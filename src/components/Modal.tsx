import { ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTapGuard } from '../hooks/useTapGuard';
import { usePortalAccent } from '../hooks/usePortalAccent';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: ReactNode;
    maxWidth?: string;
    className?: string;
}

export default function Modal({ isOpen, onClose, title, children, maxWidth = 'max-w-3xl', className = '' }: Props) {
    const { t } = useTranslation();
    useEffect(() => {
        if (isOpen) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
        return () => {
            document.body.style.overflow = '';
        };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [isOpen, onClose]);

    // Dismiss on a backdrop TAP, not on any click that happens to land there —
    // dragging a selection out of the dialog (a quiz explanation, a flashcard
    // being edited) very often lifts over the backdrop, and that closed the
    // dialog and threw the selection away.
    const backdrop = useTapGuard(onClose, true);

    // A dialog is rendered at the end of the BODY, never where it was written.
    // `opacity`, `transform` and `filter` on ANY ancestor make that ancestor the
    // stacking context (and the last two the containing block) of a
    // `position: fixed` child, so the dialog stops being a full-screen overlay
    // and starts being part of whatever it was written inside. The archived and
    // completed project grids dim themselves with `opacity-70`: every dialog
    // opened from a card there — Edit Project, Export, Add material — was drawn
    // at 70% alpha with the cards behind bleeding through it.
    // The portal leaves the subtree the workspace themes with the project's
    // colour (`Layout` sets these two vars on a descendant of <html>), so read
    // them where the dialog was WRITTEN and carry them across.
    const { anchor, accent } = usePortalAccent(isOpen);

    if (!isOpen) return null;

    return (
        <>
            <span ref={anchor} className="hidden" aria-hidden="true" />
            {createPortal((
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={accent}>
                    <div className="absolute inset-0 bg-black/50" {...backdrop} aria-hidden="true" />
                    <div className={`relative bg-white dark:bg-slate-800 rounded-2xl shadow-xl w-full ${maxWidth} max-h-[90vh] overflow-auto ${className}`} role="dialog" aria-modal="true">
                        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700">
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{title}</h2>
                            <button
                                onClick={onClose}
                                aria-label={t("Close dialog")}
                                className="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg"
                            >
                                <X className="w-5 h-5 text-slate-400" />
                            </button>
                        </div>
                        <div className="px-6 py-4">
                            {children}
                        </div>
                    </div>
                </div>
            ), document.body)}
        </>
    );
}