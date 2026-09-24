import { useEffect, useRef, useState, ReactNode } from 'react';
import { Check, Pipette } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { parseCssColor } from '../../utils/color';
import { FOCUS_RING, FIELD_BASE, FIELD_SIZE, cx } from './vocabulary';
import { useRovingGrid } from './useRovingGrid';
import { useMediaQuery } from '../../hooks/useMediaQuery';

/**
 * CHOOSING A COLOUR, ONCE.
 *
 * There were two of these — the project dialog's and Settings' accent row — in
 * one file, sharing a palette constant and nothing else. The project one was the
 * older copy: no tick on the chosen swatch, no way to enter a value at all, no
 * focus ring, and a selection ring with `ring-offset-white / dark:ring-offset-
 * slate-800`, which is the offset trap `vocabulary.ts` exists to name (the gap
 * is PAINTED, so it is a pale halo on Warm and on Black). Two copies of a
 * control is how one of them quietly becomes the bad one.
 *
 * The differences that are real are data, and they are props: which shortlist,
 * which colours are already spoken for, which extra colours this library holds.
 * Everything else — the grid, the mark, the keyboard, the value field, the
 * eyedropper — is this file.
 *
 * **A block beside the field, or sixteen columns, or eight — and no breakpoint.**
 * Where everything fits side by side the palette is a block of fixed squares
 * with the value beside it (see `besideMinRem`); where it does not, the palette
 * takes the line and the value goes underneath. A VIEWPORT query
 * (`grid-cols-4 sm:grid-cols-8`) deciding the shape of something also mounted
 * in a 448px dialog on a 1200px screen is the container-width rule this app
 * keeps relearning. Sixteen divides by both,
 * so whichever count the grid can hold fills its rows flush and there is never
 * an orphan. Which one it is comes from MEASURING the grid's own box, so the
 * same control is one line on a settings card and two in a dialog. Height
 * carries the touch target instead (`h-9 touch:h-11`, `h-7 touch:h-9` when the
 * chips are half-width): input capability is a media query here, never a width.
 *
 * **The mark is an outline, not a ring.** `outline-offset` leaves its gap
 * TRANSPARENT where `ring-offset` fills it with a colour — so one declaration is
 * right on all four themes, and the tick inside means the chosen swatch is
 * legible at a glance across sixteen rather than by hunting for a halo.
 */

/** A project's identity colour: vivid, so 24 of them can be told apart. */
export const PROJECT_COLORS = [
    '#F43F5E', // Rose
    '#EF4444', // Red
    '#F97316', // Orange
    '#f5b30b', // Amber
    '#84CC16', // Lime
    '#22C55E', // Green
    '#14B8A6', // Teal
    '#06B6D4', // Cyan
    '#0EA5E9', // Sky
    '#3B82F6', // Blue
    '#6366F1', // Indigo
    '#8B5CF6', // Violet
    '#A855F7', // Purple
    '#D946EF', // Fuchsia
    '#EC4899', // Pink
    '#334155', // Slate — the one achromatic choice, for a project that wants none
];

/**
 * The app's accent: saturated and dark enough that white label text clears AA on
 * a solid button without the app having to darken it first.
 *
 * (A PROJECT colour is darkened on the way to `--accent-rgb`, which is why the
 * two lists differ and why the project dialog previews the result rather than
 * pretending the swatch is what gets painted.)
 *
 * **ONE ORDER, THREE LADDERS.** This list, `THEME_TINTS` and the app icon's
 * `ICON_BACKGROUNDS` are the same sixteen NAMES in the same sixteen positions —
 * fourteen hues round the wheel, then the achromatic pair — so a reader moving
 * down the Appearance card finds the same colour in the same place three times.
 * What differs is the RUNG each palette is drawn at, because the three are asked
 * to do different jobs: an accent is a fill that carries white text (700), a
 * theme tint is a whole page (a pastel, or its dark mirror), an icon tile is
 * read at 16px among other apps' icons (900).
 *
 * That is also why the pair at the end is `Ink`/`Paper` and not black/white
 * here. `#ffffff` as an accent is painted `#757575` by `accentSolidTriplet` —
 * the swatch would be a lie about the button, which is the one thing
 * `color-gates.mjs` refuses. So the accent's pale end is the LIGHTEST cool grey
 * that still carries white text: `#64748b`, measured at 4.76:1. The icon tile
 * has no such constraint (its ink flips), so there the same two slots are true
 * black and true white. Guard: `palette-order-gates.mjs`.
 */
