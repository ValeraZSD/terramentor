import { generateResponse, webSearch, AI_PROMPTS, verifyResourcesBatch, isValidResourceUrl } from './ai.js';
import { sanitizeResourceType } from './curriculumSchema.js';
import { parseJsonWithRepair } from './jsonRepair.js';
// Re-exported: every importer of the repair reads it from here.
export { parseJsonWithRepair };

export function validateSchema(schema, value, path = '') {
    const errors = [];
    if (!value && value !== 0 && value !== false) {
        errors.push(`${path || 'root'}: value is required`);
        return { valid: false, errors, data: null };
    }
    // Work on a local copy so truncation (slice) never mutates the caller's
    // value. Previously `value = value.slice(...)` re-sliced the argument in
    // place, corrupting the original object/array referenced by the caller.
    let validated = value;
    switch (schema.type) {
        case 'array':
            if (!Array.isArray(value)) {
                errors.push(`${path || 'root'}: expected array, got ${typeof value}`);
                return { valid: false, errors, data: null };
            }
            if (schema.minItems !== undefined && value.length < schema.minItems) {
                errors.push(`${path || 'root'}: expected at least ${schema.minItems} items, got ${value.length}`);
            }
            if (schema.maxItems !== undefined && value.length > schema.maxItems) {
                validated = validated.slice(0, schema.maxItems);
            }
            if (schema.items) {
                for (let i = 0; i < validated.length; i++) {
                    const itemErrors = validateSchema(schema.items, validated[i], `${path || 'root'}[${i}]`);
                    if (!itemErrors.valid) errors.push(...itemErrors.errors);
                }
            }
            break;
        case 'object':
            if (typeof value !== 'object' || Array.isArray(value) || value === null) {
                errors.push(`${path || 'root'}: expected object, got ${typeof value}`);
                return { valid: false, errors, data: null };
            }
            if (schema.required) {
                for (const field of schema.required) {
                    if (!(field in value) || value[field] === undefined || value[field] === null) {
                        errors.push(`${path || 'root'}.${field}: required field is missing`);
                    }
                }
            }
            if (schema.properties) {
                for (const [key, propSchema] of Object.entries(schema.properties)) {
                    if (key in value && value[key] !== undefined) {
                        const propErrors = validateSchema(propSchema, value[key], `${path || 'root'}.${key}`);
                        if (!propErrors.valid) errors.push(...propErrors.errors);
                    }
                }
            }
            break;
        case 'string':
            if (typeof value !== 'string') {
                errors.push(`${path || 'root'}: expected string, got ${typeof value}`);
                return { valid: false, errors, data: null };
            }
            if (schema.minLength !== undefined && value.length < schema.minLength) {
                errors.push(`${path || 'root'}: string too short (min ${schema.minLength}, got ${value.length})`);
            }
            if (schema.maxLength !== undefined && value.length > schema.maxLength) {
                validated = validated.slice(0, schema.maxLength);
            }
            if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
                errors.push(`${path || 'root'}: string doesn't match pattern`);
            }
            if (schema.enum && !schema.enum.includes(value)) {
                errors.push(`${path || 'root'}: value "${value}" not in allowed values: [${schema.enum.join(', ')}]`);
            }
            break;
    }
    return { valid: errors.length === 0, errors, data: errors.length === 0 ? validated : null };
}

// Normalize an answer/option string for tolerant comparison: strip an enumerator
// prefix ("A)", "b.", "3 -"), lowercase, collapse whitespace, drop trailing
// punctuation. Local models rarely echo the option text back verbatim.
// Shared by the quiz pipeline (finalizeQuiz in studyMaterial.js) and the feed question
// normalizer (feed.js) so both grade answers identically.
export function normalizeChoice(s) {
    return String(s ?? '')
        .replace(/^\s*[([]?[a-dA-D0-9][)\].:\-]\s*/, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[.!?;,]+$/, '')
        .trim();
}

const MEDIA_HASH_RE = /^[a-f0-9]{64}$/;

/**
 * Validate the pictures/clips attached to a question (`QuizQuestion.media`).
 *
 * Every normalizer that rebuilds a question key by key — `normalizeFeedQuestion`
 * here, and anything written later — must run this rather than spread the raw
 * object, because dropping the key silently turns a photo question into an
 * unanswerable one and NOTHING would report it. That is the same invisible
 * failure as a visual kind with no renderer.
 *
 * No model produces this field: it exists for material that arrives with real
 * files. So the bar is "did an importer write something sane", and the checks
 * are the content-address format the media endpoint enforces plus the two kinds
 * the card renderer knows. Returns undefined when there is nothing to attach,
 * so a text question's JSON stays exactly as it was.
 */
