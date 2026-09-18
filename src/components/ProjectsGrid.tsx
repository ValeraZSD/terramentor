// src/components/ProjectsGrid.tsx
// Main project grid with drag-and-drop reordering, project creation (manual + AI),
// import/export, and the full AI creation pipeline with incremental live tree rendering.
import {
    useState,
    useEffect,
    useRef,
    useCallback,
    useMemo,
    createContext,
    useContext,
} from 'react';
import {
    DndContext,
    DragEndEvent,
    DragStartEvent,
    DragOverlay,
    closestCorners,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
    useDroppable,
    MeasuringStrategy,
} from '@dnd-kit/core';
import {
    SortableContext,
    rectSortingStrategy,
} from '@dnd-kit/sortable';
import { useStore } from '../store';
import ProjectCard from './ProjectCard';
import Modal from './Modal';
import {
    Plus,
    Sparkles,
    Loader2,
    CheckCircle2,
    FolderTree,
    FileText,
    Link,
    AlertCircle,
    Bot,
    Upload,
    Minimize2,
    X,
    ChevronDown,
    ChevronRight,
} from 'lucide-react';
import { Project } from '../types';
import { api } from '../api';
import { onActivateKey } from '../utils/a11y';
import { usePointerVerb } from '../utils/platform';
import { scrollIntoViewWithin } from '../utils/scrollWithin';
import { useStickToBottom } from '../hooks/useStickToBottom';
import ProjectFormFields from './ProjectFormFields';
import { OutlineBriefPanel } from './ExternalAuthoring';
import VaultPanel from './VaultPanel';
import { useTranslation } from 'react-i18next';
import i18n, { k } from '../i18n';

// INCREMENTAL LIVE NODE TREE
interface LiveNode {
    key: string;
    title: string;
    description: string;
    depth: number;
    status: 'pending' | 'generating' | 'created' | 'cancelled' | 'error';
    resourceCount: number;
    children: LiveNode[];
}

function addCategories(
    tree: LiveNode[],
    categories: Array<{ index?: number; title: string; description?: string }>
): LiveNode[] {
    return [
        ...tree,
        ...categories.map((c, i) => ({
            key: `cat-${c.index ?? i}`,
            title: c.title,
            description: c.description || '',
            depth: 0,
            status: 'pending' as const,
            resourceCount: 0,
            children: [],
        })),
    ];
}

function addElements(
    tree: LiveNode[],
    categoryIndex: number,
    elements: Array<{ index?: number; title: string; description?: string }>
): LiveNode[] {
    return tree.map((node, i) => {
        if (i !== categoryIndex) return node;
        return {
            ...node,
            status: 'generating' as const,
            children: [
                ...node.children,
                ...elements.map((e, ei) => ({
                    key: `${node.key}-el-${e.index ?? ei}`,
                    title: e.title,
                    description: e.description || '',
                    depth: 1,
                    status: 'pending' as const,
                    resourceCount: 0,
                    children: [],
                })),
            ],
        };
    });
}

function addSubElements(
    tree: LiveNode[],
    categoryIndex: number,
    elementIndex: number,
    subElements: Array<{ index?: number; title: string; description?: string }>
): LiveNode[] {
    return tree.map((catNode, ci) => {
        if (ci !== categoryIndex) return catNode;
        return {
            ...catNode,
            children: catNode.children.map((elNode, ei) => {
                if (ei !== elementIndex) return elNode;
                return {
                    ...elNode,
                    status: 'generating' as const,
                    children: [
                        ...elNode.children,
                        ...subElements.map((se, sei) => ({
                            key: `${elNode.key}-se-${se.index ?? sei}`,
                            title: se.title,
                            description: se.description || '',
                            depth: 2,
                            status: 'pending' as const,
                            resourceCount: 0,
                            children: [],
                        })),
                    ],
                };
            }),
        };
    });
}

function allCreated(nodes: LiveNode[]): boolean {
    return nodes.length > 0 && nodes.every(n => n.status === 'created');
}

/**
 * A detail is done once its resource pass has run — whether or not the search
 * found anything, because the node itself was written to the database before
 * that search started. Parents roll up from it: a topic is created once every
 * one of its details is, a phase once every one of its topics is.
 *
 * Addressed by index, not by title: the server sends the coordinates it
 * generated from, and two topics in different phases are free to share a name.
 */
function markSubElementDone(
    tree: LiveNode[],
    categoryIndex: number,
    elementIndex: number,
    subElementIndex: number,
    resourceCount: number
): LiveNode[] {
    return tree.map((catNode, ci) => {
        if (ci !== categoryIndex) return catNode;
        const elements = catNode.children.map((elNode, ei) => {
            if (ei !== elementIndex) return elNode;
            const subElements = elNode.children.map((seNode, sei) => {
                if (sei !== subElementIndex) return seNode;
                return {
                    ...seNode,
                    status: 'created' as const,
                    resourceCount: seNode.resourceCount + resourceCount,
                };
            });
            return {
                ...elNode,
                status: allCreated(subElements) ? ('created' as const) : elNode.status,
                resourceCount: elNode.resourceCount + resourceCount,
                children: subElements,
            };
        });
        return {
            ...catNode,
            status: allCreated(elements) ? ('created' as const) : catNode.status,
            resourceCount: catNode.resourceCount + resourceCount,
            children: elements,
        };
    });
}

/**
 * The server only emits `complete` once every node is in the database, so
 * anything still reading as pending or generating at that point is an event the
 * client failed to match, never unfinished work — settle the tree so the final
 * counters state what was actually created. Cancelled/errored nodes keep their
 * status; those are outcomes, not gaps.
 */
function markAllCreated(tree: LiveNode[]): LiveNode[] {
    return tree.map(node => ({
        ...node,
        status:
            node.status === 'cancelled' || node.status === 'error'
                ? node.status
                : ('created' as const),
        children: markAllCreated(node.children),
    }));
}

function markCategoryGenerating(tree: LiveNode[], categoryIndex: number): LiveNode[] {
    return tree.map((node, i) => {
        if (i !== categoryIndex) return node;
        return { ...node, status: 'generating' as const };
    });
}

function markElementGenerating(
    tree: LiveNode[],
    categoryIndex: number,
    elementIndex: number
): LiveNode[] {
    return tree.map((catNode, ci) => {
        if (ci !== categoryIndex) return catNode;
        return {
            ...catNode,
            children: catNode.children.map((elNode, ei) => {
                if (ei !== elementIndex) return elNode;
                return { ...elNode, status: 'generating' as const };
            }),
        };
    });
}

function markAllRemainingCancelled(tree: LiveNode[]): LiveNode[] {
    return tree.map(node => ({
        ...node,
        status: node.status === 'created' ? 'created' : 'cancelled',
        children: markAllRemainingCancelled(node.children),
    }));
}

function countNodes(tree: LiveNode[]): { created: number; total: number } {
    let created = 0, total = 0;
    const walk = (nodes: LiveNode[]) => {
        for (const n of nodes) {
            total++;
            if (n.status === 'created') created++;
            walk(n.children);
        }
    };
    walk(tree);
    return { created, total };
}

function findGeneratingNode(tree: LiveNode[]): LiveNode | null {
    for (const node of tree) {
        if (node.status === 'generating') return node;
        const child = findGeneratingNode(node.children);
        if (child) return child;
    }
    return null;
}

function isCategoryComplete(cat: LiveNode): boolean {
    if (cat.status !== 'created') return false;
    return cat.children.every(c => c.status === 'created');
}

function isCategoryActive(cat: LiveNode): boolean {
    if (cat.status === 'generating') return true;
    return cat.children.some(c => c.status === 'generating' || isCategoryActive(c));
}

// -------------------------
// LOCAL STORAGE PERSISTENCE
// -------------------------

const LS_KEY = 'ai-creation-progress';

export interface AICreationState {
    projectId: number;
    projectName: string;
    isNew: boolean;
    aiProgress: any | null;
    liveTree: LiveNode[];
    aiEventLog: any[];
    aiModel: string;
    aiSummary: string;
    aiElapsedMs: number;
    aiError: string | null;
    wasCancelled: boolean;
}

export function saveAICreationState(state: AICreationState) {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch { }
}

