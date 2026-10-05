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
// One column at every width: the files, the name they fill in, one folded row
// for a goal and the lessons' language, a quiet "Other ways to start" menu,
// and one button. Colour and icon are not chosen here (see `freeColour`). It
// was two columns with seventy appearance controls open beside the form, and
// seven rounds of outside readers (2026-10-02) took it down to this.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { ArrowLeft, ChevronDown, FileInput, MessageSquare, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store';
import { api } from '../api';
import Modal from './Modal';
import { StudyLanguageField, useLanguageName } from './ProjectFormFields';
import { PROJECT_COLORS, sameColor } from './ui/ColorField';
import { parseCssColor } from '../utils/color';
import { OutlineBriefPanel } from './ExternalAuthoring';
import ProjectImportZone from './ProjectImportZone';
import SourceFiles, { MAX_FILE_BYTES, usableSource, type SourceFile } from './creation/SourceFiles';
import { Button } from './ui/Button';
import { Field, TextArea, TextInput } from './ui/Field';
import ScrollShade from './ui/ScrollShade';
import { ExpandableSection } from './ui/Disclosure';
import { MenuItem, MenuPopover } from './ui/Popover';
import { useElementWidth } from '../hooks/useElementWidth';
import { useRootFontSize } from '../hooks/useRootFontSize';
import { cx } from './ui/vocabulary';
import { openCreationRun, startCreationRun, type CreationInput } from './creation/creationRuns';
import type { Project, StagedDocument } from '../types';

const DEFAULT_ICON = 'folder';
/** The form's own width at which the foot is one row: its sentence, then the
 *  button. */
const ONE_ROW_FOOT_REM = 34;

