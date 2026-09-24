/**
 * THE TWO DISCLOSURES, AND THERE ARE ONLY TWO.
 *
 * Settings had seven, counted off the phone it is read on:
 * a borderless 12px "More" with a small chevron; a bordered 40px box with a
 * named summary; the same bordered box again but tinted `bg-slate-50` and
 * hand-written twice in the AI tab (both missing the webkit marker reset, so
 * Safari drew a native triangle beside the drawn chevron); a bordered box whose
 * summary was a three-line PARAGRAPH with a second line under it; an icon card
 * with the chevron on the RIGHT; the same icon card again with a border and a
 * shadow; and the same again tinting itself open. Every one of them was
 * locally defensible. Together they taught the reader nothing: on the Search
 * links tab two of them sat 150px apart in different sizes, and on the AI tab
 * three named boxes stacked up under a section whose own explanation was an
 * unnamed chevron.
 *
 * A disclosure is a promise — press this and the thing under it appears. A
 * reader can only learn that promise if it always looks the same. So:
 *
 *   Explain            PROSE behind a name. A quiet line with a chevron, no
 *                      border. Thirty of them closed down a page are thirty
 *                      quiet lines; thirty bordered 40px boxes are a second
 *                      page of noise, which is what a settings page can least
 *                      afford. Open, the body takes a hairline down its left
 *                      edge — that is what says where the opened thing ends,
 *                      and it costs nothing while closed.
 *
 *   ExpandableSection  CONTROLS behind a name. An icon, a title, one line of
 *                      what is inside, and the chevron at the far end. This is
 *                      a section of the page that happens to start closed, so
 *                      it is the size of a section: the summary alone is worth
 *                      pressing, and the body is other settings.
 *
 * The rule that keeps it at two: if what opens is words, it is an `Explain`;
 * if what opens is things you can set, it is an `ExpandableSection`. Nothing
 * on this page is a third case. Guard: `tools/settings-vocabulary-gates.mjs`.
 *
 * Both are a native `<details>`. A `<summary>` is not a button, so neither
 * enters the control vocabulary's three heights — but both carry `FOCUS_RING`
 * and a finger's 44px, because a keyboard and a thumb do not care what the
 * element is called.
 */
