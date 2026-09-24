import { forwardRef, ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { CONTROL_BASE, CONTROL_SIZE, CONTROL_SIZE_ICON, CONTROL_VARIANT, ControlSize, ControlVariant, cx } from './vocabulary';

interface Common {
    variant?: ControlVariant;
    size?: ControlSize;
    /** Icon before the label. Sized here so no call site picks its own. */
    icon?: ReactNode;
    /** Icon after the label (a chevron, an external-link arrow). */
    trailing?: ReactNode;
    /** Swaps the leading icon for a spinner and disables the button. */
    busy?: boolean;
    /** Stretches to the container — a phone-width primary action. */
    block?: boolean;
    className?: string;
    children?: ReactNode;
}

type ButtonProps = Common & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'>;
type LinkProps = Common & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children' | 'className'> & { href: string };

const shape = ({ variant = 'neutral', size = 'md', block }: Common) =>
    cx(CONTROL_BASE, CONTROL_SIZE[size], CONTROL_VARIANT[variant], block && 'w-full');

/**
 * The app's button. Every `<button>` outside a purpose-built widget goes
 * through this, so that height, radius, focus ring and hover state are decided
 * once instead of 186 times. See `vocabulary.ts` for what the sizes mean.
 *
 * A `busy` button keeps its label and swaps its icon for a spinner: replacing
 * the text with "Loading…" makes the row change width mid-press, and the label
 * is the only thing that says what is loading.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { variant, size, icon, trailing, busy, block, className, children, disabled, type = 'button', ...rest }, ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            disabled={disabled || busy}
            aria-busy={busy || undefined}
            className={cx(shape({ variant, size, block }), className)}
            {...rest}
        >
            {busy ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" aria-hidden="true" /> : icon}
            {children}
            {trailing}
        </button>
    );
});

/** Same shape, rendered as a link. `<a>` for navigation, `<button>` for actions. */
export const ButtonLink = forwardRef<HTMLAnchorElement, LinkProps>(function ButtonLink(
    { variant, size, icon, trailing, block, className, children, ...rest }, ref,
) {
    return (
        <a ref={ref} className={cx(shape({ variant, size, block }), 'no-underline', className)} {...rest}>
            {icon}{children}{trailing}
        </a>
    );
});

interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'trailing' | 'block' | 'children'> {
    /** Required: an icon-only control is invisible to a screen reader without it. */
    label: string;
    icon: ReactNode;
    /** Show the label as a tooltip too (default on — the icon is rarely obvious). */
    tooltip?: boolean;
}

/**
 * A square control that is only an icon. `label` is mandatory and becomes both
 * the accessible name and the tooltip: an icon-only button with neither is a
 * mystery to everyone, not only to a screen reader.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
    { variant = 'quiet', size = 'md', label, icon, tooltip = true, busy, className, disabled, type = 'button', ...rest }, ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            aria-label={label}
            title={tooltip ? label : undefined}
            disabled={disabled || busy}
            aria-busy={busy || undefined}
            className={cx(CONTROL_BASE, CONTROL_SIZE_ICON[size], CONTROL_VARIANT[variant], 'shrink-0', className)}
            {...rest}
        >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : icon}
        </button>
    );
});
