import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, X, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore, themeKeyOf } from '../../store';
import { useTapGuard } from '../../hooks/useTapGuard';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { uiLocale } from '../../utils/locale';
import { accentSolidTriplet } from '../../utils/color';
import { useAccentVars } from '../../hooks/useAccentVars';
import { readVisualPalette, parseColor, rgbToHex, ensureContrast, readableOn } from '../visuals/palette';
import { downloadBlob, fileSlug } from '../../utils/exportVisual';
import { Button, IconButton } from '../ui/Button';
import { getIconEmoji } from '../IconPicker';
import { renderCertificate } from './certificate';
import {
    completionStats, completionStory, completionCaption, completionFootnote, completionEyebrow,
    type SummaryText,
} from './summary';

/**
 * The screen a course only ever shows once.
 *
 * Everything else in this app is built to be come back to. This is not: it
 * appears the moment the last unit of work is done, and after it is dismissed
 * the project is filed and the screen is gone. That shapes three decisions.
 *
 * **It is one view, not a page.** Everything worth knowing is above the actions
 * on a 390px phone, because the thing people do with a screen like this is
 * photograph it, and a screenshot of half a summary is not worth keeping.
 *
 * **It can be saved properly.** The download in the corner paints a real
 * poster (`certificate.ts`) rather than the DOM — a screenshot catches the
 * browser chrome and whatever the scroll position happened to be.
 *
 * **It never claims more than happened.** Tiles are built from what exists, so
 * a project with no cards has no card tile rather than a tile reading zero, and
 * topics closed as "skipped" are named in a footnote instead of being folded
 * into the headline count. See `summary.ts`, which picks all of it once so the
 * screen and the poster cannot drift apart.
 */
