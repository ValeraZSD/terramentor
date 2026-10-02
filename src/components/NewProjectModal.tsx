// src/components/NewProjectModal.tsx
// The New project dialog, opened from the Projects page: three ways to start a
// project — with AI, through a chat model, or from a file. What is typed in it
// lives in the form below, which exists only while the dialog is open, so every
// way of closing it (Cancel, Escape, the backdrop, a finished import) also
// clears it. An AI creation is STARTED here and then lives in
// creation/creationRuns.ts — its screen, its stream and its ETA — so the form
// stays a form while any number of runs go on.
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store';
import { api } from '../api';
import Modal from './Modal';
import ProjectFormFields from './ProjectFormFields';
import { OutlineBriefPanel } from './ExternalAuthoring';
import VaultPanel from './VaultPanel';
import ProjectImportZone from './ProjectImportZone';
import { Button } from './ui/Button';
import { openCreationRun, startCreationRun, type CreationInput } from './creation/creationRuns';

const DEFAULT_COLOR = '#8B5CF6';
const DEFAULT_ICON = 'folder';

/** `draft` refills the form: a creation that failed before it made a project
 *  hands back what was typed (see `takeDraft`). */
export default function NewProjectModal({ isOpen, draft, onClose }: {
    isOpen: boolean;
    draft: CreationInput | null;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    // Always the FORM: a creation in progress has its own screen
    // (creation/CreationRunView), so this dialog never turns into one and
    // never stands between the reader and a new project.
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("Create New Project")}
            maxWidth="max-w-md"
        >
            <NewProjectForm draft={draft} onClose={onClose} />
        </Modal>
    );
}