export const ACCENT_COLORS = [
    '#0369a1', // Sky
    '#1d4ed8', // Blue
    '#4338ca', // Indigo
    '#6d28d9', // Violet
    '#7e22ce', // Purple
    '#a21caf', // Fuchsia
    '#be185d', // Pink
    '#be123c', // Rose
    '#b91c1c', // Red
    '#c2410c', // Orange
    '#b45309', // Amber
    '#15803d', // Green
    '#047857', // Emerald
    '#0f766e', // Teal
    '#0f172a', // Ink
    '#64748b', // Paper
];

/**
 * THE PAGE'S OWN COLOUR — the third rung of the same sixteen.
 *
 * A theme is a mode and a tint (`src/utils/themeRamp.ts`), and these are the
 * shortlist for the tint. Pastels, because a tint is the whole page: they land
 * about where the hand-made cream theme sat, which is as far as a surface
 * should go before it stops being a surface. Anything at all is still typeable,
 * and the generator caps what it will act on rather than refusing it.
 *
 * **Fourteen hues at ONE lightness and ONE saturation** (HSL 87% / 60%),
 * generated rather than taken from Tailwind's 200 rung, because the ramp reads
 * a tint's lightness as how DEEP the page should go — and Tailwind's pastels
 * are not level: `amber-200` sits at 76.5% and `violet-200` at 92%, so the two
 * chips looked equally pale and asked for 14 points of depth and 6. Measured in
 * Edge, 2026-09-21: the amber re-coloured the page to a clear cream and the
 * violet was very nearly the untinted app. At one lightness every hue asks for
 * 10.9 points and the row differs only in the thing it is offering.
 *
 * `Ink` and `Paper` are not decoration here, they are the two ends of the
 * choice. Paper is NO tint — the app's own slate ramp, in either mode, to the
 * bit. Ink in dark mode is the true-black page the old OLED theme was; in light
 * mode it is the deepest a light page is allowed to go.
 */
export const THEME_TINTS = [
    '#cae5f2', // Sky
    '#cad9f2', // Blue
    '#cacbf2', // Indigo
    '#d6caf2', // Violet
    '#dfcaf2', // Purple
    '#eccaf2', // Fuchsia
    '#f2cade', // Pink
    '#f2cad1', // Rose
    '#f2caca', // Red
    '#f2dbca', // Orange
    '#f2e6ca', // Amber
    '#caf2d9', // Green
    '#caf2e4', // Emerald
    '#caf2ee', // Teal
    '#000000', // Ink
    '#ffffff', // Paper
];

/** Normalise for comparison: `#E74`, `#ee7744` and `rgb(238 119 68)` are one colour. */
export const sameColor = (a: string | null | undefined, b: string | null | undefined) => {
    const pa = parseCssColor(a), pb = parseCssColor(b);
    return !!pa && pa === pb;
};

const COLUMNS = 8;

/**
 * Half-width chips: the whole palette on ONE line when the container can hold
 * it, two lines of eight when it cannot.
 *
 * The orphan rule is what pins the two counts — 16 divides by 8 and by 16, so
 * both fill their rows flush — and the container rule is what forbids a
 * breakpoint choosing between them: this control is mounted in a settings card
 * (736px on any desktop), in a 448px dialog, and on a 390px phone, and `sm:`
 * calls the first two the same thing. So the grid measures ITSELF.
 *
 * `MIN_DENSE_CHIP` is the floor a half-width chip may not go under — below
 * about 24px a swatch stops being a target and starts being a stripe — and the
 * GAP closes with the chips (8px between eight, 4px between sixteen), because a
 * gap that stays put spends 120px of a 480px row on nothing. Sixteen chips plus
 * fifteen gaps is what the whole palette needs: 444px, which every desktop
 * window clears (the settings card is 480px at a 768px viewport and 736px past
 * 1100px) and a phone does not.
 */
