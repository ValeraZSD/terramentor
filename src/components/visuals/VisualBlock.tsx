import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Code2, Copy, Download, Loader2, MessageSquareWarning, PenLine, Wand2, X } from 'lucide-react';
import { loadRenderer, SELF_THEMING_KINDS, VISUAL_KIND_LABELS } from './registry';
import { isVisualBrief, isUndrawnError } from './resolveBrief';
import { readVisualPalette } from './palette';
import { stampArrivalOrder, settleArrival, ARRIVAL_STAGE_MS } from './arrival';
import ExportVisualModal from './ExportVisualModal';
import { useStore, themeKeyOf } from '../../store';
import { api } from '../../api';
import { copyText } from '../../utils/clipboard';
import { repairPercent, progressCounter, type RepairProgress } from './repairProgress';
import { useTranslation } from 'react-i18next';
import { useNumberFormat } from '../../hooks/useNumberFormat';

/** Kinds rendered inside a sandboxed iframe, whose pixels the page cannot read. */
const IFRAME_KINDS: ReadonlySet<string> = new Set(['p5', 'widget']);

/**
 * The toolbar buttons, sized as TARGETS rather than as text.
 *
 * They were `flex items-center gap-1.5` around a 14px icon and a `text-xs`
 * label, which measured 16px tall — and below `sm` two of them ("Fix this",
 * "Save") hide their label, so on the phone this app is actually studied on the
 * whole control was a bare 14px glyph. Every visual in every lesson carries this
 * row, so "tell the AI the picture is wrong" was the hardest thing on the card
 * to hit. `min-h-6 min-w-6` is the 24px floor; the row's own padding shrinks to
 * absorb it, so the header band grows by 4px, not by 8.
 */
const TOOL_BTN = 'inline-flex min-h-6 min-w-6 items-center justify-center gap-1.5 rounded transition-colors';

/**
 * Width is quantised before it reaches the renderers: a visual is re-rendered
 * from scratch when it changes, so reacting to every pixel of a drag-resize (or
 * a scrollbar appearing) would thrash. 48px buckets are coarse enough to ignore
 * that and fine enough that a phone rotation always crosses one.
 */
const WIDTH_BUCKET = 48;
/**
 * The width a visual should be (re)drawn at, given the width it was last drawn
 * at. Charts now draw to exactly the width they're handed, so quantising to
 * 48px buckets (the old behaviour) threw away up to 47px of the card — visible
 * as dead space beside the chart on a phone. Hysteresis buys the same
 * re-render stability without the loss: the first measurement is used exactly,
 * growth has to clear a bucket before it's worth redrawing, and shrinkage is
 * adopted at once so a visual never sits wider than its container.
 */
const settleWidth = (w: number, prev: number): number => {
    if (!prev) return w;
    if (w < prev) return w <= prev - 8 ? w : prev;
    return w >= prev + WIDTH_BUCKET ? w : prev;
};

/**
 * One line of a scene brief to show while it is not yet drawn: the `Shows:`
 * line if the author wrote one, else the first sentence. Long enough to say
 * what the picture will be about, short enough to stay one line on a phone.
 */
