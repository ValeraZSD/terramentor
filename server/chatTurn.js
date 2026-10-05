// One assistant turn: the sources it may cite, the lookups it makes, and the
// background task that streams and stores it. Used by routes/chat.js.
import db from './database.js';
import {
    AI_PROMPTS, aiProvenance, getAISettings, isReasoningLoop, searchDocuments,
    streamResponse,
} from './ai.js';
import { buildTodayBriefingContext } from './today.js';
import { formatSourceContext, resolveCitations } from './citations.js';
import { webSearchEnabled } from './webContext.js';
import {
    chatTools, createTailGuard, extractToolTail, hasDocumentTools, hasWebTool, isToolRefusalError,
    lateResultsBlock, LIBRARY_TEXT_BOUNDARY, MAX_CALLS_PER_TURN, paragraphBreak, runNativeAgentTurn,
    runToolCalls, runToolRounds, storedActions, toolTailRule, wireTools,
} from './aiTools.js';
import { getUiLanguage } from './language.js';
import * as tasks from './tasks.js';
import { assistantSettingsBlock, readSettable, settingsBefore } from './assistantSettings.js';
import {
    chatNowBlock, createStampFilter, resolveTimeZone, stampHistory, stripSendStamp,
} from './chatContext.js';
import { getGateConfig, getSetting } from './settingsStore.js';
import { activeGenerations } from './creationRuns.js';

// AI CHAT

/**
 * A stored message on its way to the client: the `actions` column is JSON and
 * the client wants a list. A row written by an older build (or by hand) has
 * null, and a row that somehow holds something else is treated as none — a
 * conversation must render, whatever is in one column of it.
 */
function withActions(row) {
    let actions = null;
    try {
        const parsed = row.actions ? JSON.parse(row.actions) : null;
        if (Array.isArray(parsed) && parsed.length) actions = parsed;
    } catch { /* not JSON: the message still renders */ }
    return { ...row, actions };
}

/**
 * Assemble everything one turn may cite: the learner's own vault (up to `limit`
 * chunks, hybrid FTS5 + sqlite-vec retrieval, keyword-only when embeddings are
 * off — hence async: embedding the query is a network call), then whatever
 * the model asked to look up before answering (server/aiTools.js — the live
 * web, gated; a search of the learner's own library, local and free).
 *
 * The vault is retrieved unconditionally from the learner's own wording, which
 * costs nothing and needs no permission. Everything after it is the model's
 * decision, and `calls` carries what it decided so the answer can say so.
 *
 * Returns the prompt block AND the numbered source list behind it: the answer
 * cites by number (`[[src:2]]`) and the app resolves those markers into real
 * titles (and, for a web page, a real link) afterwards, so a claim taken from
 * the learner's notes or from a page says which. See server/citations.js.
 *
 * The vault is searched first and listed first: it is the learner's own
 * material, and a model reads the top of a long context best.
 */
