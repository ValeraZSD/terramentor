import { useId, useRef } from 'react';
import { useStore } from '../store';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { AlertTriangle, Trash2, Info } from 'lucide-react';

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
            button: 'bg-red-600 hover:bg-red-700',
        },
        warning: {
            iconWrap: 'bg-amber-100 dark:bg-amber-900/30',
            icon: <AlertTriangle className="w-6 h-6 text-amber-600 dark:text-amber-400" />,
            button: 'bg-amber-600 hover:bg-amber-700',
        },
        info: {
            iconWrap: 'bg-accent/15',
            icon: <Info className="w-6 h-6 text-accent-fg" />,
            button: 'bg-accent hover:bg-accent/90',
        },
    }[dialog.variant] ?? {
        iconWrap: 'bg-accent/15',
        icon: <Info className="w-6 h-6 text-accent-fg" />,
        button: 'bg-accent hover:bg-accent/90',
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
                    <button
                        ref={cancelRef}
                        onClick={() => hideConfirm(false)}
                        className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-lg transition-colors"
                    >
                        {dialog.cancelLabel}
                    </button>
                    <button
                        onClick={() => hideConfirm(true)}
                        className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors ${V.button}`}
                    >
                        {dialog.confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}