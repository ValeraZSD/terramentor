// src/components/NewProjectModal.tsx
// The New project dialog, opened from the Projects page: three ways to start a
// project — with AI, through a chat model, or from a file. What is typed in it
// lives in the form below, which exists only while the dialog is open, so every
// way of closing it (Cancel, Escape, the backdrop, a finished import) also
// clears it. An AI creation is STARTED here and then lives in
// creation/creationRuns.ts — its screen, its stream and its ETA — so the form
// stays a form while any number of runs go on.
//
// A course can be built FROM files (a textbook, notes, past exams): they are
// read the moment they are dropped (POST /api/documents/staged), so the dialog
// shows what each will contribute, and the run has them in hand before its
// first model call. With a file, a name is optional — the file names the course.
//
// One column at every width: the name (with the icon-and-colour tile at its
// start), the goal, the lessons' language, the files, an outlined "Import a
// course or deck", and one button, in a box of fixed size
// (`COURSE_DIALOG_SIZE`). It was two columns with seventy appearance controls
// open beside the form, and seven rounds of outside readers (2026-10-02) took
// it down to this.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { ArrowLeft, FileInput, MessageSquare, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store';
import { api } from '../api';
import Modal from './Modal';
import { StudyLanguageField } from './ProjectFormFields';
import { PROJECT_COLORS, sameColor } from './ui/ColorField';
import { parseCssColor } from '../utils/color';
import { OutlineBriefPanel } from './ExternalAuthoring';
import ProjectImportZone from './ProjectImportZone';
import SourceFiles, { MAX_FILE_BYTES, usableSource, type SourceFile } from './creation/SourceFiles';
import { Button } from './ui/Button';
import { Field, TextArea, TextInput } from './ui/Field';
import ScrollShade from './ui/ScrollShade';
import { useElementWidth } from '../hooks/useElementWidth';
import { useRootFontSize } from '../hooks/useRootFontSize';
import { cx } from './ui/vocabulary';
import { COURSE_DIALOG_SIZE, openCreationRun, startCreationRun, type CreationInput } from './creation/creationRuns';
import { preloadCreationRunView } from './creation/CreationRunHost';
import AppearancePicker from './creation/AppearancePicker';
import { DEFAULT_PROJECT_ICON } from './ProjectIcon';
import { findLearningLanguage } from '../../server/learningLanguage.js';
import type { Project, StagedDocument } from '../types';

/** One upload request's share of a batch of files: under the server's 100
 *  files and 256 MB per request, with room to spare. */
const STAGE_BATCH_FILES = 20;
const STAGE_BATCH_BYTES = 200 * 1024 * 1024;
/** The form's own width at which the foot is one row: its sentence, then the
 *  import button, then Create (the sentence may wrap to two lines there). */
const ONE_ROW_FOOT_REM = 38;

/**
 * The order a new course is offered a colour in: the VIVID row from blue
 * round the wheel, then the soft row the same way, the greys last. Not the
 * palette's own order, which starts on the soft row's grey; and not red
 * first, which beside a focused Name field read as an error (2026-10-06).
 */
const OFFER_ORDER = [13, 14, 15, 9, 10, 11, 12, 5, 6, 7, 1, 2, 3, 4, 8, 0];

/** The first colour in `OFFER_ORDER` no other project wears, else blue. */
function freeColour(projects: Project[]): string {
    const worn = projects.map(p => parseCssColor(p.color)).filter((c): c is string => !!c);
    const offered = OFFER_ORDER.map(i => PROJECT_COLORS[i]);
    return offered.find(c => !worn.some(w => sameColor(w, c))) || offered[0];
}

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
    // Always the FORM: a creation in progress has its own screen
    // (creation/CreationRunView), so this dialog never turns into one and
    // never stands between the reader and a new project.
    return (
        // "New course": every line in the dialog says course (Course material,
        // Import a course, Lessons…), and a title saying Project was the one
        // word that did not match (three outside readers, 2026-10-02).
        <Modal isOpen={isOpen} onClose={cancel} title={t("New course")} {...COURSE_DIALOG_SIZE} fill>
            <NewProjectForm draft={draft} onClose={onClose} onCancel={cancel} release={release} />
        </Modal>
    );
}

