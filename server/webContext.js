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
//      topic title, so this is a setting the learner sets (`off`, `ask` or
//      `auto` — see `webSearchMode`), plus a switch by the composer that a turn
//      can drop either way. Off, nothing here ever opens a socket. And because
//      the model now writes the query rather than the app sending the learner's
//      wording verbatim (server/aiTools.js), what was typed into a search
//      engine is written into the answer the learner keeps.
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
 * How the learner has set web answering: `off`, `ask` or `auto`.
 *
 * Three states rather than two because the question the setting answers
 * changed. It used to mean "may this turn run A search", and the learner
 * decided per question because the app decided the query (it was their own
 * wording, verbatim). Now the MODEL decides whether to search at all and what
 * to type — which is the thing that makes the feature useful, and also the
 * thing that makes "on" a bigger promise than it was. So there is a state for
 * each of the two honest answers to "who decides": `ask` keeps the per-question
 * switch in front of the composer, defaulted off, and `auto` hands the decision
 * to the model for every turn.
 *
 * `true` is read as `ask` — that is what the old checkbox meant, and an install
 * that ticked it must not silently be upgraded into the looser one. Anything
 * unrecognised, and any error at all, is `off`: the setting backs the sentence
 * in SECURITY.md, and a sentence like that fails closed.
 */
export function webSearchMode() {
    try {
        const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get('ai_web_search')?.value;
        if (raw === 'auto') return 'auto';
        if (raw === 'ask' || raw === 'true') return 'ask';
        return 'off';
    } catch {
        return 'off';
    }
}

/** Is web answering switched on at all? Default off, and off on any error. */
export function webSearchEnabled() {
    return webSearchMode() !== 'off';
}

/**
 * May THIS turn search, given the setting and what the composer sent?
 *
 * In `ask` the switch is the permission and its default is off, so a client
 * that sends nothing searches nothing. In `auto` the learner has already given
 * the permission once, in Settings — but the switch stays in the composer as an
 * opt-OUT, so `useWeb === false` is still honoured: a question you would rather
 * not have searched is a normal thing to have, and taking that away would be a
 * worse app than the one with the extra tick.
 */
export function webAllowedForTurn(useWeb) {
    const mode = webSearchMode();
    if (mode === 'off') return false;
    if (mode === 'auto') return useWeb !== false;
    return useWeb === true;
}

/**
 * Search the web for one turn and return citable sources.
 *
 * Never throws: a dead network, a blocked host or a search source that changed
 * its HTML is a turn with fewer sources, never a failed answer. The shape
 * matches what `formatSourceContext` takes, so web results and vault chunks are
 * one numbered list.
 *
 * @returns {Promise<{title: string, content: string, url: string}[]>}
 */
export async function searchWebSources(query, { maxResults = MAX_RESULTS } = {}) {
    const q = String(query || '').trim();
    if (!q || !webSearchEnabled()) return [];

    let found = [];
    try {
        const res = await webSearch(q, maxResults);
        found = res?.success ? res.results : [];
    } catch (e) {
        console.error('[web] search failed:', e.message);
        return [];
    }
    if (!found.length) return [];

    // The snippet a search engine returns is a sentence; it is enough to CITE
    // but rarely enough to answer from, so the top few pages are read in full.
    // The rest keep their snippet: a source the model can name and the learner
    // can click still beats a claim from nowhere.
    const pages = await Promise.allSettled(
        found.slice(0, MAX_PAGES).map(r => fetchPageContent(r.url, PAGE_CHARS)),
    );

    return found.map((r, i) => {
        const page = pages[i]?.status === 'fulfilled' ? pages[i].value : null;
        const body = page?.success && page.content ? page.content : String(r.description || r.snippet || '').trim();
        return {
            title: String(r.title || r.url).trim(),
            url: r.url,
            content: body || '(no readable text at this address)',
        };
    });
}