/** The first palette colour no other project wears, else the palette's first. */
function freeColour(projects: Project[]): string {
    const worn = projects.map(p => parseCssColor(p.color)).filter((c): c is string => !!c);
    return PROJECT_COLORS.find(c => !worn.some(w => sameColor(w, c))) || PROJECT_COLORS[0];
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
        <Modal isOpen={isOpen} onClose={cancel} title={t("New course")} maxWidth="max-w-2xl" fill>
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
    // NOT CHOSEN HERE. Colour and icon were the largest part of this dialog
    // and the first thing every outside reader asked to lose, six rounds
    // running (2026-10-02): a new course takes the first palette colour no
    // other project wears, so a library does not turn one purple, and the
    // folder icon; both are changed in Edit project, next to the course
    // they are for.
    const [newColor] = useState(() => draft?.color || freeColour(projects));
    const newIcon = draft?.icon || DEFAULT_ICON;
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
        return () => { mounted.current = false; };
    }, []);

    const addFiles = useCallback((picked: File[]) => {
        const stamp = Date.now().toString(36);
        const entries: SourceFile[] = picked.map((f, i) => ({
            key: `${stamp}-${i}-${f.name}`, name: f.name, size: f.size,
            status: f.size > MAX_FILE_BYTES ? 'done' : 'reading',
            error: f.size > MAX_FILE_BYTES ? t("Over the 25 MB limit for one file.") : undefined,
        }));
        setFiles(prev => [...prev, ...entries]);
        const send = picked.filter(f => f.size <= MAX_FILE_BYTES);
        const keys = entries.filter(e => e.status === 'reading').map(e => e.key);
        if (!send.length) return;
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

    const [otherWaysOpen, setOtherWaysOpen] = useState(false);
    const otherWaysRef = useRef<HTMLButtonElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const width = useElementWidth(bodyRef);
    const rootPx = useRootFontSize();
    const wide = width >= ONE_ROW_FOOT_REM * rootPx;
    // What "Automatic" will pick, when the FILES decide it: the server's own
    // read of each file (`stagedSummary().language`), the first one that has
    // one. A typed goal is read before the files (resolveCreationLanguage), so
    // once there is one the dialog no longer claims to know.
    const filesLanguage = newDescription.trim() ? null
        : usable.map(f => (f.doc?.ok ? f.doc.language : null)).find(Boolean) ?? null;
    const chosenName = useLanguageName(newLanguage || filesLanguage);
    // FILES FIRST, then the name a file fills in: "turn this textbook into a
    // course" is what the dialog is for, and with Name and Description above
    // it typing looked like step one (2026-10-02, round 5). The zone takes the
    // focus, not Name: a glowing Name field drew all three outside readers to
    // type before adding the book that would have named the course.
    const madeFrom = (
        <>
            <SourceFiles files={files} onAdd={addFiles} onRemove={removeFile} autoFocus />
            <Field
                label={t("Name")}
                // No "Taken from …" once a file has filled it: the file is
                // listed just above and the field shows the name.
                hint={usable.length && !name ? t("Optional with a file: the course is named after it.") : undefined}
            >
                {id => (
                    <TextInput
                        id={id}
                        value={newName}
                        onChange={e => { nameTyped.current = true; setNewName(e.target.value); }}
                        placeholder={firstTitle || t("e.g., Machine Learning, Japanese N3…")}
                    />
                )}
            </Field>
        </>
    );
    // The goal and the lessons' language, behind ONE row whose title says what
    // is in it. Shown, they were two full-width fields of equal weight to Name
    // for values most people leave alone; folded with the colour and icon as
    // "More options", the fold was a vague wall. Seven rounds of outside
    // readers, 2026-10-02.
    const extras = (
        <div className="space-y-4">
            {/* No "(optional)" here: the closed row already says the whole
                section is, and three optionals in one fold was noise. */}
            <Field label={t("Goal")}>
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
        </div>
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
                        <Button variant="quiet" size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => setCreateMode('ai')} className="-ml-2">
                            {t("Back to creating with AI")}
                        </Button>
                        {/* The chatbot view names itself; the import view's own
                            zone already says what it takes, and a heading over
                            it said the same thing twice. */}
                        {createMode === 'external' && (
                            <h3 className="mt-2 text-base font-semibold text-slate-900 dark:text-white">
                                {t("Paste a course from another chatbot")}
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
                        <ProjectImportZone onDone={onCancel} />
                    ) : (
                        <div className="space-y-4">
                            {madeFrom}
                            {/* A row with a light outline at the size of a field
                                label: bare text with a chevron 900px away read as
                                not pressable, and a bold card read as a heading.
                                Closed, it already ANSWERS the language question,
                                and says where the answer came from. */}
                            <div className="rounded-lg border border-slate-200 dark:border-slate-700">
                                <ExpandableSection
                                    variant="row"
                                    title={(
                                        <span className="text-sm">
                                            {t("Goal and language")}
                                            <span className="font-normal text-slate-500 dark:text-slate-400">
                                                {' · '}
                                                {newLanguage && chosenName ? chosenName
                                                    : chosenName ? t("{{language}}, from your files", { language: chosenName })
                                                        : t("optional")}
                                            </span>
                                        </span>
                                    )}
                                >
                                    {extras}
                                </ExpandableSection>
                            </div>
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
                    {/* The other two ways to start: ONE quiet button and its
                        menu, in the foot, out of the form. As tabs they were a
                        block to get past before Name; as links under the form,
                        three rows on a phone and more to decide for someone who
                        knew what they came for. Wide it is the foot's left end;
                        narrow, the last line under the button. */}
                    <div className={cx('-ml-2', wide ? 'shrink-0' : 'order-last self-start')}>
                        <Button
                            ref={otherWaysRef}
                            variant="quiet"
                            size="sm"
                            trailing={<ChevronDown className="h-4 w-4" />}
                            onClick={() => setOtherWaysOpen(v => !v)}
                            aria-haspopup="menu"
                            aria-expanded={otherWaysOpen}
                        >
                            {t("Other ways to start")}
                        </Button>
                        <MenuPopover open={otherWaysOpen} onClose={() => setOtherWaysOpen(false)} anchorRef={otherWaysRef} label={t("Other ways to start")}>
                            <MenuItem icon={<FileInput className="h-4 w-4" />} onSelect={() => { setOtherWaysOpen(false); setCreateMode('import'); }}>
                                {t("Import a course or Anki deck")}
                            </MenuItem>
                            <MenuItem icon={<MessageSquare className="h-4 w-4" />} onSelect={() => { setOtherWaysOpen(false); setCreateMode('external'); }}>
                                {t("Paste a course from another chatbot")}
                            </MenuItem>
                        </MenuPopover>
                    </div>
                    {/* Why the button is not ready, in words, where the eye goes
                        when a press does nothing — and nothing otherwise. */}
                    <p className={cx('min-w-0 text-sm text-slate-500 dark:text-slate-400', wide ? 'ml-auto text-right' : !blockedAI && 'hidden')} aria-live="polite">
                        {blockedAI}
                    </p>
                    {/* One button, and Cancel is the dialog's ✕ (and Escape).
                        Narrow, it takes the full width. */}
                    <div className={cx('flex', wide ? cx('shrink-0 items-center', !blockedAI && 'ml-auto') : '[&>button]:w-full')}>
                        <Button variant="primary" onClick={handleCreateWithAI} disabled={!!blockedAI} title={blockedAI || undefined} icon={<Sparkles className="w-4 h-4" />} className="whitespace-nowrap">
                            {t("Create with AI")}
                        </Button>
                    </div>
                </div>
            )}
        </>
    );
}
