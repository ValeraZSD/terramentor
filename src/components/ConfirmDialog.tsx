import { useId, useRef } from 'react';
import { useStore } from '../store';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { AlertTriangle, Trash2, Info } from 'lucide-react';
import { Button } from './ui/Button';

export default function ConfirmDialog() {
    const dialog = useStore(s => s.confirmDialog);
    const hideConfirm = useStore(s => s.hideConfirm);

    const cancelRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const titleId = useId();
    const messageId = useId();

    // Focus starts on Cancel (the safe answer), Tab stays inside, and Escape
    // answers "no" only when this is the topmost dialog — over a Modal it used
    // to close both.
    useDialogFocus(dialog.isOpen, dialogRef, {
        initialFocus: cancelRef,
        onEscape: (e) => { e.preventDefault(); hideConfirm(false); },
    });

    if (!dialog.isOpen) return null;

    // Three intents. `info` is the benign default (e.g. bulk upload): it must
    // read as a normal confirmation, never a red destructive one.
    const V = {
        danger: {
            iconWrap: 'bg-red-100 dark:bg-red-900/30',
            icon: <Trash2 className="w-6 h-6 text-red-600 dark:text-red-400" />,
            variant: 'confirmDanger' as const,
        },
        // Every warning here gives something up (discard, remove, stop), so
        // its confirm is the outlined red, not the filled colour that reads
        // as the safe answer — two strangers reached for it by reflex.
        warning: {
            iconWrap: 'bg-amber-100 dark:bg-amber-900/30',
            icon: <AlertTriangle className="w-6 h-6 text-amber-600 dark:text-amber-400" />,
            variant: 'danger' as const,
        },
        info: {
            iconWrap: 'bg-accent/15',
            icon: <Info className="w-6 h-6 text-accent-fg" />,
            variant: 'primary' as const,
        },
    }[dialog.variant] ?? {
        iconWrap: 'bg-accent/15',
        icon: <Info className="w-6 h-6 text-accent-fg" />,
        variant: 'primary' as const,
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div
                className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                onClick={() => hideConfirm(false)}
                aria-hidden="true"
            />
            <div
                ref={dialogRef}
                tabIndex={-1}
                className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 w-full max-w-sm overflow-hidden animate-scale-in outline-none"
                role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}
            >
                <div className="p-6">
                    <div className="flex items-start gap-4">
                        <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${V.iconWrap}`}>
                            {V.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3 id={titleId} className="text-lg font-semibold text-slate-900 dark:text-white">
                                {dialog.title}
                            </h3>
                            <p id={messageId} className="mt-2 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                                {dialog.message}
                            </p>
                        </div>
                    </div>
                </div>
                <div className="px-6 py-4 bg-slate-50 dark:bg-slate-700/50 border-t border-slate-200 dark:border-slate-700 flex items-center justify-end gap-3">
                    <Button ref={cancelRef} variant="quiet" onClick={() => hideConfirm(false)}>
                        {dialog.cancelLabel}
                    </Button>
                    {/* The one solid red in the app: carrying out a deletion
                        the reader already asked for (`confirmDanger`). */}
                    <Button variant={V.variant} onClick={() => hideConfirm(true)}>
                        {dialog.confirmLabel}
                    </Button>
                </div>
            </div>
        </div>
    );
}