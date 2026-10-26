// The course outline and the activity log of one creation run, drawn as the
// Outline and Activity log tabs of the run screen (CreationRunView). Neither
// scrolls by itself: the screen has ONE scrolling body, and these are content
// inside it. Boxes of their own (`max-h-80`, `max-h-56`) inside a dialog that
// also scrolled made four scroll regions on one screen, the outline three rows
// tall on a laptop.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { scrollIntoViewWithin } from '../../utils/scrollWithin';
import { FOCUS_RING, cx } from '../ui/vocabulary';
import { type LiveNode, containsKey, isCategoryActive, isCategoryComplete } from './liveTree';
import type { LogEntry } from './creationLog';

/** The run screen's scrolling body: the boundary every scroll here stays inside. */
export const RUN_BODY_ATTR = 'data-run-body';
/** The topic being written: the screen measures it to point the way back. */
export const ACTIVE_ROW_ATTR = 'data-active-row';

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

/** One status, one icon: done, working, stopped, failed, or not yet. */
function StatusIcon({ status }: { status: LiveNode['status'] }) {
    switch (status) {
        case 'generating': return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent-fg" aria-hidden="true" />;
        case 'created': return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />;
        case 'cancelled': return <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />;
        case 'error': return <AlertCircle className="h-4 w-4 shrink-0 text-red-500" aria-hidden="true" />;
        default: return <span className="mx-[0.3125rem] h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400 dark:bg-slate-500" aria-hidden="true" />;
    }
}

/** Rows wrap, so an icon sits on the first line of its title, not its middle. */
function Lead({ children }: { children: React.ReactNode }) {
    return <span className="flex h-5 shrink-0 items-center">{children}</span>;
}

/**
 * The course as it is written: phases, their sections, their topics.
 *
 * It follows the topic being written while `follow` is on — inside the run
 * screen's body, never the page (`scrollIntoViewWithin` with the body as its
 * boundary). The screen turns `follow` off the moment the reader scrolls, and
 * offers the way back, so reading phase 1 is never yanked to phase 3.
 */
