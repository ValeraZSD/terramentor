import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { onActivateKey } from '../utils/a11y';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore, isDarkTheme } from '../store';
import { Project } from '../types';
import { useAICreationContext } from './ProjectsGrid';
import ProgressRing from './ProgressRing';
import Modal from './Modal';
import ImportExportModal from './ImportExportModal';
import { Trash2, MoreVertical, Edit2, Upload, Loader2, CheckCircle2, Archive, RotateCcw, BookPlus, Trophy } from 'lucide-react';
import { MaterialPassPanel } from './ExternalAuthoring';
import ProjectFormFields from './ProjectFormFields';
import { Button } from './ui/Button';
import { getIconEmoji } from './IconPicker';
import { accentSolidTriplet, accentFgTriplet } from '../utils/color';
import { useTranslation } from 'react-i18next';
import { uiLocale } from '../utils/locale';

interface Props {
    project: Project;
    isDragOverlay?: boolean;
}

export default function ProjectCard({ project, isDragOverlay }: Props) {
    const { t } = useTranslation();
    const openProject = useStore(s => s.openProject);
    const deleteProject = useStore(s => s.deleteProject);
    const openCompletion = useStore(s => s.openCompletion);
    const updateProject = useStore(s => s.updateProject);
    const showConfirm = useStore(s => s.showConfirm);
    const theme = useStore(s => s.theme);
    const { isProjectGenerating } = useAICreationContext();

    const isGenerating = isProjectGenerating(project.id);

    const [showMenu, setShowMenu] = useState(false);
    const [showEdit, setShowEdit] = useState(false);
    const [showExport, setShowExport] = useState(false);
    const [showMaterial, setShowMaterial] = useState(false);
    const [editName, setEditName] = useState(project.name);
    const [editDescription, setEditDescription] = useState(project.description);
    const [editColor, setEditColor] = useState(project.color);
    const [editIcon, setEditIcon] = useState(project.icon);
    const [editLanguage, setEditLanguage] = useState(project.content_language || '');

    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: project.id,
        disabled: isDragOverlay
    });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.3 : 1,
        zIndex: isDragging ? 1000 : undefined,
        // Theme this card's accent (e.g. the "AI generating" badge) to its own colour.
        '--accent-rgb': accentSolidTriplet(project.color),
        '--accent-fg-rgb': accentFgTriplet(project.color, isDarkTheme(theme)),
    } as React.CSSProperties;

    // A project nothing is teaching measures itself in CARDS MET, not topics
    // completed: nothing will ever mark its nodes complete, so the leaf-status
    // ratio described a real 1,501-card import as "0 / 1 items, 0%" —
    // a true statement about a denominator nobody chose. The test was "is this
    // an Anki import", which is why a course full of cards could never show the
    // card number and an import could never show the topic one. It is now
    // whichever metric can actually move: switch teaching on for an import with
    // named subdecks and its 32 topics become the measure.
    const cards = project.card_count ?? 0;
    const topics = project.topic_count ?? 0;
    // …and a collection with no topics at all measures itself in cards however
    // its teaching switch is set: 30 "Stage N" slices are not 30 things to
    // finish, so counting them would put the card back where it started with a
    // denominator of a different shape.
    const isDeck = (project.teaches === false || topics === 0) && cards > 0;
    // The RING is the one number the server computes for every surface
    // (`server/progress.js`): a topic closed by hand counts 1, a topic whose
    // content is cards counts the share of them met, and every topic weighs the
    // same. The count of ticks reads a deck with six named subdecks and 471
    // cards met as 0%.
    const progress = Math.round((project.progress_fraction ?? 0) * 100);
    // A taught import has both halves and both are true, so the card prints
    // both: the count of topics closed, and the cards underneath it.
    const alsoHasCards = !isDeck && cards > 0;

    const handleDelete = async (e: React.MouseEvent) => {
        e.stopPropagation();
        setShowMenu(false);
        const confirmed = await showConfirm({
            title: t("Delete Project"),
            message: t("Delete \"{{name}}\" and all its contents? This action cannot be undone.", { name: project.name }),
            confirmLabel: t("Delete"),
            variant: 'danger',
        });
        if (!confirmed) return;
        await deleteProject(project.id);
    };

    const handleEdit = (e: React.MouseEvent) => {
        e.stopPropagation();
        setEditName(project.name);
        setEditDescription(project.description);
        setEditColor(project.color);
        setEditIcon(project.icon);
        setEditLanguage(project.content_language || '');
        setShowEdit(true);
        setShowMenu(false);
    };

    const handleExport = (e: React.MouseEvent) => {
        e.stopPropagation();
        setShowExport(true);
        setShowMenu(false);
    };

    const handleAddMaterial = (e: React.MouseEvent) => {
        e.stopPropagation();
        setShowMaterial(true);
        setShowMenu(false);
    };

    const handleSummary = (e: React.MouseEvent) => {
        e.stopPropagation();
        setShowMenu(false);
        openCompletion(project.id);
    };

    const changeStatus = async (e: React.MouseEvent, status: 'active' | 'completed' | 'archived') => {
        e.stopPropagation();
        setShowMenu(false);
        await updateProject(project.id, { status });
    };

    const status = project.status ?? 'active';

    const handleSaveEdit = async () => {
        await updateProject(project.id, {
            name: editName,
            description: editDescription,
            color: editColor,
            icon: editIcon,
            content_language: editLanguage,
        });
        setShowEdit(false);
    };

    useEffect(() => {
        if (!showMenu) return;
        const handleClickOutside = () => setShowMenu(false);
        const timer = setTimeout(() => document.addEventListener('click', handleClickOutside), 0);
        // A portalled menu is positioned once, in viewport coordinates, so it
        // would slide away from its card on a scroll. Close it instead.
        document.addEventListener('scroll', handleClickOutside, true);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('click', handleClickOutside);
            document.removeEventListener('scroll', handleClickOutside, true);
        };
    }, [showMenu]);

    // The options menu is portalled to the body for the same reason the dialogs
    // are (see `Modal`): the archived and completed grids dim themselves with
    // `opacity-70`, and a menu inside that subtree is painted at 70% alpha with
    // the cards behind it showing through — permanently on a phone, where
    // nothing ever hovers to lift the dim.
    const menuBtnRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [menuPos, setMenuPos] = useState({ top: 0, right: 0 });

    const openMenu = () => {
        const r = menuBtnRef.current?.getBoundingClientRect();
        if (r) setMenuPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
        setShowMenu(true);
    };

    // Flip above the button when the menu would run off the bottom: a fixed
    // menu is outside the page's scroll, so what leaves the viewport is gone.
    useLayoutEffect(() => {
        if (!showMenu || !menuRef.current || !menuBtnRef.current) return;
        const height = menuRef.current.offsetHeight;
        const anchor = menuBtnRef.current.getBoundingClientRect();
        const below = anchor.bottom + 4;
        const flipped = below + height > window.innerHeight - 8
            ? anchor.top - height - 4
            : below;
        const top = Math.max(8, Math.min(flipped, window.innerHeight - 8 - height));
        if (top !== menuPos.top) setMenuPos(p => ({ ...p, top }));
    }, [showMenu, menuPos.top]);

    const progressColor = progress === 100 ? '#22C55E' : project.color;

    return (
        <>
            <div
                ref={setNodeRef}
                style={style}
                onClick={() => !isDragging && openProject(project.id)}
                onKeyDown={onActivateKey(() => !isDragging && openProject(project.id))}
                role="button"
                tabIndex={0}
                aria-label={t("Open {{name}}", { name: project.name })}
                className={`w-full max-w-sm h-full bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 cursor-pointer hover:border-slate-300 dark:hover:border-slate-600 hover:shadow-md transition group flex flex-col ${isDragging ? 'shadow-2xl' : ''}`}
            >
                <div
                    {...attributes}
                    {...listeners}
                    onClick={e => e.stopPropagation()}
                    title={t("Drag to reorder (press and hold on touch)")}
                    className="flex justify-center py-2 cursor-grab active:cursor-grabbing transition touch-pan-y can-hover:opacity-0 can-hover:group-hover:opacity-100"
                >
                    <div className="flex gap-1">
                        {[...Array(5)].map((_, i) => (
                            <div key={i} className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600" />
                        ))}
                    </div>
                </div>

                <div className="px-5 pb-5 flex-1 flex flex-col">
                    <div className="flex items-start justify-between mb-4">
                        <div className="flex items-center gap-2">
                            <div
                                className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shrink-0"
                                style={{ backgroundColor: project.color }}
                            >
                                {getIconEmoji(project.icon)}
                            </div>
                            {isGenerating && (
                                <div className="flex items-center gap-1.5 px-2 py-1 bg-accent/20 rounded-lg border border-accent/30 dark:border-accent/40 shrink-0">
                                    <Loader2 className="w-3 h-3 text-accent-fg animate-spin shrink-0" />
                                    <span className="text-[10px] text-accent-fg font-medium whitespace-nowrap">{t("AI generating…")}</span>
                                </div>
                            )}
                            {status === 'completed' && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 shrink-0">
                                    <CheckCircle2 className="w-3 h-3" /> {t("Completed")}
                                </span>
                            )}
                            {status === 'archived' && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-slate-200 dark:bg-slate-600 text-slate-600 dark:text-slate-300 shrink-0">
                                    <Archive className="w-3 h-3" /> {t("Archived")}
                                </span>
                            )}
                        </div>

                        <div className="relative">
                            {/* Hover-reveal only where a hover pointer exists. On touch this was
                                `opacity-0` forever, so Edit / Export / status changes were
                                unreachable on a phone. Keyboard focus reveals it too. */}
                            <button
                                ref={menuBtnRef}
                                onClick={e => { e.stopPropagation(); if (showMenu) setShowMenu(false); else openMenu(); }}
                                aria-label={t("Project options")}
                                aria-haspopup="menu"
                                aria-expanded={showMenu}
                                className="p-4 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:focus-visible:opacity-100"
                            >
                                <MoreVertical className="w-4 h-4 text-slate-400" />
                            </button>

                            {showMenu && createPortal(
                                <div
                                    ref={menuRef}
                                    style={{ top: menuPos.top, right: menuPos.right }}
                                    onClick={e => e.stopPropagation()}
                                    className="fixed w-44 bg-white dark:bg-slate-700 rounded-xl shadow-lg border border-slate-200 dark:border-slate-600 py-1 z-50"
                                >
                                    <button
                                        onClick={handleEdit}
                                        className="w-full px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 flex items-center gap-2"
                                    >
                                        <Edit2 className="w-4 h-4" />
                                        {t("Edit")}
                                    </button>
                                    <button
                                        onClick={handleExport}
                                        className="w-full px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 flex items-center gap-2"
                                    >
                                        <Upload className="w-4 h-4" />
                                        {t("Export")}
                                    </button>
                                    {/* A deck has no phases and no topics to write
                                        readings for — its material is its cards. */}
                                    {!isDeck && (
                                        <button
                                            onClick={handleAddMaterial}
                                            className="w-full px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 flex items-center gap-2"
                                        >
                                            <BookPlus className="w-4 h-4" />
                                            {t("Add material")}
                                        </button>
                                    )}

                                    {/* The finished-project screen shows itself once, the
                                        moment the last item is done. This is how it is
                                        reached afterwards — and the only way at all for a
                                        project finished before the screen existed. */}
                                    {(progress >= 100 || status === 'completed') && (
                                        <button
                                            onClick={handleSummary}
                                            className="w-full px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 flex items-center gap-2"
                                        >
                                            <Trophy className="w-4 h-4 text-amber-500" />
                                            {t("Summary")}
                                        </button>
                                    )}

                                    <div className="my-1 h-px bg-slate-100 dark:bg-slate-600" />

                                    {status !== 'completed' && (
                                        <button
                                            onClick={e => changeStatus(e, 'completed')}
                                            className="w-full px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 flex items-center gap-2"
                                        >
                                            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                                            {t("Mark completed")}
                                        </button>
                                    )}
                                    {status !== 'archived' && (
                                        <button
                                            onClick={e => changeStatus(e, 'archived')}
                                            className="w-full px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 flex items-center gap-2"
                                        >
                                            <Archive className="w-4 h-4 text-slate-400" />
                                            {t("Archive")}
                                        </button>
                                    )}
                                    {status !== 'active' && (
                                        <button
                                            onClick={e => changeStatus(e, 'active')}
                                            className="w-full px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 flex items-center gap-2"
                                        >
                                            <RotateCcw className="w-4 h-4 text-slate-400" />
                                            {t("Move to active")}
                                        </button>
                                    )}

                                    <div className="my-1 h-px bg-slate-100 dark:bg-slate-600" />

                                    <button
                                        onClick={handleDelete}
                                        className="w-full px-3 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                        {t("Delete")}
                                    </button>
                                </div>,
                                document.body)}
                        </div>
                    </div>

                    <h3 className="font-semibold text-slate-900 dark:text-white text-lg mb-1 line-clamp-2">{project.name}</h3>
                    {project.description && (
                        <p className="text-sm text-slate-500 dark:text-slate-400 line-clamp-3">{project.description}</p>
                    )}

                    <div className="flex items-center justify-between pt-4 mt-auto border-t border-slate-100 dark:border-slate-700">
                        <div className="text-sm text-slate-500 dark:text-slate-400 min-w-0">
                            {isDeck
                                ? t("{{value}} / {{value2}} cards met", { value: (project.seen_card_count || 0).toLocaleString(uiLocale()), value2: cards.toLocaleString(uiLocale()) })
                                : t("{{done}} / {{total}} items", { done: project.completed_topic_count || 0, total: topics })}
                            {alsoHasCards && (
                                <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                                    {t("{{value}} / {{value2}} cards met", { value: (project.seen_card_count || 0).toLocaleString(uiLocale()), value2: cards.toLocaleString(uiLocale()) })}
                                </div>
                            )}
                        </div>
                        <ProgressRing progress={progress} color={progressColor} size={40} />
                    </div>
                </div>
            </div>

            <Modal isOpen={showEdit} onClose={() => setShowEdit(false)} title={t("Edit Project")} maxWidth="max-w-md">
                <div className="space-y-4">
                    <ProjectFormFields
                        name={editName}
                        setName={setEditName}
                        description={editDescription}
                        setDescription={setEditDescription}
                        color={editColor}
                        setColor={setEditColor}
                        icon={editIcon}
                        setIcon={setEditIcon}
                        language={editLanguage}
                        setLanguage={setEditLanguage}
                        descriptionRows={7}
                        projectId={project.id}
                        namePlaceholder={project.name}
                        descriptionPlaceholder={project.description || t("No description")}
                        nameAutoFocus={true}
                    />
                    <div className="flex justify-end gap-3 pt-4 border-t border-slate-200 dark:border-slate-700">
                        <Button variant="quiet" onClick={() => setShowEdit(false)}>{t("Cancel")}</Button>
                        <Button variant="primary" onClick={handleSaveEdit}>{t("Save Changes")}</Button>
                    </div>
                </div>
            </Modal>

            <Modal
                isOpen={showMaterial}
                onClose={() => setShowMaterial(false)}
                title={t("Add material — {{name}}", { name: project.name })}
                maxWidth="max-w-xl"
            >
                <MaterialPassPanel projectId={project.id} />
            </Modal>

            <ImportExportModal
                isOpen={showExport}
                onClose={() => setShowExport(false)}
                initialProjectId={project.id}
                mode="export"
            />
        </>
    );
}