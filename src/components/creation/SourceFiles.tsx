// src/components/creation/SourceFiles.tsx — the course MATERIAL in the New
// course window: any number of links and files, in one list.
//
// A link is read the moment it is pasted (POST /api/short-courses/read) and a
// file the moment it is dropped (POST /api/documents/staged), so the window can
// say what the course will be made of before anything is generated: what a
// link turned out to be (a video and its length, a web page and its site),
// a file's pages and chapters, or why something cannot be used and what to do
// instead (readReasons.ts, the reader's `fix`: a file, Try again, a pasted
// transcript, or the video's title as the course's name). Both end as staged
// documents the creation run takes by id. The parent owns the list and the
// requests; this draws them.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
    AlertCircle, BookOpen, CircleAlert, File, FileText, FileX, FolderOpen, Globe, Link2, Loader2, Plus, SquarePlay, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { StagedDocument } from '../../types';
import { useStore } from '../../store';
import { Button, IconButton } from '../ui/Button';
import { TextArea, TextInput } from '../ui/Field';
import { MenuItem, MenuPopover, menuTriggerKeys } from '../ui/Popover';
import { cx } from '../ui/vocabulary';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import type { NumberOptions } from '../../utils/numberFormat';
import { serverText } from '../../utils/serverText';
import { READ_REASON, READ_REASON_OTHER } from '../shortCourses/readReasons';
import type { ShortReadFail } from '../shortCourses/shortCourseTypes';
import OwnLine from '../ui/OwnLine';

/** One piece of material: a file or a link, being read, read, or refused. */
export interface SourceFile {
    key: string;
    /** A file's name; a link's site until it is read, then its title. */
    name: string;
    size: number;
    /** `reading` until the server answers. */
    status: 'reading' | 'done';
    doc?: StagedDocument;
    /** Refused here or by the request itself. */
    error?: string;
    /** A link: what was pasted, read again by Try again. */
    url?: string;
    /** A link that could not be read: why, and the way on the reader offers. */
    fail?: ShortReadFail;
}

/** The per-file cap the server enforces (`MAX_FILE_BYTES`, server/extract.js). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** The digits follow the interface language (`fmt`); KB and MB are the symbols. */
const humanSize = (bytes: number, fmt: (value: number, options?: NumberOptions) => string) =>
    bytes < 1024 * 1024
        ? `${fmt(Math.max(1, Math.round(bytes / 1024)))} KB`
        : `${fmt(bytes / 1024 / 1024, { decimals: 1 })} MB`;

/** Material the run can build from: read, with text in it. */
export const usableSource = (f: SourceFile) => f.status === 'done' && !!f.doc?.ok && !f.doc.noText;

/** The site of a link, for "Reading youtube.com"; the text itself when it is not one. */
export function hostOf(raw: string): string {
    try {
        return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./i, '');
    } catch {
        return raw;
    }
}

/** Something that is meant as a link: a web address, or a site and a path. */
const LINKISH = /^(?:https?:\/\/|www\.)\S+$|^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*$/i;
/** One word as a link would be meant: the brackets, quotes and full stop
 *  around it dropped, a closing bracket kept when the link opened it
 *  (`wiki/Mercury_(planet)`). */