export default function CompletionSummary() {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const data = useStore(s => s.completion);
    const closeCompletion = useStore(s => s.closeCompletion);
    const updateProject = useStore(s => s.updateProject);
    const addToast = useStore(s => s.addToast);
    const themeKey = useStore(s => themeKeyOf(s.theme, s.themeTint));

    const [saving, setSaving] = useState(false);
    const [filing, setFiling] = useState(false);
    const primaryRef = useRef<HTMLButtonElement>(null);
    const backdrop = useTapGuard(() => closeCompletion(), true);

    useEffect(() => {
        if (!data) return;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = ''; };
    }, [!!data]);

    useEffect(() => {
        if (!data) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeCompletion(); };
        document.addEventListener('keydown', onKey);
        // Land on the action rather than on the dialog: this screen has exactly
        // one thing to decide, and a keyboard reader should not have to walk the
        // statistics to reach it.
        primaryRef.current?.focus();
        return () => document.removeEventListener('keydown', onKey);
    }, [!!data, closeCompletion]);

    const text: SummaryText = useMemo(() => ({
        t: (key, vars) => String(t(key, vars as never)),
        num,
        date: (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString(uiLocale(), {
            day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
        }),
        shortDate: (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString(uiLocale(), {
            day: 'numeric', month: 'short', timeZone: 'UTC',
        }),
    }), [t, num]);

    // The card is themed to the PROJECT's colour, not the app's: this is the one
    // screen that is about a single project, and it is the picture that gets
    // kept. Carried across the portal by hand — a portalled subtree inherits
    // nothing from where it was written. Called ABOVE the early return: it is
    // a hook (two store subscriptions), and this component is mounted with no
    // data almost all the time, so below the return the render that opened the
    // screen called two more hooks than the one before it and React threw.
    const accentStyle = useAccentVars(data?.project.color) as React.CSSProperties;

    if (!data) return null;

    const { project, timeline, span } = data;
    const emoji = getIconEmoji(project.icon);
    const stats = completionStats(data, text);
    const story = completionStory(data, text);
    const caption = completionCaption(data, text);
    const footnote = completionFootnote(data, text);
    const eyebrow = completionEyebrow(data, text);
    const finishedOn = span ? text.date(span.lastDay) : '';
    const alreadyFiled = project.status !== 'active';

    const save = async () => {
        setSaving(true);
        try {
            // The poster's palette is the theme's (so it matches what is on
            // screen) with the project's own accent swapped in — through the
            // same contrast clamp every visual uses, or a pale yellow project
            // paints invisible bars on white.
            const base = readVisualPalette(themeKey);
            const bgRgb = parseColor(base.bg) ?? { r: 1, g: 1, b: 1 };
            const accentRgb = parseColor(accentSolidTriplet(project.color));
            const accent = accentRgb ? rgbToHex(ensureContrast(accentRgb, bgRgb)) : base.accent;
            const blob = await renderCertificate({
                emoji,
                eyebrow,
                title: project.name,
                subtitle: finishedOn,
                stats: stats.map(s => ({ value: s.value, label: s.label })),
                story: [story, footnote].filter(Boolean).join(' '),
                caption,
                chart: timeline
                    ? {
                        buckets: timeline.buckets.map(b => b.count),
                        startLabel: text.shortDate(timeline.buckets[0].start),
                        endLabel: span ? text.shortDate(span.lastDay) : '',
                    }
                    : null,
            }, {
                bg: base.bg,
                fg: base.fg,
                muted: base.muted,
                border: base.border,
                accent,
                // The ink that reads ON the accent, which is NOT `accent-fg`:
                // that token is the accent AS TEXT ON THE PAGE, and on the light
                // theme it is the accent itself, so ink set from it can land on
                // a fill the same colour as itself. `readableOn` picks
                // near-black or white by measured contrast, the same way every
                // filled label in the app does.
                accentFg: readableOn(accent),
            });
            downloadBlob(blob, `${fileSlug(project.name, 'course')}-complete.png`);
        } catch (e: unknown) {
            addToast('error', t("Could not save the picture"), (e as Error)?.message);
        } finally {
            setSaving(false);
        }
    };

    const fileAsCompleted = async () => {
        setFiling(true);
        await updateProject(project.id, { status: 'completed' });
        setFiling(false);
        closeCompletion();
    };

    return createPortal((
        <div className="fixed inset-0 z-[70] flex items-stretch justify-center sm:items-center sm:p-4" style={accentStyle}>
            <div className="absolute inset-0 bg-slate-900/60" {...backdrop} aria-hidden="true" />
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t("{{name}} is finished", { name: project.name })}
                className="relative flex w-full flex-col overflow-hidden bg-white shadow-2xl dark:bg-slate-900 sm:max-h-[94vh] sm:max-w-md sm:rounded-3xl"
            >
                <div className="h-1.5 shrink-0 bg-accent" />

                <div className="absolute right-2 top-4 z-10 flex gap-0.5">
                    <IconButton
                        label={t("Save this as a picture")}
                        icon={<Download className="h-5 w-5" />}
                        busy={saving}
                        onClick={save}
                    />
                    <IconButton
                        label={t("Close")}
                        icon={<X className="h-5 w-5" />}
                        onClick={() => closeCompletion()}
                    />
                </div>

                <Confetti />

                <div className="flex-1 overflow-y-auto px-5 pb-4 pt-6 text-center">
                    {/* Centred when it fits, scrolled when it does not. A deck
                        finished in three days has half the content a four-month
                        course does, and a full-bleed phone card pinned to the top
                        left 300px of blank between the sentence and the buttons —
                        which reads as something that failed to load. */}
                    <div className="flex min-h-full flex-col justify-center">
                    <Crest emoji={emoji} />

                    <p className="mt-3.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                        {eyebrow}
                    </p>
                    <h2 className="mt-1.5 text-2xl font-semibold leading-tight text-slate-900 dark:text-white">
                        {project.name}
                    </h2>
                    {finishedOn && (
                        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{finishedOn}</p>
                    )}

                    {stats.length > 0 && (
                        <div className="mt-5 grid grid-cols-2 gap-x-3 gap-y-4 border-t border-slate-100 pt-5 dark:border-slate-800">
                            {stats.map((stat, i) => (
                                <div
                                    key={stat.key}
                                    // An odd last tile takes the whole row and centres, rather
                                    // than sitting alone against the left margin looking
                                    // like a tile whose neighbour failed to load.
                                    className={i === stats.length - 1 && stats.length % 2 === 1 ? 'col-span-2' : ''}
                                >
                                    <p className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">{stat.value}</p>
                                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{stat.label}</p>
                                </div>
                            ))}
                        </div>
                    )}

                    {timeline && span && (
                        <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
                            <ActivityBars
                                buckets={timeline.buckets}
                                bucketDays={timeline.days}
                                label={(start, done) => t("{{date}}: {{done}} things done", { count: done,
                                    date: text.shortDate(start), done: num(done),
                                })}
                            />
                            <div className="mt-1.5 flex justify-between text-[11px] text-slate-500 dark:text-slate-400">
                                <span>{text.shortDate(span.firstDay)}</span>
                                <span>{text.shortDate(span.lastDay)}</span>
                            </div>
                        </div>
                    )}

                    {caption && (
                        <p className="mt-2.5 text-xs text-slate-500 dark:text-slate-400">{caption}</p>
                    )}
                    {story && (
                        <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{story}</p>
                    )}
                    {footnote && (
                        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{footnote}</p>
                    )}
                    </div>
                </div>

                <div className="shrink-0 space-y-1.5 border-t border-slate-200 bg-white px-5 py-3 dark:border-slate-700 dark:bg-slate-900">
                    {alreadyFiled ? (
                        <Button ref={primaryRef} variant="primary" size="lg" block onClick={() => closeCompletion()}>
                            {t("Done")}
                        </Button>
                    ) : (
                        <>
                            <Button
                                ref={primaryRef}
                                variant="primary"
                                size="lg"
                                block
                                busy={filing}
                                icon={<Check className="h-4 w-4" />}
                                onClick={fileAsCompleted}
                            >
                                {t("Move it to Completed")}
                            </Button>
                            {/* Not "Cancel": nothing is being undone. The project stays
                                where it is and the summary stops asking. */}
                            <Button variant="quiet" size="md" block onClick={() => closeCompletion()}>
                                {t("Keep it in Active")}
                            </Button>
                        </>
                    )}
                </div>
            </div>
        </div>
    ), document.body);
}

