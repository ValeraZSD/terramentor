// src/components/ProjectImportZone.tsx
// The Import tab of the New project dialog: a dropzone that turns a project
// file into a project, or hands an Anki deck to the deck importer; and a field
// for a course link, which carries the same file inside the link itself.
import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store';
import { api } from '../api';
import { onActivateKey } from '../utils/a11y';
import { installedEditionOf } from '../utils/projectFiles';
import { CourseLinkError, CourseLinkProblem, courseFromText, packedCourseIn } from '../utils/courseLink';
import type { CourseUpdatePreview } from '../types';
import { Field, TextInput } from './ui/Field';
import { Button } from './ui/Button';

/** A course a link carries, counted for the line under the field. `have`:
 *  whether the library already holds it (asked only for an opened link): new,
 *  the same or an older edition (open that), or a newer one (its update preview). */
interface LinkedCourse {
    name: string; cards: number; questions: number; file: File;
    have: 'new' | { projectId: number } | CourseUpdatePreview;
}

function countItems(nodes: unknown[]): { cards: number; questions: number } {
    let cards = 0, questions = 0;
    const walk = (list: unknown[]) => list.forEach((n: any) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n.flashcards)) cards += n.flashcards.length;
        if (Array.isArray(n.questions)) questions += n.questions.length;
        if (Array.isArray(n.children)) walk(n.children);
    });
    walk(nodes);
    return { cards, questions };
}

/** What this dropzone accepts. An Anki deck is here because it is where
 *  someone holding one looks first — "import" is the word they are after,
 *  and a separate entrance in Settings is a door they never find. */
const IMPORT_ACCEPT = '.json,.studyvault,.zip,.apkg,.colpkg';
const IMPORTABLE_RE = /\.(json|studyvault|zip|apkg|colpkg)$/i;

/** `onDone` closes the dialog: called once a project exists, and before a
 *  deck is handed over. A file that fails to import leaves the dialog open. */