export function sanitizeQuestionMedia(raw) {
    if (!Array.isArray(raw)) return undefined;
    const clean = raw
        .filter(m => m && typeof m.hash === 'string' && MEDIA_HASH_RE.test(m.hash)
            && (m.kind === 'image' || m.kind === 'audio'))
        .map(m => ({
            hash: m.hash,
            kind: m.kind,
            ...(typeof m.name === 'string' && m.name ? { name: m.name } : {}),
            ...(typeof m.alt === 'string' && m.alt ? { alt: m.alt } : {}),
        }));
    return clean.length ? clean : undefined;
}

// Sentence-openers that mean the model started deliberating in the finished
// answer instead of before it: an explanation that argues itself into a corner
// ("So actually options 1, 3 and 4 all contain only rational numbers! Let me
// reconsider — …"). That is reasoning leakage, the same failure class as a
// visual spec full of "okay, better:".
const DELIBERATION_RE = /\b(let me (?:reconsider|rethink|think|recheck)|on second thought|wait[,—-]|hold on|hmm[,.]|scratch that|actually,? (?:both|all|options?|the)|i (?:made|got) (?:a|that) (?:mistake|wrong)|correction:)/i;

// "the first option", "option B", "choice 3", "the second answer" — a positional
// reference to an option. Meaningless to the learner because BOTH quiz paths
// (finalizeQuiz, normalizeFeedQuestion) shuffle the options before display, so
// by the time the explanation is read the position it names is a different
// answer. Resolved against the option text instead — which is why this must run
// BEFORE the shuffle, while the model's ordering still holds.
const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth'];
const ORDINAL_REF_RE = new RegExp(
    String.raw`\b(?:the\s+)?(?:(${ORDINAL_WORDS.join('|')})\s+(?:option|answer|choice)` +
    String.raw`|(?:option|answer|choice)\s+(\d|[a-eA-E])\b)`,
    'gi'
);

/** Short, quotable form of an option for inlining into an explanation. */
function quoteOption(opt) {
    const t = String(opt).replace(/\s+/g, ' ').trim();
    return `"${t.length > 64 ? `${t.slice(0, 61)}…` : t}"`;
}

/**
 * Make one AI-written explanation safe to show the learner.
 *
 * Two mechanical repairs, preferred over a repair round-trip to the model:
 *  1. Positional option references are rewritten to the option's own words —
 *     MUST be called BEFORE the options are shuffled.
 *  2. Deliberation is cut: everything from the first "let me reconsider"-class
 *     marker to the end goes, since whatever follows is the model arguing with
 *     itself rather than teaching. If that leaves nothing, the explanation is
 *     dropped entirely (no explanation beats a confusing one).
 *
 * `options` is the model's ORIGINAL option order; omit it for true/false and
 * short-answer questions, where positional references have no referent.
 */
export function sanitizeExplanation(explanation, options) {
    let text = typeof explanation === 'string' ? explanation.trim() : '';
    if (!text) return '';

    // Cut deliberation at the sentence that starts it. Split on sentence ends
    // that aren't decimal points/abbreviations closely enough for prose.
    const sentences = text.split(/(?<=[.!?])\s+/);
    const firstBad = sentences.findIndex(s => DELIBERATION_RE.test(s));
    if (firstBad === 0) return '';
    if (firstBad > 0) text = sentences.slice(0, firstBad).join(' ').trim();
    if (!text) return '';

    if (Array.isArray(options) && options.length > 0) {
        text = text.replace(ORDINAL_REF_RE, (match, word, token) => {
            let idx = -1;
            if (word) idx = ORDINAL_WORDS.indexOf(word.toLowerCase());
            else if (token) {
                idx = /\d/.test(token) ? Number(token) - 1 : token.toLowerCase().charCodeAt(0) - 97;
            }
            if (idx < 0 || idx >= options.length) return match; // unresolvable — leave it
            return quoteOption(options[idx]);
        });
    }
    return text.trim();
}