const DENSE_COLUMNS = 16;
const MIN_DENSE_CHIP = 24;
const GAP = 8;
const DENSE_GAP = 4;
const DENSE_MIN_WIDTH = DENSE_COLUMNS * MIN_DENSE_CHIP + (DENSE_COLUMNS - 1) * DENSE_GAP;

/**
 * THE WIDE SHAPE: the palette is a BLOCK, and the value field stands beside it.
 *
 * Sixteen chips stretched across a 736px settings card is one control drawn as
 * a 736px stripe, with the eyedropper and the value that belongs to it on a
 * line of their own underneath — and on the next card down the same stripe
 * again. Left to fill the width they always will, because a `1fr` column takes
 * whatever it is given.
 *
 * So past the width where everything fits side by side the chips stop
 * stretching: eight fixed squares by two rows, the eyedropper against them at
 * the block's full height (it IS the seventeenth swatch — the one that is any
 * colour at all), then the value and its sentence. One row instead of three,
 * and the palette reads as a palette rather than as a ruler.
 *
 * The chip is sized in REM, so `ui_scale` reaches it; the threshold is
 * therefore also rem, converted with the live root font size at measure time.
 * That is not decoration — a 160% scale grows the settings card's own padding,
 * which shrinks this box, which fires the observer, which re-reads the root
 * font size. The two halves of the sum move together or the shape is chosen
 * for a chip size nobody is drawing.
 */
const BESIDE_COLUMNS = 8;
const CHIP_REM = 2;          // the FLOOR, and what the threshold below is sized against
const CHIP_TOUCH_REM = 2.75; // the 44px floor, as ever
/**
 * …and the CEILING, because in the wide shape the chips take the slack.
 *
 * Eight fixed squares leave a 736px settings card 180-odd px short of full,
 * three times over — once per colour row on the Appearance card. So the chips
 * grow into it (`minmax(floor, 1fr)`, square by `aspect-square`, so the block
 * gets taller as it gets wider) and stop at this size, which is where they land
 * on that card: 736 − the pipette, the value group and the gaps, over eight.
 * Past it they stop, because a swatch bigger than this is not a swatch any
 * more.
 */
const CHIP_MAX_REM = 3.5;

/**
 * The palette group's own bounds, and why it needs BOTH.
 *
 * The group and the value beside it are two flex children, and `flex-1` on
 * each splits the free space between them in the ratio of their grow factors —
 * not "fill the first, then the second". With the chips' floor expressed as
 * `minmax()` grid tracks, that gave the group 272px to hold 298px of chips:
 * the tracks overflowed their box, the eyedropper was drawn on top of the
 * fifteenth swatch and the value field on top of the sixteenth. Measured in
 * Edge on a 736px settings card, 2026-09-21.
 *
 * So the group carries a real `minWidth` — the floor it can never be squeezed
 * under — and only the group grows. The value field is `shrink-0` at its own
 * basis, and the slack between the two bounds is the chips'.
 */
const groupRem = (chip: number) =>
    BESIDE_COLUMNS * chip + (BESIDE_COLUMNS - 1) * BESIDE_GAP_REM + GROUP_GAP_REM + PIPETTE_REM;
const BESIDE_GAP_REM = 0.375;
const GROUP_GAP_REM = 0.5;   // chips → eyedropper
const PIPETTE_REM = 2.75;    // w-11
const ROW_GAP_REM = 1;       // palette group → value group
const VALUE_MIN_REM = 11;    // the field (9rem) with room for a word beside it

const besideMinRem = (chip: number) => groupRem(chip) + ROW_GAP_REM + VALUE_MIN_REM;

/** `beside` = the wide shape; the other two are the palette on its own line. */
type Shape = 'beside' | 'dense' | 'eight';