export function LiveStructureTree({ tree, activeNodeKey, follow, live }: { tree: LiveNode[]; activeNodeKey: string | null; follow: boolean; live: boolean }) {
    const { t } = useTranslation();
    // The active row: a topic or section row, or a phase heading while the
    // model is still writing that phase's sections.
    const activeNodeRef = useRef<HTMLElement | null>(null);
    const setActiveRow = (el: HTMLElement | null) => { activeNodeRef.current = el; };

    const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());

    // Following opens the phase the topic is in, if the reader folded it: the
    // way back otherwise led to a row that was not drawn, and nothing moved.
    useEffect(() => {
        if (!follow || !activeNodeKey) return;
        const phase = tree.find(cat => cat.key !== activeNodeKey && containsKey(cat, activeNodeKey));
        if (phase) setCollapsedKeys(prev => {
            if (!prev.has(phase.key)) return prev;
            const next = new Set(prev);
            next.delete(phase.key);
            return next;
        });
    }, [activeNodeKey, follow, tree]);

    useEffect(() => {
        if (!follow) return;
        const el = activeNodeRef.current;
        scrollIntoViewWithin(el, {
            boundary: el?.closest<HTMLElement>(`[${RUN_BODY_ATTR}]`) ?? null, block: 'center', behavior: 'smooth',
        });
    }, [activeNodeKey, follow, collapsedKeys]);

    // A finished phase folds away while another one is still being built. With
    // nothing generating the run is over, and folding then would hide the
    // whole course at the moment it is ready to read.
    useEffect(() => {
        if (!tree.some(isCategoryActive)) return;
        setCollapsedKeys(prev => {
            let next: Set<string> | null = null;
            for (const cat of tree) {
                if (isCategoryComplete(cat) && !isCategoryActive(cat) && !prev.has(cat.key)) {
                    next ??= new Set(prev);
                    next.add(cat.key);
                }
            }
            return next ?? prev;
        });
    }, [tree]);

    const toggleCollapse = useCallback((key: string) => {
        setCollapsedKeys(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    }, []);

    if (tree.length === 0) return null;

    const linksBadge = (n: number) => n > 0 && (
        <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
            {t("{{resourceCount}} links", { count: n, resourceCount: n })}
        </span>
    );

    const renderNode = (node: LiveNode): React.JSX.Element => {
        const isActive = node.key === activeNodeKey;
        const hasChildren = node.children.length > 0;
        // A row left "generating" by a run that stopped stopped with it.
        const status: LiveNode['status'] = node.status === 'generating' && !live ? 'cancelled' : node.status;
        // Amber only on the topic that stopped: on its section and phase too, three
        // bold amber headings outweighed the red message that says why.
        const tone = status === 'pending' ? 'text-slate-500 dark:text-slate-400'
            : status === 'cancelled' && !hasChildren ? 'text-amber-700 dark:text-amber-300'
                : 'text-slate-800 dark:text-slate-100';

        // A phase is a heading row that folds its sections away; the whole row
        // is the control, not a 14px chevron beside it.
        if (node.depth === 0) {
            const isCollapsed = collapsedKeys.has(node.key);
            const done = node.children.reduce((n, el) => n + el.children.filter(c => c.status === 'created').length, 0);
            const total = node.children.reduce((n, el) => n + el.children.length, 0);
            const Chevron = isCollapsed ? ChevronRight : ChevronDown;
            return (
                <li key={node.key} className="mt-2 first:mt-0">
                    <button
                        type="button"
                        ref={isActive ? setActiveRow : undefined}
                        {...(isActive ? { [ACTIVE_ROW_ATTR]: '' } : {})}
                        onClick={() => toggleCollapse(node.key)}
                        disabled={!hasChildren}
                        aria-expanded={hasChildren ? !isCollapsed : undefined}
                        className={cx(
                            'flex w-full min-h-10 items-start gap-2 rounded-lg px-2 py-2.5 text-left',
                            'can-hover:enabled:hover:bg-slate-100 dark:can-hover:enabled:hover:bg-slate-700/60 disabled:cursor-default',
                            FOCUS_RING,
                        )}
                    >
                        <Lead><Chevron className={cx('h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400', !hasChildren && 'invisible')} aria-hidden="true" /></Lead>
                        <Lead><StatusIcon status={status} /></Lead>
                        <span className={cx('min-w-0 flex-1 break-words text-sm font-semibold', tone)}>{node.title}</span>
                        {total > 0 && (
                            <span className="shrink-0 text-xs leading-5 tabular-nums text-slate-500 dark:text-slate-400">{done}/{total}</span>
                        )}
                    </button>
                    {hasChildren && !isCollapsed && (
                        <ul className="ml-4 border-l border-slate-200 pl-2 dark:border-slate-700">
                            {node.children.map(renderNode)}
                        </ul>
                    )}
                </li>
            );
        }

        return (
            <li key={node.key}>
                <div
                    ref={isActive ? setActiveRow : undefined}
                    aria-current={isActive ? 'step' : undefined}
                    {...(isActive ? { [ACTIVE_ROW_ATTR]: '' } : {})}
                    className={cx(
                        'flex min-h-8 items-start gap-2 rounded-md px-2 py-1.5',
                        isActive && 'bg-accent/10 dark:bg-accent/20',
                    )}
                >
                    <Lead><StatusIcon status={status} /></Lead>
                    {/* Wraps: cut to "Ни…" on a phone, a topic said nothing. */}
                    <span className={cx('min-w-0 flex-1 break-words text-sm', tone, (hasChildren || isActive) && 'font-medium')}>
                        {node.title}
                    </span>
                    {!hasChildren && linksBadge(node.resourceCount)}
                </div>
                {hasChildren && (
                    <ul className="ml-4 border-l border-slate-200 pl-2 dark:border-slate-700">
                        {node.children.map(renderNode)}
                    </ul>
                )}
            </li>
        );
    };

    return (
        // -mx-2: the rows' own padding, so their text lines up with the head's.
        <ul aria-label={t("Outline")} className="-mx-2">
            {tree.map(renderNode)}
        </ul>
    );
}

export function ActivityLog({ entries }: { entries: LogEntry[] }) {
    if (entries.length === 0) return null;
    return (
        <ul className="space-y-2">
            {entries.map((entry) => {
                const isRunning = entry.status === 'running';
                const isError = entry.status === 'error';
                const isWarning = entry.status === 'warning';
                const isSuccess = entry.status === 'success';
                return (
                    <li key={entry.id} className="flex gap-2.5 items-start">
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
                            <p className={`text-sm ${isError
                                ? 'text-red-700 dark:text-red-300'
                                : isWarning
                                    ? 'text-amber-700 dark:text-amber-300'
                                    : isSuccess
                                        ? 'text-slate-700 dark:text-slate-300'
                                        : 'text-slate-600 dark:text-slate-400'
                                }`}>
                                {entry.message}
                            </p>
                            {isError && entry.error && (
                                <p className="text-xs text-red-600 dark:text-red-400 mt-0.5 font-mono break-all">
                                    {entry.error}
                                </p>
                            )}
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}