// Quiz questions may carry LaTeX ($\frac{a}{b}$, $E = mc^2$). Local models
// routinely emit those backslashes *unescaped*, which is invalid JSON — and,
// worse, sequences like \frac / \times / \nabla collide with JSON's \f, \t, \n
// escapes, so a naive JSON.parse silently mangles the equation instead of
// failing. This walks the raw JSON and, inside string values, doubles any
// backslash that isn't already a JSON escape we must preserve (\" \\ \/ \uXXXX),
// so every LaTeX command survives as a literal backslash. A properly
// double-escaped \\frac is left intact, so the pass is safe to always run.
export function escapeLatexBackslashes(jsonStr) {
    let out = '';
    let inString = false;
    for (let i = 0; i < jsonStr.length; i++) {
        const c = jsonStr[i];
        if (c === '"') { inString = !inString; out += c; continue; }
        if (c === '\\' && inString) {
            const next = jsonStr[i + 1];
            if (next === '"' || next === '\\' || next === '/') { out += c + next; i++; continue; }
            if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(jsonStr.slice(i + 2, i + 6))) {
                out += jsonStr.slice(i, i + 6); i += 5; continue;
            }
            out += '\\\\'; // lone backslash (LaTeX command or \{ ) — escape it
            continue;
        }
        out += c;
    }
    return out;
}

/**
 * Extract the first {...} object from model output, LaTeX-safely.
 *
 * Lives here beside its two dependencies because feedGen.js and paper.js each
 * carried a byte-identical private copy, and a change to the escaping rules
 * would otherwise have to be made twice.
 */
export function parseObjectResponse(resp) {
    const match = String(resp || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    return parseJsonWithRepair(escapeLatexBackslashes(match[0]));
}

// isValidResourceUrl is imported from ai.js (canonical implementation) rather
// than redefined. This deduplicates two previously divergent copies so the
// webSearch half and the curation half of the resource pipeline agree on URL
// validity.

// The same deduplication, one layer up: this list had drifted into three copies
// (here, server/index.js, and the importer), disagreeing about `course_link` and
// `link` — so a type the importer accepted was one the curator rewrote away.
// curriculumSchema.js owns the list AND the normalizer now; re-exported here so
// the existing importers of this module keep working.
export { sanitizeResourceType };

// Resource Discovery Pipeline
//
// A topic's links are chosen, never just found: search results are ranked and
// thinned (one site does not fill the list, feeds and homework farms never
// reach it), a model with the course in front of it picks the ones that teach
// THIS topic, and its "none of these" is final — no links beats wrong links.
// The model's own memory is the last resort, and only for addresses this
// machine has seen answer.

/**
 * Sites whose pages are not study resources: social feeds, Q&A and homework
 * farms, and document dumps behind a login. A LABEL matches the brand on any
 * country domain (pinterest.de, brainly.in); a DOMAIN matches itself and its
 * subdomains.
 */
const LOW_VALUE_LABELS = ['pinterest', 'brainly'];
const LOW_VALUE_DOMAINS = [
    'facebook.com', 'instagram.com', 'tiktok.com', 'x.com', 'twitter.com', 'threads.net', 'linkedin.com',
    'quora.com', 'answers.com', 'chegg.com', 'coursehero.com', 'studocu.com', 'scribd.com', 'slideshare.net',
];

/** The site a URL belongs to, without `www.`; '' for anything unparseable. */
export function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

export function isLowValueHost(host) {
    if (!host) return true;
    if (host.split('.').some(label => LOW_VALUE_LABELS.includes(label))) return true;
    return LOW_VALUE_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
}

/** One page, one key: tracking parameters, the fragment and a trailing slash say nothing. */
function pageKey(url) {
    try {
        const u = new URL(url);
        u.hash = '';
        for (const p of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$)/i.test(p)) u.searchParams.delete(p);
        return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
    } catch { return url; }
}

/**
 * The candidates a curator is shown, from one result list per query.
 *
 * Taken in turn from each list (round robin), so every query's best results come
 * first rather than all of the first query's before any of the second; the same
 * page twice, a URL that is not a page, and a low-value site are dropped; and no
 * site supplies more than `perHost`, so one prolific domain cannot be the whole
 * choice.
 */
export function rankResourceCandidates(lists, { max = 10, perHost = 2 } = {}) {
    const queues = (lists || []).map(l => (Array.isArray(l) ? l.slice() : []));
    const seen = new Set();
    const perSite = new Map();
    const out = [];
    while (out.length < max && queues.some(q => q.length)) {
        for (const q of queues) {
            const item = q.shift();
            if (!item?.url || !isValidResourceUrl(item.url)) continue;
            const key = pageKey(item.url);
            const host = hostOf(item.url);
            if (seen.has(key) || isLowValueHost(host)) continue;
            seen.add(key);
            if ((perSite.get(host) || 0) >= perHost) continue;
            perSite.set(host, (perSite.get(host) || 0) + 1);
            out.push({ title: String(item.title || '').trim(), url: item.url, snippet: String(item.snippet || '') });
            if (out.length >= max) break;
        }
    }
    return out;
}