/**
 * Which shape, and therefore how many chips fit, measured on the control's own box.
 *
 * A `ResizeObserver` and not a one-off read, because the settings page keeps its
 * sections MOUNTED and toggles `hidden`: arriving on the AI tab and switching to
 * General means this grid is born at zero width. Measured in a real browser on
 * 2026-09-17 — the observer does report the box when the section is shown, and
 * the count lands on the same answer as landing on General directly. (In the
 * in-app browser PANE it never does, because a hidden pane runs no rendering
 * steps for the observer to fire in; that is the pane, not the page.)
 */
function useGridColumns(touch: boolean) {
    const ref = useRef<HTMLDivElement | null>(null);
    const [shape, setShape] = useState<Shape>('eight');
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measure = () => {
            const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            const width = el.clientWidth;
            setShape(
                width >= besideMinRem(touch ? CHIP_TOUCH_REM : CHIP_REM) * rem ? 'beside'
                    : width >= DENSE_MIN_WIDTH ? 'dense'
                        : 'eight');
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [touch]);
    const columns = shape === 'dense' ? DENSE_COLUMNS : COLUMNS;
    return { ref, shape, columns };
}

/**
 * Every chip gets an edge, so a colour close to the surface is still a chip.
 *
 * An INSET SHADOW rather than `ring-1 ring-inset`, which is the obvious spelling
 * and the wrong one: `ring-*` is the same box-shadow channel `FOCUS_RING` uses,
 * so an inset resting ring made the keyboard focus ring inset too — measured as
 * `boxShadow: rgba(255,255,255,.15) inset` on a focused swatch, i.e. no visible
 * focus at all. The shadow channel and the ring channel compose; one edge each.
 */
const SWATCH_EDGE = 'shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)]';

interface ColorFieldProps {
    value: string;
    onChange: (hex: string) => void;
    label?: ReactNode;
    /** One line under the label, before the grid. */
    help?: ReactNode;
    /** The shortlist. */
    colors?: string[];
    /**
     * Colours another project already carries, hex → who has it. Marked with a
     * dot and named in the tile's title, so a library of 24 courses stops
     * collapsing onto one blue by accident.
     */
    inUse?: Record<string, string>;
    /**
     * Colours this library holds that the grid cannot reach — an imported or
     * seeded value, or one chosen before the palette changed. Without this row
     * they are unrecoverable the moment you click away from them.
     */
    library?: string[];
    /** Sentence beside the value field. Replaced by the parse error while typing. */
    hint?: ReactNode;
    /**
     * WHAT A CHIP IS PAINTED, when that is not the value it stands for.
     *
     * A project's colour is its own swatch and nothing else, and that is the
     * default. The PAGE TINT is not: the stored value is a pastel, and what
     * choosing it paints depends on the mode — the same rose is a pale card in
     * light and a deep maroon page in dark. A row of pastels in a dark app
     * offers sixteen colours the app will not show you.
     *
     * So the chip may be painted by a function of the value. Only the paint
     * moves: the value field, the eyedropper, the selection, the keyboard and
     * every label still work in the stored colour, because that is the thing
     * being chosen and the thing a person would type.
     */
    swatch?: (hex: string) => string;
}