export function loadAICreationState(): AICreationState | null {
    try {
        const raw = localStorage.getItem(LS_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function clearAICreationState() {
    try {
        localStorage.removeItem(LS_KEY);
    } catch { }
}

// -------------------
// AI CREATION CONTEXT
// -------------------

interface AICreationContextValue {
    generatingProjectId: number | null;
    isProjectGenerating: (projectId: number) => boolean;
    openGenerationModal: () => void;
}

export const AICreationContext = createContext<AICreationContextValue>({
    generatingProjectId: null,
    isProjectGenerating: () => false,
    openGenerationModal: () => { },
});

export function useAICreationContext() {
    return useContext(AICreationContext);
}

// -------
// HELPERS
// -------

function stripMarkdown(text: string): string {
    if (!text) return '';
    return text
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/__(.*?)__/g, '$1')
        .replace(/_(.*?)_/g, '$1')
        .replace(/`(.*?)`/g, '$1')
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .replace(/#{1,6}\s?/g, '')
        .replace(/^[-*+]\s/gm, '')
        .replace(/^\d+\.\s/gm, '')
        .replace(/^>\s/gm, '')
        .replace(/---/g, '')
        .trim();
}

/** Format elapsed milliseconds into a human-readable string */
function formatElapsed(ms: number): string {
    if (ms < 1000) return '';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
}

// -----------------
// AI CREATION STEPS
// -----------------

const AI_CREATION_STEPS = [
    { key: 'thinking', label: k("Thinking"), icon: Bot, description: k("Analyzing project scope") },
    { key: 'project', label: k("Project"), icon: FolderTree, description: k("Creating project shell") },
    { key: 'summary', label: k("Summary"), icon: FileText, description: k("Writing project summary") },
    { key: 'categories', label: k("Phases"), icon: FolderTree, description: k("Generating learning phases") },
    { key: 'elements', label: k("Topics"), icon: FileText, description: k("Creating sub-topics") },
    { key: 'sub_elements', label: k("Details"), icon: Sparkles, description: k("Adding detailed topics") },
    { key: 'resources', label: k("Resources"), icon: Link, description: k("Finding educational resources") },
    { key: 'complete', label: k("Complete"), icon: CheckCircle2, description: k("Project ready!") },
];

// ACTIVE TASK BANNER
interface ActiveTaskBannerProps {
    aiProgress: any | null;
    isAICreating: boolean;
    liveNodeCounts: { created: number; total: number };
    totalResources: number;
    aiElapsedMs: number;
    currentPhaseLabel: string;
}

function ActiveTaskBanner({
    aiProgress,
    isAICreating,
    liveNodeCounts,
    totalResources,
    aiElapsedMs,
    currentPhaseLabel,
}: ActiveTaskBannerProps) {
    const { t } = useTranslation();
    const phase = aiProgress?.phase;
    const isComplete = phase === 'complete';
    const isCancelled = phase === 'cancelled';
    const isError = phase === 'error';

    const primaryMessage = isComplete
        ? 'Project fully created!'
        : isCancelled
            ? 'Creation cancelled — partial content saved'
            : isError
                ? 'An error occurred'
                : aiProgress?.message || 'Initializing...';

    const secondaryMessage = isComplete
        ? `${t("{{count}} cards", { count: liveNodeCounts.total })} • ${t("{{count}} links resolved", { count: totalResources })}`
        : isCancelled
            ? t("{{created}}/{{total}} cards created", { created: liveNodeCounts.created, total: liveNodeCounts.total })
            : isError
                ? aiProgress?.error || ''
                : currentPhaseLabel;

    if (!aiProgress && !isAICreating) return null;

    const bannerBg = isComplete
        ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800'
        : isCancelled
            ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
            : isError
                ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
                : 'bg-accent/10 border-accent/30 dark:border-accent/40';

    const textColor = isComplete
        ? 'text-emerald-900 dark:text-emerald-100'
        : isCancelled
            ? 'text-amber-900 dark:text-amber-100'
            : isError
                ? 'text-red-900 dark:text-red-100'
                : 'text-accent-fg';

    const subTextColor = isComplete
        ? 'text-emerald-600 dark:text-emerald-400'
        : isCancelled
            ? 'text-amber-600 dark:text-amber-400'
            : isError
                ? 'text-red-600 dark:text-red-400'
                : 'text-accent-fg';

    return (
        <div className={`p-4 ${bannerBg} border rounded-xl flex items-center justify-between shadow-sm`}>
            <div className="flex items-center gap-3 min-w-0">
                {isComplete ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                ) : isCancelled ? (
                    <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
                ) : isError ? (
                    <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                ) : (
                    <Loader2 className="w-5 h-5 text-accent-fg animate-spin shrink-0" />
                )}
                <div className="min-w-0">
                    <p className={`font-semibold ${textColor} truncate`}>
                        {primaryMessage}
                    </p>
                    {secondaryMessage && (
                        <p className={`text-xs ${subTextColor} truncate`}>
                            {secondaryMessage}
                        </p>
                    )}
                </div>
            </div>

            {liveNodeCounts.total > 0 && (
                <div className="text-right shrink-0 pl-4">
                    <p className={`text-lg font-bold ${textColor} tabular-nums`}>
                        {liveNodeCounts.created} / {liveNodeCounts.total}
                    </p>
                    <p className={`text-xs ${subTextColor}`}>
                        {totalResources > 0 ? t("{{totalResources}} links •", { totalResources }) : ''}
                        {formatElapsed(aiElapsedMs) || t("starting...")}
                    </p>
                </div>
            )}
        </div>
    );
}

// AIStepProgress COMPONENT
interface AIStepProgressProps {
    aiProgress: any | null;
    isAICreating: boolean;
    liveNodeCounts: { created: number; total: number };
    totalResources: number;
}

function AIStepProgress({
    aiProgress,
    isAICreating,
    liveNodeCounts,
    totalResources,
}: AIStepProgressProps) {
    const { t } = useTranslation();
    const phase = aiProgress?.phase || 'creating';

    const getActiveStepIndex = (): number => {
        switch (phase) {
            case 'thinking': return 0;
            case 'init': return 1;
            case 'summary': return 2;
            case 'generating_categories':
            case 'categories_generated': return 3;
            case 'generating_elements':
            case 'elements_generated': return 4;
            case 'generating_sub_elements':
            case 'sub_elements_generated': return 5;
            case 'finding_resources':
            case 'resources_saved': return 6;
            case 'complete': return 7;
            case 'error':
            case 'cancelled': return -1;
            default: return 0;
        }
    };

    const activeStepIndex = getActiveStepIndex();
    const isError = phase === 'error';
    const isCancelled = phase === 'cancelled';
    const isComplete = phase === 'complete';

    const microProgress = useMemo(() => {
        if (liveNodeCounts.total === 0) return 0;
        if (phase === 'finding_resources' || phase === 'resources_saved') {
            return Math.min(95, totalResources > 0 ? 50 : 10);
        }
        return Math.round((liveNodeCounts.created / liveNodeCounts.total) * 100);
    }, [phase, liveNodeCounts, totalResources]);

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-1">
                {AI_CREATION_STEPS.map((step, index) => {
                    const Icon = step.icon;
                    const isActive = index === activeStepIndex;
                    const isCompleted = index < activeStepIndex;

                    return (
                        <div key={step.key} className="flex-1 flex items-center">
                            <div className="flex flex-col items-center flex-1 min-w-0">
                                <div
                                    className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-all duration-300 ${isCompleted || (isComplete && index === activeStepIndex)
                                        ? 'bg-emerald-700 text-white'
                                        : isActive && isAICreating
                                            ? 'bg-accent text-white animate-pulse'
                                            : isActive && (isError || isCancelled)
                                                ? isError
                                                    ? 'bg-red-600 text-white'
                                                    : 'bg-amber-600 text-white'
                                                : 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400'
                                        }`}
                                >
                                    {isCompleted || (isComplete && index === activeStepIndex) ? (
                                        <CheckCircle2 className="w-4 h-4" />
                                    ) : (
                                        <Icon className="w-4 h-4" />
                                    )}
                                </div>
                                <p
                                    className={`text-xs mt-1 font-medium text-center truncate ${isCompleted || (isComplete && index === activeStepIndex)
                                        ? 'text-emerald-600 dark:text-emerald-400'
                                        : isActive
                                            ? 'text-accent-fg'
                                            : 'text-slate-500 dark:text-slate-400'
                                        }`}
                                >
                                    {t(step.label)}
                                </p>
                                {isActive && isAICreating && (
                                    <div className="w-full h-0.5 mt-1 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-accent transition-all duration-500 rounded-full"
                                            style={{ width: `${microProgress}%` }}
                                        />
                                    </div>
                                )}
                            </div>
                            {index < AI_CREATION_STEPS.length - 1 && (
                                <div
                                    className={`h-0.5 flex-1 mx-1 mb-5 transition-colors duration-300 ${index < activeStepIndex || (isComplete && index === activeStepIndex)
                                        ? 'bg-emerald-500'
                                        : 'bg-slate-200 dark:bg-slate-700'
                                        }`}
                                />
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ------------------------------------------------------
// LiveStructureTree COMPONENT
// - Auto-scroll to active node
// - Highlighted active node (purple left-border + pulse)
// - Auto-collapse completed categories
// - Resource status dots
// ------------------------------------------------------

function LiveStructureTree({ tree, activeNodeKey }: { tree: LiveNode[]; activeNodeKey: string | null }) {
    const { t } = useTranslation();
    const activeNodeRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const pointerVerb = usePointerVerb();

    // The tree follows the node being written — inside its own box. It used to
    // call `scrollIntoView`, which also scrolls the dialog and, on a phone, the
    // page: every few seconds, for the length of a creation run, while the
    // learner is reading the activity log underneath it.
    useEffect(() => {
        scrollIntoViewWithin(activeNodeRef.current, {
            boundary: listRef.current, block: 'center', behavior: 'smooth',
        });
    }, [activeNodeKey]);

    const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());

    // Auto-collapse completed categories when tree changes
    useEffect(() => {
        // Folding a finished phase away only helps while another one is still
        // being built. With nothing generating the run is over, and collapsing
        // then would hide the whole structure at the moment it's ready to read.
        if (!tree.some(isCategoryActive)) return;
        setCollapsedKeys(prev => {
            const next = new Set(prev);
            for (const cat of tree) {
                if (isCategoryComplete(cat) && !isCategoryActive(cat)) {
                    // Auto-collapse completed categories
                    if (!next.has(cat.key)) {
                        next.add(cat.key);
                    }
                }
            }
            return next;
        });
    }, [tree]);

    const toggleCollapse = useCallback((key: string) => {
        setCollapsedKeys(prev => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    }, []);

    if (tree.length === 0) return null;

    const resourceDot = (status: LiveNode['status'], resources: number) => {
        let dotColor: string;
        let tooltip: string;

        if (status === 'created' && resources > 0) {
            dotColor = 'bg-emerald-400';
            tooltip = i18n.t("{{count}} links found", { count: resources });
        } else if (status === 'generating') {
            dotColor = 'bg-amber-400 animate-pulse';
            tooltip = i18n.t("Searching…");
        } else if (status === 'created') {
            dotColor = 'bg-emerald-300';
            tooltip = i18n.t("Created");
        } else if (status === 'cancelled') {
            dotColor = 'bg-amber-400';
            tooltip = i18n.t("Cancelled");
        } else if (status === 'error') {
            dotColor = 'bg-red-400';
            tooltip = i18n.t("Error");
        } else {
            dotColor = 'bg-slate-300 dark:bg-slate-600';
            tooltip = i18n.t("Pending");
        }

        return (
            <span
                className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotColor}`}
                title={tooltip}
            />
        );
    };

    const renderNode = (node: LiveNode, isLast: boolean, isTopLevel: boolean): JSX.Element => {
        const isActive = node.key === activeNodeKey;
        const isCollapsed = collapsedKeys.has(node.key);
        const hasChildren = node.children.length > 0;
        const canCollapse = isTopLevel && hasChildren;

        return (
            <div key={node.key}>
                <div
                    ref={isActive ? activeNodeRef : undefined}
                    className={`flex items-center gap-2 py-1.5 px-2 rounded-r-lg transition-all duration-200 ${isActive
                        ? 'bg-accent/20 border-l-4 border-accent animate-pulse'
                        : ''
                        }`}
                    style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
                >
                    {/* Tree connector lines */}
                    {node.depth > 0 && (
                        <span className="text-slate-500 dark:text-slate-400 text-xs font-mono">
                            {isLast ? '└' : '├'}
                        </span>
                    )}

                    {/* Collapse/expand button for top-level nodes */}
                    {canCollapse && (
                        <button
                            onClick={() => toggleCollapse(node.key)}
                            className="shrink-0 p-0.5 hover:bg-slate-200 dark:hover:bg-slate-600 rounded transition-colors"
                            title={isCollapsed ? t("Expand") : t("Collapse")}
                        >
                            {isCollapsed ? (
                                <ChevronRight className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                            ) : (
                                <ChevronDown className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                            )}
                        </button>
                    )}

                    {/* Status icon */}
                    {node.status === 'generating' ? (
                        <Loader2 className="w-4 h-4 text-accent-fg animate-spin shrink-0" />
                    ) : node.status === 'created' ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                    ) : node.status === 'cancelled' ? (
                        <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                    ) : node.status === 'error' ? (
                        <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                    ) : (
                        resourceDot('pending', 0)
                    )}

                    {/* Folder or file icon */}
                    {hasChildren ? (
                        <FolderTree
                            className={`w-4 h-4 shrink-0 ${node.status === 'created'
                                ? 'text-accent-fg'
                                : 'text-slate-500 dark:text-slate-400'
                                }`}
                        />
                    ) : (
                        <FileText
                            className={`w-4 h-4 shrink-0 ${node.status === 'created'
                                ? 'text-slate-700 dark:text-slate-200'
                                : 'text-slate-500 dark:text-slate-400'
                                }`}
                        />
                    )}

                    {/* Title */}
                    <span
                        className={`text-sm truncate ${node.status === 'created'
                            ? 'text-slate-900 dark:text-white'
                            : node.status === 'cancelled'
                                ? 'text-amber-700 dark:text-amber-300'
                                : 'text-slate-700 dark:text-slate-300'
                            } ${node.depth === 0 ? 'font-medium' : ''}`}
                    >
                        {node.title}
                    </span>

                    {hasChildren === false && resourceDot(node.status, node.resourceCount)}

                    {/* Resource count badge */}
                    {node.resourceCount > 0 && (
                        <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 shrink-0">
                            {t("{{resourceCount}} links", { resourceCount: node.resourceCount })}
                        </span>
                    )}

                    {/* Category-level progress badge */}
                    {isTopLevel && hasChildren && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent-fg shrink-0">
                            {node.children.filter(c => c.status === 'created').length}/
                            {node.children.length}
                        </span>
                    )}
                </div>

                {/* Render children (unless collapsed) */}
                {hasChildren && !isCollapsed &&
                    node.children.map((child, idx) =>
                        renderNode(child, idx === node.children.length - 1, false)
                    )}
            </div>
        );
    };

    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-slate-900 dark:text-white">
                    {t("Live structure")}
                </h3>
                {tree.length > 0 && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                        {collapsedKeys.size > 0 ? t("{{size}} collapsed", { size: collapsedKeys.size }) : t("{{pointerVerb}} phase to collapse", { pointerVerb })}
                    </span>
                )}
            </div>
            <div ref={listRef} className="max-h-80 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-xl p-3 bg-white dark:bg-slate-800">
                {tree.map((node, idx) => renderNode(node, idx === tree.length - 1, true))}
            </div>
        </div>
    );
}

