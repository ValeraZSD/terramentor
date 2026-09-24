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
// TWO PROTOCOLS, ONE BUDGET. On an OpenAI-compatible endpoint the turn uses
// native `tools`/`tool_calls` (`runNativeAgentTurn`, up to NATIVE_MAX_ROUNDS).
// Tool calling is the least uniformly implemented part of that API (it needs a
// chat template with the right special tokens), so an endpoint that refuses it
// is remembered and served the TEXT protocol instead (`runToolRounds`: a line
// per lookup, parsed here), as is Ollama. The text protocol is the same bet as
// the `[[open:p:n]]`/`[[set:k:v]]`/`[[src:N]]` markers: plain text parses on
// every endpoint, and a malformed line is nothing rather than an error. Both
// spend from MAX_CALLS_PER_TURN.
//
// WHAT A TOOL MAY BE. Everything here READS. A tool that wrote would be a model
// changing the learner's library on a misread, and the app's answer to that is
// unchanged: the assistant proposes, the learner presses. What is safe to do
// unattended is look, and looking is exactly what the answers were missing.

import { generateResponse, AI_PROMPTS } from './ai.js';
import { searchWebSources } from './webContext.js';
import { formatSourceContext } from './citations.js';
import { searchAll } from './search.js';
import { resolveProject, projectStateText, projectListText } from './projectState.js';
import { getUiLanguage } from './language.js';
import { logActivity } from './activityLog.js';

/** Lookups one turn may ask for in a single round. */
const MAX_CALLS_PER_ROUND = 3;
/**
 * Lookups one turn may ask for in total, across every round. 12 because the
 * native loop spends its budget in SMALL calls (one query at a time, several
 * rounds) — the text protocol asked one round for three at a time, so 6
 * covered two rounds; an agentic turn asking 4 sequential questions ("find X,
 * then check Y against Z") would hit 6 and stop mid-thought. Shared by both
 * protocols so a turn costs the same however it is spoken.
 */
export const MAX_CALLS_PER_TURN = 12;
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
/**
 * What a web search says it did, in the three words the answer prompt and the
 * screen both read.
 *
 * Three outcomes, not two: a search that ran and found nothing is a real
 * answer ("no results"), but an engine that REFUSED the request — DuckDuckGo
 * throttles by IP, a 202 with an empty body — is a check that never happened,
 * and the two must not share a word (the gap line in index.js keys on the
 * exact string "the search failed").
 */
export function searchSummary(count, failed = false) {
    if (failed) return 'the search failed';
    return count ? `${count} page${count === 1 ? '' : 's'}` : 'no results';
}