async function buildSourceContext(nodeId, projectId, message, { limit = 3, pageContext = '', history = [], emit, signal, native = false } = {}) {
    let chunks = [];
    try {
        // The open topic's documents and its course's first: a question asked
        // inside a topic is usually about it.
        chunks = await searchDocuments(message, nodeId, projectId, limit);
        // Retry on the topic's title when the learner's phrasing finds nothing —
        // short or anaphoric turns ("explain this again", "why?") carry no
        // retrievable terms. Only meaningful when there IS a topic.
        if (chunks.length === 0 && nodeId != null) {
            const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get(nodeId);
            if (node?.title) chunks = await searchDocuments(node.title, nodeId, projectId, limit);
        }
        // Then the whole library: standing in one course does not mean the
        // question is about it, and the answer may be in another one's files.
        if (chunks.length === 0 && (nodeId != null || projectId != null)) {
            chunks = await searchDocuments(message, null, null, limit);
        }
    } catch (e) {
        console.error('[sources] vault search failed:', e.message);
    }

    const items = chunks.map(c => ({ title: c.doc_title, content: c.content }));

    // Whether a lookup is on the wire is the SETTING and nothing else: the model
    // decides mid-answer whether it needs the web at all. Every library tool is
    // always on — listing, reading and searching the learner's own documents and
    // topics is local, free and needs no permission, so there is no switch for
    // it (the tutor's "Use docs" was one, and it only ever took answers away).
    const tools = chatTools({ web: webSearchEnabled(), library: true });

    // The excerpts are three PASSAGES ranked by the question's wording, and a
    // model handed them unlabelled reads them as the vault: "the only actual
    // file I have access to right now is one" about a project holding forty
    // (2026-09-28). Said beside them, where the model reads them.
    const excerptNote = chunks.length
        ? `\n\nSources 1–${chunks.length} above are EXCERPTS of the learner's documents, picked by how well they match this question — a few passages, never a list of what the vault holds. ${hasDocumentTools(tools)
            ? 'What documents exist comes from list_documents, and a document is read in full with read_document; never say a document does not exist, or that you can only see excerpts, on the strength of these.'
            : 'Do not infer from them what else the vault holds.'}`
        : '';

    // Native mode: the tools ride to the ANSWER call and the model decides
    // there, round by round (server/aiTools.js runNativeAgentTurn). The
    // pre-answer decision pass would only spend a model round answering the
    // question the loop is about to answer for itself — and on a single-slot
    // local server that round is the learner's first seconds of the turn.
    // The vault still comes from here (local, fast, listed first); the loop's
    // own results join the same numbered list mid-answer, so every
    // `[[src:N]]` stays true.
    if (native) {
        const { text, sources } = formatSourceContext(items);
        return {
            text: (text ? `\n\n${text}${excerptNote}` : ''),
            sources, calls: [], tools, items, context: [], native: true,
        };
    }

    // What the model wants looked up, in its own words. Runs even with the
    // vault empty — a question about the live web has nothing to do with
    // whether this learner keeps documents. `history` rides along because the
    // latest question may be a short follow-up ("так уже включён") that only
    // makes sense against the exchange it belongs to.
    const { items: found, context: looked, calls } = await runToolRounds({
        question: message,
        tools,
        pageContext,
        history,
        emit,
        signal,
    });
    items.push(...found);

    // What a lookup found that is not a CITABLE source — the learner's own
    // filing. It goes in as plain context: it must reach the answer, and it
    // must never end up numbered, because an answer signed "Sources: Your
    // library" cites nothing anyone can go and check.
    // It is also someone else's text when the course was imported, so it carries
    // the same boundary as a numbered source.
    const looking = looked.length ? `\n\n${looked.join('\n\n')}\n\n${LIBRARY_TEXT_BOUNDARY}` : '';

    const { text, sources } = formatSourceContext(items);
    // A lookup that came back with NOTHING has to reach the answer, or the
    // turn's two halves contradict each other: the answer confidently states
    // the thing from memory, and the line underneath it says the web was
    // searched for exactly that. The model decided it could not be sure — an
    // empty result is the answer to that, not a reason to forget the doubt.
    const empty = calls.filter(c => !c.failed && (!c.summary || /^(no results|nothing)$/.test(c.summary)));
    const broke = calls.filter(c => c.failed);
    const gap = (empty.length
        ? `\n\nLooked up and found NOTHING: ${empty.map(c => `“${c.arg}”`).join(', ')}. `
        + 'Say plainly that you could not check it, and answer from what you do know while naming what you could not confirm. Do not present a remembered figure, date or rule as current when the search for it came back empty.'
        : '')
        // A lookup that broke is not one that came back empty, and this line
        // sits after the library boundary so it reads as an instruction.
        + (broke.length
            ? `\n\nLooked up and could NOT CHECK (the lookup failed): ${broke.map(c => `“${c.arg}”`).join(', ')}. `
            + 'Nothing was checked there, so do not conclude that what it looked for is missing. Say plainly that you could not check it, and mark anything that depends on it as unconfirmed.'
            : '');

    // The tools, the source array and the context array ride back with the
    // block: the ANSWER may end by asking for a lookup (server/aiTools.js
    // extractToolTail), and the continuation needs the same tool set, the same
    // running record, and arrays its results join so every number stays true.
    return {
        text: (text ? `\n\n${text}${excerptNote}` : '') + looking + gap + toolTailRule(tools),
        sources, calls, tools, items, context: looked,
    };
}

