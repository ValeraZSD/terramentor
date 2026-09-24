import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Loader2, Sparkles, X } from 'lucide-react';
import { api } from '../../api';
import type { VisualPalette } from './registry';
import {
    captionFromBrief, DEFAULT_GIF_FPS, downloadBlob, exportAnimationGif, gifDelayCs, gifFrameCount, exportStillPng, fileSlug, findExportable,
    previewFrame, type CardText,
} from '../../utils/exportVisual';
import { animationLoopSeconds } from './svgLabelFit';
import { useTranslation } from 'react-i18next';
import { k } from '../../i18n';

/**
 * "Save" on a visual: the drawing as a file — a GIF for an animation, a PNG
 * for anything still — either bare or framed as a card with a title and a
 * caption, so it can leave the app with enough context to be understood.
 *
 * The words are the learner's to edit; the AI only DRAFTS them (and for a
 * brief-backed animation the draft is free: the brief's own "Shows:" and
 * "Notice:" lines are exactly a title and a caption). A dialog rather than
 * a one-click download because the two choices — with or without the card,
 * and what it says — change what is being saved, and a file is the wrong
 * place to discover a wrong choice.
 *
 * Portalled to <body>: a visual lives inside feed cards and the assistant
 * drawer, and a `position: fixed` dialog inside a transformed or
 * backdrop-filtered ancestor is positioned against THAT ancestor, not the
 * viewport (see the TodayActivityModal note in docs/ARCHITECTURE.md).
 */

interface Props {
    open: boolean;
    onClose: () => void;
    kind: string;
    /** The block's own source — a brief, an SVG, a spec — for the caption draft. */
    code: string;
    /** The renderer's stage, holding the live <svg>/<canvas>. */
    stage: HTMLElement | null;
    palette: VisualPalette;
}

const WIDTHS = [
    { label: k("Small"), px: 480 },
    { label: k("Medium"), px: 640 },
    { label: k("Large"), px: 800 },
];

