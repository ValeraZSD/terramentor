import { cloneElement, isValidElement, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from 'react';
import { MenuPopover, menuTriggerKeys } from './ui/Popover';

interface Props {
    /** The ⋮ button. Its `label` names the menu (and titles the phone's sheet). */
    trigger: ReactNode;
    /** `MenuItem`s. Any of them closes the menu when chosen. */
    children: ReactNode;
}

/**
 * A row's ⋮ menu: a `MenuPopover` on the trigger itself, so it floats beside
 * the ⋮ with a mouse and is the bottom sheet on a phone, with the menu's keys.
 */
export default function DropdownMenu({ trigger, children }: Props) {
    const [isOpen, setIsOpen] = useState(false);
    const buttonRef = useRef<HTMLElement>(null);

    // The trigger IS the control: it is a real button, so its own Enter and
    // Space reach the click below and it carries the menu's state. Wrapped in a
    // focusable button-role div it was a button inside a button and two Tab stops.
    if (!isValidElement(trigger)) return null;
    const label = (trigger.props as { label?: string }).label ?? '';
    const control = cloneElement(trigger as ReactElement<Record<string, unknown>>, {
        ref: buttonRef,
        'aria-haspopup': 'menu', 'aria-expanded': isOpen,
        // The row under it opens on a click: the ⋮ is not the row.
        onClick: (e: ReactMouseEvent) => { e.stopPropagation(); setIsOpen(o => !o); },
        onKeyDown: menuTriggerKeys(() => setIsOpen(true)),
    });

    return (
        <>
            {control}
            <MenuPopover open={isOpen} onClose={() => setIsOpen(false)} anchorRef={buttonRef} label={label} align="end">
                <div role="none" onClick={() => setIsOpen(false)}>
                    {children}
                </div>
            </MenuPopover>
        </>
    );
}
