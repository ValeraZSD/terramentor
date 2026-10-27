import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FOCUS_RING } from './ui/vocabulary';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '../store';
import { Project } from '../types';
import { useAICreationContext } from './aiCreationContext';
import ProgressRing from './ProgressRing';
import Modal from './Modal';
import ExportProjectModal from './ExportProjectModal';
import { Trash2, MoreVertical, Edit2, Upload, Loader2, CheckCircle2, Archive, RotateCcw, BookPlus, Trophy, Play } from 'lucide-react';
import { MaterialPassPanel } from './ExternalAuthoring';
import ProjectFormFields from './ProjectFormFields';
import { Button, IconButton } from './ui/Button';
import { MenuItem, MENU_PANEL } from './ui/Popover';
import { ProjectIcon } from './ProjectIcon';
import { useAccentVars } from '../hooks/useAccentVars';
import { useDropFlash } from '../hooks/useDropFlash';
import { useTranslation } from 'react-i18next';
import { uiLocale } from '../utils/locale';
import { countsInCards } from '../utils/projectShape';

interface Props {
    project: Project;
    isDragOverlay?: boolean;
}

export default function ProjectCard({ project, isDragOverlay }: Props) {
    const { t } = useTranslation();
    const openProject = useStore(s => s.openProject);
    const studyProject = useStore(s => s.studyProject);
    const deleteProject = useStore(s => s.deleteProject);
    const openCompletion = useStore(s => s.openCompletion);
    const updateProject = useStore(s => s.updateProject);
    const showConfirm = useStore(s => s.showConfirm);
    const { isProjectGenerating, openGenerationModal } = useAICreationContext();

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
    const [editSearchWords, setEditSearchWords] = useState(project.search_words ?? '');
    // What the field held when the dialog opened: the model may write the
    // words while it is open, and an untouched field must not then be sent as
    // the learner's '' over them.
    const [openedSearchWords, setOpenedSearchWords] = useState(project.search_words ?? '');

    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: project.id,
        disabled: isDragOverlay
    });
    // The overlay flying home lights up too, so the flash starts at the drop
    // and the card it lands on (hidden until then) carries it on.
    const flash = useDropFlash(`project:${project.id}`);

    // Theme this card's accent (e.g. the "AI generating" badge) to its own colour.
    const accent = useAccentVars(project.color);
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.3 : 1,
        zIndex: isDragging ? 1000 : undefined,
        ...accent,
        ...flash?.style,
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
    // The rule is `countsInCards` (utils/projectShape.ts), shared with every
    // other screen that asks it — this card is where it was first written.
    const isDeck = countsInCards({ teaches: project.teaches, topics, cards });
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
        setEditSearchWords(project.search_words ?? '');
        setOpenedSearchWords(project.search_words ?? '');
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
            // Sent only when changed: an untouched field must not stamp the
            // model's words as the learner's, and a new name gets new ones.
            ...(editSearchWords.trim() !== openedSearchWords.trim() ? { search_words: editSearchWords.trim() } : {}),
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
        // Escape closes it and hands focus back to the ⋮ it came from.
        const handleKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            setShowMenu(false);
            menuBtnRef.current?.focus();
        };
        document.addEventListener('keydown', handleKey, true);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('click', handleClickOutside);
            document.removeEventListener('scroll', handleClickOutside, true);
            document.removeEventListener('keydown', handleKey, true);
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
                // The whole card opens the project for the pointer; the keyboard
                // and a screen reader reach that through the title below. As a
                // button role holding Study, the ⋮ menu and the drag handle, the
                // card was buttons inside a button.
                onClick={() => !isDragging && openProject(project.id)}
                // Border and shadow animate; OPACITY must not. dnd-kit hides
                // the dropped card (opacity 0) while the overlay lands on its
                // slot and shows it again at the end, and a plain `transition`
                // faded it back in over 150 ms: the card blinked out for two
                // frames after every drop.
                className={`w-full max-w-sm h-full bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 cursor-pointer hover:border-slate-300 dark:hover:border-slate-600 hover:shadow-md transition-[border-color,box-shadow] group flex flex-col ${isDragging ? 'shadow-2xl' : ''} ${isDragging || isDragOverlay ? 'drag-ring' : ''} ${flash?.className ?? ''}`}
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
                            {/* The card's accent is the project's colour made
                                safe for a white label (`useAccentVars` above), so
                                a white drawing on it reads on every swatch. */}
                            <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shrink-0 bg-accent text-white">
                                <ProjectIcon icon={project.icon} className="h-6 w-6" />
                            </div>
                            {/* A control, not a badge: it opens this project's
                                creation screen, over the grid, while every other
                                card and the New project form stay usable. */}
                            {isGenerating && (
                                <Button
                                    variant="subtle"
                                    size="sm"
                                    className="shrink-0 whitespace-nowrap text-accent-fg"
                                    icon={<Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                                    onClick={e => { e.stopPropagation(); openGenerationModal(project.id); }}
                                    title={t("View AI generation progress")}
                                >
                                    {t("AI generating…")}
                                </Button>
                            )}
                            {status === 'completed' && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-3xs font-medium rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 shrink-0">
                                    <CheckCircle2 className="w-3 h-3" /> {t("Completed")}
                                </span>
                            )}
                            {status === 'archived' && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-3xs font-medium rounded-full bg-slate-200 dark:bg-slate-600 text-slate-600 dark:text-slate-300 shrink-0">
                                    <Archive className="w-3 h-3" /> {t("Archived")}
                                </span>
                            )}
                        </div>

                        <div className="relative">
                            {/* Hover-reveal only where a hover pointer exists. On touch this was
                                `opacity-0` forever, so Edit / Export / status changes were
                                unreachable on a phone. Keyboard focus reveals it too. */}
                            <IconButton
                                ref={menuBtnRef}
                                onClick={e => { e.stopPropagation(); if (showMenu) setShowMenu(false); else openMenu(); }}
                                label={t("Project options")}
                                tooltip={false}
                                aria-haspopup="menu"
                                aria-expanded={showMenu}
                                icon={<MoreVertical className="w-4 h-4" />}
                                className="can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:focus-visible:opacity-100"
                            />

                            {showMenu && createPortal(
                                <div
                                    ref={menuRef}
                                    style={{ top: menuPos.top, right: menuPos.right }}
                                    onClick={e => e.stopPropagation()}
                                    className={`fixed min-w-44 w-max z-50 ${MENU_PANEL}`}
                                >
                                    <MenuItem roving={false} onSelect={handleEdit} icon={<Edit2 className="w-4 h-4" />}>
                                        {t("Edit")}
                                    </MenuItem>
                                    <MenuItem roving={false} onSelect={handleExport} icon={<Upload className="w-4 h-4" />}>
                                        {t("Export")}
                                    </MenuItem>
                                    {/* A deck has no phases and no topics to write
                                        readings for — its material is its cards. */}
                                    {!isDeck && (
                                        <MenuItem roving={false} onSelect={handleAddMaterial} icon={<BookPlus className="w-4 h-4" />}>
                                            {t("Add material")}
                                        </MenuItem>
                                    )}

                                    {/* The finished-project screen shows itself once, the
                                        moment the last item is done. This is how it is
                                        reached afterwards. */}
                                    {(progress >= 100 || status === 'completed') && (
                                        <MenuItem roving={false} onSelect={handleSummary} icon={<Trophy className="w-4 h-4 text-amber-500" />}>
                                            {t("Summary")}
                                        </MenuItem>
                                    )}

                                    <div className="my-1 h-px bg-slate-100 dark:bg-slate-600" />

                                    {status !== 'completed' && (
                                        <MenuItem roving={false} onSelect={e => changeStatus(e, 'completed')} icon={<CheckCircle2 className="w-4 h-4 text-emerald-500" />}>
                                            {t("Mark completed")}
                                        </MenuItem>
                                    )}
                                    {status !== 'archived' && (
                                        <MenuItem roving={false} onSelect={e => changeStatus(e, 'archived')} icon={<Archive className="w-4 h-4" />}>
                                            {t("Archive")}
                                        </MenuItem>
                                    )}
                                    {status !== 'active' && (
                                        <MenuItem roving={false} onSelect={e => changeStatus(e, 'active')} icon={<RotateCcw className="w-4 h-4" />}>
                                            {t("Move to active")}
                                        </MenuItem>
                                    )}

                                    <div className="my-1 h-px bg-slate-100 dark:bg-slate-600" />

                                    <MenuItem roving={false} tone="danger" onSelect={handleDelete} icon={<Trash2 className="w-4 h-4" />}>
                                        {t("Delete")}
                                    </MenuItem>
                                </div>,
                                document.body)}
                        </div>
                    </div>

                    <h3 className="font-semibold text-slate-900 dark:text-white text-lg mb-1">
                        <button data-row="title"
                            type="button"
                            onClick={(e) => { e.stopPropagation(); if (!isDragging) openProject(project.id); }}
                            aria-label={t("Open {{name}}", { name: project.name })}
                            className={`-mx-1 px-1 line-clamp-2 text-left rounded ${FOCUS_RING}`}
                        >
                            {project.name}
                        </button>
                    </h3>
                    {project.description && (
                        <p className="text-sm text-slate-500 dark:text-slate-400 line-clamp-3">{project.description}</p>
                    )}

                    <div className="flex items-center justify-between gap-2 pt-4 mt-auto border-t border-slate-100 dark:border-slate-700">
                        <div className="text-sm text-slate-500 dark:text-slate-400 min-w-0">
                            {isDeck
                                ? t("{{value}} / {{value2}} cards met", { count: cards, value: (project.seen_card_count || 0).toLocaleString(uiLocale()), value2: cards.toLocaleString(uiLocale()) })
                                : t("{{done}} / {{total}} items", { count: topics, done: project.completed_topic_count || 0, total: topics })}
                            {alsoHasCards && (
                                <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                                    {t("{{value}} / {{value2}} cards met", { count: cards, value: (project.seen_card_count || 0).toLocaleString(uiLocale()), value2: cards.toLocaleString(uiLocale()) })}
                                </div>
                            )}
                        </div>
                        {/* Study is the card's own action, and it goes
                            straight into the course's stream. Without it the
                            tile is a READ — a title, a count and a ring — and
                            a library of sixteen courses offers no way to
                            start any of them but to open one and hunt. It
                            sits INSIDE the footer row, so the tile does not
                            grow a line and break the grid's level rows.
                            Active courses only: a finished or archived one is
                            a record, and its menu still has Summary. */}
                        <div className="flex items-center gap-2 shrink-0">
                            {(project.status ?? 'active') === 'active' && (
                                <Button
                                    variant="primary"
                                    onClick={e => { e.stopPropagation(); studyProject(project.id); }}
                                    title={t("Study {{name}}", { name: project.name })}
                                    icon={<Play className="w-4 h-4" aria-hidden="true" />}
                                >
                                    {t("Study")}
                                </Button>
                            )}
                            <ProgressRing progress={progress} color={progressColor} size={40} />
                        </div>
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
                        searchWords={editSearchWords}
                        setSearchWords={setEditSearchWords}
                        searchWordsPending={project.search_words == null}
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

            <ExportProjectModal
                isOpen={showExport}
                onClose={() => setShowExport(false)}
                initialProjectId={project.id}
            />
        </>
    );
}