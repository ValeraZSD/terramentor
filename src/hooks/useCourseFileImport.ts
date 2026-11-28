// src/hooks/useCourseFileImport.ts
// The one way a course file becomes a project: the Import tab's file drop, its
// link field and the page a course link opens all hand their file here, so the
// edition check (update in place), the importer's notes and the toasts stay
// one path.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store';
import { api } from '../api';
import { installedEditionOf } from '../utils/projectFiles';

export function useCourseFileImport() {
    const { t } = useTranslation();
    const openProject = useStore(s => s.openProject);
    const openAnkiImport = useStore(s => s.openAnkiImport);
    const openCourseUpdate = useStore(s => s.openCourseUpdate);
    const loadProjects = useStore(s => s.loadProjects);
    const addToast = useStore(s => s.addToast);
    const [importing, setImporting] = useState(false);

    /** Imports `file`; `onDone` runs once a project exists, or before the file is handed to another screen. */
    const importFile = async (file: File, onDone: () => void) => {
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

    return { importing, importFile };
}
