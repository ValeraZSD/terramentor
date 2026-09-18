import { useState, useCallback, useEffect, useRef } from 'react';
import {
    X, Upload, Loader2, AlertTriangle, Check, ArrowLeftRight, Undo2, ArrowRight, Layers,
    Image as ImageIcon, Volume2, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { api } from '../api';
import CardMedia from './CardMedia';
import Checkbox from './Checkbox';
import CardExtra from './CardExtra';
import CardText from './CardText';
import { useStore } from '../store';
import type { AnkiPreview, AnkiImportResult } from '../types';
import { useTranslation } from 'react-i18next';
import { useNumberFormat } from '../hooks/useNumberFormat';

/** Sizes a person can judge a download by. */
function formatBytes(n: number): string {
    if (!n) return '0 MB';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    const mb = n / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * Import an Anki deck.
 *
 * This screen is the first thing a lot of people will ever do in this app —
 * they arrive with a deck they have been building for years — so it is designed
 * around five rules, each one earned from how importers usually go wrong:
 *
 *  1. **Never ask a question before you can show its consequence.** The first
 *     screen has no options at all, just a dropzone. Every decision appears
 *     only once there is a preview to judge it against. An importer that opens
 *     with a field-mapping matrix is asking people to predict an outcome they
 *     have not been shown.
 *
 *  2. **Samples, not settings.** Field picking is a guess — by name where the
 *     deck's author named its fields usefully, by position where they did not
 *     (see server/ankiFields.js) — and the mistake it can make is a reversed
 *     front/back. No amount of explaining catches that; one real card catches
 *     it instantly. So the preview shows an actual card — labelled Question and
 *     Answer, complete with the picture, the clips and the supporting lines —
 *     and "Swap front/back" flips it *live*, change and consequence in the same
 *     glance, which is what makes one toggle enough where a mapping table would
 *     not be. The other samples are a step away rather than stacked underneath:
 *     three of them, each carrying a sentence, two clips and a picture, pushed
 *     the actual decisions a page and a half below the fold and proved nothing
 *     the first had not.
 *
 *  3. **Every dropped card is visible with a reason.** Not "1,400 of 2,000
 *     imported" — a count with causes, on screen without clicking. A silent
 *     partial import is the worst outcome here, because it is discovered months
 *     later when the card you meant to study never came up.
 *
 *  4. **Undo in one click, and say so up front.** Import always creates a NEW
 *     project, so undo is a single delete that cascades. Without a visible undo,
 *     trying the importer is a risk, and then nobody tries it.
 *
 *  5. **The button says what will happen.** "Import 2,847 cards", never
 *     "Continue" — the number is the whole commitment being made.
 *
 * The other thing this screen does is tell people how to get an .apkg at all
 * (File → Export → Anki Deck Package). That sentence removes more friction than
 * any feature here: most people have never exported one.
 */
export default function AnkiImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const [phase, setPhase] = useState<'drop' | 'reading' | 'preview' | 'done'>('drop');
    const [preview, setPreview] = useState<AnkiPreview | null>(null);
    const [result, setResult] = useState<AnkiImportResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState(0);
    const [dragging, setDragging] = useState(false);
    const [busy, setBusy] = useState(false);

    // The decisions, all of which have sensible defaults.
    const [projectName, setProjectName] = useState('');
    const [swap, setSwap] = useState(false);
    const [keepSchedule, setKeepSchedule] = useState(true);
    const [includeMedia, setIncludeMedia] = useState(true);
    // Which sample card is on screen. ONE at a time: three stacked samples —
    // each with a sentence, two clips and a picture — pushed the actual
    // decisions a page and a half below the fold, and the second and third
    // proved nothing the first had not. Stepping through them is the same
    // check at a tenth of the height.
    const [sample, setSample] = useState(0);

    const fileRef = useRef<HTMLInputElement>(null);
    const addToast = useStore(s => s.addToast);
    const consumePendingFile = useStore(s => s.consumeAnkiImportFile);
    const loadProjects = useStore(s => s.loadProjects);
    const openProject = useStore(s => s.openProject);

    const reset = useCallback(() => {
        setPhase('drop'); setPreview(null); setResult(null); setError(null);
        setProgress(0); setProjectName(''); setSwap(false); setKeepSchedule(true);
        setIncludeMedia(true); setSample(0);
    }, []);

    const close = useCallback(() => {
        // Release the staged parse rather than leaving it to time out.
        if (preview && phase === 'preview') api.cancelAnkiImport(preview.stagingId).catch(() => { });
        reset();
        onClose();
    }, [preview, phase, reset, onClose]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, close]);

    // A deck dropped on the create-project dropzone opens this already holding
    // the file: someone who has a deck goes to "new project" first, and being
    // sent back to find a second dropzone is a step that teaches nothing. The
    // file is consumed (not just read), so re-opening the importer by hand
    // later never re-parses it.
    useEffect(() => {
        if (!open) return;
        const pending = consumePendingFile();
        if (pending) handleFile(pending);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    async function handleFile(file: File) {
        if (!file) return;
        if (!/\.(apkg|colpkg)$/i.test(file.name)) {
            setError('That is not an Anki deck. Look for a file ending in .apkg.');
            return;
        }
        setError(null); setPhase('reading'); setProgress(0);
        try {
            const p = await api.inspectAnkiDeck(file, setProgress);
            setPreview(p);
            setSample(0);
            setProjectName(p.suggestedName);
            setPhase('preview');
        } catch (err: any) {
            setError(err.message || 'That deck could not be read.');
            setPhase('drop');
        }
    }

    async function commit() {
        if (!preview) return;
        setBusy(true);
        try {
            const res = await api.commitAnkiImport({
                stagingId: preview.stagingId,
                projectName: projectName.trim() || preview.suggestedName,
                swapFrontBack: swap,
                keepSchedule,
                includeMedia,
            });
            setResult(res);
            setPhase('done');
            await loadProjects();
        } catch (err: any) {
            setError(err.message || 'The import could not be completed.');
        } finally {
            setBusy(false);
        }
    }

    async function undo() {
        if (!result) return;
        setBusy(true);
        try {
            await api.deleteProject(result.projectId);
            await loadProjects();
            addToast('success', t("Import undone — every card it added has been removed."));
            close();
        } catch (err: any) {
            setError(err.message || 'The import could not be undone.');
        } finally {
            setBusy(false);
        }
    }

    if (!open) return null;

    const stats = preview?.stats;
    // Samples flip with the toggle, so the decision and its consequence are in
    // the same glance. Media flips WITH its side — the commit does the same
    // (a picture belongs to the side it was written on, not to a position), and
    // a preview that showed otherwise would be showing a different import.
    const samples = (preview?.samples ?? []).map(s => (swap
        ? { ...s, front: s.back, back: s.front, media: { front: s.media.back, back: s.media.front } }
        : s));
    // Clamped rather than trusted: a second deck can have fewer samples than
    // the one before it, and an out-of-range index would render nothing at all
    // where the whole point of this screen is that something is visible.
    const shown = samples.length ? Math.min(sample, samples.length - 1) : 0;
    const mediaCount = stats?.mediaFiles ?? 0;

    return (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/60 backdrop-blur-sm p-0 sm:p-4"
            onClick={close}>
            <div
                className="w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white dark:bg-slate-800 shadow-xl"
                onClick={e => e.stopPropagation()}
                role="dialog" aria-modal="true" aria-label={t("Import an Anki deck")}
            >
                <header className="flex items-start gap-3 p-5 border-b border-slate-200 dark:border-slate-700">
                    <span className="mt-0.5 shrink-0 w-9 h-9 rounded-lg bg-accent/10 text-accent-fg flex items-center justify-center">
                        <Layers size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h2 className="font-semibold text-slate-900 dark:text-slate-100">{t("Import an Anki deck")}</h2>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                            {t("Your cards, plus everything this app adds on top.")}
                        </p>
                    </div>
                    <button onClick={close} aria-label={t("Close")}
                        className="shrink-0 p-2 -m-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700">
                        <X size={18} />
                    </button>
                </header>

                {error && (
                    <div className="mx-5 mt-4 flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3 text-sm text-amber-900 dark:text-amber-200">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {/* ---- 1. drop: no options at all ---- */}
                {phase === 'drop' && (
                    <div className="p-5">
                        <div
                            onDragOver={e => { e.preventDefault(); setDragging(true); }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={e => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); }}
                            onClick={() => fileRef.current?.click()}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
                            role="button" tabIndex={0}
                            className={`rounded-xl border-2 border-dashed p-10 text-center cursor-pointer transition
                                ${dragging
                                    ? 'border-accent bg-accent/5'
                                    : 'border-slate-300 dark:border-slate-600 hover:border-accent can-hover:hover:bg-accent/5'}`}
                        >
                            <Upload className="w-8 h-8 mx-auto text-slate-400 dark:text-slate-500 mb-3" />
                            <p className="font-medium text-slate-900 dark:text-slate-100">{t("Drop your .apkg here")}</p>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{t("or choose a file")}</p>
                        </div>
                        <input ref={fileRef} type="file" accept=".apkg,.colpkg" className="hidden"
                            onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
                        {/* The single highest-value sentence on this screen: most
                            people have never exported a deck and would stop here. */}
                        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                            {t("In Anki:")}{' '}<span className="font-medium text-slate-700 dark:text-slate-300">{t("File → Export → Anki Deck Package (.apkg)")}</span>{t(". Leave \"Include scheduling information\" ticked to keep your review history. Your pictures and audio come across too.")}
                        </p>
                    </div>
                )}

                {/* ---- 2. reading ---- */}
                {phase === 'reading' && (
                    <div className="p-10 flex flex-col items-center gap-3 text-center">
                        <Loader2 size={28} className="animate-spin text-accent" />
                        <p className="text-sm text-slate-600 dark:text-slate-300">
                            {progress < 100 ? t("Uploading… {{progress}}%", { progress }) : t("Reading your deck…")}
                        </p>
                        <div className="w-full max-w-xs h-1 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
                            <div className="h-full bg-accent transition-all" style={{ width: `${Math.max(4, progress)}%` }} />
                        </div>
                        <p className="text-sm text-slate-500 dark:text-slate-400">{t("Nothing is added to your library yet.")}</p>
                    </div>
                )}

                {/* ---- 3. preview: decide against something visible ---- */}
                {phase === 'preview' && preview && stats && (
                    <div className="p-5 space-y-5">
                        <p className="text-sm text-slate-700 dark:text-slate-200">
                            <span className="font-semibold text-slate-900 dark:text-white">{t("{{cards}} cards", { cards: num(stats.cards) })}</span>
                            {' '}{t("from {{count}} decks", { count: stats.decks.length })}.
                            {/* Links are not an option to tick — they are part of
                                the card, like its formatting. Saying so here is
                                the point: a deck whose answers are half Khan
                                Academy links is a deck whose value would be
                                halved by dropping them, and the previous
                                importer dropped every one. */}
                            {(stats.links ?? 0) > 0 && (
                                <> {t("{{value}} links come across — on the cards, and gathered under their topics.", { count: stats.links ?? 0, value: num(stats.links ?? 0) })}</>
                            )}
                        </p>

                        {/* The field-mapping check, done by looking rather than configuring. */}
                        <div>
                            <div className="flex items-center justify-between gap-3 mb-2">
                                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                    {t("How your cards will look")}
                                </h3>
                                {samples.length > 1 && (
                                    <div className="flex items-center gap-1">
                                        <button
                                            onClick={() => setSample(i => (i - 1 + samples.length) % samples.length)}
                                            aria-label={t("Previous example")}
                                            className="grid place-items-center min-h-[44px] min-w-[44px] rounded-lg text-slate-500 dark:text-slate-400 can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-700/60"
                                        >
                                            <ChevronLeft size={15} />
                                        </button>
                                        <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400 select-none">
                                            {shown + 1} / {samples.length}
                                        </span>
                                        <button
                                            onClick={() => setSample(i => (i + 1) % samples.length)}
                                            aria-label={t("Next example")}
                                            className="grid place-items-center min-h-[44px] min-w-[44px] rounded-lg text-slate-500 dark:text-slate-400 can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-700/60"
                                        >
                                            <ChevronRight size={15} />
                                        </button>
                                    </div>
                                )}
                            </div>
                            <div className="space-y-2">
                                {samples.slice(shown, shown + 1).map((s, i) => (
                                    <div key={i} data-testid="anki-sample"
                                        className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden text-sm bg-white dark:bg-slate-800">
                                        {/* Both sides are LABELLED. The swap
                                            toggle asks "are these the wrong way
                                            round?", which is not answerable while
                                            the only thing telling them apart is
                                            which one happens to be on top. */}
                                        <div className="px-3 pt-2.5 pb-2.5 text-slate-900 dark:text-slate-100 whitespace-pre-wrap break-words">
                                            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t("Question")}</span>
                                            {/* Rendered exactly as the imported card will
                                                render it — readings above their kanji, the
                                                target word marked. A preview that showed the
                                                raw `好[す]き` would be a preview of a
                                                different import. */}
                                            <CardText content={s.front} />
                                            {/* The real files, from the same URL the imported
                                                card will use — a preview of media you cannot
                                                see or hear is not a preview of it. */}
                                            {includeMedia && <CardMedia media={s.media.front} size="preview" className="mt-2" />}
                                        </div>
                                        <div className="px-3 pt-2.5 pb-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-words">
                                            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t("Answer")}</span>
                                            <CardText content={s.back} />
                                            {/* The reading / sentence / translation the deck's
                                                own template shows under the answer. Visible in
                                                the preview because it is the clearest evidence
                                                that the right field became the answer. */}
                                            <CardExtra text={s.extra} className="mt-1.5 text-xs" />
                                            {includeMedia && <CardMedia media={s.media.back} size="preview" className="mt-2" />}
                                        </div>
                                    </div>
                                ))}
                            </div>
                            {/* The swap control sits UNDER the card it changes,
                                next to the question it answers — at the top of
                                the block it was a setting to be configured
                                before there was anything to judge it against. */}
                            <div className="mt-2 flex items-center justify-between gap-3">
                                <p className="text-sm text-slate-500 dark:text-slate-400">
                                    {t("Wrong way round?")}
                                </p>
                                <button
                                    onClick={() => setSwap(v => !v)}
                                    aria-pressed={swap}
                                    className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-colors ${swap
                                        ? 'border-accent/50 bg-accent/10 text-accent-fg'
                                        : 'border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 can-hover:hover:bg-slate-50 dark:can-hover:hover:bg-slate-700/50'}`}
                                >
                                    <ArrowLeftRight size={13} />
                                    {swap ? t("Swapped") : t("Swap front/back")}
                                </button>
                            </div>
                        </div>

                        {/* What is coming — the deck tree becomes topics. */}
                        <details className="rounded-lg border border-slate-200 dark:border-slate-700">
                            <summary className="px-3 py-2 text-sm text-slate-700 dark:text-slate-200 cursor-pointer select-none">
                                {/* Say what the tree will actually look like.
                                    A big deck is cut into stages in its own
                                    order, which is a consequence worth showing
                                    BEFORE the commit — the same rule the rest of
                                    this screen follows. */}
                                {stats.decks.length === 1
                                    ? ((stats.decks[0]?.stages ?? 0) > 1 ? t("How this deck will be laid out") : t("1 deck becomes a topic"))
                                    : t("{{length}} decks become topics", { length: stats.decks.length })}
                            </summary>
                            <ul className="px-3 pb-3 space-y-1 max-h-40 overflow-y-auto">
                                {stats.decks.map(d => (
                                    <li key={d.name} className="flex justify-between gap-3 text-xs text-slate-600 dark:text-slate-400">
                                        <span className="truncate">{d.name.replace(/::/g, ' › ')}</span>
                                        <span className="shrink-0 tabular-nums">
                                            {d.count}
                                            {(d.stages ?? 0) > 1 && t("· {{stages}} sections", { count: d.stages ?? 0, stages: d.stages })}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </details>

                        {/* What is NOT coming — always visible, never behind a click. */}
                        {(stats.skipped > 0 || preview.warnings.length > 0) && (
                            <div className="rounded-lg bg-slate-50 dark:bg-slate-900/40 p-3 space-y-1.5">
                                {stats.skipped > 0 && (
                                    <p className="text-sm text-slate-600 dark:text-slate-300">
                                        <span className="font-medium">
                                            {stats.skipped === 1
                                                ? t("1 note will not become a card:")
                                                : t("{{skipped}} notes will not become cards:", { skipped: stats.skipped })}
                                        </span>{' '}
                                        {Object.entries(stats.skipReasons)
                                            .map(([reason, n]) => `${n} ${reason}`)
                                            .join(', ')}.
                                    </p>
                                )}
                                {preview.warnings.map((w, i) => (
                                    <p key={i} className="text-sm text-slate-500 dark:text-slate-400">{w}</p>
                                ))}
                            </div>
                        )}

                        {/* The only three settings. */}
                        <div className="space-y-2.5">
                            <label className="block">
                                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t("Project name")}</span>
                                <input
                                    value={projectName}
                                    onChange={e => setProjectName(e.target.value)}
                                    className="mt-1.5 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-accent/60 focus:border-transparent"
                                />
                            </label>
                            {mediaCount > 0 && (
                                <OptionRow
                                    checked={includeMedia}
                                    onChange={setIncludeMedia}
                                    title={t("Bring the pictures and audio")}
                                >
                                    <span className="inline-flex items-center gap-1 align-middle">
                                        {(stats.mediaImages ?? 0) > 0 && (
                                            <><ImageIcon size={12} aria-hidden="true" />{num((stats.mediaImages ?? 0))}</>
                                        )}
                                        {(stats.mediaSounds ?? 0) > 0 && (
                                            <><Volume2 size={12} aria-hidden="true" className="ml-1.5" />{num((stats.mediaSounds ?? 0))}</>
                                        )}
                                    </span>
                                    {t("· {{bytes}} kept on this machine.", { bytes: formatBytes(stats.mediaBytes ?? 0) })}
                                </OptionRow>
                            )}
                            <OptionRow
                                checked={keepSchedule}
                                onChange={setKeepSchedule}
                                title={t("Keep my Anki review schedule")}
                            >
                                {t("Cards keep the intervals they earned, so you carry on instead of starting over.")}
                            </OptionRow>
                        </div>

                        {/* Sticky, because the commit is the one control that
                            must never be somewhere else on the page: the deck
                            list, the skipped-notes block and the options all
                            grow with the deck, and on a phone that put the
                            button below the fold on exactly the decks that
                            took longest to read. */}
                        <div className="sticky bottom-0 -mx-5 -mb-5 mt-1 border-t border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-800/95 backdrop-blur px-5 py-4 space-y-2">
                            <div className="flex gap-2">
                                <button onClick={commit} disabled={busy}
                                    className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-white font-medium hover:opacity-90 disabled:opacity-50">
                                    {busy && <Loader2 size={15} className="animate-spin" />}
                                    {busy ? t("Importing…") : t("Import {{n}} cards", { count: stats.cards, n: num(stats.cards) })}
                                </button>
                                <button onClick={close} disabled={busy}
                                    className="rounded-lg px-4 py-3 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
                                    {t("Cancel")}
                                </button>
                            </div>
                            {/* Said BEFORE they commit, not after — that is what
                                makes pressing the button feel cheap. */}
                            <p className="text-sm text-slate-500 dark:text-slate-400 text-center">
                                {t("This creates a new project. You can undo it in one click.")}
                            </p>
                        </div>
                    </div>
                )}

                {/* ---- 4. done ---- */}
                {phase === 'done' && result && (
                    <div className="p-5 space-y-4">
                        <div className="flex items-start gap-3">
                            <span className="mt-0.5 w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 flex items-center justify-center shrink-0">
                                <Check size={18} />
                            </span>
                            <div>
                                <p className="font-medium text-slate-900 dark:text-slate-100">
                                    {t("{{imported}} cards imported into “{{name}}”.", { imported: num(result.imported), name: result.name })}
                                </p>
                                {result.skipped > 0 && (
                                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                                        {result.skipped === 1 ? t("1 note was") : t("{{skipped}} notes were", { skipped: result.skipped })} {t("left behind, as listed before the import.")}
                                    </p>
                                )}
                            </div>
                        </div>
                        <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                            {result.stages
                                ? <>{t("Cut into")}{' '}<span className="font-medium text-slate-700 dark:text-slate-200">{t("{{stages}} sections", { count: result.stages, stages: result.stages })}</span> {t("in the deck’s own order, so you can see where you are in it. Reviews are scheduled by FSRS, and")}{' '}{result.stages > 1 ? t("new cards arrive a few a day rather than all at once") : t("the rest of the app works on them from here")}.</>
                                : <>{t("Your decks are now topics. Reviews are scheduled by FSRS, and the rest of the app works on them from here.")}</>}
                        </p>
                        <div className="flex gap-2">
                            <button
                                onClick={() => { openProject(result.projectId); close(); }}
                                className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-white font-medium hover:opacity-90 inline-flex items-center justify-center gap-1.5"
                            >
                                {t("Open it")}{' '}<ArrowRight size={15} />
                            </button>
                            <button onClick={undo} disabled={busy}
                                className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2.5 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 inline-flex items-center gap-1.5">
                                <Undo2 size={15} /> {t("Undo")}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * One yes/no choice, as a row you press rather than a native checkbox.
 *
 * The native control is 13px, painted by the OS, and ignores everything this
 * app knows about its own surfaces — next to a card preview and an accent
 * button it reads as an unstyled form left over from somewhere else, and its
 * hit area is a tenth of the row of text explaining it. So: the real input is
 * kept (it is what makes the label, the keyboard and the screen reader work)
 * and moved off screen, the box beside it is drawn from the app's own accent,
 * and the whole row — title, description, box — is the target.
 *
 * `peer-focus-visible` is what keeps that honest: the focus ring has to move to
 * the thing that looks like the control, or a keyboard user sees nothing at all.
 */
function OptionRow({ checked, onChange, title, children }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    title: string;
    children: React.ReactNode;
}) {
    return (
        <label className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-colors ${checked
            ? 'border-accent/40 bg-accent/5'
            : 'border-slate-200 dark:border-slate-700 can-hover:hover:bg-slate-50 dark:can-hover:hover:bg-slate-700/40'}`}>
            <Checkbox checked={checked} onChange={onChange} className="mt-0.5" />
            <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">{title}</span>
                <span className="mt-0.5 block text-sm text-slate-500 dark:text-slate-400 leading-relaxed">{children}</span>
            </span>
        </label>
    );
}
