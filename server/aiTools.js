// What a chat turn may go and LOOK UP before it answers.
//
// The app's answering path has always retrieved the same two things in the same
// order, whatever was asked: the vault chunks that matched the learner's
// wording, and — if they had ticked the box for that one question — a single
// web search on that same wording. Retrieval decided by the question's phrasing
// is retrieval that cannot follow a question. "Is that still the rule for 2026,
// and what changed?" is two searches; "what does my textbook call this, and is
// there a project of mine on it already?" is a search of a different KIND; and
// a question that needs nothing at all still paid for a search engine round
// trip because a switch was left on.
//
// So the model asks. Before the answer streams, it gets one short, cheap turn
// whose entire output is a list of lookups it wants — none, or up to three —
// and it gets that turn again after seeing what came back, so a result can
// change the next query. Then the answer is written once, with what it found:
// a page or a document is numbered into the same citable block the vault
// already fills (server/citations.js) and carries a `[[src:N]]` marker, while
// the learner's own filing goes in as plain context, because a citation exists
// so a claim can be CHECKED somewhere and their own project list is not that.
//
// WHY A TEXT PASS AND NOT OPENAI TOOL CALLS. `tools`/`tool_calls` is the
// obvious mechanism and it is the wrong one here. This app points at whatever
// OpenAI-compatible endpoint the learner configured — a llama-server on their
// own machine, a router, an aggregator — and tool calling is the part of that
// API surface that is least uniformly implemented: it needs a chat template
// that emits the right special tokens, and when it is missing the failure is a
// 400 or, worse, a plausible-looking empty call. The app already made this
// trade once — it uses no constrained decoding anywhere, because generation is
// prompt-and-repair rather than schema-enforced — and the marker conventions
// everywhere else — `[[open:p:n]]`, `[[set:k:v]]`, `[[src:N]]` — are the same
// bet: ask for plain text, validate it here, and let a malformed answer be
// nothing rather than an error. A line of text parses on every endpoint there
// is.
//
// WHAT A TOOL MAY BE. Everything here READS. A tool that wrote would be a model
// changing the learner's library on a misread, and the app's answer to that is
// unchanged: the assistant proposes, the learner presses. What is safe to do
// unattended is look, and looking is exactly what the answers were missing.

import { generateResponse, AI_PROMPTS } from './ai.js';
import { searchWebSources } from './webContext.js';
import { searchAll } from './search.js';
import { getUiLanguage } from './language.js';
import { logActivity } from './activityLog.js';

/** Lookups one turn may ask for in a single round. */
const MAX_CALLS_PER_ROUND = 3;
/** Lookups one turn may ask for in total, across every round. */
const MAX_CALLS_PER_TURN = 6;
/** How many times the model is asked "anything else?" — 2 means one refinement. */
const MAX_ROUNDS = 2;
/** How many saved links one library lookup may add, deduped by address. */
const MAX_RESOURCE_HITS = 2;
/**
 * How long the decision pass may take before the turn gives up and answers.
 *
 * Its output is a list of at most three short lines, so this is generous for
 * the work; what it really bounds is WAITING. A local server with one slot
 * (llama-swap here) puts this question behind whatever background lesson is
 * already generating, and on the default 60s the learner sat in front of
 * "Thinking..." for a full minute before a turn that then ran no lookups at
 * all - measured on 2026-09-15.
 *
 * Not lower than this, though, and 25s was: this is the FIRST call of a turn,
 * so on a cold local endpoint it pays the model load (~20-40s for a 21GB MoE
 * through llama-swap) that the answer would have paid anyway. Timing out there
 * saves the learner nothing - the answer pass then waits for the same load -
 * and it silently costs every lookup on the first question after a restart.
 */
const DECISION_TIMEOUT_MS = 45000;

/* ── the tools ──────────────────────────────────────────────────────────── */

/**
 * Search the live web.
 *
 * The only tool that sends the learner's words off the machine, which is why it
 * exists behind two gates the others do not have (see webContext.js) and why
 * the query it ran is shown in the conversation as it happens and kept there: a
 * claim you can click is half of it, and watching what gets typed into a search
 * engine on your behalf is the other half.
 */