/**
 * The lookups a finished reply asked for, run, and the one pass that finishes
 * the answer with them (server/aiTools.js — extractToolTail). Shared by the
 * streaming turn and the plain one: the same per-turn cap, the same dedupe as
 * the pass before the answer, and late sources numbered to CONTINUE the same
 * list, so every `[[src:N]]` the reply already wrote stays true.
 *
 * `tail` is the caller's own extractToolTail result — the caller has already
 * taken the request lines off its stored text. `answer(user, history)` writes
 * the continuation and returns its text; the streaming path runs its own tail
 * guard inside, so a continuation that ends by asking for yet another lookup
 * is dropped rather than shown or stored — one continuation per turn, and the
 * prompt says so too.
 *
 * An abort propagates: the caller's envelope saves the partial the same way it
 * would have without this. Any other failure is logged and the reply stands
 * without its continuation — the same "fewer sources, never a failed answer"
 * rule the lookup loop itself follows.
 *
 * @returns {Promise<string>} what the continuation added ('' when it wrote nothing)
 */
async function runLateLookups({ tail, tools, calls, items, context, message, system, history, emit, signal, answer, at = null }) {
    const remaining = MAX_CALLS_PER_TURN - calls.length;
    const wanted = tail.calls.slice(0, Math.max(0, remaining))
        // The pre-answer pass's dedupe, verbatim: a lookup already run this
        // turn is not run again for being asked for twice.
        .filter(c => !calls.some(d => d.tool === c.tool && d.arg.toLowerCase() === c.arg.toLowerCase()));

    let resultsBlock;
    if (wanted.length) {
        // The late block's numbers continue the list the reply already cited.
        const offset = items.length;
        // `at`: the answer had begun — these rows stand between its paragraphs.
        const { added } = await runToolCalls({ wanted, tools, calls, items, context, emit, at });
        // `failed` is set by runToolCalls for an engine that refused AND for a
        // tool that threw.
        const failed = wanted.some(c =>
            calls.find(d => d.tool === c.tool && d.arg === c.arg)?.failed === true);
        resultsBlock = lateResultsBlock({ addedItems: added, lateContext: context, offset, failed });
    } else {
        // The turn already spent its allowance. The honest version of that,
        // not a silent pretend-nothing-was-asked.
        resultsBlock = 'The reply asked for further lookups, but this turn has already spent its lookup budget, so they were not run. Finish the answer from what you have and say plainly what you could not check.';
    }

    const cont = AI_PROMPTS.continue_answer({ resultsBlock });
    // The model's own partial answer rides as the assistant turn before this
    // one — "continue from where you stopped" has to have something to
    // continue from.
    const contHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: tail.head }];
    try {
        return await answer(cont.user, contHistory);
    } catch (e) {
        if (signal?.aborted) throw e;
        console.error('[tools] continuation failed:', e.message);
        return '';
    }
}

// Endpoints that refused native tools, for the process lifetime (keyed
// provider|baseUrl|model). A 4xx blaming the `tools` field is a capability
// verdict that does not change mid-session; remembering it means the fallback
// to the text protocol is decided before the turn's first model call instead
// of costing the learner a failed request on every turn. A restart re-probes,
// so an endpoint that gained tool support is picked up when the app restarts.
const nativeToolsRefused = new Set();

/**
 * The assistant's own last few setting changes, newest first, with what each
 * replaced (`chat_messages.settings_before`) — so "undo" is something it can
 * do. A day back at most: a change older than that is not what "undo" means.
 */
function recentSettingChanges() {
    // Across every conversation: the settings are the app's, not a thread's.
    const rows = db.prepare(`
        SELECT settings_before, created_at FROM chat_messages
        WHERE role = 'assistant' AND settings_before IS NOT NULL
        ORDER BY created_at DESC, id DESC LIMIT 3
    `).all();
    const out = [];
    for (const r of rows) {
        const at = String(r.created_at || '');
        const ms = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(at) ? at : `${at.replace(' ', 'T')}Z`);
        const minutesAgo = Number.isFinite(ms) ? Math.max(0, Math.round((Date.now() - ms) / 60000)) : 0;
        if (minutesAgo > 24 * 60) continue;
        try { out.push({ minutesAgo, before: JSON.parse(r.settings_before) }); } catch { /* a bad row is skipped */ }
    }
    return out;
}

