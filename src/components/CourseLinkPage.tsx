// src/components/CourseLinkPage.tsx
// The page a course link opens: the course it holds, in its own colour, with
// what is inside (counts, the first card, every topic) and one button. A full
// page rather than a dialog over the list: someone who opened a link sent to
// them came for this one course, and on a phone a box floating over a page
// they have never seen reads as a stray popup.
import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { usePortalAccent } from '../hooks/usePortalAccent';
import { useStudyClock } from '../hooks/useStudyClock';
import { useAccentVars } from '../hooks/useAccentVars';
import { courseFileOf, outlineOf, shown, type CourseOutline } from '../utils/courseOutline';
import { courseFromText } from '../utils/courseLink';
import { installedEditionOf } from '../utils/projectFiles';
import type { CourseUpdatePreview } from '../types';
import { ProjectIcon, iconName } from './ProjectIcon';
import { Button, IconButton } from './ui/Button';
import { DIALOG_BODY } from './ui/Dialog';

/** A course a link carries, read and ready to show. `have`: whether the
 *  library already holds it: new, the same or an older edition (open that),
 *  or a newer one (its update preview). */
export interface LinkedCourse {
    name: string;
    description: string;
    color: string | null;
    icon: string | null;
    /** The course's language, for the text it wrote (name, cards, topics). */
    lang: string | undefined;
    outline: CourseOutline;
    file: File;
    have: 'new' | { projectId: number } | CourseUpdatePreview;
}

/** Reads the course a link carries and asks the library whether it holds it.
 *  Throws `CourseLinkError` (or any error) for a link that cannot be read. */
export async function readLinkedCourse(text: string): Promise<LinkedCourse> {
    const data = await courseFromText(text);
    const project = data.project as Record<string, unknown>;
    // Shown, not stored: the importer reads the name from the file.
    const name = shown(project.name, 200);
    const file = courseFileOf(data);
    // A course the library already has is offered to open, not to add again.
    const edition = await installedEditionOf(file).catch(() => null);
    const have: LinkedCourse['have'] = !edition?.match ? 'new'
        : edition.refused === 'older' || edition.summary?.nothing ? { projectId: edition.match.projectId } : edition;
    const lang = shown(project.content_language, 35);
    return {
        name,
        description: shown(project.description, 600),
        // Only a plain colour from someone else's file reaches a style.
        color: /^#[0-9a-f]{6}$/i.test(shown(project.color, 7)) ? shown(project.color, 7) : null,
        // An icon the app has no drawing for would be drawn as its own text: the default instead.
        icon: iconName(shown(project.icon, 40)),
        lang: /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lang) ? lang : undefined,
        outline: outlineOf(data.nodes),
        file,
        have,
    };
}

/** The content column: one reading width, centred on a wide window. */
const COLUMN = 'mx-auto w-full max-w-xl px-5';
/** The close on the course's band: filled like the mark beside it, so it reads
 *  as a control on a saturated colour where a bare glyph read as a stray mark.
 *  White glyph and ring: the app's accent ring is the band's own colour there.
 *  15% and 20% keep the glyph at 3:1 or more on the darkest band a course
 *  colour can give (its white text at 4.5:1). */
const ON_BAND = '!bg-white/15 !text-white can-hover:enabled:hover:!bg-white/20 enabled:active:!bg-white/25 '
    + 'focus-visible:!ring-white disabled:!bg-transparent disabled:!text-white/60';
/** Rows drawn before "and N more": a link can hold tens of thousands of
 *  topics, and a phone drawing them all stalls. A real course stays under it. */
const MAX_TOPICS_SHOWN = 200;