/** The first link from each site, in order. */
export function onePerHost(resources) {
    const seen = new Set();
    return (resources || []).filter(r => {
        const host = hostOf(r?.url);
        if (!host || seen.has(host)) return false;
        seen.add(host);
        return true;
    });
}

/** `[...]` or `{ resources: [...] }` from a model reply; null when it is neither. */
function resourceArray(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.resources)) return parsed.resources;
    return null;
}

/**
 * What a topic keeps, given the candidates and what the curator said.
 *
 *   curated: an array → the curator ANSWERED. Only links that were among the
 *            candidates survive (anything else it wrote is invented), one per
 *            site. An empty answer is kept empty: it read the candidates and
 *            found nothing that teaches this topic.
 *   curated: null     → the curator did not answer (an error, an unreadable
 *            reply). The top candidates stand in, one per site, at most three.
 */
export function decideResources(candidates, curated) {
    if (Array.isArray(curated)) {
        const allowed = new Map((candidates || []).map(c => [c.url, c]));
        return onePerHost(curated.filter(r => r?.url && allowed.has(r.url) && isValidResourceUrl(r.url)))
            .slice(0, 4)
            .map(r => ({
                title: String(r.title || '').trim() || allowed.get(r.url).title || 'Resource',
                url: r.url,
                type: sanitizeResourceType(r.type),
            }));
    }
    return onePerHost(candidates || []).slice(0, 3).map(r => ({ title: r.title || 'Resource', url: r.url, type: 'article' }));
}

/** "in Russian (русский)" — or nothing when the course has no language set. */
function readerLanguage(lang) {
    return lang ? `${lang.name} (${lang.endonym})` : null;
}

function queryLanguageRule(lang) {
    if (!lang) return '';
    const taught = lang.learning ? ` The course teaches ${lang.learning.name}: a query may be in ${lang.learning.name} where that finds better pages (grammar terms, exercises written for learners).` : '';
    return `\nThe learner reads ${readerLanguage(lang)}: write the queries in ${lang.name} so the results are pages they can read. Keep proper nouns and established technical terms in their standard form.${taught}`;
}

/**
 * Two search queries for every topic of one section, in ONE model call — the
 * section's topics are known together, and a call per topic was the single
 * largest cost of a creation run after the searches themselves. Returns one
 * array of queries per topic, in order, or null when the reply does not have
 * exactly that shape (each topic then plans its own queries).
 */
export async function planSectionQueries(sectionTitle, topics, signal, lang = null) {
    if (!Array.isArray(topics) || topics.length === 0) return null;
    const list = topics.map((t, i) => `${i + 1}. ${t.title}${t.description ? ` — ${String(t.description).slice(0, 160)}` : ''}`).join('\n');
    const prompt = `Section of a course: "${sectionTitle}".
Its topics:
${list}

For EACH topic, write 2 concise, keyword-based web search queries that would find a page teaching that topic (an explanation, a reference page or an exercise) — not the section in general.${queryLanguageRule(lang)}
Output ONLY a raw JSON array with one entry per topic, in the same order, each an array of 2 strings. No markdown, no explanation.
Example for two topics: [["rust ownership rules", "rust borrow checker explained"], ["rust lifetimes tutorial", "rust lifetime annotations"]]`;
    try {
        const response = await generateResponse(prompt, '', [], { signal, temperature: 0.1 });
        return parseSectionQueries(parseJsonWithRepair(response), topics.length);
    } catch (e) {
        if (signal?.aborted) throw e;
        console.log('[Resources] Section query planning failed, planning per topic:', e.message);
        return null;
    }
}

/** The section plan's shape check, on its own so a gate can pin it. */
export function parseSectionQueries(parsed, n) {
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.queries) ? parsed.queries : null;
    if (!rows || rows.length !== n) return null;
    const out = rows.map(r => (Array.isArray(r) ? r : typeof r === 'string' ? [r] : [])
        .map(q => String(q).trim()).filter(Boolean).slice(0, 3));
    return out.every(r => r.length > 0) ? out : null;
}

/**
 * Generate concise, keyword-based search queries for one topic.
 * Falls back to sensible defaults if the model fails.
 */
