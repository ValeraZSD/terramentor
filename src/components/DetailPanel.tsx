import { useState, useEffect } from 'react';
import { useStore } from '../store';
import { useIsMobile } from '../hooks/useMediaQuery';
import { usePointerVerb } from '../utils/platform';
import { findNode, todayStr, parseDate, isLeafNode, structuralChildren } from '../utils/tree';
import { api } from '../api';
import Breadcrumbs from './Breadcrumbs';
import Checkbox from './Checkbox';
import ResourceList from './ResourceList';
import MarkdownNotes from './MarkdownNotes';
import AIPanel from './AIPanel';
import StudyTools from './StudyTools';
import StatusBadge from './StatusBadge';
import ExternalSearchButton from './ExternalSearchButton';
import { FileText, Circle, Clock, CheckCircle, MinusCircle, Bot, Brain, BookOpen, Layers, X, Calendar, AlertTriangle, Scale, Play, PenLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { uiLocale } from '../utils/locale';

type Tab = 'details' | 'ai' | 'quizzes' | 'flashcards';

function formatDateShort(dateStr: string): string {
    const d = parseDate(dateStr);
    return d.toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export default function DetailPanel() {
    const { t } = useTranslation();
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const tree = useStore(s => s.tree);
    const updateNode = useStore(s => s.updateNode);
    const selectNode = useStore(s => s.selectNode);
    const studyNode = useStore(s => s.studyNode);
    const currentProjectId = useStore(s => s.currentProjectId);
    // Only used to disambiguate a thin topic title in the video search.
    const projectName = useStore(s => s.projects.find(p => p.id === s.currentProjectId)?.name ?? null);
    const isMobile = useIsMobile();
    const pointerVerb = usePointerVerb();

    const [activeTab, setActiveTab] = useState<Tab>('details');
    // The tutor tab, once opened, STAYS mounted and hides behind `hidden` — the
    // same pattern Settings uses for its groups. Unmounting it on every tab
    // switch threw away the whole conversation view and reloaded history, so
    // coming back dumped the learner at the top of a long answer they were
    // halfway through. Lazily mounted (not mounted upfront) so merely selecting
    // a node doesn't fire a chat-history load, an AI status probe and a doc
    // count for a panel nobody opened; reset per node, since the chat is
    // per-node and AIPanel remounts on its key anyway.
    const [tutorMounted, setTutorMounted] = useState(false);
    useEffect(() => {
        if (activeTab === 'ai') setTutorMounted(true);
    }, [activeTab]);
    useEffect(() => {
        setTutorMounted(activeTab === 'ai');
    }, [selectedNodeId]);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [notes, setNotes] = useState('');
    const [status, setStatus] = useState<'not_started' | 'in_progress' | 'completed' | 'skipped'>('not_started');
    const [isNote, setIsNote] = useState(false);
    // The title is edited in the header, in place — click it and it becomes an
    // input. There is no separate Title field (and so no Save button): the panel
    // showed the same string twice, once as the header and once as a form field.
    const [editingTitle, setEditingTitle] = useState(false);
    const [weight, setWeight] = useState('');

    // Counts for tabs
    const [quizCount, setQuizCount] = useState(0);
    const [flashcardCount, setFlashcardCount] = useState(0);

    const node = selectedNodeId ? findNode(tree, selectedNodeId) : null;

    useEffect(() => {
        if (node) {
            setTitle(node.title);
            setDescription(node.description);
            setNotes(node.notes || '');
            setStatus(node.status);
            setIsNote(!!node.is_note);
            setEditingTitle(false);
        }
    }, [node?.id, node?.notes]);

    // Sync status changes from Categories to Details panel
    useEffect(() => {
        if (node) {
            setStatus(node.status);
        }
    }, [node?.status]);

    // Sync weight from node data
    useEffect(() => {
        if (node) {
            setWeight(
                node.estimated_weight !== null && node.estimated_weight !== undefined
                    ? String(node.estimated_weight)
                    : ''
            );
        }
    }, [node?.id, node?.estimated_weight]);

    // Fetch counts for tabs
    useEffect(() => {
        if (selectedNodeId) {
            loadCounts();
        } else {
            setQuizCount(0);
            setFlashcardCount(0);
        }
    }, [selectedNodeId]);

    const loadCounts = async () => {
        if (!selectedNodeId) return;
        try {
            const [quizzes, flashcards] = await Promise.all([
                api.getQuizzes(selectedNodeId),
                api.getFlashcards(selectedNodeId)
            ]);
            setQuizCount(quizzes.length);
            setFlashcardCount(flashcards.length);
        } catch (error) {
            console.error('Failed to load counts:', error);
        }
    };

    // Autosaves like every other field on this panel: Enter or blur commits,
    // Escape reverts. An empty title is a slip, not an intent — revert it.
    const commitTitle = async () => {
        setEditingTitle(false);
        const next = title.trim();
        if (!selectedNodeId || !node || !next || next === node.title) {
            setTitle(node?.title ?? '');
            return;
        }
        setTitle(next);
        await updateNode(selectedNodeId, { title: next });
    };

    const cancelTitleEdit = () => {
        setTitle(node?.title ?? '');
        setEditingTitle(false);
    };

    // Overview (description) — the public curriculum blurb; autosaves via its
    // own markdown editor, same contract as My notes below.
    const handleDescriptionSave = async (value: string) => {
        if (!selectedNodeId) return;
        setDescription(value);
        await updateNode(selectedNodeId, { description: value });
    };

    // My notes (private) — saved independently by MarkdownNotes on save.
    const handleNotesChange = (value: string) => {
        setNotes(value);
    };

    const handleNotesSave = async (value: string) => {
        if (!selectedNodeId) return;
        setNotes(value);
        await updateNode(selectedNodeId, { notes: value });
    };

    const handleStatusChange = async (newStatus: typeof status) => {
        if (!selectedNodeId || !node) return;

        // 1. Optimistic UI update
        setStatus(newStatus);

        // 2. Await the store action
        const success = await updateNode(selectedNodeId, { status: newStatus });

        // 3. If the backend rejected it (and store swallowed it to open the modal),
        // revert the local UI state so it doesn't falsely show as "Completed".
        if (!success) {
            setStatus(node.status);
        }
    };

    const handleIsNoteChange = async (checked: boolean) => {
        if (!selectedNodeId) return;
        setIsNote(checked);
        await updateNode(selectedNodeId, { is_note: checked ? 1 : 0 });
    };

    const handleWeightSave = async () => {
        if (!selectedNodeId) return;
        const newWeight = weight.trim() === '' ? null : parseFloat(weight);
        if (newWeight !== null && (isNaN(newWeight) || newWeight < 0)) {
            setWeight(node?.estimated_weight !== null && node?.estimated_weight !== undefined ? String(node?.estimated_weight) : '');
            return;
        }
        await updateNode(selectedNodeId, { estimated_weight: newWeight });
    };

    // Callback to update counts when StudyTools changes data
    const handleCountsChange = (quizzes: number, flashcards: number) => {
        setQuizCount(quizzes);
        setFlashcardCount(flashcards);
    };

    // Schedule-derived values
    const today = todayStr();
    const effectiveNodeStatus = node
        ? (node.effectiveStatus || node.status)
        : 'not_started';
    const isClosed = effectiveNodeStatus === 'completed' || effectiveNodeStatus === 'skipped';
    const isOverdue = node
        ? !!node.scheduled_end &&
        node.scheduled_end < today &&
        !isClosed
        : false;
    const isActive = node
        ? !!node.scheduled_start &&
        !!node.scheduled_end &&
        node.scheduled_start <= today &&
        node.scheduled_end >= today &&
        !isClosed
        : false;
    const hasSchedule = !!(node?.scheduled_start && node?.scheduled_end);

    if (!node) {
        return (
            <div className="flex items-center justify-center h-full text-slate-500 dark:text-slate-400">
                {t("Select an item to view details")}
            </div>
        );
    }

    // Leafness ignores note children: they're the topic's material, not
    // sub-work. A topic with only notes under it is still something you prove,
    // so it gets the status buttons rather than a rolled-up progress badge.
    const isLeaf = isLeafNode(node);
    const hasChildren = structuralChildren(node).length > 0;

    return (
        <div className="h-full flex flex-col overflow-hidden">
            {/* Header — the node's ONE title. Ancestor trail (desktop only; a
                phone hasn't the width for it) then the title itself, editable in
                place. Both platforms get the same header so renaming works on
                either, and the title is never rendered twice. */}
            <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
                {/* The trail on its own line, and gone entirely while renaming.
                    Sharing the title's row left the field about forty pixels
                    wide on a 380px panel — you could not read what you were
                    typing, which is most of why renaming here felt broken.
                    Editing is a mode; nothing else in this header is needed
                    during it. */}
                {!isMobile && !editingTitle && <Breadcrumbs />}
                <div className="flex items-center gap-1">
                {editingTitle ? (
                    <input
                        value={title}
                        autoFocus
                        onChange={e => setTitle(e.target.value)}
                        onBlur={commitTitle}
                        onKeyDown={e => {
                            if (e.key === 'Enter') { e.preventDefault(); commitTitle(); }
                            else if (e.key === 'Escape') { e.preventDefault(); cancelTitleEdit(); }
                        }}
                        aria-label={t("Topic title")}
                        className="flex-1 min-w-0 px-2 py-1 text-sm font-medium rounded border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                ) : (
                    <button
                        onClick={() => setEditingTitle(true)}
                        title={t("{{title}} — {{pointerVerb}} to rename", { title: node.title, pointerVerb })}
                        /* `basis-40` is a FLOOR, not a width: flexbox shrinks
                           items in proportion to their content, so without one
                           the longest string in the row wins and the title —
                           which is what the panel is about — loses. */
                        className="group flex-1 basis-40 min-w-0 flex items-center gap-1.5 text-left px-2 py-1 rounded text-sm font-medium text-slate-900 dark:text-white hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                    >
                        <span className="min-w-0 truncate">{node.title}</span>
                        {/* Renaming was discoverable only by clicking text that
                            does not look clickable. Shown outright on touch,
                            which has no hover to reveal it with. */}
                        <PenLine
                            className="w-3.5 h-3.5 shrink-0 text-slate-400 opacity-0 transition-opacity can-hover:group-hover:opacity-100 group-focus-visible:opacity-100 touch:opacity-60"
                            aria-hidden="true"
                        />
                    </button>
                )}
                {/* Study this topic (or this section's topics) as a feed of
                    lessons, questions and cards — the same stream as the home
                    page, pointed at one thing, without waiting for the schedule
                    to bring it round. */}
                {!editingTitle && !node.is_note && currentProjectId != null && (
                    <button
                        onClick={() => studyNode(currentProjectId, node.id)}
                        className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 min-h-9 touch:min-h-11 rounded-lg text-sm font-medium bg-accent text-white hover:brightness-95 transition"
                        title={isLeaf ? t("Study this topic now") : t("Study the topics in this section now")}
                    >
                        <Play className="w-3.5 h-3.5" />
                        {/* The word is never collapsed to the glyph. On a
                            phone this is the only way into a topic's lesson,
                            and a bare triangle between a magnifier and an X
                            is not an instruction. It costs 38px, which the
                            row has — Close beside it carries its own word at
                            the same width. */}
                        <span>{t("Study")}</span>
                    </button>
                )}
                {/* Video explanations of this exact topic, one tap away — the
                    search people were doing by hand. */}
                {!editingTitle && <ExternalSearchButton title={node.title} context={projectName} variant="icon" />}
                <button
                    onClick={() => selectNode(null)}
                    aria-label={t("Close detail panel")}
                    title={t("Close detail panel")}
                    className="shrink-0 flex items-center gap-1.5 p-1.5 rounded-lg text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                >
                    <X className={isMobile ? 'w-5 h-5' : 'w-4 h-4'} />
                    {isMobile && <span className="text-sm font-medium">{t("Close")}</span>}
                </button>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-slate-200 dark:border-slate-700 flex-shrink-0 overflow-x-auto">
                <button
                    onClick={() => setActiveTab('details')}
                    className={`flex items-center gap-2 shrink-0 px-4 py-2.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${activeTab === 'details'
                        ? 'border-accent text-accent-fg'
                        : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                        }`}
                >
                    <Layers className="w-4 h-4" />
                    {t("Details")}
                </button>
                <button
                    onClick={() => setActiveTab('ai')}
                    className={`flex items-center gap-2 shrink-0 px-4 py-2.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${activeTab === 'ai'
                        ? 'border-accent text-accent-fg'
                        : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                        }`}
                >
                    <Bot className="w-4 h-4" />
                    {t("AI Tutor")}
                </button>
                <button
                    onClick={() => setActiveTab('quizzes')}
                    className={`flex items-center gap-2 shrink-0 px-4 py-2.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${activeTab === 'quizzes'
                        ? 'border-accent text-accent-fg'
                        : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                        }`}
                >
                    <Brain className="w-4 h-4" />
                    {t("Quizzes ({{quizCount}})", { quizCount })}
                </button>
                <button
                    onClick={() => setActiveTab('flashcards')}
                    className={`flex items-center gap-2 shrink-0 px-4 py-2.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${activeTab === 'flashcards'
                        ? 'border-accent text-accent-fg'
                        : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                        }`}
                >
                    <BookOpen className="w-4 h-4" />
                    {t("Flashcards ({{flashcardCount}})", { flashcardCount })}
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {activeTab === 'details' && (
                    <div className="flex-1 overflow-auto p-4 space-y-5">
                        {/* No Title field here — the header IS the title, editable
                            in place. Space on this panel is scarce; the same string
                            twice was the most expensive thing on it. */}

                        {/* Overview (topics) / Material (notes) — the shared curriculum
                            text. Same markdown editor as My notes; this is what the
                            feed teaches and what ships on export. */}
                        <div>
                            <MarkdownNotes
                                key={`overview-${selectedNodeId}`}
                                value={description}
                                onChange={setDescription}
                                onSave={handleDescriptionSave}
                                label={isNote ? t("Material") : t("Overview")}
                                icon={isNote ? FileText : BookOpen}
                                badge="public"
                                nodeId={selectedNodeId ?? undefined}
                                surface={isNote ? 'material' : 'overview'}
                                placeholder={isNote
                                    ? t("Add the reading / material for this topic…")
                                    : t("Add an overview — what this covers and why…")}
                            />
                        </div>

                        {/* Status & Is Note */}
                        <div className="flex items-center gap-4 flex-wrap">
                            {isLeaf && !isNote && (
                                <div className="flex items-center gap-2">
                                    <span className="text-sm text-slate-600 dark:text-slate-400">{t("Status:")}</span>
                                    <div className="flex gap-1">
                                        {[
                                            { value: 'not_started', icon: Circle, color: 'text-slate-400', title: t("Not started") },
                                            { value: 'in_progress', icon: Clock, color: 'text-blue-500', title: t("In progress") },
                                            { value: 'completed', icon: CheckCircle, color: 'text-green-500', title: t("Completed (verified)") },
                                            { value: 'skipped', icon: MinusCircle, color: 'text-slate-500 dark:text-slate-400', title: t("Skipped — moved on without proving it") }
                                        ].map(({ value, icon: Icon, color, title }) => (
                                            <button
                                                key={value}
                                                title={title}
                                                onClick={() => handleStatusChange(value as typeof status)}
                                                className={`p-1.5 rounded-lg transition ${status === value
                                                    ? 'bg-slate-100 dark:bg-slate-700'
                                                    : 'hover:bg-slate-50 dark:hover:bg-slate-800'
                                                    }`}
                                            >
                                                <Icon className={`w-5 h-5 ${color}`} />
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {hasChildren && !isNote && (
                                <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                                    <span>{t("Progress:")}</span>
                                    <StatusBadge status={node.effectiveStatus || (node.progress?.percentage === 100 ? 'completed' : node.progress?.percentage ? 'in_progress' : 'not_started')} showLabel />
                                    <span>{node.progress?.percentage || 0}%</span>
                                </div>
                            )}

                            <label className="flex items-center gap-2 text-sm">
                                <Checkbox checked={isNote} onChange={handleIsNoteChange} />
                                <span className="flex items-center gap-1 text-slate-600 dark:text-slate-400">
                                    <FileText className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                                    {t("Reference material (doesn't affect progress)")}
                                </span>
                            </label>
                        </div>

                        {/* Schedule Info Card */}
                        {hasSchedule && (
                            <div className={`rounded-lg border p-3 ${isOverdue
                                ? 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800/40'
                                : isActive
                                    ? 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800/40'
                                    : 'bg-slate-50 dark:bg-slate-900/40 border-slate-200/60 dark:border-slate-700/60'
                                }`}>
                                <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-sm">
                                    <div className="flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap">
                                        <Calendar className={`w-4 h-4 ${isOverdue ? 'text-red-500' : isActive ? 'text-emerald-500' : 'text-accent-fg'}`} />
                                        <span>{t("Schedule")}</span>
                                    </div>

                                    <div className="flex items-center gap-1.5 text-slate-600 dark:text-slate-400 whitespace-nowrap">
                                        <Clock className="w-3.5 h-3.5 shrink-0" />
                                        <span>{formatDateShort(node.scheduled_start!)} &mdash; {formatDateShort(node.scheduled_end!)}</span>
                                    </div>

                                    {isActive && !isOverdue && (
                                        <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300 whitespace-nowrap">
                                            <Play className="w-3.5 h-3.5 shrink-0" />
                                            <span className="font-medium">{t("Active")}</span>
                                        </div>
                                    )}

                                    {isOverdue && (
                                        <div className="flex items-center gap-1.5 text-red-700 dark:text-red-300 whitespace-nowrap">
                                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                            <span className="font-medium">{t("Overdue")}</span>
                                        </div>
                                    )}

                                    <div className="flex items-center gap-1.5 text-slate-600 dark:text-slate-400 whitespace-nowrap">
                                        <Scale className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                        <span>{t("Weight:")}</span>
                                        <input
                                            type="number"
                                            min="0.1"
                                            step="0.1"
                                            value={weight}
                                            onChange={e => setWeight(e.target.value)}
                                            onBlur={handleWeightSave}
                                            onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
                                            className="w-16 px-2 py-0.5 text-sm border border-slate-200 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:ring-1 focus:ring-accent"
                                            placeholder="1.0"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* My notes — the learner's private markdown annotations.
                            Hidden on note-nodes: a note IS material, so its own
                            private sub-notes were dead weight. */}
                        {!isNote && (
                            <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
                                <MarkdownNotes
                                    key={selectedNodeId}
                                    value={notes}
                                    onChange={handleNotesChange}
                                    onSave={handleNotesSave}
                                    label={t("My notes")}
                                    icon={PenLine}
                                    badge="private"
                                    nodeId={selectedNodeId ?? undefined}
                                    surface="notes"
                                    placeholder={t("Your private notes — thoughts, questions, reminders…")}
                                />
                            </div>
                        )}

                        {/* Resources */}
                        <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
                            <ResourceList key={selectedNodeId} nodeId={selectedNodeId!} />
                        </div>
                    </div>
                )}

                {/* Swap the classes rather than appending `hidden` to a `flex`
                    box: both set `display`, so which wins would come down to
                    Tailwind's emit order. Same shape Settings uses for its
                    kept-mounted groups. */}
                {tutorMounted && (
                    <div className={activeTab === 'ai' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
                        <AIPanel key={selectedNodeId} active={activeTab === 'ai'} />
                    </div>
                )}

                {activeTab === 'quizzes' && (
                    <div className="flex-1 overflow-auto">
                        <StudyTools key={selectedNodeId} nodeId={selectedNodeId!} mode="quiz" onCountsChange={handleCountsChange} />
                    </div>
                )}

                {activeTab === 'flashcards' && (
                    <div className="flex-1 overflow-auto">
                        <StudyTools key={selectedNodeId} nodeId={selectedNodeId!} mode="flashcards" onCountsChange={handleCountsChange} />
                    </div>
                )}
            </div>
        </div>
    );
}