const searchWebTool = {
    name: 'search_web',
    arg: 'a search query, phrased as you would type it into a search engine',
    why: 'facts that change — this year\'s rules, a current version, a price, a date, recent news — or anything you would otherwise have to guess at',
    note: (q) => `Searching the web: “${q}”`,
    async run(query) {
        // The search itself, its result caps and its own fail-closed reading of
        // the setting stay in webContext.js — this tool is the model's handle
        // on it, not a second copy of it.
        const items = await searchWebSources(query);
        return {
            items,
            // `summary` is for the model's second round (English, like every
            // other server-written string); `count` is for the screen, where
            // the sentence around it is the learner's own language.
            count: items.length,
            summary: items.length ? `${items.length} page${items.length === 1 ? '' : 's'}` : 'no results',
        };
    },
};

/**
 * Search the learner's OWN library — projects, topics, documents.
 *
 * The assistant's prompt has always ended with a hard-won paragraph: the
 * snapshot is the whole of what you know, a project that is absent is one you
 * cannot SEE rather than one that does not exist, so never say "you have no
 * such project". That paragraph is an apology for a missing capability. The
 * snapshot is today's cross-project state — it is not, and should not become,
 * a dump of every topic in the library — so a question about a project the
 * learner is not currently behind on was unanswerable by construction.
 *
 * This is the cheapest tool here by a wide margin: a local ranked search over
 * rows already in SQLite, no network and no model. It also returns the ids the
 * assistant's `[[open:p:n]]` marker needs, so "open that topic for me" stops
 * depending on the topic happening to be in today's snapshot.
 *
 * IT IS CONTEXT, NOT A SOURCE. What comes back is the learner's own filing —
 * their project names, their topic titles — and numbering that into the citable
 * list produced answers signed `Sources: Your library — nothing matches "driving
 * theory"`, which is a citation of the app telling itself something. A citation
 * exists so a claim can be CHECKED somewhere: a web page and a vault document
 * both have somewhere. A list of their own project names does not, and the
 * learner is the authority on it anyway.
 */
/**
 * The projects a lookup should have found, which is not always what one search
 * returns.
 *
 * `searchAll` scores a row by how much of the QUERY it matches, so a
 * two-word question is answered best by whatever contains both words — and a
 * learner's project rarely does. Measured: a library holding a course whose
 * title carried the word "driving" but not the word "theory" answered
 * "driving theory" with a saved link and NO project at all, because the link's
 * title happened to contain both words. The assistant
 * then said there was no such project, which is exactly the sentence this tool
 * exists to stop it from saying.
 *
 * So when a multi-word lookup finds no project, each word is tried on its own
 * and the project hits are merged. Deliberately only for PROJECTS, and only as
 * a fallback: widening every search by token would drown a precise question in
 * everything that shares one common word with it.
 */
function projectsFor(query, res) {
    if (res.projects.length) return res.projects;
    const words = String(query).split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2);
    if (words.length < 2) return res.projects;
    const found = [];
    for (const word of words) {
        for (const p of searchAll(word, { limit: 3 }).projects) {
            if (!found.some(x => x.projectId === p.projectId)) found.push(p);
            if (found.length >= 4) return found;
        }
    }
    return found;
}

const findInLibraryTool = {
    name: 'find_in_library',
    arg: 'a word or two to look for in the learner\'s own projects, topics and documents',
    why: 'anything about what the learner already has that today\'s snapshot does not show — a project, a deck, a topic, one of their documents',
    note: (q) => `Looking through your library for “${q}”`,
    async run(query) {
        const res = searchAll(query, { limit: 5 });
        const lines = [];
        for (const p of projectsFor(query, res)) {
            lines.push(`Project "${p.title}" (projectId ${p.projectId})`);
        }
        for (const n of res.nodes) {
            const where = n.projectName ? ` in project "${n.projectName}"` : '';
            lines.push(`Topic "${n.title}" (projectId ${n.projectId}, nodeId ${n.nodeId})${where}${n.status ? `, ${n.status}` : ''}${n.snippet ? `: ${n.snippet}` : ''}`);
        }
        for (const d of res.documents) {
            lines.push(`Document "${d.title || 'Untitled'}" in the vault${d.projectName ? ` (project "${d.projectName}")` : ''}${d.snippet ? `: ${d.snippet}` : ''}`);
        }
        // Saved links come last and sparingly. A project's topics carry dozens
        // of them and a word like "driving" matches the same site four times:
        // measured on the real library, "driving theory" returned one project,
        // one topic and FIVE resources, four of which were one URL. Deduped by
        // address and capped, so the answer to "have I got a project on this"
        // is not buried under a link list.
        const seenUrls = new Set();
        for (const r of res.resources) {
            if (r.url && seenUrls.has(r.url)) continue;
            if (r.url) seenUrls.add(r.url);
            if (seenUrls.size > MAX_RESOURCE_HITS) break;
            lines.push(`Saved link "${r.title}"${r.url ? ` (${r.url})` : ''}${r.nodeTitle ? ` on topic "${r.nodeTitle}"` : ''}`);
        }
        if (!lines.length) {
            // An empty result is a REAL answer, and the only tool result worth
            // stating as one: it is the difference between "I cannot see
            // whether you have a Dutch project" and "you have not got one".
            return {
                context: `A search of every project name, topic title, saved link and vault document for "${query}" found NO match. This search covers the whole library, so you may say plainly that there is nothing on this — it is not a gap in what you can see.`,
                count: 0,
                summary: 'nothing',
            };
        }
        return {
            // The ids are here so the assistant can POINT at a row; measured
            // once without the second sentence, it wrote "(projectId 2)" into
            // the answer and invented `[[open:2:root]]` for a project that has
            // no node id in the list at all.
            context: `In the learner's own library, matching "${query}":\n${lines.join('\n')}\n`
                + 'The ids above are real. Use one ONLY inside an [[open:projectId:nodeId]] marker, never in a sentence the learner reads, and never invent one for a row that does not carry it — a project line has no node id, so it cannot be opened this way.',
            count: lines.length,
            summary: `${lines.length} match${lines.length === 1 ? '' : 'es'}`,
        };
    },
};

