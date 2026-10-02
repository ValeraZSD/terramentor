import { useState, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';
import type { Toast } from '../types';
import Modal from './Modal';
import { useTranslation } from 'react-i18next';

const getIcon = (type: string) => {
    switch (type) {
        case 'success': return <CheckCircle className="w-5 h-5 text-green-500" />;
        case 'error': return <XCircle className="w-5 h-5 text-red-500" />;
        default: return <Info className="w-5 h-5 text-blue-500" />;
    }
};

const getBgColor = (type: string) => {
    switch (type) {
        case 'success': return 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800';
        case 'error': return 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800';
        default: return 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800';
    }
};

function ToastItem({ toast, onShowDetails, onDismiss, onHold, onRelease }: {
    toast: Toast;
    onShowDetails: (t: Toast) => void;
    onDismiss: (id: string) => void;
    /** The countdown stops while the pointer is over the toast or focus is inside it. */
    onHold: (id: string) => void;
    onRelease: (id: string) => void;
}) {
    const { t: tr } = useTranslation();
    const hover = useRef(false);
    const focus = useRef(false);
    const sync = () => (hover.current || focus.current ? onHold : onRelease)(toast.id);
    // Re-trigger the "blip" whenever the collapsed count ticks up (a duplicate arrived).
    const [blip, setBlip] = useState(false);
    const firstRender = useRef(true);
    useEffect(() => {
        if (firstRender.current) { firstRender.current = false; return; }
        setBlip(true);
        const t = setTimeout(() => setBlip(false), 400);
        return () => clearTimeout(t);
    }, [toast.count]);

    return (
        // Outer wrapper owns the one-shot entry animation; inner card owns the repeatable blip.
        // It is also the live region: an error is an alert (announced at once), anything
        // else a status (announced when the reader is idle). The card is NOT the button —
        // a `role="button"` around the dismiss button nested one control in another — so
        // the text is the details button and the dismiss button is its sibling.
        <div className="animate-slide-in" role={toast.type === 'error' ? 'alert' : 'status'}>
            <div
                onMouseEnter={() => { hover.current = true; sync(); }}
                onMouseLeave={() => { hover.current = false; sync(); }}
                onFocus={() => { focus.current = true; sync(); }}
                onBlur={(e) => {
                    // Focus moving between this card's own buttons is not leaving it.
                    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                    focus.current = false; sync();
                }}
                className={`flex items-start gap-3 p-4 rounded-xl border shadow-lg transition-all ${blip ? 'animate-toast-blip' : ''} ${getBgColor(toast.type)}`}
            >
                {getIcon(toast.type)}
                {toast.details ? (
                    <button
                        type="button"
                        onClick={() => onShowDetails(toast)}
                        className="flex-1 min-w-0 text-left cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                        <span className="block text-sm font-medium text-slate-900 dark:text-white">{toast.message}</span>
                        <span className="block text-sm text-slate-500 dark:text-slate-400 mt-1 truncate">
                            {tr("Click for details")}
                        </span>
                    </button>
                ) : (
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-900 dark:text-white">{toast.message}</p>
                    </div>
                )}
                {toast.count > 1 && (
                    <span
                        aria-label={tr("{{count}} occurrences", { count: toast.count })}
                        className="shrink-0 min-w-[1.25rem] h-5 px-1.5 inline-flex items-center justify-center rounded-full bg-slate-900/80 dark:bg-white/20 text-white text-xs font-semibold tabular-nums"
                    >
                        {toast.count}
                    </span>
                )}
                <button
                    onClick={(e) => { e.stopPropagation(); onDismiss(toast.id); }}
                    aria-label={tr("Dismiss notification")}
                    className="p-1 hover:bg-black/10 dark:hover:bg-white/10 rounded"
                >
                    <X className="w-4 h-4 text-slate-400" />
                </button>
            </div>
        </div>
    );
}

export default function ToastContainer() {
    const { t: tr } = useTranslation();
    const toasts = useStore(s => s.toasts);
    const removeToast = useStore(s => s.removeToast);
    const pauseToast = useStore(s => s.pauseToast);
    const resumeToast = useStore(s => s.resumeToast);
    const [detailToast, setDetailToast] = useState<Toast | null>(null);

    return (
        <>
            {/* `--assistant-w` is the width of the docked assistant panel (0 when
                it is closed or overlaying). Fixed positioning is relative to the
                viewport, which knows nothing about that column, so toasts would
                otherwise stack underneath it.

                `z-[60]`, not `z-50`: the assistant drawer and every Modal are
                also `fixed z-50`, and both render AFTER ToastContainer in
                Layout — so at equal z the later element wins and the toast was
                painted over completely. On a phone, where the drawer covers the
                whole screen, that meant a failed question reported its error
                behind the panel the learner was looking at: the send appeared to
                do nothing at all. It stays below ConfirmDialog (`z-[100]`),
                which is modal and must not be talked over. */}
            <div
                className="fixed top-4 z-[60] flex flex-col gap-2 max-w-sm"
                style={{ right: 'calc(1rem + var(--assistant-w, 0px))' }}
            >
                {toasts.map(toast => (
                    <ToastItem
                        key={toast.id}
                        toast={toast}
                        onShowDetails={setDetailToast}
                        onDismiss={removeToast}
                        onHold={pauseToast}
                        onRelease={resumeToast}
                    />
                ))}
            </div>

            <Modal
                isOpen={!!detailToast}
                onClose={() => setDetailToast(null)}
                title={detailToast?.type === 'error' ? tr("Error Details") : tr("Details")}
            >
                <div className="space-y-4">
                    <div className="flex items-start gap-3">
                        {detailToast && getIcon(detailToast.type)}
                        <div>
                            <p className="font-medium text-slate-900 dark:text-white">{detailToast?.message}</p>
                            {detailToast?.details && (
                                <pre className="mt-3 p-3 bg-slate-100 dark:bg-slate-800 rounded-lg text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-words">
                                    {detailToast.details}
                                </pre>
                            )}
                        </div>
                    </div>
                    <div className="flex justify-end">
                        <button
                            onClick={() => setDetailToast(null)}
                            className="px-4 py-2 bg-slate-900 dark:bg-slate-700 text-white rounded-xl hover:bg-slate-800 dark:hover:bg-slate-600"
                        >
                            {tr("Close")}
                        </button>
                    </div>
                </div>
            </Modal>
        </>
    );
}