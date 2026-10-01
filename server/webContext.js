// Answering from the live web, when — and only when — the learner has asked
// for it.
//
// The app already searches the web: `webSearch` (DuckDuckGo, Wikipedia, GitHub
// and a self-hosted SearXNG if one is configured) has always fed resource
// hunting during project creation. What it never fed was an ANSWER, so the
// tutor could not tell you today's exam-board rule, this year's syntax, or
// anything that changed after its training cut-off — the one question a local
// model is worst at and most confident about.
//
// Two things make this safe to add rather than a hole in the app's promise.
//
//   1. IT IS OFF UNTIL SOMEONE TURNS IT ON. `SECURITY.md` says a learner's data
//      never leaves their machine and offers a packet capture to prove it; a
//      chat question is a far more personal thing to hand DuckDuckGo than a
//      topic title, so this is a setting the learner sets (`ai_web_search`,
//      `off` or `on` — see `webSearchEnabled`). Off, nothing here ever opens a
//      socket. And because the model now writes the query rather than the app
//      sending the learner's wording verbatim (server/aiTools.js), what was
//      typed into a search engine is written into the answer the learner keeps.
//   2. WHAT COMES BACK IS A SOURCE, NOT AN ANSWER. Results are numbered into
//      the same block the vault's own chunks go into (server/citations.js) and
//      cited the same way, so a claim taken from a web page is a claim the
//      learner can click. Unattributed web text in a tutor answer would be
//      strictly worse than no web at all: it would look exactly like the
//      model's own knowledge.
//
// Kept deliberately thin — one query, the top few results, and the text of the
// best one or two pages. A tutor turn that spends thirty seconds crawling is a
// tutor turn nobody waits for.

import db from './database.js';
import { webSearch, fetchPageContent } from './ai.js';

/** How many search results are offered to the model at all. */
const MAX_RESULTS = 4;
/** How many of those get their page fetched and read (the expensive half). */
const MAX_PAGES = 2;
/** Characters kept per page. A local model's context is the binding constraint. */
const PAGE_CHARS = 1500;

/**
 * Is web answering switched on? Default off, and off on anything else at all.
 *
 * ONE SWITCH, not a mode, and no per-question control beside the composer.
 * Three states — `off`, `ask`, `auto` — answer the question "who decides
 * whether to search", and that question is only a real one while the APP
 * writes the query from the learner's own wording. The MODEL writes it
 * (server/aiTools.js): it decides mid-answer whether a question needs looking
 * up and what to type, so "ask me each question" and "whenever it helps"
 * resolve to the same wire — the tool is on it and the model uses it or does
 * not. Two labels for one behaviour is a setting that cannot be set wrong OR
 * right, and a switch by the composer asks the permission Settings has
 * already been asked for.
 *
 * The migration is in server/database.js and it FAILS CLOSED: `auto` was
 * blanket permission and becomes `on`, while `ask`/`true` — where every single
 * turn needed a fresh yes that defaulted to no — becomes `off`. An install
 * that never granted a turn its permission does not get it granted wholesale
 * by an upgrade; the setting is one switch away and says so.
 *
 * So the only value that opens a socket is the literal `on`. Anything else,
 * and any error at all, is off: this setting backs a sentence in SECURITY.md,
 * and a sentence like that fails closed.
 */
export function webSearchEnabled() {
    try {
        return db.prepare('SELECT value FROM settings WHERE key = ?').get('ai_web_search')?.value === 'on';
    } catch {
        return false;
    }
}

/**
 * Search the web for one turn and return citable sources.
 *
 * Never throws: a dead network, a blocked host or a search source that changed
 * its HTML is a turn with fewer sources, never a failed answer. The shape
 * matches what `formatSourceContext` takes, so web results and vault chunks are
 * one numbered list.
 *
 * `failed` separates two empties the learner reads differently: a search that
 * RAN and found nothing is a real answer, while an engine that refused the
 * request or could not be reached (DuckDuckGo throttles by IP — a 202 with an
 * empty body) is a check that never happened. Collapsing the two made answers
 * claim "no results" for a search that never ran.
 *
 * @returns {Promise<{items: {title: string, content: string, url: string}[], failed: boolean}>}
 */
export async function searchWebSources(query, { maxResults = MAX_RESULTS } = {}) {
    const q = String(query || '').trim();
    if (!q || !webSearchEnabled()) return { items: [], failed: false };

    let found = [];
    let failed = false;
    try {
        const res = await webSearch(q, maxResults);
        found = res?.success ? res.results : [];
        // Sources that were ASKED and could not answer at all — a rejected
        // fetch, a throttled endpoint — count as an engine that refused, not
        // as an answer of zero.
        failed = !found.length && (res?.sourceErrors ?? 0) > 0;
    } catch (e) {
        console.error('[web] search failed:', e.message);
        return { items: [], failed: true };
    }
    if (!found.length) return { items: [], failed };

    // The snippet a search engine returns is a sentence; it is enough to CITE
    // but rarely enough to answer from, so the top few pages are read in full.
    // The rest keep their snippet: a source the model can name and the learner
    // can click still beats a claim from nowhere.
    //
    // A hosted result that ARRIVED with its text (Tavily's query-relevant
    // chunks, Jina's extracted page — both carry a `text` when it is long
    // enough to answer from, server/searchBackends.js) skips its fetch: the
    // fetch would re-download what the search already delivered, one round
    // trip per result, and would spend the MAX_PAGES budget that a thin
    // snippet needs far more.
    const textReady = new Map();
    const toFetch = [];
    found.forEach((r, i) => {
        const text = typeof r.text === 'string' ? r.text.trim() : '';
        if (text.length >= 200) textReady.set(i, text);
        else toFetch.push(i);
    });
    const fetched = await Promise.allSettled(
        toFetch.slice(0, MAX_PAGES).map(i => fetchPageContent(found[i].url, PAGE_CHARS)),
    );
    const pageByIndex = new Map(toFetch.slice(0, MAX_PAGES).map((foundIndex, k) => [foundIndex, fetched[k]]));

    return {
        items: found.map((r, i) => {
            const settled = pageByIndex.get(i);
            const page = settled?.status === 'fulfilled' ? settled.value : null;
            const body = textReady.get(i)
                || (page?.success && page.content ? page.content : String(r.description || r.snippet || '').trim());
            return {
                title: String(r.title || r.url).trim(),
                url: r.url,
                content: body || '(no readable text at this address)',
            };
        }),
        failed: false,
    };
}
