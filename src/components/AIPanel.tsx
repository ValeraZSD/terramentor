import { useState, useEffect, useMemo, useRef } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { ChatMessage, AiAction, AIStatus, AITaskSummary, TreeNode } from '../types';
import Markdown from './Markdown';
import AIUnavailableNotice from './AIUnavailableNotice';
import { isAIUsable } from '../utils/aiStatus';
import AiModelBadge from './AiModelBadge';
import AiDisclosure from './AiDisclosure';
import { splitTutorActions, TutorAction } from '../utils/tutorActions';
import { stripCitationMarkers } from '../utils/citations';
import { readableAnswer } from '../utils/answerText';
import { flattenTree } from '../utils/tree';
import { useIsMobile } from '../hooks/useMediaQuery';
import { useStickToBottom } from '../hooks/useStickToBottom';
import { useAutoGrow } from '../hooks/useAutoGrow';
import { Bot, Send, Square, Trash2, RefreshCw, Loader2, Check, FileText, Globe, Trophy, ArrowRight } from 'lucide-react';
import CopyButton from './CopyButton';
import ChatTurnError from './ChatTurnError';
import ReasoningPanel from './ReasoningPanel';
import AiActions from './AiActions';
import { useTranslation } from 'react-i18next';

interface AIPanelProps {
    /**
     * False while the panel is mounted but hidden behind another detail tab.
     * The panel stays mounted so the conversation (and the reader's place in
     * it) survives a tab switch; this tells it when to save and restore that
     * place, since `display: none` destroys the scroll box and zeroes scrollTop.
     */
    active?: boolean;
}

