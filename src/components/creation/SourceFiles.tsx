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
import { AlertCircle, BookOpen, FileText, FileX, FolderOpen, Loader2, Plus, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { StagedDocument } from '../../types';
import { useStore } from '../../store';
import { Button, IconButton } from '../ui/Button';
import { MenuItem, MenuPopover, menuTriggerKeys } from '../ui/Popover';
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

/** What a FOLDER is filtered to: the kinds the server reads (`extractText`:
 *  PDF and Office by their parsers, the rest as text). A picked file is sent
 *  whatever it is and the server says why it cannot be read; a folder is
 *  whatever happened to be in it — images, `.DS_Store`, an Office lock file —
 *  and a row of refusals for those would bury the files that matter. */
const READABLE = /\.(pdf|docx|pptx|xlsx|txt|md|markdown|csv|tsv|tex|html?)$/i;
const readableInFolder = (f: File) => READABLE.test(f.name) && !/^[.~]/.test(f.name);
/** What one course takes: the creation route reads the first hundred. */
export const MAX_SOURCE_FILES = 100;
/** How many files a dropped folder is walked for before the walk stops: a
 *  whole home directory dropped by accident must not hang the dialog. */
const WALK_LIMIT = 1000;

/**
 * What a DROP holds, folders walked. `dataTransfer.files` lists a dropped
 * folder as one empty File that no server can read, so the entries are taken
 * instead — SYNCHRONOUSLY, before the first await, because the browser empties
 * the transfer once the event returns. Loose files are sent as they are, like
 * picked ones; a folder's contents are filtered like a picked folder's.
 */
async function droppedFiles(dt: DataTransfer): Promise<{ loose: File[]; inFolder: File[] | null }> {
    const all = Array.from(dt.files);
    const entries = Array.from(dt.items ?? [])
        .filter(i => i.kind === 'file')
        .map(i => i.webkitGetAsEntry?.() ?? null);
    if (!entries.length || entries.some(e => !e) || !entries.some(e => e!.isDirectory)) {
        return { loose: all, inFolder: null };
    }
    const loose: File[] = [];
    const inFolder: File[] = [];
    const asFile = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    const walk = async (dir: FileSystemDirectoryEntry) => {
        const reader = dir.createReader();
        // readEntries hands a directory over in batches (100 in Chromium)
        // and an empty batch means the end.
        for (;;) {
            const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
            if (!batch.length) return;
            for (const entry of batch) {
                if (inFolder.length >= WALK_LIMIT) return;
                // A hidden folder (.git, .venv) is never course material.
                if (entry.isDirectory && !entry.name.startsWith('.')) await walk(entry as FileSystemDirectoryEntry);
                else if (entry.isFile) inFolder.push(await asFile(entry as FileSystemFileEntry));
            }
        }
    };
    for (const entry of entries as FileSystemEntry[]) {
        try {
            if (entry.isDirectory) await walk(entry as FileSystemDirectoryEntry);
            else loose.push(await asFile(entry as FileSystemFileEntry));
        } catch { /* an entry the browser will not open is skipped, like a hidden file */ }
    }
    return { loose, inFolder };
}

export default function SourceFiles({ files, onAdd, onRemove }: {
    files: SourceFile[];
    onAdd: (files: File[]) => void;
    onRemove: (key: string) => void;
}) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const inputRef = useRef<HTMLInputElement>(null);
    const folderRef = useRef<HTMLInputElement>(null);
    const addRef = useRef<HTMLButtonElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const touch = useMediaQuery('(hover: none)');

    /** `loose` files are sent whatever they are and the server says why one
     *  cannot be read; `inFolder` (a picked or dropped folder's contents) is
     *  filtered to what a course is read from. Callers copy a FileList into an
     *  array BEFORE this runs: a FileList is live, and clearing the input
     *  below empties it. */
    const take = (loose: File[], inFolder: File[] | null = null) => {
        for (const input of [inputRef.current, folderRef.current]) if (input) input.value = '';
        let fromFolder: File[] = [];
        if (inFolder) {
            fromFolder = inFolder.filter(readableInFolder);
            if (!fromFolder.length && !loose.length) {
                addToast('info', t("Nothing in that folder can be read"), t("A course is made from PDF, Word, PowerPoint, Excel or text files."));
                return;
            }
            const room = Math.max(0, MAX_SOURCE_FILES - files.length - loose.length);
            if (fromFolder.length > room) {
                addToast('info', t("Part of the folder was left out"), t("A course is made from at most 100 files."));
                fromFolder = fromFolder.slice(0, room);
            } else if (fromFolder.length < inFolder.length) {
                addToast('info', t("Part of the folder was left out"), t("A course is made from PDF, Word, PowerPoint, Excel or text files."));
            }
        }
        const picked = [...loose, ...fromFolder];
        if (picked.length) onAdd(picked);
    };

    const any = files.length > 0;
    const chooseFiles = () => inputRef.current?.click();
    // A folder where the browser can open one. A phone's picker cannot (and
    // where it pretends to, it hands back nothing), so on touch "Add" goes
    // straight to the files.
    const canFolder = !touch;
    const add = () => (canFolder ? setMenuOpen(o => !o) : chooseFiles());

    return (
        // LAST in the dialog and optional: a course is made from a name and a
        // goal, and FROM files only when there are some (2026-10-06).
        // At the bottom, the list grows where nothing is under it, so a file
        // arriving moves nothing the learner has already filled in. A drop
        // lands anywhere on the section.
        <div
            className={cx('min-w-0 rounded-xl', dragOver && any && 'ring-2 ring-accent ring-offset-4 ring-offset-white dark:ring-offset-slate-800')}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
            // A folder drops here as well as files (2026-10-06): the menu's
            // "Add a folder" is not the only way in.
            onDrop={e => {
                e.preventDefault();
                setDragOver(false);
                void droppedFiles(e.dataTransfer).then(({ loose, inFolder }) => take(loose, inFolder));
            }}
        >
            <div className="mb-1 flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-slate-900 dark:text-white">
                    {t("Course material")} <span className="font-normal text-slate-500 dark:text-slate-400">{t("(optional)")}</span>
                </p>
                <Button
                    ref={addRef}
                    variant="quiet"
                    size="sm"
                    icon={<Plus className="h-4 w-4" />}
                    onClick={add}
                    onKeyDown={canFolder ? menuTriggerKeys(() => setMenuOpen(true)) : undefined}
                    aria-haspopup={canFolder ? 'menu' : undefined}
                    aria-expanded={canFolder ? menuOpen : undefined}
                    className="-mr-2"
                >
                    {t("Add")}
                </Button>
                <MenuPopover open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={addRef} label={t("Add")} align="end">
                    <MenuItem icon={<FileText className="h-4 w-4" />} onSelect={() => { setMenuOpen(false); chooseFiles(); }}>{t("Add files")}</MenuItem>
                    <MenuItem icon={<FolderOpen className="h-4 w-4" />} onSelect={() => { setMenuOpen(false); folderRef.current?.click(); }}>{t("Add a folder")}</MenuItem>
                </MenuPopover>
            </div>
            {any ? (
                <ul className="space-y-1.5" aria-live="polite">
                    {files.map(f => <SourceRow key={f.key} file={f} onRemove={() => onRemove(f.key)} />)}
                </ul>
            ) : (
                // Empty: one slim dashed row that says what belongs here and
                // takes a drop. It is a button too, for the learner who reads
                // it as the place to press.
                <button
                    type="button"
                    onClick={chooseFiles}
                    className={cx(
                        'flex w-full items-center gap-3 rounded-xl border-2 border-dashed px-3 py-2 text-left transition-colors',
                        FOCUS_RING,
                        // slate-400: slate-300 on white was barely drawn.
                        dragOver ? 'border-accent bg-accent/10' : 'border-slate-400 dark:border-slate-500 can-hover:hover:border-accent',
                    )}
                >
                    <Upload className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                    {/* What belongs here, then the kinds it reads: without the
                        second line nobody learned that slides and spreadsheets
                        work (two of three outside readers, 2026-10-06). The
                        25 MB cap is said where it matters: on a file over it. */}
                    <span className="min-w-0 text-sm">
                        <span className="block text-slate-700 dark:text-slate-200">{t("A textbook, notes or past exams")}</span>
                        <span className="block text-slate-500 dark:text-slate-400">
                            {touch ? t("PDF, Word, PowerPoint, Excel or text") : t("PDF, Word, PowerPoint, Excel or text · or drop them here")}
                        </span>
                    </span>
                </button>
            )}
            <input ref={inputRef} type="file" multiple className="hidden" onChange={e => take(Array.from(e.target.files ?? []))} />
            {canFolder && (
                <input
                    ref={folderRef}
                    type="file"
                    multiple
                    className="hidden"
                    // Not in React's typings; every desktop browser reads it.
                    {...{ webkitdirectory: '' }}
                    onChange={e => take([], Array.from(e.target.files ?? []))}
                />
            )}
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
