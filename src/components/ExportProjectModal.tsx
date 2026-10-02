import { useState } from 'react';
import { useStore } from '../store';
import Modal from './Modal';
import Checkbox from './Checkbox';
import { Button } from './ui/Button';
import { Select } from './ui/Field';
import { SegmentedControl } from './ui/SegmentedControl';
import { exportProjectToFile, type ExportFormat } from '../utils/projectFiles';
import { useTranslation } from 'react-i18next';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    /** Preselected project; without one the first project is. */
    initialProjectId?: number;
}

/** The ONE export dialog: the project card's Export and Settings → Data both
 *  open it, so the choices (which project, format, what to add) live here and
 *  nowhere else. */
export default function ExportProjectModal({ isOpen, onClose, initialProjectId }: Props) {
    const { t } = useTranslation();
    const projects = useStore(s => s.projects);
    const addToast = useStore(s => s.addToast);
    const [selected, setSelected] = useState<number | null>(initialProjectId ?? projects[0]?.id ?? null);
    // `.studyvault` is the lossless one (card media, uploaded files), so it is
    // the default; `.json` stays for a file a person can read and diff.
    const [format, setFormat] = useState<ExportFormat>('studyvault');
    const [exporting, setExporting] = useState(false);
    // Private notes are OFF by default — the curriculum (titles, overviews,
    // material, structure) always ships; the learner's personal notes only
    // leave the device on an explicit opt-in.
    const [includeNotes, setIncludeNotes] = useState(false);
    const [includeResources, setIncludeResources] = useState(true);
    const [includeProgress, setIncludeProgress] = useState(true);

    const handleExport = async () => {
        if (!selected) return;
        setExporting(true);
        try {
            await exportProjectToFile(selected, { format, includeNotes, includeResources, includeProgress });
            onClose();
        } catch (e: any) {
            addToast('error', t("Export failed"), e.message);
        } finally {
            setExporting(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("Export Project")}>
            <div className="space-y-4">
                <div>
                    <label htmlFor="export-project" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">{t("Select Project")}</label>
                    <Select
                        id="export-project"
                        value={selected ?? ''}
                        onChange={e => setSelected(e.target.value ? Number(e.target.value) : null)}
                    >
                        <option value="">{t("Choose a project…")}</option>
                        {projects.map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                    </Select>
                </div>

                <div>
                    <span className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">{t("File format")}</span>
                    <SegmentedControl
                        label={t("File format")}
                        value={format}
                        onChange={setFormat}
                        options={[
                            { value: 'studyvault', label: '.studyvault' },
                            { value: 'json', label: '.json' },
                        ]}
                    />
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                        {format === 'studyvault'
                            ? t("Everything: topics, questions, cards with their pictures and audio, and uploaded files")
                            : t("Structure only: card media and uploaded files stay behind")}
                    </p>
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
                    <Button variant="quiet" onClick={onClose}>
                        {t("Cancel")}
                    </Button>
                    <Button variant="primary" busy={exporting} disabled={!selected} onClick={handleExport}>
                        {t("Export")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
