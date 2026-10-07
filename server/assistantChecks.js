/**
 * What the assistant prepares is CHECKED before the learner can press it.
 *
 * A proposal's words come from a model, and a card the learner adds is
 * reviewed for months on a schedule built to make it stick; a link is a
 * place they will be sent. So, before Add or Save is offered:
 *
 *   - a CARD is answered cold by a second call that never sees its back
 *     (`feed_drill_check`, the free pass the feed's own drills and cards go
 *     through), and a cold answer that differs gets one more look with both
 *     shown side by side and unlabelled (`feed_drill_arbiter`). Only a back
 *     that look rejects is DISPUTED — a different wording is not a wrong one.
 *     Like every verifier here it catches a slip and not a misconception the
 *     two calls share.
 *   - a LINK is opened once (`safeFetch`: every address vetted, the socket
 *     pinned) to see that the page exists, and its own <title> is read so the
 *     saved row says what the page says. Only with the live web on: a link
 *     check is an outbound request like a web search, under the same switch.
 *
 * A verdict is `ok`, `disputed` (with the reason) or `unchecked` (with why: no
 * model, the web off, a timeout). A checker that cannot answer is not evidence
 * against the item — `unchecked` keeps it offered and says so. Verdicts are
 * kept by content (`assistant_checks`), so a re-read conversation, a second
 * device or the Add press itself reads the verdict instead of paying again.
 */
import crypto from 'node:crypto';
import db from './database.js';
import { generateResponse, AI_PROMPTS } from './ai.js';
import { parseJsonWithRepair, escapeLatexBackslashes } from './agentic.js';
import { sameAnswer } from './feedQuality.js';
import { sameOption } from './questionOptions.js';
import { bankTitle } from './studyMaterial.js';
import { safeFetch } from './netSafety.js';
import { sanitizeUrl } from './urlSafety.js';
import { webSearchEnabled } from './webContext.js';

/** How long a link check waits for the page, headers and body together. */
export const LINK_CHECK_TIMEOUT_MS = 10_000;
/** How much of a page is read for its title: the head is at the top. */
const LINK_READ_BYTES = 64 * 1024;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const cardCheckKey = (nodeId, front, back) => sha(`card\u0000${Number(nodeId)}\u0000${String(front).trim()}\u0000${String(back).trim()}`);
export const linkCheckKey = (url) => sha(`link\u0000${String(url).trim()}`);

const readStmt = () => db.prepare('SELECT verdict, reason, detail FROM assistant_checks WHERE key = ?');
const writeStmt = () => db.prepare(`
    INSERT INTO assistant_checks (key, kind, verdict, reason, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason, detail = excluded.detail, checked_at = excluded.checked_at
`);

/** A stored verdict, or null. `unchecked` is never stored: the next look tries again. */
export function storedVerdict(key) {
    const row = readStmt().get(key);
    if (!row) return null;
    let detail = null;
    try { detail = row.detail ? JSON.parse(row.detail) : null; } catch { /* a verdict without its detail is still a verdict */ }
    return { verdict: row.verdict, reason: row.reason || null, ...(detail ? { detail } : {}) };
}

function remember(key, kind, v) {
    if (v.verdict === 'unchecked') return v;
    writeStmt().run(key, kind, v.verdict, v.reason || null, v.detail ? JSON.stringify(v.detail) : null, new Date().toISOString());
    return v;
}

function parseObject(resp) {
    const match = String(resp || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return parseJsonWithRepair(escapeLatexBackslashes(match[0])); } catch { return null; }
}

/** One check per content at a time: a preview and an Add pressed together share it. */
const inFlight = new Map();
const once = (key, run) => {
    if (inFlight.has(key)) return inFlight.get(key);
    const p = run().finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
};

/**
 * Check the cards of one message (at most a handful), grouped by topic so each
 * cold pass is asked about one subject. Returns one verdict per card, in order.
 */
export async function checkCards(cards, { signal } = {}) {
    const out = new Array(cards.length).fill(null);
    const todo = [];
    cards.forEach((c, i) => {
        const key = cardCheckKey(c.nodeId, c.front, c.back);
        const stored = storedVerdict(key);
        if (stored) out[i] = stored;
        else todo.push({ ...c, i, key });
    });
    const byTopic = new Map();
    for (const c of todo) {
        if (!byTopic.has(c.nodeId)) byTopic.set(c.nodeId, []);
        byTopic.get(c.nodeId).push(c);
    }
    for (const [nodeId, group] of byTopic) {
        const groupKey = group.map(c => c.key).join(',');
        const verdicts = await once(groupKey, () => checkTopicCards(bankTitle(nodeId), group, { signal }));
        group.forEach((c, k) => { out[c.i] = remember(c.key, 'card', verdicts[k]); });
    }
    return out;
}

