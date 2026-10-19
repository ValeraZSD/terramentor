import { FocusEvent, forwardRef, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import { IconButton } from './Button';
import { FIELD_BASE, FIELD_SIZE, ControlSize, cx } from './vocabulary';
import { SettingHelp } from './SettingRow';

interface FieldShellProps {
    /** The visible label. Wired to the control by a generated id. */
    label?: ReactNode;
    /** One line under the label, before the control — say what the value means. */
    help?: ReactNode;
    /** One line under the control — say what happens after you change it. */
    hint?: ReactNode;
    /** Rendered right of the label (a status dot, a "connected" badge). */
    aside?: ReactNode;
    className?: string;
    children: (id: string) => ReactNode;
}

/**
 * Label / help / control / hint, in that order, always.
 *
 * Settings had every permutation of these four: help above the control in one
 * place and below it in the next, labels that were `<p>` and so clicked
 * nothing, and hints that repeated the label. The order is fixed here so a
 * reader learns it once: what this is, what it means, the control, what happens
 * next.
 */
export function Field({ label, help, hint, aside, className, children }: FieldShellProps) {
    const id = useId();
    return (
        <div className={cx('min-w-0', className)}>
            {(label || aside) && (
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-1">
                    {label && (
                        <label htmlFor={id} className="text-sm font-medium text-slate-900 dark:text-white cursor-pointer">
                            {label}
                        </label>
                    )}
                    {aside}
                </div>
            )}
            {/* Help and hint are PROSE, so they are read at the reading size
                (14px) and separated from the label by weight and colour, not by
                being shrunk to 12px. 12px is for badges, counters and code. */}
            {/* A short help is a line; a long one is a "More". The threshold is
                counted on the translated string, because how much screen a
                sentence takes is a fact about the language being read, not about
                the English it came from. A ReactNode help (one with a <code> in
                it) cannot be counted, so it stays inline as it always was. */}
            {help && (typeof help === 'string'
                ? <div className="mb-2"><SettingHelp text={help} /></div>
                : <p className="text-sm text-slate-500 dark:text-slate-400 mb-2">{help}</p>)}
            {children(id)}
            {hint && <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">{hint}</p>}
        </div>
    );
}

interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'className'> {
    size?: ControlSize;
    /** Icon inside the field's left edge (search, url). Decorative only. */
    icon?: ReactNode;
    className?: string;
}

/**
 * A text field on the app's field scale. It goes DOWN the surface ladder
 * (`bg-white dark:bg-slate-900`), which is what separates it from a button of
 * the same height sitting beside it.
 */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
    { size = 'md', icon, className, ...rest }, ref,
) {
    const field = <input ref={ref} className={cx('w-full', FIELD_BASE, FIELD_SIZE[size], icon ? 'pl-9' : '', className)} {...rest} />;
    if (!icon) return field;
    return (
        <div className="relative min-w-0">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 pointer-events-none" aria-hidden="true">
                {icon}
            </span>
            {field}
        </div>
    );
});

interface PasswordInputProps extends Omit<TextInputProps, 'type' | 'icon' | 'onBlur'> {
    /** Focus left the field AND its eye. Tabbing from the box to the eye is
     *  still inside the field, so a screen that saves on blur does not save
     *  (and test) a key the learner only wanted to look at first. */
    onBlur?: (e: FocusEvent<HTMLElement>) => void;
    /** What the field holds, which is what its toggle says: "Show password"
     *  for the app's own password, "Show the key" for a provider's API key. */
    kind?: 'password' | 'key';
    /** Controlled visibility, for a screen that reveals the secret itself (a
     *  key just generated). Left out, the field keeps its own, hidden at first. */
    shown?: boolean;
    onShownChange?: (shown: boolean) => void;
}