/** How long the paper falls for. After this the pieces leave the DOM entirely:
 *  an animation nobody can see is still an animation the compositor is running,
 *  and this dialog can sit open for as long as someone wants to look at it. */
const CONFETTI_MS = 2600;
const PIECES = 18;

/**
 * A short fall of paper, and then nothing.
 *
 * The argument against confetti is that it is a decoration pretending to be
 * information. The argument for it, here only, is that this screen exists to
 * mark an occasion — and an occasion with no signal is a dialog. It is brief,
 * it is behind the content rather than over it, it is the project's own colour
 * rather than a party palette, and `prefers-reduced-motion` removes it outright
 * (the CSS rule, so the pieces never start rather than stopping mid-fall).
 */
function Confetti() {
    const [falling, setFalling] = useState(true);
    useEffect(() => {
        const timer = setTimeout(() => setFalling(false), CONFETTI_MS);
        return () => clearTimeout(timer);
    }, []);
    if (!falling) return null;
    return (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-60 overflow-hidden" aria-hidden="true">
            {Array.from({ length: PIECES }, (_, i) => {
                // Deterministic rather than random: the same screen photographed
                // twice should be the same screen, and a seeded spread is easier
                // to look at than a lucky one.
                const left = ((i * 37) % 100) + (i % 3);
                const delay = (i % 6) * 0.12;
                const duration = 1.5 + ((i * 7) % 9) / 10;
                const wide = i % 3 === 0;
                return (
                    <span
                        key={i}
                        className={`animate-confetti-fall absolute top-0 block rounded-[1px] ${i % 2 ? 'bg-accent' : 'bg-accent/50'}`}
                        style={{
                            left: `${left}%`,
                            width: wide ? 7 : 4,
                            height: wide ? 4 : 9,
                            animationDelay: `${delay}s`,
                            animationDuration: `${duration}s`,
                        }}
                    />
                );
            })}
        </div>
    );
}

/** The emoji in its disc, with the tick that says finished. */
function Crest({ emoji }: { emoji: string }) {
    return (
        <div className="relative mx-auto h-[76px] w-[76px]">
            {/* Two rings of accent at low alpha: a halo, so the crest reads as lit
                rather than as a flat chip. No animation — it is in the poster too. */}
            <div className="absolute -inset-3 rounded-full bg-accent/10" aria-hidden="true" />
            <div className="absolute inset-0 rounded-full bg-accent/20" aria-hidden="true" />
            <div className="absolute inset-0 flex items-center justify-center overflow-hidden text-[34px] leading-none" aria-hidden="true">
                {emoji}
            </div>
            <span className="absolute -bottom-0.5 -right-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-accent ring-4 ring-white dark:ring-slate-900">
                <Check className="h-4 w-4 text-white" strokeWidth={3} aria-hidden="true" />
            </span>
        </div>
    );
}

/**
 * The shape of the effort, week by week or day by day.
 *
 * Drawn as `div`s with a height, like the deck forecast: thirty numbers do not
 * justify a chart library, and a bar that carries its own label is legible to a
 * screen reader. `items-stretch` rather than `items-end` on purpose — a
 * percentage height against a parent with no definite height resolves to zero,
 * which once drew every busy day as nothing and every EMPTY day as its hairline.
 */
function ActivityBars({ buckets, bucketDays, label }: {
    buckets: { start: string; count: number }[];
    bucketDays: number;
    label: (start: string, count: number) => string;
}) {
    const peak = Math.max(1, ...buckets.map(b => b.count));
    // A three-day project is three bars, and three bars stretched across 330px
    // are three slabs — the chart stops reading as a chart. Past this count they
    // are thin enough to share the width; below it they keep their own and the
    // row centres, which says "not much time passed" rather than "here is a
    // diagram of three enormous things".
    const narrow = buckets.length < 8;
    return (
        <div
            className={`flex items-stretch gap-[3px] ${narrow ? 'justify-center' : ''}`}
            style={{ height: 68 }}
            role="group"
            aria-label={String(bucketDays)}
        >
            {buckets.map(bucket => {
                const description = label(bucket.start, bucket.count);
                return (
                    <div
                        key={bucket.start}
                        className={`flex min-w-0 flex-col justify-end ${narrow ? '' : 'flex-1'}`}
                        style={narrow ? { width: 26 } : undefined}
                        title={description}
                    >
                        <div
                            className={`w-full rounded-t ${bucket.count > 0 ? 'bg-accent' : 'bg-slate-200 dark:bg-slate-700'}`}
                            style={{ height: bucket.count > 0 ? `${Math.max(8, (bucket.count / peak) * 100)}%` : 2 }}
                            role="img"
                            aria-label={description}
                        />
                    </div>
                );
            })}
        </div>
    );
}