/**
 * The tools this turn may use.
 *
 * `web` is the per-turn allowance (the setting AND, in ask mode, the switch by
 * the composer). `library` is off for the node tutor: it is answering about one
 * topic whose material it already has in full, and a tool nobody needs is a
 * round trip everybody pays for.
 */
export function chatTools({ web = false, library = false } = {}) {
    const tools = [];
    if (web) tools.push(searchWebTool);
    if (library) tools.push(findInLibraryTool);
    return tools;
}

/**
 * Of everything this turn looked up, what actually LEFT THE MACHINE.
 *
 * The answer's trailer names these and nothing else (server/citations.js), so
 * the test is a single one and it lives here, beside the tool that opens the
 * socket, rather than as a tool name typed out at the call site.
 */
export function webQueries(calls = []) {
    return calls.filter(c => c.tool === searchWebTool.name).map(c => c.arg);
}

/* ── the loop ───────────────────────────────────────────────────────────── */

/** One line of the model's answer: `tool_name: argument`. */
const CALL_RE = /^\s*[-*\d.)\s]*([a-z_]+)\s*[:(]\s*(.+?)\s*\)?\s*$/i;

/**
 * Parse the tool pass's output into calls we are willing to make.
 *
 * Deliberately forgiving about SHAPE and merciless about CONTENT: a small model
 * writes `- search_web: ...` or `1. search_web("...")` as often as the bare
 * form, and none of that is worth a failed lookup. But a tool that is not on
 * this turn's list, a name it invented, or an empty argument produces nothing —
 * the same contract as an invented node id.
 */
export function parseToolCalls(text, tools) {
    const byName = new Map(tools.map(t => [t.name, t]));
    const calls = [];
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line || /^none\b/i.test(line)) continue;
        const m = line.match(CALL_RE);
        if (!m) continue;
        const tool = byName.get(m[1].toLowerCase());
        if (!tool) continue;
        // Quotes around the argument are the model quoting a query, not part of
        // one; a trailing full stop is prose habit. Both would be searched for.
        const arg = m[2].replace(/^["“'`]+|["”'`.]+$/g, '').trim();
        if (arg.length < 2 || arg.length > 200) continue;
        if (calls.some(c => c.tool === tool.name && c.arg.toLowerCase() === arg.toLowerCase())) continue;
        calls.push({ tool: tool.name, arg });
        if (calls.length >= MAX_CALLS_PER_ROUND) break;
    }
    return calls;
}

/**
 * Let the model look things up, then hand back what it found.
 *
 * Never throws. A dead network, an endpoint that went away mid-decision, a
 * model that answers the tool pass with a paragraph of prose — all of them are
 * a turn with fewer sources, never a failed answer. That is the same rule the
 * web path has always had, and it is what makes this safe to put in front of
 * every turn: the worst case is the app exactly as it was.
 *
 * Two kinds of result come back, and the difference matters at the other end:
 * `items` are CITABLE sources (a web page, a document) that get numbered and
 * can carry a `[[src:N]]` marker, while `context` is everything the model
 * should know but nobody can check by following a link — the learner's own
 * filing. Numbering the second kind produced answers signed "Sources: Your
 * library".
 *
 * @returns {Promise<{items: {title, content, url?}[], context: string[], calls: {tool, arg, summary}[]}>}
 */
