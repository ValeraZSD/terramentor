// The Projects page's short courses: one box to paste a link or drop a file
// into, and the short courses being studied, three small cards to a row
// (projects/CompactCard.tsx). A finished or archived one is on the page's
// Finished or Archived view instead, with the full courses.
//
// A source is READ first (POST /api/short-courses/read): the box then shows
// what it is and how big, and only Create writes a course. A source that cannot
// be read says why and offers its way on (readReasons.ts, the reader's `fix`):
// a file instead, Try again, a pasted transcript, or "Write it from the title"
// for a video with no captions. A whole book offers a few of its chapters, or a
// full course through the New course dialog; a few lines offer the Inbox.
//
// The rows are GET /api/short-courses, owned by ProjectsGrid, which leaves
// these courses out of its own grid. A course leaves the strip when it grows
// a phase (server/shortCourses.js `listShortCourses`).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Archive, CheckCircle2, CircleAlert, ExternalLink, File, FileText, Globe, Link2,
    Loader2, MoreVertical, Paperclip, Play, RotateCcw, Sparkles, Trash2, X, Youtube,
} from 'lucide-react';
import { api } from '../../api';
import { useStore } from '../../store';
import type { Project, StagedDocument } from '../../types';
import { Button, IconButton } from '../ui/Button';
import { TextArea } from '../ui/Field';
import { MenuItem, MenuPopover, menuTriggerKeys } from '../ui/Popover';
import { cx } from '../ui/vocabulary';
import Checkbox from '../Checkbox';
import ProgressRing from '../ProgressRing';
import ConnectAIActions from '../ConnectAIActions';
import { MAX_FILE_BYTES } from '../creation/SourceFiles';
import { CompactCard, COMPACT_GRID } from '../projects/CompactCard';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { freeColour } from '../../utils/freeColour';
import { useCanHover } from '../../utils/platform';
import { READ_REASON, READ_REASON_OTHER } from './readReasons';
import type { ShortCourseRow, ShortRead, ShortReadFail, ShortReadOk, SourceKind } from './shortCourseTypes';

/** Below this width the box and the rows stack their actions under the text. */
const NARROW_PX = 560;

const KIND_ICON: Record<SourceKind, typeof Globe> = {
    video: Youtube, page: Globe, pdf: FileText, file: File, topic: Sparkles,
};

/** The label between two rules that every section of the page uses. */
export function SectionLabel({ children }: { children: ReactNode }) {
    return (
        <div className="flex items-center gap-3 mb-4">
            <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">{children}</span>
            <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
        </div>
    );
}

function Tile({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'warn' }) {
    return (
        <div className={cx(
            'w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
            tone === 'warn'
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
        )}>
            {children}
        </div>
    );
}

/** The site of a link, for "Reading youtube.com"; the text itself when it is not one. */
function hostOf(raw: string): string {
    try {
        return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./i, '');
    } catch {
        return raw;
    }
}

/** What the box is showing. `pasted`: the transcript a read came from, kept
 *  for "Save to Inbox" when it turns out to be only a few lines. */
type Box =
    | { state: 'empty' }
    | { state: 'reading'; where: string; detail: string }
    | { state: 'read'; read: ShortReadOk; pasted?: string }
    | { state: 'unreadable'; fail: ShortReadFail; where: string; link: string | null }
    | { state: 'transcript'; title: string; url: string | null }
    | { state: 'chapters'; read: ShortReadOk; picked: number[] };

function useReadLine() {
    const { t } = useTranslation();
    const num = useNumberFormat();
    /** "Video · 12 min · 4 topics": what was read and what it makes. */
    return (read: ShortReadOk, pasted: boolean): string => {
        const what = pasted ? t("Transcript")
            : read.kind === 'video' ? t("Video")
                : read.kind === 'page' ? t("Web page")
                    : read.kind === 'pdf' ? t("PDF")
                        : t("Document");
        const size = read.kind === 'video' && read.minutes && !pasted ? t("{{n}} min", { n: read.minutes })
            : read.pages && read.kind !== 'page' ? t("{{count}} pages", { count: read.pages })
                : t("{{words}} words", { count: read.words, words: num(read.words) });
        return [what, size, t("{{count}} topics", { count: read.topics })].join(' · ');
    };
}