export default function CourseLinkPage({ course, busy, onAct, onClose }: {
    /** Null while the link is being read. */
    course: LinkedCourse | null;
    busy: boolean;
    /** Add, open or update, by what `course.have` says. */
    onAct: () => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const titleId = useId();
    const pageRef = useRef<HTMLDivElement>(null);
    // Not closed while the course is being added: the import would land with
    // no page to retry from, or open a course the learner walked away from.
    const leave = () => { if (!busy) onClose(); };
    useDialogFocus(true, pageRef, { onEscape: leave, onBack: leave });
    const { anchor, accent } = usePortalAccent(true);
    useStudyClock(null, { enabled: true, layer: 'dialog' });
    // The band is the course's own colour made safe for white text, as on its
    // card in the list; the button keeps the app's accent.
    const band = useAccentVars(course?.color);

    const have = course?.have ?? 'new';
    const known = have !== 'new' && 'projectId' in have;
    const outline = course?.outline;
    const close = (onBand: boolean) => (
        <IconButton
            onClick={leave}
            disabled={busy}
            label={t("Close dialog")}
            tooltip={false}
            icon={<X className="h-5 w-5" />}
            className={onBand ? ON_BAND : undefined}
        />
    );

    return (
        <>
            <span ref={anchor} className="hidden" aria-hidden="true" />
            {createPortal((
                <div
                    ref={pageRef}
                    tabIndex={-1}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={course ? titleId : undefined}
                    aria-label={course ? undefined : t("Reading it…")}
                    className="fixed inset-0 z-50 flex flex-col bg-white safe-p-0 outline-none dark:bg-slate-900"
                    style={accent}
                >
                    {course && outline ? (
                        // The band scrolls with the rest: a long name and description
                        // would otherwise hold half a small phone, and only the
                        // button needs to stay in view.
                        <div className={DIALOG_BODY}>
                            <div className="bg-accent pt-3 text-white" style={band}>
                                <div className={`${COLUMN} pb-6`}>
                                    {/* At the end, as every close in the app, and in
                                        the same box as while the link is read. */}
                                    <div className="flex justify-end">{close(true)}</div>
                                    {/* The name sits beside the mark, as on the course's card. */}
                                    <div className="mt-2 flex items-center gap-4">
                                        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-3xl">
                                            <ProjectIcon icon={course.icon} className="h-8 w-8" />
                                        </div>
                                        <h1 id={titleId} lang={course.lang} className="min-w-0 break-words text-2xl font-semibold leading-tight">
                                            {course.name}
                                        </h1>
                                    </div>
                                    {course.description && (
                                        // Full white: at 90% it fell to 4:1 on a pale course's band.
                                        <p lang={course.lang} className="mt-4 break-words text-base">{course.description}</p>
                                    )}
                                </div>
                            </div>
                            <div className={`${COLUMN} py-5`}>
                                {/* A count keeps its word on its line. */}
                                <p className="text-base text-slate-600 dark:text-slate-300">
                                    <span className="whitespace-nowrap">{t("{{count}} topics", { count: outline.topics.length })}</span>
                                    {' · '}<span className="whitespace-nowrap">{t("{{count}} cards", { count: outline.cards })}</span>
                                    {' · '}<span className="whitespace-nowrap">{t("{{count}} questions", { count: outline.questions })}</span>
                                </p>
                                {have !== 'new' && (
                                    <p className="mt-2 text-base font-medium text-slate-900 dark:text-white">
                                        {known ? t("You already have this course.") : t("This link holds a newer edition of a course you have.")}
                                    </p>
                                )}
                                {outline.firstCard && (
                                    <section className="mt-5 rounded-xl border border-slate-200 px-4 py-4 text-center dark:border-slate-700">
                                        <h2 className="text-sm text-slate-600 dark:text-slate-300">{t("First card")}</h2>
                                        <p lang={course.lang} className="mt-2 break-words text-xl text-slate-900 dark:text-white">{outline.firstCard.front}</p>
                                        {outline.firstCard.back && (
                                            <p lang={course.lang} className="mt-1 break-words text-base text-slate-600 dark:text-slate-300">{outline.firstCard.back}</p>
                                        )}
                                    </section>
                                )}
                                {outline.topics.length > 0 && (
                                    <section className="mt-6">
                                        <h2 className="text-sm font-semibold text-slate-600 dark:text-slate-300">{t("Topics")}</h2>
                                        <ul className="mt-1 border-t border-slate-200 dark:border-slate-700">
                                            {outline.topics.slice(0, MAX_TOPICS_SHOWN).map((topic, i) => (
                                                <li key={i} className="flex items-baseline justify-between gap-4 border-b border-slate-200 py-3 text-base dark:border-slate-700">
                                                    <span lang={course.lang} className="min-w-0 break-words text-slate-900 dark:text-white">{topic.title}</span>
                                                    <span className="shrink-0 whitespace-nowrap text-slate-600 dark:text-slate-300">{t("{{count}} cards", { count: topic.cards })}</span>
                                                </li>
                                            ))}
                                            {outline.topics.length > MAX_TOPICS_SHOWN && (
                                                <li className="py-3 text-base text-slate-600 dark:text-slate-300">
                                                    {t("and {{count}} more topics", { count: outline.topics.length - MAX_TOPICS_SHOWN })}
                                                </li>
                                            )}
                                        </ul>
                                    </section>
                                )}
                            </div>
                        </div>
                    ) : (
                        // Being read: a moment, so a spinner rather than a page that
                        // jumps, and no band yet: its colour is the course's.
                        <>
                            <div className="shrink-0 pt-3"><div className={`${COLUMN} flex justify-end`}>{close(false)}</div></div>
                            <div className="flex flex-1 items-center justify-center" role="status" aria-busy="true">
                                <Loader2 className="h-6 w-6 animate-spin text-accent-fg" aria-hidden="true" />
                                <span className="sr-only">{t("Reading it…")}</span>
                            </div>
                        </>
                    )}

                    {course && (
                        <div className="shrink-0 border-t border-slate-200 py-3 dark:border-slate-700">
                            <div className={COLUMN}>
                                <Button variant="primary" size="lg" block busy={busy} onClick={onAct}
                                    aria-label={known ? t("Open {{name}}", { name: course.name }) : undefined}>
                                    {have === 'new' ? t("Add this course") : known ? t("Open") : t("Update course")}
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            ), document.body)}
        </>
    );
}