function NewProjectForm({ draft, onClose }: { draft: CreationInput | null; onClose: () => void }) {
    const { t } = useTranslation();
    const createProject = useStore(s => s.createProject);
    const openProject = useStore(s => s.openProject);
    const addToast = useStore(s => s.addToast);

    const [createMode, setCreateMode] = useState<'ai' | 'external' | 'import'>('ai');
    const [newName, setNewName] = useState(draft?.name ?? '');
    const [newDescription, setNewDescription] = useState(draft?.description ?? '');
    const [newColor, setNewColor] = useState(draft?.color || DEFAULT_COLOR);
    const [newIcon, setNewIcon] = useState(draft?.icon || DEFAULT_ICON);
    const [newLanguage, setNewLanguage] = useState(draft?.language ?? '');
    // Vault files staged in the form. Held here (not on the server) so they
    // survive switching between tabs and serve either Create button, then
    // uploaded once the project row exists.
    const [stagedVaultFiles, setStagedVaultFiles] = useState<File[]>([]);

    // Upload any files staged in the form to the now-existing project.
    // Best-effort: a failed file surfaces a toast but never blocks project creation.
    const uploadStagedVault = async (projectId: number) => {
        if (stagedVaultFiles.length === 0) return;
        try {
            const { documents } = await api.uploadDocumentFiles(stagedVaultFiles, { projectId });
            const failed = documents.filter(d => !d.ok);
            if (failed.length) {
                addToast('error', t("{{count}} files couldn't be read", { count: failed.length }), failed.map(f => f.title).join(', '));
            }
        } catch (e: any) {
            addToast('error', t("Some vault files failed to upload"), e.message);
        }
    };

    const handleCreate = async () => {
        if (!newName.trim()) return;
        const project = await createProject({
            name: newName,
            description: newDescription,
            color: newColor,
            icon: newIcon,
            content_language: newLanguage,
        });
        await uploadStagedVault(project.id);
        onClose();
        openProject(project.id);
    };

    // Start a creation and hand it to the run store: the dialog closes, and
    // opens blank again, at once, so "New project" can start an empty project,
    // an import or another generation while this one runs. The run's own screen
    // opens over the grid; closing it leaves the run going (the task bar has it).
    const handleCreateWithAI = () => {
        if (!newName.trim()) return;
        const key = startCreationRun({
            name: newName,
            description: newDescription,
            color: newColor,
            icon: newIcon || 'brain',
            language: newLanguage,
            files: stagedVaultFiles,
        });
        onClose();
        openCreationRun(key);
    };

    return (
        <div className="space-y-4">
            {/* Three tabs at this width need short labels; "With AI"
                is the local pipeline, "Chat model" is the paste-a-prompt
                route, and they are genuinely different products rather
                than two ways to press the same button. */}
            <div className="flex rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700">
                {([
                    ['ai', t("With AI")],
                    ['external', t("Chat model")],
                    ['import', t("Import")],
                ] as const).map(([mode, label]) => (
                    <button
                        key={mode}
                        onClick={() => setCreateMode(mode)}
                        aria-pressed={createMode === mode}
                        className={`flex-1 min-h-[44px] px-2 text-sm font-medium transition ${createMode === mode
                            ? 'bg-accent text-white'
                            : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
                            }`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {createMode === 'external' ? (
                <OutlineBriefPanel
                    subject={newName}
                    setSubject={setNewName}
                    language={newLanguage}
                    onImported={(id) => { onClose(); openProject(id); }}
                />
            ) : createMode === 'import' ? (
                <ProjectImportZone onDone={onClose} />
            ) : (
                <>
                    <ProjectFormFields
                        name={newName}
                        setName={setNewName}
                        description={newDescription}
                        setDescription={setNewDescription}
                        color={newColor}
                        setColor={setNewColor}
                        icon={newIcon}
                        setIcon={setNewIcon}
                        language={newLanguage}
                        setLanguage={setNewLanguage}
                        isNew
                        descriptionRows={5}
                        namePlaceholder={t("e.g., Machine Learning, Japanese N3…")}
                        descriptionPlaceholder={t("Describe what you want to learn…")}
                        nameAutoFocus={true}
                    />

                    <div className="pt-4 border-t border-slate-200 dark:border-slate-700">
                        <div className="flex items-center justify-between mb-1.5">
                            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                                {t("Reference files")}{' '}<span className="text-slate-500 dark:text-slate-400 font-normal">{t("(optional)")}</span>
                            </label>
                            {stagedVaultFiles.length > 0 && (
                                <span className="text-xs text-slate-500 dark:text-slate-400">
                                    {t("{{length}} staged", { length: stagedVaultFiles.length })}
                                </span>
                            )}
                        </div>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                            {t("Curriculum, notes, textbooks or past exams. The AI uses them as grounding — they stay with the project whether you create it empty or with AI.")}
                        </p>
                        <VaultPanel
                            stagedFiles={stagedVaultFiles}
                            onStagedFilesChange={setStagedVaultFiles}
                        />
                    </div>

                    {/* Sticky in the dialog's own scroll area, on its surface: the
                        form is taller than a laptop screen, and the submit must
                        not be a scroll away. `-mx-6 -mb-4` reach the dialog's
                        padding so the bar meets its edges and nothing scrolls
                        past beneath it. */}
                    <div className="sticky bottom-0 z-10 -mx-6 -mb-4 px-6 pb-4 flex justify-end gap-3 pt-4 border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                        {/* The shared Button: the hand-rolled three faded to 50%
                            when disabled, which on a tinted page left a pale lilac
                            nobody read as a button, and their labels wrapped. */}
                        <Button variant="quiet" onClick={onClose}>{t("Cancel")}</Button>
                        <Button variant="neutral" onClick={handleCreate} disabled={!newName.trim()} className="whitespace-nowrap">
                            {t("Create Empty")}
                        </Button>
                        <Button variant="primary" onClick={handleCreateWithAI} disabled={!newName.trim()} icon={<Sparkles className="w-4 h-4" />} className="whitespace-nowrap">
                            {t("Create with AI")}
                        </Button>
                    </div>
                </>
            )}
        </div>
    );
}