function SourceBox({ projects, narrow, onCreated, onFullCourse }: {
    projects: Project[];
    narrow: boolean;
    onCreated: () => void;
    onFullCourse: (doc: StagedDocument, title: string) => void;
}) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const addToast = useStore(s => s.addToast);
    const readLine = useReadLine();
    // A finger cannot drag a file onto the box, so a touch screen is not told to.
    const prompt = useCanHover() ? t("Paste a link or drop a file") : t("Paste a link");
    const [box, setBox] = useState<Box>({ state: 'empty' });
    const [text, setText] = useState('');
    const [transcript, setTranscript] = useState('');
    const [busy, setBusy] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    useEffect(() => () => abortRef.current?.abort(), []);

    const begin = (where: string, detail: string) => {
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        setBox({ state: 'reading', where, detail });
        return ac;
    };

    const show = (r: ShortRead, { link = null, file = null, pasted }: { link?: string | null; file?: string | null; pasted?: string }) => {
        if (r.ok) setBox({ state: 'read', read: r, pasted });
        else setBox({ state: 'unreadable', fail: r, where: r.title || file || r.host || (link ? hostOf(link) : '') || t("This link"), link });
    };

    const failed = (e: unknown, ac: AbortController) => {
        if (ac.signal.aborted) return;
        setBox({ state: 'empty' });
        addToast('error', t("Could not read it"), e instanceof Error ? e.message : String(e));
    };

    const readLink = async (raw: string) => {
        const link = raw.trim();
        if (!link) return;
        const ac = begin(hostOf(link), link);
        try {
            const r = await api.readShortSource({ url: link }, ac.signal);
            if (!ac.signal.aborted) show(r, { link });
        } catch (e) { failed(e, ac); }
    };

    const readFile = async (file: File) => {
        if (file.size > MAX_FILE_BYTES) {
            setBox({ state: 'unreadable', fail: { ok: false, reason: 'too_large', fix: null }, where: file.name, link: null });
            return;
        }
        const ac = begin(file.name, '');
        try {
            const r = await api.readShortFile(file, ac.signal);
            if (!ac.signal.aborted) show(r, { file: file.name });
        } catch (e) { failed(e, ac); }
    };

    /** Back to an empty box. A source read and not used is let go now (the
     *  server forgets it within a day anyway); `keep` when the New course
     *  dialog took it. */
    const clear = ({ keep = false }: { keep?: boolean } = {}) => {
        abortRef.current?.abort();
        if (!keep && (box.state === 'read' || box.state === 'chapters')) void api.discardShortSource(box.read.stagedId).catch(() => { });
        setBox({ state: 'empty' });
        setText('');
        setTranscript('');
    };

    const create = async (body: Parameters<typeof api.createShortCourse>[0], read: ShortReadOk | null) => {
        setBusy(true);
        try {
            await api.createShortCourse({ ...body, color: freeColour(projects), via: 'projects' });
            setBox({ state: 'empty' });
            setText('');
            setTranscript('');
            onCreated();
        } catch (e) {
            const err = e as { status?: number; data?: { reason?: string } } & Error;
            if (err.data?.reason === 'no_ai' && read) setBox({ state: 'read', read: { ...read, ai: false } });
            else {
                if (err.status === 404) setBox({ state: 'empty' });
                addToast('error', t("Could not create the short course"), err.message);
            }
        } finally {
            setBusy(false);
        }
    };

    const fromTranscript = async (title: string, url: string | null) => {
        const pasted = transcript.trim();
        if (!pasted) return;
        setBusy(true);
        try {
            const r = await api.readShortSource({ transcript: pasted, title, url: url ?? undefined });
            if (r.ok && r.size === 'ok' && r.ai) {
                setBusy(false);
                await create({ stagedId: r.stagedId }, r);
                return;
            }
            show(r, { link: url, pasted });
        } catch (e) {
            addToast('error', t("Could not read it"), e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const saveToInbox = async (read: ShortReadOk, pasted?: string) => {
        setBusy(true);
        try {
            await api.capture(pasted ? { text: pasted } : { url: read.url ?? undefined, title: read.title });
            clear();
            addToast('success', t("Saved to your Inbox"));
        } catch (e) {
            addToast('error', t("Could not save the note"), e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const chooseFile = () => fileRef.current?.click();

    // A dropped file is read at once; a dropped link (dragged from another
    // tab's address bar) too.
    const dropProps = {
        onDragOver: (e: React.DragEvent) => {
            if (box.state === 'reading') return;
            e.preventDefault();
            setDragOver(true);
        },
        onDragLeave: (e: React.DragEvent) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        },
        onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            setDragOver(false);
            if (box.state === 'reading') return;
            const file = e.dataTransfer.files?.[0];
            if (file) { void readFile(file); return; }
            const link = e.dataTransfer.getData('text/uri-list').split('\n').find(l => l && !l.startsWith('#'))
                || e.dataTransfer.getData('text/plain');
            if (link?.trim()) { setText(link.trim()); void readLink(link); }
        },
    };

    // On a phone the forward actions need the whole line, so Clear is the
    // box's own × beside the title instead of a button in that line.
    const clearButton = narrow ? null : <Button variant="quiet" onClick={() => clear()}>{t("Clear")}</Button>;
    const corner = narrow && box.state !== 'empty' && box.state !== 'reading'
        ? <IconButton label={t("Clear")} tooltip={false} icon={<X className="w-4 h-4" />} className="self-start -mr-1" onClick={() => clear()} />
        : null;

    if (box.state === 'transcript') {
        return (
            <div data-short="source" className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-3 space-y-3">
                <div className="flex items-center gap-3 min-w-0">
                    <Tile><Youtube className="w-5 h-5" aria-hidden="true" /></Tile>
                    <div className="min-w-0 flex-1">
                        <p className="text-base font-medium text-slate-900 dark:text-white line-clamp-2">{box.title}</p>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                            {t("On YouTube, open the description and press Show transcript, then copy it here.")}
                        </p>
                    </div>
                </div>
                <TextArea
                    aria-label={t("The video's transcript")}
                    value={transcript}
                    onChange={e => setTranscript(e.target.value)}
                    rows={5}
                    autoFocus
                    className="block leading-6 resize-y"
                />
                <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button variant="quiet" onClick={() => clear()}>{t("Cancel")}</Button>
                    <Button variant="primary" busy={busy} disabled={!transcript.trim()}onClick={() => void fromTranscript(box.title, box.url)}>
                        {t("Create short course")}
                    </Button>
                </div>
            </div>
        );
    }

    if (box.state === 'chapters') {
        const { read, picked } = box;
        const chapters = read.chapters ?? [];
        const toggle = (part: number, on: boolean) =>
            setBox({ ...box, picked: on ? [...picked, part].sort((a, b) => a - b) : picked.filter(p => p !== part) });
        const words = chapters.filter(c => picked.includes(c.part)).reduce((n, c) => n + c.words, 0);
        // A preface alone is a note: the server refuses it, so Create waits for more.
        const tooFew = picked.length > 0 && words < (read.minWords ?? 0);
        return (
            <div data-short="source" className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-3 space-y-3">
                <div className="flex items-center gap-3 min-w-0">
                    <Tile><FileText className="w-5 h-5" aria-hidden="true" /></Tile>
                    <div className="min-w-0 flex-1">
                        <p className="text-base font-medium text-slate-900 dark:text-white line-clamp-2">{read.title}</p>
                        <p className="text-sm text-slate-500 dark:text-slate-400">{t("Pick the chapters to learn now.")}</p>
                    </div>
                </div>
                <ul className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700">
                    {chapters.map(c => (
                        <li key={c.part}>
                            <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50">
                                <Checkbox checked={picked.includes(c.part)} onChange={on => toggle(c.part, on)} />
                                <span className="min-w-0 flex-1 text-sm text-slate-800 dark:text-slate-100">{c.title}</span>
                                <span className="shrink-0 text-sm text-slate-500 dark:text-slate-400">
                                    {c.from != null ? t("p. {{from}}", { from: c.from }) : t("{{words}} words", { count: c.words, words: num(c.words) })}
                                </span>
                            </label>
                        </li>
                    ))}
                </ul>
                <div className="flex flex-wrap items-center justify-end gap-2">
                    {picked.length > 0 && (
                        <span className="mr-auto text-sm text-slate-500 dark:text-slate-400">
                            {t("{{words}} words", { count: words, words: num(words) })}{tooFew && ` · ${t("Too little for a course.")}`}
                        </span>
                    )}
                    <Button variant="quiet" onClick={() => setBox({ state: 'read', read })}>{t("Back")}</Button>
                    <Button variant="primary" busy={busy} disabled={!picked.length || tooFew} onClick={() => void create({ stagedId: read.stagedId, parts: picked }, read)}>
                        {t("Create short course")}
                    </Button>
                </div>
            </div>
        );
    }

    let tile: ReactNode;
    let first: ReactNode;
    let second: ReactNode;
    let actions: ReactNode;
    let pair = false;
    switch (box.state) {
        case 'empty': {
            tile = <Tile><Link2 className="w-5 h-5" aria-hidden="true" /></Tile>;
            first = (
                <input
                    type="text"
                    inputMode="url"
                    enterKeyHint="go"
                    value={text}
                    onChange={e => setText(e.target.value)}
                    // Not the Enter that confirms an input method's candidate.
                    onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void readLink(text); } }}
                    // A pasted link is read at once: pasting IS the request.
                    // Typed text waits for Enter or Read.
                    onPaste={e => {
                        const file = e.clipboardData.files?.[0];
                        if (file) { e.preventDefault(); void readFile(file); return; }
                        const pasted = e.clipboardData.getData('text').trim();
                        if (pasted && !text.trim() && !/\s/.test(pasted)) { e.preventDefault(); setText(pasted); void readLink(pasted); }
                    }}
                    aria-label={prompt}
                    placeholder={prompt}
                    className="w-full bg-transparent p-0 border-0 text-base font-medium text-slate-900 dark:text-white placeholder:text-slate-500 dark:placeholder:text-slate-400 outline-none focus:ring-0"
                />
            );
            second = t("A web page, a PDF, a YouTube video or a document");
            actions = text.trim()
                ? <Button variant="primary" onClick={() => void readLink(text)}>{t("Read")}</Button>
                : <Button variant="neutral" icon={<Paperclip className="w-4 h-4" aria-hidden="true" />} onClick={chooseFile}>{t("Choose a file")}</Button>;
            break;
        }
        case 'reading':
            tile = <Tile><Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /></Tile>;
            first = t("Reading {{where}}", { where: box.where });
            second = box.detail;
            actions = <Button variant="quiet" onClick={() => clear()}>{t("Cancel")}</Button>;
            break;
        case 'unreadable': {
            const { fail } = box;
            tile = <Tile tone="warn"><CircleAlert className="w-5 h-5" aria-hidden="true" /></Tile>;
            first = box.where;
            second = t(READ_REASON[fail.reason] ?? READ_REASON_OTHER, { size: Math.round(MAX_FILE_BYTES / 1024 / 1024) });
            const fix = fail.fix === 'file'
                ? <Button variant="primary" onClick={chooseFile}>{t("Choose a file")}</Button>
                : fail.fix === 'retry' && box.link
                    ? <Button variant="primary" onClick={() => void readLink(box.link!)}>{t("Try again")}</Button>
                    : fail.fix === 'transcript'
                        ? <Button variant="primary" onClick={() => setBox({ state: 'transcript', title: fail.title || box.where, url: fail.url ?? box.link })}>{t("Paste the transcript")}</Button>
                        : fail.fix === 'topic' && fail.title
                            ? <Button variant="primary" busy={busy} onClick={() => void create({ fromTopic: { title: fail.title! } }, null)}>{t("Write it from the title")}</Button>
                            : null;
            actions = <>{clearButton}{fix}</>;
            break;
        }
        case 'read': {
            const { read, pasted } = box;
            const KindIcon = KIND_ICON[read.kind];
            tile = <Tile><KindIcon className="w-5 h-5" aria-hidden="true" /></Tile>;
            first = read.title;
            if (read.size === 'too-big') {
                second = t("Too long for one short course: make a full course of it, or pick a few chapters for a short one.");
                pair = true;
                actions = (
                    <>
                        {clearButton}
                        <Button variant="neutral" block={narrow} onClick={() => setBox({ state: 'chapters', read, picked: [] })}>{t("Pick chapters")}</Button>
                        <Button variant="primary" block={narrow} disabled={!read.staged} onClick={() => { if (read.staged) { onFullCourse(read.staged, read.title); clear({ keep: true }); } }}>{t("Full course")}</Button>
                    </>
                );
            } else if (read.size === 'too-small') {
                const canSave = !!pasted || !!read.url;
                second = canSave
                    ? t("Too little for a course, but it can be a note.")
                    : t("Too little for a course.");
                actions = <>{clearButton}{canSave && <Button variant="primary" busy={busy} onClick={() => void saveToInbox(read, pasted)}>{t("Save to Inbox")}</Button>}</>;
            } else if (!read.ai) {
                second = `${readLine(read, !!pasted)} · ${t("Writing it needs an AI connection.")}`;
                actions = <>{clearButton}<ConnectAIActions returnTo="/projects" /></>;
            } else {
                second = readLine(read, !!pasted);
                actions = <>{clearButton}<Button variant="primary" busy={busy} onClick={() => void create({ stagedId: read.stagedId }, read)}>{t("Create short course")}</Button></>;
            }
            break;
        }
    }

    const empty = box.state === 'empty';
    return (
        <div
            data-short="source"
            {...dropProps}
            className={cx(
                'rounded-xl border bg-white dark:bg-slate-800 px-4 py-3 transition-colors',
                dragOver ? 'border-accent ring-2 ring-accent'
                    : empty
                        ? 'border-slate-300 dark:border-slate-600 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent'
                        : 'border-slate-200 dark:border-slate-700',
                narrow ? 'flex flex-col gap-3' : 'flex items-center gap-3 min-h-[4.5rem]',
            )}
        >
            <div className="flex items-center gap-3 min-w-0 flex-1">
                {tile}
                <div className="min-w-0 flex-1">
                    {empty ? first : (
                        <p className={cx('text-base font-medium text-slate-900 dark:text-white', narrow ? 'line-clamp-2' : 'truncate')} title={typeof first === 'string' ? first : undefined}>{first}</p>
                    )}
                    <p className={cx('text-sm', box.state === 'unreadable' ? 'text-slate-600 dark:text-slate-300' : 'text-slate-500 dark:text-slate-400', narrow || box.state === 'unreadable' ? 'line-clamp-3' : 'truncate')}>{second}</p>
                </div>
                {corner}
            </div>
            {actions && (
                <div className={cx(
                    'items-center gap-2 shrink-0',
                    narrow && pair ? 'grid grid-cols-2' : 'flex flex-wrap',
                    narrow && 'justify-end',
                )}>
                    {actions}
                </div>
            )}
            <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={e => {
                    // Copied before the input is cleared: a FileList is live.
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void readFile(file);
                }}
            />
        </div>
    );
}