async function checkTopicCards(title, group, { signal }) {
    const set = { title: `${title} — flashcards`, items: group.map(c => ({ prompt: c.front, answer: c.back, distractors: [] })) };
    let cold = null;
    try {
        const { system, user } = AI_PROMPTS.feed_drill_check(title, set, null);
        const resp = await generateResponse(user, system, [], { temperature: 0.1, signal, operation: 'assistant_check' });
        const answers = parseObject(resp)?.answers;
        if (Array.isArray(answers)) {
            cold = new Map();
            answers.forEach((a, k) => {
                const n = Number.isInteger(a?.n) ? a.n : k + 1;
                const answer = a?.answer == null ? '' : String(a.answer).trim();
                if (n >= 1 && n <= group.length && answer) cold.set(n - 1, answer);
            });
        }
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        return group.map(() => ({ verdict: 'unchecked', reason: `the checking model could not be asked (${String(err?.message || err).slice(0, 120)})` }));
    }
    if (!cold || cold.size === 0) return group.map(() => ({ verdict: 'unchecked', reason: 'the checking model gave no usable answer' }));

    const verdicts = group.map((c, i) => {
        if (!cold.has(i)) return { verdict: 'unchecked', reason: 'the checking model skipped this card' };
        const theirs = cold.get(i);
        if (/^ambiguous$/i.test(theirs)) return { verdict: 'disputed', reason: 'the question has more than one right answer, so the card cannot be checked against one back' };
        if (sameOption(theirs, c.back) || sameAnswer(theirs, c.back)) return { verdict: 'ok', reason: null };
        return { verdict: 'contested', theirs };
    });
    const contested = verdicts.map((v, i) => ({ v, i })).filter(x => x.v.verdict === 'contested');
    if (!contested.length) return verdicts;

    // Side by side, unlabelled: a cold answer that differs is weak evidence on
    // its own (another spelling, a shorter form of the same answer).
    const rows = contested.map(({ v, i }, k) => {
        const keyFirst = k % 2 === 0;
        return { i, theirs: v.theirs, keyLabel: keyFirst ? 'a' : 'b', n: k + 1, prompt: group[i].front,
            a: keyFirst ? group[i].back : v.theirs, b: keyFirst ? v.theirs : group[i].back };
    });
    let looks = null;
    try {
        const { system, user } = AI_PROMPTS.feed_drill_arbiter(title, set, rows);
        const resp = await generateResponse(user, system, [], { temperature: 0.1, signal, operation: 'assistant_check' });
        const list = parseObject(resp)?.verdicts;
        if (Array.isArray(list)) looks = new Map(list.map((x, k) => [Number.isInteger(x?.n) ? x.n : k + 1, String(x?.correct || '').trim().toLowerCase()]));
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
    }
    for (const r of rows) {
        const look = looks?.get(r.n);
        if (!['a', 'b', 'both', 'neither'].includes(look)) {
            verdicts[r.i] = { verdict: 'unchecked', reason: 'a second look could not be had' };
        } else if (look === 'both' || look === r.keyLabel) {
            verdicts[r.i] = { verdict: 'ok', reason: null };
        } else {
            verdicts[r.i] = { verdict: 'disputed', reason: `a second model answered “${r.theirs.slice(0, 120)}”, and a closer look sided with it`, detail: { answer: r.theirs.slice(0, 200) } };
        }
    }
    return verdicts;
}

/** The page's own title, from the first bytes of its HTML. */
export function pageTitle(html) {
    const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m) return null;
    const t = m[1]
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, 200) : null;
}

/**
 * Check a link: a URL the app accepts at all, then — with the live web on —
 * a page that answers 2xx, and its title. Returns `{ verdict, reason, detail:
 * { url, title } }`.
 */
export async function checkLink(rawUrl, { fetchImpl = safeFetch } = {}) {
    const checked = sanitizeUrl(rawUrl);
    if (!checked.ok) return { verdict: 'disputed', reason: `not a link the app can open (${checked.reason})` };
    const url = checked.url;
    const key = linkCheckKey(url);
    const stored = storedVerdict(key);
    if (stored) return stored;
    if (!webSearchEnabled()) return { verdict: 'unchecked', reason: 'web access is off, so the page was not opened', detail: { url } };
    return once(key, async () => remember(key, 'link', await openPage(url, fetchImpl)));
}

async function openPage(url, fetchImpl) {
    const signal = AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS);
    let res;
    try {
        res = await fetchImpl(url, { signal, headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'user-agent': 'Mozilla/5.0 (Terramentor link check)' } });
    } catch (err) {
        return { verdict: 'unchecked', reason: `the page could not be reached (${String(err?.message || err).slice(0, 120)})`, detail: { url } };
    }
    try {
        // The reasons are read by a learner, so they are words; the status
        // stays on the verdict for anyone who needs it.
        if (res.status === 404 || res.status === 410) {
            return { verdict: 'disputed', reason: 'there is no page at that address', detail: { url, status: res.status } };
        }
        if (res.status < 200 || res.status >= 300) {
            // A 403 or a 429 is a site refusing robots, not a missing page.
            return { verdict: 'unchecked', reason: 'the site did not let the app open the page', detail: { url, status: res.status } };
        }
        let title = null;
        if (/html/i.test(res.headers.get('content-type') || '')) {
            const reader = res.body?.getReader?.();
            let html = '';
            const decoder = new TextDecoder();
            if (reader) {
                let read = 0;
                while (read < LINK_READ_BYTES) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    read += value.byteLength;
                    html += decoder.decode(value, { stream: true });
                    if (/<\/title>/i.test(html)) break;
                }
                await reader.cancel().catch(() => {});
            }
            title = pageTitle(html);
        } else {
            await res.body?.cancel?.().catch(() => {});
        }
        return { verdict: 'ok', reason: null, detail: { url, title } };
    } catch (err) {
        return { verdict: 'unchecked', reason: `the page could not be read (${String(err?.message || err).slice(0, 120)})`, detail: { url } };
    }
}