export default function ProjectImportZone({ onDone, link: linkGiven = '' }: {
    onDone: () => void;
    /** A course link the app was opened with (`#course=…`), filled in for the learner to add. */
    link?: string;
}) {
    const { t } = useTranslation();
    const openProject = useStore(s => s.openProject);
    const openAnkiImport = useStore(s => s.openAnkiImport);
    const openCourseUpdate = useStore(s => s.openCourseUpdate);
    const loadProjects = useStore(s => s.loadProjects);
    const addToast = useStore(s => s.addToast);

    const [importing, setImporting] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // The link field. What it holds is read as it changes, so the line under
    // it names the course (or says what is wrong) before anything is added.
    // `from` says which text a reading belongs to: once the text changes, the
    // old course is no longer shown, and the line waits for the new reading.
    const [linkText, setLinkText] = useState(linkGiven);
    const [reading, setReading] = useState<{ from: string; course: LinkedCourse | null; problem: CourseLinkProblem | null } | null>(null);
    const current = reading?.from === linkText ? reading : null;
    const linked = current?.course ?? null;
    const linkProblem = current?.problem ?? null;
    // A link the app was opened with is shown as the course it holds, with one
    // button, until the learner changes the text (only possible when it failed).
    const offering = linkGiven !== '' && linkText === linkGiven;
    const hintId = useId();
    useEffect(() => {
        const text = linkText;
        if (!packedCourseIn(text)) {
            // Half a paste is not yet wrong; text with no course in it is.
            setReading({ from: text, course: null, problem: text.trim().length > 12 ? 'not-a-link' : null });
            return;
        }
        let stale = false;
        // A pause before unpacking, so typing does not unpack on every key.
        const timer = window.setTimeout(async () => {
            try {
                const data = await courseFromText(text);
                // Shown, not stored: the importer reads the name from the file.
                const name = Array.from(data.project.name.trim()).slice(0, 200).join('');
                // The importer reads files, so the link's course is handed to it as
                // one: the edition check, the warnings and the toasts stay one path.
                const safeName = Array.from(name.replace(/[\\/:*?"<>|\p{C}]+/gu, ' ')).slice(0, 80).join('').trim();
                const file = new File([JSON.stringify(data)], `${safeName || 'course'}.json`, { type: 'application/json' });
                // An opened link is asked about first: a course the library already
                // has is offered to open, not to add again.
                let have: LinkedCourse['have'] = 'new';
                if (offering) {
                    const edition = await installedEditionOf(file).catch(() => null);
                    if (edition?.match) {
                        have = edition.refused === 'older' || edition.summary?.nothing
                            ? { projectId: edition.match.projectId }
                            : edition;
                    }
                }
                if (!stale) setReading({ from: text, course: { name, ...countItems(data.nodes), file, have }, problem: null });
            } catch (e) {
                if (!stale) setReading({ from: text, course: null, problem: e instanceof CourseLinkError ? e.problem : 'damaged' });
            }
        }, offering ? 0 : 150);
        return () => { stale = true; window.clearTimeout(timer); };
    }, [linkText, offering]);

    const linkProblemText: Record<CourseLinkProblem, string> = {
        'not-a-link': t("This is not a course link."),
        'newer-format': t("This link was made by a newer version of Terramentor. Update the app, then open it again."),
        'too-large': t("This course is too large for a link. Ask for the course file instead."),
        'damaged': t("This link is incomplete. Open it again from the message it came in, or copy all of it."),
        'not-a-course': t("This link holds no course."),
        'unsupported': t("This browser cannot open course links. Update it, or ask for the course file."),
    };

    const addLinked = (e?: FormEvent) => {
        e?.preventDefault();
        if (!linked || importing) return;
        const have = linked.have;
        if (have === 'new') processImport(linked.file);
        else if ('projectId' in have) { onDone(); openProject(have.projectId); }
        else { onDone(); openCourseUpdate(linked.file, have); }
    };

    const processImport = async (file: File) => {
        // A deck is not a project file: it needs a preview, a front/back check
        // and a media decision, all of which the Anki importer already owns. So
        // this hands the file over rather than growing a second implementation.
        if (/\.(apkg|colpkg)$/i.test(file.name)) {
            onDone();
            openAnkiImport(file);
            return;
        }
        setImporting(true);
        try {
            // A newer edition of a course already here updates it in place,
            // after a preview, instead of arriving as a second copy.
            const edition = await installedEditionOf(file);
            if (edition) {
                onDone();
                openCourseUpdate(file, edition);
                return;
            }
            const isBundle = /\.(studyvault|zip)$/i.test(file.name);
            let newProject;
            if (isBundle) {
                // .studyvault = project + extracted text + original files.
                newProject = await api.importBundle(file);
            } else {
                const text = await file.text();
                const data = JSON.parse(text);
                if (!data.project?.name || !Array.isArray(data.nodes)) {
                    addToast('error', t("Invalid project file"), t("Must contain project.name and nodes array."));
                    setImporting(false);
                    return;
                }
                newProject = await api.importProject(data);
            }
            await loadProjects();
            onDone();
            openProject(newProject.id);
            // Repairs the importer made — an unknown language code, a dropped
            // unsafe link, a course you already have. Each one changes what you
            // ended up with, so none of them may be silent.
            const warnings = newProject.warnings || [];
            const libraryNotes = warnings.join('\n');
            if (newProject.library) {
                // A whole-library .studyvault: the project opened is the first of
                // them, and the notes say which others did not come.
                addToast(newProject.failed?.length ? 'info' : 'success', t("{{count}} projects imported", { count: newProject.imported?.length ?? 1 }), libraryNotes || undefined);
            } else if (warnings.length) {
                addToast('info', t("Imported \"{{name}}\" with {{count}} notes", { name: newProject.name, count: warnings.length }), libraryNotes);
            } else {
                addToast('success', t("Project \"{{name}}\" imported successfully!", { name: newProject.name }));
            }
        } catch (e: any) {
            addToast('error', t("Import failed"), e.message);
        } finally {
            setImporting(false);
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files[0];
        // A second file while one is importing would make a second copy.
        if (importing) return;
        if (file && IMPORTABLE_RE.test(file.name)) processImport(file);
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    };

    const handleDropZoneClick = () => {
        if (!importing) fileInputRef.current?.click();
    };

    const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        // Cleared so choosing the same file again (after a failed import) fires
        // `change` again instead of doing nothing.
        e.target.value = '';
        if (file && !importing) processImport(file);
    };

    // A count keeps its word on its line: "8" never ends one line with
    // "questions" starting the next.
    const counts = linked && (
        <>
            <span className="whitespace-nowrap">{t("{{count}} cards", { count: linked.cards })}</span>
            {' · '}<span className="whitespace-nowrap">{t("{{count}} questions", { count: linked.questions })}</span>
        </>
    );

    // The link the app was opened with, read: the course it holds and one button.
    if (offering && linked) {
        const have = linked.have;
        const known = have !== 'new' && 'projectId' in have;
        return (
            <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 px-4 py-4 dark:border-slate-700">
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                        {known ? t("You already have this course.") : t("Course in this link")}
                    </p>
                    <p className="mt-1 break-words text-xl font-semibold text-slate-900 dark:text-white">{linked.name}</p>
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{counts}</p>
                </div>
                <Button variant="primary" size="lg" block busy={importing} onClick={() => addLinked()}
                    aria-label={known ? t("Open {{name}}", { name: linked.name }) : undefined}>
                    {have === 'new' ? t("Add this course") : known ? t("Open") : t("Update course")}
                </Button>
            </div>
        );
    }
    // Being read: a moment, so a spinner rather than a field that jumps.
    if (offering && !current) {
        return (
            <div className="flex min-h-32 items-center justify-center" role="status" aria-busy="true">
                <Loader2 className="h-5 w-5 animate-spin text-accent-fg" aria-hidden="true" />
                <span className="sr-only">{t("Reading it…")}</span>
            </div>
        );
    }

    return (
        <div className="space-y-4">
        {/* A link the app was opened with has one thing to do: the file
            target is for someone who came to import, not for them. */}
        {!linkGiven && (
        <div
            // The view's one target, so it is a real place to drop a file:
            // 8rem tall, because a compact row looks lost on an otherwise
            // empty screen. Icon left and the dashed edge in slate-400, like
            // the material row.
            className={`flex min-h-32 items-center gap-3 border-2 border-dashed rounded-xl px-4 py-3 text-start cursor-pointer transition-colors ${isDragging
                ? 'border-accent bg-accent/10'
                : 'border-slate-400 dark:border-slate-500 hover:border-accent'
                }`}
            onClick={handleDropZoneClick}
            onKeyDown={onActivateKey(handleDropZoneClick)}
            role="button"
            tabIndex={0}
            aria-label={t("Import file — choose or drop a project file")}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
        >
            <input
                ref={fileInputRef}
                type="file"
                accept={IMPORT_ACCEPT}
                onChange={handleImportFileChange}
                className="hidden"
            />
            {importing ? (
                <>
                    <Loader2 className="h-5 w-5 shrink-0 text-accent-fg animate-spin" aria-hidden="true" />
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                        {t("Importing...")}
                    </p>
                </>
            ) : (
                <>
                    <Upload className="h-5 w-5 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                    {/* Plain words, and no list of extensions: ".json
                        (structure only) · .studyvault" meant nothing to any
                        outside reader, and the file picker only offers the
                        kinds it takes anyway (`accept`). */}
                    <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">
                            {t("Add a course exported from Terramentor, or an Anki deck")}
                        </span>
                        <span className="block text-sm text-slate-500 dark:text-slate-400">
                            {t("Choose a file, or drop it here")}
                        </span>
                    </span>
                </>
            )}
        </div>
        )}
        {/* A course link is the same file inside the link, sent as a message
            where a file is awkward: on a phone, a link is copied with one
            press and a file has to be found in a folder first. */}
        <form onSubmit={addLinked}>
            {/* "Or" only under the file target; an opened link hides that. */}
            <Field label={linkGiven ? t("Paste a link") : t("Or paste a course link")}>
                {(id) => (
                    <>
                        <div className="flex gap-2">
                            <TextInput
                                id={id}
                                className="min-w-0 flex-1"
                                value={linkText}
                                onChange={e => setLinkText(e.target.value)}
                                autoComplete="off"
                                autoCapitalize="off"
                                spellCheck={false}
                                enterKeyHint="go"
                                aria-invalid={linkProblem ? true : undefined}
                                aria-describedby={hintId}
                            />
                            <Button type="submit" variant={linked ? 'primary' : 'neutral'} disabled={!linked || importing}>
                                {t("Add")}
                            </Button>
                        </div>
                        {/* Always there, so a screen reader hears the course or the
                            problem as soon as a paste is read. */}
                        <p id={hintId} aria-live="polite" className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
                            {linked
                                ? <span className="text-slate-700 dark:text-slate-200"><span className="font-medium">{linked.name}</span>{' · '}{counts}</span>
                                : linkProblem ? <span className="text-red-700 dark:text-red-300">{linkProblemText[linkProblem]}</span> : null}
                        </p>
                    </>
                )}
            </Field>
        </form>
        </div>
    );
}