export default function ColorField({
    value, onChange, label, help, colors = PROJECT_COLORS, inUse, library, hint,
    swatch = (hex) => hex,
}: ColorFieldProps) {
    const { t } = useTranslation();
    const [typed, setTyped] = useState(value);
    // The last value THIS component asked for. Without it the effect below
    // cannot tell a change it caused from one that arrived from elsewhere.
    const emittedRef = useRef<string | null>(null);

    // Follow the stored value when it changes ELSEWHERE — the assistant can set
    // the accent through the [[set:…]] contract, and a field still showing the
    // old value would be lying about what the app is using.
    //
    // But only then. Every keystroke that parses commits, so syncing on our own
    // change rewrote the field WHILE it was being typed: "hsl(150 70% 32%)"
    // parses as soon as "…32" lands, so the field snapped to "#188b52" and the
    // trailing "%)" was typed onto the end of that. A colour field that edits
    // your text under the cursor is unusable, and the live preview is what
    // confirms the value anyway.
    useEffect(() => {
        if (value === emittedRef.current) return;
        setTyped(value);
    }, [value]);

    const commit = (raw: string) => {
        const parsed = parseCssColor(raw);
        if (!parsed) return;  // not a colour yet — leave what they are typing alone
        emittedRef.current = parsed;
        onChange(parsed);
    };

    const parsedTyped = parseCssColor(typed);
    const invalid = typed.trim().length > 0 && !parsedTyped;
    // `<input type="color">` accepts `#rrggbb` and NOTHING else: handed '' or a
    // half-typed value it silently reports black, so the eyedropper would open on
    // black and a stray click would set it.
    const swatchValue = parsedTyped || parseCssColor(value) || '#000000';

    const index = colors.findIndex(c => sameColor(c, value));
    // The arrow keys have to walk the grid as it is DRAWN, so the measured count
    // is what both the layout and the keyboard read.
    const touch = useMediaQuery('(hover: none)');
    const { ref: rootRef, shape, columns } = useGridColumns(touch);
    const beside = shape === 'beside';
    const half = shape === 'dense';
    const { itemProps } = useRovingGrid({
        count: colors.length, index, columns,
        onSelect: i => onChange(colors[i]),
    });

    // A library colour is only worth offering when the grid cannot reach it.
    const extras = (library || [])
        .map(c => parseCssColor(c))
        .filter((c): c is string => !!c && !colors.some(p => sameColor(p, c)))
        .filter((c, i, all) => all.indexOf(c) === i);

    const owner = (color: string) => {
        if (!inUse) return undefined;
        const hex = parseCssColor(color);
        const key = hex && Object.keys(inUse).find(k => sameColor(k, hex));
        return key ? inUse[key] : undefined;
    };

    // THE EYEDROPPER, THE FIELD AND THE SENTENCE. One of each, wherever the
    // measured shape puts them — the wide shape only moves them, it does not
    // give them different behaviour, and the second copy of a control is how one
    // of them quietly becomes the bad one.
    //
    // Beside the palette it takes the block's own height (`self-stretch`, the
    // device the atlas chrome uses to make two neighbours read as one row), so
    // it lands as the swatch after the swatches rather than as a button that
    // happens to be nearby.
    const pipette = (
        <label
            className={cx('relative shrink-0 cursor-pointer', beside ? 'w-11 self-stretch' : 'h-10 w-10')}
            title={t("Pick any colour")}
        >
            <span className="sr-only">{t("Pick any colour")}</span>
            <span
                className="flex h-full w-full items-center justify-center rounded-lg border border-slate-300 dark:border-slate-600"
                style={{ backgroundColor: swatch(swatchValue) }}
            >
                <Pipette className="h-4 w-4 text-white [filter:drop-shadow(0_1px_1px_rgb(0_0_0/0.55))]" aria-hidden="true" />
            </span>
            <input
                type="color"
                value={swatchValue}
                onChange={e => { setTyped(e.target.value); emittedRef.current = e.target.value; onChange(e.target.value); }}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
        </label>
    );

    // The field is as wide as the values it holds and no wider — `#0369a1` is
    // eight characters, the longest thing anyone pastes here is
    // `hsl(192 82% 31%)`.
    const field = (
        <input
            type="text"
            value={typed}
            onChange={e => { setTyped(e.target.value); commit(e.target.value); }}
            onBlur={() => { if (!parseCssColor(typed)) setTyped(value); }}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            aria-label={t("Colour value")}
            aria-invalid={invalid}
            placeholder="#0e7490"
            className={cx(
                'w-36 max-w-full shrink-0 font-mono', FIELD_BASE, FIELD_SIZE.md,
                // A RING, not a border colour. `border-amber-500` loses to
                // `dark:border-slate-600` inside FIELD_BASE — Tailwind orders
                // its stylesheet by palette, slate after amber, so the class
                // string's order decides nothing and the field stayed slate
                // (measured: rgb(71 85 105) either way). The ring is a
                // different channel, so it simply shows.
                invalid && 'ring-1 ring-amber-500 dark:ring-amber-400',
            )}
        />
    );

    // Beside the palette the sentence goes UNDER the field, which is what makes
    // the value group as tall as the two rows of chips it stands next to; on its
    // own line it sits beside the field and wraps underneath below ~26rem.
    const sentence = (
        <p className={cx(
            'text-sm',
            beside ? 'mt-1.5' : 'min-w-0 flex-1 basis-48',
            invalid ? 'text-amber-700 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400',
        )}>
            {invalid
                ? t("Not a colour yet — try #0e7490, rgb(14 116 144) or hsl(192 82% 31%).")
                : hint || t("Hex, rgb() or hsl().")}
        </p>
    );

    return (
        // `w-full`, because THE SHAPE IS MEASURED ON THIS BOX and a box that
        // takes its width from its own contents makes that measurement
        // circular. A shrink-to-fit box is sized by its widest line — which
        // here is the hint sentence under the value field. That is how the Appearance
        // card came out with THREE different pickers on it: the page tint's
        // longer hint bought it 16 columns, the accent's shorter one left it at
        // 8 on its own line, and the app icon — the one in a plain block — got
        // the wide shape. Same component, same card, three shapes, decided by
        // the length of a sentence. A control is given its width; it does not
        // vote on it.
        <div ref={rootRef} className="w-full min-w-0">
            {label && (
                <p className="text-sm font-medium text-slate-900 dark:text-white mb-1">{label}</p>
            )}
            {help && <p className="text-sm text-slate-500 dark:text-slate-400 mb-2">{help}</p>}

            <div className={cx(beside && 'flex flex-wrap items-start gap-x-4 gap-y-3')}>
            <div
                className={cx(beside && 'flex flex-1 items-stretch gap-2')}
                // The palette group takes the slack and hands it to the chips,
                // between the floor a chip may not go under and the ceiling it
                // may not go over. It is the only thing in the row that grows.
                style={beside ? {
                    minWidth: `${groupRem(touch ? CHIP_TOUCH_REM : CHIP_REM)}rem`,
                    maxWidth: `${groupRem(CHIP_MAX_REM)}rem`,
                } : undefined}
            >
            <div
                role="radiogroup"
                aria-label={typeof label === 'string' ? label : t("Colour")}
                className={cx('grid', beside && 'min-w-0 flex-1')}
                style={{
                    // `1fr` in BOTH shapes now, but bounded in the wide one: the
                    // floor is the chip's own size (so the shape is never chosen
                    // for a chip that will not fit) and the ceiling is the group's
                    // `maxWidth` above. Unbounded is how the palette once became a
                    // 736px stripe with its value on a line underneath.
                    gridTemplateColumns: beside
                        ? `repeat(${columns}, minmax(${touch ? CHIP_TOUCH_REM : CHIP_REM}rem, 1fr))`
                        : `repeat(${columns}, minmax(0, 1fr))`,
                    // rem in the wide shape because the chips beside it are rem;
                    // px in the other two because the chip floor they are sized
                    // against (`MIN_DENSE_CHIP`) is a physical target, not type.
                    gap: beside ? `${BESIDE_GAP_REM}rem` : half ? DENSE_GAP : GAP,
                }}
            >
                {colors.map((color, i) => {
                    const selected = sameColor(color, value);
                    const taken = owner(color);
                    return (
                        <button
                            key={color}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            aria-label={taken ? t("{{color}} — used by {{name}}", { color, name: taken }) : color}
                            title={taken ? t("{{color}} — used by {{name}}", { color, name: taken }) : color}
                            onClick={() => onChange(color)}
                            {...itemProps(i)}
                            className={cx(
                                'relative rounded-lg transition-[filter,outline-color]',
                                // A chip half as wide is drawn half as tall, or the
                                // row reads as a bar chart; the touch floor is still
                                // a capability query, never a width. Beside the
                                // field it is a SQUARE at whatever width the track
                                // gives it — `aspect-square` is what keeps it one
                                // as it grows, and what makes the block get taller
                                // rather than turn into eight bricks.
                                beside ? 'w-full aspect-square'
                                    : half ? 'w-full h-7 touch:h-9'
                                        : 'w-full h-9 touch:h-11',
                                // A HAIRLINE ON EVERY CHIP. Slate sits within 1.4:1 of
                                // the dark panel it is drawn on, so without an edge the
                                // last swatch reads as a gap in the grid rather than a
                                // colour — and the same is true of anything pale in the
                                // light themes. An inset ring belongs to the chip, so it
                                // costs no layout and never fights the selection outline.
                                SWATCH_EDGE,
                                FOCUS_RING,
                                selected
                                    ? 'outline outline-2 outline-offset-2 outline-slate-900 dark:outline-white'
                                    : 'can-hover:hover:brightness-110',
                            )}
                            style={{ backgroundColor: swatch(color) }}
                        >
                            {selected && (
                                <Check
                                    className="absolute inset-0 m-auto h-4 w-4 text-white [filter:drop-shadow(0_1px_1px_rgb(0_0_0/0.55))]"
                                    strokeWidth={3}
                                    aria-hidden="true"
                                />
                            )}
                            {taken && !selected && (
                                <span
                                    className="absolute right-1 top-1 h-2 w-2 rounded-full bg-white ring-1 ring-black/45"
                                    aria-hidden="true"
                                />
                            )}
                        </button>
                    );
                })}
            </div>
                {beside && pipette}
            </div>
                {beside && (
                    // `shrink-0`, and no `grow`: the slack belongs to the
                    // chips. A value field that grows is how the row ended
                    // after this box with the rest of the card left empty.
                    <div className="min-w-0 shrink-0 basis-44">
                        {field}
                        {sentence}
                    </div>
                )}
            </div>

            {/* The legend draws the MARK, not a dot on the page background: a white
                dot with a dark ring is a dot on a colour and an empty circle on
                paper, so in the light themes the sentence pointed at nothing. It is
                a miniature swatch carrying the real dot, and it aligns to the first
                line rather than centring on a block that wraps to two on a phone. */}
            {inUse && Object.keys(inUse).length > 0 && (
                <p className="mt-2 flex items-start gap-2 text-sm text-slate-500 dark:text-slate-400">
                    {/* Square, not a 28×20 pill: at pill proportions with a dot on
                        the right it reads as a Switch, which is a control the app
                        really has. */}
                    <span className={cx('relative mt-0.5 h-5 w-5 shrink-0 rounded', SWATCH_EDGE, 'bg-slate-400 dark:bg-slate-500')} aria-hidden="true">
                        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-white ring-1 ring-black/45" />
                    </span>
                    {t("A dot marks a colour another project already uses")}
                </p>
            )}

            {extras.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm text-slate-500 dark:text-slate-400">{t("In your library")}</span>
                    {extras.map(color => {
                        const selected = sameColor(color, value);
                        const taken = owner(color);
                        return (
                            <button
                                key={color}
                                type="button"
                                aria-pressed={selected}
                                aria-label={taken ? t("{{color}} — used by {{name}}", { color, name: taken }) : color}
                                title={taken ? t("{{color}} — used by {{name}}", { color, name: taken }) : color}
                                onClick={() => onChange(color)}
                                className={cx(
                                    'h-7 w-9 touch:h-11 touch:w-11 rounded-lg transition-[filter,outline-color]',
                                    SWATCH_EDGE, FOCUS_RING,
                                    selected
                                        ? 'outline outline-2 outline-offset-2 outline-slate-900 dark:outline-white'
                                        : 'can-hover:hover:brightness-110',
                                )}
                                style={{ backgroundColor: swatch(color) }}
                            />
                        );
                    })}
                </div>
            )}

            {/* THE VALUE ROW, when the palette took the line to itself. */}
            {!beside && (
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                    {pipette}
                    {field}
                    {sentence}
                </div>
            )}
        </div>
    );
}