import React from 'react';
import { ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { FOCUS_RING, cx } from './vocabulary';

/** Hides the platform's own marker. Chrome, Safari and Firefox each need a
 *  different one of these, and a triangle beside a drawn chevron is the tell
 *  that one was forgotten — which two hand-written copies in the AI tab were. */
const NO_MARKER = 'list-none [&::-webkit-details-marker]:hidden [&::marker]:content-[""]';

/** Every summary in the app is pressable the same way: no double-tap zoom
 *  delay, no 300ms wait, and a focus ring a keyboard can see. */
const SUMMARY_BASE = `cursor-pointer [touch-action:manipulation] ${FOCUS_RING} ${NO_MARKER}`;

/**
 * The chevron turns; it does not swap for a different glyph.
 *
 * `transition-transform`, never `transition-all` — a listed property is the one
 * the compositor can take, and `all` also animates the colour change on hover,
 * which is why the turn read as instant: it was sharing a 200ms budget with a
 * paint. Off entirely under `prefers-reduced-motion`, where a rotating arrow is
 * exactly the kind of thing the setting is asking you not to draw.
 */
const CHEVRON_TURN =
    'transition-transform duration-200 ease-out motion-reduce:transition-none group-open:rotate-90';

/**
 * Prose behind a name.
 *
 * `summary` is what is inside, in the reader's words — "Where your data goes",
 * not "Details" and never "More". An unnamed disclosure is a door with no sign
 * on it, and a page of them is a corridor: the Search links tab carried two of
 * them 150px apart, both saying "More", one inside the other's section, and
 * neither said anything a reader could not have guessed.
 *
 * THE WHOLE LINE OPENS IT. An `inline-flex` summary is only as wide as its own
 * words, so on a phone the pressable area was a 70px word with 250px of dead
 * row beside it that looked exactly as pressable.
 */
export function Explain({ summary, children, className = '', onToggle }: {
    summary: React.ReactNode;
    children: React.ReactNode;
    className?: string;
    /** Fired on open AND on close, like the DOM event. A body that has to be
     *  fetched loads here rather than on mount. */
    onToggle?: React.ReactEventHandler<HTMLDetailsElement>;
}) {
    return (
        <details onToggle={onToggle} className={cx('group', className)}>
            <summary
                // 14px, not 12px: this is prose, and the page's own rule is that
                // 12px is for badges, counters and code. It also has to sit beside
                // a setting's name without reading as a footnote.
                className={cx(
                    'flex w-full items-center gap-1.5 rounded -mx-2 px-2 py-1.5 touch:min-h-11',
                    'text-sm font-medium text-slate-600 hover:text-accent-fg dark:text-slate-300',
                    SUMMARY_BASE,
                )}
            >
                <ChevronRight className={cx('w-4 h-4 shrink-0 text-slate-500 dark:text-slate-400', CHEVRON_TURN)} aria-hidden="true" />
                <span className="min-w-0">{summary}</span>
            </summary>
            {/* The hairline is the whole open treatment. It starts under the
                chevron, so the body reads as hanging off the line that opened
                it rather than as the next thing on the page. */}
            <div className="details-reveal mt-1 ml-2 border-l-2 border-slate-200 pl-3 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {children}
            </div>
        </details>
    );
}

/**
 * Controls behind a name.
 *
 * `variant`:
 *   card  it stands on the page as its own card (the page background is
 *         visible around it).
 *   row   it is one row of a divided panel, and opening it tints the whole row
 *         end to end with an accent rule down its left edge — because an open
 *         row's contents are themselves cards, radios and fields with borders,
 *         and without the tint nothing said where the open row stopped and the
 *         next one began.
 *
 * The rule is an inset SHADOW, not a border: a border would shift the row's
 * contents 2px sideways on every open and closed again.
 */
export function ExpandableSection({
    icon: Icon, lead, title, desc, aside, variant = 'card', flushBody = false, children, className = '', onToggle,
}: {
    icon?: LucideIcon;
    /** Drawn where the icon goes, for a section whose mark is a picture of what
     *  is inside rather than a glyph — the app icon's own live preview. */
    lead?: React.ReactNode;
    title: React.ReactNode;
    desc?: React.ReactNode;
    /** The read-only answer on the summary line, so a closed section still says
     *  whether what is inside is on. */
    aside?: React.ReactNode;
    variant?: 'card' | 'row';
    /** The body brings its own padding — a divided list of rows that each pad
     *  themselves, for instance. Without it the section's own padding and the
     *  rows' would stack into a 32px gutter. */
    flushBody?: boolean;
    children: React.ReactNode;
    className?: string;
    onToggle?: React.ReactEventHandler<HTMLDetailsElement>;
}) {
    const card = variant === 'card';
    // An open ROW tints itself end to end and takes the panel's own corners
    // when it is the first or last of them: a square corner over a rounded card
    // is a chip out of it. `overflow-hidden` on the panel would do the same in
    // one class and clip the model picker's dropdown, which opens from inside
    // one of these.
    return (
        <details
            onToggle={onToggle}
            className={cx(
                'group',
                card
                    ? 'rounded-xl bg-white shadow-sm dark:bg-slate-800'
                    : 'open:bg-slate-50 open:shadow-[inset_2px_0_0_0_rgb(var(--accent-rgb))] first:open:rounded-t-xl last:open:rounded-b-xl dark:open:bg-slate-900/50',
                // (see the note above the return)
                className,
            )}
        >
            <summary
                className={cx(
                    'flex flex-wrap items-start gap-3 px-4 py-3 text-left',
                    // Open, the body follows this summary and its square top edge
                    // does not cover the summary's own rounded bottom corners, so
                    // the page showed through two corner notches (black on dark).
                    card ? 'rounded-xl group-open:rounded-b-none' : 'rounded-lg',
                    // An open ROW's summary becomes a HEADER BAND: a shade deeper
                    // than the body under it. With every job open, five bodies and
                    // five summaries were one continuous grey and it took the
                    // accent hairline to tell where one job ended — "hard to
                    // distinguish what is what where".
                    // Open, the band is square-cornered so it meets the body and
                    // the panel's edges; only the first row keeps the panel's top.
                    card ? '' : 'group-open:bg-slate-100 dark:group-open:bg-slate-800 group-open:rounded-none [details[open]:first-child>&]:rounded-t-xl',
                    SUMMARY_BASE,
                )}
            >
                {lead ?? (Icon && <Icon className="mt-0.5 w-5 h-5 shrink-0 text-accent-fg" aria-hidden="true" />)}
                <span className="min-w-0 flex-1">
                    <span className="block font-medium text-slate-900 dark:text-white">{title}</span>
                    {desc && <span className="mt-0.5 block text-sm text-slate-500 dark:text-slate-400">{desc}</span>}
                </span>
                {/* Narrow, the answer drops to its own full-width line under the
                    text. `flex-basis:0%` on the text span would otherwise let a
                    long answer stay inline and squeeze the description into a
                    ~185px column. */}
                {aside && (
                    <span className="order-last basis-full shrink-0 self-center pl-8 text-sm text-slate-500 dark:text-slate-400 sm:order-none sm:basis-auto sm:pl-0">
                        {aside}
                    </span>
                )}
                <ChevronRight className={cx('w-4 h-4 shrink-0 self-center text-slate-500 dark:text-slate-400', CHEVRON_TURN)} aria-hidden="true" />
            </summary>
            {/* Indented to the title above it, so the body reads as belonging to
                that section rather than starting a new one; the icon's column is
                the indent. */}
            <div
                className={cx(
                    'details-reveal border-t border-slate-100 dark:border-slate-700/60',
                    flushBody ? '' : 'px-4 pb-4 pt-3',
                    card ? 'rounded-b-xl bg-white dark:bg-slate-800' : '',
                    (Icon || lead) && !flushBody ? 'sm:pl-12' : '',
                )}
            >
                {children}
            </div>
        </details>
    );
}