// ACTIVITY LOG
interface LogEntry {
    id: string;
    message: string;
    status: 'running' | 'success' | 'error' | 'warning';
    task?: string;
    error?: string;
}

function eventToLogEntry(event: any): LogEntry | null {
    const phase = event.phase;
    const cat = event.currentCategory;
    const el = event.currentElement;
    const se = event.currentSubElement;

    // Determine a stable ID for deduplication
    let id = phase;
    if (cat) id += `-${cat}`;
    if (el) id += `-${el}`;
    if (se) id += `-${se}`;

    // Map to concise message
    let message = event.message || '';
    let status: LogEntry['status'] = 'success';

    // Each step logs twice — once when it starts, once when it lands — and the
    // two share an id on purpose, so the second upsert turns the spinner into a
    // tick instead of leaving a stalled row above its own result.
    switch (phase) {
        case 'thinking':
            //Skip thinking-phase events — they're not useful milestones
            return null;

        case 'init':
            message = event.message || i18n.t("Creating project…");
            status = 'success';
            id = 'init';
            break;

        case 'summary':
            // Two events carry this phase: the one announcing the work has a
            // message, the one delivering the result has the summary text.
            if (event.summary) {
                message = i18n.t("Project summary written");
                status = 'success';
            } else {
                message = message || i18n.t("Generating project summary…");
                status = 'running';
            }
            id = 'summary';
            break;

        case 'planned':
        case 'generating_categories':
        case 'categories_generated':
            id = 'categories';
            if (phase === 'categories_generated') {
                const count = event.categories?.length || 0;
                message = count > 0 ? i18n.t("{{count}} phases created", { count }) : message;
                status = 'success';
            } else {
                message = i18n.t("Generating phases…");
                status = 'running';
            }
            break;

        case 'generating_elements':
        case 'elements_generated':
            id = `elements-${cat}`;
            if (phase === 'elements_generated') {
                const count = event.elements?.length || 0;
                const label = cat || i18n.t("Phase");
                message = count > 0 ? i18n.t("{{label}}: {{count}} topics created", { label, count }) : message;
                status = 'success';
            } else {
                message = cat ? i18n.t('Generating topics for "{{category}}"…', { category: cat }) : i18n.t("Generating topics…");
                status = 'running';
            }
            break;

        case 'generating_sub_elements':
        case 'sub_elements_generated':
            // A whole phase can be expanded in one batched call, which reports
            // no element of its own — that run is its own row, settled by
            // `sub_elements_batched` below.
            id = el ? `sub_elements-${cat}-${el}` : `sub_elements-${cat}`;
            if (phase === 'sub_elements_generated') {
                const count = event.subElements?.length || 0;
                const label = el || se || i18n.t("Topic");
                message = count > 0 ? i18n.t("{{label}}: {{count}} details created", { label, count }) : message;
                status = 'success';
            } else {
                message = se ? i18n.t('Expanding "{{title}}"…', { title: se })
                    : el ? i18n.t('Generating details for "{{title}}"…', { title: el })
                        : i18n.t("Generating details…");
                status = 'running';
            }
            break;

        case 'sub_elements_batched':
            message = event.message || i18n.t("Topics expanded");
            status = event.batched > 0 ? 'success' : 'warning';
            id = `sub_elements-${cat}`;
            break;

        case 'finding_resources':
        case 'resources_saved':
            id = `resources-${cat}-${el}-${se}`;
            if (phase === 'resources_saved') {
                // No search ran, so there is nothing to report — the event still
                // drives the live tree, it just doesn't belong in the log.
                if (event.curated === false) return null;
                const rc = event.resourceCount || 0;
                const label = se || el || i18n.t("Topic");
                message = rc > 0 ? i18n.t("{{label}}: {{count}} links found", { label, count: rc })
                    : i18n.t("{{label}}: resources checked", { label });
                status = 'success';
            } else {
                message = se ? i18n.t('Finding links for "{{title}}"…', { title: se }) : i18n.t("Finding resources…");
                status = 'running';
            }
            break;

        case 'complete':
            message = event.message || i18n.t("Project complete!");
            status = 'success';
            id = 'complete';
            break;

        case 'error':
            message = i18n.t("Error occurred");
            status = 'error';
            id = event.error ? `error-${event.error.substring(0, 50)}` : 'error';
            break;

        case 'cancelled':
            message = i18n.t("Cancelled by user");
            status = 'warning';
            id = 'cancelled';
            break;

        default:
            // Skip messages without a known phase
            if (!message) return null;
            id = `misc-${id}`;
            break;
    }

    return { id, message, status, task: event.task, error: event.error };
}

