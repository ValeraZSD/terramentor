import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { Document } from '../types';
import {
    Download, FileText, FileSpreadsheet, FileCode, Presentation, File as FileIcon,
    Trash2, ExternalLink, Loader2, AlertCircle, X, Eye, Sigma,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n, { k } from '../i18n';
import { num } from '../utils/numberFormat';

// Anything binary that the server can't read as text is rejected on upload and
// surfaced as a "failed" doc, so we intentionally don't restrict selection here
// — a learner's reference material is anything (sql, ps1, bat, py, configs…).
// PDF/DOCX/XLSX/PPTX get a dedicated parser; everything else is accepted iff it
// decodes as text.

function extOf(name: string): string {
    const m = /\.([a-z0-9]+)$/i.exec(name);
    return m ? m[1].toLowerCase() : '';
}

function humanSize(bytes?: number | null): string {
    if (bytes === undefined || bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Compact "12,340 chars" for the amount of text extracted from a file.
function humanChars(n?: number | null): string {
    if (n === undefined || n === null) return '';
    return i18n.t("{{value}} chars", { count: n, value: num(n) });
}

// A short human label for how a PDF's dropped math was recovered, from the
// recovery_meta JSON ({ method, recovered, reason, cancelled, … }).
function recoveryDetail(meta?: string | null): { method: string; recovered: number; reason: string; cancelled: boolean } {
    try {
        const m = JSON.parse(meta || '{}');
        return { method: m.method || 'ocr', recovered: m.recovered || 0, reason: m.reason || '', cancelled: !!m.cancelled };
    } catch { return { method: 'ocr', recovered: 0, reason: '', cancelled: false }; }
}

// Why a recovery attempt produced nothing, in words the user can act on. The
// values are KEYS — every read site passes them through tr() — and k() marks
// them so the extractor keeps them in en.json.
const RECOVERY_FAIL_REASONS: Record<string, string> = {
    'no-vision-or-ocr': k('No vision model was available and OCR produced nothing — connect a vision model in Settings → AI & Models and re-run.'),
    'no-gain': k("Re-reading the rendered pages didn't beat the existing text layer."),
};

// Selecting more than this many files at once asks for confirmation before the
// (potentially slow, synchronous) batch upload — a guard against fat-finger drops.
const BULK_CONFIRM_THRESHOLD = 10;

// The vault list should read like a file explorer, not upload order: natural,
// case-insensitive, numeric-aware so "…B 2" sorts before "…B 10" (a plain
// string sort would interleave them) and "EN" before "Uitwerking".
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function sortDocs(docs: Document[]): Document[] {
    return [...docs].sort((a, b) =>
        NAME_COLLATOR.compare(a.title || a.original_filename || '', b.title || b.original_filename || ''));
}

// Extensions we treat as "code/markup" for iconography only (purely cosmetic).
const CODE_EXT = new Set([
    'ps1', 'bat', 'cmd', 'sh', 'sql', 'py', 'js', 'ts', 'tsx', 'jsx', 'json',
    'yaml', 'yml', 'xml', 'html', 'css', 'c', 'cpp', 'h', 'java', 'go', 'rs',
    'rb', 'php', 'toml', 'ini', 'conf', 'log',
]);

// Pick a display kind for an icon from the stored file_type plus the original
// filename (text-kind docs all share file_type='text', so we lean on the ext).
function displayKind(fileType?: string, filename?: string | null): string {
    if (fileType && fileType !== 'text') return fileType;
    const ext = extOf(filename || '');
    if (CODE_EXT.has(ext)) return 'code';
    return 'text';
}

function FileKindIcon({ type }: { type?: string }) {
    const cls = 'w-4 h-4 shrink-0';
    if (type === 'xlsx') return <FileSpreadsheet className={`${cls} text-emerald-500`} />;
    if (type === 'pdf') return <FileIcon className={`${cls} text-red-500`} />;
    if (type === 'docx') return <FileText className={`${cls} text-blue-500`} />;
    if (type === 'pptx') return <Presentation className={`${cls} text-orange-500`} />;
    if (type === 'code') return <FileCode className={`${cls} text-amber-500`} />;
    return <FileText className={`${cls} text-slate-500 dark:text-slate-400`} />;
}

interface VaultPanelProps {
    /** Live mode: upload immediately and attach to this project. */
    projectId?: number;
    /** Live mode: attach to a specific node instead of the whole project. */
    nodeId?: number;
    /** Staging mode (project not created yet): hold Files until creation. */
    stagedFiles?: File[];
    onStagedFilesChange?: (files: File[]) => void;
    className?: string;
}

/**
 * The project Vault. Drop any reference material — PDF/DOCX/XLSX/PPTX get a
 * dedicated parser, and any text-based file (sql, ps1, bat, py, configs, logs…)
 * is accepted as long as the server can read it as text. The backend extracts
 * the text, stores the original in a content-addressed blob store, and indexes
 * it so the AI can ground its answers in your own materials. Binary files the
 * server can't read are returned as "failed" with a reason.
 *
 * Two modes:
 *  - Live (projectId/nodeId set): uploads immediately, lists stored documents.
 *  - Staging (onStagedFilesChange set): collects Files in the creation modal so
 *    they survive switching between manual and AI creation; the parent uploads
 *    them once the project exists.
 */
export default function VaultPanel({
    projectId, nodeId, stagedFiles, onStagedFilesChange, className = '',
}: VaultPanelProps) {
    const { t: tr } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const showConfirm = useStore(s => s.showConfirm);
    const staging = !!onStagedFilesChange;

    const [docs, setDocs] = useState<Document[]>([]);
    const [loading, setLoading] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    // "View extracted text" modal state: the doc whose text we're showing, plus
    // its lazily-fetched content (docs list doesn't carry the full text).
    const [viewDoc, setViewDoc] = useState<Document | null>(null);
    const [viewText, setViewText] = useState<string | null>(null);
    const [viewLoading, setViewLoading] = useState(false);

    const openText = async (doc: Document) => {
        setViewDoc(doc);
        setViewText(null);
        setViewLoading(true);
        try {
            const { content } = await api.getDocumentText(doc.id);
            setViewText(content);
        } catch (e: any) {
            addToast('error', tr("Failed to load extracted text"), e.message);
            setViewText('');
        } finally {
            setViewLoading(false);
        }
    };

    // Docs the user manually sent to math recovery via the Σ button. When one of
    // them settles, toast the outcome — a manual action deserves a verdict even
    // when it's "nothing needed doing" (a silently vanishing badge reads as a bug).
    const manualRecoverIds = useRef<Set<number>>(new Set());
    const toastManualRecoveryOutcomes = (next: Document[]) => {
        for (const d of next) {
            if (!manualRecoverIds.current.has(d.id)) continue;
            if (d.recovery_status === 'running' || d.recovery_status === 'pending') continue;
            manualRecoverIds.current.delete(d.id);
            const { method, recovered, reason } = recoveryDetail(d.recovery_meta);
            if (d.recovery_status === 'recovered') {
                addToast('success', tr("Math recovered"), tr("\"{{title}}\": {{count}} pages re-read via {{method}}.", { title: d.title, count: recovered, method: method === 'vision' ? tr("a vision model") : method === 'mixed' ? tr("a vision model and OCR") : 'OCR' }));
            } else if (d.recovery_status === 'failed') {
                addToast('error', tr("Math recovery failed"), `"${d.title}": ${RECOVERY_FAIL_REASONS[reason] ? tr(RECOVERY_FAIL_REASONS[reason]) : tr("the pages could not be re-read.")}`);
            } else if (d.recovery_status === 'skipped') {
                addToast('info', tr("No recovery needed"), tr("\"{{title}}\": the text layer looks clean — no dropped formulas detected.", { title: d.title }));
            }
        }
    };

    // `silent` refreshes in place without flipping the loading spinner — used by
    // the background-recovery poller so the list doesn't flicker to "Loading…"
    // every few seconds while a doc is being re-read.
    const refresh = async (silent = false) => {
        if (staging || (!projectId && !nodeId)) return;
        if (!silent) setLoading(true);
        try {
            const next = sortDocs(await api.getDocuments(nodeId, projectId));
            toastManualRecoveryOutcomes(next);
            setDocs(next);
        } catch (e: any) {
            if (!silent) addToast('error', tr("Failed to load vault"), e.message);
        } finally {
            if (!silent) setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId, nodeId]);

    // While any PDF is having its math re-read in the background, poll (silently,
    // no loading flicker) so the badge advances on its own. Depend on the boolean,
    // not `docs`, so the interval isn't torn down and recreated on every poll.
    // projectId/nodeId are in the deps so a scope change re-creates the interval
    // with a fresh closure — otherwise it would keep polling the OLD scope.
    const recoveryActive = docs.some(d => d.recovery_status === 'running' || d.recovery_status === 'pending');
    useEffect(() => {
        if (!recoveryActive) return;
        const t = setInterval(() => refresh(true), 5000);
        return () => clearInterval(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recoveryActive, projectId, nodeId]);

    // Manually (re-)run math recovery — e.g. after connecting a vision model, to
    // upgrade an OCR result to clean LaTeX. Optimistically flips to 'pending' so
    // the poller above takes over.
    const handleRecover = async (doc: Document) => {
        try {
            await api.recoverDocument(doc.id);
            manualRecoverIds.current.add(doc.id);
            setDocs(ds => ds.map(d => (d.id === doc.id ? { ...d, recovery_status: 'pending' } : d)));
        } catch (e: any) {
            addToast('error', tr("Couldn't start math recovery"), e.message);
        }
    };

    const handleFiles = async (fileList: FileList | null) => {
        if (!fileList || fileList.length === 0) return;
        // No client-side filtering: the server decides what it can read as text
        // and returns a per-file accepted/declined result.
        const files = Array.from(fileList);
        if (inputRef.current) inputRef.current.value = '';
        if (files.length === 0) return;

        // Guard bulk drops/selections. Allowed (server takes up to 100 per batch),
        // but confirm first so an accidental "select all" doesn't silently ingest.
        if (files.length > BULK_CONFIRM_THRESHOLD) {
            const confirmed = await showConfirm({
                title: tr("Add {{length}} files?", { count: files.length, length: files.length }),
                message: tr("Add {{length}} documents to this project's vault. Each is text-extracted and indexed for AI context.", { count: files.length, length: files.length }),
                confirmLabel: tr("Add {{length}} files", { count: files.length, length: files.length }),
                variant: 'info',
            });
            if (!confirmed) return;
        }

        if (staging) {
            // Dedupe against already-staged files by name + size.
            const seen = new Set((stagedFiles || []).map(f => `${f.name}:${f.size}`));
            const merged = [...(stagedFiles || [])];
            files.forEach(f => {
                const key = `${f.name}:${f.size}`;
                if (!seen.has(key)) { merged.push(f); seen.add(key); }
            });
            onStagedFilesChange!(merged);
            return;
        }

        setUploading(true);
        try {
            const { documents } = await api.uploadDocumentFiles(files, { projectId, nodeId });
            const ok = documents.filter(d => d.ok).length;
            const failed = documents.filter(d => !d.ok);
            if (ok) addToast('success', tr("Added {{count}} files to the vault", { count: ok }));
            failed.forEach(f => addToast('error', tr("Couldn't read \"{{title}}\"", { title: f.title }), f.error));
            await refresh();
        } catch (e: any) {
            addToast('error', tr("Upload failed"), e.message);
        } finally {
            setUploading(false);
        }
    };

    const handleDeleteDoc = async (doc: Document) => {
        const confirmed = await showConfirm({
            title: tr("Remove file"),
            message: tr("Remove \"{{title}}\" from the vault? Its extracted text will no longer be used for AI context.", { title: doc.title }),
            confirmLabel: tr("Remove"),
            variant: 'danger',
        });
        if (!confirmed) return;
        try {
            await api.deleteDocument(doc.id);
            setDocs(prev => prev.filter(d => d.id !== doc.id));
        } catch (e: any) {
            addToast('error', tr("Failed to remove file"), e.message);
        }
    };

    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
    };

    const staged = stagedFiles || [];

    return (
        <div className={className}>
            <button
                type="button"
                onClick={() => inputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                disabled={uploading}
                className={`w-full flex flex-col items-center justify-center gap-1 px-4 py-5 border-2 border-dashed rounded-xl transition text-center
                    ${dragOver
                        ? 'border-accent bg-accent/10'
                        : 'border-slate-300 dark:border-slate-600 hover:border-accent'}`}
            >
                {uploading
                    ? <Loader2 className="w-5 h-5 text-accent-fg animate-spin" />
                    : <Download className="w-5 h-5 text-slate-400" />}
                <span className="text-sm font-medium text-slate-600 dark:text-slate-300">
                    {uploading ? tr("Processing…") : tr("Drop files or click to upload")}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                    {tr("PDF, Office & any text-based file (code, configs…) · used as AI context · max 25 MB each")}
                </span>
            </button>
            <input
                ref={inputRef}
                type="file"
                multiple
                onChange={e => handleFiles(e.target.files)}
                className="hidden"
            />

            {/* Staging-mode list (files held until the project is created) */}
            {staging && staged.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                    {staged.map((f, i) => (
                        <li key={`${f.name}:${f.size}:${i}`} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-700/40">
                            <FileKindIcon type={displayKind(undefined, f.name)} />
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm text-slate-700 dark:text-slate-200">{f.name}</div>
                                <div className="text-xs text-slate-500 dark:text-slate-400">{tr("{{humanSize}} · will be processed on create", { humanSize: humanSize(f.size) })}</div>
                            </div>
                            <button
                                type="button"
                                onClick={() => onStagedFilesChange!(staged.filter((_, idx) => idx !== i))}
                                title={tr("Remove")}
                                className="p-1 text-slate-500 dark:text-slate-400 hover:text-red-500"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {/* Live-mode list (stored documents) */}
            {!staging && (
                <div className="mt-3">
                    {loading ? (
                        <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 px-1 py-2">
                            <Loader2 className="w-4 h-4 animate-spin" /> {tr("Loading vault…")}
                        </div>
                    ) : docs.length === 0 ? (
                        <p className="text-sm text-slate-500 dark:text-slate-400 px-1 py-2">{tr("No files yet.")}</p>
                    ) : (
                        <ul className="space-y-1.5">
                            {docs.map(doc => (
                                <li key={doc.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-700/40">
                                    {doc.status === 'failed'
                                        ? <AlertCircle className="w-4 h-4 shrink-0 text-red-500" />
                                        : <FileKindIcon type={displayKind(doc.file_type, doc.original_filename)} />}
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-sm text-slate-700 dark:text-slate-200">{doc.title}</div>
                                        <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                                            {doc.status === 'failed'
                                                ? <span className="text-red-500">{tr("Failed: {{error}}", { error: doc.error })}</span>
                                                : <>
                                                    {(doc.file_type === 'text'
                                                        ? (extOf(doc.original_filename || '') || 'text')
                                                        : (doc.file_type || 'file')).toUpperCase()}
                                                    {doc.file_size ? ` · ${humanSize(doc.file_size)}` : ''}
                                                    {doc.page_count
                                                        ? ` · ${doc.file_type === 'pptx' ? tr("{{count}} slides", { count: doc.page_count }) : tr("{{count}} pages", { count: doc.page_count })}`
                                                        : ''}
                                                    {doc.char_count != null ? ` · ${humanChars(doc.char_count)}` : ''}
                                                    {doc.embedding_status === 'indexed'
                                                        ? <span className="text-emerald-500" title={tr("Indexed for semantic search")}> {tr("· indexed")}</span>
                                                        : ''}
                                                    {doc.recovery_status === 'running'
                                                        ? <span className="text-amber-500" title={tr("Re-reading dropped formulas from the rendered pages")}> · <Loader2 className="inline w-3 h-3 animate-spin -mt-0.5" /> {tr("recovering math")}</span>
                                                        : doc.recovery_status === 'pending'
                                                            ? <span className="text-slate-500 dark:text-slate-400" title={tr("Queued for math recovery — one file is processed at a time")}> {tr("· math queued")}</span>
                                                        : doc.recovery_status === 'recovered'
                                                            ? (() => {
                                                                const { method, recovered, cancelled } = recoveryDetail(doc.recovery_meta);
                                                                return <span className="text-emerald-500" title={`${tr("Recovered formulas on {{count}} pages via {{method}}", { count: recovered, method: method === 'vision' ? tr("a vision model") : method === 'mixed' ? tr("a vision model and OCR") : 'OCR' })}${cancelled ? tr(" — stopped early, some pages were not re-read") : ''}`}> {tr("· math recovered")}{method === 'ocr' ? tr("(OCR)") : ''}{cancelled ? tr("(partial)") : ''}</span>;
                                                            })()
                                                        : doc.recovery_status === 'failed'
                                                            ? (() => {
                                                                const { reason } = recoveryDetail(doc.recovery_meta);
                                                                return <span className="text-red-400" title={RECOVERY_FAIL_REASONS[reason] ? tr(RECOVERY_FAIL_REASONS[reason]) : tr("Math recovery failed — the pages could not be re-read.")}> {tr("· math recovery failed")}</span>;
                                                            })()
                                                            : ''}
                                                </>}
                                        </div>
                                    </div>
                                    {doc.status !== 'failed' && (
                                        <button
                                            type="button"
                                            onClick={() => openText(doc)}
                                            title={tr("View extracted text")}
                                            className="p-1 text-slate-500 dark:text-slate-400 hover:text-accent-fg"
                                        >
                                            <Eye className="w-4 h-4" />
                                        </button>
                                    )}
                                    {doc.file_hash && doc.status !== 'failed' && (
                                        <a
                                            href={api.documentOriginalUrl(doc.id)}
                                            target="_blank"
                                            rel="noreferrer"
                                            title={tr("Open original")}
                                            className="p-1 text-slate-500 dark:text-slate-400 hover:text-accent-fg"
                                        >
                                            <ExternalLink className="w-4 h-4" />
                                        </a>
                                    )}
                                    {doc.file_type === 'pdf' && doc.file_hash && doc.status !== 'failed'
                                        && doc.recovery_status !== 'running' && doc.recovery_status !== 'pending' && (
                                        <button
                                            type="button"
                                            onClick={() => handleRecover(doc)}
                                            title={doc.recovery_status === 'recovered'
                                                ? tr("Re-run math recovery (e.g. to upgrade OCR to a vision model)")
                                                : doc.recovery_status === 'skipped'
                                                    ? tr("Text layer looks clean — run math recovery anyway")
                                                : doc.recovery_status === 'failed'
                                                    ? tr("Retry math recovery")
                                                    : tr("Recover formulas dropped by the PDF text layer")}
                                            className="p-1 text-slate-500 dark:text-slate-400 hover:text-accent-fg"
                                        >
                                            <Sigma className="w-4 h-4" />
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => handleDeleteDoc(doc)}
                                        title={tr("Remove")}
                                        className="p-1 text-slate-500 dark:text-slate-400 hover:text-red-500"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {/* Extracted-text preview: shows exactly what the AI sees for this file. */}
            {viewDoc && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                    onClick={() => setViewDoc(null)}
                >
                    <div
                        className="flex flex-col w-full max-w-2xl max-h-[80vh] rounded-xl bg-white dark:bg-slate-800 shadow-xl border border-slate-200 dark:border-slate-700"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-700">
                            <FileText className="w-4 h-4 shrink-0 text-accent-fg" />
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">
                                    {viewDoc.title}
                                </div>
                                <div className="text-xs text-slate-500 dark:text-slate-400">
                                    {tr("Extracted text")}
                                    {viewText != null ? ` · ${humanChars(viewText.length)}` : ''}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setViewDoc(null)}
                                title={tr("Close")}
                                className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-auto p-4">
                            {viewLoading ? (
                                <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                                    <Loader2 className="w-4 h-4 animate-spin" /> {tr("Loading…")}
                                </div>
                            ) : viewText ? (
                                <pre className="whitespace-pre-wrap break-words text-xs text-slate-600 dark:text-slate-300 font-mono">
                                    {viewText}
                                </pre>
                            ) : (
                                <p className="text-sm text-slate-500 dark:text-slate-400">{tr("No text was extracted from this file.")}</p>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
