import { generateResponse, webSearch, AI_PROMPTS, verifyResourcesBatch, isValidResourceUrl } from './ai.js';
import { sanitizeResourceType } from './curriculumSchema.js';

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

export function parseJsonWithRepair(text) {
    if (!text || !text.trim()) return null;
    let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();

    // 1. Try native parse first (best case, if AI returned perfectly valid JSON)
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        // continue to repair
    }

    cleaned = cleaned.replace(/([{,])\s*'(.*?)'\s*:/g, '$1"$2":');
    cleaned = cleaned.replace(/:\s*'(.*?)'(\s*[,}])/g, ': "$1"$2');
    cleaned = cleaned.replace(/(\{|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
    cleaned = cleaned.replace(/}\s*{/g, '},{');
    cleaned = cleaned.replace(/\]\s*\[/g, '],[');

    const objStart = cleaned.indexOf('{');
    const arrStart = cleaned.indexOf('[');

    // 2. Determine which bracket opens the JSON structure first
    const isArrFirst = arrStart !== -1 && (objStart === -1 || arrStart < objStart);
    const isObjFirst = objStart !== -1 && (arrStart === -1 || objStart < arrStart);

    if (isArrFirst) {
        try {
            const endBracket = findMatchingBracket(cleaned, arrStart, '[', ']');
            if (endBracket !== -1) return JSON.parse(cleaned.slice(arrStart, endBracket + 1));
        } catch (e) { }
    } else if (isObjFirst) {
        try {
            const endBrace = findMatchingBracket(cleaned, objStart, '{', '}');
            if (endBrace !== -1) return JSON.parse(cleaned.slice(objStart, endBrace + 1));
        } catch (e) { }
    }

    console.log('[JSON Repair] Failed to parse JSON. First 200 chars:', cleaned.slice(0, 200));
    return null;
}

function findMatchingBracket(text, startIdx, openBracket, closeBracket) {
    let depth = 0, inString = false, escaped = false;
    for (let i = startIdx; i < text.length; i++) {
        const char = text[i];
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (char === openBracket) depth++;
        if (char === closeBracket) { depth--; if (depth === 0) return i; }
    }
    const lastBracket = text.lastIndexOf(closeBracket);
    if (lastBracket !== -1 && lastBracket > startIdx) {
        try { JSON.parse(text.slice(startIdx, lastBracket + 1)); return lastBracket; } catch { }
    }
    return -1;
}

// Normalize an answer/option string for tolerant comparison: strip an enumerator
// prefix ("A)", "b.", "3 -"), lowercase, collapse whitespace, drop trailing
// punctuation. Local models rarely echo the option text back verbatim.
// Shared by the quiz pipeline (index.js finalizeQuiz) and the feed question
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
// answer instead of before it. Seen in the wild on a real Boss Fight: an
// explanation that argued itself into a corner ("So actually options 1, 3 and 4
// all contain only rational numbers! Let me reconsider — …"). That is reasoning
// leakage, the same failure class as a visual spec full of "okay, better:".
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
 * Two mechanical repairs, both earned from real output (see D-021's "prefer the
 * mechanical layer over a repair round-trip"):
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

/**
 * Generate concise, keyword-based search queries using the LLM.
 * Falls back to sensible defaults if LLM fails.
 */
async function generateSmartQueries(subElementTitle, elementTitle, signal) {
    // Default queries: short, keyword-based, human-like
    const fallbackQueries = [
        `${subElementTitle} documentation`,
        `${subElementTitle} tutorial guide`,
        `${elementTitle} ${subElementTitle}`,
    ];

    try {
        const queryPrompt = `Generate exactly 3 concise, keyword-based search queries to find educational resources for the topic: "${subElementTitle}".
Context: ${elementTitle}.
Output ONLY a raw JSON array of strings. No markdown, no explanation. Example: ["rust borrow checker", "rust ownership memory"]`;

        const response = await generateResponse(queryPrompt, '', [], {
            signal, temperature: 0.1
        });
        const parsed = parseJsonWithRepair(response);
        if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map(q => String(q).trim()).filter(Boolean);
        }
    } catch (e) {
        console.log('[Resources] Smart query generation failed, using defaults.');
    }

    return fallbackQueries;
}

/**
 * Core resource discovery function.
 *
 * Pipeline:
 *   1. Generate smart keyword queries via LLM
 *   2. Search in parallel across all providers (DDG, Wikipedia, GitHub, SearXNG)
 *   3. Deduplicate results
 *   4. Pass real URLs to LLM for strict zero-hallucination curation
 *   5. Fallback: return top 3 raw search results if LLM curation fails
 */
export async function searchAndCurateResources(
    projectName, projectSummary, categoryTitle, elementTitle,
    subElementTitle, subElementDescription, signal
) {
    // Generate smart, concise search queries
    const queries = await generateSmartQueries(subElementTitle, elementTitle, signal);
    console.log(`[Resources] Queries for "${subElementTitle}":`, queries);

    // Parallel search across all providers
    const searchPromises = queries.map(q => webSearch(q, 4));
    const results = await Promise.allSettled(searchPromises);

    const allResults = [];
    const seenUrls = new Set();
    for (const r of results) {
        if (r.status === 'fulfilled' && r.value.success) {
            for (const item of r.value.results) {
                if (item.url && !seenUrls.has(item.url) && isValidResourceUrl(item.url)) {
                    seenUrls.add(item.url);
                    allResults.push({ title: item.title, url: item.url, snippet: item.snippet || '' });
                }
            }
        }
    }

    console.log(`[Resources] Found ${allResults.length} unique candidates for "${subElementTitle}"`);

    if (allResults.length === 0) return [];

    // Strict zero-hallucination LLM curation
    let curated = [];
    if (allResults.length > 0) {
        const candidates = allResults.slice(0, 10);
        // Enforce the whitelist, don't just prompt for it: any URL the LLM
        // returns that isn't verbatim in the candidate list is a hallucination.
        const candidateUrls = new Set(candidates.map(r => r.url));
        const candidateList = candidates
            .map((r, i) => `[${i}] Title: "${r.title}"\nURL: ${r.url}\nSnippet: ${r.snippet.slice(0, 150)}`)
            .join('\n\n');

        try {
            const { system, user } = AI_PROMPTS.find_resources(subElementTitle, candidateList);
            const response = await generateResponse(user, system, [], { signal, temperature: 0.1 });
            const parsed = parseJsonWithRepair(response);

            if (Array.isArray(parsed)) {
                curated = parsed;
            } else if (parsed?.resources && Array.isArray(parsed.resources)) {
                curated = parsed.resources;
            }
            const dropped = curated.filter(r => r?.url && !candidateUrls.has(r.url)).length;
            if (dropped > 0) {
                console.log(`[Resources] Dropped ${dropped} curated URL(s) not present in the candidate list (hallucination guard)`);
            }
            curated = curated.filter(r => r?.url && candidateUrls.has(r.url));
        } catch (e) {
            console.log('[Resources] LLM curation failed:', e.message);
        }
    }

    // If curation succeeded and returned resources, use them
    if (curated.length > 0) {
        return curated
            .filter(r => r.url && isValidResourceUrl(r.url))
            .map(r => ({
                title: r.title || 'Resource',
                url: r.url,
                type: sanitizeResourceType(r.type),
            }));
    }

    // Fallback — Ask LLM for canonical resources from its training data
    console.log('[Resources] Search/Curation returned 0 results. Falling back to LLM internal knowledge...');
    try {
        const fallbackPrompt = `You are an expert educational resource curator. Web search failed to find good resources for the topic: "${subElementTitle}".
Rely on your internal training data to provide 2-3 canonical, highly reliable learning resources.
CRITICAL RULES:
1. ONLY provide URLs that you are 100% confident exist and are correct (e.g., official docs like doc.rust-lang.org, rust-book, github.com/rust-lang, etc.).
2. DO NOT make up URLs. If you are unsure of the exact URL, provide the main domain (e.g., https://doc.rust-lang.org/book/).
3. Output ONLY a valid JSON object: { "resources": [{"title": "...", "url": "https://...", "type": "documentation|article|book|video"}] }`;

        const response = await generateResponse(fallbackPrompt, '', [], { signal, temperature: 0.1 });
        const parsed = parseJsonWithRepair(response);

        let fallbackResources = [];
        if (Array.isArray(parsed)) {
            fallbackResources = parsed;
        } else if (parsed?.resources && Array.isArray(parsed.resources)) {
            fallbackResources = parsed.resources;
        }

        if (fallbackResources.length > 0) {
            const validUrls = fallbackResources.filter(r => r.url && isValidResourceUrl(r.url));

            // Verify URLs to filter out confirmed 404s (LLM hallucinations).
            // verifyResourcesBatch already distinguishes "network error" (keep URL)
            // from "confirmed 404/410/451" (drop URL). If it returns [], every URL
            // was either invalid or confirmed dead — do NOT leak them to the user.
            try {
                const verified = await verifyResourcesBatch(validUrls);
                if (verified.length > 0) {
                    return verified.map(r => ({
                        title: r.title || 'Resource',
                        url: r.url,
                        type: sanitizeResourceType(r.type),
                    }));
                }
                // Verification dropped every URL — they are confirmed dead (LLM hallucinations).
                console.log('[Resources] LLM fallback URLs all failed verification (confirmed 404s) — returning []');
            } catch (ve) {
                console.log('[Resources] URL verification failed catastrophically, returning []:', ve.message);
            }

            // Do NOT return validUrls here. If verification dropped them,
            // they are confirmed 404s. Returning them would leak LLM hallucinations
            // (dead links) to the user. Fall through to the raw search results below.
        }
    } catch (e) {
        console.log('[Resources] LLM knowledge fallback failed:', e.message);
    }

    // Absolute last resort — return top 3 raw search results
    console.log('[Resources] Falling back to top 3 raw search results.');
    return allResults.slice(0, 3).map(r => ({
        title: r.title,
        url: r.url,
        type: 'article',
    }));
}
