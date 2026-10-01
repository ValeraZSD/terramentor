import { cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { placePopover } from './ui/Popover';

interface Props {
    trigger: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}

export default function DropdownMenu({ trigger, children, className = '' }: Props) {
    const [isOpen, setIsOpen] = useState(false);
    const [position, setPosition] = useState({ top: 0, left: 0 });
    const triggerRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    // Placed from the menu's MEASURED box, before paint. It assumed 144px wide
    // and ~100px tall — true of `w-36` only at 100% `ui_scale`, so at 160% the
    // menu (230px) started 86px left of the ⋮ it belongs to.
    useLayoutEffect(() => {
        if (!isOpen || !triggerRef.current || !menuRef.current) return;
        const p = placePopover(
            triggerRef.current.getBoundingClientRect(),
            { width: menuRef.current.offsetWidth, height: menuRef.current.offsetHeight },
            { width: window.innerWidth, height: window.innerHeight },
            { align: 'end' },
        );
        setPosition({ top: p.top, left: p.left });
    }, [isOpen]);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (
                menuRef.current &&
                !menuRef.current.contains(e.target as Node) &&
                triggerRef.current &&
                !triggerRef.current.contains(e.target as Node)
            ) {
                setIsOpen(false);
            }
        };

        const handleScroll = () => {
            setIsOpen(false);
        };

        // Escape closes it and hands focus back to the ⋮ — claimed in the
        // capture phase, so a page or drawer listening for Escape does not
        // also act on the press that only meant "close this menu".
        const handleKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            setIsOpen(false);
            triggerRef.current?.querySelector<HTMLElement>('button, [tabindex]')?.focus();
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            document.addEventListener('scroll', handleScroll, true);
            document.addEventListener('keydown', handleKey, true);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('scroll', handleScroll, true);
            document.removeEventListener('keydown', handleKey, true);
        };
    }, [isOpen]);

    // The trigger IS the control: it is a real button, so its own Enter and
    // Space reach the click below and it carries the menu's state. Wrapped in a
    // focusable button-role div it was a button inside a button and two Tab stops.
    const control = isValidElement(trigger)
        ? cloneElement(trigger as ReactElement<Record<string, unknown>>, { 'aria-haspopup': 'menu', 'aria-expanded': isOpen })
        : trigger;

    return (
        <>
            <div
                ref={triggerRef}
                onClick={(e) => {
                    e.stopPropagation();
                    setIsOpen(!isOpen);
                }}
            >
                {control}
            </div>

            {isOpen && createPortal(
                <div
                    ref={menuRef}
                    className={`fixed z-[9999] w-36 bg-white dark:bg-slate-700 rounded-xl shadow-lg border border-slate-200 dark:border-slate-600 py-1 ${className}`}
                    style={{ top: position.top, left: position.left }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div onClick={() => setIsOpen(false)} role="presentation">
                        {children}
                    </div>
                </div>,
                document.body
            )}
        </>
    );
}