export async function runToolRounds({ question, tools = [], pageContext = '', emit, signal } = {}) {
    const items = [];
    const context = [];
    const calls = [];
    if (!tools.length || !String(question || '').trim()) return { items, context, calls };

    const startedAt = Date.now();
    try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
            if (signal?.aborted || calls.length >= MAX_CALLS_PER_TURN) break;

            const { system, user } = AI_PROMPTS.tool_use({
                question,
                tools,
                pageContext,
                done: calls,
                found: items,
                round,
                uiLang: getUiLanguage(),
            });
            let decision = '';
            try {
                decision = await generateResponse(user, system, [], {
                    temperature: 0.1,
                    // The decision is a list, not an argument. Reasoning here
                    // buys nothing and costs the learner the seconds before
                    // their answer starts.
                    think: false,
                    operation: 'summary',
                    timeout: DECISION_TIMEOUT_MS,
                    signal,
                });
            } catch (e) {
                if (signal?.aborted) break;
                // An EMPTY reply is not "nothing needed" — it is an endpoint
                // that could not answer the question, and the two must not look
                // the same in a log. Measured on a reasoning-first local model
                // served over the OpenAI path (Qwen3.6-35B through llama-swap,
                // 2026-09-15): the whole budget went to the reasoning channel
                // and `content` came back empty, so every lookup was silently
                // skipped on a turn that looked completely normal. `ai.js` now
                // asks unattended work for a brief budget and reports an empty
                // reply as one, so this arrives as an error with its own reason
                // rather than as an indistinguishable blank.
                console.error(`[tools] ${e.emptyReply ? 'no decision — ' : 'decision failed: '}${e.message}`);
                break;
            }

            const wanted = parseToolCalls(decision, tools)
                .slice(0, MAX_CALLS_PER_TURN - calls.length)
                // A model asked twice in one turn will ask twice for the same
                // thing; running it again would cost a round trip to learn
                // nothing and would list the same page as two sources.
                .filter(c => !calls.some(d => d.tool === c.tool && d.arg.toLowerCase() === c.arg.toLowerCase()));
            if (!wanted.length) break;

            const byName = new Map(tools.map(t => [t.name, t]));
            // Every lookup is announced BEFORE it runs and updated when it
            // lands, so the learner watches it happen rather than reading
            // afterwards that it did. The whole list goes out each time — six
            // items at most, and the client then never has to merge anything.
            for (const c of wanted) calls.push({ ...c, state: 'running' });
            emit?.({ actions: calls.map(c => ({ ...c })) });

            const results = await Promise.allSettled(
                wanted.map(c => byName.get(c.tool).run(c.arg)),
            );
            results.forEach((r, i) => {
                const call = calls.find(c => c.tool === wanted[i].tool && c.arg === wanted[i].arg);
                const value = r.status === 'fulfilled' ? r.value : null;
                if (r.status === 'rejected') console.error(`[tools] ${call.tool} failed:`, r.reason?.message);
                call.state = 'done';
                call.summary = value?.summary || 'nothing';
                call.count = Number.isFinite(value?.count) ? value.count : 0;
                for (const item of (value?.items || [])) {
                    if (item.url && items.some(x => x.url === item.url)) continue;
                    items.push(item);
                }
                if (value?.context) context.push(String(value.context));
            });
            emit?.({ actions: calls.map(c => ({ ...c })) });
        }
    } catch (e) {
        // The loop itself broke. Whatever it had already found is still good.
        console.error('[tools] loop failed:', e.message);
    }
    // Nothing is left mid-flight in the record: a lookup the loop abandoned
    // (cancelled, or the endpoint went away between deciding and running) is
    // reported as what it is, never as a row that spins for ever.
    for (const c of calls) {
        if (c.state !== 'done') { c.state = 'done'; c.summary = c.summary || 'stopped'; }
    }

    if (calls.length) {
        logActivity({
            area: 'ai',
            event: 'ai.tools',
            ms: Date.now() - startedAt,
            // Metadata only — the QUERY is the learner's own words and belongs
            // in their conversation, not in a file written to be handed to a
            // stranger (server/activityLog.js).
            detail: `${calls.length} lookup${calls.length === 1 ? '' : 's'}: ${calls.map(c => c.tool).join(', ')} · ${items.length} sources`,
        });
    }
    return { items, context, calls };
}
