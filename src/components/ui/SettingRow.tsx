/**
 * THE SETTING ROW.
 *
 * `vocabulary.ts` settled what a CONTROL looks like — three heights, one
 * radius per kind, one focus ring — and the Settings page obeys it: almost
 * every button, field and switch on the page comes from `ui/`. What a SETTING
 * looks like needs its own rule, or each one becomes hand-written markup
 * around its control: dozens of grey `<p>` descriptions, each individually
 * defensible, in a dozen different arrangements. The page becomes thousands of
 * words of prose with controls embedded in it, and a reader looking for one
 * switch has to read an essay to find it.
 *
 * The rule this file enforces: **a setting is a name and a control.** The
 * name is on the left, the control is on the right, and they share one line.
 * Anything else about the setting is available, never present:
 *
 *   hint   ONE short line under the name, and only when it changes which way
 *          you would set the thing. "Used by every screen in the app" is not
 *          a hint, it is a description of the obvious; "Off is fine" is.
 *   detail the longer version, READ ON THE PAGE. A page of identical grey
 *          chevrons is not a skimmable page (see `SettingNote` below), so
 *          nothing here hides behind an unnamed control. Optional reading that
 *          is genuinely long gets a NAME and an `Explain` from `ui/Disclosure`.
 *
 * A control too wide to sit beside its name (the theme previews, a palette)
 * takes `block`, which puts it on its own line under the name and inside the
 * same row — so it is still one setting, not a card of its own.
 *
 * `SettingGroup` is the card those rows live in: a quiet caption, then one
 * surface with hairlines between the rows. Group captions are how a long page
 * stays skimmable — the eye reads six captions, not thirty labels.
 */
