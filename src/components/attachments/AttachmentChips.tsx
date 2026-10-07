import { useEffect, useRef } from 'react';
import { AlertCircle, FileSpreadsheet, FileText, ImageIcon, Presentation, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../../api';
import { IconButton } from '../ui/Button';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import type { ComposerFile, Refusal } from '../../hooks/useComposerAttachments';
import { ATTACH_MAX_BYTES, ATTACH_MAX_FILES, sizeLabel } from '../../utils/attachments';

/** The icon a file's card carries, by what its bytes turned out to be (or its name, before then). */
export function FileGlyph({ fileType, name, className = 'w-5 h-5' }: { fileType?: string | null; name?: string; className?: string }) {
    const t = (fileType || (name?.split('.').pop() ?? '')).toLowerCase();
    if (t === 'xlsx' || t === 'csv' || t === 'xls') return <FileSpreadsheet className={className} aria-hidden="true" />;
    if (t === 'pptx' || t === 'ppt') return <Presentation className={className} aria-hidden="true" />;
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif'].includes(t)) return <ImageIcon className={className} aria-hidden="true" />;
    return <FileText className={className} aria-hidden="true" />;
}

/** "PDF · 3 pages · 1.2 MB" — what a file card says under its name. */
export function fileFacts(t: TFunction, num: (n: number) => string, f: { fileType?: string | null; pages?: number | null; size: number; name: string }): string {
    const kind = (f.fileType || f.name.split('.').pop() || '').toLowerCase();
    const word = ({ pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint', text: t("Text") } as Record<string, string>)[kind] ?? kind.toUpperCase();
    const pages = f.pages ? (kind === 'pptx' ? t("{{count}} slides", { count: f.pages }) : t("{{count}} pages", { count: f.pages })) : null;
    return [word, pages, sizeLabel(f.size, num)].filter(Boolean).join(' · ');
}

/** A ring that fills as the upload goes, over the thumbnail or beside the name. */
function ProgressRing({ value, className = 'w-6 h-6' }: { value: number; className?: string }) {
    const r = 9;
    const c = 2 * Math.PI * r;
    return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
            <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
            <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
                strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.04, Math.min(1, value)))}
                transform="rotate(-90 12 12)" className="transition-[stroke-dashoffset] duration-200" />
        </svg>
    );
}

/** What a refusal says, in the learner's language. */
function refusalText(t: TFunction, num: (n: number) => string, r: Refusal): string {
    switch (r.reason) {
        case 'too_large': return t("{{name}} is larger than {{size}} MB.", { name: r.name, size: num(ATTACH_MAX_BYTES / 1024 / 1024) });
        case 'too_many': return t("{{name}} was not added: a message can carry at most {{count}} files.", { name: r.name, count: ATTACH_MAX_FILES });
        case 'heic':
        case 'heic_unreadable': return t("{{name}} is a HEIC photo, which this browser cannot open. Choose it from the photo library instead, or save it as JPEG.", { name: r.name });
        case 'empty': return t("{{name}} is empty.", { name: r.name });
        default: return t("{{name}} cannot be attached: videos, sound, archives and programs are not read here.", { name: r.name });
    }
}

/**
 * The files waiting in the composer, as chips above the text — a picture as its
 * thumbnail, anything else as a card with its name and what it is — each with
 * its ✕. An upload in progress shows a ring and keeps Send waiting; a failed one
 * turns red and says why. What was refused before uploading is a line under
 * the chips, with the reason, until it is dismissed or something else is added.
 */
