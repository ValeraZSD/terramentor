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
 * WHAT "OPEN" LOOKS LIKE, MEASURED.
 *
 * The surface ladder is a ladder of HALF-STEPS: white to `slate-100` is 1.10:1,
 * `slate-50` to `slate-100` is 1.05:1, and on the dark side `slate-800` to
 * `slate-900` is 1.10:1. An open section that told itself apart by a step of
 * fill alone (which is what this file did) measured 1.04 to 1.12 against what
 * sat around it, so on a page of open sections nothing said where one ended.
 * The fill cannot simply be pushed further, because muted text is `slate-500`
 * and stays above 4.5:1 only on `slate-50` and lighter (on a warm tint `slate-50`
 * itself measured 4.44:1, which is why an open CARD's body is its own white and
 * not a grey). So on a card the EDGE carries it: a 1px `slate-300` outline
 * (1.48:1 on white; `slate-600` on the dark side, 2.1:1 on `slate-800`), the
 * same rule under the header, and, on the dark side only, a body recessed to
 * `slate-900`. A ROW is drawn differently (see `ExpandableSection`): its body
 * IS recessed to `slate-50`, where muted text is 4.55:1 untinted and under the
 * floor on a warm tint.
 *
 * `OPEN_EDGE` is the card's outline. It is an OUTLINE drawn inside the box
 * (`-outline-offset-1`) rather than a border because it adds no pixels, so the
 * contents do not move when the section opens.
 */
const OPEN_EDGE =
    'open:outline open:outline-1 open:-outline-offset-1 open:outline-slate-300 dark:open:outline-slate-600';

/** The rule under an opened summary, between it and its body. */
const BODY_RULE = 'border-t border-slate-300 dark:border-slate-600';

/** The opened prose of an `Explain`: a rule one rung stronger than the hairline
 *  it replaces (1.18:1 to 1.48:1 against the row it opens in), a wash of the
 *  ink colour over whatever it opens on (a fixed rung would be invisible on
 *  the one surface that shares it: `slate-100` on the page, `slate-900` in an
 *  open dark row), and text at reading strength. `slate-500` measured 4.14 to
 *  4.31:1 where an `Explain` stands straight on the page (`slate-100`), under
 *  the 4.5:1 floor. */
const EXPLAIN_BODY =
    'details-reveal mt-1 ml-2 rounded-r-lg border-l-2 border-slate-300 bg-slate-900/5 py-2 pl-3 pr-3 text-sm text-slate-600 dark:border-slate-600 dark:bg-white/5 dark:text-slate-300';

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
            <div className={EXPLAIN_BODY}>
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
 *   row   it is one row of a divided panel. Open, its body hangs off a GUIDE
 *         LINE under the header's icon, the way an `Explain` hangs off the line
 *         under its chevron: one idiom for "this belongs to that" on the page.
 *         The line starts below the header, never beside it, because the
 *         header is the parent and a line through it reads as one more
 *         child, and the body is
 *         indented to the title, so the line runs in the gutter between the
 *         two. Header and body are the panel's own surface; the panel's
 *         dividers say where one row ends.
 *
 * Tried and dropped 2026-09-30: a `slate-100` header band (the PAGE's colour,
 * read as a hole in the card); an accent wash, a 3px stripe and an outline
 * ("this looks ugly"); an all-white row with nothing marking the body (parent
 * and child could not be told apart); and a `slate-50` body with a 2px accent
 * rule at the panel's edge, whose fill measured 1.05:1 against the header, so
 * the accent alone carried the grouping, and put muted text at 4.55:1 (under
 * the floor on a warm tint).
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
    const marked = Boolean(Icon || lead);
    return (
        <details
            onToggle={onToggle}
            className={cx(
                'group',
                card && cx('rounded-xl bg-white shadow-sm dark:bg-slate-800', OPEN_EDGE),
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
                    // A row answers the pointer with a step of fill, and takes
                    // the panel's corners where it has them, or the hover fill
                    // pokes past the card's larger radius (`overflow-hidden` on
                    // the panel would clip the model picker's dropdown, which
                    // opens from inside one of these). Open, the fill meets the
                    // body square.
                    card ? '' : 'transition-colors hover:bg-slate-50 dark:hover:bg-slate-700/40 [details:first-child>&]:rounded-t-xl [details:last-child:not([open])>&]:rounded-b-xl group-open:rounded-none [details[open]:first-child>&]:rounded-t-xl',
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
            {card ? (
                <div
                    className={cx(
                        'details-reveal rounded-b-xl bg-white dark:bg-slate-900',
                        BODY_RULE,
                        flushBody ? '' : 'px-4 pb-4 pt-3',
                        marked && !flushBody ? 'sm:pl-12' : '',
                    )}
                >
                    {children}
                </div>
            ) : (
                <div
                    className={cx(
                        'details-reveal',
                        // The guide sits under the centre of a 20px icon (16px
                        // padding + 10px, less half its own 2px). A flush body's
                        // children pad themselves by 16px, so `pl-8` lands their
                        // text on the same 48px title column as `pl-12` does.
                        marked && 'relative before:absolute before:left-[1.5625rem] before:top-0 before:bottom-4 before:w-0.5 before:rounded-full before:bg-slate-300 dark:before:bg-slate-600',
                        flushBody
                            ? (marked ? 'pl-8' : '')
                            : cx('pb-4 pt-1 pr-4', marked ? 'pl-12' : 'pl-4'),
                    )}
                >
                    {children}
                </div>
            )}
        </details>
    );
}