const fromDraft = (docs: StagedDocument[] = []): SourceFile[] =>
    docs.map((doc, i) => ({ key: `draft-${i}`, name: doc.title, size: doc.ok ? doc.file_size ?? 0 : 0, status: 'done', doc }));

function NewProjectForm({ draft, onClose, onCancel, release }: {
    draft: CreationInput | null;
    /** Closes after a Create: the files went with it. */
    onClose: () => void;
    /** Closes and lets the staged files go. */
    onCancel: () => void;
    release: MutableRefObject<(() => void) | null>;
}) {
    const { t } = useTranslation();
    const openProject = useStore(s => s.openProject);
    const projects = useStore(s => s.projects);

    const [createMode, setCreateMode] = useState<'ai' | 'external' | 'import'>('ai');
    const [newName, setNewName] = useState(draft?.name ?? '');
    const [newDescription, setNewDescription] = useState(draft?.description ?? '');
    // Colour and icon start as the first palette colour no other project
    // wears (so a library does not turn one purple) and the folder. As
    // controls they were the largest part of this dialog and the first thing
    // every outside reader asked to lose (2026-10-02); now they are one tile
    // at the start of the Name field (creation/AppearancePicker), which costs
    // no row and shows what the course will wear.
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
    release.current = () => {
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

    const addFiles = useCallback((picked: File[]) => {
        const stamp = Date.now().toString(36);
        const entries: SourceFile[] = picked.map((f, i) => ({
            key: `${stamp}-${i}-${f.name}`, name: f.name, size: f.size,
            status: f.size > MAX_FILE_BYTES ? 'done' : 'reading',
            error: f.size > MAX_FILE_BYTES ? t("Over the 25 MB limit for one file.") : undefined,
        }));
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
    }, [stageBatch, t]);

    const removeFile = (key: string) => {
        const f = files.find(x => x.key === key);
        if (f?.doc?.ok) void api.discardStagedDocument(f.doc.id).catch(() => { });
        setFiles(prev => prev.filter(x => x.key !== key));
    };

    const reading = files.some(f => f.status === 'reading');
    const usable = files.filter(usableSource);
    const claimable = files.flatMap(f => (f.doc?.ok ? [f.doc] : []));
    const firstTitle = usable[0]?.doc?.ok ? usable[0].doc.suggestedTitle : '';
    const name = newName.trim();
    // What the button waits for, said beside it rather than left to a greyed
    // button to imply.
    const blockedAI = reading ? t("Reading your files…")
        : !name && !usable.length ? t("Type a name or add a file to start.")
            : '';

    // ONE way to create here, with AI. An empty-project button sat beside it
    // ("Create Empty", then "without AI", "empty project", "without lessons")
    // and four rounds of outside readers asked what it was for. Nobody opens
    // this app to build a course by hand, so the dialog does not offer it.
    // The other doors are Import and another chatbot.
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
    const width = useElementWidth(bodyRef);
    const rootPx = useRootFontSize();
    const wide = width >= ONE_ROW_FOOT_REM * rootPx;
    // What "Automatic" will pick, when the FILES decide it: the server's own
    // read of each file (`stagedSummary().language`), the first one that has
    // one. A typed goal is read before the files (resolveCreationLanguage), so
    // once there is one the dialog no longer claims to know. Nor when the name
    // says the course TEACHES the files' language ("Learn Dutch" over a Dutch
    // book): it is then not explained in it, and the same rule the server
    // runs (server/learningLanguage.js) says so here.
    const readFromFiles = newDescription.trim() ? null
        : usable.map(f => (f.doc?.ok ? f.doc.language : null)).find(Boolean) ?? null;
    const filesLanguage = readFromFiles && readFromFiles !== findLearningLanguage({ name }).named ? readFromFiles : null;
    // NAME, GOAL, LANGUAGE, then the course's MATERIAL (2026-10-06).
    // A course is made from a name and a goal; files are an optional extra it
    // is built FROM when there are some, so they come last — and at the
    // bottom the list grows where nothing is under it. Name takes the focus
    // (the dialog's first field, `useDialogFocus`). It was files first from
    // 2026-10-02: the zone was the dialog's first step and took the focus.
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
                hint={usable.length && !name ? t("Optional with a file: the course is named after it.") : undefined}
            >
                {id => (
                    // The tile at the start of the field is the course's icon
                    // and colour (creation/AppearancePicker): it sits where the
                    // card will show them, beside the name.
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
                )}
            </Field>
            {/* "(optional)" right after the label, read with it — at the far
                end of the row it sat a dialog's width away from its label. */}
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
            <StudyLanguageField language={newLanguage} setLanguage={setNewLanguage} isNew automaticAs={filesLanguage} />
            <SourceFiles files={files} onAdd={addFiles} onRemove={removeFile} />
        </>
    );

    return (
        <>
            {/* The ONE scroll region: the dialog's title above it and the
                buttons below it stay put, and a shade at its edge says when
                there is more (at 1280x800 the file list runs under the foot). */}
            <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
            <ScrollShade frameClassName="flex min-h-0 flex-1 flex-col" className="min-h-0 flex-1 px-6 py-4">
                {/* Taken, each of the other two ways names itself and says how
                    to come back. */}
                {createMode !== 'ai' && (
                    <div className="mb-4">
                        {/* The chatbot view is reached FROM the import view, so
                            its Back goes there. */}
                        <Button variant="quiet" size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => setCreateMode(createMode === 'external' ? 'import' : 'ai')} className="-ml-2">
                            {createMode === 'external' ? t("Back") : t("Back to creating with AI")}
                        </Button>
                        {/* The chatbot view names itself; the import view's own
                            zone already says what it takes, and a heading over
                            it said the same thing twice. */}
                        {createMode === 'external' && (
                            <h3 className="mt-2 text-base font-semibold text-slate-900 dark:text-white">
                                {t("Make a course with an external chatbot")}
                            </h3>
                        )}
                    </div>
                )}

                <div>
                    {createMode === 'external' ? (
                        <OutlineBriefPanel
                            subject={newName}
                            setSubject={setNewName}
                            language={newLanguage}
                            onImported={(id) => { onCancel(); openProject(id); }}
                        />
                    ) : createMode === 'import' ? (
                        <div className="space-y-4">
                            <ProjectImportZone onDone={onCancel} />
                            {/* A course another chatbot wrote is an import too,
                                so it is offered HERE rather than from a menu
                                beside the import button, whose first item only
                                repeated that button's words (three outside
                                readers, 2026-10-05). It says what the learner
                                DOES there — has a chatbot make the course —
                                rather than "Paste…", the last step of it
                                (2026-10-05). */}
                            {/* `wrap`: on a phone (and in most languages) the
                                label takes two lines. */}
                            <Button variant="subtle" wrap icon={<MessageSquare className="h-4 w-4 shrink-0" />} onClick={() => setCreateMode('external')}>
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
                        moved the foot's top edge 33px on a phone the moment a
                        file was read. */}
                    <p className={cx('min-w-0 text-sm text-slate-500 dark:text-slate-400', wide && 'flex-1', !blockedAI && 'invisible')} aria-live="polite">
                        {blockedAI || t("Type a name or add a file to start.")}
                    </p>
                    {/* The other way to start: ONE outlined button BESIDE
                        Create (narrow: under it, full width) that opens the
                        import view, where a chatbot's course is offered too.
                        It was "Other ways to start", quiet 12px text alone at
                        the foot's left end opening a menu: hard to see and
                        strangely placed (2026-10-05). Two rounds of three
                        outside readers said why: the label hid the word
                        they looked for ("import"), grey text did not read as a
                        button, a lone left control reads as Cancel, and the
                        menu's first item only repeated the button. */}
                    <div className={cx('flex', wide ? 'shrink-0' : 'order-last [&>button]:w-full')}>
                        <Button variant="neutral" icon={<FileInput className="h-4 w-4" />} onClick={() => setCreateMode('import')} className="whitespace-nowrap">
                            {t("Import a course or deck")}
                        </Button>
                    </div>
                    {/* One primary button, and Cancel is the dialog's ✕ (and
                        Escape). Narrow, it takes the full width. */}
                    <div className={cx('flex', wide ? 'shrink-0' : '[&>button]:w-full')}>
                        <Button variant="primary" onClick={handleCreateWithAI} disabled={!!blockedAI} title={blockedAI || undefined} icon={<Sparkles className="w-4 h-4" />} className="whitespace-nowrap">
                            {t("Create with AI")}
                        </Button>
                    </div>
                </div>
            )}
        </>
    );
}