export default function AIPanel({ active = true }: AIPanelProps) {
    const { t: tr } = useTranslation();
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const nodes = useStore(s => s.nodes);
    const tree = useStore(s => s.tree);
    const addToast = useStore(s => s.addToast);
    const openMasteryGate = useStore(s => s.openMasteryGate);
    const selectNode = useStore(s => s.selectNode);
    const isMobile = useIsMobile();

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    // The last turn that failed to send, shown inline in the transcript with a
    // retry (see ChatTurnError).
    const [turnError, setTurnError] = useState<{ message: string; text: string } | null>(null);
    const [loading, setLoading] = useState(false);
    const [streaming, setStreaming] = useState(false);
    const [streamingContent, setStreamingContent] = useState('');
    // Id pre-assigned to the in-flight assistant turn so the streaming bubble and
    // the final message share one React key/slot — the message settles in place
    // instead of unmount→remount (which would restart every visual/animation).
    const [streamingMsgId, setStreamingMsgId] = useState<number | null>(null);
    const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
    // Full status kept (not just the boolean) so the header can show the model source + name.
    const [aiStatus, setAiStatus] = useState<AIStatus | null>(null);
    const [useRag, setUseRag] = useState(true);
    // Per-question, and deliberately not remembered: see the switch below. The
    // mode decides where it starts — `ask` opens it off, `auto` opens it on and
    // leaves it there to be dropped for one question.
    const webMode = useStore(s => s.aiWebSearchMode);
    const [useWeb, setUseWeb] = useState(webMode === 'auto');
    useEffect(() => { setUseWeb(webMode === 'auto'); }, [webMode]);
    /** What the turn is doing before the model starts ("Searching the web…"). */
    const [note, setNote] = useState('');
    /**
     * What the streaming turn is looking up, replaced whole on each frame, and
     * mirrored in a ref: the handler that finishes a turn captured this state
     * when the turn STARTED, so reading it there attaches the empty list and
     * every row disappears the instant the answer lands.
     */
    const [lookups, setLookups] = useState<AiAction[]>([]);
    const lookupsRef = useRef<AiAction[]>([]);
    const trackLookups = (next: AiAction[]) => { lookupsRef.current = next; setLookups(next); };
    // Count of documents available to ground answers for the selected node (RAG scope).
    const [docCount, setDocCount] = useState(0);
    // True after the user Stops a generation that produced text — offers "Continue".
    const [stoppedPartial, setStoppedPartial] = useState(false);
    // Accumulated reasoning text per assistant message id — kept after the turn
    // finishes so the learner can re-open a past turn's "Reasoning" panel. The
    // server now persists each turn's reasoning with the message, so history
    // loads repopulate this map and the panels survive reloads.
    const [reasoningByMsg, setReasoningByMsg] = useState<Record<number, string>>({});
    // Explicit open/closed state per message id. Missing = collapsed. Set to
    // true automatically while a message is actively reasoning, then collapsed
    // automatically the moment its content starts arriving — unless the learner
    // already toggled it manually (tracked in userToggledReasoningRef), in which
    // case their choice wins over the auto behaviour.
    const [reasoningOpen, setReasoningOpen] = useState<Record<number, boolean>>({});
    const userToggledReasoningRef = useRef<Set<number>>(new Set());
    // Whether the in-flight turn's content has started arriving yet — flips the
    // reasoning panel from "auto-open while reasoning" to "auto-closed now that
    // there's an answer to read". Reset at the start of every send().
    const contentStartedRef = useRef(false);

    // In-memory drafts keyed by node id, so switching nodes within the same
    // session restores the exact in-progress text instantly (no round trip),
    // while a debounced write (below) persists it to the DB for reloads.
    const draftsRef = useRef<Map<number, string>>(new Map());
    const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // The node the draft-flush effect last ran for, so switching nodes can
    // flush the *outgoing* node's draft rather than the incoming one.
    const prevNodeIdRef = useRef<number | null>(null);

    // Follow-the-stream-unless-the-reader-scrolled-up. Lifted into a hook and
    // shared with the global assistant, which had none of it.
    const scroll = useStickToBottom<HTMLDivElement>(active);
    // Abort handle for the LOCAL stream subscription. Aborting it only
    // detaches this panel — the generation itself is a background task that
    // keeps running server-side (Stop cancels via the task id below).
    const abortRef = useRef<AbortController | null>(null);
    // Background-task id of the in-flight turn (from the stream's first frame).
    const taskIdRef = useRef<string | null>(null);
    // Set when chat history is first loaded for a node, so we teleport (no animation) to the latest message on open.
    const justLoadedRef = useRef(false);
    // Ids of assistant messages generated in *this* session (not loaded from
    // history). Only their visual blocks may auto-repair a failed render; a
    // reopened chat's old visuals wait for a manual "Fix with AI" click.
    const freshMsgIdsRef = useRef<Set<number>>(new Set());
    // Maps a provisional (client-assigned) assistant message id to its persisted
    // DB row id, so an in-session visual repair can be written back to the right
    // row (history messages already carry their real DB id).
    const dbIdRef = useRef<Map<number, number>>(new Map());
    // Latest messages, read outside the render cycle by persistRepair.
    const messagesRef = useRef<ChatMessage[]>([]);
    // Mirrors `active` so the restore effect can tell "was already open" from
    // "just came back on screen".
    const activeRef = useRef(active);
    // Grows from one line up to five as the question wraps — same hook as the
    // assistant composer and the feed's answer box.
    const inputRef = useAutoGrow(input, { rows: 5 });

    const selectedNode = nodes.find(n => n.id === selectedNodeId);

    // The topic that genuinely comes next: the first still-open leaf after this
    // one in curriculum order. Read from the store, never from the model — the
    // tutor only signals that it's time to move on (see utils/tutorActions), so
    // the title on the button is always the real one.
    //
    // Leaf = non-note node with no non-note children, depth-first by position:
    // the exact rule the server's getOrderedLeaves uses, so the topic the tutor
    // was told is next and the topic this button opens can't drift apart.
    // Deliberately NOT getLeafNodes — it treats a node whose only children are
    // notes as a branch, where the server counts it as a leaf. `status` is read
    // directly (not getEffectiveStatus, which derives from child progress and
    // would misreport such a node) — with no real children it IS the own status.
    const nextLeaf = useMemo<TreeNode | null>(() => {
        if (!selectedNodeId) return null;
        const ordered = flattenTree(tree).filter(
            n => !n.is_note && !n.children.some(c => !c.is_note),
        );
        const i = ordered.findIndex(l => l.id === selectedNodeId);
        if (i === -1) return null;
        return ordered
            .slice(i + 1)
            .find(l => l.status !== 'completed' && l.status !== 'skipped') ?? null;
    }, [tree, selectedNodeId]);

    // Hiding the panel with `display: none` destroys its scroll box, so the
    // browser zeroes scrollTop and the learner lands back at the top of the
    // conversation on return. Restore where they were — or the bottom, if they
    // were following a live stream when they left.
    useEffect(() => {
        const wasActive = activeRef.current;
        activeRef.current = active;
        if (wasActive || !active) return;
        scroll.restore();
    }, [active, scroll]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    // A visual block inside an assistant reply was repaired (auto or via "Fix
    // with AI"). Splice the fixed spec into the message and persist it, so a
    // reopened chat renders the corrected spec instead of the broken original.
    const persistRepair = (messageId: number, originalCode: string, repairedCode: string) => {
        const msg = messagesRef.current.find(m => m.id === messageId);
        if (!msg || !msg.content.includes(originalCode)) return;
        const newContent = msg.content.split(originalCode).join(repairedCode);
        setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, content: newContent } : m)));
        const dbId = dbIdRef.current.get(messageId) ?? messageId;
        // A history message already carries its real id; a synthetic one that
        // never got mapped (a turn the server did not save) has a NEGATIVE id
        // and no row to write to, and the in-session render is fixed either way.
        if (dbId > 0) api.updateChatMessage(dbId, newContent).catch(() => { });
    };

    useEffect(() => {
        checkAIStatus();
    }, []);

    useEffect(() => {
        // Flush the outgoing node's pending draft immediately (bypassing the
        // debounce) before switching, so a quick node-hop never loses text.
        const prevId = prevNodeIdRef.current;
        if (draftSaveTimerRef.current) {
            clearTimeout(draftSaveTimerRef.current);
            draftSaveTimerRef.current = null;
            if (prevId != null) {
                const pendingDraft = draftsRef.current.get(prevId);
                if (pendingDraft !== undefined) api.updateNode(prevId, { chat_draft: pendingDraft }).catch(() => { });
            }
        }
        prevNodeIdRef.current = selectedNodeId;

        // Leaving a node mid-stream only DETACHES this panel from the turn —
        // the generation is a background task and keeps running (visible in
        // the task dock); coming back reattaches via resumeActiveTask below.
        abortRef.current?.abort();

        setStoppedPartial(false);
        if (selectedNodeId) {
            loadChatHistory().then(() => resumeActiveTask(selectedNodeId));
            // Count docs the tutor can actually ground on: this node's docs OR the
            // whole project's vault (project-vault files carry node_id=NULL), which
            // matches the server's RAG scope so "Use docs (N)" reflects reality.
            const projectId = nodes.find(n => n.id === selectedNodeId)?.project_id;
            api.getDocuments(selectedNodeId, projectId)
                .then(docs => setDocCount(docs.length))
                .catch(() => setDocCount(0));
            // Restore the in-progress question: the in-memory cache wins (it's
            // more current within this session), falling back to the DB value.
            const cached = draftsRef.current.get(selectedNodeId);
            const node = nodes.find(n => n.id === selectedNodeId);
            setInput(cached ?? node?.chat_draft ?? '');
        } else {
            freshMsgIdsRef.current = new Set();
            dbIdRef.current = new Map();
            setMessages([]);
            setDocCount(0);
            setInput('');
        }
        userToggledReasoningRef.current = new Set();
        setReasoningByMsg({});
        setReasoningOpen({});
    }, [selectedNodeId]);

    useEffect(() => {
        // On open, teleport straight to the latest message (no animation).
        if (justLoadedRef.current) {
            justLoadedRef.current = false;
            requestAnimationFrame(() => scroll.stick());
            return;
        }
        // Otherwise only snap to the bottom right after the user sends — keep a "free
        // camera" while the AI streams, so the reader can stay where they are reading.
        if (messages[messages.length - 1]?.role === 'user') scroll.stick(true);
    }, [messages, scroll]);

    useEffect(() => {
        // While streaming, follow the output to the bottom — but only as long as
        // the reader hasn't scrolled up (the hook unsticks the moment they do).
        if (streaming) scroll.follow();
    }, [streamingContent, streaming, scroll]);

    const checkAIStatus = async () => {
        try {
            const status = await api.getAIStatus();
            setAiStatus(status);
            setAiAvailable(isAIUsable(status));
        } catch {
            setAiStatus(null);
            setAiAvailable(false);
        }
    };

    const loadChatHistory = async () => {
        if (!selectedNodeId) return;
        try {
            const history = await api.getChatHistory(selectedNodeId);
            justLoadedRef.current = true;
            // History messages are not "fresh" — they must not auto-repair. Their
            // ids are already the real DB row ids, so the id map starts empty.
            freshMsgIdsRef.current = new Set();
            dbIdRef.current = new Map();
            setMessages(history);
            // Rebuild the reasoning map from the persisted traces so past
            // turns' "Reasoning" panels survive reloads (collapsed by default).
            const traces: Record<number, string> = {};
            for (const m of history) {
                if (m.role === 'assistant' && m.reasoning) traces[m.id] = m.reasoning;
            }
            setReasoningByMsg(traces);
        } catch (error) {
            console.error('Failed to load chat history:', error);
        }
    };

    // Reattach to a tutor turn still generating for this node (after a page
    // reload, or a hop to another node and back). The server replays the
    // question, reasoning and answer accumulated so far, then follows live.
    const resumeActiveTask = async (nodeId: number) => {
        try {
            const all = await api.getTasks();
            const active = all.find(t =>
                t.kind === 'chat' && t.nodeId === nodeId &&
                (t.status === 'running' || t.status === 'queued'));
            // Bail if the user already hopped to another node meanwhile.
            if (!active || prevNodeIdRef.current !== nodeId) return;
            await attachToChatTask(active, nodeId);
        } catch { /* task feed unavailable — plain history view is fine */ }
    };

    // Shared tail of send() for a reattached turn: consume the task's event
    // stream into the same streaming UI, then settle from the DB (the server
    // persists the turn — including its reasoning — whether or not this panel
    // was watching when it finished).
    const attachToChatTask = async (task: AITaskSummary, nodeId: number) => {
        const assistantId = Date.now() + 1;
        freshMsgIdsRef.current.add(assistantId);
        contentStartedRef.current = false;
        taskIdRef.current = task.id;

        // A queued turn hasn't inserted its user row yet — splice the question
        // in from task metadata so the conversation reads correctly.
        const question = task.meta?.message;
        if (question) {
            setMessages(prev => {
                const lastUser = [...prev].reverse().find(m => m.role === 'user');
                if (lastUser?.content === question) return prev;
                return [...prev, {
                    id: Date.now(), node_id: nodeId, role: 'user' as const,
                    content: question, created_at: new Date().toISOString(),
                }];
            });
        }

        const controller = new AbortController();
        abortRef.current = controller;
        setLoading(true);
        setStreaming(true);
        setStreamingContent('');
        setStreamingMsgId(assistantId);

        let fullResponse = '';
        let terminal: { cancelled: boolean } | null = null;
        try {
            for await (const evt of api.attachTask(task.id, controller.signal)) {
                if (typeof evt.thinkingChunk === 'string' && evt.thinkingChunk) {
                    setReasoningByMsg(prev => ({ ...prev, [assistantId]: (prev[assistantId] || '') + evt.thinkingChunk }));
                    if (!userToggledReasoningRef.current.has(assistantId)) {
                        setReasoningOpen(prev => (prev[assistantId] ? prev : { ...prev, [assistantId]: true }));
                    }
                }
                if (typeof evt.chunk === 'string' && evt.chunk) {
                    if (!contentStartedRef.current) {
                        contentStartedRef.current = true;
                        if (!userToggledReasoningRef.current.has(assistantId)) {
                            setReasoningOpen(prev => ({ ...prev, [assistantId]: false }));
                        }
                    }
                    fullResponse += evt.chunk;
                    setStreamingContent(fullResponse);
                }
                if (evt.error) throw new Error(evt.error);
                if (evt.done || evt.cancelled) {
                    terminal = { cancelled: !!evt.cancelled };
                    break;
                }
            }
            if (!controller.signal.aborted && terminal) {
                // Settle from the DB: canonical row ids + persisted reasoning.
                await loadChatHistory();
                if (terminal.cancelled && fullResponse.trim()) setStoppedPartial(true);
            }
        } catch (error: any) {
            if (!controller.signal.aborted) addToast('error', tr("AI Error"), error.message);
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            taskIdRef.current = null;
            setLoading(false);
            setStreaming(false);
            setStreamingMsgId(null);
            setStreamingContent('');
        }
    };

    // Persist an in-progress draft for a node: cache it in-memory (instant
    // restore on same-session node hops) and debounce a DB write (survives
    // reload). Called from the input's onChange — never from a programmatic
    // setInput — so a node switch can't cross-contaminate another node's draft.
    const saveDraft = (nodeId: number, value: string) => {
        draftsRef.current.set(nodeId, value);
        if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = setTimeout(() => {
            api.updateNode(nodeId, { chat_draft: value }).catch(() => { });
        }, 600);
    };

    const handleInputChange = (value: string) => {
        setInput(value);
        if (selectedNodeId) saveDraft(selectedNodeId, value);
    };

    // Write the current node's pending draft to the DB immediately, bypassing
    // the debounce. Called on unmount (node switch / tab change / panel close)
    // and — with keepalive — on page reload / tab close, so text typed in the
    // last debounce window is never lost. No-op when nothing is pending.
    const flushDraft = (keepalive = false) => {
        if (!draftSaveTimerRef.current) return; // nothing awaiting a write
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
        const nodeId = prevNodeIdRef.current;
        if (nodeId == null) return;
        const draft = draftsRef.current.get(nodeId);
        if (draft === undefined) return;
        api.saveChatDraft(nodeId, draft, keepalive).catch(() => { });
    };

    // A page reload / tab close (pagehide) or an app switch (visibilitychange →
    // hidden) can fire before the debounced write lands — flush with keepalive
    // so the browser completes the write as the document unloads. On unmount
    // (this panel remounts per node via key, and hides when another detail tab
    // is active) flush synchronously; the page stays alive so keepalive isn't
    // needed. Registered once — flushDraft reads the latest state via refs.
    useEffect(() => {
        const onPageHide = () => flushDraft(true);
        const onVisibility = () => { if (document.visibilityState === 'hidden') flushDraft(true); };
        window.addEventListener('pagehide', onPageHide);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.removeEventListener('pagehide', onPageHide);
            document.removeEventListener('visibilitychange', onVisibility);
            flushDraft();
        };
    }, []);

    // On unmount (leaving the workspace, closing the detail panel, node-key
    // remount), DETACH from any in-flight turn — the generation is a background
    // task that keeps running and reattaches on return. Without this the SSE
    // connection lingers for the whole task, and a handful of them exhaust the
    // browser's per-origin connection pool (the app then stalls / "disconnects").
    useEffect(() => {
        return () => { abortRef.current?.abort(); };
    }, []);

    const send = async (rawText: string) => {
        const userMessage = rawText.trim();
        if (!userMessage || !selectedNodeId || loading || streaming) return;

        // Don't clobber text the user has typed for their next question.
        const restoreInput = () => setInput(cur => {
            const next = cur.trim() ? cur : userMessage;
            saveDraft(selectedNodeId, next);
            return next;
        });

        setInput('');
        // The message is now in flight — drop its saved draft (cache + DB), so
        // it doesn't reappear on the next visit. restoreInput re-saves on error.
        draftsRef.current.set(selectedNodeId, '');
        if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
        api.updateNode(selectedNodeId, { chat_draft: '' }).catch(() => { });
        setStoppedPartial(false);
        setTurnError(null);
        setLoading(true);

        const tempUserMessage: ChatMessage = {
            id: Date.now(),
            node_id: selectedNodeId,
            role: 'user',
            content: userMessage,
            created_at: new Date().toISOString()
        };
        setMessages(prev => [...prev, tempUserMessage]);

        const controller = new AbortController();
        abortRef.current = controller;
        taskIdRef.current = null;
        let fullResponse = '';

        // Reserve the assistant turn's id up front and mark it fresh, so the
        // streaming bubble renders under the same key/slot as the final message
        // and its visuals settle in place rather than remounting at stream end.
        const assistantId = Date.now() + 1;
        freshMsgIdsRef.current.add(assistantId);
        contentStartedRef.current = false;

        try {
            setStreaming(true);
            setStreamingContent('');
            setStreamingMsgId(assistantId);

            // Terminal frame metadata: on Stop the server cancels the task,
            // saves the partial turn (with reasoning) and reports cancelled.
            // (Holder object rather than a let — TS can't track assignments
            // made inside the onDone closure.)
            const doneMeta: { current: { assistantMessageId: number | null; cancelled?: boolean; content?: string | null } | null } = { current: null };

            setNote('');
            for await (const chunk of api.streamChat(selectedNodeId, userMessage, useRag, controller.signal, meta => {
                doneMeta.current = meta;
                // Remember the persisted row id so an in-session visual repair on
                // this turn can be written back to the DB (see persistRepair).
                if (meta.assistantMessageId != null) dbIdRef.current.set(assistantId, meta.assistantMessageId);
            }, undefined, deltaText => {
                // Accumulate the raw reasoning text and keep the panel open by
                // default while the model is still reasoning — unless the
                // learner already collapsed it manually.
                setReasoningByMsg(prev => ({ ...prev, [assistantId]: (prev[assistantId] || '') + deltaText }));
                if (!userToggledReasoningRef.current.has(assistantId)) {
                    setReasoningOpen(prev => (prev[assistantId] ? prev : { ...prev, [assistantId]: true }));
                }
            }, taskId => {
                // First frame carries the background-task id — Stop cancels
                // through it, and it marks this turn as resumable elsewhere.
                taskIdRef.current = taskId;
            }, { useWeb, onNote: setNote, onActions: trackLookups })) {
                setNote('');
                if (!contentStartedRef.current) {
                    // The model has stopped reasoning and started answering — auto-close
                    // the panel now that there's an answer to read, unless the learner
                    // already chose to keep it open.
                    contentStartedRef.current = true;
                    if (!userToggledReasoningRef.current.has(assistantId)) {
                        setReasoningOpen(prev => ({ ...prev, [assistantId]: false }));
                    }
                }
                fullResponse += chunk;
                // Grounding markers are resolved server-side when the turn is
                // stored; mid-stream they are stripped so none is ever read.
                setStreamingContent(stripCitationMarkers(fullResponse));
            }

            const stopped = controller.signal.aborted || !!doneMeta.current?.cancelled;
            // Prefer the stored answer — the same text with its `[[src:N]]`
            // markers turned into the documents they cited — so the message on
            // screen matches what a reload shows. Falls back to the streamed
            // text whenever the server sent none (an older server, a turn that
            // saved nothing).
            const settled = doneMeta.current?.content?.trim()
                ? doneMeta.current.content
                : stripCitationMarkers(fullResponse);
            if (fullResponse.trim()) {
                const assistantMessage: ChatMessage = {
                    id: assistantId,
                    node_id: selectedNodeId,
                    role: 'assistant',
                    content: settled,
                    // What it looked up rides with it, so the rows stay where
                    // they were instead of vanishing when the answer arrives.
                    actions: lookupsRef.current.length ? lookupsRef.current : null,
                    created_at: new Date().toISOString()
                };
                setMessages(prev => [...prev, assistantMessage]);
                // Both a natural finish and a Stop are persisted server-side
                // (the task saves the partial + reasoning on cancel), so the
                // stopped turn stays in context and can be continued.
                if (stopped) setStoppedPartial(true);
            } else if (stopped) {
                // Stopped before any output — drop the empty turn.
                setMessages(prev => prev.filter(m => m.id !== tempUserMessage.id));
                restoreInput();
            }
            setStreamingContent('');
            trackLookups([]);
        } catch (error: any) {
            // The socket died under a turn the server had already accepted
            // (the phone went to the background, the stream went quiet) — the
            // answer is still being written there. Re-follow it rather than
            // reporting the question as unsent: the task replays what it has
            // and streams the rest, or, if it finished meanwhile, the history
            // reload shows the persisted turn.
            const droppedTask = taskIdRef.current;
            if (droppedTask && !controller.signal.aborted) {
                setStreamingContent('');
                setStreaming(false);
                setStreamingMsgId(null);
                await loadChatHistory();
                await resumeActiveTask(selectedNodeId);
                return;
            }
            // Inline, not a toast. The draft was already being restored here —
            // what was missing is anywhere for the learner to READ what went
            // wrong and a way to send it again: a toast expires, and the one
            // thing wanted after a failed send is to retry it.
            setTurnError({ message: error.message || 'the request failed.', text: userMessage });
            setMessages(prev => prev.filter(m => m.id !== tempUserMessage.id));
            restoreInput();
        } finally {
            abortRef.current = null;
            taskIdRef.current = null;
            setLoading(false);
            setStreaming(false);
            setStreamingMsgId(null);
            setNote('');
        }
    };

    const handleSend = () => send(input);
    const handleContinue = () => send('Please continue your previous answer from exactly where you stopped.');

    const handleStop = () => {
        const taskId = taskIdRef.current;
        if (taskId) {
            // Cancel the background task: the server saves the partial turn
            // (with reasoning) and ends the stream with a `cancelled` frame.
            // Falling back to a local abort only if the cancel call fails.
            api.cancelTask(taskId).catch(() => abortRef.current?.abort());
        } else {
            abortRef.current?.abort();
        }
    };

    const handleClear = async () => {
        if (!selectedNodeId) return;
        try {
            await api.clearChatHistory(selectedNodeId);
            freshMsgIdsRef.current = new Set();
            dbIdRef.current = new Map();
            setMessages([]);
            setStoppedPartial(false);
            userToggledReasoningRef.current = new Set();
            setReasoningByMsg({});
            setReasoningOpen({});
            addToast('success', tr("Chat cleared"));
        } catch (error: any) {
            addToast('error', tr("Failed to clear chat"), error.message);
        }
    };

    // Learner clicked the chevron on a "Reasoning" panel — their choice now
    // overrides the auto-open-while-thinking / auto-close-on-answer behaviour
    // for this message.
    const toggleReasoning = (msgId: number) => {
        userToggledReasoningRef.current.add(msgId);
        setReasoningOpen(prev => ({ ...prev, [msgId]: !prev[msgId] }));
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            // While generating, let Enter insert a newline so the user can
            // compose their next question; don't send until the stream ends.
            if (loading || streaming) return;
            e.preventDefault();
            handleSend();
        }
    };

    if (aiAvailable === null) {
        return (
            <div className="flex-1 flex items-center justify-center text-slate-500 dark:text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                {tr("Checking AI status...")}
            </div>
        );
    }

    if (!aiAvailable) {
        return (
            <div className="flex-1 p-4 overflow-auto">
                <AIUnavailableNotice status={aiStatus} onRetry={checkAIStatus} variant="panel" />
            </div>
        );
    }

    return (
        <div className="flex-1 min-h-0 flex flex-col">
            {/* Header — slim: tutor label on the left, controls on the right.
                `select-none` for the same reason as the assistant drawer: chrome
                that can hold a selection endpoint lets a drag out of the message
                list swallow the whole panel. */}
            <div className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700 select-none">
                {/* The badge yields the space, not the switches: in a detail
                    panel ~380px wide the two toggles were wrapping onto two
                    lines each ("Use / docs") while the model name held its
                    width. A model name is information; the switches are the
                    controls. */}
                <div className="min-w-0 overflow-hidden">
                    <AiModelBadge status={aiStatus} fallbackLabel={tr("Tutor")} />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <button
                        type="button"
                        role="switch"
                        aria-checked={useRag}
                        onClick={() => setUseRag(!useRag)}
                        title={tr("Ground answers in your project documents")}
                        className={`group flex shrink-0 items-center gap-1.5 whitespace-nowrap pl-1 pr-2.5 py-1 rounded-full text-xs font-medium border transition-all ${useRag
                            ? 'bg-accent/15 border-accent/40 text-accent-fg'
                            : 'border-slate-300 dark:border-slate-600 text-slate-500 hover:border-accent/40 hover:text-slate-600 dark:hover:text-slate-300'
                            }`}
                    >
                        <span
                            className={`flex items-center justify-center w-5 h-5 rounded-full transition-all ${useRag
                                ? 'bg-accent text-white scale-100'
                                : 'bg-slate-200 dark:bg-slate-700 text-transparent scale-90 group-hover:scale-100'
                                }`}
                        >
                            {useRag ? <Check className="w-3.5 h-3.5" strokeWidth={3} /> : <FileText className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />}
                        </span>
                        {docCount > 0 ? tr("Use docs ({{docCount}})", { docCount }) : tr("Use docs")}
                    </button>
                    {/* Only shown when web answers are switched on in Settings —
                        a control that looks available and does nothing is worse
                        than no control. It is permission, not an instruction:
                        the tutor decides whether it needs the web and what to
                        type, and this says whether it may. Where it starts
                        follows the mode, and it is never remembered between
                        mounts — this is the one thing in the app that sends the
                        learner's words off the machine. */}
                    {webMode !== 'off' && (
                        <button
                            type="button"
                            role="switch"
                            aria-checked={useWeb}
                            onClick={() => setUseWeb(!useWeb)}
                            title={tr("Let it look things up on the web while it answers, and cite the pages it used")}
                            className={`group flex shrink-0 items-center gap-1.5 whitespace-nowrap pl-1 pr-2.5 py-1 rounded-full text-xs font-medium border transition-all ${useWeb
                                ? 'bg-accent/15 border-accent/40 text-accent-fg'
                                : 'border-slate-300 dark:border-slate-600 text-slate-500 hover:border-accent/40 hover:text-slate-600 dark:hover:text-slate-300'
                                }`}
                        >
                            <span
                                className={`flex items-center justify-center w-5 h-5 rounded-full transition-all ${useWeb
                                    ? 'bg-accent text-white scale-100'
                                    : 'bg-slate-200 dark:bg-slate-700 text-transparent scale-90 group-hover:scale-100'
                                    }`}
                            >
                                {useWeb ? <Check className="w-3.5 h-3.5" strokeWidth={3} /> : <Globe className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />}
                            </span>
                            {tr("Search web")}
                        </button>
                    )}
                    <button
                        onClick={handleClear}
                        className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded text-slate-500 dark:text-slate-400 hover:text-slate-600"
                        title={tr("Clear chat")}
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Messages - This is the scrollable area */}
            <div
                ref={scroll.ref}
                onScroll={scroll.onScroll}
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain p-4 space-y-4 select-text"
            >
                {messages.length === 0 && !streaming && (
                    <div className="text-center py-8 text-slate-400">
                        <Bot className="w-12 h-12 mx-auto mb-3 opacity-50" />
                        <p>{tr("Ask me anything about \"{{title}}\"", { title: selectedNode?.title })}</p>
                        <p className="text-sm mt-1">{tr("I'll guide you through the learning process")}</p>
                    </div>
                )}

                {/* The in-flight assistant turn is spliced into the list under its
                    reserved id, so when the stream ends the same slot/key hosts the
                    final message — React reconciles in place instead of remounting
                    (which would restart every visual/animation). Included as soon as
                    EITHER content or reasoning text exists, so the "Reasoning" panel
                    is visible from the moment the model starts thinking, before its
                    first answer token arrives. */}
                {(streaming && streamingMsgId != null && (streamingContent || reasoningByMsg[streamingMsgId])
                    ? [...messages, {
                        id: streamingMsgId,
                        node_id: selectedNodeId ?? 0,
                        role: 'assistant' as const,
                        content: streamingContent,
                        actions: lookups.length ? lookups : null,
                        created_at: '',
                    }]
                    : messages
                ).map(msg => {
                    const isStreaming = streaming && msg.id === streamingMsgId;
                    const reasoning = reasoningByMsg[msg.id];
                    // Still reasoning if this is the live turn and it hasn't produced
                    // any visible content yet — drives the "…" vs finished label.
                    const isActivelyReasoning = isStreaming && !msg.content;
                    // Pull the tutor's action markers out of the prose. `body` is
                    // what the learner reads; `actions` become real buttons below.
                    const { body, actions } = msg.role === 'assistant'
                        ? splitTutorActions(msg.content, isStreaming)
                        : { body: msg.content, actions: [] as TutorAction[] };
                    return msg.role === 'user' ? (
                        <div key={msg.id} className="flex justify-end">
                            <div className="max-w-[85%] min-w-0 rounded-2xl px-4 py-2.5 bg-accent text-white">
                                <div className="whitespace-pre-wrap text-sm break-words">{msg.content}</div>
                            </div>
                        </div>
                    ) : (
                        <div key={msg.id} className="min-w-0">
                            {/* What this turn looked up, in the order it happened:
                                before the reasoning and before the answer, because
                                that is when it happened. */}
                            <AiActions actions={msg.actions} className="mb-1" />
                            {reasoning && (
                                <ReasoningPanel
                                    text={reasoning}
                                    open={!!reasoningOpen[msg.id]}
                                    live={isActivelyReasoning}
                                    onToggle={() => toggleReasoning(msg.id)}
                                />
                            )}
                            {body && (
                                <div className="overflow-x-auto overflow-y-hidden">
                                    <Markdown content={body} className="text-sm text-slate-800 dark:text-slate-200" streaming={isStreaming} autoRepair={freshMsgIdsRef.current.has(msg.id)} nodeId={selectedNodeId ?? undefined} surface="tutor" messageId={msg.id > 0 ? msg.id : undefined} onRepaired={(orig, fixed) => persistRepair(msg.id, orig, fixed)} />
                                </div>
                            )}

                            {/* The tutor's offer to move on, rendered as real
                                buttons. It asked; the app answers with the truth —
                                which node is next and what it's actually called. */}
                            {!isStreaming && actions.length > 0 && (
                                <div className="mt-3 flex flex-wrap gap-2">
                                    {actions.includes('boss_fight') && selectedNodeId != null && (
                                        <button
                                            onClick={() => openMasteryGate(selectedNodeId, selectedNode?.title ?? '', false)}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                                        >
                                            <Trophy className="w-3.5 h-3.5 flex-shrink-0" />
                                            {tr("Take the Boss Fight")}
                                        </button>
                                    )}
                                    {/* Only offered when a next topic really exists —
                                        on the last open leaf the button simply isn't
                                        there, rather than pointing somewhere invented. */}
                                    {actions.includes('next_topic') && nextLeaf && (
                                        <button
                                            onClick={() => selectNode(nextLeaf.id)}
                                            title={tr("Go to \"{{title}}\"", { title: nextLeaf.title })}
                                            className="flex items-center gap-1.5 max-w-full px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                                        >
                                            <span className="truncate">{tr("Next: {{title}}", { title: nextLeaf.title })}</span>
                                            <ArrowRight className="w-3.5 h-3.5 flex-shrink-0" />
                                        </button>
                                    )}
                                </div>
                            )}

                            {/* Copies what is on the screen, not what is in the
                                row: the raw message still carries the action
                                markers this panel renders as buttons, and they
                                mean nothing in someone else's notes. */}
                            {!isStreaming && readableAnswer(msg.content) && (
                                <CopyButton
                                    text={readableAnswer(msg.content)}
                                    label={tr("Copy answer")}
                                    onFailed={() => addToast('error', tr("Could not copy"), tr("Your browser blocked clipboard access."))}
                                />
                            )}
                        </div>
                    );
                })}

                {/* Generic fallback spinner for the gap before the first reasoning
                    chunk (or, for non-thinking models, the first content chunk)
                    arrives — once reasoning starts, the inline "Reasoning" panel
                    above takes over showing live progress. */}
                {loading && !streamingContent && !(streamingMsgId != null && reasoningByMsg[streamingMsgId]) && (
                    <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {/* A web search runs BEFORE the model and costs seconds;
                            spending them under a generic "Loading…" reads as a
                            hang, so the turn says what it is doing. */}
                        <span className="text-sm">{note || tr("Loading…")}</span>
                    </div>
                )}

                {turnError && (
                    <ChatTurnError
                        message={turnError.message}
                        retryDisabled={loading || streaming}
                        onRetry={() => { const t = turnError.text; setTurnError(null); send(t); }}
                        onDismiss={() => setTurnError(null)}
                    />
                )}

            </div>

            {/* Input. On a phone the detail panel is a full-screen overlay, so the
                floating TaskDock lands right on top of this box and eats taps
                meant for it. Reserve the dock's measured height (--task-dock-h,
                published by TaskDock; 0px when no tasks are running) so the input
                sits clear of it. Desktop keeps the dock well away from the side
                panel, so it pays no dead space. */}
            <div
                className="flex-shrink-0 p-4 border-t border-slate-200 dark:border-slate-700 select-none"
                style={isMobile ? { paddingBottom: 'calc(1.25rem + var(--task-dock-h, 0px))' } : undefined}
            >
                {stoppedPartial && !streaming && !loading && (
                    <button
                        onClick={handleContinue}
                        className="mb-2 flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-accent/10 text-accent-fg hover:bg-accent/20 transition"
                        title={tr("Ask the AI to continue where it stopped")}
                    >
                        <RefreshCw className="w-3.5 h-3.5" />
                        {tr("Continue generating")}
                    </button>
                )}
                <div className="flex gap-2">
                    <textarea
                        ref={inputRef}
                        value={input}
                        onChange={e => handleInputChange(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={streaming || loading ? tr("Type your next question…") : tr("Ask a question...")}
                        rows={1}
                        className="flex-1 min-w-0 px-4 py-2.5 border border-slate-200 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-700 text-slate-900 dark:text-white placeholder-slate-400 resize-none focus:ring-2 focus:ring-accent focus:border-accent select-text"
                    />
                    {streaming || loading ? (
                        <button
                            onClick={handleStop}
                            className="px-4 py-2.5 bg-slate-700 dark:bg-slate-600 text-white rounded-xl hover:bg-slate-800 dark:hover:bg-slate-500 transition"
                            title={tr("Stop generating")}
                        >
                            <Square className="w-5 h-5" fill="currentColor" />
                        </button>
                    ) : (
                        <button
                            onClick={handleSend}
                            disabled={!input.trim()}
                            aria-label={tr("Send message")}
                            className="px-4 py-2.5 bg-accent text-white rounded-xl hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
                        >
                            <Send className="w-5 h-5" />
                        </button>
                    )}
                </div>
                <AiDisclosure className="mt-2" />
            </div>
        </div>
    );
}