export default function AttachmentChips({ files, refusals, onRemove, onDismissRefusals }: {
    files: ComposerFile[];
    refusals: Refusal[];
    onRemove: (key: string) => void;
    onDismissRefusals: () => void;
}) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    // A file just added is the one to see — its upload, or why it failed — so
    // the strip scrolls ITSELF to its end (never the page: utils/scrollWithin.ts).
    const listRef = useRef<HTMLUListElement>(null);
    const count = files.length;
    const lastCount = useRef(count);
    useEffect(() => {
        const list = listRef.current;
        if (list && count > lastCount.current) list.scrollLeft = list.scrollWidth;
        lastCount.current = count;
    }, [count]);
    if (!files.length && !refusals.length) return null;
    return (
        <div className="space-y-1.5">
            {files.length > 0 && (
                <ul ref={listRef} className="flex gap-2 overflow-x-auto overscroll-x-contain pt-1.5 pb-1 [scrollbar-width:thin]" aria-label={t("Attached files")}>
                    {files.map(f => {
                        const busy = f.state === 'preparing' || f.state === 'uploading';
                        const failed = f.state === 'failed';
                        const picture = f.preview || (f.kind === 'image' && f.server ? api.attachmentFileUrl(f.server.id) : null);
                        const status = busy
                            ? (f.state === 'preparing' ? t("Preparing…") : t("Uploading {{percent}}%", { percent: num(Math.round(f.progress * 100)) }))
                            : failed ? (f.error || t("Upload failed")) : null;
                        if (picture && !failed) {
                            return (
                                <li key={f.key} className="relative shrink-0" title={status ? `${f.name} — ${status}` : f.name}>
                                    <img src={picture} alt={f.name} className="block w-16 h-16 rounded-xl object-cover border border-slate-200 dark:border-slate-600 bg-slate-100 dark:bg-slate-700" />
                                    {busy && (
                                        <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/45 text-white" role="status" aria-label={status ?? undefined}>
                                            <ProgressRing value={f.state === 'preparing' ? 0.04 : f.progress} />
                                        </span>
                                    )}
                                    <button
                                        type="button"
                                        data-chip-remove
                                        onClick={() => onRemove(f.key)}
                                        aria-label={t("Remove {{name}}", { name: f.name })}
                                        title={t("Remove {{name}}", { name: f.name })}
                                        className="absolute -top-1.5 -right-1.5 flex items-center justify-center w-6 h-6 rounded-full bg-slate-800 text-white ring-2 ring-white dark:ring-slate-800 can-hover:hover:bg-slate-700 before:absolute before:-inset-2.5 before:content-[''] outline-none focus-visible:ring-accent"
                                    >
                                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                                    </button>
                                </li>
                            );
                        }
                        return (
                            <li
                                key={f.key}
                                className={`flex items-center gap-2 shrink-0 w-56 h-16 pl-2 pr-1 rounded-xl border bg-white dark:bg-slate-800 ${failed
                                    ? 'border-red-400 dark:border-red-500'
                                    : 'border-slate-200 dark:border-slate-600'}`}
                            >
                                <span className={`flex items-center justify-center w-10 h-10 shrink-0 rounded-lg ${failed
                                    ? 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300'
                                    : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-200'}`}>
                                    {busy ? <ProgressRing value={f.state === 'preparing' ? 0.04 : f.progress} className="w-6 h-6 text-accent-fg" />
                                        : failed ? <AlertCircle className="w-5 h-5" aria-hidden="true" />
                                            : <FileGlyph fileType={f.server?.fileType} name={f.name} />}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100">{f.name}</span>
                                    <span
                                        className={`block truncate text-xs ${failed ? 'text-red-600 dark:text-red-300' : 'text-slate-500 dark:text-slate-400'}`}
                                        title={status ?? undefined}
                                        role={busy || failed ? 'status' : undefined}
                                    >
                                        {status ?? fileFacts(t, num, { fileType: f.server?.fileType, pages: f.server?.pages, size: f.server?.size ?? f.size, name: f.name })}
                                    </span>
                                </span>
                                <IconButton size="sm" label={t("Remove {{name}}", { name: f.name })} icon={<X className="w-4 h-4" />} onClick={() => onRemove(f.key)} />
                            </li>
                        );
                    })}
                </ul>
            )}
            {refusals.length > 0 && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 px-2.5 py-1.5 text-xs leading-5 text-amber-900 dark:text-amber-100" role="alert">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    <ul className="min-w-0 flex-1 space-y-0.5">
                        {refusals.slice(0, 3).map((r, i) => <li key={i} className="break-words">{refusalText(t, num, r)}</li>)}
                        {refusals.length > 3 && <li>{t("…and {{count}} more files not added.", { count: refusals.length - 3 })}</li>}
                    </ul>
                    <IconButton size="sm" label={t("Dismiss")} icon={<X className="w-4 h-4" />} onClick={onDismissRefusals} className="-my-1 -mr-1" />
                </div>
            )}
        </div>
    );
}