import React, { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { SettingHintContext } from './settingHint';

/**
 * A GROUP'S CAPTION IS NOT SHOUTED.
 *
 * No `text-transform: uppercase`. In Cyrillic, for one, it is actively harder
 * to read: capitals lose the ascenders and descenders that give a word its
 * silhouette, so a heading in capitals is a grey brick where the same words in
 * sentence case are a shape. The rule holds for every label in the app, not just this
 * one — guard: `tools/settings-vocabulary-gates.mjs`.
 *
 * Sentence case, not Title Case: the caption is translated into twelve
 * languages, and Title Case is an English typographic rule that is simply
 * wrong in Russian, Dutch, Spanish and most of the rest. One rule that holds
 * everywhere beats a rule that looks right in one locale.
 *
 * Losing the capitals costs the caption some of its weight, so the colour
 * takes it back: slate-600 on the light page is 7.0:1 against slate-500's
 * 4.8:1, and slate-300 on the dark page is 11.6:1.
 */
export const GROUP_CAPTION = 'mb-2 px-1 text-sm font-semibold text-slate-600 dark:text-slate-300';

/**
 * A setting's explanation. ONE LINE OR FIVE, IT IS ON THE PAGE.
 *
 * Demoting a long help line into an unnamed "More" buys a skimmable page and
 * pays for it in a corridor of identical grey chevrons: three on one screen of
 * the Learning tab, one of them directly above another inside the card it
 * belonged to. Opening one costs a tap and tells the reader nothing they could
 * have predicted, and what is behind it is four lines — which is not a page of
 * prose, it is a sentence.
 *
 * So there is no anonymous disclosure anywhere in the app. A paragraph that is
 * genuinely optional reading gets a NAME and an `Explain` (see
 * `ui/Disclosure.tsx`); everything else is simply read.
 *
 * Help and hint are PROSE, so they are read at the reading size (14px) and set
 * apart from the label by weight and colour, not by being shrunk to 12px. 12px
 * is for badges, counters and code.
 */
export function SettingNote({ children, className = '' }: { children: React.ReactNode; className?: string }) {
    return <p className={`text-sm text-slate-500 dark:text-slate-400 ${className}`}>{children}</p>;
}

/** The same paragraph, from a string. `Field` passes its `help` through here so
 *  a field's explanation and a row's are one shape. */
export function SettingHelp({ text }: { text: React.ReactNode }) {
    return <SettingNote>{text}</SettingNote>;
}

/**
 * A titled card holding setting rows. The rows draw their own top border via
 * `divide-y`, so a row never has to know whether it is first.
 */
export function SettingGroup({ title, intro, children, className = '' }: {
    title: React.ReactNode;
    /** A paragraph under the heading, kept closed until asked for. */
    intro?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <section className={`mb-6 ${className}`}>
            {/* A caption, not a headline: it labels the card below it rather
                than announcing a chapter. Still an h2 — the page's outline is
                what a screen reader navigates by. */}
            <h2 className={GROUP_CAPTION}>{title}</h2>
            {intro && (
                <div className="mb-2 px-1">
                    <SettingNote>{intro}</SettingNote>
                </div>
            )}
            <div className="divide-y divide-slate-100 dark:divide-slate-700/60 rounded-xl bg-white shadow-sm dark:bg-slate-800">
                {children}
            </div>
        </section>
    );
}

/**
 * One setting.
 *
 * `label` + `control` is the whole of it. `block` moves the control under the
 * name for anything that needs the full width. `hint` is at most one line and
 * `more` is the long version, closed.
 */
/** The gap between a name and its control (`gap-4`). */
const ROW_GAP = 16;
/** A name needs at least this much of the row, or this much of a line, to read
 *  as a name and not as a ribbon of one-word lines. Whichever is smaller: on a
 *  narrow card the fraction binds, on a wide one the absolute does. */
const NAME_MIN_FRACTION = 0.45;
const NAME_MIN_REM = 12;
/** How much more room a `fill` row needs before its control comes back
 *  beside the name. Filling its line, a `block="narrow"` switch pads each
 *  segment 12px tighter than beside the name, so it measures up to 48px
 *  narrower there (four segments): without this margin a row in that band
 *  would come back, measure wider, and go under again, every frame. */
const FILL_RETURN_REM = 3;

/**
 * Does the control still fit BESIDE the name?
 *
 * The control is `shrink-0`, so what gives is the name column — and at some
 * width it gives everything. "Numbers" beside a select whose widest option is
 * "Same as the language (1,234.5)" leaves 89px on a 390px phone, and the line
 * under it comes out as "A comma / and a / point are / always / both /
 * accepted / when you / type." — eight lines of ribbon. In another language the
 * same row can be fine while a different one collapses, because a translated
 * label can run half as long again and its control wider still.
 * Neither a viewport breakpoint nor a fixed pixel floor can tell those apart:
 * the same row is one line in one language and a ribbon in the next, inside a
 * card whose width is not the screen's.
 *
 * So it is measured, on the row's own box. It is measured from the CONTROL's natural width, which
 * is the same whether the control is beside the name or under it, so the
 * decision cannot feed back into itself: stacking does not change any number
 * this reads, and there is no flicker to damp. (A `block="narrow"` switch is
 * the one exception: it pads its segments tighter while it fills its line, so
 * a `fill` row needs `FILL_RETURN_REM` more room to come back beside the name.)
 */
function useStacksWhenTight(enabled: boolean, fill = false) {
    const row = useRef<HTMLDivElement>(null);
    const control = useRef<HTMLDivElement>(null);
    const [stacked, setStacked] = useState(false);

    const measure = useCallback(() => {
        const rowEl = row.current, controlEl = control.current;
        // A row in a settings tab that is `hidden` has no box: every width is 0
        // and 0 − 0 − 16 reads as "does not fit", which stacked every row of a
        // tab that was not the one the page opened on. The observer measures
        // again the moment the tab is shown.
        if (!enabled || !rowEl || !controlEl || rowEl.clientWidth === 0) return;
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const floor = Math.min(rowEl.clientWidth * NAME_MIN_FRACTION, NAME_MIN_REM * rem);
        // Read at `max-content`: a `fill` control stacked under the name is as
        // wide as the row, and that width would keep it stacked for good. The
        // width is put back before anything paints, so nothing moves.
        const was = controlEl.style.width;
        controlEl.style.width = 'max-content';
        const natural = controlEl.offsetWidth;
        controlEl.style.width = was;
        const forName = rowEl.clientWidth - natural - ROW_GAP;
        const back = fill ? FILL_RETURN_REM * rem : 0;
        setStacked(prev => forName < floor + (prev ? back : 0));
    }, [enabled, fill]);

    useLayoutEffect(() => {
        const rowEl = row.current;
        if (!enabled || !rowEl) return;
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(rowEl);
        if (control.current) ro.observe(control.current);
        return () => ro.disconnect();
        // `stacked` because the control's wrapper is a different element in
        // each position, and an observer left on the detached one never fires.
    }, [enabled, measure, stacked]);

    // Not measured while there is no control (a row whose button gives way to
    // what it opened), so the last answer is stale: it would put the stacked
    // row's bottom margin over the opened panel's own top margin.
    return { row, control, stacked: enabled && stacked };
}

export function SettingRow({ id, label, hint, detail, control, more, block = false, fill = false, alignTop = false, htmlFor, className = '' }: {
    /** Lets a settings link ending `#<section>/<target>` scroll to and flash this row (`settingTargetId`). */
    id?: string;
    label: React.ReactNode;
    hint?: React.ReactNode;
    /** The long explanation, closed, under the name. Sits in the LEFT column
     *  because it is about the setting, not about the control. */
    detail?: React.ReactNode;
    control?: React.ReactNode;
    more?: React.ReactNode;
    block?: boolean;
    /** Beside the name while it fits, like any control; once under it, the
     *  line is the control's to fill (a `SegmentedControl block="narrow"`,
     *  whose segments read as one choice across a phone). `block` instead put
     *  such a switch under its name at EVERY width, a short track with the
     *  right half of a desktop card empty beside it. */
    fill?: boolean;
    /** The control level with the name's first line instead of centred on the
     *  text: for a detail that opens (a disclosure), which would otherwise
     *  slide the control down as it grows. */
    alignTop?: boolean;
    htmlFor?: string;
    className?: string;
}) {
    // The name is a <label> only when it points at a real control id — a
    // <label for> naming nothing is a promise to a screen reader that the app
    // does not keep.
    const Name = htmlFor ? 'label' : 'span';
    const { row, control: controlRef, stacked } = useStacksWhenTight(!block && !!control, fill);
    const under = block || stacked;
    const hintId = useId();
    const name = (
        <Name
            {...(htmlFor ? { htmlFor } : {})}
            className="block font-medium text-slate-900 dark:text-white"
        >
            {label}
        </Name>
    );

    return (
        <SettingHintContext.Provider value={hint ? hintId : undefined}>
        <div id={id} className={`px-4 py-3 ${className}`}>
            {/* THE CONTROL NEVER DROPS BELOW THE NAME.
                `flex-wrap` with a fixed 192px name column breaks the row
                whenever the name's column plus the control exceeds the card,
                and the control then lands on the next line at the LEFT edge.
                Three things are wrong with that. A switch on the left is a
                switch a thumb cannot reach one-handed, which is why every
                phone OS puts them on the right. A fixed basis breaks rows that
                fit perfectly well — a short name plus a two-option switch was
                303px of content inside a 347px card. And a wrapped row and an
                unwrapped one read as two different kinds of setting when they
                are the same kind.
                So: name left, control right, on one line. What gives is the
                NAME, which wraps — `min-w-0` lets it shrink past its longest
                word and the control is `shrink-0`. When even that is not
                enough (`useStacksWhenTight`), the control goes UNDER the whole
                name rather than beside a three-line one, which is the same
                place `block` puts it. Either way it is never half-way: a
                control at the left edge of its own line, under a name it is no
                longer beside, is the shape this replaced.
                The measurement reads the control at `max-content`: a stacked
                control that fills its line would otherwise measure as the row
                itself, and a row that stacked once would never come back. */}
            <div ref={row} className={`flex ${alignTop ? 'items-start' : 'items-center'} justify-between gap-4 ${under ? 'mb-3' : ''}`}>
                <div className="min-w-0 flex-1">
                    {name}
                    {hint && (
                        <p id={hintId} className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{hint}</p>
                    )}
                    {/* A <div> with the hint's type, not a <p>: a detail may
                        hold blocks (a status line over a note, a disclosure
                        with a button in it), and a block inside a <p> is
                        invalid markup the parser closes early. */}
                    {detail && <div className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{detail}</div>}
                </div>
                {/* A flex row, so a `block="narrow"` switch beside the name
                    knows it SHARES its line and keeps its own width: in a plain
                    block it filled that box with equal segments, and the
                    longest label ("No clock") broke onto two lines. */}
                {!under && control && <div ref={controlRef} className="flex shrink-0">{control}</div>}
            </div>
            {/* Stacked, the control keeps its OWN width rather than stretching,
                unless the row says `fill`; either way the measurement reads it
                at `max-content`, so filling the line never keeps it stacked.
                A `block` row is never measured, so its control is given the
                full row: the theme cards and the size slider are laid out
                across it, and a shrink-to-fit box left both a third wide. */}
            {under && control && (block
                ? <div>{control}</div>
                : <div ref={controlRef} className={fill ? '' : 'w-max max-w-full'}>{control}</div>
            )}
            {more && <div className="mt-3">{more}</div>}
        </div>
        </SettingHintContext.Provider>
    );
}

export default SettingRow;
