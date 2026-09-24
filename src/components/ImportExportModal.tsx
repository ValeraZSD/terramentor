import { useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import Modal from './Modal';
import Checkbox from './Checkbox';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    initialProjectId?: number;
    mode: 'export' | 'import';
}

export default function ImportExportModal({ isOpen, onClose, initialProjectId }: Props) {
    const { t } = useTranslation();
    const projects = useStore(s => s.projects);
    const [exportProjectId, setExportProjectId] = useState<number | null>(initialProjectId || null);
    // Private notes are OFF by default — the curriculum (titles, overviews,
    // material, structure) always ships; the learner's personal notes only
    // leave the device on an explicit opt-in.
    const [includeNotes, setIncludeNotes] = useState(false);
    const [includeResources, setIncludeResources] = useState(true);
    const [includeProgress, setIncludeProgress] = useState(true);

    const handleExport = async () => {
        if (!exportProjectId) return;
        const data = await api.exportProject(exportProjectId, { includeNotes, includeResources, includeProgress });
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${data.project.name.toLowerCase().replace(/\s+/g, '-')}-export.json`;
        a.click();
        URL.revokeObjectURL(url);
        onClose();
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("Export Project")}>
            <div className="space-y-4">
                <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">{t("Select Project")}</label>
                    <select
                        value={exportProjectId || ''}
                        onChange={e => setExportProjectId(Number(e.target.value))}
                        className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                    >
                        <option value="">{t("Choose a project…")}</option>
                        {projects.map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                    </select>
                </div>

                <div className="space-y-3">
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                        {t("Titles, overviews, material and structure are always included — that's the curriculum. Choose what else to add:")}
                    </p>

                    {/* These three were `<input className="hidden">` beside a
                        hand-drawn box: `hidden` takes an element out of the tab
                        order, so the export options could not be reached, let
                        alone toggled, without a mouse. */}
                    <label className="flex items-start gap-3 cursor-pointer">
                        <Checkbox checked={includeNotes} onChange={setIncludeNotes} className="mt-0.5" />
                        <span className="text-slate-700 dark:text-slate-200">
                            {t("My private notes")}
                            <span className="block text-sm text-slate-500 dark:text-slate-400">{t("Your personal annotations. Off by default — leave off when sharing.")}</span>
                        </span>
                    </label>

                    <label className="flex items-center gap-3 cursor-pointer">
                        <Checkbox checked={includeResources} onChange={setIncludeResources} />
                        <span className="text-slate-700 dark:text-slate-200">{t("Resources (links, videos, etc.)")}</span>
                    </label>

                    <label className="flex items-center gap-3 cursor-pointer">
                        <Checkbox checked={includeProgress} onChange={setIncludeProgress} />
                        <span className="text-slate-700 dark:text-slate-200">{t("Progress (completion status)")}</span>
                    </label>
                </div>

                <div className="flex justify-end gap-3 pt-4">
                    <button onClick={onClose} className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl">
                        {t("Cancel")}
                    </button>
                    <button
                        onClick={handleExport}
                        disabled={!exportProjectId}
                        className="px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent/90 disabled:opacity-50"
                    >
                        {t("Export")}
                    </button>
                </div>
            </div>
        </Modal>
    );
}