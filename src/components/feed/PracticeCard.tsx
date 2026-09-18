import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import Markdown from '../Markdown';
import MathText from '../MathText';
import {
    fileToImageData, scanToBlob, imageDataToCanvas, orderCorners,
    type Point, type Quad,
} from '../../utils/scan/warp';
import { FeedPracticeCard, PaperGrade } from '../../types';
import {
    Camera, Check, ChevronRight, Loader2, PenLine, RefreshCw, ScanLine, X, Eye, AlertTriangle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
    card: FeedPracticeCard;
    done: boolean;
    onDone: (key: string) => void;
}

/** Corner handles start inset from the frame — a page rarely fills the shot. */
const DEFAULT_INSET = 0.08;

type Phase = 'brief' | 'adjust' | 'grading' | 'result' | 'selfmark';

/**
 * "Now do it on paper."
 *
 * The one card in the feed that asks the learner to put the phone down. They
 * work the exercise by hand, photograph it, and the app perspective-corrects the
 * shot client-side (src/utils/scan/warp.ts) before a vision model reads it and
 * the main model marks it against the authored rubric.
 *
 * Two things here are deliberate and worth not "simplifying" later:
 *
 * 1. The camera is offered ONLY when the server reports a vision model it
 *    actually trusts. Otherwise the card leads with self-marking instead. An
 *    invitation to photograph work that will then be graded by a model that
 *    cannot see it produces a confident, fabricated grade — far worse than
 *    honestly saying "mark this yourself against the worked solution".
 *
 * 2. An unreadable photo does NOT consume the card or record a score. A bad
 *    shot is not a wrong answer, and charging the learner's mastery estimate for
 *    a lighting problem would teach them to distrust the whole system.
 */
