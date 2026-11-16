// src/components/CourseUpdateModal.tsx
// The preview of updating a course already in the library from a newer file of
// it: what the file changes, adds and removes, the places where the learner and
// the file both changed the same thing (theirs kept unless they choose the
// file's), then the update itself and an undo. Opened by the import doors when
// the file's course is one the library already holds.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store';
import { api } from '../api';
import Modal from './Modal';
import { Button } from './ui/Button';
import { importProjectFile } from '../utils/projectFiles';
import CourseUpdateChanges, { fieldName } from './CourseUpdateChanges';

type Phase = 'preview' | 'applying' | 'done' | 'undoing' | 'undone';

export default function CourseUpdateModal() {
    const { t } = useTranslation();
    const pending = useStore(s => s.courseUpdate);
    const close = useStore(s => s.closeCourseUpdate);
    const loadProjects = useStore(s => s.loadProjects);
    const openProject = useStore(s => s.openProject);
    const addToast = useStore(s => s.addToast);

    const [phase, setPhase] = useState<Phase>('preview');
    const [choices, setChoices] = useState<Record<string, 'mine' | 'file'>>({});
    const [error, setError] = useState<string | null>(null);
    const [copying, setCopying] = useState(false);

    // A new file starts a new preview.
    useEffect(() => {
        setPhase('preview');
        setChoices({});
        setError(null);
        setCopying(false);
    }, [pending]);

    if (!pending) return null;
    const { file, preview } = pending;
    const match = preview.match!;
    const summary = preview.summary;
    const items = preview.items;
    const conflicts = preview.conflicts ?? [];
    const refused = preview.refused === 'older';
    const nothing = !refused && !!summary?.nothing;
    const busy = phase === 'applying' || phase === 'undoing' || copying;

    const apply = async () => {
        setPhase('applying');
        setError(null);
        try {
            const taken = Object.fromEntries(Object.entries(choices).filter(([, v]) => v === 'file'));
            await api.commitCourseUpdate(file, match.projectId, taken);
        } catch (e: any) {
            setError(e?.message || String(e));
            setPhase('preview');
            return;
        }
        // The update is written; a failed list refresh must not offer to apply it again.
        setPhase('done');
        loadProjects().catch(() => { });
    };

    const undo = async () => {
        setPhase('undoing');
        setError(null);
        try {
            await api.undoCourseUpdate(match.projectId);
        } catch (e: any) {
            setError(e?.message || String(e));
            setPhase('done');
            return;
        }
        setPhase('undone');
        loadProjects().catch(() => { });
    };

    const finish = () => {
        close();
        if (phase === 'done' || phase === 'undone') openProject(match.projectId);
    };

    // The old way stays one press away: someone may want both editions side by side.
    const importCopy = async () => {
        setCopying(true);
        try {
            const result = await importProjectFile(file);
            await loadProjects();
            close();
            openProject(result.id);
            addToast('success', t("Project \"{{name}}\" imported successfully", { name: result.name }));
        } catch (e: any) {
            setError(e?.message || String(e));
            setCopying(false);
        }
    };

    const footer = phase === 'done' || phase === 'undoing' ? (
        <>
            <Button variant="neutral" busy={phase === 'undoing'} onClick={undo}>{t("Undo update")}</Button>
            <Button variant="primary" disabled={busy} onClick={finish}>{t("Done")}</Button>
        </>
    ) : phase === 'undone' ? (
        <Button variant="primary" onClick={finish}>{t("Done")}</Button>
    ) : refused || nothing ? (
        <>
            <Button variant="quiet" disabled={busy} onClick={close}>{t("Close")}</Button>
            <Button variant="neutral" busy={copying} disabled={busy} onClick={importCopy}>{t("Add as a second course")}</Button>
        </>
    ) : (
        <>
            <Button variant="quiet" disabled={busy} onClick={close}>{t("Cancel")}</Button>
            <Button variant="neutral" busy={copying} disabled={busy} onClick={importCopy}>{t("Add as a second course")}</Button>
            <Button variant="primary" busy={phase === 'applying'} disabled={busy} onClick={apply}>{t("Update course")}</Button>
        </>
    );

    const editions = match.version && match.fileVersion && match.version !== match.fileVersion
        ? t("You have edition {{mine}}; this file is edition {{file}}.", { mine: match.version, file: match.fileVersion })
        : null;
    // The edition has its own line above; the rest are details the learner may have set.
    const detailFields = (items?.project ?? []).filter(f => f !== 'version');

    return (
        <Modal isOpen onClose={busy ? () => { } : close} closable={!busy} title={t("Update {{name}}", { name: match.name })} maxWidth="max-w-3xl" footer={footer}>
            <div className="space-y-4" aria-live="polite">
                {error && (
                    <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
                        {error}
                    </p>
                )}

                {phase === 'done' || phase === 'undoing' ? (
                    <p className="text-slate-700 dark:text-slate-200">
                        {t("The course is updated. Your progress, notes and reviews stayed with it.")}
                    </p>
                ) : phase === 'undone' ? (
                    <p className="text-slate-700 dark:text-slate-200">{t("The update was undone. The course is as it was before.")}</p>
                ) : refused ? (
                    <p className="text-slate-700 dark:text-slate-200">
                        {t("This file is an older edition than the course you have, so it was not applied.")}
                        {editions && <span className="mt-1 block text-sm text-slate-500 dark:text-slate-400">{editions}</span>}
                    </p>
                ) : nothing ? (
                    <p className="text-slate-700 dark:text-slate-200">{t("This file changes nothing in your course.")}</p>
                ) : summary && items ? (
                    <>
                        <p className="text-slate-700 dark:text-slate-200">
                            {t("This file is a newer edition of a course you already have. Updating it keeps your progress, notes and reviews.")}
                            {editions && <span className="mt-1 block text-sm text-slate-500 dark:text-slate-400">{editions}</span>}
                        </p>
                        <CourseUpdateChanges key={`${file.name}:${file.size}:${file.lastModified}`} items={items} summary={summary} conflicts={conflicts} choices={choices}
                            onChoose={(key, v) => setChoices(prev => ({ ...prev, [key]: v }))}
                            details={detailFields.map(f => fieldName(t, f))} />
                    </>
                ) : null}
            </div>
        </Modal>
    );
}
