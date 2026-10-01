// src/components/ProjectImportZone.tsx
// The Import tab of the New project dialog: a dropzone that turns a project
// file into a project, or hands an Anki deck to the deck importer.
import { useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store';
import { api } from '../api';
import { onActivateKey } from '../utils/a11y';

/** What this dropzone accepts. An Anki deck is here because it is where
 *  someone holding one looks first — "import" is the word they are after,
 *  and a separate entrance in Settings is a door they never find. */
const IMPORT_ACCEPT = '.json,.studyvault,.zip,.apkg,.colpkg';
const IMPORTABLE_RE = /\.(json|studyvault|zip|apkg|colpkg)$/i;

/** `onDone` closes the dialog: called once a project exists, and before a
 *  deck is handed over. A file that fails to import leaves the dialog open. */
export default function ProjectImportZone({ onDone }: { onDone: () => void }) {
    const { t } = useTranslation();
    const openProject = useStore(s => s.openProject);
    const openAnkiImport = useStore(s => s.openAnkiImport);
    const loadProjects = useStore(s => s.loadProjects);
    const addToast = useStore(s => s.addToast);

    const [importing, setImporting] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

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
                addToast('info', t("Imported \"{{name}}\" with {{count}} notes", { name: newProject.name, count: warnings.length }), warnings.join(''));
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

    const handleDropZoneClick = () => fileInputRef.current?.click();

    const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) processImport(file);
    };

    return (
        <div
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${isDragging
                ? 'border-accent bg-accent/10'
                : 'border-slate-300 dark:border-slate-600 hover:border-accent'
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
                <div className="flex flex-col items-center gap-3">
                    <Loader2 className="w-10 h-10 text-accent-fg animate-spin" />
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                        {t("Importing...")}
                    </p>
                </div>
            ) : (
                <>
                    <Upload className="w-10 h-10 text-slate-400 mx-auto mb-3" />
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                        {t("Drop a project file or an Anki deck here")}
                    </p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                        {t(".json (structure only) · .studyvault (structure + files) · .apkg (Anki deck)")}
                    </p>
                </>
            )}
        </div>
    );
}