/**
 * A secret field with ONE show/hide control, inside its right edge.
 *
 * Edge draws its own eye inside every `type="password"` input and Chrome and
 * Firefox draw none, so the app's password fields had an eye on one browser
 * and nothing on the others, and the one field that added its own toggle
 * beside the box had TWO on Edge (the Connect dialog's API key, 2026-10-17).
 * The browser's is switched off in `index.css` (`::-ms-reveal`); this is the
 * one every browser gets.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
    { kind = 'password', size = 'md', className, shown: shownProp, onShownChange, onBlur, ...rest }, ref,
) {
    const { t } = useTranslation();
    const [shownOwn, setShownOwn] = useState(false);
    const shown = shownProp ?? shownOwn;
    const setShown = (v: boolean) => { setShownOwn(v); onShownChange?.(v); };
    const label = kind === 'key'
        ? (shown ? t("Hide the key") : t("Show the key"))
        : (shown ? t("Hide password") : t("Show password"));
    return (
        <div
            className={cx('relative min-w-0', className)}
            onBlur={onBlur && (e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onBlur(e); })}
        >
            <TextInput ref={ref} size={size} type={shown ? 'text' : 'password'} className="pr-10 touch:pr-12" {...rest} />
            <IconButton
                size="sm"
                className="absolute right-1 top-1/2 -translate-y-1/2"
                // Pressing the eye must not take the caret out of the field.
                onMouseDown={e => e.preventDefault()}
                onClick={() => setShown(!shown)}
                disabled={rest.disabled}
                label={label}
                icon={shown ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
            />
        </div>
    );
});

interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
    className?: string;
}

/**
 * The same field, several lines tall.
 *
 * It takes its padding from the `md` field rather than a height — a textarea is
 * sized in `rows` — so a name input and the description under it line up at the
 * left edge and share one radius, which two hand-written class strings in the
 * project dialog did not.
 */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
    { className, ...rest }, ref,
) {
    return <textarea ref={ref} className={cx('w-full px-3 py-2 text-sm', FIELD_BASE, className)} {...rest} />;
});

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'className'> {
    size?: ControlSize;
    /** Size to the widest option rather than to the container. Use it for a
     *  select that is a row's control; leave it off inside a `Field`. */
    fit?: boolean;
    className?: string;
}

/**
 * A native `<select>`, restyled to the field scale with one drawn chevron.
 *
 * Native on purpose: it is the only listbox that a phone renders as a native
 * wheel and a screen reader announces without help. For a list long enough to
 * need searching, use `ModelPicker`'s combobox instead — a `<select>` with 437
 * options is not a choice, it is a haystack.
 *
 * `fit` SIZES IT TO ITS OWN CONTENT instead of filling its container, and it is
 * what a select sitting beside a name in a setting row wants. The three pickers
 * in Language & region were `w-full sm:w-56`, `w-full sm:w-64` and a segmented
 * control: three different widths, none of them the width of anything else on
 * the screen, and on a phone all three were full-width blocks that pushed
 * themselves below their own labels. Every desktop OS sizes a popup button to
 * its widest option and parks it on the right of the row — so does this. The
 * browser measures the widest <option> for us, which also means the control
 * does not resize as the value changes.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
    { size = 'md', fit = false, className, children, ...rest }, ref,
) {
    return (
        // Fit, the wrapper is as wide as the select, or the chevron (placed on
        // the WRAPPER's right edge) floats at the far side of a block-level
        // parent, detached from the box it belongs to (seen 2026-10-02 in the
        // New course dialog, where a fit select sits in a Field).
        <div className={cx('relative min-w-0', fit ? 'w-fit max-w-full' : '')}>
            <select
                ref={ref}
                className={cx(fit ? 'w-auto max-w-full' : 'w-full', FIELD_BASE, FIELD_SIZE[size], 'appearance-none pr-9 cursor-pointer', className)}
                {...rest}
            >
                {children}
            </select>
            <ChevronDown
                className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 dark:text-slate-400 pointer-events-none"
                aria-hidden="true"
            />
        </div>
    );
});
