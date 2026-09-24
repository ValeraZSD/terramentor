// Hosted search backends — the general web, from a service the learner chose.
//
// The built-in general search is DuckDuckGo's no-JavaScript HTML endpoint,
// which throttles per IP: when it declines, EVERY search from this machine
// fails at once, and the one source that could answer a general question
// answers none. A hosted API with a key removes that single point: its results
// arrive as JSON (no scraping), Brave and Tavily's free tiers are sized for
// one learner, and Tavily and Jina return page TEXT with the results, which
// saves the page fetch that would otherwise follow.
//
// The trade the learner makes is named in SECURITY.md: saving a key adds
// exactly that engine's host to the outbound set, and sends it the search
// terms the model wrote, with the key attached. A key is stored in the
// settings table, is write-only (`isSecretSettingKey` keeps it out of the
// settings dump; the key routes beside /api/ai/key are the only writers), and
// is sent to its own service and nowhere else.
//
// Kept out of ai.js (whose webSearch fans out to these) because ai.js is
// already a monolith and every one of these is a small, self-contained shape:
// one endpoint, one parser, one error rule.

import db from './database.js';
import { safeFetch } from './netSafety.js';

/**
 * Text kept per result when the search response already carries it.
 * Mirrors webContext.js's PAGE_CHARS and for the same reason: a local model's
 * context is the binding constraint. Jina returns full extracted pages
 * (kilobytes); without this cap one Jina result outweighs everything else
 * the turn reads.
 */
const MAX_TEXT_CHARS = 1500;

/** A result shorter than this is a sentence, not a reading — the page fetch
 * would still add something, so it is not skipped. Tavily's query-relevant
 * chunks run 200–800 characters, so a healthy chunk clears it. */
const TEXT_READY_MIN = 200;

/** The three backends, and the settings row each key lives in. */
export const SEARCH_BACKENDS = {
    tavily: { setting: 'search_tavily_key', label: 'Tavily' },
    brave: { setting: 'search_brave_key', label: 'Brave' },
    jina: { setting: 'search_jina_key', label: 'Jina' },
};

/** The settings rows that are credentials — auth.js imports this so the
 * settings dump strips them and the generic settings writer refuses them. */
export const SECRET_SEARCH_KEYS = Object.values(SEARCH_BACKENDS).map(b => b.setting);

function getBackendKey(provider) {
    const backend = SEARCH_BACKENDS[provider];
    if (!backend) return null;
    try {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(backend.setting);
        const value = row?.value;
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    } catch {
        return null;
    }
}

/** Whether a key is saved, per backend — the only thing any client learns. */
export function searchKeysStatus() {
    const out = {};
    for (const name of Object.keys(SEARCH_BACKENDS)) out[name] = !!getBackendKey(name);
    return out;
}

/** Store or clear one backend's key. An empty string means clear — the Clear
 * button's word, the same convention as /api/ai/key. The value is never read
 * back: the caller learns only that it is saved. */
export function setSearchBackendKey(provider, key) {
    const backend = SEARCH_BACKENDS[provider];
    if (!backend) throw new Error(`Unknown search backend: ${provider}`);
    const trimmed = String(key || '').trim();
    if (trimmed) {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(backend.setting, trimmed);
    } else {
        db.prepare('DELETE FROM settings WHERE key = ?').run(backend.setting);
    }
    return !!trimmed;
}

// ── The parsers ─────────────────────────────────────────────────────────────
//
// Pure, so the gate can run them against recorded response shapes with no
// network. Tolerant about missing fields, merciless about URLs: a result with
// no URL is dropped here, and the surviving ones are vetted again by
// isValidResourceUrl in webSearch's merge, the same as every scraped result.

export function tavilyParse(data) {
    const out = [];
    for (const r of (Array.isArray(data?.results) ? data.results : [])) {
        if (!r?.url) continue;
        const content = String(r.content || '').trim();
        out.push({
            title: String(r.title || r.url).trim() || 'Untitled',
            url: r.url,
            snippet: content,
            ...(content.length >= TEXT_READY_MIN ? { text: content } : {}),
        });
    }
    return out;
}

export function braveParse(data) {
    const out = [];
    for (const r of (Array.isArray(data?.web?.results) ? data.web.results : [])) {
        if (!r?.url) continue;
        out.push({
            title: String(r.title || r.url).trim() || 'Untitled',
            url: r.url,
            snippet: String(r.description || '').trim(),
        });
    }
    return out;
}

export function jinaParse(data) {
    const out = [];
    for (const r of (Array.isArray(data?.data) ? data.data : [])) {
        if (!r?.url) continue;
        // Jina returns the full extracted page; keep a reading-sized slice of
        // it rather than the whole document (see MAX_TEXT_CHARS above).
        const content = String(r.content || '').trim().slice(0, MAX_TEXT_CHARS);
        out.push({
            title: String(r.title || r.url).trim() || 'Untitled',
            url: r.url,
            snippet: content.slice(0, 300),
            ...(content.length >= TEXT_READY_MIN ? { text: content } : {}),
        });
    }
    return out;
}