const searchWebTool = {
    name: 'search_web',
    arg: 'a search query, phrased as you would type it into a search engine',
    why: 'facts that change — this year\'s rules, a current version, a price, a date, recent news — or anything you would otherwise have to guess at',
    note: (q) => `Searching the web: “${q}”`,
    async run(query) {
        // The search itself, its result caps and its own fail-closed reading of
        // the setting stay in webContext.js — this tool is the model's handle
        // on it, not a second copy of it.
        const { items, failed } = await searchWebSources(query);
        return {
            items,
            // `summary` is for the model's second round (English, like every
            // other server-written string); `count` is for the screen, where
            // the sentence around it is the learner's own language.
            count: items.length,
            summary: searchSummary(items.length, failed),
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
 * One project in depth (server/projectState.js). The row shows the project's
 * NAME rather than whatever the model typed — usually an id, which reads as
 * nothing to the learner watching the row.
 */
const projectStateTool = {
    name: 'project_state',
    // An id is a usable argument, and project 1 is one character long.
    minArg: 1,
    arg: 'the project\'s id (projectId) or its name',
    why: 'one project in depth — progress, pace, deadline, every open topic with its nodeId and mastery, cards due, recent test scores — whenever an answer about a single course needs more than the snapshot\'s summary line, and before proposing a card or a mastery check on a topic the snapshot does not list',
    note: (q) => `Reading the state of project “${q}”`,
    async run(query) {
        const project = resolveProject(query);
        if (!project) {
            return {
                context: `There is no project matching "${query}". The learner's active projects are:\n${projectListText() || '(none)'}\nAsk again with one of these ids if one of them was meant.`,
                count: 0,
                summary: 'no such project',
            };
        }
        return { context: projectStateText(project.id), count: 1, label: project.name, summary: 'read' };
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
    if (library) tools.push(findInLibraryTool, projectStateTool);
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

/**
 * Does this turn carry a live web lookup?
 *
 * The answer prompt has to SAY so (server/ai.js appIdentity): a model that
 * holds the tool and has been told the app does the searching apologises
 * instead of using it, and a model with no tool invents a reason it has no
 * internet. Both are one boolean, and it is read from the turn's own tool list
 * rather than from the setting — the setting, the composer switch and the
 * endpoint's capabilities have all already been folded into that list, and a
 * second reading of any of them is a second chance to disagree with it.
 */
export function hasWebTool(tools = []) {
    return tools.some(t => t.name === searchWebTool.name);
}

/* ── lookups asked for MID-ANSWER ────────────────────────────────────────── */
//
// The pass before the answer decides from the QUESTION alone; the model writing
// the answer is the one that actually finds out what it is missing. So the
// answer itself gets one escape hatch: it may END with lookup lines, the app
// runs them, and the model gets exactly one more pass to finish. Bounded —
// the turn cap shared with the native loop, one continuation, and the lines
// are the request, never part of the answer the learner keeps.

/**
 * The instruction that offers the answer pass that hatch. Empty when the turn
 * has no tools — a prompt that offers nothing must not ask for lines.
 */
export function toolTailRule(tools = []) {
    if (!tools.length) return '';
    return `\n\nONE MORE LOOKUP, IF THE ANSWER NEEDS IT: if what the sources above give you is not enough to answer honestly — a figure, a date, a current rule, something about the learner's library the snapshot does not show — you may END your reply with one or more lookup lines in exactly this form:\n\n${tools[0].name}: the query\n\nThe app runs them while the learner watches, adds what came back to the numbered list, and gives you one more pass to finish. Write the answer as far as you can first, then the lines. Ask only for something genuinely missing — never for anything the material above already settles, and never for more than ${MAX_CALLS_PER_TURN} lookups in one turn.`;
}

/** One line of prose, shaped like a call for a tool the turn actually has. */
function parseCallLine(line, byName) {
    const m = line.match(CALL_RE);
    if (!m) return null;
    const tool = byName.get(m[1].toLowerCase());
    if (!tool) return null;
    const arg = m[2].replace(/^["“'`]+|["”'`.]+$/g, '').trim();
    if (arg.length < argFloor(tool) || arg.length > 200) return null;
    return { tool: tool.name, arg };
}

/**
 * Split a finished reply into its answer and a trailing block of lookup lines.
 *
 * The tail is a run of AT LEAST ONE trailing line that each parse as a call for
 * a tool this turn has; the first line that does not parse stops the walk, so a
 * lookup line in the MIDDLE of prose is content and stays. Lines inside an
 * unclosed code fence never count — a code sample that mentions `search_web`
 * is text, and a spec half-delivered into a fence is where an answer often
 * legitimately ends. Deliberately conservative: a miss only means a turn that
 * answers as before, while a false hit would run searches the model never asked
 * for and rewrite an answer it had already finished.
 *
 * @returns {{head: string, calls: {tool: string, arg: string}[]}}
 */
export function extractToolTail(text, tools = []) {
    const body = String(text ?? '').replace(/\s+$/, '');
    if (!body || !tools.length) return { head: body, calls: [] };
    // An odd number of fence lines means the reply ends INSIDE a code block;
    // nothing in there is a request.
    const fences = (body.match(/^[ \t]*(?:```|~~~)/gm) || []).length;
    if (fences % 2) return { head: body, calls: [] };

    const byName = new Map(tools.map(t => [t.name, t]));
    const lines = body.split('\n');
    const tail = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        const parsed = parseCallLine(lines[i].trim(), byName);
        if (!parsed) break;
        tail.unshift(parsed);
    }
    if (!tail.length) return { head: body, calls: [] };
    const head = lines.slice(0, lines.length - tail.length).join('\n').replace(/\s+$/, '');
    return { head, calls: tail };
}

/**
 * Hold a streaming answer's trailing lines back until they can no longer grow
 * into a lookup request.
 *
 * The tail is only KNOWN to be one when the reply ends, but the learner is
 * reading token by token: emitted tool lines would have to be un-said once the
 * lookups run. So every chunk is screened before it is shown — the last line is
 * held whenever it could still become a call (it starts like a tool name, or
 * could be growing into one), and released the moment a following line makes it
 * ordinary prose. At stream end the held block either parses as lookups (the
 * caller runs them and continues from `head`) or is flushed as the content it
 * turned out to be. The cost is one line of latency on any line that begins
 * like a tool call; the benefit is that scaffolding is never on the screen and
 * never in the stored text.
 *
 * @param {{tools: object[], onChunk: (text: string) => void}} opts
 * @returns {{feed(chunk: string): void, end(): {tailCalls: object[], tailLength: number}}}
 */
export function createTailGuard({ tools = [], onChunk }) {
    const byName = new Map(tools.map(t => [t.name, t]));

    let buffer = '';
    let emitted = 0;
    let scanned = 0;   // offset after the last complete line already classified
    let safeEnd = 0;   // end of the last complete line that cannot be part of a tail
    const scan = () => {
        for (;;) {
            const nl = buffer.indexOf('\n', scanned);
            if (nl === -1) break;
            if (!parseCallLine(buffer.slice(scanned, nl).trim(), byName)) safeEnd = nl + 1;
            scanned = nl + 1;
        }
    };
    const flush = (upTo) => {
        if (upTo > emitted && onChunk) onChunk(buffer.slice(emitted, upTo));
        emitted = Math.max(emitted, upTo);
    };
    return {
        feed(chunk) {
            buffer += chunk;
            scan();
            // A trailing run of call-shaped lines stays held until a line that
            // cannot be one follows it — then the run was prose and is released.
            flush(safeEnd);
        },
        end() {
            const { head, calls } = extractToolTail(buffer, tools);
            if (calls.length) {
                // A confirmed request: the tail is never shown and never stored.
                flush(head.length);
                return { tailCalls: calls, tailLength: buffer.length - head.length };
            }
            flush(buffer.length);
            return { tailCalls: [], tailLength: 0 };
        },
    };
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
/**
 * A query that is the schema's own word rather than the model's question.
 * Measured 2026-09-23 on OpenRouter/glm-5.3-flash: asked for "dark mode, OLED
 * tint", the model called search_web with {"query":"placeholder"}, the search
 * ran, and the learner watched a row say the web had been searched for
 * "placeholder". Whole-string only — "placeholder text in html" is a question.
 */
const PLACEHOLDER_QUERIES = new Set([
    'placeholder', 'query', 'search', 'search query', 'your query', 'your query here', 'query here',
    'string', 'text', 'example', 'test', 'todo', 'none', 'null', 'undefined', 'n/a', 'argument', 'arg', 'input', '',
]);
/** The shortest argument a tool accepts: two characters for a search, whose
 *  one-letter query is noise; fewer where a tool says so (an id). */
const argFloor = (tool) => tool?.minArg ?? 2;

export function isPlaceholderQuery(arg) {
    const s = String(arg ?? '').toLowerCase().replace(/^[\s"'`<[{(]+|[\s"'`>\]})]+$/g, '').replace(/[.…]+$/g, '').trim();
    return PLACEHOLDER_QUERIES.has(s);
}

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
        if (arg.length < argFloor(tool) || arg.length > 200 || isPlaceholderQuery(arg)) continue;
        if (calls.some(c => c.tool === tool.name && c.arg.toLowerCase() === arg.toLowerCase())) continue;
        calls.push({ tool: tool.name, arg });
        if (calls.length >= MAX_CALLS_PER_ROUND) break;
    }
    return calls;
}

/** Same tool asking for the same thing twice in one turn runs once. */
const sameCall = (a, b) => a.tool === b.tool && a.arg.toLowerCase() === b.arg.toLowerCase();

/**
 * Run a batch of already-vetted calls against the turn's tools: announce them,
 * run them, fold what came back into the turn's `items`/`context`, mark the
 * call rows done. Shared by the pass before the answer (runToolRounds), the
 * mid-answer continuation (server/index.js) and the native loop — so the
 * screen, the caps and the dedupe behave identically wherever a lookup runs
 * from.
 *
 * The per-call split (`perCall`) is what the native loop needs: each
 * `role:"tool"` result message carries only THAT call's findings, numbered as
 * a contiguous slice of the turn's list — a wire-valid loop hands every
 * `tool_call_id` its own result.
 *
 * @param {{tool: string, arg: string}[]} wanted calls to run (already capped and deduped)
 * @param {object[]} tools this turn's tools
 * @param {{tool, arg, state, summary?, count?}[]} calls the turn's running record — appended to
 * @param {{title, content, url?}[]} items the turn's citable sources — appended to
 * @param {string[]} context the turn's non-citable context — appended to
 * @param {(frame: {actions: object[]}) => void} [emit]
 * @returns {Promise<{added: object[], perCall: {items: object[], context: string[], failed: boolean, summary: string}[]}>}
 */
export async function runToolCalls({ wanted, tools, calls, items, context, emit }) {
    const byName = new Map(tools.map(t => [t.name, t]));
    // Every lookup is announced BEFORE it runs and updated when it lands, so
    // the learner watches it happen rather than reading afterwards that it
    // did. The whole list goes out each time — six items at most, and the
    // client then never has to merge anything.
    for (const c of wanted) calls.push({ ...c, state: 'running' });
    emit?.({ actions: calls.map(c => ({ ...c })) });

    const added = [];
    const perCall = wanted.map(() => ({ items: [], context: [], failed: false, summary: 'nothing' }));
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
        // What the tool actually looked at, when the argument is not it (an id).
        if (typeof value?.label === 'string' && value.label) call.label = value.label.slice(0, 120);
        const mine = perCall[i];
        mine.summary = call.summary;
        mine.failed = call.summary === 'the search failed';
        for (const item of (value?.items || [])) {
            if (item.url && items.some(x => x.url === item.url)) continue;
            items.push(item);
            added.push(item);
            mine.items.push(item);
        }
        if (value?.context) {
            context.push(String(value.context));
            mine.context.push(String(value.context));
        }
    });
    emit?.({ actions: calls.map(c => ({ ...c })) });
    return { added, perCall };
}

/**
 * The prompt block carrying a MID-ANSWER lookup's results to the continuation
 * pass. Sources append to the turn's numbered list (the caller passes the
 * offset); the learner's own filing rides as plain context exactly as it does
 * before the answer; and when nothing usable came back, an engine that
 * REFUSED says so — "no results" for a search that never ran is the lie this
 * whole mechanism exists to prevent.
 *
 * @param {{addedItems?: object[], lateContext?: string[], offset?: number, failed?: boolean}} opts
 * @returns {string}
 */
export function lateResultsBlock({ addedItems = [], lateContext = [], offset = 0, failed = false } = {}) {
    const parts = [];
    if (addedItems.length) parts.push(formatSourceContext(addedItems, { offset }).text);
    if (lateContext.length) parts.push(lateContext.join('\n\n'));
    if (addedItems.length) {
        // The numbers are named, never "N": the tool result is the only place
        // the model learns what range these new entries took.
        parts.push(`Cite what you use from these as [[src:${offset + 1}]] through [[src:${offset + addedItems.length}]].`);
    }
    if (parts.length) return parts.join('\n\n');
    return failed
        ? 'The lookups the reply asked for could not be completed — the search engine refused the request or the network failed. Nothing was checked. Say plainly that you could not verify, answer from what you have, and mark anything you are not sure of as unverified.'
        : 'The lookups the reply asked for ran and found nothing usable. Say plainly that nothing came back, and answer from what you have.';
}

/* ── the native agent loop ───────────────────────────────────────────────── */

/** Agentic rounds one native turn may spend before a forced final answer. */
export const NATIVE_MAX_ROUNDS = 6;

/**
 * The turn's tools as OpenAI function schemas — the wire shape every
 * OpenAI-compatible surface (llama-server --jinja, OpenRouter, vLLM) accepts.
 * The internal descriptors carry `arg` (what a query looks like) and `why`
 * (when the tool exists at all); those become the parameter and function
 * descriptions, because that is all the wire can carry.
 */
export function wireTools(tools = []) {
    return tools.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: (t.why || `Use ${t.name} when the answer needs it.`).trim(),
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: (t.arg || 'What to look up').trim() },
                },
                required: ['query'],
                additionalProperties: false,
            },
        },
    }));
}

/**
 * A native call's arguments to the query string the internal tools run on.
 * Tolerant about shape, merciless about content — the same rule the text
 * parser lives by, for the same reason: the endpoint is whatever the learner
 * configured, and the measured failure is a model that emits the SHAPE
 * correctly with nothing usable in it. No usable query returns '' and the
 * loop answers that with a recovery note, never with a search for garbage and
 * never with a crash.
 */
export function parseToolArgs(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return '';
    try {
        const v = JSON.parse(s);
        if (typeof v === 'string') return v.trim().slice(0, 400);
        if (v && typeof v === 'object') {
            for (const key of ['query', 'q', 'search', 'argument', 'args', 'text', 'value']) {
                if (typeof v[key] === 'string' && v[key].trim()) return v[key].trim().slice(0, 400);
            }
            return '';
        }
        return '';
    } catch {
        // Truncated JSON (`{"query": "current ai ne`) — the arguments string
        // was cut mid-call. Recover what the model clearly meant.
        const m = s.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)/);
        if (m) return m[1].replace(/\\"/g, '"').trim().slice(0, 400);
        // Not JSON at all and not JSON-shaped: the model wrote the bare query.
        if (!/^[{["']/.test(s)) return s.slice(0, 400);
        return '';
    }
}

/**
 * The system-prompt addition native mode needs over the text protocol's: the
 * model decides by itself when to call, so the prompt must tell it that
 * calling is normal and that small calls across rounds are the intended
 * shape — a model told only "tools exist" calls once or never. The citation
 * rule rides along because tool results arrive as numbered blocks whose
 * numbering continues the prompt's list.
 */
export function nativeToolRule(tools = []) {
    if (!tools.length) return '';
    const names = tools.map(t => t.name).join(' and ');
    return `\n\nLIVE LOOKUPS: before answering you may call ${names}. Several small calls across several rounds are normal when the answer needs it — search for anything current or anything you would otherwise guess at, and search again with different words when results miss. Results arrive as a numbered source list: cite what you use as [[src:N]], never invent a source, and say plainly when a lookup found nothing or failed. A request to change a setting, open a screen or point at a topic needs no lookup at all — answer it directly.`;
}

/**
 * Did the endpoint refuse native tools? A 4xx whose body blames the `tools`
 * field — OpenRouter 400s with a "tools" message for models that cannot,
 * llama-server without --jinja refuses the request outright. A 5xx is never
 * counted: that is transient, not a capability verdict. The verdict is cached
 * for the process lifetime by the caller — the endpoint does not un-learn it
 * mid-session, and re-probing costs a failed request at the start of every
 * turn.
 */
export function isToolRefusalError(err) {
    const status = err?.httpStatus;
    if (!Number.isInteger(status) || status < 400 || status >= 500) return false;
    return /tool/i.test(String(err?.responseBody || ''));
}

const nativeCallKey = (tool, arg) => `${tool}:${String(arg).toLowerCase()}`;

/**
 * The native multi-turn loop: the model decides by itself when to look
 * something up, the app executes the calls and hands the results back as
 * `role:"tool"` messages, and the model keeps going until it has an answer it
 * is willing to write. This is the shape the wire defines — assistant message
 * carrying `tool_calls`, one tool message per `tool_call_id` — not a text
 * protocol smuggled through it.
 *
 * Termination is bounded three ways: a plain answer round ends the loop, the
 * round budget (`NATIVE_MAX_ROUNDS`) forces a tools-free final round, and the
 * call budget (`MAX_CALLS_PER_TURN`, shared with the text protocol) does the
 * same the moment it is spent — the model is TOLD the budget is gone rather
 * than left guessing why the tools vanished.
 *
 * Wire-validity is the whole discipline here: every call the model emitted is
 * echoed verbatim in the assistant message, and every one of their ids gets
 * exactly one `role:"tool"` reply — a malformed one says its arguments did
 * not parse, an unknown name says what the real tools are, a duplicate points
 * at the results already in hand, an over-budget one says the turn is out of
 * room. Strict endpoints refuse the round over a single missing id, so a gap
 * here is not a cosmetic detail.
 *
 * @param {object} opts
 * @param {string} opts.system the turn's system prompt (nativeToolRule is appended here)
 * @param {object[]} opts.history prior conversation turns (already sized)
 * @param {string} opts.message the learner's message
 * @param {object[]} opts.tools this turn's internal tool descriptors
 * @param {object[]} opts.items the turn's citable sources — appended to (shared with the caller)
 * @param {string[]} opts.context the turn's non-citable context — appended to
 * @param {object[]} opts.calls the turn's call record — appended to (drives the chips and the cap)
 * @param {(messages: object[], withTools: boolean) => AsyncIterable} opts.startRound
 *   one model request: the caller binds streaming, temperature and the abort signal
 * @param {(frame: object) => void} [opts.emit] SSE frames (chips, chunks, thinking)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{fullText: string, thinkingText: string, thinkingChars: number, calls: object[]}>}
 */
export async function runNativeAgentTurn({
    system, history = [], message, tools = [], items, context, calls, startRound, emit, signal,
}) {
    const msgs = [
        { role: 'system', content: system + nativeToolRule(tools) },
        ...history,
        { role: 'user', content: message },
    ];
    let fullText = '';
    let thinkingText = '';
    let thinkingChars = 0;
    let budgetTold = false;
    for (let round = 0; round <= NATIVE_MAX_ROUNDS; round++) {
        if (signal?.aborted) break;
        const budgetLeft = calls.length < MAX_CALLS_PER_TURN;
        const withTools = tools.length > 0 && budgetLeft && round < NATIVE_MAX_ROUNDS;
        if (!budgetLeft && !budgetTold) {
            msgs.push({
                role: 'system',
                content: 'The lookup budget for this turn is spent. Write the final answer now from what you have, and say plainly what you could not check.',
            });
            budgetTold = true;
        }
        let roundText = '';
        let roundCalls = null;
        for await (const part of startRound(msgs, withTools)) {
            if (!part || !part.type) continue;
            if (part.type === 'thinking' && part.content) {
                thinkingText += part.content;
                thinkingChars += part.content.length;
                emit?.({ thinking: thinkingChars, thinkingChunk: part.content });
            } else if (part.type === 'content' && part.content) {
                roundText += part.content;
                emit?.({ chunk: part.content });
            } else if (part.type === 'tool_calls' && Array.isArray(part.calls) && part.calls.length && withTools) {
                roundCalls = part.calls;
            }
        }
        if (roundText) fullText += roundText;
        if (!roundCalls) break; // a plain answer: the turn is done

        // Normalise first: every emitted call gets an id (some endpoints
        // stream none), and the SAME value goes into the assistant message and
        // the tool result, so id matching never depends on the endpoint having
        // been generous.
        roundCalls.forEach((rc, i) => { if (!rc.id) rc.id = `call_${round}_${i}`; });

        const wanted = [];
        const notes = new Map();
        const seen = new Set(calls.map(c => nativeCallKey(c.tool, c.arg)));
        for (const rc of roundCalls) {
            const tool = tools.find(t => t.name === rc.name);
            if (!tool) {
                notes.set(rc.id, `No tool named "${rc.name || '?'}" exists here. Available: ${tools.map(t => t.name).join(', ') || 'none'}. Use only these, or finish the answer from what you have.`);
                continue;
            }
            const arg = parseToolArgs(rc.arguments);
            if (arg.length < argFloor(tool) || arg.length > 400 || isPlaceholderQuery(arg)) {
                notes.set(rc.id, 'That call was malformed — its arguments did not contain a usable query. Call the tool again with one plain search query, or finish the answer from what you have.');
                continue;
            }
            if (seen.has(nativeCallKey(tool.name, arg))) {
                notes.set(rc.id, 'That exact lookup already ran this turn — its results are already in the numbered source list. Use what is there, or finish the answer.');
                continue;
            }
            seen.add(nativeCallKey(tool.name, arg));
            wanted.push({ tool: tool.name, arg, id: rc.id });
        }

        // The cap is shared with the text protocol: a round that asks for more
        // than the turn has left runs only what fits, and the rest are told
        // why they were not run — never a silent drop, which the model would
        // read as the search having failed.
        const room = MAX_CALLS_PER_TURN - calls.length;
        const overrun = wanted.slice(room);
        const runnable = wanted.slice(0, room);
        for (const w of overrun) {
            notes.set(w.id, 'The turn\'s lookup budget ran out before this lookup could run. Finish the answer from what you have, and say plainly what you could not check.');
        }

        const blocks = new Map();
        if (runnable.length) {
            const offset = items.length;
            const { perCall } = await runToolCalls({ wanted: runnable, tools, calls, items, context, emit });
            let off = offset;
            runnable.forEach((w, i) => {
                const mine = perCall[i];
                blocks.set(w.id, lateResultsBlock({
                    addedItems: mine.items, lateContext: mine.context, offset: off, failed: mine.failed,
                }));
                off += mine.items.length;
            });
        }

        msgs.push({
            role: 'assistant',
            content: roundText.trim() || null,
            tool_calls: roundCalls.map(rc => ({
                id: rc.id,
                type: 'function',
                function: {
                    name: rc.name || 'unknown',
                    arguments: typeof rc.arguments === 'string' && rc.arguments ? rc.arguments : '{}',
                },
            })),
        });
        for (const rc of roundCalls) {
            const block = blocks.get(rc.id) ?? notes.get(rc.id)
                ?? 'Nothing usable came back from that lookup. Say plainly that nothing came back, and answer from what you have.';
            msgs.push({ role: 'tool', tool_call_id: rc.id, content: block });
        }
    }
    return { fullText, thinkingText, thinkingChars, calls };
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
export async function runToolRounds({ question, tools = [], pageContext = '', history = [], emit, signal } = {}) {
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
                history,
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
                .filter(c => !calls.some(d => sameCall(d, c)));
            if (!wanted.length) break;

            await runToolCalls({ wanted, tools, calls, items, context, emit });
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