/**
 * Everything AI that is running or queued on this machine right now, for the
 * chat prompt (server/chatContext.js turns it into lines). The task registry is
 * the source: every generation registers there — the queue's own tasks, and
 * the self-managed ones (project creation, study-material runs, feed
 * preparation, indexing) as external tasks. Two additions, both tolerant of the
 * shape changing under them:
 *   - a creation's live run in `activeGenerations`, for an estimate the
 *     registry's mirror does not carry (read only if the run reports one);
 *   - a project flagged `ai_generating` that no task accounts for (a run the
 *     registry lost track of), so "is it still being made" has one answer.
 * `skip(task)` drops the turn's own task — it is running, and not news to it.
 * Never throws: the chat must answer even if this cannot.
 */
function collectRunningWork(skip = null) {
    try {
        const list = tasks.listTasks().filter(t => !(skip && skip(t)));
        const runs = [...activeGenerations.values()];
        const work = list.map(t => {
            if (t.kind !== 'create_project' || t.progress?.etaMs != null) return t;
            const run = runs.find(g => (g.projectId != null && g.projectId === t.projectId) || g.name === t.label);
            const eta = Number(run?.status?.etaMs ?? run?.etaMs);
            return Number.isFinite(eta) && eta > 0 ? { ...t, progress: { ...t.progress, etaMs: eta } } : t;
        });
        const accounted = new Set(list.filter(t => t.kind === 'create_project').map(t => t.projectId));
        for (const p of db.prepare('SELECT id, name FROM projects WHERE ai_generating = 1').all()) {
            if (accounted.has(p.id)) continue;
            work.push({ kind: 'create_project', status: 'running', projectId: p.id, projectName: p.name, progress: {} });
        }
        return work;
    } catch (e) {
        console.error('[chat] could not read the running work:', e.message);
        return [];
    }
}

// The assistant's sampling temperature. Low because it teaches as well as plans:
// it emits fenced visual specs (p5/vega-lite/mermaid) inline, and a model's spec
// accuracy degrades sharply with temperature. 0.35 keeps the prose warm while
// making the machine-readable blocks far more reliable.
const CHAT_TEMPERATURE = 0.35;

