import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useStore } from '../store';
import Markdown from './Markdown';
import { splitOpenTargets, splitDestinations, type Destination } from '../utils/tutorActions';
import { splitSettingChanges } from '../utils/assistantSettings';
import { stripCitationMarkers } from '../utils/citations';
import { readableAnswer } from '../utils/answerText';
import SettingChangeChips from './SettingChangeChips';
import AiActions from './AiActions';
import { AIStatus, ChatMessage, AiAction } from '../types';
import AiModelBadge from './AiModelBadge';
import AiDisclosure from './AiDisclosure';
import CopyButton from './CopyButton';
import ChatTurnError from './ChatTurnError';
import ReasoningPanel from './ReasoningPanel';
import { useAutoGrow } from '../hooks/useAutoGrow';
import { useStickToBottom } from '../hooks/useStickToBottom';
import { useTapGuard } from '../hooks/useTapGuard';
import { holdReload } from '../utils/freshness';
import { ArrowUpRight, Check, Globe, Loader2, Send, Square, Trash2, X } from 'lucide-react';
import { BrandMark } from './BrandMark';
import { useTranslation } from 'react-i18next';
import { k } from '../i18n';
import { useNumberFormat } from '../hooks/useNumberFormat';

interface Props {
    open: boolean;
    onClose: () => void;
    /** Opens the capture dialog — the assistant's one "tool" that writes. */
    onCapture: () => void;
    /**
     * True when there is room to sit BESIDE the page instead of over it — the
     * app frame has already reserved `width` px on its right, so this panel must
     * not paint a backdrop or trap focus. On a phone it is false and the panel
     * behaves as a normal modal drawer.
     */
    docked: boolean;
    /** Panel width in px when docked (the learner can drag it). */
    width: number;
    onResize: (width: number) => void;
}

/** A resolved `[[open:…]]` target: the id came from the model, the title didn't. */
interface ResolvedTarget {
    id: number;
    projectId: number;
    title: string;
    projectName: string;
}

/**
 * Docked width, in px. The old panel was a phone-sized 26rem on every screen,
 * which on a desktop left a code block or a rendered chart in an answer wrapping
 * every few words. `DEFAULT_WIDTH` is the starting point; the learner drags the
 * edge from there and the choice is remembered.
 */
export const DEFAULT_WIDTH = 520;
export const MIN_WIDTH = 320;
/** Below this there isn't room for a page AND a panel, so the panel overlays. */
export const DOCK_QUERY = '(min-width: 1024px)';

/**
 * The three openers offered on an empty conversation. `k()` so the extractor
 * sees them from a table — they were plain strings rendered raw, which meant a
 * Russian learner met three English buttons beside a Russian one, and clicking
 * one put an English sentence in their own transcript. Both halves are the
 * translation now: the label AND what gets sent, because what the learner reads
 * on the button is what they are saying.
 */
const QUICK_PROMPTS = [
    k('What should I do today?'),
    k("Explain what I'm looking at"),
    k("I'm behind — what do I drop?"),
];

/**
 * True when typing costs nothing — a real keyboard, not an on-screen one that
 * eats half the viewport the instant a field takes focus.
 */
function typingIsCheap(): boolean {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(pointer: fine)').matches;
}

/** The resolved targets of one assistant message, in the order it named them. */
function messageTargets(content: string, labels: Record<number, ResolvedTarget>): ResolvedTarget[] {
    if (!content.includes('[[')) return [];
    return splitOpenTargets(content).targets
        .map(t => labels[t.nodeId])
        .filter((t): t is ResolvedTarget => Boolean(t));
}

/** Local calendar day of a timestamp, as a stable `YYYY-M-D` key. */
function dayKey(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * The label on a date blob: "Today" / "Yesterday" for the two days a learner
 * thinks of by name, a weekday inside the last week, an explicit date beyond it.
 */
function dayLabel(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((midnight(today) - midnight(d)) / 86_400_000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'long',
        ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    });
}

/**
 * A centred date blob, the way every messaging app marks a new day. This
 * conversation is long-lived and global — without it, an answer from three weeks
 * ago and one from this morning are indistinguishable while scrolling back.
 */
function DateBlob({ iso }: { iso: string }) {
    const label = dayLabel(iso);
    if (!label) return null;
    return (
        <div className="flex justify-center py-1">
            <span className="px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-700/70 text-[11px] font-medium text-slate-500 dark:text-slate-300">
                {label}
            </span>
        </div>
    );
}

