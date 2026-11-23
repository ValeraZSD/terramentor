// src/components/NewProjectModal.tsx
// The New course window, the ONE place a course is started. It opens on a
// choice: create a course, or import one (a course file, a deck, or a course
// another chatbot wrote). What is typed in it lives in the form below, which
// exists only while the window is open, so every way of closing it (Cancel,
// Escape, the backdrop, a finished import) also clears it. An AI creation is
// STARTED here and then lives in creation/creationRuns.ts — its screen, its
// stream and its ETA — so the form stays a form while any number of runs go on.
//
// A course is built FROM any mix of material: links (a web page, a YouTube
// video) read the moment they are pasted (POST /api/short-courses/read) and
// files read the moment they are dropped (POST /api/documents/staged), so the
// window shows what each will contribute, and the run has them in hand before
// its first model call. With material, a name is optional — it names the
// course. The learner never says how big the course is: the run judges it from
// the name, the goal and the material (server/courseShape.js), a few topics on
// one level for one video or a short document, phases for a subject or a book.
//
// One column at every width: the name (with the icon-and-colour tile at its
// start), the goal, the lessons' language, the material, and one button, in a
// box of fixed size (`COURSE_DIALOG_SIZE`). Appearance is a single tile rather
// than a set of open controls beside the form.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { ChevronRight, FileInput, Link2, MessageSquare, PenLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store';
import { api } from '../api';
import Modal from './Modal';
import { StudyLanguageField } from './ProjectFormFields';
import { freeColour } from '../utils/freeColour';
import { OutlineBriefPanel } from './ExternalAuthoring';
import type { BriefKept } from './ExternalAuthoring';
import ProjectImportZone from './ProjectImportZone';
import SourceFiles, { MAX_FILE_BYTES, MAX_SOURCE_FILES, hostOf, linksIn, onlyLinks, usableSource, type SourceFile } from './creation/SourceFiles';
import { Button } from './ui/Button';
import { Field, TextArea, TextInput } from './ui/Field';
import ScrollShade from './ui/ScrollShade';
import { useElementWidth } from '../hooks/useElementWidth';
import { useRootFontSize } from '../hooks/useRootFontSize';
import { firstField, focusableIn } from '../hooks/useDialogFocus';
import { useConfirmDiscard } from '../hooks/useConfirmDiscard';
import { hasPhysicalKeyboard } from '../utils/platform';
import { cx, FOCUS_RING } from './ui/vocabulary';
import { COURSE_DIALOG_SIZE, openCreationRun, startCreationRun, type CreationInput } from './creation/creationRuns';
import { preloadCreationRunView } from './creation/CreationRunHost';
import AppearancePicker from './creation/AppearancePicker';
import { DEFAULT_PROJECT_ICON } from './ProjectIcon';
import { findLearningLanguage } from '../../server/learningLanguage.js';
import { catalogLanguage, languagesFromAcceptHeader, resolveCreationLanguage, typedName } from '../../server/creationLanguage.js';
import type { StagedDocument } from '../types';

/** One upload request's share of a batch of files: under the server's 100
 *  files and 256 MB per request, with room to spare. */
const STAGE_BATCH_FILES = 20;
const STAGE_BATCH_BYTES = 200 * 1024 * 1024;
/** Links read at once in one window; the rest wait their turn (see `pumpReads`). */
const LINK_READS_AT_ONCE = 4;
/** What one link read sends: the link, or a transcript pasted for it. */
type ReadBody = { url?: string; transcript?: string; title?: string };
/** The form's own width at which the foot is one row: its sentence, then the
 *  import button, then Create (the sentence may wrap to two lines there). */
const ONE_ROW_FOOT_REM = 38;

/** `draft` refills the form: a creation that failed before it made a project
 *  hands back what was typed, and its files, still read (see `takeDraft`). */
