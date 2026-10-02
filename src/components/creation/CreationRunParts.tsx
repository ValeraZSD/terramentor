// The live structure tree and the activity log of one creation run. Moved out
// of ProjectsGrid.tsx with the run itself (see creationRuns.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, FileText, FolderTree, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { scrollIntoViewWithin } from '../../utils/scrollWithin';
import { useStickToBottom } from '../../hooks/useStickToBottom';
import { type LiveNode, isCategoryActive, isCategoryComplete } from './liveTree';
import type { LogEntry } from './creationLog';


export function stripMarkdown(text: string): string {
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

// LiveStructureTree COMPONENT
// - Auto-scroll to active node
// - Highlighted active node (purple left-border + pulse)
// - Auto-collapse completed categories
// - Resource status dots
// ------------------------------------------------------

export function LiveStructureTree({ tree, activeNodeKey }: { tree: LiveNode[]; activeNodeKey: string | null }) {
    const { t } = useTranslation();
    const activeNodeRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

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
                        <span className="ml-auto text-3xs px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 shrink-0">
                            {t("{{resourceCount}} links", { count: node.resourceCount, resourceCount: node.resourceCount })}
                        </span>
                    )}

                    {/* Category-level progress badge */}
                    {isTopLevel && hasChildren && (
                        <span className="text-3xs px-2 py-0.5 rounded-full bg-accent/10 text-accent-fg shrink-0">
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
                {/* A count only. The hint it replaced — "{{pointerVerb}} phase
                    to collapse" — built a sentence out of a verb and a noun,
                    which no language but English can take ("Нажмите фаза для
                    сворачивания"), and the chevron beside each phase says it
                    anyway. */}
                {collapsedKeys.size > 0 && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                        {t("{{count}} phases folded", { count: collapsedKeys.size })}
                    </span>
                )}
            </div>
            <div ref={listRef} className="max-h-80 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-xl p-3 bg-white dark:bg-slate-800">
                {tree.map((node, idx) => renderNode(node, idx === tree.length - 1, true))}
            </div>
        </div>
    );
}

export function ActivityLog({ entries }: { entries: LogEntry[] }) {
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
                    {t("{{count}} steps done", { count: entries.filter(e => e.status === 'success').length })}
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
