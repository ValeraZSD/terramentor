// src/components/ProjectImportZone.tsx
// The Import tab of the New project dialog: a dropzone that turns a project
// file into a project, or hands an Anki deck to the deck importer; and a field
// for a course link, which carries the same file inside the link itself.
import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { onActivateKey } from '../utils/a11y';
import { CourseLinkError, CourseLinkProblem, courseFromText, packedCourseIn } from '../utils/courseLink';
import { courseFileOf, outlineOf, shown } from '../utils/courseOutline';
import { useCourseFileImport } from '../hooks/useCourseFileImport';
import { Field, TextInput } from './ui/Field';
import { Button } from './ui/Button';

/** A course a pasted link carries, counted for the line under the field. */
interface PastedCourse { name: string; cards: number; questions: number; file: File }

/** What this dropzone accepts. An Anki deck is here because it is where
 *  someone holding one looks first — "import" is the word they are after,
 *  and a separate entrance in Settings is a door they never find. */
const IMPORT_ACCEPT = '.json,.studyvault,.zip,.apkg,.colpkg';
const IMPORTABLE_RE = /\.(json|studyvault|zip|apkg|colpkg)$/i;

/** `onDone` closes the dialog: called once a project exists, and before a
 *  deck is handed over. A file that fails to import leaves the dialog open. */
export default function ProjectImportZone({ onDone, link: linkGiven = '' }: {
    onDone: () => void;
    /** A course link the app was opened with that could not be read: filled
     *  in, so the line under the field says what is wrong with it. */
    link?: string;
}) {
    const { t } = useTranslation();
    const { importing, importFile } = useCourseFileImport();
    const processImport = (file: File) => importFile(file, onDone);
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // The link field. What it holds is read as it changes, so the line under
    // it names the course (or says what is wrong) before anything is added.
    // `from` says which text a reading belongs to: once the text changes, the
    // old course is no longer shown, and the line waits for the new reading.
    const [linkText, setLinkText] = useState(linkGiven);
    const [reading, setReading] = useState<{ from: string; course: PastedCourse | null; problem: CourseLinkProblem | null } | null>(null);
    const current = reading?.from === linkText ? reading : null;
    const linked = current?.course ?? null;
    const linkProblem = current?.problem ?? null;
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
                const name = shown(data.project.name, 200);
                const file = courseFileOf(data);
                const { cards, questions } = outlineOf(data.nodes);
                if (!stale) setReading({ from: text, course: { name, cards, questions, file }, problem: null });
            } catch (e) {
                if (!stale) setReading({ from: text, course: null, problem: e instanceof CourseLinkError ? e.problem : 'damaged' });
            }
        }, 150);
        return () => { stale = true; window.clearTimeout(timer); };
    }, [linkText]);

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
        void processImport(linked.file);
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