export default function PracticeCard({ card, done, onDone }: Props) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const repairFeedVisual = useStore(s => s.repairFeedVisual);

    const [phase, setPhase] = useState<Phase>('brief');
    const [visionAvailable, setVisionAvailable] = useState<boolean | null>(null);
    const [source, setSource] = useState<ImageData | null>(null);
    const [quad, setQuad] = useState<Quad | null>(null);
    const [grade, setGrade] = useState<PaperGrade | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [solution, setSolution] = useState<string | null>(null);
    const [selfMarked, setSelfMarked] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const previewRef = useRef<HTMLDivElement>(null);
    const dragging = useRef<number | null>(null);

    // Ask once whether marking by photo is even possible here, so the primary
    // button is right the first time rather than failing after the learner has
    // already taken a picture.
    useEffect(() => {
        let alive = true;
        api.getPaperCapability()
            .then(cap => { if (alive) setVisionAvailable(cap.vision); })
            .catch(() => { if (alive) setVisionAvailable(false); });
        return () => { alive = false; };
    }, []);

    const totalWeight = useMemo(
        () => card.rubric.reduce((sum, r) => sum + (r.weight || 1), 0),
        [card.rubric],
    );

    // --- Capture ------------------------------------------------------------

    const onFilePicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        // Reset immediately: picking the SAME file twice (retake after a bad
        // scan) fires no change event unless the value is cleared.
        event.target.value = '';
        if (!file) return;

        setBusy(true);
        setProblem(null);
        try {
            const image = await fileToImageData(file);
            setSource(image);
            const ix = image.width * DEFAULT_INSET;
            const iy = image.height * DEFAULT_INSET;
            setQuad([
                { x: ix, y: iy },
                { x: image.width - ix, y: iy },
                { x: image.width - ix, y: image.height - iy },
                { x: ix, y: image.height - iy },
            ]);
            setPhase('adjust');
        } catch (err: any) {
            setProblem(t("Could not read that image: {{message}}", { message: err.message }));
        } finally {
            setBusy(false);
        }
    };

    // Draw the captured photo into the preview canvas whenever it changes.
    const canvasHostRef = useCallback((host: HTMLDivElement | null) => {
        if (!host || !source) return;
        host.replaceChildren(imageDataToCanvas(source));
        const canvas = host.firstElementChild as HTMLCanvasElement;
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        canvas.style.display = 'block';
        canvas.style.borderRadius = '0.5rem';
    }, [source]);

    // --- Corner dragging ----------------------------------------------------
    // Pointer events (not mouse/touch pairs) so one code path covers finger,
    // stylus and mouse — this is used on a phone far more than on a desktop.

    const pointToImage = (clientX: number, clientY: number): Point | null => {
        const host = previewRef.current;
        if (!host || !source) return null;
        const rect = host.getBoundingClientRect();
        const scale = source.width / rect.width;
        return {
            x: Math.max(0, Math.min(source.width, (clientX - rect.left) * scale)),
            y: Math.max(0, Math.min(source.height, (clientY - rect.top) * scale)),
        };
    };

    const onHandleDown = (index: number) => (e: React.PointerEvent) => {
        e.preventDefault();
        (e.target as Element).setPointerCapture(e.pointerId);
        dragging.current = index;
    };

    const onHandleMove = (e: React.PointerEvent) => {
        if (dragging.current === null || !quad) return;
        const point = pointToImage(e.clientX, e.clientY);
        if (!point) return;
        const next = [...quad] as Quad;
        next[dragging.current] = point;
        setQuad(next);
    };

    const onHandleUp = (e: React.PointerEvent) => {
        if (dragging.current === null) return;
        try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* already released */ }
        dragging.current = null;
    };

    /** Nudge a corner with the keyboard — the handles must not be mouse-only. */
    const onHandleKey = (index: number) => (e: React.KeyboardEvent) => {
        if (!quad || !source) return;
        const step = e.shiftKey ? 20 : 4;
        const deltas: Record<string, [number, number]> = {
            ArrowLeft: [-step, 0], ArrowRight: [step, 0],
            ArrowUp: [0, -step], ArrowDown: [0, step],
        };
        const delta = deltas[e.key];
        if (!delta) return;
        e.preventDefault();
        const next = [...quad] as Quad;
        next[index] = {
            x: Math.max(0, Math.min(source.width, next[index].x + delta[0])),
            y: Math.max(0, Math.min(source.height, next[index].y + delta[1])),
        };
        setQuad(next);
    };

    // --- Submit -------------------------------------------------------------

    const submitScan = async () => {
        if (!source || !quad || busy) return;
        setBusy(true);
        setProblem(null);
        setPhase('grading');
        try {
            // Re-order before warping: nothing stops a learner dragging one
            // handle past another, and the resulting self-intersecting quad
            // warps to garbage without erroring. Sorting by angle turns a
            // bowtie back into the page outline they clearly meant.
            const blob = await scanToBlob(source, orderCorners(quad), card.mode);
            const result = await api.gradePaperAttempt(card.feedItemId, blob);

            if (result.status === 'graded') {
                setGrade(result.grade);
                setPhase('result');
                onDone(card.key);
                return;
            }
            if (result.status === 'no_vision') {
                setVisionAvailable(false);
                setProblem(result.reason);
                setPhase('brief');
                return;
            }
            // 'unreadable' / 'error' — the exercise stays live and retakeable.
            setProblem(result.status === 'unreadable' ? result.reason : result.error);
            setPhase('adjust');
        } catch (err: any) {
            setProblem(err.message);
            setPhase('adjust');
        } finally {
            setBusy(false);
        }
    };

    const openSelfMark = async () => {
        setBusy(true);
        setProblem(null);
        try {
            const { referenceSolution } = await api.getPaperSolution(card.feedItemId);
            setSolution(referenceSolution);
            setPhase('selfmark');
        } catch (err: any) {
            setProblem(err.message);
        } finally {
            setBusy(false);
        }
    };

    const submitSelfMark = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await api.selfGradePaperAttempt(card.feedItemId, selfMarked.size);
            addToast('success', t("Marked {{size}} of {{length}} — recorded", { size: selfMarked.size, length: card.rubric.length }));
            onDone(card.key);
            setPhase('result');
        } catch (err: any) {
            setProblem(err.message);
        } finally {
            setBusy(false);
        }
    };

    const toggleSelfPoint = (id: string) => {
        setSelfMarked(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    // --- Render -------------------------------------------------------------

    const modeLabel = card.mode === 'document' ? t("Written work") : t("Drawing / construction");

    return (
        // No FeedCardShell here. This is a CHAPTER card — ChapterGroup already
        // draws the rounded border, the accent bar down the left, the background
        // and the project/topic header. Wrapping it in the shell as well nested a
        // bordered card with its own accent bar inside the chapter's, and
        // repeated the topic title. The shell is for STANDALONE cards
        // (flashcard, recall); QuestionCard's `inChapter` prop exists for the
        // same reason.
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
            <div className="flex items-start justify-between gap-3 mb-3">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent-fg">
                    <PenLine className="w-3.5 h-3.5" aria-hidden="true" />
                    {t("On paper · {{modeLabel}}", { modeLabel })}
                </p>
                <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-accent/10 text-accent-fg whitespace-nowrap">
                        {t("{{totalWeight}} marks", { totalWeight })}
                    </span>
                    {done && <Check className="w-4 h-4 text-emerald-500" aria-label={t("Done")} />}
                </div>
            </div>

            <div className="prose prose-slate dark:prose-invert max-w-none prose-sm sm:prose-base">
                {/* The brief is the only part of this card that lives in the
                    cached row, so it is the only one whose repair can be
                    written back. `autoBuild` stays off for the same reason the
                    lesson card keeps it off: nothing compiles mid-scroll. */}
                <Markdown
                    content={card.brief}
                    nodeId={card.nodeId}
                    surface="feed-practice"
                    autoBuild={false}
                    onRepaired={(original, repaired) => repairFeedVisual(card.key, original, repaired)}
                />
            </div>

            {card.materials && (
                <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                    <span className="font-medium">{t("You'll need:")}</span> <MathText content={card.materials} />
                </p>
            )}

            {/* Collapsed by default, and the prompt forbids answers inside a
                rubric point (AI_PROMPTS.paper_exercise rule 4b).
                Both matter, and the prompt is the real fix: a model left to its
                own devices writes "correctly calculates 0.277°" as a criterion,
                which hands over the answer to an exercise the learner has not
                started. Withholding reference_solution is pointless if the
                marking scheme restates it. Native <details> so the disclosure is
                keyboard- and screen-reader-correct for free. */}
            {phase !== 'result' && (
                <details className="mt-4 group rounded-xl bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700">
                    <summary className="flex items-center gap-1.5 p-3 cursor-pointer list-none text-xs font-semibold text-slate-700 dark:text-slate-200 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                        <ChevronRight className="w-3.5 h-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
                        {t("What you'll be marked on")}
                        <span className="font-normal text-slate-500 dark:text-slate-400">
                            {t("({{length}} points)", { length: card.rubric.length })}
                        </span>
                    </summary>
                    <ul className="px-3 pb-3 space-y-1.5">
                        {card.rubric.map(point => (
                            <li key={point.id} className="flex gap-2 text-sm text-slate-600 dark:text-slate-300">
                                <span className="text-slate-500 dark:text-slate-400 shrink-0">•</span>
                                <span><MathText content={point.point} />{point.weight > 1 && <span className="text-slate-500 dark:text-slate-400"> {t("({{weight}} marks)", { weight: point.weight })}</span>}</span>
                            </li>
                        ))}
                    </ul>
                </details>
            )}

            {problem && (
                <div className="mt-4 flex gap-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 p-3">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-900 dark:text-amber-200">{problem}</p>
                </div>
            )}

            {/* --- Phase: brief ------------------------------------------------ */}
            {phase === 'brief' && !done && (
                <div className="mt-4 flex flex-wrap gap-2">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={onFilePicked}
                        className="hidden"
                        aria-hidden="true"
                        tabIndex={-1}
                    />
                    {visionAvailable !== false && (
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={busy || visionAvailable === null}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
                        >
                            {busy || visionAvailable === null
                                ? <Loader2 className="w-4 h-4 animate-spin" />
                                : <Camera className="w-4 h-4" />}
                            {t("Photograph my work")}
                        </button>
                    )}
                    <button
                        onClick={openSelfMark}
                        disabled={busy}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 disabled:opacity-50"
                    >
                        <Eye className="w-4 h-4" />
                        {visionAvailable === false ? t("Show solution & mark it myself") : t("Mark it myself")}
                    </button>
                </div>
            )}

            {visionAvailable === false && phase === 'brief' && (
                <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                    {t("No vision model is configured, so photos can't be marked automatically. Set one under Settings → AI & Models to turn this on.")}
                </p>
            )}

            {/* --- Phase: adjust corners --------------------------------------- */}
            {phase === 'adjust' && source && quad && (
                <div className="mt-4">
                    <p className="text-sm text-slate-600 dark:text-slate-300 mb-2">
                        {t("Drag the four corners onto the corners of your page.")}
                    </p>
                    <div
                        ref={previewRef}
                        className="relative touch-none select-none"
                        onPointerMove={onHandleMove}
                        onPointerUp={onHandleUp}
                        onPointerCancel={onHandleUp}
                    >
                        <div ref={canvasHostRef} />
                        <svg
                            className="absolute inset-0 w-full h-full pointer-events-none"
                            viewBox={`0 0 ${source.width} ${source.height}`}
                            preserveAspectRatio="none"
                            aria-hidden="true"
                        >
                            <polygon
                                points={quad.map(p => `${p.x},${p.y}`).join(' ')}
                                fill="rgb(var(--accent-rgb) / 0.15)"
                                stroke="rgb(var(--accent-rgb))"
                                strokeWidth={Math.max(2, source.width / 300)}
                            />
                        </svg>
                        {quad.map((point, index) => (
                            <button
                                key={index}
                                onPointerDown={onHandleDown(index)}
                                onKeyDown={onHandleKey(index)}
                                aria-label={t("Corner {{n}} — drag or use arrow keys", { n: index + 1 })}
                                // White in BOTH themes on purpose: this handle sits on top of
                                // the learner's photo, not on an app surface, and a photo of a
                                // page is bright regardless of what theme the app is in.
                                className="absolute w-8 h-8 -ml-4 -mt-4 rounded-full bg-white dark:bg-white border-2 border-accent shadow-md touch-none focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1"
                                style={{
                                    left: `${(point.x / source.width) * 100}%`,
                                    top: `${(point.y / source.height) * 100}%`,
                                }}
                            />
                        ))}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                        <button
                            onClick={submitScan}
                            disabled={busy}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
                        >
                            <ScanLine className="w-4 h-4" />
                            {t("Scan & submit")}
                        </button>
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={busy}
                            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50"
                        >
                            <RefreshCw className="w-4 h-4" /> {t("Retake")}
                        </button>
                        <button
                            onClick={() => { setPhase('brief'); setSource(null); setQuad(null); }}
                            className="px-3 py-2 rounded-lg text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                        >
                            {t("Cancel")}
                        </button>
                    </div>
                </div>
            )}

            {/* --- Phase: grading --------------------------------------------- */}
            {phase === 'grading' && (
                <div className="mt-4 flex items-center gap-3 text-sm text-slate-600 dark:text-slate-300">
                    <Loader2 className="w-4 h-4 animate-spin text-accent-fg" />
                    <span>{t("Reading your working, then marking it — this takes a moment.")}</span>
                </div>
            )}

            {/* --- Phase: self-mark ------------------------------------------- */}
            {phase === 'selfmark' && (
                <div className="mt-4">
                    <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 bg-slate-50 dark:bg-slate-900/40">
                        <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 mb-2">{t("Worked solution")}</p>
                        <div className="prose prose-slate dark:prose-invert max-w-none prose-sm">
                            {/* Fetched on demand, never cached in the card, so a
                                repair here has no row to persist into — surface
                                and node are carried for a feedback report only. */}
                            <Markdown content={solution || ''} nodeId={card.nodeId} surface="paper-solution" autoBuild={false} />
                        </div>
                    </div>
                    <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                        {t("Tick each point your paper actually shows. Be honest — this only tunes what the app teaches you next.")}
                    </p>
                    <ul className="mt-2 space-y-1.5">
                        {card.rubric.map(point => {
                            const ticked = selfMarked.has(point.id);
                            return (
                                <li key={point.id}>
                                    <button
                                        onClick={() => toggleSelfPoint(point.id)}
                                        aria-pressed={ticked}
                                        className="w-full flex items-start gap-2 text-left p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700/40"
                                    >
                                        <span className={`mt-0.5 w-4 h-4 rounded border shrink-0 flex items-center justify-center ${ticked
                                            ? 'bg-accent border-accent'
                                            : 'border-slate-300 dark:border-slate-600'}`}>
                                            {ticked && <Check className="w-3 h-3 text-white" />}
                                        </span>
                                        <span className="text-xs text-slate-700 dark:text-slate-200"><MathText content={point.point} /></span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    <div className="mt-3 flex gap-2">
                        <button
                            onClick={submitSelfMark}
                            disabled={busy}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
                        >
                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                            {t("Record {{size}} of {{length}}", { size: selfMarked.size, length: card.rubric.length })}
                        </button>
                        <button
                            onClick={() => setPhase('brief')}
                            className="px-3 py-2 rounded-lg text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                        >
                            {t("Back")}
                        </button>
                    </div>
                </div>
            )}

            {/* --- Phase: result ---------------------------------------------- */}
            {phase === 'result' && grade && (
                <div className="mt-4">
                    <div className="flex items-baseline gap-2 mb-3">
                        <span className="text-2xl font-bold text-slate-900 dark:text-white">
                            {grade.score}<span className="text-slate-500 dark:text-slate-400">/{grade.total}</span>
                        </span>
                        <span className="text-sm text-slate-500 dark:text-slate-400">{t("on your paper")}</span>
                    </div>
                    <ul className="space-y-2">
                        {grade.results.map(result => (
                            <li key={result.id} className="flex gap-2">
                                {result.met
                                    ? <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" aria-label={t("Met")} />
                                    : <X className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" aria-label={t("Not met")} />}
                                <div className="min-w-0">
                                    <p className="text-xs font-medium text-slate-700 dark:text-slate-200"><MathText content={result.point} /></p>
                                    {result.comment && (
                                        <p className="text-sm text-slate-500 dark:text-slate-400"><MathText content={result.comment} /></p>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                    {grade.feedback && (
                        <div className="mt-3 prose prose-slate dark:prose-invert max-w-none prose-sm">
                            <Markdown content={grade.feedback} nodeId={card.nodeId} surface="paper-feedback" autoBuild={false} />
                        </div>
                    )}
                    {grade.nextAction && (
                        <p className="mt-3 text-xs text-slate-700 dark:text-slate-200">
                            <span className="font-medium">{t("Next:")}</span> <MathText content={grade.nextAction} />
                        </p>
                    )}
                </div>
            )}

            {phase === 'result' && !grade && (
                <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
                    {t("Recorded. Compare your working against the solution above — the gaps you found are what to practise next.")}
                </p>
            )}
        </div>
    );
}