function ShortCard({ row, project, onChanged }: {
    row: ShortCourseRow;
    /** The same course in the store: the one progress number every surface shows. */
    project: Project | undefined;
    onChanged: () => void;
}) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const openProject = useStore(s => s.openProject);
    const studyProject = useStore(s => s.studyProject);
    const updateProject = useStore(s => s.updateProject);
    const deleteProject = useStore(s => s.deleteProject);
    const showConfirm = useStore(s => s.showConfirm);
    const addToast = useStore(s => s.addToast);
    const [menuOpen, setMenuOpen] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const menuRef = useRef<HTMLButtonElement>(null);
    const KindIcon = KIND_ICON[row.kind] ?? File;

    const progress = Math.round((project?.progress_fraction ?? (row.topics ? row.done / row.topics : 0)) * 100);
    const done = project?.completed_topic_count ?? row.done;
    const total = project?.topic_count ?? row.topics;
    const building = row.state === 'building';
    const failed = row.state === 'failed';

    const retry = async () => {
        setRetrying(true);
        try {
            await api.retryShortCourse(row.id);
            onChanged();
        } catch (e) {
            const err = e as { data?: { reason?: string } } & Error;
            addToast('error', t("Could not write it"), err.data?.reason === 'no_ai' ? t("Writing it needs an AI connection.") : err.message);
        } finally {
            setRetrying(false);
        }
    };

    const setStatus = async (status: 'completed' | 'archived') => {
        setMenuOpen(false);
        if (await updateProject(row.id, { status })) onChanged();
    };

    const remove = async () => {
        setMenuOpen(false);
        const confirmed = await showConfirm({
            title: t("Delete Project"),
            message: t("Delete \"{{name}}\" and all its contents? This action cannot be undone.", { name: row.name }),
            confirmLabel: t("Delete"),
            variant: 'danger',
        });
        if (!confirmed) return;
        await deleteProject(row.id);
        onChanged();
    };

    const menu = (
        <>
            <IconButton
                ref={menuRef}
                label={t("Course options")}
                tooltip={false}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                icon={<MoreVertical className="w-4 h-4" />}
                onClick={() => setMenuOpen(o => !o)}
                onKeyDown={menuTriggerKeys(() => setMenuOpen(true))}
            />
            <MenuPopover open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={menuRef} label={t("Course options")} align="end">
                {row.url && (
                    <MenuItem icon={<ExternalLink className="w-4 h-4" />} href={row.url} onSelect={() => setMenuOpen(false)}>
                        {t("Open the source")}
                    </MenuItem>
                )}
                {!building && !failed && (
                    <MenuItem icon={<CheckCircle2 className="w-4 h-4 text-emerald-500" />} onSelect={() => void setStatus('completed')}>{t("Mark completed")}</MenuItem>
                )}
                <MenuItem icon={<Archive className="w-4 h-4" />} onSelect={() => void setStatus('archived')}>{t("Archive")}</MenuItem>
                <div className="my-1 h-px bg-slate-100 dark:bg-slate-600" />
                <MenuItem tone="danger" icon={<Trash2 className="w-4 h-4" />} onSelect={() => void remove()}>{t("Delete")}</MenuItem>
            </MenuPopover>
        </>
    );

    const meta = failed ? (
        <>
            <CircleAlert className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{t("Its topics could not be written.")}</span>
        </>
    ) : row.from ? (
        <>
            <KindIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{row.from}</span>
        </>
    ) : (
        <>
            <Sparkles className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{t("Written from its title")}</span>
        </>
    );

    // Being written: the line that says so stands where the ring and the
    // count will be, so nothing moves when they arrive.
    const reading = building ? (
        <span className="inline-flex items-center gap-2 text-sm text-accent-fg">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> {t("Writing the topics…")}
        </span>
    ) : failed ? null : (
        <>
            <ProgressRing progress={progress} color={progress === 100 ? '#22C55E' : row.color} size={40} />
            <span className="text-sm text-slate-500 dark:text-slate-400 min-w-0 truncate">
                {t("{{done}} / {{total}} topics", { done: num(done), total: num(total) })}
            </span>
        </>
    );

    const action = building ? undefined : failed ? (
        <Button variant="neutral" busy={retrying} icon={<RotateCcw className="w-4 h-4" aria-hidden="true" />} onClick={() => void retry()}>
            {t("Try again")}
        </Button>
    ) : (
        <Button variant="primary" icon={<Play className="w-4 h-4" aria-hidden="true" />} title={t("Study {{name}}", { name: row.name })} onClick={() => studyProject(row.id)}>
            {t("Study")}
        </Button>
    );

    return (
        <CompactCard
            data="short"
            color={row.color}
            icon={row.icon}
            name={row.name}
            meta={meta}
            metaTone={failed ? 'warn' : 'plain'}
            reading={reading}
            action={action}
            menu={menu}
            onOpen={() => void openProject(row.id)}
        />
    );
}

