// src/components/creation/SourceFiles.tsx — the files a new course is built
// FROM, in the New project dialog.
//
// A dropped file is read at once (POST /api/documents/staged), so the dialog can
// say what the course will be made of before anything is generated: pages and
// characters read, the contents found and how ("from its bookmarks", "from its
// Contents page"), or why the file cannot shape the outline (a scan with no
// text layer, a file the server cannot read, one over the size cap). The
// parent owns the list and the requests; this draws them.
import { useRef, useState, type ReactNode } from 'react';
import { AlertCircle, BookOpen, FileText, FileX, Loader2, Plus, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { StagedDocument } from '../../types';
import { IconButton } from '../ui/Button';
import { cx, FOCUS_RING } from '../ui/vocabulary';
import { useMediaQuery } from '../../hooks/useMediaQuery';

/** One file in the dialog: being read, read, or refused before it was sent. */
export interface SourceFile {
    key: string;
    name: string;
    size: number;
    /** `reading` until the server answers. */
    status: 'reading' | 'done';
    doc?: StagedDocument;
    /** Refused here or by the request itself. */
    error?: string;
}

/** The per-file cap the server enforces (`MAX_FILE_BYTES`, server/extract.js). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const humanSize = (bytes: number) =>
    bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** A file the run can build from: read, with text in it. */
export const usableSource = (f: SourceFile) => f.status === 'done' && !!f.doc?.ok && !f.doc.noText;

export default function SourceFiles({ files, onAdd, onRemove, autoFocus = false }: {
    files: SourceFile[];
    onAdd: (files: File[]) => void;
    onRemove: (key: string) => void;
    /** Focus the empty drop zone on mount: it is the dialog's first step. */
    autoFocus?: boolean;
}) {
    const { t } = useTranslation();
    const inputRef = useRef<HTMLInputElement>(null);
    const [dragOver, setDragOver] = useState(false);
    const touch = useMediaQuery('(hover: none)');

    const take = (list: FileList | null) => {
        if (!list || list.length === 0) return;
        // A FileList is LIVE: clearing the input empties it, so copy first.
        const picked = Array.from(list);
        if (inputRef.current) inputRef.current.value = '';
        onAdd(picked);
    };

    // The zone is the full invitation only while it is empty; once a file is
    // in, the list is the content and the zone shrinks to a strip under it
    // (kept full size it pushed the name and the button a phone's height
    // away). A drop lands anywhere on the section.
    const any = files.length > 0;
    const choose = () => inputRef.current?.click();
    return (
        <div
            className={cx('min-w-0 rounded-xl', dragOver && any && 'ring-2 ring-accent')}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
            onDrop={e => { e.preventDefault(); setDragOver(false); take(e.dataTransfer.files); }}
        >
            {/* A heading only over a LIST: empty, the zone's own title says
                what to add, and "Course material" above it was the same thing
                in three stacked lines. */}
            {any && (
                <>
                    <p className="mb-1.5 text-sm font-medium text-slate-900 dark:text-white">{t("Course material")}</p>
                    <ul className="mb-1.5 space-y-1.5" aria-live="polite">
                        {files.map(f => <SourceRow key={f.key} file={f} onRemove={() => onRemove(f.key)} />)}
                    </ul>
                </>
            )}
            {/* ONE zone, the same element before and after: the full invitation
                while empty, a slim "Add more files" strip under the list once
                files are in. A button beside the heading instead made the top
                of the dialog jump on the first file, and what the learner had
                just used to add a file was gone when she wanted a second. */}
            <button
                type="button"
                onClick={choose}
                autoFocus={autoFocus && !any}
                className={cx(
                    'flex w-full items-center gap-3 rounded-xl border-2 border-dashed text-left transition-colors',
                    any ? 'px-3 py-1.5' : 'px-4 py-3',
                    FOCUS_RING,
                    // The dashed edge was slate-300 on white: the main target
                    // of the dialog, barely drawn in the light theme.
                    dragOver ? 'border-accent bg-accent/10' : 'border-slate-400 dark:border-slate-500 can-hover:hover:border-accent',
                )}
            >
                {any ? (
                    <>
                        <Plus className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                        <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{t("Add more files")}</span>
                    </>
                ) : (
                    <>
                        <Upload className="h-5 w-5 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                        <span className="min-w-0">
                            <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">
                                {/* "Add" everywhere: "Drop … here" assumed a drag
                                    the learner who most needs this does not make.
                                    A drag still works; the small print says so. */}
                                {t("Add a textbook, notes or past exams")}
                            </span>
                            <span className="block text-sm text-slate-500 dark:text-slate-400">
                                {/* The 25 MB cap is said where it matters: on a
                                    file over it. Up here it was one more clause
                                    every reader read once and no one needed. */}
                                {touch ? t("PDF, Word, PowerPoint, Excel or text") : t("PDF, Word, PowerPoint, Excel or text · or drop them here")}
                            </span>
                        </span>
                    </>
                )}
            </button>
            <input ref={inputRef} type="file" multiple className="hidden" onChange={e => take(e.target.files)} />
        </div>
    );
}

function SourceRow({ file, onRemove }: { file: SourceFile; onRemove: () => void }) {
    const { t } = useTranslation();
    const doc = file.doc;
    let icon = <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-500 dark:text-slate-400" aria-hidden="true" />;
    let line: ReactNode = t("Reading…");
    let tone = 'text-slate-500 dark:text-slate-400';
    let title: string | undefined;

    if (file.error || (doc && !doc.ok)) {
        icon = <AlertCircle className="h-4 w-4 shrink-0 text-red-500" aria-hidden="true" />;
        line = file.error || (doc && !doc.ok ? doc.error : '');
        tone = 'text-red-700 dark:text-red-300';
    } else if (doc?.ok && doc.noText) {
        // Not drawn as an error: an amber triangle on a screen about to be
        // confirmed read as "I did something wrong", amber text as a failure.
        // An amber FILE mark, the row's name quieter than the files that are
        // used, and one clause that says what happens to it. Longer versions
        // ("…so it is left out. A typed copy would work.") wrapped to three
        // lines on a phone and became the loudest text in the dialog.
        icon = <FileX className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
        line = t("No text found, so it will be skipped.");
    } else if (doc?.ok) {
        // Pages and chapters when the file has them, in the words a person
        // would use ("297 characters" or "139 sections" were numbers no one
        // could act on). The chapters are the TOP level of the contents; how
        // they were found is the tooltip.
        const s = doc.structure;
        const pages = doc.page_count
            ? (doc.file_type === 'pptx' ? t("{{count}} slides", { count: doc.page_count }) : t("{{count}} pages", { count: doc.page_count }))
            : '';
        const chapters = s.method !== 'none' && s.topCount > 1 ? t("{{count}} chapters", { count: s.topCount }) : '';
        title = s.method === 'bookmarks' ? t("Read from the PDF's bookmarks")
            : s.method === 'contents' ? t("Read from its printed Contents page")
                : s.method === 'headings' ? t("Read from its numbered headings") : undefined;
        // One icon colour for every file that is fine; only a problem is coloured.
        icon = s.method === 'none'
            ? <FileText className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
            : <BookOpen className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />;
        // A file with neither (plain text, notes) still says it was READ: a
        // row with nothing under its name looked as if it had been ignored.
        line = [pages, chapters].filter(Boolean).join(' · ') || t("Read in full");
    }

    // The chapter list that used to follow this line is gone: "139 sections"
    // already says the book was read, and the list was the noisiest line in
    // the dialog to two of three outside readers (2026-10-02). The size shows
    // only beside a failure, where it is the reason (the 25 MB cap).
    const failed = !!(file.error || (doc && !doc.ok));
    const leftOut = !!(doc?.ok && doc.noText);
    return (
        // The edge, light: bg-slate-50 alone on a white dialog barely drew the
        // row. Every row is the height of a two-line one, and a one-line row
        // CENTRES in it: rows of three heights in one list read as ragged, and a
        // name pinned to the top read as a row missing its second line.
        <li className={cx(
            'flex min-h-14 gap-3 rounded-lg border border-slate-200 bg-slate-100/70 px-3 py-2 dark:border-transparent dark:bg-slate-700/40',
            line ? 'items-start' : 'items-center',
        )}>
            <span className={cx(line && 'mt-0.5')}>{icon}</span>
            <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                    <span className={cx('min-w-0 truncate text-sm font-medium', leftOut ? 'text-slate-500 dark:text-slate-400' : 'text-slate-800 dark:text-slate-100')}>{file.name}</span>
                    {failed && <span className="shrink-0 text-sm text-slate-500 dark:text-slate-400">{humanSize(file.size)}</span>}
                </div>
                {line && <p className={cx('text-sm', tone)} title={title}>{line}</p>}
            </div>
            <IconButton size="sm" label={t("Remove {{name}}", { name: file.name })} icon={<X className="h-4 w-4" />} onClick={onRemove} />
        </li>
    );
}