async function generateSmartQueries(subElementTitle, elementTitle, signal, lang = null) {
    const fallbackQueries = [
        `${subElementTitle} ${elementTitle}`,
        `${subElementTitle}`,
    ];

    try {
        const queryPrompt = `Generate exactly 3 concise, keyword-based search queries to find educational resources for the topic: "${subElementTitle}".
Context: ${elementTitle}.${queryLanguageRule(lang)}
Output ONLY a raw JSON array of strings. No markdown, no explanation. Example: ["rust borrow checker", "rust ownership memory"]`;

        const response = await generateResponse(queryPrompt, '', [], {
            signal, temperature: 0.1
        });
        const parsed = parseJsonWithRepair(response);
        if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map(q => String(q).trim()).filter(Boolean);
        }
    } catch (e) {
        if (signal?.aborted) throw e;
        console.log('[Resources] Smart query generation failed, using defaults.');
    }

    return fallbackQueries;
}

/**
 * Links from the model's own memory, for when the web gave nothing at all to
 * choose from (offline, every source throttled). Kept only when the address
 * ANSWERED here: an unreachable one cannot be told apart from an invented one,
 * and an invented link is worse than none.
 */
async function linksFromMemory(subElementTitle, elementTitle, signal, lang) {
    const reader = readerLanguage(lang);
    const prompt = `Web search found nothing for the topic "${subElementTitle}" (part of "${elementTitle}").
From what you know, name 1 to 3 well-known, stable pages that teach this topic: official documentation, a university or standards body, an established reference or educational publisher.${reader ? ` Prefer pages in ${reader}.` : ''}
Only give an address you are certain exists. If you are not certain of the exact page, give the site's own page for the subject, or nothing.
Output ONLY a JSON object: { "resources": [{"title": "...", "url": "https://...", "type": "documentation|article|book|video|tutorial|course|tool"}] }`;
    try {
        const response = await generateResponse(prompt, '', [], { signal, temperature: 0.1 });
        const listed = (resourceArray(parseJsonWithRepair(response)) || []).filter(r => r?.url && isValidResourceUrl(r.url) && !isLowValueHost(hostOf(r.url)));
        if (!listed.length) return [];
        const answered = await verifyResourcesBatch(listed, 8000, { keepUnreachable: false });
        return onePerHost(answered).slice(0, 3).map(r => ({
            title: String(r.title || '').trim() || 'Resource',
            url: r.url,
            type: sanitizeResourceType(r.type),
        }));
    } catch (e) {
        if (signal?.aborted) throw e;
        console.log('[Resources] Links from memory failed:', e.message);
        return [];
    }
}

/**
 * Find and choose the study links for one topic.
 *
 *   1. Queries: the section's plan when one was made (`queries`), else planned here.
 *   2. Search every provider for each query, in parallel.
 *   3. Rank and thin the results (`rankResourceCandidates`).
 *   4. A model with the course, the section, the topic and the learner's
 *      language in front of it picks up to four (`decideResources`).
 *   5. Nothing to pick from at all: the model's memory, verified (`linksFromMemory`).
 */
export async function searchAndCurateResources(
    projectName, projectSummary, categoryTitle, elementTitle,
    subElementTitle, subElementDescription, signal, lang = null, queries = null
) {
    const planned = Array.isArray(queries) && queries.length
        ? queries
        : await generateSmartQueries(subElementTitle, elementTitle, signal, lang);
    console.log(`[Resources] Queries for "${subElementTitle}":`, planned);

    const settled = await Promise.allSettled(planned.map(q => webSearch(q, 6)));
    const lists = settled.map(r => (r.status === 'fulfilled' && r.value.success ? r.value.results : []));
    const candidates = rankResourceCandidates(lists, { max: 10, perHost: 2 });
    console.log(`[Resources] ${candidates.length} candidates for "${subElementTitle}"`);

    if (candidates.length === 0) return linksFromMemory(subElementTitle, elementTitle, signal, lang);

    let curated = null;
    try {
        const candidateList = candidates
            .map((r, i) => `[${i}] Title: "${r.title}"\nURL: ${r.url}\nSite: ${hostOf(r.url)}\nSnippet: ${r.snippet.slice(0, 200)}`)
            .join('\n\n');
        const { system, user } = AI_PROMPTS.find_resources(subElementTitle, candidateList, {
            course: projectName, section: elementTitle, phase: categoryTitle,
            description: subElementDescription, lang,
        });
        const response = await generateResponse(user, system, [], { signal, temperature: 0.1 });
        curated = resourceArray(parseJsonWithRepair(response));
        const invented = (curated || []).filter(r => r?.url && !candidates.some(c => c.url === r.url)).length;
        if (invented > 0) console.log(`[Resources] Dropped ${invented} curated URL(s) not in the candidate list (hallucination guard)`);
    } catch (e) {
        if (signal?.aborted) throw e;
        console.log('[Resources] Curation failed, keeping the top candidates:', e.message);
    }
    return decideResources(candidates, curated);
}