export default function ShortCourses({ rows, projects, onChanged, onFullCourse, showBox = true }: {
    /** The short courses to show (the page has already left out the finished,
     *  the archived and what a search does not match); null until loaded. */
    rows: ShortCourseRow[] | null;
    projects: Project[];
    onChanged: () => void;
    onFullCourse: (doc: StagedDocument, title: string) => void;
    showBox?: boolean;
}) {
    const { t } = useTranslation();
    const ref = useRef<HTMLElement>(null);
    const width = useElementWidth(ref);
    const narrow = width > 0 && width < NARROW_PX;
    const list = rows ?? [];
    const byId = new Map(projects.map(p => [p.id, p]));

    if (!showBox && !list.length) return null;
    return (
        <section ref={ref} aria-label={t("Short courses")} className="mb-10">
            <SectionLabel>{list.length ? `${t("Short courses")} · ${list.length}` : t("Short courses")}</SectionLabel>
            {showBox && <SourceBox projects={projects} narrow={narrow} onCreated={onChanged} onFullCourse={onFullCourse} />}
            {list.length > 0 && (
                <div className={cx(COMPACT_GRID, showBox && 'mt-4')}>
                    {list.map(row => <ShortCard key={row.id} row={row} project={byId.get(row.id)} onChanged={onChanged} />)}
                </div>
            )}
        </section>
    );
}