const linkWord = (word: string): string => {
    let w = word.replace(/^[(<["'«“„‘]+/, '');
    for (;;) {
        const cut = w.replace(/[>\]"'»”’,.;:!?]+$/, '');
        const close = cut.endsWith(')') && cut.split(')').length > cut.split('(').length;
        const next = close ? cut.slice(0, -1) : cut;
        if (next === w) return w;
        w = next;
    }
};
const words = (text: string) => String(text ?? '').split(/\s+/).map(linkWord).filter(Boolean);
/** The links in pasted or typed text: several at once, one per word. */
export const linksIn = (text: string): string[] => [...new Set(words(text).filter(w => LINKISH.test(w)))];
/** Pasted text that is links and nothing else, which a paste may read at once;
 *  anything more is left in the field for the learner to see. */
export const onlyLinks = (text: string): boolean => {
    const all = words(text);
    return all.length > 0 && all.every(w => LINKISH.test(w));
};

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

/** What the window does with a failed link's way on. */
export interface LinkFixes {
    onRetry: (key: string) => void;
    onTranscript: (key: string, text: string) => void;
    /** A video with nothing to read: its title names the course instead. */
    onUseTitle: (key: string) => void;
}

export default function SourceFiles({ files, onAdd, onRemove, onLinks, fixes, draft = '', onDraft }: {
    files: SourceFile[];
    onAdd: (files: File[]) => void;
    onRemove: (key: string) => void;
    /** Links pasted, typed or dropped: each is read and listed. */
    onLinks: (urls: string[]) => void;
    fixes: LinkFixes;
    /** The link box's text when it shows again: the window keeps it across a step. */
    draft?: string;
    /** The link box's text not yet added, as it changes: the window counts it
     *  as typed work before it closes. */
    onDraft?: (text: string) => void;
}) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const inputRef = useRef<HTMLInputElement>(null);
    const folderRef = useRef<HTMLInputElement>(null);
    const addRef = useRef<HTMLButtonElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    // Seeded from the window: ← to the first choice and back again keeps a typed
    // link, as it keeps the name and the goal, so it stays work to lose.
    const [text, setText] = useState(draft);
    const onDraftRef = useRef(onDraft);
    onDraftRef.current = onDraft;
    useEffect(() => { onDraftRef.current?.(text); }, [text]);
    // A failed link whose "Choose a file" opened the picker: the files picked
    // take its place in the list.
    const replacing = useRef<string | null>(null);
    // The latest list, read when a pick is accepted rather than when it began.
    const filesNow = useRef(files);
    filesNow.current = files;
    const touch = useMediaQuery('(hover: none)');

    /** `loose` files are sent whatever they are and the server says why one
     *  cannot be read; `inFolder` (a picked or dropped folder's contents) is
     *  filtered to what a course is read from. Callers copy a FileList into an
     *  array BEFORE this runs: a FileList is live, and clearing the input
     *  below empties it. */
    const take = (loose: File[], inFolder: File[] | null = null, replace: string | null = null) => {
        for (const input of [inputRef.current, folderRef.current]) if (input) input.value = '';
        // Links and files share one cap; a failed link the files replace gives
        // its row back. The list as it is NOW: a dropped folder is walked
        // asynchronously, and links added meanwhile count too.
        const current = filesNow.current;
        const room = Math.max(0, MAX_SOURCE_FILES - current.length + (replace && current.some(f => f.key === replace) ? 1 : 0));
        let fromFolder: File[] = [];
        if (inFolder) {
            fromFolder = inFolder.filter(readableInFolder);
            if (!fromFolder.length && !loose.length) {
                addToast('info', t("Nothing in that folder can be read"), t("A course is made from PDF, Word, PowerPoint, Excel or text files."));
                return;
            }
            const folderRoom = Math.max(0, room - loose.length);
            if (fromFolder.length > folderRoom) {
                addToast('info', t("Part of the folder was left out"), t("A course is made from at most 100 files."));
                fromFolder = fromFolder.slice(0, folderRoom);
            } else if (fromFolder.length < inFolder.length) {
                addToast('info', t("Part of the folder was left out"), t("A course is made from PDF, Word, PowerPoint, Excel or text files."));
            }
        }
        let picked = [...loose, ...fromFolder];
        if (picked.length > room) {
            // Only loose files are still over: a folder was cut to fit above.
            addToast('info', t("A course is made from at most 100 links and files."));
            picked = picked.slice(0, room);
        }
        if (picked.length && replace) onRemove(replace);
        if (picked.length) onAdd(picked);
    };

    /** Read what was typed or pasted. Text with no link in it is sent as it
     *  is, and the reader says why it is not one. */
    const readTyped = (raw: string) => {
        const found = linksIn(raw);
        const typed = raw.trim();
        if (!found.length && !typed) return;
        onLinks(found.length ? found : [typed]);
        setText('');
    };

    const typed = !!text.trim();
    // Each open says what the picked files replace: a picker closed with
    // nothing picked fires no change, so a stale entry would drop a failed
    // link on the next Add files.
    const chooseFiles = (replace: string | null = null) => { replacing.current = replace; inputRef.current?.click(); };
    const chooseFolder = () => { replacing.current = null; folderRef.current?.click(); };
    // A folder where the browser can open one. A phone's picker cannot (and
    // where it pretends to, it hands back nothing), so on touch "Add files"
    // goes straight to the files.
    const canFolder = !touch;
    const addFiles = () => (canFolder ? setMenuOpen(o => !o) : chooseFiles());

    return (
        // LAST in the window and optional: a course is made from a name and a
        // goal, and FROM material only when there is some. At the bottom, the
        // list grows where nothing is under it, so a source arriving moves
        // nothing the learner has already filled in. A drop (files, a folder,
        // a link dragged from a browser tab) lands anywhere on the section.
        <div
            data-material=""
            className={cx('min-w-0 rounded-xl', dragOver && 'ring-2 ring-accent ring-offset-4 ring-offset-white dark:ring-offset-slate-800')}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
            onDrop={e => {
                e.preventDefault();
                setDragOver(false);
                const dt = e.dataTransfer;
                if (dt.files?.length) {
                    void droppedFiles(dt).then(({ loose, inFolder }) => take(loose, inFolder));
                    return;
                }
                const dropped = dt.getData('text/uri-list').split('\n').filter(l => l && !l.startsWith('#')).join(' ')
                    || dt.getData('text/plain');
                const found = linksIn(dropped);
                if (found.length) onLinks(found);
            }}
        >
            <label htmlFor="course-material-link" className="mb-1 block text-sm font-medium text-slate-900 dark:text-white">
                {t("Course material")} <span className="font-normal text-slate-500 dark:text-slate-400">{t("(optional)")}</span>
            </label>
            <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                    <TextInput
                        id="course-material-link"
                        icon={<Link2 className="h-4 w-4" />}
                        type="text"
                        inputMode="url"
                        enterKeyHint="go"
                        autoComplete="off"
                        value={text}
                        onChange={e => setText(e.target.value)}
                        // Not the Enter that confirms an input method's candidate.
                        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); readTyped(text); } }}
                        // A pasted link is read at once: pasting IS the request.
                        // Several links pasted together are read one by one; a
                        // pasted file joins the files. A paste with any other
                        // text in it lands in the field as it is: Enter reads
                        // the links out of it, and nothing goes unseen.
                        onPaste={e => {
                            const pastedFiles = Array.from(e.clipboardData.files ?? []);
                            if (pastedFiles.length) { e.preventDefault(); take(pastedFiles); return; }
                            const pasted = e.clipboardData.getData('text');
                            if (!text.trim() && onlyLinks(pasted)) { e.preventDefault(); onLinks(linksIn(pasted)); }
                        }}
                        aria-describedby="course-material-hint"
                        // Short: the hint under the row names what a link can
                        // be, and a phone leaves the field half the row.
                        placeholder={t("Paste a link")}
                    />
                </div>
                {/* One cell, two buttons, the one not in use hidden: swapped
                    outright, the field jumped at the first letter typed. */}
                <div className="grid shrink-0">
                    <Button variant="neutral" icon={<Plus className="h-4 w-4" />} className={cx('[grid-area:1/1]', !typed && 'invisible')}
                        tabIndex={typed ? undefined : -1} aria-hidden={typed ? undefined : true}
                        onClick={() => readTyped(text)}>{t("Add link")}</Button>
                    <Button
                        ref={addRef}
                        variant="neutral"
                        icon={<Plus className="h-4 w-4" />}
                        className={cx('[grid-area:1/1]', typed && 'invisible')}
                        tabIndex={typed ? -1 : undefined}
                        aria-hidden={typed ? true : undefined}
                        onClick={addFiles}
                        onKeyDown={canFolder ? menuTriggerKeys(() => setMenuOpen(true)) : undefined}
                        aria-haspopup={canFolder ? 'menu' : undefined}
                        aria-expanded={canFolder ? menuOpen : undefined}
                    >
                        {t("Add files")}
                    </Button>
                </div>
                <MenuPopover open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={addRef} label={t("Add files")} align="end">
                    <MenuItem icon={<FileText className="h-4 w-4" />} onSelect={() => { setMenuOpen(false); chooseFiles(); }}>{t("Add files")}</MenuItem>
                    <MenuItem icon={<FolderOpen className="h-4 w-4" />} onSelect={() => { setMenuOpen(false); chooseFolder(); }}>{t("Add a folder")}</MenuItem>
                </MenuPopover>
            </div>
            {/* What belongs here, said once: without the kinds nobody learns
                that slides, spreadsheets and videos work. A finger cannot drag,
                so a touch screen is not told to drop. */}
            <p id="course-material-hint" className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
                {touch ? t("Web pages, YouTube videos, PDF, Word, PowerPoint, Excel or text files")
                    : t("Web pages, YouTube videos, PDF, Word, PowerPoint, Excel or text files · or drop them here")}
            </p>
            {files.length > 0 && (
                <ul className="mt-3 space-y-1.5" aria-live="polite">
                    {files.map(f => <SourceRow
                        key={f.key}
                        file={f}
                        onRemove={() => onRemove(f.key)}
                        fixes={fixes}
                        onChooseFile={() => chooseFiles(f.key)}
                    />)}
                </ul>
            )}
            <input ref={inputRef} type="file" multiple className="hidden" onChange={e => {
                // Only the picker a failed row's "Choose a file" opened replaces
                // that row; a drop or a paste never does.
                const replace = replacing.current;
                replacing.current = null;
                take(Array.from(e.target.files ?? []), null, replace);
            }} />
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

const quietIcon = 'h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400';

function SourceRow({ file, onRemove, fixes, onChooseFile }: {
    file: SourceFile;
    onRemove: () => void;
    fixes: LinkFixes;
    onChooseFile: () => void;
}) {
    const { t } = useTranslation();
    const fmt = useNumberFormat();
    const doc = file.doc;
    const source = doc?.ok ? doc.source ?? null : null;
    const isLink = file.url != null || !!source;
    let icon = <Loader2 className={cx(quietIcon, 'animate-spin')} aria-hidden="true" />;
    let line: ReactNode = t("Reading…");
    let tone = 'text-slate-500 dark:text-slate-400';
    let title: string | undefined;
    let fix: ReactNode = null;
    let note = '';
    const [pasting, setPasting] = useState(false);
    const [transcript, setTranscript] = useState('');
    const pasteRef = useRef<HTMLTextAreaElement>(null);
    useEffect(() => { if (pasting) pasteRef.current?.focus(); }, [pasting]);

    if (file.status === 'reading') {
        // As it was pasted until the reader names it.
    } else if (file.fail) {
        // A link that could not be read is not the learner's mistake: an
        // amber mark, the reason in plain words, and the way on beside it.
        const fail = file.fail;
        icon = <CircleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
        line = t(READ_REASON[fail.reason] ?? READ_REASON_OTHER, { size: Math.round(MAX_FILE_BYTES / 1024 / 1024) });
        tone = 'text-slate-600 dark:text-slate-300';
        fix = fail.fix === 'file' ? <Button size="sm" variant="neutral" onClick={onChooseFile}>{t("Choose a file")}</Button>
            : fail.fix === 'retry' && file.url ? <Button size="sm" variant="neutral" onClick={() => fixes.onRetry(file.key)}>{t("Try again")}</Button>
                : fail.fix === 'transcript' && !pasting ? <Button size="sm" variant="neutral" onClick={() => setPasting(true)}>{t("Paste the transcript")}</Button>
                    : fail.fix === 'topic' && fail.title ? <Button size="sm" variant="neutral" onClick={() => fixes.onUseTitle(file.key)}>{t("Use its title as the name")}</Button>
                        : null;
        // Create goes ahead without it, so the row says so, as a file with no
        // text does.
        note = fix || pasting ? t("Left out unless it is fixed.") : t("It will be left out.");
    } else if (file.error || (doc && !doc.ok)) {
        icon = <AlertCircle className="h-4 w-4 shrink-0 text-red-500" aria-hidden="true" />;
        line = file.error || (doc && !doc.ok ? serverText(doc) ?? '' : '');
        tone = 'text-red-700 dark:text-red-300';
    } else if (doc?.ok && doc.noText) {
        // Not drawn as an error: an amber triangle on a screen about to be
        // confirmed read as "I did something wrong", amber text as a failure.
        // An amber FILE mark, the row's name quieter than the files that are
        // used, and one clause that says what happens to it.
        icon = <FileX className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
        line = t("No text found, so it will be skipped.");
    } else if (doc?.ok && source) {
        // A link, as a person would name it: what it is, how long, where.
        const Kind = source.kind === 'video' ? SquarePlay : source.kind === 'page' ? Globe : source.kind === 'pdf' ? FileText : File;
        icon = <Kind className={quietIcon} aria-hidden="true" />;
        const what = source.pasted ? t("Transcript")
            : source.kind === 'video' ? t("Video")
                : source.kind === 'page' ? t("Web page")
                    : source.kind === 'pdf' ? t("PDF") : t("Document");
        const size = source.kind === 'video' && source.minutes && !source.pasted ? t("{{n}} min", { n: fmt(source.minutes) })
            : doc.page_count && source.kind !== 'page' ? t("{{count}} pages", { count: doc.page_count }) : '';
        line = [what, size, source.host].filter(Boolean).join(' · ');
    } else if (doc?.ok) {
        // Pages and chapters when the file has them, in the words a person
        // would use. The chapters are the TOP level of the contents; how
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
        icon = s.method === 'none' ? <FileText className={quietIcon} aria-hidden="true" /> : <BookOpen className={quietIcon} aria-hidden="true" />;
        // A file with neither (plain text, notes) still says it was READ.
        line = [pages, chapters].filter(Boolean).join(' · ') || t("Read in full");
    }

    // The size shows only beside a failed FILE, where it is the reason (the
    // 25 MB cap); a link has none.
    const failed = !isLink && !!(file.error || (doc && !doc.ok));
    const leftOut = !!(doc?.ok && doc.noText) || !!note;
    const name = file.fail?.title || file.name;
    return (
        // Every row is the height of a two-line one, and a one-line row
        // CENTRES in it: rows of three heights in one list read as ragged.
        <li className="rounded-lg border border-slate-200 bg-slate-100/70 px-3 py-2 dark:border-transparent dark:bg-slate-700/40">
            <div className={cx('flex min-h-10 gap-3', line ? 'items-start' : 'items-center')}>
                <span className={cx(line && 'mt-0.5')}>{icon}</span>
                <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                        <span className={cx('min-w-0 truncate text-sm font-medium', leftOut ? 'text-slate-500 dark:text-slate-400' : 'text-slate-800 dark:text-slate-100')} title={file.url || undefined}><OwnLine>{name}</OwnLine></span>
                        {failed && <span className="shrink-0 text-sm text-slate-500 dark:text-slate-400">{humanSize(file.size, fmt)}</span>}
                    </div>
                    {line && <p className={cx('text-sm', tone)} title={title}>{line}</p>}
                    {note && <p className="text-sm text-slate-500 dark:text-slate-400">{note}</p>}
                    {fix && <div className="mt-2">{fix}</div>}
                </div>
                <IconButton size="sm" label={t("Remove {{name}}", { name })} icon={<X className="h-4 w-4" />} onClick={onRemove} />
            </div>
            {pasting && file.fail?.fix === 'transcript' && (
                // The video's own words, copied from YouTube, in place of the
                // captions the reader could not get.
                <div className="mt-2 space-y-2">
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                        {t("On YouTube, open the description and press Show transcript, then copy it here.")}
                    </p>
                    <TextArea
                        ref={pasteRef}
                        aria-label={t("The video's transcript")}
                        value={transcript}
                        onChange={e => setTranscript(e.target.value)}
                        rows={4}
                        className="block resize-y leading-6"
                    />
                    <div className="flex justify-end gap-2">
                        <Button size="sm" variant="quiet" onClick={() => { setPasting(false); setTranscript(''); }}>{t("Cancel")}</Button>
                        <Button size="sm" variant="neutral" disabled={!transcript.trim()}
                            onClick={() => { fixes.onTranscript(file.key, transcript.trim()); setPasting(false); setTranscript(''); }}>
                            {t("Add the transcript")}
                        </Button>
                    </div>
                </div>
            )}
        </li>
    );
}
