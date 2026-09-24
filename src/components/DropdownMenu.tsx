import { useEffect, useRef, useState } from 'react';
import { onActivateKey } from '../utils/a11y';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface Props {
    trigger: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}

export default function DropdownMenu({ trigger, children, className = '' }: Props) {
    const { t } = useTranslation();
    const [isOpen, setIsOpen] = useState(false);
    const [position, setPosition] = useState({ top: 0, left: 0 });
    const triggerRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (isOpen && triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            const menuWidth = 144; // w-36 = 9rem = 144px

            let left = rect.right - menuWidth;
            let top = rect.bottom + 4;

            // Adjust if menu would go off screen
            if (left < 8) left = 8;
            if (left + menuWidth > window.innerWidth - 8) {
                left = window.innerWidth - menuWidth - 8;
            }

            // Check if menu would go below viewport
            const menuHeight = 100; // Approximate
            if (top + menuHeight > window.innerHeight - 8) {
                top = rect.top - menuHeight - 4;
            }

            setPosition({ top, left });
        }
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

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            document.addEventListener('scroll', handleScroll, true);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('scroll', handleScroll, true);
        };
    }, [isOpen]);

    return (
        <>
            <div
                ref={triggerRef}
                onClick={(e) => {
                    e.stopPropagation();
                    setIsOpen(!isOpen);
                }}
                onKeyDown={onActivateKey(() => setIsOpen(!isOpen))}
                role="button"
                tabIndex={0}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-label={t("Open menu")}
            >
                {trigger}
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