function ActivityLog({ entries }: { entries: LogEntry[] }) {
    const { t } = useTranslation();
    // The same rule every streaming surface here follows: the log follows new
    // lines unless the reader has scrolled up to read an earlier one. It used
    // to `scrollIntoView` a sentinel at the end, which had neither half of that
    // — it scrolled the dialog and the page along with the log, and it did so
    // on every single line regardless of where the reader was looking.
    const scroll = useStickToBottom<HTMLDivElement>();

    useEffect(() => { scroll.follow(); }, [entries.length, scroll]);

    if (entries.length === 0) return null;

    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-slate-900 dark:text-white">
                    {t("Activity log")}
                </h3>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                    {entries.filter(e => e.status === 'success').length} {t("completed")}
                </span>
            </div>
            <div
                ref={scroll.ref}
                onScroll={scroll.onScroll}
                className="max-h-56 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-xl p-3 bg-white dark:bg-slate-800"
            >
                <div className="space-y-2">
                    {entries.map((entry) => {
                        const isRunning = entry.status === 'running';
                        const isError = entry.status === 'error';
                        const isWarning = entry.status === 'warning';
                        const isSuccess = entry.status === 'success';

                        return (
                            <div
                                key={entry.id}
                                className="flex gap-2.5 items-start"
                            >
                                <div className="shrink-0 mt-0.5">
                                    {isError ? (
                                        <AlertCircle className="w-4 h-4 text-red-500" />
                                    ) : isWarning ? (
                                        <AlertCircle className="w-4 h-4 text-amber-500" />
                                    ) : isRunning ? (
                                        <Loader2 className="w-4 h-4 text-accent-fg animate-spin" />
                                    ) : (
                                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                                    )}
                                </div>
                                <div className="min-w-0">
                                    <p
                                        className={`text-sm ${isError
                                            ? 'text-red-700 dark:text-red-300'
                                            : isWarning
                                                ? 'text-amber-700 dark:text-amber-300'
                                                : isSuccess
                                                    ? 'text-slate-700 dark:text-slate-300'
                                                    : 'text-slate-600 dark:text-slate-400'
                                            }`}
                                    >
                                        {entry.message}
                                    </p>
                                    {isError && entry.error && (
                                        <p className="text-xs text-red-600 dark:text-red-400 mt-0.5 font-mono break-all">
                                            {entry.error}
                                        </p>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

type ProjectStatusValue = 'active' | 'completed' | 'archived';

// A *leaf* drop zone shown for an empty section while dragging, so a project can
// be dropped in to change its status. It must NOT wrap a SortableContext —
// nesting a droppable around sortable items makes dnd-kit's rect measurement
// loop ("Maximum update depth exceeded").
function EmptyDropZone({
    status,
    label,
}: {
    status: ProjectStatusValue;
    label: string;
}) {
    const { t } = useTranslation();
    const { setNodeRef, isOver } = useDroppable({ id: `status:${status}` });
    return (
        <div
            ref={setNodeRef}
            className={`rounded-xl border-2 border-dashed py-8 text-center text-sm transition-colors ${isOver
                ? 'border-accent text-accent bg-accent/5'
                : 'border-slate-300 dark:border-slate-600 text-slate-400'
                }`}
        >
            {t("Drop here to mark as {{label}}", { label })}
        </div>
    );
}

// --------------
// MAIN COMPONENT
// --------------

export default function ProjectsGrid() {
    const { t } = useTranslation();
    const projects = useStore(s => s.projects);
    const setProjects = useStore(s => s.setProjects);
    const createProject = useStore(s => s.createProject);
    const openProject = useStore(s => s.openProject);
    const openAnkiImport = useStore(s => s.openAnkiImport);
    const loadProjects = useStore(s => s.loadProjects);
    const addToast = useStore(s => s.addToast);

    // AI creation store state
    const aiCreationActive = useStore(s => s.aiCreationActive);
    const setAICreationActive = useStore(s => s.setAICreationActive);
    const aiCreationMinimized = useStore(s => s.aiCreationMinimized);
    const setAICreationMinimized = useStore(s => s.setAICreationMinimized);
    const setAICreationProgress = useStore(s => s.setAICreationProgress);
    const showAICreationModal = useStore(s => s.showAICreationModal);
    const setShowAICreationModal = useStore(s => s.setShowAICreationModal);

    const [showCreate, setShowCreate] = useState(false);
    // Three tabs now, so the old boolean became a mode. `showImport` is kept as a
    // derived value because the drop handlers and the modal reset both read it.
    const [createMode, setCreateMode] = useState<'ai' | 'external' | 'import'>('ai');
    const showImport = createMode === 'import';
    const [importing, setImporting] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [newName, setNewName] = useState('');
    const [newDescription, setNewDescription] = useState('');
    const [newColor, setNewColor] = useState('#8B5CF6');
    const [newIcon, setNewIcon] = useState('folder');
    const [newLanguage, setNewLanguage] = useState('');
    // Vault files staged in the create modal. Held here (not on the server) so
    // they survive switching between "Create Empty" and "Create with AI", then
    // uploaded once the project row exists.
    const [stagedVaultFiles, setStagedVaultFiles] = useState<File[]>([]);
    const [activeProject, setActiveProject] = useState<Project | null>(null);
    const [isRestored, setIsRestored] = useState(false);

    // AI Creation State
    const [isAICreating, setIsAICreating] = useState(false);
    const [aiProgress, setAiProgress] = useState<any>(null);
    const [aiError, setAiError] = useState<string | null>(null);
    const [liveTree, setLiveTree] = useState<LiveNode[]>([]);
    const [createdProjectId, setCreatedProjectId] = useState<number | null>(null);
    const [wasCancelled, setWasCancelled] = useState(false);
    const [aiModel, setAiModel] = useState('');
    const [aiSummary, setAiSummary] = useState('');
    const [aiThinking, setAiThinking] = useState('');
    const [aiElapsedMs, setAiElapsedMs] = useState<number>(0);
    const [totalResources, setTotalResources] = useState(0);
    const isCreatingRef = useRef(false);
    const thinkingRef = useRef<HTMLDivElement>(null);
    const aiStartTimeRef = useRef<number>(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const pollingRef = useRef<number | null>(null);
    const aiAbortControllerRef = useRef<AbortController | null>(null);
    const elapsedTimerRef = useRef<number | null>(null);

    // Refactored activity log: deduplicated entries by id
    const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
    const logEntriesMapRef = useRef<Map<string, LogEntry>>(new Map());

    // Collapsible thinking section — starts collapsed, expands during thinking phase
    const [thinkingExpanded, setThinkingExpanded] = useState(false);

    // Collapsible summary section
    const [summaryExpanded, setSummaryExpanded] = useState(true);


    useEffect(() => {
        if (aiProgress?.phase === 'thinking') {
            setThinkingExpanded(true);
        } else if (aiProgress?.phase && aiProgress.phase !== 'thinking' && thinkingExpanded) {
            // Collapse thinking section once we move past the thinking phase
            setThinkingExpanded(false);
        }
    }, [aiProgress?.phase]);

    const sensors = useSensors(
        // Desktop: start dragging as soon as the mouse moves a little.
        useSensor(MouseSensor, { activationConstraint: { distance: 10 } }),
        // Touch: require a short press-and-hold before a drag begins, so a normal
        // swipe scrolls the page and only a deliberate long-press reorders a card.
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
    );

    // Derived counts from live tree
    const liveNodeCounts = useMemo(
        () => countNodes(liveTree),
        [liveTree]
    );


    const activeNodeKey = useMemo(
        () => findGeneratingNode(liveTree)?.key ?? null,
        [liveTree]
    );

    const currentPhaseLabel = useMemo(() => {
        const phase = aiProgress?.phase;
        switch (phase) {
            case 'thinking': return t(AI_CREATION_STEPS[0].description);
            case 'init': return t(AI_CREATION_STEPS[1].description);
            case 'summary': return t(AI_CREATION_STEPS[2].description);
            case 'generating_categories':
            case 'categories_generated': return t(AI_CREATION_STEPS[3].description);
            case 'generating_elements':
            case 'elements_generated': return t(AI_CREATION_STEPS[4].description);
            case 'generating_sub_elements':
            case 'sub_elements_generated': return t(AI_CREATION_STEPS[5].description);
            case 'finding_resources':
            case 'resources_saved': return t(AI_CREATION_STEPS[6].description);
            case 'complete': return t(AI_CREATION_STEPS[7].description);
            default: return 'Preparing...';
        }
    }, [aiProgress?.phase]);


    const upsertLogEntry = useCallback((event: any) => {
        const entry = eventToLogEntry(event);
        if (!entry) return;

        setLogEntries(prev => {
            const existing = logEntriesMapRef.current.get(entry.id);
            if (existing) {
                logEntriesMapRef.current.set(entry.id, entry);
                return prev.map(e => e.id === entry.id ? entry : e);
            } else {
                logEntriesMapRef.current.set(entry.id, entry);
                return [...prev, entry];
            }
        });
    }, []);

    /**
     * Nothing is still in flight once the pipeline reports an outcome, so
     * settle whatever rows are left mid-step instead of leaving spinners on a
     * finished build.
     */
    const settleRunningLogEntries = useCallback((status: LogEntry['status']) => {
        setLogEntries(prev => prev.map(e => {
            if (e.status !== 'running') return e;
            const settled = { ...e, status };
            logEntriesMapRef.current.set(e.id, settled);
            return settled;
        }));
    }, []);

    // LocalStorage Persistence

    const loadRestoredState = useCallback((state: AICreationState) => {
        setAiProgress(state.aiProgress);
        setLiveTree(state.liveTree);
        // Restore log entries from event log
        const entries: LogEntry[] = [];
        const entriesMap = new Map<string, LogEntry>();
        for (const event of state.aiEventLog) {
            const entry = eventToLogEntry(event);
            if (entry) {
                entriesMap.set(entry.id, entry);
            }
        }
        entriesMap.forEach(entry => entries.push(entry));
        setLogEntries(entries);
        logEntriesMapRef.current = entriesMap;
        setAiModel(state.aiModel);
        setAiSummary(state.aiSummary);
        setAiElapsedMs(state.aiElapsedMs);
        setAiError(state.aiError);
        setWasCancelled(state.wasCancelled);
        setCreatedProjectId(state.projectId);
        setIsAICreating(false);
        setIsRestored(state.isNew);
    }, []);

    const startCompletionPolling = useCallback((projectId: number) => {
        if (pollingRef.current) return;
        pollingRef.current = window.setInterval(async () => {
            try {
                const project = await api.getProject(projectId);
                if (!project) return;
                const isStillGenerating = project.ai_generating === 1;
                const nodes = await api.getNodes(projectId);
                const nonNoteNodes = nodes.filter((n: any) => !n.is_note);
                await loadProjects();
                if (!isStillGenerating && nonNoteNodes.length > 0) {
                    stopCompletionPolling();
                    setIsAICreating(false);
                    setAICreationActive(false);
                    setAICreationMinimized(false);
                    setAICreationProgress(null);
                    setAiProgress({
                        phase: 'complete',
                        message: t("Project fully complete!"),
                        projectId,
                        overallProgress: 100,
                        done: true,
                    });
                    setShowCreate(true); // Show the modal so user can see result
                    addToast('success', t("Project \"{{name}}\" AI generation completed!", { name: project.name }));
                }
            } catch (e) {
                console.error('Polling error:', e);
            }
        }, 5000);
    }, [loadProjects, addToast, setAICreationActive, setAICreationMinimized, setAICreationProgress]);

    const stopCompletionPolling = useCallback(() => {
        if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
        }
    }, []);

    useEffect(() => {
        const restored = loadAICreationState();
        if (restored) {
            loadRestoredState(restored);

            if (restored.wasCancelled) {
                // Cancellation is terminal — don't poll for "completion" and risk
                // misreporting a cancelled run as a success on reload.
                setShowCreate(true);
                return;
            }

            // If so, show the floating indicator (minimized) and start polling
            const checkServerStatus = async () => {
                try {
                    const project = await api.getProject(restored.projectId);
                    if (project && project.ai_generating === 1) {
                        // Server is still generating — restore with floating indicator
                        setAICreationActive(true);
                        setAICreationMinimized(true);
                        setIsAICreating(false); // Not actively streaming, but server is working
                        // Restore the floating indicator's progress info
                        setAICreationProgress({
                            phase: restored.aiProgress?.phase || '',
                            message: restored.aiProgress?.message || 'Generating in background...',
                            overallProgress: restored.aiProgress?.overallProgress || 0,
                            projectName: restored.projectName,
                        });
                        startCompletionPolling(restored.projectId);
                    } else {
                        // Server finished or project doesn't exist — show the modal with result
                        setShowCreate(true);
                        startCompletionPolling(restored.projectId);
                    }
                } catch {
                    // Can't reach server — show modal anyway so user can see last known state
                    setShowCreate(true);
                    startCompletionPolling(restored.projectId);
                }
            };

            checkServerStatus();
        } else {

            // This handles cases where localStorage was cleared or page was force-reloaded
            const checkForBackgroundGeneration = async () => {
                try {
                    // Fetch projects directly from API to avoid stale closure issues
                    const projectsFromApi = await api.getProjects();
                    setProjects(projectsFromApi);
                    const generatingProject = projectsFromApi.find(
                        (p: any) => p.ai_generating === 1
                    );
                    if (generatingProject) {
                        // Set all state synchronously before rendering the floating indicator
                        setCreatedProjectId(generatingProject.id);
                        setAiProgress({
                            phase: 'init',
                            message: t("Generating in background..."),
                            overallProgress: 0,
                        });
                        setIsRestored(true);
                        setAICreationProgress({
                            phase: '',
                            message: t("Generating in background..."),
                            overallProgress: 0,
                            projectName: generatingProject.name,
                        });
                        setAICreationActive(true);
                        setAICreationMinimized(true);
                        startCompletionPolling(generatingProject.id);
                    }
                } catch {
                    // Silently handle — this is a best-effort backup
                }
            };

            checkForBackgroundGeneration();
        }
    }, [loadRestoredState, startCompletionPolling, setAICreationActive, setAICreationMinimized, loadProjects]);


    useEffect(() => {
        const handleBeforeUnload = () => {
            if (createdProjectId && aiProgress && aiProgress.phase !== 'complete' && aiProgress.phase !== 'error' && aiProgress.phase !== 'cancelled') {
                // Synchronously save to localStorage before page closes
                try {
                    // Use fresh store data to avoid stale closure issues
                    const freshProjects = useStore.getState().projects;
                    const project = freshProjects.find((p: any) => p.id === createdProjectId);
                    const eventLogArray: any[] = [];
                    logEntriesMapRef.current.forEach(entry => eventLogArray.push(entry));
                    localStorage.setItem(LS_KEY, JSON.stringify({
                        projectId: createdProjectId,
                        projectName: project?.name || 'Unknown',
                        isNew: isRestored,
                        aiProgress,
                        liveTree,
                        aiEventLog: eventLogArray,
                        aiModel,
                        aiSummary,
                        aiElapsedMs,
                        aiError,
                        wasCancelled,
                    }));
                } catch { }
            }
        };

        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [createdProjectId, aiProgress, liveTree, aiModel, aiSummary, aiElapsedMs, aiError, wasCancelled, isRestored]);

    useEffect(() => {
        const el = thinkingRef.current;
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    }, [aiThinking]);

    useEffect(() => {
        return () => {
            aiAbortControllerRef.current?.abort();
            if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
            stopCompletionPolling();
        };
    }, [stopCompletionPolling]);

    // Re-open modal if AI creation is active and not minimized
    useEffect(() => {
        if (aiCreationActive && !aiCreationMinimized && !showCreate && isAICreating) {
            setShowCreate(true);
        }
    }, [aiCreationActive, aiCreationMinimized, isAICreating, showCreate]);


    // This is triggered by Layout when the user clicks "View" on the floating indicator
    useEffect(() => {
        if (showAICreationModal) {
            setShowCreate(true);
            setShowAICreationModal(false); // consume the signal
        }
    }, [showAICreationModal, setShowAICreationModal]);

    // Save to localStorage when state changes

    useEffect(() => {
        if (
            createdProjectId &&
            (isAICreating || aiProgress) &&
            aiProgress?.phase !== 'complete' &&
            aiProgress?.phase !== 'cancelled'
        ) {
            const project = projects.find(p => p.id === createdProjectId);
            if (project) {
                // Convert logEntries map back to array for serialization
                const eventLogArray: any[] = [];
                logEntriesMapRef.current.forEach(entry => eventLogArray.push(entry));

                saveAICreationState({
                    projectId: createdProjectId,
                    projectName: project.name,
                    isNew: isRestored,
                    aiProgress,
                    liveTree,
                    aiEventLog: eventLogArray,
                    aiModel,
                    aiSummary,
                    aiElapsedMs,
                    aiError,
                    wasCancelled,
                });
            }
        }
        if (aiProgress?.phase === 'complete' || aiProgress?.phase === 'error' || aiProgress?.phase === 'cancelled') {
            clearAICreationState();
            stopCompletionPolling();
        }
    }, [
        aiProgress, liveTree, logEntries, aiModel, aiSummary,
        aiElapsedMs, createdProjectId, isAICreating, isRestored,
        wasCancelled, aiError, projects, stopCompletionPolling,
    ]);

    // Cancel / Minimize

    const handleCancelAICreation = async () => {
        // Tell the server to actually stop generating. Aborting the local fetch
        // alone just disconnects the SSE stream — the server keeps generating in
        // the background. The cancel endpoint aborts the Ollama request and breaks
        // the generation loop, preserving whatever was created so far.
        const pid = createdProjectId;
        try {
            await api.cancelProjectWithAI(pid ?? undefined);
        } catch {
            // Best effort — fall through to the local abort regardless.
        }

        aiAbortControllerRef.current?.abort();

        // Reflect cancellation immediately (the SSE generator returns silently on
        // abort, so we won't get a 'cancelled' event back from the stream).
        setWasCancelled(true);
        setLiveTree(prev => markAllRemainingCancelled(prev));
        setAiProgress({
            phase: 'cancelled',
            message: t("AI creation cancelled. Partial content has been kept."),
            projectId: pid ?? undefined,
            cancelled: true,
        });
        await loadProjects();

        setAICreationActive(false);
        setAICreationMinimized(false);
    };

    const handleMinimizeAICreation = () => {
        setAICreationMinimized(true);
        setShowCreate(false);
    };

    const resetForm = () => {
        setNewName('');
        setNewDescription('');
        setNewColor('#8B5CF6');
        setNewIcon('folder');
        setNewLanguage('');
        setStagedVaultFiles([]);
        setCreateMode('ai');
        setImporting(false);
        setIsDragging(false);
        setIsAICreating(false);
        setIsRestored(false);
        setAiProgress(null);
        setAiError(null);
        setLogEntries([]);
        logEntriesMapRef.current.clear();
        setCreatedProjectId(null);
        setWasCancelled(false);
        setLiveTree([]);
        setAiModel('');
        setAiSummary('');
        setAiThinking('');
        setTotalResources(0);
        setThinkingExpanded(false);
        setSummaryExpanded(true);
        aiAbortControllerRef.current = null;
        stopCompletionPolling();
        clearAICreationState();
        setAICreationActive(false);
        setAICreationMinimized(false);
        setAICreationProgress(null);
    };

    // Import Handling

    /** What this dropzone accepts. An Anki deck is here because it is where
     *  someone holding one looks first — "import" is the word they are after,
     *  and a separate entrance in Settings is a door they never find. */
    const IMPORT_ACCEPT = '.json,.studyvault,.zip,.apkg,.colpkg';
    const IMPORTABLE_RE = /\.(json|studyvault|zip|apkg|colpkg)$/i;

    const processImport = async (file: File) => {
        // A deck is not a project file: it needs a preview, a front/back check
        // and a media decision, all of which the Anki importer already owns. So
        // this hands the file over rather than growing a second implementation.
        if (/\.(apkg|colpkg)$/i.test(file.name)) {
            setShowCreate(false);
            resetForm();
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
            setShowCreate(false);
            resetForm();
            openProject(newProject.id);
            // Repairs the importer made — an unknown language code, a dropped
            // unsafe link, a course you already have. Each one changes what you
            // ended up with, so none of them may be silent.
            const warnings = newProject.warnings || [];
            if (warnings.length) {
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

    // Upload any files staged in the create modal to the now-existing project.
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
        setShowCreate(false);
        resetForm();
        openProject(project.id);
    };

    // --------------------
    // AI CREATION PIPELINE
    // --------------------

    const handleCreateWithAI = async () => {
        if (!newName.trim()) return;
        if (isCreatingRef.current) return;
        isCreatingRef.current = true;

        const controller = new AbortController();
        aiAbortControllerRef.current = controller;

        setIsAICreating(true);
        setAICreationActive(true);
        setAiProgress(null);
        setAiError(null);
        setLogEntries([]);
        logEntriesMapRef.current.clear();
        setCreatedProjectId(null);
        setWasCancelled(false);
        setLiveTree([]);
        setAiThinking('');
        setTotalResources(0);
        aiStartTimeRef.current = Date.now();

        if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = window.setInterval(() => {
            setAiElapsedMs(Date.now() - aiStartTimeRef.current);
        }, 1000);

        let latestProjectId: number | null = null;

        try {
            for await (const progress of api.createProjectWithAI(
                newName, newDescription, newColor, newIcon || 'brain', controller.signal, newLanguage
            )) {
                setAiProgress(progress);

                // Update store for floating indicator
                setAICreationProgress({
                    phase: progress.phase || '',
                    message: progress.message || '',
                    overallProgress: progress.overallProgress || 0,
                    projectName: newName,
                });

                // Incremental tree building

                switch (progress.phase) {
                    case 'categories_generated': {
                        const cats = progress.categories;
                        if (cats && cats.length > 0) {
                            setLiveTree(prev => addCategories(prev, cats));
                        }
                        break;
                    }

                    case 'generating_elements': {
                        const ci = progress.categoryIndex;
                        if (ci !== undefined) {
                            setLiveTree(prev => markCategoryGenerating(prev, ci));
                        }
                        break;
                    }

                    case 'elements_generated': {
                        const ci = progress.categoryIndex;
                        const elems = progress.elements;
                        if (ci !== undefined && elems && elems.length > 0) {
                            setLiveTree(prev => addElements(prev, ci, elems));
                        }
                        break;
                    }

                    case 'generating_sub_elements': {
                        const ci = progress.categoryIndex;
                        const ei = progress.elementIndex;
                        if (ci !== undefined && ei !== undefined) {
                            setLiveTree(prev => markElementGenerating(prev, ci, ei));
                        }
                        break;
                    }

                    case 'sub_elements_generated': {
                        const ci = progress.categoryIndex;
                        const ei = progress.elementIndex;
                        const subs = progress.subElements;
                        if (ci !== undefined && ei !== undefined && subs && subs.length > 0) {
                            setLiveTree(prev => addSubElements(prev, ci, ei, subs));
                        }
                        break;
                    }

                    case 'resources_saved': {
                        const rc = progress.resourceCount || 0;
                        setTotalResources(prev => prev + rc);

                        const ci = progress.categoryIndex;
                        const ei = progress.elementIndex;
                        const si = progress.subElementIndex;
                        if (ci !== undefined && ei !== undefined && si !== undefined) {
                            setLiveTree(prev => markSubElementDone(prev, ci, ei, si, rc));
                        }
                        break;
                    }

                    case 'complete': {
                        setLiveTree(prev => markAllCreated(prev));
                        settleRunningLogEntries('success');
                        break;
                    }
                }

                // Accumulate thinking locally
                if (progress.thinkingChunk) {
                    setAiThinking(prev => prev + progress.thinkingChunk);
                }


                // Don't gate on `progress.message`: the events that REPORT a
                // finished step carry structured counts rather than prose, so
                // requiring a message dropped every one of them and left the
                // log a column of spinners under a "3 completed" count.
                if (progress.phase !== 'thinking') {
                    upsertLogEntry(progress);
                }

                // Other state updates

                if (progress.projectId) {
                    latestProjectId = progress.projectId;
                    setCreatedProjectId(progress.projectId);
                }
                if (progress.model) setAiModel(progress.model);
                if (progress.summary) setAiSummary(progress.summary);

                if (progress.error) {
                    setAiError(progress.error);
                    upsertLogEntry({ ...progress, phase: 'error' });
                }

                if (progress.done && progress.projectId) {
                    upsertLogEntry(progress);
                    await uploadStagedVault(progress.projectId);
                    setStagedVaultFiles([]);
                    await loadProjects();
                    addToast('success', t("Project \"{{newName}}\" created with AI!", { newName }));
                    clearAICreationState();
                }
            }
        } catch (e: any) {
            if (e?.name === 'AbortError') {
                setWasCancelled(true);
                setLiveTree(prev => markAllRemainingCancelled(prev));
                settleRunningLogEntries('warning');
                setAiProgress({
                    phase: 'cancelled',
                    message: t("AI creation cancelled. Partial content has been kept."),
                    projectId: latestProjectId || undefined,
                    cancelled: true,
                });
                upsertLogEntry({ phase: 'cancelled', message: t("AI creation cancelled.") });
                await loadProjects();
                clearAICreationState();
                addToast(
                    'info',
                    t("AI creation cancelled"),
                    latestProjectId
                        ? t("Partial project saved.")
                        : t("No project was created.")
                );
            } else {
                setAiError(e.message || 'Unknown AI creation error');
                addToast('error', t("AI creation failed"), e.message);
                clearAICreationState();
            }
        } finally {
            aiAbortControllerRef.current = null;
            isCreatingRef.current = false;
            setIsAICreating(false);
            setAICreationActive(false);
            if (elapsedTimerRef.current) {
                clearInterval(elapsedTimerRef.current);
                elapsedTimerRef.current = null;
            }
        }
    };

    const handleCloseModal = () => {
        if (isAICreating) {
            handleMinimizeAICreation();
            return;
        }
        setShowCreate(false);
        resetForm();
    };

    // Project Grid Drag

    const statusOf = (id: number, list: Project[]): ProjectStatusValue =>
        (list.find(p => p.id === id)?.status ?? 'active') as ProjectStatusValue;

    const handleDragStart = (event: DragStartEvent) => {
        const project = projects.find(p => p.id === event.active.id);
        setActiveProject(project || null);
    };

    // All reordering / cross-section moves are resolved once, on drop. (Moving a
    // card between SortableContexts live in onDragOver remounts it every pointer
    // move and loops dnd-kit's rect measurement — so we don't do that.) The drop
    // target is either another card (insert at its position) or an empty section's
    // drop-zone ("status:<name>"). closestCorners makes the card under the pointer
    // win over its containing section, so drops land where you point.
    const handleDragEnd = async (event: DragEndEvent) => {
        setActiveProject(null);
        const { active, over } = event;
        if (!over || active.id === over.id) return;

        const draggedId = active.id as number;
        const sourceStatus = statusOf(draggedId, projects);

        const overId = over.id;
        let targetStatus: ProjectStatusValue;
        let overCardId: number | null = null;
        if (typeof overId === 'string' && overId.startsWith('status:')) {
            targetStatus = overId.slice('status:'.length) as ProjectStatusValue;
        } else {
            overCardId = overId as number;
            targetStatus = statusOf(overCardId, projects);
        }

        const dragged = projects.find(p => p.id === draggedId);
        if (!dragged) return;

        // Rebuild each section without the dragged card, then insert it into the
        // target section at the drop position. Global order stays grouped
        // active → completed → archived.
        const sectionItems = (s: ProjectStatusValue) =>
            projects.filter(p => p.id !== draggedId && (p.status ?? 'active') === s);

        const target = sectionItems(targetStatus);
        const insertAt =
            overCardId != null
                ? Math.max(0, target.findIndex(p => p.id === overCardId))
                : target.length;
        if (sourceStatus === targetStatus && overCardId == null) return; // no-op
        target.splice(insertAt, 0, { ...dragged, status: targetStatus });

        const grouped = (s: ProjectStatusValue) =>
            s === targetStatus ? target : sectionItems(s);
        const newOrder = [
            ...grouped('active'),
            ...grouped('completed'),
            ...grouped('archived'),
        ];

        setProjects(newOrder);
        try {
            if (sourceStatus !== targetStatus) {
                await api.updateProject(draggedId, { status: targetStatus });
            }
            await api.reorderProjects(newOrder.map(p => p.id));
        } catch (e: any) {
            await loadProjects();
            addToast('error', t("Failed to move project"), e.message);
        }
    };

    // Context Value

    const isProjectGenerating = (projectId: number): boolean => {
        const project = projects.find(p => p.id === projectId);
        if (project && project.ai_generating === 1) return true;
        if (
            createdProjectId === projectId &&
            isAICreating &&
            aiProgress?.phase !== 'complete' &&
            aiProgress?.phase !== 'error'
        )
            return true;
        return false;
    };

    const generatingProject = projects.find(p => isProjectGenerating(p.id));
    const contextValue: AICreationContextValue = {
        generatingProjectId: createdProjectId || generatingProject?.id || null,
        isProjectGenerating,
        openGenerationModal: () => {
            setShowCreate(true);
        },
    };

    // Group projects for display: active (reorderable) on top, then completed &
    // archived below their own dividers.
    const activeProjects = projects.filter(p => (p.status ?? 'active') === 'active');
    const completedProjects = projects.filter(p => p.status === 'completed');
    const archivedProjects = projects.filter(p => p.status === 'archived');

    // ------
    // RENDER
    // ------

    return (
        <AICreationContext.Provider value={contextValue}>
            <div className="h-full overflow-auto p-8 bg-slate-100 dark:bg-slate-900">
                <div className="max-w-6xl mx-auto">
                    <div className="flex items-center justify-between mb-8">
                        <div>
                            <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
                                {t("Your Projects")}
                            </h2>
                            <p className="text-slate-500 dark:text-slate-400 mt-1">
                                {t("Drag to reorder • Click to open")}
                            </p>
                        </div>
                        <button
                            onClick={() => setShowCreate(true)}
                            className="flex items-center gap-2 px-4 py-2.5 bg-slate-900 dark:bg-accent text-white rounded-xl hover:bg-slate-800 dark:hover:bg-accent/90 transition font-medium"
                        >
                            <Plus className="w-5 h-5" />
                            {t("New Project")}
                        </button>
                    </div>

                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCorners}
                        // Re-measure droppables during the drag so the empty-section
                        // drop zones (which mount only once a drag starts) are detected.
                        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                    >
                        {/* Active section. Plain SortableContext (NO droppable wrapper —
                            wrapping a droppable around sortable items loops dnd-kit's
                            measurement). Cross-section drops land on a card in the target
                            section; empty sections use a separate leaf drop zone below. */}
                        <SortableContext
                            items={activeProjects.map(p => p.id)}
                            strategy={rectSortingStrategy}
                        >
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-fr gap-6 min-h-[2rem]">
                                {activeProjects.map(project => (
                                    <ProjectCard key={project.id} project={project} />
                                ))}
                            </div>
                        </SortableContext>
                        {activeProjects.length === 0 && activeProject && (
                            <EmptyDropZone status="active" label={t("Active")} />
                        )}

                        {([
                            { label: t("Completed"), status: 'completed' as const, items: completedProjects },
                            { label: t("Archived"), status: 'archived' as const, items: archivedProjects },
                        ]).map(section => {
                            const isEmpty = section.items.length === 0;
                            const isDragging = activeProject != null;
                            // Hidden entirely when empty and not dragging.
                            if (isEmpty && !isDragging) return null;
                            return (
                                <div key={section.label}>
                                    <div className="flex items-center gap-3 mt-10 mb-5">
                                        <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                            {section.label} · {section.items.length}
                                        </span>
                                        <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                                    </div>
                                    {isEmpty ? (
                                        <EmptyDropZone status={section.status} label={section.label} />
                                    ) : (
                                        <SortableContext
                                            items={section.items.map(p => p.id)}
                                            strategy={rectSortingStrategy}
                                        >
                                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-fr gap-6 opacity-70 hover:opacity-100 transition-opacity">
                                                {section.items.map(project => (
                                                    <ProjectCard key={project.id} project={project} />
                                                ))}
                                            </div>
                                        </SortableContext>
                                    )}
                                </div>
                            );
                        })}

                        <DragOverlay>
                            {activeProject && (
                                <div className="opacity-80">
                                    <ProjectCard project={activeProject} isDragOverlay />
                                </div>
                            )}
                        </DragOverlay>
                    </DndContext>

                    {projects.length === 0 && (
                        <div className="text-center py-16">
                            <p className="text-slate-500 dark:text-slate-400 text-lg">{t("No projects yet")}</p>
                            <p className="text-slate-500 dark:text-slate-400 mt-1">
                                {t("Create your first learning project to get started")}
                            </p>
                        </div>
                    )}
                </div>

                {/* Create / Import Modal */}

                <Modal
                    isOpen={showCreate}
                    onClose={handleCloseModal}
                    title={
                        isAICreating
                            ? t("Creating Project with AI")
                            : aiProgress?.phase === 'cancelled'
                                ? t("AI Creation Cancelled")
                                : isRestored
                                    ? t("AI Generation in Progress")
                                    : t("Create New Project")
                    }
                    maxWidth={
                        isAICreating || aiProgress || isRestored
                            ? 'max-w-2xl'
                            : 'max-w-md'
                    }
                >
                    {!isAICreating && !aiProgress && !isRestored ? (
                        /*
                         * INITIAL FORM: Create New / Import
                         */
                        <div className="space-y-4">
                            {/* Three tabs at this width need short labels; "With AI"
                                is the local pipeline, "Chat model" is the paste-a-prompt
                                route, and they are genuinely different products rather
                                than two ways to press the same button. */}
                            <div className="flex rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700">
                                {([
                                    ['ai', 'With AI'],
                                    ['external', 'Chat model'],
                                    ['import', 'Import'],
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
                                    onImported={(id) => { handleCloseModal(); openProject(id); }}
                                />
                            ) : showImport ? (
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

                                    <div className="flex justify-end gap-3 pt-4 border-t border-slate-200 dark:border-slate-700">
                                        <button
                                            onClick={handleCloseModal}
                                            className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl transition"
                                        >
                                            {t("Cancel")}
                                        </button>
                                        <button
                                            onClick={handleCreate}
                                            disabled={!newName.trim()}
                                            className="px-4 py-2 bg-slate-900 dark:bg-slate-600 text-white rounded-xl hover:bg-slate-800 dark:hover:bg-slate-500 transition disabled:opacity-50"
                                        >
                                            {t("Create Empty")}
                                        </button>
                                        <button
                                            onClick={handleCreateWithAI}
                                            disabled={!newName.trim()}
                                            className="px-4 py-2 bg-gradient-to-r from-accent to-accent text-white rounded-xl hover:from-accent/90 hover:to-accent/90 transition disabled:opacity-50 flex items-center gap-2 font-medium"
                                        >
                                            <Sparkles className="w-4 h-4" />
                                            {t("Create with AI")}
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    ) : (
                        /*
                         * [UX OVERHAUL] AI CREATION PROGRESS VIEW
                         * Layout:
                         * 1. Minimize/Cancel header
                         * 2. Stepper with micro-progress
                         * 3. Active Task Banner (replaces old Status + Current Task boxes)
                         * 4. Completion / Cancelled messages
                         * 5. Live Structure Tree (auto-scroll, auto-collapse)
                         * 6. Activity Log (deduplicated, concise)
                         * 7. Model Thinking (collapsed by default)
                         * 8. Project Summary (compact)
                         * 9. Error display
                         * 10. Action buttons
                         */
                        <div className="space-y-3">
                            {/* Minimize / Cancel header */}
                            {(isAICreating || isRestored) && (
                                <div className="flex items-center justify-between -mt-2 mb-1">
                                    <div />
                                    <div className="flex items-center gap-2">
                                        {isAICreating && (
                                            <button
                                                onClick={handleMinimizeAICreation}
                                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                                                title={t("Minimize — continue in background")}
                                            >
                                                <Minimize2 className="w-3.5 h-3.5" />
                                                {t("Minimize")}
                                            </button>
                                        )}
                                        {(isAICreating || isRestored) && (
                                            <button
                                                onClick={handleCancelAICreation}
                                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
                                                title={t("Cancel AI creation")}
                                            >
                                                <X className="w-3.5 h-3.5" />
                                                {t("Cancel")}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Step progress */}
                            <AIStepProgress
                                aiProgress={aiProgress}
                                isAICreating={isAICreating}
                                liveNodeCounts={liveNodeCounts}
                                totalResources={totalResources}
                            />

                            <ActiveTaskBanner
                                aiProgress={aiProgress}
                                isAICreating={isAICreating}
                                liveNodeCounts={liveNodeCounts}
                                totalResources={totalResources}
                                aiElapsedMs={aiElapsedMs}
                                currentPhaseLabel={currentPhaseLabel}
                            />

                            {/* Completion message */}
                            {aiProgress?.phase === 'complete' && (
                                <div className="flex items-start gap-3 p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl">
                                    <div className="shrink-0 mt-0.5">
                                        <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="font-medium text-emerald-700 dark:text-emerald-300 break-words">
                                            {aiProgress.message || t("Project created successfully!")}
                                        </p>
                                        <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-1 break-words">
                                            {aiProgress.task || t("All phases, cards, and resource links have been created.")}
                                        </p>
                                    </div>
                                    <span className="shrink-0 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                                        {t("{{created}} cards • {{totalResources}} links", { created: liveNodeCounts.created, totalResources })}
                                    </span>
                                </div>
                            )}

                            {/* Cancelled display */}
                            {aiProgress?.phase === 'cancelled' && (
                                <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl">
                                    <p className="font-medium text-amber-700 dark:text-amber-400">
                                        {t("AI creation cancelled")}
                                    </p>
                                    <p className="text-sm text-amber-600 dark:text-amber-500 mt-1">
                                        {t("Partial content was saved. A note inside the project explains that the AI generation stopped before completion.")}
                                    </p>
                                </div>
                            )}

                            {/* Error display */}
                            {aiError && (
                                <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl">
                                    <p className="text-sm text-red-600 dark:text-red-400">
                                        {aiError}
                                    </p>
                                </div>
                            )}

                            <LiveStructureTree tree={liveTree} activeNodeKey={activeNodeKey} />

                            <ActivityLog entries={logEntries} />

                            {aiThinking && (
                                <div className="rounded-xl border border-accent/30 dark:border-accent/40 bg-accent/10 overflow-hidden">
                                    <button
                                        onClick={() => setThinkingExpanded(prev => !prev)}
                                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent/20 transition-colors"
                                    >
                                        <Bot className="w-3.5 h-3.5 text-accent-fg shrink-0" />
                                        <span className="text-xs uppercase tracking-wide text-accent-fg font-medium">
                                            {t("Model thinking")}
                                        </span>
                                        {aiProgress?.phase === 'thinking' && (
                                            <span className="w-1.5 h-3.5 bg-accent animate-pulse rounded-sm" />
                                        )}
                                        <span className="ml-auto text-accent-fg">
                                            {thinkingExpanded ? (
                                                <ChevronDown className="w-4 h-4" />
                                            ) : (
                                                <ChevronRight className="w-4 h-4" />
                                            )}
                                        </span>
                                    </button>
                                    {thinkingExpanded && (
                                        <div
                                            ref={thinkingRef}
                                            className="max-h-48 overflow-y-auto px-3 pb-3 text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed"
                                        >
                                            {aiThinking}
                                        </div>
                                    )}
                                </div>
                            )}

                            <div
                                className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden"
                            >
                                <button
                                    onClick={() => setSummaryExpanded(prev => !prev)}
                                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                                >
                                    <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
                                        {t("Project summary")}
                                    </span>
                                    <span className="ml-auto text-slate-500 dark:text-slate-400">
                                        {summaryExpanded ? (
                                            <ChevronDown className="w-4 h-4" />
                                        ) : (
                                            <ChevronRight className="w-4 h-4" />
                                        )}
                                    </span>
                                </button>
                                {summaryExpanded && (
                                    <div className="px-3 pb-3">
                                        <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                                            {stripMarkdown(aiSummary) || t("Preparing summary...")}
                                        </p>
                                    </div>
                                )}
                            </div>

                            {/* Final completion celebration */}
                            {aiProgress?.phase === 'complete' && (
                                <div className="p-6 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-xl text-center">
                                    <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
                                    <p className="text-lg font-semibold text-emerald-700 dark:text-emerald-400">
                                        {t("Project fully complete!")}
                                    </p>
                                </div>
                            )}

                            {/* Action buttons */}
                            <div className="flex flex-col gap-3 pt-2">
                                {aiProgress?.phase === 'complete' && createdProjectId && (
                                    <button
                                        onClick={() => {
                                            setShowCreate(false);
                                            const id = createdProjectId;
                                            resetForm();
                                            openProject(id);
                                        }}
                                        className="w-full px-6 py-3 bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-lg font-semibold rounded-xl hover:from-emerald-600 hover:to-teal-600 transition-all duration-500 animate-glow-pulse"
                                    >
                                        {t("Go to Project")}
                                    </button>
                                )}

                                {createdProjectId &&
                                    aiProgress?.phase !== 'complete' &&
                                    !isAICreating && (
                                        <button
                                            onClick={() => {
                                                setShowCreate(false);
                                                const id = createdProjectId;
                                                openProject(id);
                                            }}
                                            className="w-full px-4 py-2 bg-slate-900 dark:bg-slate-600 text-white rounded-xl hover:bg-slate-800 dark:hover:bg-slate-500 transition"
                                        >
                                            {t("Open Partial Project")}
                                        </button>
                                    )}

                                {aiProgress?.phase !== 'complete' &&
                                    !isAICreating && (
                                        <p className="text-sm text-center text-amber-600 dark:text-amber-400">
                                            {t("Generation is running on the server. Progress will update automatically when complete.")}
                                        </p>
                                    )}
                            </div>
                        </div>
                    )}
                </Modal>
            </div>
        </AICreationContext.Provider>
    );
}