// ── The searches ────────────────────────────────────────────────────────────
//
// Each follows the ddgSearch contract, which webSearch's fan-out is written
// against: not configured → [] (a settled zero, like an unconfigured
// SearXNG); configured but refused (401, 429, a dead network) → THROW, so the
// turn reads as "the search failed", never as "no results".
//
// Requests go through safeFetch, the same vetting every other outbound call
// takes: private and loopback resolved addresses refused, every redirect
// re-checked. These are fixed public hosts, so the vetting is cheap and the
// promise in SECURITY.md stays one sentence.

/** Brave's base plan is 1 request per second — a queue, not a hope. */
const braveQueue = makeThrottledQueue(1100);

function makeThrottledQueue(spacingMs) {
    let chain = Promise.resolve();
    return function enqueue(task) {
        const p = chain.then(async () => {
            await new Promise(r => setTimeout(r, spacingMs));
            return task();
        });
        chain = p.catch(() => { });
        return p;
    };
}

export async function tavilySearch(query, maxResults = 4) {
    const key = getBackendKey('tavily');
    if (!key) return [];
    try {
        const res = await safeFetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Terramentor/1.0 (educational tool)',
            },
            body: JSON.stringify({
                query,
                search_depth: 'basic',
                max_results: Math.min(Math.max(maxResults, 1), 8),
                include_raw_content: false,
            }),
            signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) {
            console.log(`[Search/Tavily] Declined with ${res.status}`);
            throw new Error(`Tavily declined with ${res.status}`);
        }
        return tavilyParse(await res.json());
    } catch (e) {
        console.log('[Search/Tavily] Failed:', e.message);
        throw e;
    }
}

export async function braveSearch(query, maxResults = 4) {
    const key = getBackendKey('brave');
    if (!key) return [];
    const run = async () => {
        try {
            const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(Math.max(maxResults, 1), 10)}`;
            const res = await safeFetch(url, {
                headers: {
                    'X-Subscription-Token': key,
                    'Accept': 'application/json',
                    'User-Agent': 'Terramentor/1.0 (educational tool)',
                },
                signal: AbortSignal.timeout(12000),
            });
            if (!res.ok) {
                console.log(`[Search/Brave] Declined with ${res.status}`);
                throw new Error(`Brave declined with ${res.status}`);
            }
            return braveParse(await res.json());
        } catch (e) {
            console.log('[Search/Brave] Failed:', e.message);
            throw e;
        }
    };
    return braveQueue(run);
}

export async function jinaSearch(query, maxResults = 4) {
    const key = getBackendKey('jina');
    if (!key) return [];
    try {
        // Measured 2026-09-19: without a key this endpoint answers 401
        // AuthenticationRequiredError — an earlier "20 requests a minute
        // keyless" figure no longer holds, so a key is required, full stop.
        const res = await safeFetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
            headers: {
                'Authorization': `Bearer ${key}`,
                'Accept': 'application/json',
                'User-Agent': 'Terramentor/1.0 (educational tool)',
            },
            signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) {
            console.log(`[Search/Jina] Declined with ${res.status}`);
            throw new Error(`Jina declined with ${res.status}`);
        }
        return jinaParse(await res.json()).slice(0, Math.max(maxResults, 1));
    } catch (e) {
        console.log('[Search/Jina] Failed:', e.message);
        throw e;
    }
}

// ── Is this key any good? ────────────────────────────────────────────────────

/** What a test asks for. Any query costs the same one request, so it is a word
 *  with results everywhere rather than anything about the learner. */
const TEST_QUERY = 'encyclopedia';

/**
 * Whether a saved key actually works — the only honest way to know is to ask
 * the service, so this spends ONE real search against the learner's quota.
 * Nothing calls it on a timer or on page load for that reason: Settings tests
 * a key at the moment one is saved, and again when the Test button is pressed.
 *
 * `configured: false` is not a failure — a backend with no key has nothing to
 * be wrong yet, which is a different thing to say than "not connected".
 */
export async function testSearchBackend(provider) {
    const run = { tavily: tavilySearch, brave: braveSearch, jina: jinaSearch }[provider];
    if (!run) throw new Error(`Unknown search backend: ${provider}`);
    if (!getBackendKey(provider)) return { configured: false, ok: false };
    try {
        const results = await run(TEST_QUERY, 1);
        // A key that answers 200 with nothing is not a working key: the query
        // is a dictionary word, so an empty answer means the plan, the quota or
        // the parser — not the question.
        if (!results.length) return { configured: true, ok: false, error: 'Answered with no results' };
        return { configured: true, ok: true };
    } catch (e) {
        return { configured: true, ok: false, error: String(e?.message || e) };
    }
}