// One assistant turn as a background task: reads the conversation's history,
// saves the user turn up-front (so a reload mid-generation already shows the
// question), streams the model, then persists the assistant turn WITH its
// reasoning trace. On cancel it persists whatever partial answer/reasoning
// exists and resolves { cancelled: true } so the queue moves on.
//
// `page` is where the learner is standing (server/pageContext.js): its text
// goes into the prompt and its ids scope the first vault search. With a topic
// open, that text carries the topic's whole context — which is all the old
// per-topic tutor had that this did not.
async function runChatTurn({ conversationId, message, page = {}, emit: emitFrame, signal, timeZone = undefined }) {
    // Said first, before anything can be slow: a turn that started a new
    // conversation has to tell the device that asked which one it is in.
    emitFrame({ conversationId });
    // A reply that opens with a copy of a history send-stamp never shows it
    // while it streams (server/chatContext.js); the stored text is cleaned in
    // saveAssistant.
    const emit = createStampFilter(emitFrame);
    // "Now" is this turn's, read when it starts running — a turn that waited in
    // the queue answers for the moment it runs, not the moment it was asked.
    const nowMs = Date.now();
    const zone = resolveTimeZone(timeZone);
    // Native multi-turn tool calling is attempted on the OpenAI-compatible
    // provider only (the Ollama native surface differs and keeps the text
    // protocol), for any turn that has tools at all, and never for an endpoint
    // that already refused.
    const aiSettings = getAISettings();
    const nativeKey = `${aiSettings.provider}|${aiSettings.baseUrl || ''}|${aiSettings.model || ''}`;
    const tryNativeTools = aiSettings.provider === 'openai' && !nativeToolsRefused.has(nativeKey);
    // The documents retrieved for this turn, so the answer's `[[src:N]]`
    // markers can be resolved into their real titles before it is stored.
    let ragSources = [];
    // And what the model chose to look up to get them — the web half of which
    // is written into the answer itself.
    let toolCalls = [];
    // The lookup machinery the continuation needs if the answer ends by asking
    // for one: the tools this turn was given, the array its numbered sources
    // live in, and the non-citable context lines.
    let ragTools = [], ragItems = [], ragLooked = [];
    const contextPayload = buildTodayBriefingContext({ decayDays: getGateConfig().decayDays });
    // This conversation's tail, read before buildSourceContext so the decision
    // pass sees the exchange a short follow-up belongs to — and before
    // inserting the new user row, which the prompt already carries. Ten
    // messages: a long conversation costs no more per turn than a short one.
    const history = stampHistory(db.prepare(`
        SELECT role, content, created_at FROM chat_messages
        WHERE conversation_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 10
    `).all(conversationId).reverse(), zone);
    let ragContext = '';
    ({ text: ragContext, sources: ragSources, calls: toolCalls = [], tools: ragTools, items: ragItems, context: ragLooked } = await buildSourceContext(
        page.nodeId ?? null, page.projectId ?? null, message, {
            pageContext: page.text || '', history, emit, signal, native: tryNativeTools,
        }));
    let { system, user } = AI_PROMPTS.assistant(contextPayload, message, page.text || '', ragContext, getUiLanguage(), {
        web: hasWebTool(ragTools),
        documents: hasDocumentTools(ragTools),
        settingsBlock: assistantSettingsBlock({ now: readSettable(getSetting), recent: recentSettingChanges() }),
    });
    // The volatile tail — the clock and what is running right now — goes after
    // everything a provider can cache, and is rebuilt for every turn. The turn
    // being answered is itself a running task, so it is left out of the list.
    system = `${system}\n\n${chatNowBlock({
        nowMs, timeZone: zone,
        work: collectRunningWork(t => t.kind === 'today_chat'),
        withHistoryStamps: history.length > 0,
    })}`;

    const touch = () => db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), conversationId);
    const userInfo = db.prepare('INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)')
        .run(conversationId, 'user', message);
    const userMessageId = Number(userInfo.lastInsertRowid);
    touch();
    emit({ userMessageId });

    let fullResponse = '';
    let thinkingChars = 0;
    let thinkingText = '';
    // Reasoning is persisted with the message so the panel survives reloads,
    // but bounded — a runaway reasoning loop must not bloat the DB.
    const REASONING_SAVE_CAP = 120000;

    // The assistant row's DB id is returned in the terminal event so the
    // client can map its provisional message id to the persisted row (visual
    // repair write-back).
    //
    // A turn that produced NOTHING — not an answer, not a line of reasoning —
    // did not happen, and its question is taken back out with it. The question
    // is written up-front on purpose, so that a reload mid-generation already
    // shows what was asked; the cost of that is an orphan row whenever the turn
    // then fails, and the client's own rule for the same case has always been
    // to drop the optimistic bubble, because an unanswered question left on
    // screen looks asked. It read as a duplicate rather than as an orphan: a
    // failure hands the text back for a retry, each retry writes another
    // question row, and the DEVICE THAT RETRIED never saw them (it renders its
    // own optimistic list) while a second device reading the same conversation
    // out of the database opened on three identical bubbles and no answer.
    //
    // Citations are resolved HERE, at the moment the answer becomes a stored
    // message: `[[src:2]]` out, the document it named in. The streamed text
    // still carries the raw markers (they are written token by token, long
    // before the turn knows it is finished), so the terminal event hands the
    // client this resolved text to replace what it rendered — and the client
    // strips any marker on its own while streaming, so none is ever read.
    let finalContent = '';
    // The lookup rows as stored, their positions moved into the stored text.
    // Handed back on the terminal frame WITH the stored content: a client that
    // swaps in the resolved answer must swap in positions measured in it too,
    // or it cuts the text a few characters off where the rows belong.
    let finalActions = null;
    const saveAssistant = () => {
        if (!fullResponse.trim() && !thinkingText.trim()) {
            db.prepare('DELETE FROM chat_messages WHERE id = ?').run(userMessageId);
            return null;
        }
        finalContent = stripSendStamp(resolveCitations(fullResponse, ragSources).text);
        const keptReasoning = thinkingText ? thinkingText.slice(0, REASONING_SAVE_CAP) : null;
        finalActions = toolCalls.length
            ? storedActions(toolCalls, { raw: fullResponse, stored: finalContent, reasoning: keptReasoning || '' })
            : null;
        // What the turn DID, stored beside what it said. Same argument the
        // reasoning column already made: a record that only exists while the
        // answer streams is a record the learner cannot go back to, and this
        // one is the app's disclosure of what left the machine.
        // And what its setting markers are about to replace — read NOW, before
        // the client applies them at settle, so the next turn can put them back.
        const before = settingsBefore(finalContent, getSetting);
        const info = db.prepare('INSERT INTO chat_messages (conversation_id, role, content, reasoning, actions, generated_by, settings_before) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(conversationId, 'assistant', finalContent,
                keptReasoning,
                finalActions ? JSON.stringify(finalActions) : null,
                aiProvenance(),
                before ? JSON.stringify(before) : null);
        touch();
        return Number(info.lastInsertRowid);
    };

    // One pass over a model stream, through the lookup-tail guard: a reply
    // that ends by asking for a lookup never flashes the request lines on the
    // screen (server/aiTools.js createTailGuard). fullResponse keeps everything
    // fed; the guard only decides what the learner watched arrive. Shared by
    // the answer and its continuation — each pass gets a fresh guard.
    const streamPass = async (userPrompt, hist, think) => {
        const guard = createTailGuard({ tools: ragTools, onChunk: t => emit({ chunk: t }) });
        for await (const part of streamResponse(userPrompt, system, hist, { temperature: CHAT_TEMPERATURE, think, signal })) {
            let chunkText = '';
            if (typeof part === 'string') {
                chunkText = part;
            } else if (part && typeof part === 'object') {
                if (part.type === 'content' && part.content) {
                    chunkText = part.content;
                } else if (part.type === 'thinking' && part.content) {
                    // Stream a running reasoning-character count AND the raw delta
                    // text, so the UI can show both a live "Thinking (N chars)…"
                    // progress indicator and the actual reasoning content in a
                    // collapsible panel (not just its length).
                    thinkingChars += part.content.length;
                    thinkingText += part.content;
                    emit({ thinking: thinkingChars, thinkingChunk: part.content });
                }
            }
            if (chunkText) {
                fullResponse += chunkText;
                guard.feed(chunkText);
            }
        }
        const ended = guard.end();
        return { tailLength: ended.tailCalls.length ? ended.tailLength : 0 };
    };

    // One pass over the model's stream. `think` is a parameter because the
    // pass may run twice: a model that loops in its reasoning (see
    // reasoningLoopDetected in ai.js) is stopped and asked once more WITHOUT
    // extended reasoning — the loop lives in the thinking channel, and a
    // direct answer is what the learner wanted anyway.
    const attempt = async (think) => {
        // think:true lets a reasoning-capable model (qwen3, deepseek-r1, …) process
        // the injected context and teaching scaffold BEFORE answering, instead of
        // emitting the final reply from token one. streamResponse gates this on the
        // model's advertised capability, so it's a no-op on non-thinking models.
        await streamPass(user, history, think);
    };

    try {
        // Native mode first: the model decides by itself whether to look
        // things up, round by round, over the wire's own `tool_calls` — no
        // pre-answer decision pass (the loop answers that question itself for
        // free), no tail parsing (calls arrive structured, never as prose).
        // The text protocol below stays: for the Ollama provider, for an
        // endpoint that refused, and for any turn without tools.
        let nativeHandled = false;
        if (tryNativeTools && ragTools.length) {
            let nativePartial = '';
            let nativeThinking = '';
            let nativeSawOutput = false;
            const emitNative = frame => {
                if (frame?.chunk) { nativePartial += frame.chunk; nativeSawOutput = true; }
                if (frame?.thinkingChunk) { nativeThinking += frame.thinkingChunk; nativeSawOutput = true; }
                emit(frame);
            };
            try {
                const res = await runNativeAgentTurn({
                    system, history, message,
                    tools: ragTools, items: ragItems, context: ragLooked, calls: toolCalls,
                    startRound: (msgs, withTools) => streamResponse(msgs, '', [], {
                        temperature: CHAT_TEMPERATURE,
                        think: true,
                        signal,
                        tools: withTools ? wireTools(ragTools) : undefined,
                    }),
                    emit: emitNative,
                    signal,
                });
                fullResponse = res.fullText;
                thinkingText = res.thinkingText;
                thinkingChars = res.thinkingChars;
                toolCalls = res.calls;
                // The loop's results joined ragItems mid-answer; re-derive the
                // numbered list so the markers the answer wrote resolve against
                // the numbers it was shown.
                ragSources = formatSourceContext(ragItems).sources;
                nativeHandled = true;
            } catch (e) {
                if (isToolRefusalError(e) && !nativeSawOutput) {
                    // The endpoint cannot do native tools. Remember it for the
                    // process lifetime and answer this turn the proven way.
                    nativeToolsRefused.add(nativeKey);
                    console.log('[tools] endpoint refused native tools; falling back to the text protocol');
                } else {
                    // A turn that streamed and then died keeps its partial,
                    // exactly as the text path's envelope would.
                    fullResponse = nativePartial;
                    thinkingText = nativeThinking;
                    throw e;
                }
            }
        }
        if (!nativeHandled) try {
            await attempt(true);
        } catch (error) {
            // Retry only when nothing of the ANSWER has been shown — a second
            // pass would otherwise splice two replies together. The note goes
            // into the reasoning panel, where the loop it explains is.
            if (!isReasoningLoop(error) || fullResponse.trim() || signal.aborted) throw error;
            const note = `\n\n[The model was repeating itself and was stopped after ${thinkingChars.toLocaleString('en-US')} characters. Answering again without extended reasoning.]\n\n`;
            thinkingChars += note.length;
            thinkingText += note;
            emit({ thinking: thinkingChars, thinkingChunk: note });
            await attempt(false);
        }
        // The answer may end by asking for a lookup (server/aiTools.js). The
        // request lines were withheld from the screen by the stream guard; they
        // come off the stored text here, the lookups run once against the
        // turn's cap, and the model gets exactly one pass to finish. Native
        // turns never reach this: their calls arrived as structured wire
        // messages and already ran.
        if (!nativeHandled && ragTools.length && fullResponse.trim() && !signal.aborted) {
            const tail = extractToolTail(fullResponse, ragTools);
            if (tail.calls.length) {
                // A request is never part of the answer: off the stored text
                // before anything runs.
                fullResponse = tail.head;
                const continued = await runLateLookups({
                    tail, tools: ragTools, calls: toolCalls, items: ragItems, context: ragLooked,
                    message, system, history, emit, signal,
                    // The answer had begun: the rows stand after what it wrote.
                    at: { reasoning: thinkingText.length, content: fullResponse.length },
                    answer: async (contUser, contHistory) => {
                        // The continuation streams through its own guard: a
                        // second request at its end is dropped, never shown and
                        // never stored (one continuation per turn). Thinking
                        // parts are ignored — this pass is bounded by design.
                        const guard = createTailGuard({ tools: ragTools, onChunk: t => emit({ chunk: t }) });
                        let text = '';
                        // Its first words open a new paragraph: a second message
                        // glued onto the first read as one line ("…for
                        // files:You're right — here are…"), live and stored.
                        let opening = true;
                        for await (const part of streamResponse(contUser, system, contHistory, { temperature: CHAT_TEMPERATURE, think: false, signal })) {
                            let chunkText = '';
                            if (typeof part === 'string') chunkText = part;
                            else if (part && typeof part === 'object' && part.type === 'content' && part.content) chunkText = part.content;
                            if (chunkText && opening) { chunkText = paragraphBreak(tail.head, chunkText); opening = false; }
                            if (chunkText) {
                                text += chunkText;
                                // An abort mid-continuation keeps its partial:
                                // the outer envelope saves it like any other.
                                fullResponse += chunkText;
                                guard.feed(chunkText);
                            }
                        }
                        const ended = guard.end();
                        return ended.tailCalls.length ? text.slice(0, text.length - ended.tailLength) : text;
                    },
                });
                // The numbered list grew: re-derive it so the markers the
                // continuation wrote resolve against the numbers it was shown.
                ragSources = formatSourceContext(ragItems).sources;
                fullResponse = tail.head + continued;
            }
        }
    } catch (error) {
        if (signal.aborted) {
            // Explicit Stop/cancel: keep the partial answer + reasoning in the
            // conversation so it can be continued (server-side context intact).
            const assistantMessageId = saveAssistant();
            return { cancelled: true, assistantMessageId, partial: !!fullResponse.trim(), content: finalContent || null, actions: finalActions };
        }
        // Same on an outright failure: whatever arrived before it broke is kept,
        // and a turn that arrived at nothing takes its question with it.
        saveAssistant();
        throw error;
    }
    if (signal.aborted) {
        const assistantMessageId = saveAssistant();
        return { cancelled: true, assistantMessageId, partial: !!fullResponse.trim(), content: finalContent || null, actions: finalActions };
    }
    const assistantMessageId = saveAssistant();
    // `actions` beside `content`: both are the STORED turn, measured in the
    // same text (see finalActions).
    return { assistantMessageId, content: finalContent || null, actions: finalActions };
}

export { buildSourceContext, collectRunningWork, runChatTurn, runLateLookups, withActions };
