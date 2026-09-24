/**
 * THE CONTROL VOCABULARY.
 *
 * The app had a colour system (accent tokens, the surface ladder, four themes)
 * and no SIZE system, so every control was sized at its call site: 186 buttons
 * in 50 distinct shapes, five different heights on the Settings page alone
 * (28 / 32 / 40 / 44 / 48px). Each one was locally defensible and no two agreed,
 * which is what "a rainbow of variation" looks like from the outside.
 *
 * The rule these constants exist to enforce: **shape carries meaning**. Height
 * says how important the control is, radius says what KIND of thing it is, fill
 * says what it does. When those vary for any other reason the reader has to
 * re-read every row, and the real distinctions have nothing left to say them
 * with.
 *
 * Three heights, and that is the whole scale:
 *
 *   sm  32px  a chip or an inline action inside a dense row (card toolbars,
 *             filter pills). Never a primary action, never alone on a phone.
 *   md  40px  THE DEFAULT. Every button, field and select in a settings row,
 *             a panel, a dialog footer.
 *   lg  44px  a primary action in a form, and anything whose whole job is to
 *             be pressed on a phone.
 *
 * Every size also carries `touch:min-h-11`, so a finger always gets its 44px
 * even where a mouse gets 32 or 40 — input capability is a media query here,
 * never a width breakpoint (see `can-hover:` / `touch:` in tailwind.config.js).
 *
 * Radius is a TYPE, not a taste:
 *   rounded-lg    every control (button, field, select, stepper, segment)
 *   rounded-xl    a panel or card — so a control never reads as a card
 *   rounded-full  a switch, a status pill, an avatar — things that are not boxes
 *
 * Focus is not optional and not a per-site decision: `FOCUS_RING` goes on every
 * interactive element. It uses no ring-offset on purpose — an offset paints the
 * ring's inner gap in `--tw-ring-offset-color` (white by default), which is
 * wrong on three of the four themes.
 */

/** Ring every interactive control shares. Keyboard-only, never on a mouse press. */
export const FOCUS_RING =
    'outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-0';

/** Base shape every control shares: layout, radius, weight, motion, touch floor. */
export const CONTROL_BASE =
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium ' +
    'transition-colors [touch-action:manipulation] select-none ' +
    'disabled:opacity-45 disabled:cursor-default ' + FOCUS_RING;

export type ControlSize = 'sm' | 'md' | 'lg';

/** Height + horizontal padding + type size. The ONLY three sizes in the app. */
export const CONTROL_SIZE: Record<ControlSize, string> = {
    sm: 'h-8 px-2.5 text-xs touch:min-h-11',
    md: 'h-10 px-3.5 text-sm touch:min-h-11',
    lg: 'h-11 px-4 text-sm',
};

/** Square variant of the same scale, for a control that is only an icon. */
export const CONTROL_SIZE_ICON: Record<ControlSize, string> = {
    sm: 'h-8 w-8 touch:min-h-11 touch:min-w-11',
    md: 'h-10 w-10 touch:min-h-11 touch:min-w-11',
    lg: 'h-11 w-11',
};

/**
 * What a control DOES, in four fills plus danger. A screen should hold exactly
 * one `primary` — the thing you came to the screen to do.
 */
export type ControlVariant = 'primary' | 'neutral' | 'subtle' | 'quiet' | 'danger';

export const CONTROL_VARIANT: Record<ControlVariant, string> = {
    // The one action this screen is for. White on accent is the house pattern
    // (see the button-colour convention: saturated hues take white labels).
    primary: 'bg-accent text-white can-hover:hover:bg-accent/90 active:bg-accent/80 shadow-sm',
    // The default. An outline, so it never competes with `primary` but still
    // reads as a control at rest — which a text-only button does not.
    neutral: 'border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 ' +
        'can-hover:hover:bg-slate-50 dark:can-hover:hover:bg-slate-700/60 active:bg-slate-100 dark:active:bg-slate-700',
    // A filled neutral, for a control that sits ON a card rather than in a row
    // of them (a toolbar button, a refresh beside a heading).
    subtle: 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 ' +
        'can-hover:hover:bg-slate-200 dark:can-hover:hover:bg-slate-600',
    // No resting chrome at all: only for an action whose meaning is carried by
    // its icon or its place (a close X, a row's overflow menu).
    quiet: 'text-slate-600 dark:text-slate-300 ' +
        'can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-700/60 can-hover:hover:text-slate-900 dark:can-hover:hover:text-white',
    // Destructive. Outline at rest — a solid red button invites the accident it
    // is warning about.
    danger: 'border border-red-300 dark:border-red-800/80 text-red-700 dark:text-red-300 ' +
        'can-hover:hover:bg-red-50 dark:can-hover:hover:bg-red-950/40',
};

/**
 * A FIELD (input, select, textarea) is not a button: it goes DOWN the surface
 * ladder, never up. `bg-white dark:bg-slate-900` on a `dark:bg-slate-800` panel.
 * Two adjacent fields in Settings used to disagree about this — one went to
 * slate-900 and the other to slate-700 — which is why it is a constant now.
 */
export const FIELD_BASE =
    // No width here on purpose: `w-full` baked into the base beat a caller's
    // `w-auto` (Tailwind orders by its own stylesheet, not by class order), which
    // collapsed a filter box next to an auto-width select. Width is the caller's.
    'rounded-lg border border-slate-300 dark:border-slate-600 ' +
    'bg-white dark:bg-slate-900 text-slate-900 dark:text-white ' +
    'placeholder:text-slate-400 dark:placeholder:text-slate-500 ' +
    'transition-colors focus-visible:border-accent ' +
    'disabled:opacity-45 disabled:cursor-default ' + FOCUS_RING;

/** Field heights match the control scale so a row of both lines up exactly. */
export const FIELD_SIZE: Record<ControlSize, string> = {
    sm: 'h-8 px-2.5 text-xs touch:min-h-11',
    md: 'h-10 px-3 text-sm touch:min-h-11',
    lg: 'h-11 px-3.5 text-sm',
};

/** Join class strings, dropping the falsy ones. */
export const cx = (...parts: (string | false | null | undefined)[]) =>
    parts.filter(Boolean).join(' ');
