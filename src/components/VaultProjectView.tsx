import { useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import VaultPanel from './VaultPanel';
import Checkbox from './Checkbox';
import { Upload, Loader2, Check, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Project-level Vault view. Manage the original files that ground this
 * project's AI (study chat, quizzes, mastery checks) and export the whole project
 * — tree + extracted text + originals — as a portable .studyvault bundle.
 */
export default function VaultProjectView() {
    const { t } = useTranslation();
    const currentProjectId = useStore(s => s.currentProjectId);
    const projects = useStore(s => s.projects);
    const addToast = useStore(s => s.addToast);
    const project = projects.find(p => p.id === currentProjectId);
    const [exporting, setExporting] = useState(false);
    const [exportingAnki, setExportingAnki] = useState(false);
    const [showOptions, setShowOptions] = useState(false);
    // Same opt-in contract as the JSON export, and the same defaults: the
    // curriculum always ships, private notes never do unless asked for. Progress
    // is off too — a bundle is more often handed to someone else than carried to
    // your own second machine, and "how far along I am" is not part of a course.
    const [includeNotes, setIncludeNotes] = useState(false);
    const [includeProgress, setIncludeProgress] = useState(false);

    if (!project) return null;

    const handleExportBundle = async () => {
        setShowOptions(false);
        setExporting(true);
        try {
            const { blob, filename } = await api.exportBundle(project.id, { includeNotes, includeProgress });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            // Same reason as the Anki export below: a bundle carrying the
            // vault's originals is large, and revoking synchronously after
            // click() cancels the download silently.
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch (e: any) {
            addToast('error', t("Export failed"), e.message);
        } finally {
            setExporting(false);
        }
    };

    /**
     * Anki export. Separate button rather than an option on the bundle, because
     * they answer different questions: a .studyvault carries the COURSE (tree,
     * material, files) and an .apkg carries the CARDS and the intervals they
     * have earned. Folding one into the other would produce an archive that is
     * half-readable by both tools and fully readable by neither.
     */
    const handleExportAnki = async () => {
        setExportingAnki(true);
        try {
            const { blob, filename, stats } = await api.exportAnki(project.id);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            // Revoke on the next tick, never synchronously after click(). The
            // browser reads the blob asynchronously once the download starts,
            // and on a 100 MB deck that start is slow enough that an immediate
            // revoke cancels the download — with no error anywhere, so the app
            // cheerfully reports success and no file ever appears.
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            if (stats) {
                // Say what left, and — the part that matters — say what could not
                // be found, rather than shipping cards with dead media refs and
                // letting Anki look like the thing that broke.
                const missing = stats.missingMedia.length
                    ? ` ${t("{{count}} media files could not be found and were left out.", { count: stats.missingMedia.length })}`
                    : '';
                addToast(missing ? 'info' : 'success', t("Deck exported"),
                    `${t("{{count}} cards", { count: stats.notes })} ${t("across {{count}} decks", { count: stats.decks })}, ${t("with {{count}} media files", { count: stats.mediaFiles })}.${missing}`);
            }
        } catch (e: any) {
            addToast('error', t("Anki export failed"), e.message);
        } finally {
            setExportingAnki(false);
        }
    };

    const Toggle = ({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) => (
        <label className="flex items-start gap-2.5 cursor-pointer py-1.5">
            <Checkbox checked={on} onChange={onChange} className="mt-0.5" />
            <span className="text-sm text-slate-700 dark:text-slate-200">
                {label}
                {hint && <span className="block text-sm text-slate-500 dark:text-slate-400">{hint}</span>}
            </span>
        </label>
    );

    return (
        <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-2xl mx-auto">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
                    <div>
                        <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{t("Project Vault")}</h2>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                            {t("Upload your own materials — curriculum, notes, textbooks, past exams. They become searchable text the AI uses to ground answers, quizzes and mastery checks. Originals stay on your machine.")}
                        </p>
                    </div>
                    <div className="relative self-start shrink-0 flex items-center gap-2">
                        <button
                            onClick={handleExportAnki}
                            disabled={exportingAnki}
                            title={t("Export this project's flashcards as an Anki .apkg deck")}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 dark:text-slate-300 border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 transition"
                        >
                            {exportingAnki ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
                            {t("Export to Anki")}
                        </button>
                        <button
                            onClick={() => setShowOptions(v => !v)}
                            disabled={exporting}
                            aria-expanded={showOptions}
                            title={t("Export project + files as a .studyvault bundle")}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 dark:text-slate-300 border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 transition"
                        >
                            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                            {t("Export bundle")}
                        </button>

                        {showOptions && (
                            <>
                                <div className="fixed inset-0 z-10" onClick={() => setShowOptions(false)} />
                                {/* `top-full` is load-bearing. An absolutely
                                    positioned child of a FLEX container takes
                                    its static position from the container's
                                    alignment — `items-center` centred this
                                    panel on the 32px button row, so it opened
                                    ON TOP of the two buttons that raise it and
                                    spilled up over the header. A block parent
                                    would have dropped it below on its own; a
                                    flex one never will. */}
                                <div className="absolute right-0 top-full mt-1.5 z-20 w-72 p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg">
                                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-1.5">
                                        {t("The curriculum and your uploaded files are always included. Choose what else to add:")}
                                    </p>
                                    <Toggle
                                        on={includeNotes}
                                        onChange={setIncludeNotes}
                                        label={t("My private notes")}
                                        hint={t("Off by default — leave off when sharing.")}
                                    />
                                    <Toggle
                                        on={includeProgress}
                                        onChange={setIncludeProgress}
                                        label={t("Progress (completion status)")}
                                    />
                                    <button
                                        onClick={handleExportBundle}
                                        className="mt-2 w-full px-3 py-2 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition"
                                    >
                                        {t("Export")}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
                <VaultPanel projectId={project.id} />
            </div>
        </div>
    );
}