export function briefSummary(code: string, max = 160): string {
    const lines = code.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const shows = lines.find(l => /^shows\s*:/i.test(l));
    const text = (shows ? shows.replace(/^shows\s*:\s*/i, '') : (lines[0] || '')).replace(/\s+/g, ' ');
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20))}…`;
}

interface VisualBlockProps {
    /** Canonical renderer kind from getVisualKind() (mermaid | vega | plot | smiles | math). */
    kind: string;
    /** The fence language as the author wrote it (shown in the header). */
    language: string;
    /** Raw spec text inside the fence. */
    code: string;
    /**
     * True while the surrounding message is still streaming in. Auto-repair is
     * suppressed while live (the spec isn't final yet); it kicks in once the
     * message settles.
     */
    live?: boolean;
    /**
     * Whether a failed render may silently kick off one automatic AI repair.
     * Only true for a message freshly generated in this session — a block
     * re-mounted from chat history on app reopen renders with this false, so it
     * shows the error card and the user chooses "Fix with AI" on demand instead
     * of the app self-healing behind their back.
     */
    autoRepair?: boolean;
    /**
     * Whether a renderer may start an expensive LLM BUILD on its own (only the
     * widget compiler does). Defaults to autoRepair — the chat's behaviour: the
     * tutor says "try the slider below", so the build starts as soon as the
     * reply lands. The FEED passes false: its widgets are pre-compiled in the
     * background by feedGen, so a cached build renders instantly, and anything
     * that slipped through shows a "Build widget" button rather than blocking
     * the learner mid-scroll on a model call.
     */
    autoBuild?: boolean;
    /**
     * Called once when a repair (auto or manual "Fix with AI") produces a spec
     * that differs from the source, with the original and fixed spec text. The
     * host uses it to write the fix back into the stored message so a reopened
     * chat renders the corrected spec instead of the broken original.
     */
    onRepaired?: (originalCode: string, repairedCode: string) => void;
    /**
     * Where this block is being read, and what it belongs to — recorded with a
     * feedback report so a maintainer reading the file later knows whether the
     * drawing came out of a feed lesson, the node tutor or the assistant.
     * Nothing here changes what is rendered.
     */
    surface?: string;
    nodeId?: number;
    messageId?: number;
}

/**
 * Waits for the code to stop changing before re-rendering, so a message that is
 * still streaming in doesn't hammer the renderer with half-finished specs.
 */
function useDebounced(value: string, delayMs: number): string {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        if (value === debounced) return;
        const t = setTimeout(() => setDebounced(value), delayMs);
        return () => clearTimeout(t);
    }, [value, debounced, delayMs]);
    return debounced;
}

/**
 * Shell around every visual renderer: debounces streaming input, renders into a
 * detached scratch element and only swaps it in on success (so transient parse
 * failures mid-stream keep the last good render on screen), and offers
 * view-source / copy affordances. Render errors show the message plus the raw
 * spec so the user can still read (or fix) what the AI wrote.
 */
let blockSeq = 0;

/**
 * The render was cut off by the CONNECTION, not by the spec. On a phone the
 * OS drops every socket the moment the app goes to the background, so a
 * brief the specialist was drawing (two model calls — minutes on a local
 * model) arrives here as "Failed to fetch" or as a stream that ended with no
 * result. That is not a fault in the drawing and must not be sent to the
 * repair loop as one.
 */
function isConnectionFailure(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    if ((e as { stale?: boolean }).stale) return true;
    if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) return true;
    return /stream ended without a result|connection went quiet|No response body/i.test(e.message);
}

const VisualBlock = memo(({ kind, language, code, live = false, autoRepair = false, autoBuild = autoRepair, onRepaired, surface, nodeId, messageId }: VisualBlockProps) => {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const containerRef = useRef<HTMLDivElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    // A stable id for the feedback field's label. useId would do, but this file
    // already carries a module counter for the same job in renderMermaid.
    const blockId = useRef(++blockSeq).current;
    const hasRenderedRef = useRef(false);
    // Renderers bake the palette into the SVG/canvas they produce, so the theme
    // has to be a real dependency of the render — reading the `dark` class once
    // at render time meant a visual drawn before the theme resolved (every page
    // reload, see the boot script in index.html) stayed dark-on-dark until it
    // happened to remount, and switching theme never updated one at all.
    //
    // The dependency is the THEME, not the light/dark boolean it reduces to.
    // Changing the TINT leaves `isDark` unchanged while changing every surface
    // colour under the visual — a visual drawn for stock white sat unchanged on
    // a cream page, which is the same fault the four named themes had.
    const theme = useStore(s => s.theme);
    // `mode:tint`. The mode alone stopped being enough when a theme became a
    // colour: two lavenders and a cream are all `light`, and a cache keyed on
    // that keeps the palette it was first drawn with.
    const themeKey = useStore(s => themeKeyOf(s.theme, s.themeTint));
    // The ACCENT is part of the palette too, and it is a separate setting from
    // the theme. `palette.accent` reaches real ink — a mermaid node border, and
    // now a mindmap's root node — so leaving it out of the dependency meant
    // changing the accent in Settings repainted every button on the page while
    // every diagram kept the colour it was first drawn with. Visible the moment
    // the two disagree, and invisible for as long as nobody changes it.
    const accentColor = useStore(s => s.accentColor);
    // Read once per theme+accent, not per render: `readVisualPalette` calls
    // getComputedStyle, which forces style resolution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const palette = useMemo(() => readVisualPalette(themeKey), [themeKey, accentColor]);
    // Held in a ref as well, so a self-theming kind can still be HANDED the
    // current palette at first render without the palette being a dependency
    // that tears its iframe down every time the theme changes.
    const paletteRef = useRef(palette);
    paletteRef.current = palette;
    // One dependency for "the theme changed", null for the kinds that handle
    // that themselves. `palette` derives from it, so listing that separately
    // would tear a widget's iframe down on the very switch it was built to
    // survive.
    const themeDep = SELF_THEMING_KINDS.has(kind) ? null : `${themeKey}:${accentColor}`;
    const [renderWidth, setRenderWidth] = useState(0);
    const repairTriedRef = useRef(false);
    // Read live in the render effect's catch without making it an effect dep —
    // so a rendered visual doesn't re-run (flicker) when live flips false at
    // stream end; only kind/code changes trigger a re-render.
    const liveRef = useRef(live);
    liveRef.current = live;
    const autoRepairRef = useRef(autoRepair);
    autoRepairRef.current = autoRepair;
    const autoBuildRef = useRef(autoBuild);
    autoBuildRef.current = autoBuild;
    // Aborts an in-flight repair request so the Cancel button can stop it even
    // once it's running.
    const repairAbortRef = useRef<AbortController | null>(null);
    /** The background task the in-flight repair runs as (cancel goes by id). */
    const repairTaskRef = useRef<string | null>(null);
    /**
     * What to do when the page is visible again after a render or a rebuild
     * was cut off by the connection (see isConnectionFailure): re-render, or
     * re-issue the identical rebuild request, which the server dedupes onto
     * the task still running.
     */
    const resumeRef = useRef<(() => void) | null>(null);
    /**
     * `undrawn`: the block holds a scene brief that has not been drawn and
     * may not be drawn without asking (a history message, a feed card whose
     * pre-build never ran) — or is still being written (the reply is live).
     * Neither is a failure, so neither gets the error card: this state draws
     * an offer, and a live one just says what is coming.
     */
    const [status, setStatus] = useState<'pending' | 'ok' | 'error' | 'undrawn'>('pending');
    /**
     * "Draw it" was pressed: for THIS source, an expensive build is consented
     * to, whatever the host's autoBuild says. Reset when the source changes.
     */
    const drawRequestedRef = useRef(false);
    const [error, setError] = useState('');
    const [repairing, setRepairing] = useState(false);
    // The last progress frame of an in-flight repair (null = not yet streaming).
    // Turned into a percentage and a character count by repairProgress.ts — the
    // ramp lives there because a rebuild is up to TWO model calls, and scaling
    // both against one length parked the bar on its 99% clamp for the whole of
    // the second (much longer) one.
    const [repairProgress, setRepairProgress] = useState<RepairProgress | null>(null);
    const [repairedCode, setRepairedCode] = useState<string | null>(null);
    const [showSource, setShowSource] = useState(false);
    const [copied, setCopied] = useState(false);
    const [copiedDrawn, setCopiedDrawn] = useState(false);
    // What the renderer actually drew when that is not the source: the SVG
    // behind a scene brief, the sketch behind a p5 brief, a widget's built
    // HTML. The Source panel shows both, brief above, drawing below.
    const [drawnSpec, setDrawnSpec] = useState<string | null>(null);
    // True for the first paint of this block only — the stage's arrival
    // animation. A theme re-render swaps the picture in place without it.
    const [arriving, setArriving] = useState(false);
    // The feedback panel: open, the learner's words, and whether the report has
    // been written. Deliberately per-block state and not a modal — the thing
    // being described is on screen, and a dialog would cover it.
    const [feedbackOpen, setFeedbackOpen] = useState(false);
    const [feedbackText, setFeedbackText] = useState('');
    const [feedbackSent, setFeedbackSent] = useState(false);
    // A one-line result from a rebuild that produced nothing usable. Not a toast:
    // it belongs beside the drawing it is about.
    const [reviseNote, setReviseNote] = useState<string | null>(null);
    // The Save dialog (GIF for an animation, PNG otherwise), and a nonce that
    // re-runs the render when a brief's cached DRAWING changed under identical
    // words — the effect keys on the source text and would not notice.
    const [exportOpen, setExportOpen] = useState(false);
    const [renderNonce, setRenderNonce] = useState(0);
    // Live status line from a slow renderer (the widget compiler reports
    // queue position / build progress through ctx.onProgress). Takes over the
    // pending footer while present.
    const [progressMsg, setProgressMsg] = useState<string | null>(null);

    const debouncedCode = useDebounced(code, 350);
    // What we actually render: the AI-repaired spec if we have one, else the source.
    const activeCode = repairedCode ?? debouncedCode;

    // New/edited source resets any prior repair attempt so it gets a fresh render.
    useEffect(() => {
        repairTriedRef.current = false;
        drawRequestedRef.current = false;
        setRepairedCode(null);
        setDrawnSpec(null);
    }, [debouncedCode]);

    /** The learner asked for the one model call a brief needs. */
    const requestDraw = () => {
        drawRequestedRef.current = true;
        setStatus('pending');
        setRenderNonce(n => n + 1);
    };

    // A brief written while the reply was still streaming sat in `undrawn`
    // without being looked up; the moment the reply settles it gets its render
    // (a cached drawing answers for free, a fresh message's autoBuild draws).
    // `live` is deliberately not a dependency of the render effect (see
    // liveRef), so this is the one place the settle is noticed.
    const statusRef = useRef(status);
    statusRef.current = status;
    useEffect(() => {
        if (live || statusRef.current !== 'undrawn') return;
        setStatus('pending');
        setRenderNonce(n => n + 1);
    }, [live]);

    // Ask the model to fix a spec that failed to render, then re-render its
    // output (the effect re-runs on repairedCode). One shot per source; on a
    // repeat failure we fall through to the error card. Manual retries reset the
    // guard so the button can try again.
    const runRepair = (badCode: string, message: string) => {
        repairTriedRef.current = true;
        const controller = new AbortController();
        repairAbortRef.current = controller;
        setRepairing(true);
        setRepairProgress({ chars: 0, thinking: 0 });
        setStatus('pending');
        api.repairVisual(kind, badCode, message, controller.signal, p => {
            if (controller.signal.aborted) return;
            setRepairProgress(p);
        }, undefined, id => { repairTaskRef.current = id; })
            .then(({ code: fixed }) => {
                if (controller.signal.aborted) return;
                const trimmed = (fixed || '').trim();
                if (trimmed && trimmed !== badCode.trim()) {
                    setRepairedCode(trimmed);
                    // Persist the fix against the block's original source so a
                    // reopened chat renders the corrected spec, not the broken one.
                    if (trimmed !== code.trim()) onRepaired?.(code, trimmed);
                } else {
                    setStatus('error');
                    setError(message);
                }
            })
            .catch((e: unknown) => {
                // A user-initiated cancel lands here too; leave the error card up
                // (Fix with AI stays available) rather than overwriting state.
                if (controller.signal.aborted) return;
                setStatus('error');
                if (isConnectionFailure(e)) {
                    // The rebuild is a background task and runs on; the same
                    // request re-POSTed joins it (dedupe) and replays.
                    resumeRef.current = () => runRepair(badCode, message);
                    setError(tr("The connection dropped while this was being repaired. The repair carries on on the server and is picked up when you come back."));
                    return;
                }
                setError(message);
            })
            .finally(() => {
                if (repairAbortRef.current === controller) { repairAbortRef.current = null; repairTaskRef.current = null; }
                if (!controller.signal.aborted) {
                    setRepairing(false);
                    setRepairProgress(null);
                }
            });
    };

    /**
     * "This drawing is wrong" — the one failure this app cannot detect itself.
     *
     * Every other quality gate here reads a spec, a question or a rendered
     * error. A visual that PARSES, RENDERS and depicts the wrong thing throws
     * nothing: the repair loop never fires, the coherence checker has already
     * passed it, and the only detector is a person who knows what they were
     * meant to be looking at. So the report is written FIRST and unconditionally
     * — it is the durable half, and it stays useful even if the rebuild that
     * follows is worse than what it replaced.
     *
     * Then the same specialist prompt that BUILDS this kind is handed the
     * current spec plus their words. `brief` matters: for ```animation and
     * ```p5 the block may hold a scene brief rather than a finished drawing, and
     * revising a brief with the SVG rules would answer with an SVG.
     */
    const sendFeedback = async () => {
        const text = feedbackText.trim();
        if (!text || repairing) return;
        setFeedbackOpen(false);
        setFeedbackSent(true);
        let feedbackId: string | null = null;
        try {
            const res = await api.reportVisual({
                kind, language, spec: activeCode, feedback: text,
                surface, nodeId, messageId, theme,
            });
            feedbackId = res.id;
        } catch {
            // The rebuild is still worth running: a report that failed to write
            // is a lost record, not a reason to refuse the thing they asked for.
        }
        setFeedbackText('');
        runRevise(activeCode, text, feedbackId);
    };

    // The rebuild itself. Shares runRepair's progress plumbing and its
    // write-back, so a revision persists exactly like a repair does — the same
    // bug ("fixed by the AI, still broken after a reload") would otherwise
    // arrive by a new route.
    const runRevise = (currentCode: string, feedback: string, feedbackId: string | null) => {
        const controller = new AbortController();
        repairAbortRef.current = controller;
        setRepairing(true);
        setRepairProgress({ chars: 0, thinking: 0 });
        setStatus('pending');
        api.repairVisual(kind, currentCode, '', controller.signal, p => {
            if (controller.signal.aborted) return;
            setRepairProgress(p);
        }, { feedback, brief: isVisualBrief(kind, currentCode), feedbackId, theme }, id => { repairTaskRef.current = id; })
            .then(({ code: revised, redrawn }) => {
                if (controller.signal.aborted) return;
                const trimmed = (revised || '').trim();
                if (trimmed && trimmed !== currentCode.trim()) {
                    repairTriedRef.current = false;   // a new spec deserves its own repair budget
                    setRepairedCode(trimmed);
                    if (trimmed !== code.trim()) onRepaired?.(code, trimmed);
                } else if (redrawn) {
                    // A brief-backed visual whose WORDS did not change but whose
                    // cached drawing did (the reader's note went to the drawer).
                    // The block's source is identical, so the render effect has
                    // to be told to run again.
                    repairTriedRef.current = false;
                    setStatus('pending');
                    setRenderNonce(n => n + 1);
                } else {
                    // Nothing came back, or the same spec came back. Say so
                    // rather than leaving a spinner: the drawing on screen is
                    // still the one they complained about.
                    setStatus('ok');
                    setError('');
                    setReviseNote('The model returned the same drawing. Your note was saved — try describing the change more concretely.');
                }
            })
            .catch((e: unknown) => {
                if (controller.signal.aborted) return;
                setStatus('ok');
                setError('');
                if (isConnectionFailure(e)) {
                    resumeRef.current = () => runRevise(currentCode, feedback, feedbackId);
                    setReviseNote(tr("The connection dropped. The rebuild carries on on the server and is picked up when you come back."));
                    return;
                }
                setReviseNote('The rebuild could not be reached. Your note was saved.');
            })
            .finally(() => {
                if (repairAbortRef.current === controller) { repairAbortRef.current = null; repairTaskRef.current = null; }
                if (!controller.signal.aborted) { setRepairing(false); setRepairProgress(null); }
            });
    };

    // Stop an in-flight repair and drop back to the error card so the user can
    // retry manually (or just leave it broken). The rebuild is a background
    // task since 2026-09-07 — closing the socket only detaches from it, so a
    // Cancel pressed here also cancels the task by id, or the model would go
    // on drawing for a block that has stopped listening.
    const cancelRepair = () => {
        repairAbortRef.current?.abort();
        repairAbortRef.current = null;
        const taskId = repairTaskRef.current;
        repairTaskRef.current = null;
        if (taskId) api.cancelTask(taskId).catch(() => { });
        setRepairing(false);
        setRepairProgress(null);
        setStatus('error');
        setError(prev => prev || 'render failed');
    };

    // Abort any pending repair when the block unmounts.
    useEffect(() => () => repairAbortRef.current?.abort(), []);

    // Track the available width in buckets so a rotated phone / resized pane
    // re-renders the visual at the new size instead of keeping the one-shot
    // width it was first drawn at. Layout effect: the width is known before the
    // render effect below runs, so mounting still costs exactly one render.
    useLayoutEffect(() => {
        const el = wrapperRef.current;
        if (!el) return;
        const measure = () => {
            // Wrapper minus the stage's own horizontal padding + the block's 1px
            // borders, so ctx.width is the pixel width a visual can actually
            // occupy. The padding is READ, not assumed — it's smaller on a phone,
            // where every pixel of chart matters, and getComputedStyle answers
            // even while the stage is still display:none.
            const stage = containerRef.current;
            const cs = stage ? getComputedStyle(stage) : null;
            const gutter = cs
                ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + 2
                : 26;
            const w = el.clientWidth - gutter;
            if (w > 0) setRenderWidth(prev => settleWidth(w, prev));
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        const el = containerRef.current;
        if (!el || !activeCode.trim()) return;

        let cancelled = false;
        let cleanup: void | (() => void);
        // Lets a long-running renderer (widget compile) stop its network work
        // when the block unmounts or the source changes; a server-side build
        // task deliberately keeps running (a remount reattaches to it).
        const abort = new AbortController();

        // A brief still being WRITTEN is not looked up, let alone drawn: the
        // words change with every token, so a cache lookup per debounce would
        // be a request for nothing, and drawing would spend a model call on a
        // half-sentence. Say what is coming and wait for the reply to settle.
        if (liveRef.current && isVisualBrief(kind, activeCode)) {
            setStatus('undrawn');
            setError('');
            return;
        }

        // While re-rendering, keep showing the previous good output if we have one.
        setStatus(prev => (prev === 'ok' && hasRenderedRef.current ? 'ok' : 'pending'));

        loadRenderer(kind)
            .then(async render => {
                if (cancelled) return;
                // The stage is display:none until a render succeeds, so its own
                // clientWidth is 0 on a first render — fall back to the measured
                // wrapper, then to the parent, then to a sane desktop default.
                const width = renderWidth
                    || el.clientWidth
                    || wrapperRef.current?.clientWidth
                    || el.parentElement?.clientWidth
                    || 600;
                const scratch = document.createElement('div');
                cleanup = await render(scratch, activeCode, {
                    isDark: paletteRef.current.dark,
                    palette: paletteRef.current,
                    width,
                    onProgress: (message) => { if (!cancelled) setProgressMsg(message); },
                    signal: abort.signal,
                    autoBuild: autoBuildRef.current || drawRequestedRef.current,
                    onResolved: (spec) => { if (!cancelled) setDrawnSpec(spec); },
                });
                if (cancelled) {
                    if (cleanup) cleanup();
                    return;
                }
                el.replaceChildren(...Array.from(scratch.childNodes));
                if (!hasRenderedRef.current) {
                    // First paint: let it arrive. A diagram's parts are stamped
                    // with their own timing (arrival.ts) and the class stays on
                    // until the LAST of them has landed — taking it off early
                    // is what made the tail of a long diagram pop in.
                    const partsMs = stampArrivalOrder(el, kind);
                    setArriving(true);
                    window.setTimeout(() => {
                        setArriving(false);
                        if (containerRef.current === el) settleArrival(el);
                    }, Math.max(partsMs, ARRIVAL_STAGE_MS) + 80);
                }
                hasRenderedRef.current = true;
                setStatus('ok');
                setError('');
                setProgressMsg(null);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setProgressMsg(null);
                if (isUndrawnError(e)) {
                    // Nothing failed: the brief is waiting for consent. No
                    // repair either — there is no fault for a repair to fix.
                    setStatus('undrawn');
                    setError('');
                    return;
                }
                if (isConnectionFailure(e)) {
                    // Nothing is wrong with the spec. The server keeps drawing
                    // (the authoring endpoint is a background task), so the
                    // block re-renders the moment the page is visible again:
                    // a finished drawing answers from the cache for free, and
                    // one still running is re-joined through the endpoint's
                    // dedupe and replays what it has.
                    resumeRef.current = () => {
                        repairTriedRef.current = false;
                        setStatus('pending');
                        setRenderNonce(n => n + 1);
                    };
                    setStatus('error');
                    setError(tr("The connection dropped while this was being drawn. The drawing carries on on the server and is picked up when you come back."));
                    return;
                }
                const message = e instanceof Error ? e.message : String(e);
                // Auto-repair once, but only for a block that (a) has settled
                // (not mid-stream), (b) belongs to a message freshly generated
                // this session — so a block re-mounted from history on reopen
                // never self-heals — and (c) we haven't already tried to fix.
                if (!liveRef.current && autoRepairRef.current && !repairTriedRef.current) {
                    setError(message);
                    runRepair(activeCode, message);
                } else {
                    setStatus('error');
                    setError(message);
                }
            });

        return () => {
            cancelled = true;
            abort.abort();
            if (cleanup) cleanup();
        };
    }, [kind, activeCode, themeDep, renderWidth, renderNonce]);

    // Resume a render the connection cut off (see isConnectionFailure) as soon
    // as the page is visible and online again. Big chat clients all do this —
    // the socket is a VIEW of the server's state, and the state is re-read on
    // foreground rather than trusted to have survived the background.
    useEffect(() => {
        const resume = () => {
            const action = resumeRef.current;
            if (!action) return;
            if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
            resumeRef.current = null;
            action();
        };
        document.addEventListener('visibilitychange', resume);
        window.addEventListener('online', resume);
        return () => {
            document.removeEventListener('visibilitychange', resume);
            window.removeEventListener('online', resume);
        };
    }, []);

    // `copyText`, not `navigator.clipboard`: the latter is undefined over plain
    // http, which is how a phone on the LAN reaches this — the tick only shows
    // when the text actually reached the clipboard.
    const handleCopy = async () => {
        if (!await copyText(code)) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };
    const handleCopyDrawn = async () => {
        if (!drawnSpec) return;
        if (!await copyText(drawnSpec)) return;
        setCopiedDrawn(true);
        setTimeout(() => setCopiedDrawn(false), 2000);
    };
    // The block's source is a plain-words brief when a specialist pass drew
    // it; the finished spec then sits in `drawnSpec`. Both are shown, each
    // labelled, so "Source" never answers a request for code with prose.
    const sourceIsBrief = isVisualBrief(kind, code) || (kind === 'widget' && !!drawnSpec);
    const drawnLabel = kind === 'p5' ? tr("Sketch (p5.js)")
        : kind === 'widget' ? tr("Built widget (HTML)")
            : tr("Drawing (SVG)");

    const label = VISUAL_KIND_LABELS[kind] ?? kind;
    const sourceVisible = showSource || status === 'error';
    const undrawnNoun = kind === 'p5' ? tr("simulation") : tr("animation");

    return (
        <div ref={wrapperRef} className="visual-block my-4 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
            {/* Wraps: label + Source + Copy is three items in a row the card
                clips (`overflow-hidden`, so the stage below can round its
                corners). At 160% UI scale on a phone that row measured 293px
                against a 263px card and Copy was cut off the edge. */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-xs font-mono border-b border-slate-200 dark:border-slate-700">
                <span className="flex items-center gap-1.5 min-w-0">
                    {label}
                    {status === 'pending' && <Loader2 size={12} className="animate-spin" />}
                </span>
                <div className="flex items-center gap-3 shrink-0">
                    {/* SAME BUTTON, SAME PLACE, EVERY VISUAL.

                        A drawing that renders and is wrong is the one failure
                        nothing in this app can detect — so the report has to be
                        one click from wherever the learner noticed it, and it
                        has to be in a position they can learn. It leads the
                        control group for that reason: Source and Copy are about
                        the spec, this is about the picture. */}
                    <button
                        onClick={() => { setFeedbackOpen(v => !v); setReviseNote(null); }}
                        aria-expanded={feedbackOpen}
                        className={`${TOOL_BTN} ${feedbackOpen ? 'text-accent-fg' : 'hover:text-accent-fg'}`}
                        type="button"
                        title={tr("Tell the AI what is wrong with this and rebuild it")}
                    >
                        <MessageSquareWarning size={14} />
                        <span>{tr("Fix this")}</span>
                    </button>
                    {/* Save: a GIF of an animation, a PNG of anything still,
                        bare or on a captioned card. Only once something has
                        rendered — there is nothing to save before that, and
                        nothing to save from an iframe (p5, widget), whose
                        pixels the parent cannot read. */}
                    {status === 'ok' && !IFRAME_KINDS.has(kind) && (
                        <button
                            onClick={() => setExportOpen(true)}
                            className={`${TOOL_BTN} hover:text-accent-fg`}
                            type="button"
                            title={kind === 'animation' ? tr("Save as a GIF, with or without a caption") : tr("Save as an image, with or without a caption")}
                        >
                            <Download size={14} />
                            <span>{tr("Save")}</span>
                        </button>
                    )}
                    <button
                        onClick={() => setShowSource(v => !v)}
                        className={`${TOOL_BTN} ${showSource ? 'text-accent-fg' : 'hover:text-accent-fg'}`}
                        type="button"
                        title={showSource ? tr("Hide source") : tr("Show {{language}} source", { language })}
                    >
                        <Code2 size={14} />
                        {showSource ? tr("Hide source") : tr("Source")}
                    </button>
                    <button
                        onClick={handleCopy}
                        className={`${TOOL_BTN} hover:text-accent-fg`}
                        type="button"
                    >
                        {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                        {copied ? tr("Copied!") : tr("Copy")}
                    </button>
                </div>
            </div>

            <ExportVisualModal
                open={exportOpen}
                onClose={() => setExportOpen(false)}
                kind={kind}
                code={activeCode}
                stage={containerRef.current}
                palette={palette}
            />

            {status === 'error' && (
                <div className="flex items-start gap-2 px-4 py-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200/60 dark:border-amber-800/40">
                    <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                    <span className="break-words flex-1">{tr("Couldn't render this {{label}}: {{error}}", { label: label.toLowerCase(), error })}</span>
                    <button
                        onClick={() => { repairTriedRef.current = false; runRepair(activeCode, error || 'render failed'); }}
                        disabled={repairing}
                        className="flex-shrink-0 flex items-center gap-1 font-medium hover:text-amber-900 dark:hover:text-amber-200 disabled:opacity-50"
                        type="button"
                        title={tr("Ask the AI to fix this spec")}
                    >
                        <Wand2 size={13} />
                        {tr("Fix with AI")}
                    </button>
                </div>
            )}

            {feedbackOpen && (
                <div className="px-4 py-3 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                    <label htmlFor={`vf-${blockId}`} className="block text-sm font-medium text-slate-600 dark:text-slate-300">
                        {tr("What is wrong with this {{label}}?", { label: label.toLowerCase() })}
                    </label>
                    <textarea
                        id={`vf-${blockId}`}
                        value={feedbackText}
                        onChange={e => setFeedbackText(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Escape') { e.stopPropagation(); setFeedbackOpen(false); }
                            // Ctrl/Cmd+Enter submits — the same key the notes
                            // editor and every composer in this app already use.
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendFeedback(); }
                        }}
                        rows={3}
                        autoFocus
                        placeholder={tr("The arrow points the wrong way — it should go from the source to the observer.")}
                        className="mt-1.5 w-full resize-y rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-accent/60"
                    />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        {/* Says exactly what happens, because two things do:
                            the note is kept whatever the rebuild produces. */}
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                            {tr("Saved on this machine, then sent to your own model to redraw it.")}
                        </p>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setFeedbackOpen(false)}
                                className="px-3 py-1.5 text-xs font-medium rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                            >
                                {tr("Cancel")}
                            </button>
                            <button
                                type="button"
                                onClick={sendFeedback}
                                disabled={!feedbackText.trim() || repairing}
                                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-accent text-white hover:brightness-90 disabled:opacity-50 disabled:cursor-not-allowed transition"
                            >
                                {tr("Save and rebuild")}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {reviseNote && (
                <div className="flex items-start gap-2 px-4 py-2 text-sm text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                    <span className="flex-1 break-words">{reviseNote}</span>
                    <button
                        type="button"
                        onClick={() => setReviseNote(null)}
                        aria-label={tr("Dismiss")}
                        className="shrink-0 hover:text-slate-900 dark:hover:text-white"
                    >
                        <X size={13} />
                    </button>
                </div>
            )}

            {sourceVisible && (
                <div className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                    {sourceIsBrief ? (
                        <>
                            <div className="px-4 pt-2 pb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                                {kind === 'widget' ? tr("Spec") : tr("Scene brief")}
                            </div>
                            {/* A brief is prose: set it as prose, not as code. */}
                            <div className="px-4 pb-3 text-sm leading-relaxed whitespace-pre-wrap break-words text-slate-700 dark:text-slate-200">
                                {code}
                            </div>
                            {drawnSpec ? (
                                <>
                                    <div className="flex items-center justify-between gap-3 px-4 pt-2 pb-1 border-t border-slate-200 dark:border-slate-700 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                                        <span>{drawnLabel}</span>
                                        <button
                                            onClick={handleCopyDrawn}
                                            className={`${TOOL_BTN} normal-case tracking-normal font-mono hover:text-accent-fg`}
                                            type="button"
                                        >
                                            {copiedDrawn ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                                            {copiedDrawn ? tr("Copied!") : tr("Copy")}
                                        </button>
                                    </div>
                                    <pre className="px-4 pb-3 text-xs font-mono whitespace-pre-wrap break-words text-slate-600 dark:text-slate-300 m-0 max-h-96 overflow-y-auto">
                                        {drawnSpec}
                                    </pre>
                                </>
                            ) : (
                                <p className="px-4 pb-3 border-t border-slate-200 dark:border-slate-700 pt-2 text-sm text-slate-500 dark:text-slate-400">
                                    {status === 'pending'
                                        ? tr("The drawing appears here once it is made.")
                                        : tr("Not drawn yet — the code appears here once the drawing is made.")}
                                </p>
                            )}
                        </>
                    ) : (
                        <pre className="px-4 py-3 text-xs font-mono whitespace-pre-wrap break-words text-slate-600 dark:text-slate-300 m-0">
                            {code}
                        </pre>
                    )}
                </div>
            )}

            <div
                ref={containerRef}
                role="img"
                className={`visual-block-stage overflow-x-auto p-2 sm:p-3 bg-white dark:bg-slate-900 ${status === 'ok' ? '' : 'hidden'} ${arriving ? 'vb-arrive' : ''}`}
            />

            {/* A brief that is not drawn. Not an error and not styled as one:
                while the reply is live this is the NORMAL state of every brief,
                and afterwards it is an offer — one model call, on request. The
                first line of the brief says what the picture will be about, so
                the card is not a blank with a button on it. */}
            {status === 'undrawn' && (
                <div className="flex flex-col items-center gap-2 px-4 py-6 text-center bg-white dark:bg-slate-900">
                    <PenLine size={18} className="text-slate-500 dark:text-slate-400" aria-hidden="true" />
                    {briefSummary(activeCode) && (
                        <p className="max-w-prose text-sm text-slate-700 dark:text-slate-200 leading-snug">
                            {briefSummary(activeCode)}
                        </p>
                    )}
                    {live ? (
                        <p className="flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                            <Loader2 size={12} className="animate-spin" />
                            {tr("Scene described — the {{noun}} is drawn once the reply finishes.", { noun: undrawnNoun })}
                        </p>
                    ) : (
                        <>
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                {tr("Described in words, not drawn yet.")}
                            </p>
                            <button
                                type="button"
                                onClick={requestDraw}
                                className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-accent text-white hover:brightness-90 transition"
                                title={tr("One pass of your model draws the {{noun}} from this description", { noun: undrawnNoun })}
                            >
                                <Wand2 size={13} />
                                {tr("Draw it")}
                            </button>
                        </>
                    )}
                </div>
            )}

            {status === 'pending' && (
                <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-6 text-sm text-slate-500 dark:text-slate-400">
                    <Loader2 size={14} className="animate-spin" />
                    {repairing
                        ? <>
                            {feedbackSent ? tr("Rebuilding") : tr("Repairing")} {label.toLowerCase()}…
                            {repairProgress && <span className="tabular-nums text-slate-500 dark:text-slate-300"> {repairPercent(repairProgress)}%</span>}
                            {/* The percentage can legitimately sit still for a
                                while near the knee, or while the model is still
                                reasoning; a character count that keeps climbing
                                is what says the request is alive, not hung. */}
                            {repairProgress && progressCounter(repairProgress) && (
                                <span className="tabular-nums text-slate-500 dark:text-slate-400"> · {progressCounter(repairProgress)}</span>
                            )}
                        </>
                        : progressMsg
                            ? <span className="tabular-nums">{progressMsg}</span>
                            : live
                                ? <>{tr("Generating {{label}}…", { label: label.toLowerCase() })}{' '}<span className="tabular-nums text-slate-500 dark:text-slate-300">{tr("{{length}} chars", { count: code.length, length: num(code.length) })}</span></>
                                : tr("Rendering {{label}}…", { label: label.toLowerCase() })}
                    {repairing && (
                        <button
                            onClick={cancelRepair}
                            className="flex items-center gap-1 font-medium text-slate-500 hover:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100"
                            type="button"
                            title={tr("Stop the AI fix")}
                        >
                            <X size={13} />
                            {tr("Cancel")}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
});

VisualBlock.displayName = 'VisualBlock';
export default VisualBlock;