export default function NewProjectModal({ isOpen, draft, onClose }: {
    isOpen: boolean;
    draft: CreationInput | null;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    // Staged files belong to the dialog until a Create hands them on. Every
    // other way out — Cancel, Escape, the backdrop, another tab's import —
    // lets them go (the server forgets them within a day anyway).
    const release = useRef<(() => void) | null>(null);
    const cancel = () => { release.current?.(); onClose(); };
    // Whether the form holds the learner's work: a typed name or goal, an added
    // file or link. Set by the form on every render, like `release`.
    const holdsWork = useRef(false);
    const confirmDiscard = useConfirmDiscard();
    // Every way of closing it unasked (✕, Escape, a tap outside, the system's
    // Back on the first step) asks first when there is work to lose. An import
    // that finished and Create with AI are not discards: they close directly.
    const leave = async () => {
        if (holdsWork.current && !(await confirmDiscard(t("What you typed and the material you added will not be kept.")))) return;
        cancel();
    };
    // The first step, two tiles, takes the height it needs; the form and the
    // run that replaces it in place share the fixed box.
    const [choosing, setChoosing] = useState(!draft);
    // Where the title's ← goes, set by the step on show; none on the first.
    const [back, setBack] = useState<(() => void) | null>(null);
    const onBack = useCallback((to: (() => void) | null) => setBack(() => to), []);
    // Always the FORM: a creation in progress has its own screen
    // (creation/CreationRunView), so this dialog never turns into one and
    // never stands between the reader and a new project.
    return (
        // "New course": every line in the dialog says course (Course material,
        // Import a course, Lessons…), so the title says it too.
        <Modal isOpen={isOpen} onClose={leave} title={t("New course")} maxWidth={COURSE_DIALOG_SIZE.maxWidth}
            className={choosing ? '' : COURSE_DIALOG_SIZE.className} fill onBack={back ?? undefined}>
            <NewProjectForm draft={draft} onClose={onClose} onCancel={cancel} release={release} holdsWork={holdsWork} onChoosing={setChoosing} onBack={onBack} />
        </Modal>
    );
}

const fromDraft = (docs: StagedDocument[] = []): SourceFile[] =>
    docs.map((doc, i) => ({
        key: `draft-${i}`, name: doc.title, size: doc.ok ? doc.file_size ?? 0 : 0, status: 'done', doc,
        // A link comes back as a link, not as the text file it was kept as.
        url: doc.ok && doc.source?.url ? doc.source.url : undefined,
    }));

/** One of the window's first two choices: a card the whole of which is the button. */
function Choice({ icon, title, line, onClick }: { icon: ReactNode; title: string; line: string; onClick: () => void }) {
    return (
        <button
            type="button"
            data-tile=""
            onClick={onClick}
            className={cx(
                'flex w-full items-center gap-4 rounded-xl border border-slate-200 bg-white px-4 py-4 text-left transition-colors',
                'dark:border-slate-700 dark:bg-slate-800 can-hover:hover:border-accent',
                FOCUS_RING,
            )}
        >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200">{icon}</span>
            <span className="min-w-0 flex-1">
                <span className="block text-base font-medium text-slate-900 dark:text-white">{title}</span>
                <span className="block text-sm text-slate-500 dark:text-slate-400">{line}</span>
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-slate-400" aria-hidden="true" />
        </button>
    );
}

function NewProjectForm({ draft, onClose, onCancel, release, holdsWork, onChoosing, onBack }: {
    draft: CreationInput | null;
    /** Whether the first step (create or import) is showing. */
    onChoosing: (choosing: boolean) => void;
    /** What the title's ← does on this step; null on the first. */
    onBack: (to: (() => void) | null) => void;
    /** Closes after a Create: the files went with it. */
    onClose: () => void;
    /** Closes and lets the staged files go. */
    onCancel: () => void;
    release: MutableRefObject<(() => void) | null>;
    /** Written on every render: does a close have work to lose? */
    holdsWork: MutableRefObject<boolean>;
}) {
    const { t } = useTranslation();
    const openProject = useStore(s => s.openProject);
    const projects = useStore(s => s.projects);
    const uiLanguage = useStore(s => s.uiLanguage);

    // A plain open asks first: create or import. A form handed back (a run's
    // Back, the assistant's "Open in New course") opens on the form itself.
    const [createMode, setCreateMode] = useState<'choose' | 'ai' | 'external' | 'import'>(draft ? 'ai' : 'choose');
    // The chatbot path's own fields and the reply pasted back, kept here so a
    // step back (its ←, the system's Back) does not drop them.
    const [brief, setBrief] = useState<BriefKept>({ level: '', goal: '', reply: '' });
    // A link typed into the source box but not yet added.
    const [linkDraft, setLinkDraft] = useState('');
    // Before paint, so a reopened dialog never shows the old height first.
    useLayoutEffect(() => { onChoosing(createMode === 'choose'); }, [createMode, onChoosing]);
    const [newName, setNewName] = useState(draft?.name ?? '');
    const [newDescription, setNewDescription] = useState(draft?.description ?? '');
    // Colour and icon start as the first palette colour no other project
    // wears (so a library does not turn one purple) and the folder. They are
    // one tile at the start of the Name field (creation/AppearancePicker),
    // which costs no row and shows what the course will wear.
    const [newColor, setNewColor] = useState(() => draft?.color || freeColour(projects));
    const [newIcon, setNewIcon] = useState(() => draft?.icon || DEFAULT_PROJECT_ICON);
    const [newLanguage, setNewLanguage] = useState(draft?.language ?? '');
    const [files, setFiles] = useState<SourceFile[]>(() => fromDraft(draft?.documents));
    // The name field has been typed in: a file's title never overwrites that.
    const nameTyped = useRef(!!draft?.name);

    // What a cancel lets go. Set on every render, so it always sees the
    // current list. Not an unmount cleanup: React's development double-mount
    // runs those once on the way IN, and would let a draft's files go.
    const filesRef = useRef(files);
    filesRef.current = files;
    // A row the learner added counts even when its read failed: it was theirs.
    holdsWork.current = !!newName.trim() || !!newDescription.trim() || files.length > 0
        || !!brief.level.trim() || !!brief.goal.trim() || !!brief.reply.trim() || !!linkDraft.trim();
    // The links being read, by row: removing a row, or closing the window,
    // stops its read, and a read that ends after that lets its source go.
    const readers = useRef(new Map<string, AbortController>());
    // Links waiting for a read lane (see `queueRead`).
    const readQueue = useRef<{ key: string; body: ReadBody }[]>([]);
    const lanesBusy = useRef(0);
    // Row keys: a count, so two adds in one millisecond never share one. A
    // draft's rows are `draft-<n>` and cannot meet these.
    const rowCount = useRef(0);
    release.current = () => {
        readQueue.current = [];
        for (const ac of readers.current.values()) ac.abort();
        for (const f of filesRef.current) if (f.doc?.ok) void api.discardStagedDocument(f.doc.id).catch(() => { });
    };
    // A read that finishes after the dialog closed lets its file go too.
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
        // Create swaps this form for the run's screen in the same box: have
        // its chunk here before the press (see CreationRunHost).
        preloadCreationRunView();
        return () => { mounted.current = false; };
    }, []);
    // The learner's profile (Settings → About you): the language it is written
    // in is one of the four that say which language they read best.
    const [profile, setProfile] = useState('');
    useEffect(() => {
        api.getSettings().then(s => { if (mounted.current) setProfile(s.user_profile || ''); }).catch(() => { });
    }, []);

    // Read one batch of files on the server and fill in their rows (`keys`,
    // in the same order).
    const stageBatch = useCallback((send: File[], keys: string[]) => {
        api.stageDocumentFiles(send).then(({ documents }) => {
            if (!mounted.current) {
                for (const d of documents) if (d.ok) void api.discardStagedDocument(d.id).catch(() => { });
                return;
            }
            setFiles(prev => prev.map(f => {
                const i = keys.indexOf(f.key);
                return i < 0 ? f : { ...f, status: 'done', doc: documents[i] };
            }));
            // The first real title a file carries names the course, unless a
            // name was typed. A title made from a file name is only a
            // placeholder: "lecture_03_final" is not a course.
            const titled = documents.find(d => d.ok && !d.noText && d.titleFrom === 'metadata');
            if (titled?.ok && !nameTyped.current) {
                setNewName(prev => (prev.trim() ? prev : titled.suggestedTitle));
            }
        }).catch((e: any) => {
            if (!mounted.current) return;
            setFiles(prev => prev.map(f => (keys.includes(f.key) ? { ...f, status: 'done', error: e?.message || t("Upload failed") } : f)));
        });
    }, [t]);

    const addToast = useStore(s => s.addToast);
    const addFiles = useCallback((all: File[]) => {
        // SourceFiles has already cut a pick to the room it saw and said so;
        // this is the count that moves at once, so two picks that land in the
        // same tick still share the hundred, and a cut here is said too.
        const picked = all.slice(0, Math.max(0, MAX_SOURCE_FILES - filesRef.current.length));
        if (picked.length < all.length) addToast('info', t("A course is made from at most 100 links and files."));
        const entries: SourceFile[] = picked.map((f) => ({
            key: `src-${++rowCount.current}`, name: f.name, size: f.size,
            status: f.size > MAX_FILE_BYTES ? 'done' : 'reading',
            error: f.size > MAX_FILE_BYTES ? t("Over the 25 MB limit for one file.") : undefined,
        }));
        filesRef.current = [...filesRef.current, ...entries];
        setFiles(prev => [...prev, ...entries]);
        const sendable = entries.flatMap((e, i) => (e.status === 'reading' ? [{ file: picked[i], key: e.key }] : []));
        // In batches: a folder can be a hundred files, and one request is
        // capped at 256 MB (server/routes/documents.js), so ten 25 MB PDFs
        // would fail together. Each batch fills its own rows.
        const batches: { file: File; key: string }[][] = [];
        let bytes = 0;
        for (const item of sendable) {
            const last = batches[batches.length - 1];
            if (!last || last.length >= STAGE_BATCH_FILES || bytes + item.file.size > STAGE_BATCH_BYTES) {
                batches.push([item]);
                bytes = item.file.size;
            } else {
                last.push(item);
                bytes += item.file.size;
            }
        }
        for (const batch of batches) stageBatch(batch.map(b => b.file), batch.map(b => b.key));
    }, [stageBatch, addToast, t]);

    // Read one link (or a transcript pasted for it) into its row, by its own
    // request. A window closed or a row removed while it read is cleared up by
    // the server, which drops what it staged for a request nobody waits for.
    const readInto = useCallback((key: string, body: ReadBody): Promise<void> => {
        readers.current.get(key)?.abort();
        const ac = new AbortController();
        readers.current.set(key, ac);
        setFiles(prev => prev.map(f => (f.key === key ? { ...f, status: 'reading', fail: undefined, error: undefined } : f)));
        return api.readShortSource(body, ac.signal).then(r => {
            if (readers.current.get(key) === ac) readers.current.delete(key);
            // Removed, replaced or the window closed while it read.
            if (ac.signal.aborted || !mounted.current) {
                if (r.ok) void api.discardShortSource(r.stagedId).catch(() => { });
                return;
            }
            setFiles(prev => prev.map(f => (f.key !== key ? f : !r.ok
                ? { ...f, status: 'done', fail: r }
                : r.staged
                    ? { ...f, status: 'done', name: r.title, doc: r.staged, fail: undefined }
                    : { ...f, status: 'done', error: t("Could not read it") })));
        }).catch((e: unknown) => {
            if (readers.current.get(key) === ac) readers.current.delete(key);
            if (ac.signal.aborted || !mounted.current) return;
            setFiles(prev => prev.map(f => (f.key === key ? { ...f, status: 'done', error: e instanceof Error ? e.message : t("Could not read it") } : f)));
        });
    }, [t]);

    // Every link read waits here for one of LINK_READS_AT_ONCE lanes shared by
    // the whole window: pastes, Retry and pasted transcripts alike. Each
    // read's timeout starts when it is sent, and a browser sends only about
    // six at once to one server, so forty links sent together would time out
    // waiting their turn. A row removed or a window closed before its turn is
    // not read.
    const pumpReads = useCallback(() => {
        while (lanesBusy.current < LINK_READS_AT_ONCE) {
            const job = readQueue.current.shift();
            if (!job) return;
            if (!mounted.current || !filesRef.current.some(f => f.key === job.key)) continue;
            lanesBusy.current++;
            void readInto(job.key, job.body).finally(() => { lanesBusy.current--; pumpReads(); });
        }
    }, [readInto]);
    const queueRead = useCallback((key: string, body: ReadBody) => {
        // A row asked again (Retry, then a transcript) keeps only its latest ask.
        readQueue.current = [...readQueue.current.filter(j => j.key !== key), { key, body }];
        setFiles(prev => prev.map(f => (f.key === key ? { ...f, status: 'reading', fail: undefined, error: undefined } : f)));
        pumpReads();
    }, [pumpReads]);

    // The links the cap refused, so a caller can keep them where they were typed.
    const addLinks = useCallback((urls: string[]): string[] => {
        // A link already in the list is not read twice.
        const have = new Set(filesRef.current.map(f => f.url).filter(Boolean));
        const wanted = urls.filter(u => !have.has(u));
        const fresh = wanted.slice(0, Math.max(0, MAX_SOURCE_FILES - filesRef.current.length));
        if (fresh.length < wanted.length) {
            addToast('info', t("Some links were left out"), t("A course is made from at most 100 links and files."));
        }
        const entries: SourceFile[] = fresh.map((url) => ({ key: `src-${++rowCount.current}`, name: hostOf(url), size: 0, status: 'reading', url }));
        // Now, not at the next render: a second paste in the same tick counts these.
        filesRef.current = [...filesRef.current, ...entries];
        setFiles(prev => [...prev, ...entries]);
        readQueue.current = [...readQueue.current, ...entries.map(e => ({ key: e.key, body: { url: e.url } }))];
        pumpReads();
        return wanted.slice(fresh.length);
    }, [pumpReads, addToast, t]);

    const linkFixes = {
        onRetry: (key: string) => {
            const f = filesRef.current.find(x => x.key === key);
            if (f?.url) queueRead(key, { url: f.url });
        },
        onTranscript: (key: string, transcript: string) => {
            const f = filesRef.current.find(x => x.key === key);
            if (!f) return;
            queueRead(key, { transcript, title: f.fail?.title || undefined, url: f.fail?.url || f.url || undefined });
        },
        // A video with nothing to read: the course is written from its title.
        onUseTitle: (key: string) => {
            const f = filesRef.current.find(x => x.key === key);
            if (!f?.fail?.title) return;
            nameTyped.current = true;
            setNewName(f.fail.title);
            setFiles(prev => prev.filter(x => x.key !== key));
        },
    };

    const removeFile = (key: string) => {
        const f = files.find(x => x.key === key);
        readers.current.get(key)?.abort();
        readers.current.delete(key);
        if (f?.doc?.ok) void api.discardStagedDocument(f.doc.id).catch(() => { });
        // Now, like an add: files that replace this row count its place free.
        filesRef.current = filesRef.current.filter(x => x.key !== key);
        setFiles(prev => prev.filter(x => x.key !== key));
    };

    const reading = files.some(f => f.status === 'reading');
    const usable = files.filter(usableSource);
    const claimable = files.flatMap(f => (f.doc?.ok ? [f.doc] : []));
    const firstTitle = usable[0]?.doc?.ok ? usable[0].doc.suggestedTitle : '';
    const name = newName.trim();
    // What the button waits for, said beside it rather than left to a greyed
    // button to imply.
    const blockedAI = reading ? t("Reading your material…")
        : !name && !usable.length ? t("Type a name, or add a link or a file, to start.")
            : '';
    // A link pasted into the Name: the learner meant it as material.
    const nameLinks = linksIn(newName);
    const nameIsLink = onlyLinks(newName);

    // ONE way to create here, with AI. A course is not built by hand, so the
    // dialog offers no empty-project button. The other doors are Import and
    // another chatbot.
    //
    // Start a creation and hand it to the run store: the dialog closes, and
    // opens blank again, at once, so "New project" can start an import or
    // another generation while this one runs. The run's own screen
    // opens over the grid; closing it leaves the run going (the task bar has it).
    const handleCreateWithAI = () => {
        if (blockedAI) return;
        const key = startCreationRun({
            name,
            description: newDescription,
            color: newColor,
            icon: newIcon || 'brain',
            language: newLanguage,
            documents: claimable,
        });
        onClose();
        openCreationRun(key);
    };

    const bodyRef = useRef<HTMLDivElement>(null);
    // A tile or the title's ← changes the view under the focus: move it into the
    // view that replaced it, the way the dialog's own open does
    // (`useDialogFocus`), or a keyboard or a screen reader is left on the page.
    const moved = useRef(false);
    const go = (mode: typeof createMode) => { moved.current = true; setCreateMode(mode); };
    // Past the first choice, the title's ← says how to come back. The chatbot
    // view is reached FROM the import view, so its ← goes there. Before paint,
    // with the height (`onChoosing`), so the head never shows the old step's.
    useLayoutEffect(() => {
        onBack(createMode === 'choose' ? null : () => go(createMode === 'external' ? 'import' : 'choose'));
        // Gone with the step: a closed window opens again without the last one's ←.
        return () => onBack(null);
        // `go` only sets state and a ref.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [createMode, onBack]);
    useEffect(() => {
        const box = bodyRef.current;
        if (!moved.current || !box) return;
        moved.current = false;
        const target = createMode === 'choose' ? box.querySelector<HTMLElement>('[data-tile]')
            : (hasPhysicalKeyboard() ? firstField(box) : null) ?? focusableIn(box)[0];
        target?.focus({ preventScroll: true });
    }, [createMode]);
    const width = useElementWidth(bodyRef);
    const rootPx = useRootFontSize();
    const wide = width >= ONE_ROW_FOOT_REM * rootPx;
    // What "Automatic" will pick, said in the option: the server's own rule
    // (server/creationLanguage.js), run here on what the server will be given.
    // The files' language is the server's read of the longest file
    // (`stagedSummary().language`); the app language is the setting (null
    // while it follows the browser); the browser's list is the Accept-Language
    // the server reads; a name the file filled in is not the learner's. The
    // option names the strongest signal's language, which is also what the
    // course gets when the creation's AI check has nothing to add.
    // A bare "Automatic" would leave a learner who typed "Learn Dutch" over a
    // Dutch worksheet unable to tell which language the lessons would be in.
    const longest = usable.reduce<StagedDocument | null>((best, f) => (f.doc?.ok && (!best?.ok || f.doc.char_count > best.char_count) ? f.doc : best), null);
    const appLanguage = catalogLanguage(uiLanguage);
    const browserLanguages = languagesFromAcceptHeader(typeof navigator === 'undefined' ? '' : (navigator.languages ?? [navigator.language]).join(','));
    const fileTitles = usable.flatMap(f => (f.doc?.ok ? [f.doc.suggestedTitle] : []));
    const automaticAs = resolveCreationLanguage({
        name: typedName(name, fileTitles),
        description: newDescription,
        filesLanguage: longest?.ok ? longest.language : null,
        uiLanguage: appLanguage ?? browserLanguages[0] ?? null,
        appLanguage,
        browserLanguages,
        profile,
        learning: findLearningLanguage({ name, description: newDescription }).named,
    }).code;
    // NAME, GOAL, LANGUAGE, then the course's MATERIAL.
    // A course is made from a name and a goal; files are an optional extra it
    // is built FROM when there are some, so they come last — and at the
    // bottom the list grows where nothing is under it. Name takes the focus
    // (the dialog's first field, `useDialogFocus`).
    //
    // The goal and the lessons' language are SHOWN, never behind a fold: what
    // the learner is aiming at shapes the whole course. The language is one
    // select whose Automatic option names what the files decided.
    const form = (
        <>
            <Field
                label={t("Name")}
                // No "Taken from …" once a file has filled it: the file is
                // listed below and the field shows the name.
                hint={usable.length && !name ? t("Optional with material: the course is named after it.") : undefined}
            >
                {id => (
                    <>
                        {/* The tile at the start of the field is the course's
                            icon and colour (creation/AppearancePicker): it sits
                            where the card will show them, beside the name. */}
                        <div className="relative min-w-0">
                            <div className="absolute left-1 top-1/2 z-10 -translate-y-1/2 touch:left-0">
                                <AppearancePicker icon={newIcon} color={newColor} onIcon={setNewIcon} onColor={setNewColor} />
                            </div>
                            <TextInput
                                id={id}
                                value={newName}
                                onChange={e => { nameTyped.current = true; setNewName(e.target.value); }}
                                placeholder={firstTitle || t("e.g., Machine Learning, Japanese N3…")}
                                className="pl-11 touch:pl-12"
                            />
                        </div>
                        {/* The first box is where a learner holding only a
                            link pastes it. It is moved, not refused. */}
                        {nameIsLink && (
                            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                                <p className="text-sm text-slate-700 dark:text-slate-200">{t("That is a link.")}</p>
                                <Button variant="neutral" size="sm" icon={<Link2 className="h-4 w-4" />}
                                    onClick={() => {
                                        const refused = addLinks(nameLinks);
                                        if (refused.length) { setNewName(refused.join(' ')); return; }
                                        nameTyped.current = false; setNewName('');
                                    }}>
                                    {t("Add it to the course material")}
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </Field>
            {/* "(optional)" right after the label, read with it — at the far
                end of the row it would sit a dialog's width away. */}
            <Field label={<>{t("Goal")} <span className="font-normal text-slate-500 dark:text-slate-400">{t("(optional)")}</span></>}>
                {id => (
                    <TextArea
                        id={id}
                        value={newDescription}
                        onChange={e => setNewDescription(e.target.value)}
                        // An example, not an instruction: "Describe what you
                        // want to learn…" read as a required field. It names
                        // a DATE because a learner with an exam looked for
                        // where to say when it is, and this is the place.
                        placeholder={t("For example: my exam on 14 November, or reaching level B1")}
                        rows={2}
                        className="resize-none"
                    />
                )}
            </Field>
            <StudyLanguageField language={newLanguage} setLanguage={setNewLanguage} isNew automaticAs={automaticAs} />
            <SourceFiles files={files} onAdd={addFiles} onRemove={removeFile} onLinks={addLinks} fixes={linkFixes} draft={linkDraft} onDraft={setLinkDraft} />
        </>
    );

    return (
        <>
            {/* The ONE scroll region: the dialog's title above it and the
                buttons below it stay put, and a shade at its edge says when
                there is more (at 1280x800 the file list runs under the foot). */}
            <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
            <ScrollShade frameClassName="flex min-h-0 flex-1 flex-col" className="min-h-0 flex-1 px-6 py-4">
                {/* The chatbot view names itself; the import view's own zone
                    already says what it takes, and a heading over it said the
                    same thing twice. */}
                {createMode === 'external' && (
                    <h3 className="mb-4 text-base font-semibold text-slate-900 dark:text-white">
                        {t("Make a course with an external chatbot")}
                    </h3>
                )}

                <div>
                    {createMode === 'choose' ? (
                        // Two doors, the one most people want first. Creating
                        // takes anything the learner has; importing takes what
                        // was made elsewhere.
                        <div className="space-y-3">
                            <Choice
                                icon={<PenLine className="h-5 w-5" />}
                                title={t("Create a course")}
                                line={t("Say what you want to learn, and add links or files if you have them. The AI sizes it to fit.")}
                                onClick={() => go('ai')}
                            />
                            <Choice
                                icon={<FileInput className="h-5 w-5" />}
                                title={t("Import a course")}
                                line={t("A course file, an Anki deck, or a course another chatbot wrote.")}
                                onClick={() => go('import')}
                            />
                        </div>
                    ) : createMode === 'external' ? (
                        <OutlineBriefPanel
                            subject={newName}
                            setSubject={setNewName}
                            language={newLanguage}
                            onImported={(id) => { onCancel(); openProject(id); }}
                            kept={brief}
                            onKeep={setBrief}
                        />
                    ) : createMode === 'import' ? (
                        <div className="space-y-4">
                            <ProjectImportZone onDone={onCancel} />
                            {/* A course another chatbot wrote is an import too,
                                so it is offered HERE rather than from a menu
                                beside the import button, whose first item would
                                only repeat that button's words. It says what the
                                learner DOES there — has a chatbot make the
                                course — rather than "Paste…", the last step of
                                it. */}
                            {/* `wrap`: on a phone (and in most languages) the
                                label takes two lines. */}
                            <Button variant="subtle" wrap icon={<MessageSquare className="h-4 w-4 shrink-0" />} onClick={() => go('external')}>
                                {t("Or make a course with an external chatbot")}
                            </Button>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {form}
                        </div>
                    )}
                </div>
            </ScrollShade>
            </div>

            {createMode === 'ai' && (
                <div className={cx(
                    'flex shrink-0 border-t border-slate-200 px-6 py-3 dark:border-slate-700',
                    wide ? 'items-center gap-3' : 'flex-col gap-2',
                )}>
                    {/* Why the button is not ready, in words, where the eye goes
                        when a press does nothing — and nothing otherwise. It
                        KEEPS its room when there is nothing to say: hidden, it
                        would move the foot's top edge on a phone the moment a
                        file was read. */}
                    <p className={cx('min-w-0 text-sm text-slate-500 dark:text-slate-400', wide && 'flex-1', !blockedAI && 'invisible')} aria-live="polite">
                        {blockedAI || t("Type a name, or add a link or a file, to start.")}
                    </p>
                    {/* Import is the window's other first choice (Back), so the
                        foot holds Create alone. One primary button, and Cancel is the dialog's ✕ (and
                        Escape). Narrow, it takes the full width. */}
                    <div className={cx('flex', wide ? 'shrink-0' : '[&>button]:w-full')}>
                        <Button variant="primary" onClick={handleCreateWithAI} disabled={!!blockedAI} title={blockedAI || undefined} icon={<PenLine className="w-4 h-4" />} className="whitespace-nowrap">
                            {t("Create with AI")}
                        </Button>
                    </div>
                </div>
            )}
        </>
    );
}