export default function ExportVisualModal({ open, onClose, kind, code, stage, palette }: Props) {
    const { t: tr } = useTranslation();
    const target = useMemo(() => (open ? findExportable(stage) : null), [open, stage]);
    const animated = !!(target instanceof SVGSVGElement && target.querySelector('animate, animateTransform, animateMotion, set'));
    const loopSeconds = useMemo(() => (animated && target instanceof SVGSVGElement ? animationLoopSeconds(target) : 0), [animated, target]);

    const [framed, setFramed] = useState(false);
    const [text, setText] = useState<CardText>({ title: '', caption: '' });
    const [width, setWidth] = useState(640);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<[number, number] | null>(null);
    const [drafting, setDrafting] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const previewRef = useRef<HTMLCanvasElement>(null);
    const abortRef = useRef<AbortController | null>(null);

    // Reset per opening, and seed the words from the brief when there is one.
    useEffect(() => {
        if (!open) return;
        const seeded = captionFromBrief(code);
        setText(seeded ?? { title: '', caption: '' });
        setFramed(false);
        setNote(null);
        setProgress(null);
    }, [open, code]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [open, onClose]);

    // A live preview of the first frame, so the card is seen before it is saved.
    useEffect(() => {
        if (!open || !target) return;
        let cancelled = false;
        (async () => {
            const canvas = previewRef.current;
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            const pw = 320;
            let img: CanvasImageSource, w: number, h: number;
            if (target instanceof SVGSVGElement) {
                ({ img, w, h } = await previewFrame(target, pw, animated ? Math.min(0.75, loopSeconds / 4) : 0));
            } else {
                img = target; w = pw; h = Math.round((pw * target.height) / Math.max(1, target.width));
            }
            if (cancelled) return;
            canvas.width = w; canvas.height = h;
            ctx.fillStyle = palette.bg;
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
        })().catch(() => { /* the preview is decorative */ });
        return () => { cancelled = true; };
    }, [open, target, animated, loopSeconds, palette.bg]);

    useEffect(() => () => abortRef.current?.abort(), []);

    if (!open) return null;

    const exportPalette = { bg: palette.bg, fg: palette.fg, muted: palette.muted, border: palette.border };
    const card: CardText | null = framed ? { title: text.title.trim(), caption: text.caption.trim() } : null;
    const frames = animated ? gifFrameCount(loopSeconds) : 0;
    const fpsShown = Math.round(100 / gifDelayCs(DEFAULT_GIF_FPS));

    const draft = async () => {
        setDrafting(true);
        setNote(null);
        try {
            const res = await api.captionVisual(kind, code);
            setText({ title: res.title || text.title, caption: res.caption || text.caption });
        } catch (e) {
            setNote(e instanceof Error ? e.message : tr("The AI could not draft a caption."));
        } finally {
            setDrafting(false);
        }
    };

    const save = async () => {
        if (!target || busy) return;
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setNote(null);
        try {
            const base = fileSlug(card?.title || '', animated ? 'animation' : kind);
            if (animated && target instanceof SVGSVGElement) {
                setProgress([0, frames]);
                const blob = await exportAnimationGif(target, {
                    width, card, palette: exportPalette, fps: DEFAULT_GIF_FPS, seconds: loopSeconds,
                    onProgress: (d, t) => setProgress([d, t]),
                    signal: controller.signal,
                });
                downloadBlob(blob, `${base}.gif`);
                setNote(`Saved ${base}.gif (${Math.round(blob.size / 1024)} KB, ${frames} frames).`);
            } else {
                const blob = await exportStillPng(target, { width, card, palette: exportPalette });
                downloadBlob(blob, `${base}.png`);
                setNote(`Saved ${base}.png.`);
            }
        } catch (e) {
            if (!controller.signal.aborted) setNote(e instanceof Error ? e.message : tr("The file could not be made."));
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setBusy(false);
            setProgress(null);
        }
    };

    const cancel = () => {
        if (busy) { abortRef.current?.abort(); return; }
        onClose();
    };

    const field = 'w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-accent/60';

    return createPortal(
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="export-visual-title">
            <div className="absolute inset-0 bg-black/50" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }} aria-hidden="true" />
            <div className="relative w-full max-w-lg max-h-[90vh] overflow-auto rounded-2xl bg-white dark:bg-slate-800 shadow-xl">
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-700">
                    <h2 id="export-visual-title" className="text-base font-semibold text-slate-900 dark:text-white">
                        {animated ? tr("Save as GIF") : tr("Save as image")}
                    </h2>
                    <button type="button" onClick={cancel} aria-label={tr("Close")} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700">
                        <X className="w-5 h-5 text-slate-400" />
                    </button>
                </div>

                <div className="px-5 py-4 space-y-4">
                    {!target && (
                        <p className="text-sm text-slate-600 dark:text-slate-300">{tr("Nothing here can be saved as a picture yet — wait for the drawing to finish rendering.")}</p>
                    )}

                    {target && (
                        <>
                            <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-2 flex justify-center bg-slate-50 dark:bg-slate-900/40">
                                <canvas ref={previewRef} className="max-w-full h-auto rounded" aria-label={tr("Preview of the picture")} />
                            </div>

                            <fieldset className="space-y-2">
                                <legend className="sr-only">{tr("What to save")}</legend>
                                <label className="flex items-start gap-2 text-sm text-slate-800 dark:text-slate-200 cursor-pointer">
                                    <input type="radio" name="export-frame" className="mt-1 accent-accent" checked={!framed} onChange={() => setFramed(false)} />
                                    <span><span className="font-medium">{tr("Just the picture")}</span><span className="block text-sm text-slate-500 dark:text-slate-400">{tr("The drawing alone, on the page colour.")}</span></span>
                                </label>
                                <label className="flex items-start gap-2 text-sm text-slate-800 dark:text-slate-200 cursor-pointer">
                                    <input type="radio" name="export-frame" className="mt-1 accent-accent" checked={framed} onChange={() => setFramed(true)} />
                                    <span><span className="font-medium">{tr("With a title and caption")}</span><span className="block text-sm text-slate-500 dark:text-slate-400">{tr("A card that says what it shows and what to notice — readable on its own.")}</span></span>
                                </label>
                            </fieldset>

                            {framed && (
                                <div className="space-y-2">
                                    <input
                                        className={field}
                                        placeholder={tr("Title")}
                                        value={text.title}
                                        maxLength={80}
                                        onChange={e => setText(t => ({ ...t, title: e.target.value }))}
                                    />
                                    <textarea
                                        className={`${field} min-h-[72px] resize-y`}
                                        placeholder={tr("What to notice, in one or two sentences")}
                                        value={text.caption}
                                        maxLength={400}
                                        onChange={e => setText(t => ({ ...t, caption: e.target.value }))}
                                    />
                                    <button
                                        type="button"
                                        onClick={draft}
                                        disabled={drafting || busy}
                                        className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-fg hover:underline disabled:opacity-50"
                                        title={tr("Ask the AI to draft a title and caption from the drawing")}
                                    >
                                        {drafting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                                        {drafting ? tr("Drafting…") : tr("Draft with AI")}
                                    </button>
                                </div>
                            )}

                            <div className="flex flex-wrap items-center gap-3 text-sm">
                                <label className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                                    {tr("Size")}
                                    <select className={`${field} w-auto py-1`} value={width} onChange={e => setWidth(Number(e.target.value))}>
                                        {WIDTHS.map(w => <option key={w.px} value={w.px}>{tr("{{label}} · {{px}}px", { label: tr(w.label), px: w.px })}</option>)}
                                    </select>
                                </label>
                                {animated && (
                                    <span className="text-sm text-slate-500 dark:text-slate-400">
                                        {tr("One loop, {{loopSeconds}} s at {{fps}} fps · {{frames}} frames", { count: frames, loopSeconds: loopSeconds.toFixed(loopSeconds % 1 ? 1 : 0), fps: fpsShown, frames })}
                                    </span>
                                )}
                            </div>
                        </>
                    )}

                    {progress && (
                        <div className="space-y-1" aria-live="polite">
                            <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                                <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round((100 * progress[0]) / Math.max(1, progress[1]))}%` }} />
                            </div>
                            <p className="text-sm text-slate-500 dark:text-slate-400">{tr("Encoding frame {{value}} of {{value2}}…", { value: progress[0], value2: progress[1] })}</p>
                        </div>
                    )}
                    {note && <p className="text-sm text-slate-700 dark:text-slate-300" aria-live="polite">{note}</p>}
                </div>

                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-700">
                    <button type="button" onClick={cancel} className="px-3 py-2 text-sm rounded-lg text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                        {busy ? tr("Stop") : tr("Close")}
                    </button>
                    <button
                        type="button"
                        onClick={save}
                        disabled={!target || busy}
                        className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
                    >
                        {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                        {animated ? tr("Save GIF") : tr("Save PNG")}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