function TargetButtons({ targets, onOpen }: { targets: ResolvedTarget[]; onOpen: (t: ResolvedTarget) => void }) {
    if (targets.length === 0) return null;
    return (
        <div className="space-y-1.5">
            {targets.map(t => (
                <button
                    key={t.id}
                    onClick={() => onOpen(t)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2.5 min-h-11 rounded-xl border border-accent/40 bg-accent/5 hover:bg-accent/10 text-left transition"
                >
                    <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{t.title}</span>
                        <span className="block text-sm text-slate-500 dark:text-slate-400 truncate">{t.projectName}</span>
                    </span>
                    <ArrowUpRight className="w-4 h-4 text-accent-fg shrink-0" aria-hidden="true" />
                </button>
            ))}
        </div>
    );
}

/** Where an answer offered to take the learner. Pressed, never automatic. */
function DestinationButtons({ destinations, onGo }: { destinations: Destination[]; onGo: (d: Destination) => void }) {
    const { t: tr } = useTranslation();
    if (destinations.length === 0) return null;
    return (
        <div className="flex flex-wrap gap-1.5">
            {destinations.map(d => (
                <button
                    key={d.key}
                    onClick={() => onGo(d)}
                    className="flex items-center gap-1.5 px-3 py-2 min-h-11 rounded-xl border border-accent/40 bg-accent/5 hover:bg-accent/10 text-sm font-medium text-slate-800 dark:text-slate-100 transition"
                >
                    {tr(d.label)}
                    <ArrowUpRight className="w-4 h-4 text-accent-fg shrink-0" aria-hidden="true" />
                </button>
            ))}
        </div>
    );
}

/**
 * The global assistant: one conversation, reachable from every screen.
 *
 * Distinct from the per-node AI Tutor on purpose. The tutor teaches ONE topic
 * and its context is that topic; this one sees the cross-project snapshot plus
 * where the learner is standing, so it can answer the questions that have no
 * home in a node — "what should I do today", "what is this thing on screen",
 * "I'm two weeks behind, what do I drop". It reuses the Today planning chat
 * endpoints that were built for the old dashboard and left UI-less when the
 * feed replaced it, so the server half of this already existed.
 *
 * Its only structured output is `[[open:projectId:nodeId]]`, rendered as a
 * button. Resolution is the whole safety story: the ids are looked up through
 * POST /api/nodes/labels and the button carries the title the DATABASE returns,
 * so a model that invents an id produces no button rather than a plausible one
 * (see src/utils/tutorActions.ts).
 *
 * Voice — realtime STT/TTS, and a small-model-answers-while-a-big-model-
 * researches tier — is deliberately NOT here. It is its own infrastructure
 * project (local Whisper + TTS + a two-tier router), and on a single-GPU box it
 * would be a second heavy model running alongside the chat model. See ROADMAP.md.
 */
export default function AssistantDrawer({ open, onClose, onCapture, docked, width, onResize }: Props) {
    const { t: tr } = useTranslation();
    const navigate = useNavigate();
    const num = useNumberFormat();
    const view = useStore(s => s.view);
    const currentProjectId = useStore(s => s.currentProjectId);
    const selectedNodeId = useStore(s => s.selectedNodeId);
    // On the feed there is no selected node — the card in view stands in for it.
    const feedFocusItemId = useStore(s => s.feedFocusItemId);
    const openProjectNode = useStore(s => s.openProjectNode);
    const addToast = useStore(s => s.addToast);
    const consumeAssistantPrefill = useStore(s => s.consumeAssistantPrefill);
    // The live background-task list (the TaskDock's own feed).
    const aiTasks = useStore(s => s.aiTasks);

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    // The last turn that failed to send, shown inline above the composer with a
    // retry. Cleared on the next send, on retry, or when dismissed.
    const [turnError, setTurnError] = useState<{ message: string; text: string } | null>(null);
    const [streaming, setStreaming] = useState(false);
    const [streamed, setStreamed] = useState('');
    // Per-question, never remembered: see the switch above the composer. The
    // mode decides where it starts — `ask` opens it off, `auto` opens it on and
    // leaves it there to be dropped for one question.
    const webMode = useStore(s => s.aiWebSearchMode);
    const [useWeb, setUseWeb] = useState(webMode === 'auto');
    useEffect(() => { setUseWeb(webMode === 'auto'); }, [webMode]);
    /** What the turn is doing before the model starts ("Searching the web…"). */
    const [note, setNote] = useState('');
    /**
     * The lookups the streaming turn is running, replaced whole on each frame.
     *
     * Mirrored in a ref because `send` is a useCallback that does not list it:
     * the version of `send` running a turn captured the value `actions` had
     * when the turn STARTED, which is the empty list, so reading the state
     * there attached nothing to the finished message and every row vanished the
     * instant the answer arrived. The ref is the same object the rows were
     * drawn from; the state is only what makes React redraw them.
     */
    const [actions, setActions] = useState<AiAction[]>([]);
    const actionsRef = useRef<AiAction[]>([]);
    const trackActions = useCallback((next: AiAction[]) => {
        actionsRef.current = next;
        setActions(next);
    }, []);
    // The id the in-flight turn is accumulating under. Allocated when the turn
    // starts, so its reasoning has somewhere to live before there is a message,
    // and reused as the final assistant row's key — the panel the learner
    // opened mid-answer is the same panel afterwards, not a new one.
    const [streamingId, setStreamingId] = useState<number | null>(null);
    // Accumulated reasoning text per assistant message id. Filled live from the
    // stream and rebuilt from the persisted traces on every history load, so a
    // past turn's panel survives a reload and reaches a second device.
    const [reasoningByMsg, setReasoningByMsg] = useState<Record<number, string>>({});
    // Explicit open/closed per message. Opens itself while a turn is reasoning
    // and closes itself once there is an answer to read — unless the learner
    // has touched it, in which case their choice stands. Same rule as the node
    // tutor's, deliberately: one behaviour on both chat surfaces.
    const [reasoningOpen, setReasoningOpen] = useState<Record<number, boolean>>({});
    const userToggledReasoningRef = useRef<Set<number>>(new Set());
    const contentStartedRef = useRef(false);
    const [loadingHistory, setLoadingHistory] = useState(false);
    /** nodeId → the row the DATABASE returned for it. Unresolved ids stay absent. */
    const [labels, setLabels] = useState<Record<number, ResolvedTarget>>({});
    /** Which model is answering, and whether it can be reached at all. */
    const [status, setStatus] = useState<AIStatus | null>(null);
    const [statusLoading, setStatusLoading] = useState(false);

    const abortRef = useRef<AbortController | null>(null);
    // Synthetic optimistic id → the row the server actually wrote, so an
    // in-session visual repair can be persisted (see persistRepair).
    const dbIdRef = useRef<Map<number, number>>(new Map());
    // Latest messages, read outside the render cycle by persistRepair.
    const messagesRef = useRef<ChatMessage[]>([]);
    const inputRef = useAutoGrow(input, { rows: 5 });
    // Same "follow the stream unless the reader scrolled up" rule as the node
    // tutor, from the same hook. This panel used to call scrollIntoView on every
    // chunk, which made a long answer impossible to read while it was arriving.
    const scroll = useStickToBottom<HTMLDivElement>(open);
    /** Ids already sent to /api/nodes/labels, so re-renders don't re-ask. */
    const askedRef = useRef<Set<number>>(new Set());
    /**
     * Assistant turns generated in THIS session. Two things key off it and both
     * would be wrong for a message re-read from history: a `[[set:…]]` change is
     * applied once, when the answer arrives, never again on reopen; and an
     * expensive widget build starts on its own only for an answer the learner is
     * waiting on, exactly as the tutor panel decides it.
     */
    const freshIdsRef = useRef<Set<number>>(new Set());
    /** Task ids this panel has already followed (or started itself). */
    const attachedRef = useRef<Set<string>>(new Set());

    // History loads on first open and stays — the conversation is global and
    // long-lived, so re-fetching on every open would flash an empty panel.
    //
    // The latch is a ref, NOT `messages.length === 0`. Keyed on the message
    // count, "have we loaded yet?" and "did the load return anything?" are the
    // same question, so a learner whose conversation is empty — every first run,
    // and every run after Clear — fell into a fetch loop: load ends, count is
    // still 0, the effect's own deps change, it fires again, forever, for as
    // long as the panel stayed open. A failed request looped identically.
    /**
     * Pull the conversation from the server and rebuild the reasoning traces
     * with it.
     *
     * A trace is stored on the message (`chat_messages.reasoning`), so the
     * panels are not a property of the session that watched the turn happen:
     * they reload, and they reach the other device. This is also what settles a
     * reattached turn — the optimistic ids the drawer assigns are negative, and
     * only the server knows the real ones.
     */
    const loadHistory = useCallback(async () => {
        const rows = await api.getGlobalChatHistory();
        const traces: Record<number, string> = {};
        for (const m of rows) {
            if (m.role === 'assistant' && m.reasoning) traces[m.id] = m.reasoning;
        }
        setMessages(rows);
        setReasoningByMsg(traces);
        return rows;
    }, []);

    // A reply arriving token by token is the clearest case of "not a moment to
    // reload": the text on screen is not in the database yet. `UpdatePrompt`
    // raises its banner instead and the update waits for the turn to finish.
    useEffect(() => (streaming ? holdReload('assistant-stream') : undefined), [streaming]);

    const historyLoadedRef = useRef(false);
    useEffect(() => {
        if (!open || historyLoadedRef.current) return;
        historyLoadedRef.current = true;
        setLoadingHistory(true);
        loadHistory()
            // An empty assistant is a fine degraded state — but let a NEXT open
            // retry, so a transient network failure isn't permanent.
            .catch(() => { historyLoadedRef.current = false; })
            .finally(() => setLoadingHistory(false));
    }, [open, loadHistory]);

    // Which model is on the other end, refreshed while the panel is open. The
    // check is a real request to the model server, so it is polled slowly and
    // only when someone is looking at it — never on a timer behind a closed
    // panel. It also runs right after a turn finishes, which is the moment a
    // silent backend failure would otherwise look like "the assistant ignored me".
    useEffect(() => {
        if (!open) return;
        let alive = true;
        const check = () => {
            setStatusLoading(true);
            api.getAIStatus()
                .then(s => { if (alive) setStatus(s); })
                .catch(() => { if (alive) setStatus(null); })
                .finally(() => { if (alive) setStatusLoading(false); });
        };
        check();
        const id = window.setInterval(check, 60_000);
        return () => { alive = false; window.clearInterval(id); };
    }, [open, streaming]);

    // As an overlay, the drawer takes selection away from the whole document so
    // that a drag out of the message list has nowhere to escape to — see the
    // `.assistant-overlay-open` rule in index.css for why marking only this
    // panel's own chrome unselectable was not enough. Docked, the page beside
    // the panel keeps its selection: it is a column of the app, not a modal.
    useEffect(() => {
        if (!open || docked) return;
        document.body.classList.add('assistant-overlay-open');
        return () => document.body.classList.remove('assistant-overlay-open');
    }, [open, docked]);

    useEffect(() => {
        // Escape closes the modal drawer. Docked, the panel is a persistent part
        // of the workspace and Escape belongs to whatever the learner is doing in
        // the page beside it, so it must not steal the key.
        if (!open || docked) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, docked, onClose]);

    // A screen that opened the assistant with a question in hand (the project
    // dashboard's "ask about this project") fills the composer — it never sends.
    // The learner reads it, edits it, decides. An auto-sent question would spend
    // their model on something they didn't ask for, and the reply would be
    // sitting there before they'd read the prompt.
    useEffect(() => {
        if (!open) return;
        const pending = consumeAssistantPrefill();
        if (pending) setInput(pending);
    }, [open, consumeAssistantPrefill]);

    useEffect(() => {
        if (!open) return;
        // Focus the composer on a mouse+keyboard machine only. On a phone,
        // focusing raises the on-screen keyboard, which shoves the whole
        // conversation up the moment the drawer opens — and reopening the
        // assistant to RE-READ an answer is at least as common as asking a new
        // question. There the learner taps the box when they mean to type.
        // (Capture is different: it exists only to type, so it keeps its focus.)
        if (!typingIsCheap()) return;
        const id = requestAnimationFrame(() => inputRef.current?.focus());
        return () => cancelAnimationFrame(id);
    }, [open, inputRef]);

    // Resolve every `[[open:…]]` id the conversation contains — including the
    // ones in messages loaded from HISTORY, not just a reply streamed in this
    // session. Without this the buttons existed only on the device that asked
    // the question: the same conversation opened on the phone rendered the
    // stripped text with nothing to tap.
    useEffect(() => {
        if (!open) return;
        const pending: number[] = [];
        for (const m of messages) {
            if (m.role !== 'assistant') continue;
            for (const t of splitOpenTargets(m.content).targets) {
                if (askedRef.current.has(t.nodeId)) continue;
                askedRef.current.add(t.nodeId);
                pending.push(t.nodeId);
            }
        }
        if (pending.length === 0) return;
        api.resolveNodeLabels(pending)
            .then(rows => setLabels(prev => {
                const next = { ...prev };
                for (const r of rows) next[r.id] = r;
                return next;
            }))
            // No button beats a button that lies — but a network blip shouldn't
            // retire these ids for good, so let the next message try again.
            .catch(() => { for (const id of pending) askedRef.current.delete(id); });
    }, [open, messages]);

    // Opening lands on the newest message. `loadingHistory` is in the deps
    // because the first open paints an empty box and *then* fills it — sticking
    // only on `open` would scroll a list that has no rows yet.
    useEffect(() => {
        if (open) scroll.stick();
    }, [open, loadingHistory, scroll]);

    // A turn the LEARNER just started re-arms following — you always want to see
    // the answer to the question you just asked. Everything else respects
    // whatever the reader has done with the scrollbar since.
    useEffect(() => {
        if (messages[messages.length - 1]?.role === 'user') scroll.stick(true);
    }, [messages, scroll]);

    useEffect(() => { scroll.follow(); }, [streamed, scroll]);

    useEffect(() => { messagesRef.current = messages; }, [messages]);

    /**
     * Write a repaired (or rebuilt) visual back into the stored reply.
     *
     * Without this an auto-repairing block re-runs the model on EVERY page load
     * — and, worse, a fix the learner watched happen is gone the next time they
     * open the drawer. The node tutor has had this since the repair loop
     * shipped; the assistant renders through the same `Markdown` pipeline and
     * simply never passed the callback, so the fix reached the screen and
     * nothing else.
     */
    const persistRepair = (messageId: number, originalCode: string, repairedCode: string) => {
        const msg = messagesRef.current.find(m => m.id === messageId);
        if (!msg || !msg.content.includes(originalCode)) return;
        const newContent = msg.content.split(originalCode).join(repairedCode);
        setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, content: newContent } : m)));
        const dbId = dbIdRef.current.get(messageId) ?? messageId;
        // A history message already carries its real id; a synthetic one that
        // never got mapped (a turn the server did not save) has nothing to
        // write to, and the in-session render is fixed either way.
        if (dbId > 0) api.updateChatMessage(dbId, newContent).catch(() => { });
    };

    /** Add a reasoning delta to a turn, opening its panel while it is thinking. */
    const appendReasoning = useCallback((id: number, delta: string) => {
        if (!delta) return;
        setReasoningByMsg(prev => ({ ...prev, [id]: (prev[id] || '') + delta }));
        if (!userToggledReasoningRef.current.has(id)) {
            setReasoningOpen(prev => (prev[id] ? prev : { ...prev, [id]: true }));
        }
    }, []);

    /** First answer token: there is something to read now, so fold the trace away. */
    const noteContentStarted = useCallback((id: number) => {
        if (contentStartedRef.current) return;
        contentStartedRef.current = true;
        if (!userToggledReasoningRef.current.has(id)) {
            setReasoningOpen(prev => ({ ...prev, [id]: false }));
        }
    }, []);

    /** The learner's choice, which from here on beats the automatic behaviour. */
    const toggleReasoning = useCallback((id: number) => {
        userToggledReasoningRef.current.add(id);
        setReasoningOpen(prev => ({ ...prev, [id]: !prev[id] }));
    }, []);

    /**
     * Follow a turn that is ALREADY running.
     *
     * The conversation is one global thread and the generation is a background
     * task, so the device that asked the question is not necessarily the device
     * watching the answer: a turn started on the desktop was, on the phone, a
     * question with nothing under it and no sign anything was happening — while
     * the TaskDock two inches below said "thinking 41.4k". The node tutor has
     * reattached to its own task since the task queue shipped; this is the same
     * move, minus the per-node bookkeeping (the question is already persisted,
     * so there is nothing to splice in from task metadata).
     *
     * Aborting here only detaches this panel. The task keeps running and the
     * server persists the turn either way, which is what makes reattaching safe
     * to do from two devices at once.
     */
    const attachToTask = useCallback(async (taskId: string) => {
        const assistantId = -Date.now() - 1;
        const controller = new AbortController();
        abortRef.current = controller;
        setStreamingId(assistantId);
        contentStartedRef.current = false;
        setStreamed('');
        setStreaming(true);
        let full = '';
        try {
            for await (const evt of api.attachTask(taskId, controller.signal)) {
                if (typeof evt.thinkingChunk === 'string') appendReasoning(assistantId, evt.thinkingChunk);
                if (typeof evt.chunk === 'string' && evt.chunk) {
                    noteContentStarted(assistantId);
                    full += evt.chunk;
                    setStreamed(full);
                }
                if (evt.error) throw new Error(evt.error);
                if (evt.done || evt.cancelled) break;
            }
        } catch {
            // A failed task reports itself in the dock, with the whole record
            // behind it. Here it just means there is nothing more to follow.
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setStreaming(false);
            setStreamed('');
            setStreamingId(null);
            // Settle from the database however it ended: canonical row ids and
            // the persisted trace, which also retires the provisional id above.
            // On a FAILURE this is what takes the question back off the screen —
            // the server drops an unanswered turn, and a watching device that
            // skipped the reload would go on showing a question the
            // conversation no longer contains.
            if (!controller.signal.aborted) await loadHistory().catch(() => { });
        }
    }, [appendReasoning, noteContentStarted, loadHistory]);

    // Pick up a global turn that is already in flight.
    //
    // The task list is the one the TaskDock draws, kept live by its own SSE
    // feed — which is the point: the dock along the bottom of the screen said
    // "Planner · thinking 41.4k" while the panel that turn BELONGS to showed a
    // question with nothing under it. Reading the same list means no polling
    // and no delay, on the phone as much as on the desktop.
    //
    // Skipped while this panel is the one generating, and each task is followed
    // at most once — a task stays in the list for a while after it finishes.
    useEffect(() => {
        if (!open || streaming) return;
        const active = aiTasks.find(t => t.kind === 'today_chat'
            && (t.status === 'running' || t.status === 'queued'));
        if (!active || attachedRef.current.has(active.id)) return;
        attachedRef.current.add(active.id);
        let cancelled = false;
        // Reload first: the server persists the question before it calls the
        // model, so on a device that has never seen this turn it is not in the
        // list yet — and an answer arriving above no question reads as a reply
        // to whatever came before it.
        loadHistory()
            .catch(() => { })
            .then(() => { if (!cancelled) attachToTask(active.id); });
        return () => { cancelled = true; };
    }, [open, streaming, aiTasks, loadHistory, attachToTask]);

    const send = useCallback(async (text: string) => {
        const message = text.trim();
        if (!message || streaming) return;

        const userId = -Date.now();
        const assistantId = userId - 1;
        setInput('');
        setStreamed('');
        setStreamingId(assistantId);
        contentStartedRef.current = false;
        setStreaming(true);
        setTurnError(null);
        setMessages(prev => [...prev, {
            id: userId, role: 'user', content: message, created_at: new Date().toISOString(),
        } as ChatMessage]);

        const controller = new AbortController();
        abortRef.current = controller;
        let full = '';
        let failed = '';
        // The row the server persisted for this turn. The optimistic message
        // below carries a synthetic negative id, so without this a visual
        // repaired in THIS turn has no row to be written back to — which is the
        // whole of the "the AI fixed the formula, it was broken again after a
        // reload" bug. The node tutor next door already did this; only the
        // assistant was passing `undefined` where the id arrives.
        let savedId: number | null = null;
        // The background task this turn runs as, once the server has accepted
        // it. From that frame on the turn EXISTS whatever happens to this
        // socket, and a broken socket is re-followed rather than reported.
        let taskId: string | null = null;
        let terminal = false;
        // The stored answer, handed back in the terminal frame: the same text
        // with its `[[src:N]]` grounding markers resolved into the documents
        // they cited. Preferred over the streamed text so this message and the
        // same one re-read from history are identical.
        let settled: string | null = null;
        try {
            const stream = api.streamGlobalChat(
                message,
                { view, projectId: currentProjectId, nodeId: selectedNodeId, feedItemId: feedFocusItemId },
                controller.signal,
                meta => { savedId = meta.assistantMessageId; settled = meta.content ?? null; terminal = true; },
                undefined,
                delta => appendReasoning(assistantId, delta),
                id => { taskId = id; attachedRef.current.add(id); },
                { useWeb, onNote: setNote, onActions: trackActions },
            );
            for await (const chunk of stream) {
                noteContentStarted(assistantId);
                setNote('');
                full += chunk;
                setStreamed(full);
            }
        } catch (e: any) {
            if (!controller.signal.aborted) failed = e.message || 'the request failed.';
        } finally {
            abortRef.current = null;
            setStreaming(false);
            setStreamed('');
            setStreamingId(null);
            setNote('');
            // NOT cleared here: the rows are handed to the message this turn
            // becomes, below, and clearing them first would blank the list for
            // a frame between the stream ending and the message arriving.

            // The socket died under a turn the server had already taken on —
            // the phone went to the background, the network changed, the
            // stream went quiet. The answer kept being written on the server.
            // Before this, whatever had arrived was appended as if it were the
            // whole answer, with its half-drawn diagram, and nothing ever
            // re-read it: "still broken after I came back". Now the task is
            // released for the follow-up effect below, which re-attaches (the
            // server replays what it has, then streams the rest) or, if it
            // has already finished, reads the persisted turn from history.
            const dropped = !terminal && !controller.signal.aborted && taskId != null;
            if (dropped && taskId) {
                attachedRef.current.delete(taskId);
                setReasoningByMsg(prev => { const next = { ...prev }; delete next[assistantId]; return next; });
                loadHistory().catch(() => { });
            } else if (full.trim()) {
                // Stored RAW, markers and all — exactly what the server persists,
                // so this message and the same one re-read from history resolve
                // their buttons through one code path. Display strips them.
                // Under the id the reasoning has been accumulating against, so
                // the trace stays attached to the answer it produced.
                freshIdsRef.current.add(assistantId);
                if (savedId != null) {
                    dbIdRef.current.set(assistantId, savedId);
                    // The turn is fresh under BOTH ids. Any history reload —
                    // and the panel re-reads history on every return to the
                    // foreground — replaces this message with its saved row,
                    // whose id is the database's; marked fresh only under the
                    // synthetic id, the same answer came back with autoBuild
                    // off, and a scene brief the specialist had not yet drawn
                    // showed as "not drawn" the moment the learner switched
                    // tabs and back.
                    freshIdsRef.current.add(savedId);
                }
                setMessages(prev => [...prev, {
                    id: assistantId, role: 'assistant',
                    content: settled?.trim() ? settled : full,
                    // What it looked up rides with it, so the rows stay exactly
                    // where they were rather than disappearing at the moment
                    // the answer lands. A history reload replaces this message
                    // with the stored row, which carries the same list.
                    actions: actionsRef.current.length ? actionsRef.current : null,
                    created_at: new Date().toISOString(),
                } as ChatMessage]);
                trackActions([]);
            } else if (failed) {
                // Nothing came back, so the turn did not happen: drop the
                // optimistic bubble (leaving it makes an unanswered question
                // look asked), hand the text back, and say why IN THE PANEL.
                // A toast was all this used to do, and on a phone the drawer
                // covers the whole screen — the send just appeared to do
                // nothing. The tutor next door already restored the draft on
                // failure; only the assistant had this half of the bug.
                setMessages(prev => prev.filter(m => m.content !== message || m.role !== 'user' || m.id !== userId));
                // The trace goes with it. The server drops its own copy of an
                // unanswered turn for the same reason (runChatTurn), so keeping
                // ours would leave a reasoning panel hanging under no question.
                setReasoningByMsg(prev => { const next = { ...prev }; delete next[assistantId]; return next; });
                trackActions([]);
                setInput(cur => (cur.trim() ? cur : message));
                setTurnError({ message: failed, text: message });
            }
        }
    }, [streaming, view, currentProjectId, selectedNodeId, feedFocusItemId, loadHistory, trackActions]);

    // Coming back to the app re-reads the conversation. A phone suspends the
    // page while another app is in front; whatever this panel showed at that
    // moment is what it still shows on return, and the server has moved on
    // (a turn finished, a visual was drawn and cached). Not while a turn is
    // streaming here — that socket has its own stale watchdog (api.ts) and
    // the task follow-up above.
    useEffect(() => {
        if (!open) return;
        const onVisible = () => {
            if (document.visibilityState !== 'visible' || streaming) return;
            loadHistory().catch(() => { });
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [open, streaming, loadHistory]);

    const stop = () => abortRef.current?.abort();

    const clear = async () => {
        if (streaming) return;
        try {
            await api.clearGlobalChatHistory();
            setMessages([]);
            setLabels({});
            setReasoningByMsg({});
            setReasoningOpen({});
            userToggledReasoningRef.current.clear();
            askedRef.current.clear();
            freshIdsRef.current.clear();
        } catch (e: any) {
            addToast('error', tr("Could not clear the conversation"), e.message);
        }
    };

    // Clamped so the panel can never eat the page it exists to sit beside.
    const resizeBy = (delta: number) => {
        const next = width + delta;
        onResize(Math.max(MIN_WIDTH, Math.min(next, Math.round(window.innerWidth * 0.6))));
    };

    // Drag the panel's edge to set its width. Docked only: as an overlay the
    // panel already owns the whole screen, and there is nothing beside it to
    // trade width with.
    const startResize = (e: React.PointerEvent) => {
        if (!docked) return;
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = width;
        const onMove = (ev: PointerEvent) => {
            // Dragging LEFT widens the panel, so the delta is inverted.
            const next = startWidth + (startX - ev.clientX);
            onResize(Math.max(MIN_WIDTH, Math.min(next, Math.round(window.innerWidth * 0.6))));
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    // Closing on a backdrop tap is right; closing on the END of a text-selection
    // drag is not — and on a phone that is the same click. Selecting a formula
    // out of an answer means long-pressing inside the panel and dragging a
    // handle, which very often lifts over the backdrop: the drawer shut, the
    // selection died, and the learner did it three times before giving up.
    // Shared with Modal and the notes preview, which had the identical problem.
    //
    // Declared ABOVE the `!open` early return: it is a hook, and sitting below
    // the return made the number of hooks this component runs depend on `open`.
    const backdrop = useTapGuard(onClose, true);

    if (!open) return null;

    // Markers are stripped for display but the stored history may still contain
    // them (a turn persisted server-side keeps the raw text).
    // Both marker families come out before anything is displayed or copied —
    // they are instructions to this app and mean nothing anywhere else.
    // Every marker out before the text is read. Grounding markers are normally
    // resolved server-side into the documents they cited, so this is the safety
    // net for the ones that are not: a turn still streaming, and any turn whose
    // sources went missing.
    const renderBody = (content: string) =>
        stripCitationMarkers(splitSettingChanges(splitDestinations(splitOpenTargets(content).body).body).body);

    // Which messages open a new day. Computed once per render over the whole
    // list rather than by comparing against the previous item inside the map,
    // so a streaming turn appended today can't retro-label yesterday's history.
    const dayStarts = new Set<number>();
    let lastDay = '';
    for (const m of messages) {
        const key = dayKey(m.created_at);
        if (key && key !== lastDay) { dayStarts.add(m.id); lastDay = key; }
    }

    const panel = (
        <aside
            className={`relative h-full min-h-0 bg-white dark:bg-slate-800 border-l border-slate-200 dark:border-slate-700 flex flex-col ${
                docked ? 'shrink-0' : 'w-full sm:w-[28rem] max-w-full shadow-2xl'
            }`}
            style={docked ? { width } : undefined}
            aria-label={tr("Assistant")}
        >
            {/* Resize grip. A hairline that widens its hit area beyond what it
                paints, so it is grabbable without drawing a bar down the page.
                Focusable and arrow-key operable, because a control that only a
                drag can reach doesn't exist for a keyboard. */}
            {docked && (
                <div
                    onPointerDown={startResize}
                    onDoubleClick={() => onResize(DEFAULT_WIDTH)}
                    onKeyDown={e => {
                        const step = e.shiftKey ? 64 : 16;
                        if (e.key === 'ArrowLeft') { e.preventDefault(); resizeBy(step); }
                        else if (e.key === 'ArrowRight') { e.preventDefault(); resizeBy(-step); }
                        else if (e.key === 'Home') { e.preventDefault(); onResize(DEFAULT_WIDTH); }
                    }}
                    tabIndex={0}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={tr("Resize the assistant")}
                    aria-valuenow={width}
                    title={tr("Drag to resize · double-click to reset")}
                    className="absolute left-0 top-0 bottom-0 -ml-1 w-2 cursor-col-resize z-10 hover:bg-accent/30 active:bg-accent/50 focus-visible:bg-accent/50 focus:outline-none transition-colors"
                />
            )}

            {/* `select-none` on the chrome is load-bearing, not cosmetic. Dragging
                a selection out of the message list hit-tests whatever is above or
                below it, and the browser then extends the range to that point —
                so reaching for one line of an answer swallowed the header title,
                the model badge and every message in between, which reads as the
                selection "jumping to the whole page". Chrome that cannot hold a
                selection endpoint clamps the range to the message list instead,
                and the list auto-scrolls the way a scroll container should.

                `h-14` is not a style choice, it is the APP HEADER's height. When
                the panel is docked the two headers are side by side across the
                top of the screen, so their bottom borders are read as one line —
                and `py-3` around a two-line title made this one 61px against the
                app's 56px, i.e. a 5px step in a rule that runs the full width of
                the display. The stack inside is 36px, so it sits inside 56 with
                room to spare; overlaying it is a `min-h-0` job, not a padding
                one. */}
            <header className="flex h-14 items-center justify-between gap-2 px-4 border-b border-slate-200 dark:border-slate-700 shrink-0 select-none">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="p-1.5 rounded-lg bg-accent/10 shrink-0">
                            <BrandMark className="w-4 h-4 text-accent-fg" />
                        </span>
                        <div className="min-w-0">
                            <h2 className="font-semibold text-slate-800 dark:text-slate-100 truncate leading-tight">{tr("Assistant")}</h2>
                            <AiModelBadge status={status} loading={statusLoading && !status} fallbackLabel={tr("Assistant")} />
                        </div>
                    </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        onClick={clear}
                        disabled={streaming || messages.length === 0}
                        aria-label={tr("Clear conversation")}
                        title={tr("Clear conversation")}
                        className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 transition"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                    <button
                        onClick={onClose}
                        aria-label={tr("Close assistant")}
                        className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>
            </header>

            <div
                ref={scroll.ref}
                onScroll={scroll.onScroll}
                className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 space-y-4 select-text"
            >
                {loadingHistory && messages.length === 0 && (
                    <div className="flex justify-center py-6">
                        <Loader2 className="w-5 h-5 text-slate-400 animate-spin" />
                    </div>
                )}

                {!loadingHistory && messages.length === 0 && !streaming && (
                    <div className="text-sm text-slate-500 dark:text-slate-400 space-y-3">
                        <p>
                            {tr("Ask about your day, your backlog, or whatever is on screen. This one sees every project at once — the per-topic Tutor lives inside a topic.")}
                        </p>
                    </div>
                )}

                {messages.map(m => (
                    <div key={m.id} className="space-y-4">
                        {dayStarts.has(m.id) && <DateBlob iso={m.created_at} />}
                        <div className={m.role === 'user' ? 'flex justify-end' : 'group space-y-3'}>
                            {m.role === 'user' ? (
                                <p className="max-w-[85%] px-3 py-2 rounded-2xl rounded-br-sm bg-accent text-white text-sm whitespace-pre-wrap break-words select-text">
                                    {m.content}
                                </p>
                            ) : (
                                <>
                                    {/* What the model worked through before it
                                        answered. It used to be a character
                                        count and nothing else — the one number
                                        that says a long turn is alive, and the
                                        one thing you cannot read. */}
                                    {/* What this turn looked up, in the order it
                                        happened: before the reasoning, before the
                                        answer, because that is when it happened. */}
                                    <AiActions actions={m.actions} className="mb-1" />
                                    <ReasoningPanel
                                        text={reasoningByMsg[m.id] || ''}
                                        open={!!reasoningOpen[m.id]}
                                        onToggle={() => toggleReasoning(m.id)}
                                    />
                                    {renderBody(m.content).trim() ? (
                                        <Markdown
                                            content={renderBody(m.content)}
                                            className="text-sm leading-6 text-slate-700 dark:text-slate-200 select-text"
                                            autoRepair={freshIdsRef.current.has(m.id)}
                                            autoBuild={freshIdsRef.current.has(m.id)}
                                            surface="assistant"
                                            messageId={m.id > 0 ? m.id : undefined}
                                            onRepaired={(orig, fixed) => persistRepair(m.id, orig, fixed)}
                                        />
                                    ) : (
                                        // A turn that reasoned and then said nothing
                                        // — a model that looped, or ran out of
                                        // context mid-thought. The row is kept for
                                        // its trace; the answer's absence is said,
                                        // not drawn as an empty gap under a panel.
                                        <p className="text-sm italic text-slate-500 dark:text-slate-400">
                                            {reasoningByMsg[m.id]
                                                ? tr("The model reasoned for {{chars}} characters and gave no answer.", { chars: num(reasoningByMsg[m.id].length) })
                                                : tr("The model gave no answer.")}
                                        </p>
                                    )}
                                    {/* Settings this answer changed, with the way
                                        back. Fresh turns only: re-reading an old
                                        conversation must not re-apply what it did. */}
                                    <SettingChangeChips
                                        changes={splitSettingChanges(m.content).changes}
                                        messageKey={String(m.id)}
                                        // Fresh turns APPLY and offer Undo; a
                                        // re-read of an old one only states what
                                        // it did. Without the second half, "I am
                                        // switching the interface to Dutch now:"
                                        // reopened as a sentence ending in a colon
                                        // and nothing after it — the change had
                                        // happened, and the record of it had not
                                        // survived the reload.
                                        record={!freshIdsRef.current.has(m.id)}
                                    />
                                    {/* Copy the WHOLE answer — the markdown as
                                        written, not the rendered text, so a
                                        pasted formula or table survives. The
                                        `[[open:…]]` markers are stripped: they
                                        are an instruction to this app, and mean
                                        nothing anywhere else. */}
                                    {renderBody(m.content).trim() && (
                                        <div className="flex items-center">
                                            <CopyButton
                                                text={readableAnswer(m.content, false, m.actions)}
                                                label={tr("Copy answer")}
                                                onFailed={() => addToast('error', tr("Could not copy"), tr("Your browser blocked clipboard access."))}
                                            />
                                        </div>
                                    )}
                                    {/* Topics this answer pointed at. The ids are its idea;
                                        every word on these buttons came back from the
                                        database, and an id it invented resolves to nothing. */}
                                    <TargetButtons
                                        targets={messageTargets(m.content, labels)}
                                        onOpen={t => { openProjectNode(t.projectId, t.id); if (!docked) onClose(); }}
                                    />
                                    {/* And screens it pointed at. The model named a
                                        key from a fixed list; the label and the route
                                        are the app's, and pressing is the learner's —
                                        an assistant that navigated on its own reading
                                        would move the page out from under them. */}
                                    <DestinationButtons
                                        destinations={splitDestinations(m.content).destinations}
                                        onGo={d => { navigate(d.path); if (!docked) onClose(); }}
                                    />
                                </>
                            )}
                        </div>
                    </div>
                ))}

                {turnError && (
                    <ChatTurnError
                        message={turnError.message}
                        retryDisabled={streaming}
                        onRetry={() => { const t = turnError.text; setTurnError(null); send(t); }}
                        onDismiss={() => setTurnError(null)}
                    />
                )}

                {streaming && (
                    <div className="space-y-2">
                        {/* The live trace sits above the answer as it arrives,
                            open by default while there is nothing else to read
                            and folded away by the first answer token. */}
                        <AiActions actions={actions} />
                        {streamingId != null && (
                            <ReasoningPanel
                                text={reasoningByMsg[streamingId] || ''}
                                open={!!reasoningOpen[streamingId]}
                                live={!streamed}
                                follow
                                onToggle={() => toggleReasoning(streamingId)}
                            />
                        )}
                        {streamed
                            ? <Markdown
                                content={stripCitationMarkers(splitSettingChanges(splitDestinations(splitOpenTargets(streamed, true).body, true).body, true).body)}
                                streaming
                                className="text-sm leading-6 text-slate-700 dark:text-slate-200"
                                autoBuild={false}
                            />
                            : !(streamingId != null && reasoningByMsg[streamingId]) && (
                                // Nothing at all yet — or a model that does not
                                // report its thinking, where the spinner IS the
                                // whole of what can honestly be said. A web
                                // search happens BEFORE the model starts and
                                // takes seconds, so it says so rather than
                                // spending them under a generic "Thinking…".
                                <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    {note || tr("Thinking…")}
                                </p>
                            )}
                    </div>
                )}
            </div>

            <div className="shrink-0 border-t border-slate-200 dark:border-slate-700 p-3 space-y-2 select-none">
                {messages.length === 0 && !streaming && (
                    <div className="flex flex-wrap gap-1.5">
                        {QUICK_PROMPTS.map(p => (
                            <button
                                key={p}
                                onClick={() => send(tr(p))}
                                className="px-2.5 py-1.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition"
                            >
                                {tr(p)}
                            </button>
                        ))}
                        <button
                            onClick={() => { if (!docked) onClose(); onCapture(); }}
                            className="px-2.5 py-1.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition"
                        >
                            {tr("Capture something")}
                        </button>
                    </div>
                )}

                {/* The one control in this app that opens a socket to anywhere,
                    so: hidden entirely unless web answers are switched on in
                    Settings. It grants permission rather than ordering a search
                    — the assistant decides whether it needs the web at all and
                    writes its own query, and the answer it stores says which
                    queries those were. */}
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

                <div className="flex items-end gap-2">
                    {/* `select-text` on the field re-arms what the wrapper's
                        `select-none` turned off: Safari and Firefox let an
                        inherited `user-select: none` reach into a textarea's
                        own value. */}
                    <textarea
                        ref={inputRef}
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
                        }}
                        rows={1}
                        placeholder={tr("Ask anything…")}
                        className="flex-1 min-w-0 px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:ring-2 focus:ring-accent focus:border-accent transition resize-none select-text"
                    />
                    {streaming ? (
                        <button
                            onClick={stop}
                            aria-label={tr("Stop generating")}
                            className="p-2.5 min-h-11 rounded-xl bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 transition"
                        >
                            <Square className="w-4 h-4" />
                        </button>
                    ) : (
                        <button
                            onClick={() => send(input)}
                            disabled={!input.trim()}
                            aria-label={tr("Send")}
                            className="p-2.5 min-h-11 rounded-xl bg-accent text-white hover:brightness-90 disabled:opacity-40 transition"
                        >
                            <Send className="w-4 h-4" />
                        </button>
                    )}
                </div>
                <AiDisclosure />
            </div>
        </aside>
    );

    // Docked, the panel is just another column of the app frame: no backdrop, no
    // dimming, no focus trap — the page beside it stays fully live, so the
    // learner can scroll a lesson and ask about it in the same breath. Only the
    // overlay form (a phone, where there is no room for two things) is a dialog.
    if (docked) return panel;

    return (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={tr("Assistant")}>
            <div className="absolute inset-0 bg-black/50" {...backdrop} aria-hidden="true" />
            {panel}
        </div>
    );
}
