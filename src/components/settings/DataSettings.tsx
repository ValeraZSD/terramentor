import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';
import { api } from '../../api';
import { ArrowDownUp, Download, Upload, Trash2, Layers, Terminal, MessageSquareWarning } from 'lucide-react';
import { Button, ButtonLink } from '../ui/Button';
import { SettingNote, GROUP_CAPTION } from '../ui/SettingRow';
import { Explain, ExpandableSection } from '../ui/Disclosure';
import { IMPORT_ACCEPT, importProjectFile } from '../../utils/projectFiles';
import ExportProjectModal from '../ExportProjectModal';
import SecuritySettings from '../SecuritySettings';
import ActivityLogPanel from './ActivityLogPanel';

/** Settings → Data: import and export, Anki, security, and the two local
 *  records. */
export default function DataSettings({ active }: { active: boolean }) {
    const { t: tr } = useTranslation();
    const openAnkiImport = useStore(s => s.openAnkiImport);
    const addToast = useStore(s => s.addToast);
    const projects = useStore(s => s.projects);
    const loadProjects = useStore(s => s.loadProjects);
    const showConfirm = useStore(s => s.showConfirm);

    // Import / Export
    const [importing, setImporting] = useState(false);
    const [showExport, setShowExport] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // The visual-feedback log: how many drawings the learner has reported, and
    // how big the file is. Loaded when the Data tab is looked at, not at mount —
    // it is a filesystem read for a panel most sessions never open.
    const [visualFeedback, setVisualFeedback] = useState<{ count: number; bytes: number; path: string; lastAt: string | null } | null>(null);
    useEffect(() => {
        if (!active) return;
        api.visualFeedbackSummary().then(setVisualFeedback).catch(() => { });
    }, [active]);

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        // Cleared at once so picking the same file again still fires onChange.
        e.target.value = '';
        if (!file) return;
        setImporting(true);
        try {
            const result = await importProjectFile(file);
            await loadProjects();
            // What the importer changed on the way in (a dropped unsafe link, a
            // course already held, a card's missing media) is reported, never
            // silent; a library adds which of its projects did not come.
            const notes = (result.warnings ?? []).join('\n');
            if (result.library) {
                const count = result.imported?.length ?? 1;
                addToast(result.failed?.length ? 'info' : 'success', tr("{{count}} projects imported", { count }), notes || undefined);
            } else if (notes) {
                addToast('info', tr("Imported \"{{name}}\" with {{count}} notes", { name: result.name, count: result.warnings!.length }), notes);
            } else {
                addToast('success', tr("Project \"{{name}}\" imported successfully", { name: result.name }));
            }
        } catch (e: any) {
            addToast('error', tr("Import failed"), e.message);
        } finally {
            setImporting(false);
        }
    };

    return (
        <>
            <section className={active ? 'mb-8' : 'hidden'}>
                <h2 className={GROUP_CAPTION}>{tr("Import & Export")}</h2>
                <div className="mb-2 px-1">
                    <SettingNote>
                        {tr("Move projects between machines as portable files. A .studyvault holds everything — topics, questions, cards with their pictures and audio, and your uploaded files; a .json file holds the structure only.")}
                    </SettingNote>
                </div>
                {/* ONE row, shaped like the Anki row below: what it is on
                    the left, Import and Export side by side on the right.
                    Picking a file IS the import, as on the Projects page,
                    with no second step. Which project, the format and what to add are the
                    project card's Export dialog, opened from here too.
                    Narrow, the buttons wrap under the text and stay right. */}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept={IMPORT_ACCEPT}
                    onChange={handleFileSelect}
                    className="hidden"
                />
                <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm p-4 flex flex-wrap items-center gap-x-4 gap-y-3">
                    <div className="flex min-w-[12rem] flex-1 items-center gap-4">
                        <div className="p-2 bg-accent rounded-lg shrink-0">
                            <ArrowDownUp className="w-5 h-5 text-white" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                            <p className="font-semibold text-slate-900 dark:text-white">{tr("Project files")}</p>
                            <p className="text-sm text-slate-500 dark:text-slate-400">{tr(".studyvault or .json")}</p>
                        </div>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                        <Button
                            busy={importing}
                            onClick={() => fileInputRef.current?.click()}
                            icon={<Download className="w-4 h-4" aria-hidden="true" />}
                        >
                            {tr("Import")}
                        </Button>
                        <Button
                            disabled={projects.length === 0}
                            title={projects.length === 0 ? tr("No projects to export") : undefined}
                            onClick={() => setShowExport(true)}
                            icon={<Upload className="w-4 h-4" aria-hidden="true" />}
                        >
                            {tr("Export")}
                        </Button>
                    </div>
                </div>
                {showExport && <ExportProjectModal isOpen onClose={() => setShowExport(false)} />}
            </section>

            {/* Anki import gets its own section rather than a third
                card in the grid above: it is the front door for
                people arriving with an existing collection, and
                burying it next to "export as JSON" would hide the
                one thing that gives a new user content on day one. */}
            <section className={active ? 'mb-8' : 'hidden'}>
                <h2 className={GROUP_CAPTION}>{tr("Coming from Anki?")}</h2>
                <div className="mb-2 px-1">
                    <SettingNote>
                        {tr("Bring a deck across with its review history intact. Your decks become topics, and everything here — lessons, questions, mastery — works on them from then on.")}
                    </SettingNote>
                </div>
                <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm flex items-center gap-4">
                    <div className="p-2 bg-accent rounded-lg shrink-0">
                        <Layers className="w-5 h-5 text-white" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="font-semibold text-slate-900 dark:text-white">{tr("Import an Anki deck")}</p>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                            {tr(".apkg file · you see a preview before anything is added")}
                        </p>
                    </div>
                    <Button
                        onClick={() => openAnkiImport()}
                        variant="primary"
                        className="shrink-0"
                    >
                        {tr("Choose file")}
                    </Button>
                </div>
            </section>

            <div className={active ? '' : 'hidden'}>
                <SecuritySettings />
            </div>

            {/* RECORDS & DIAGNOSTICS: the two local records of what the
                app did, collapsed because they are read when something
                needs checking, not on a skim. Open, it is ONE card with
                a hairline between the records, each laid out as name
                (+ switch), what it is, then count left and actions
                right. No card nested in a card. */}
            <div className={active ? 'mb-8' : 'hidden'}>
                <ExpandableSection
                    icon={Terminal}
                    title={tr("Records & diagnostics")}
                    // The only place this section says where the two
                    // files live; the notes below do not repeat it. Not
                    // "never sent anywhere": the visual feedback panel
                    // asks the learner to share its file, and both have
                    // a Download button for exactly that.
                    desc={tr("What the app has done, and the reports you wrote about visuals. Both stay on this computer unless you download one and share it.")}
                    flushBody
                >
                    <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
                        <ActivityLogPanel />

                        {/* VISUAL FEEDBACK.

                            A diagram that renders and is WRONG is the one
                            failure this app cannot detect: nothing throws, every
                            gate has already passed it, and the only detector is
                            a person who knows what they were meant to be looking
                            at. The "Fix this" button on every visual writes what
                            they said, the drawing they said it about, and what
                            the model produced afterwards, into one local file.

                            The panel exists so that file is not a secret. It is
                            the learner's, it never leaves the machine on its
                            own, and the whole point of keeping it is that they
                            can choose to attach it to an issue — so the two
                            things to offer are the file and a way to delete it. */}
                        <section className="px-4 py-4">
                            <h3 className="flex items-center gap-2 font-medium text-slate-900 dark:text-white">
                                <MessageSquareWarning className="w-4 h-4 shrink-0 text-accent-fg" aria-hidden="true" />
                                {tr("Visual feedback")}
                            </h3>
                            {/* ONE key, the button's name a placeholder:
                                the sentence was three keys around a bold
                                "Fix this", and each language translated
                                its fragments in English order —
                                Japanese read 使用するたびに + これを修正 +
                                図、チャート…上で. */}
                            <SettingNote className="mt-1">
                                {tr("Each time you press “{{fix}}” on a diagram, chart, animation or widget, your note and what the AI drew next are added to this file. Share it to get a bad drawing fixed for everyone.", { fix: tr("Fix this") })}
                            </SettingNote>
                            {/* The same foot as the log's: what is in the
                                file on the left, what you can do with it
                                on the right. */}
                            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                                <div className="min-w-0 flex-1 basis-48 text-sm text-slate-500 dark:text-slate-400">
                                    {visualFeedback && visualFeedback.count > 0 ? (
                                        <>
                                            {/* A path is a place, not a fact to read:
                                                the file name and the size are the
                                                line; the whole path opens on demand
                                                instead of running `break-all` across
                                                the card. */}
                                            <p>
                                                <span className="font-medium text-slate-700 dark:text-slate-200">{tr("{{count}} reports", { count: visualFeedback.count })}</span>{' · '}
                                                <code className="text-xs">{visualFeedback.path.split(/[\\/]+/).filter(Boolean).pop()}</code>{' '}
                                                <span className="whitespace-nowrap">{tr("· {{value}} KB", { value: (visualFeedback.bytes / 1024).toFixed(1) })}</span>
                                            </p>
                                            <Explain summary={tr("Show the full path")} className="mt-0.5">
                                                <p className="break-all">{visualFeedback.path}</p>
                                            </Explain>
                                        </>
                                    ) : (
                                        // The note above already says how a report
                                        // gets here; the empty state only says there
                                        // is none yet.
                                        <p>
                                            {visualFeedback === null
                                                ? tr("Checking…")
                                                : tr("Nothing reported yet")}
                                        </p>
                                    )}
                                </div>
                                <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
                                    <ButtonLink
                                        href="/api/visual-feedback/export"
                                        download="visual-feedback.jsonl"
                                        className={!visualFeedback?.count ? 'pointer-events-none opacity-45' : undefined}
                                        aria-disabled={!visualFeedback?.count}
                                        icon={<Download className="w-4 h-4" aria-hidden="true" />}
                                    >
                                        {tr("Download")}
                                    </ButtonLink>
                                    <Button
                                        variant="danger"
                                        disabled={!visualFeedback?.count}
                                        onClick={async () => {
                                            if (!(await showConfirm({
                                                title: tr("Delete the visual feedback file?"),
                                                message: tr("Every report you have written is removed from this machine. Download it first if you meant to share it."),
                                                confirmLabel: tr("Delete"),
                                                variant: 'danger',
                                            }))) return;
                                            try {
                                                await api.clearVisualFeedback();
                                                setVisualFeedback(await api.visualFeedbackSummary());
                                                addToast('success', tr("Visual feedback deleted"));
                                            } catch (e: any) {
                                                addToast('error', tr("Could not delete the file"), e?.message);
                                            }
                                        }}
                                        icon={<Trash2 className="w-4 h-4" aria-hidden="true" />}
                                    >
                                        {tr("Delete")}
                                    </Button>
                                </div>
                            </div>
                        </section>
                    </div>
                </ExpandableSection>
            </div>
        </>
    );
}
