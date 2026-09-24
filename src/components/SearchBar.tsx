import { useEffect, useRef, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { modShortcut, usePhysicalKeyboard } from '../utils/platform';
import type {
    SearchResultItem,
    SearchProjectResult,
    SearchNodeResult,
    SearchResourceResult,
    SearchDocumentResult,
} from '../types';
import {
    Search, X, Folder, FileText, Link, BookOpen,
    Loader2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { k } from '../i18n';

function useDebounce<T>(value: T, delay: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);
    return debounced;
}

// Category config (keys match SearchResultItem.type — singular)

const CATEGORIES = [
    { key: 'project' as const, label: k("Projects"), icon: Folder, color: 'text-accent-fg', bg: 'bg-[color-mix(in_srgb,rgb(var(--accent-rgb))_10%,white)] dark:bg-[color-mix(in_srgb,rgb(var(--accent-rgb))_10%,#1e293b)]' },
    { key: 'node' as const, label: k("Topics"), icon: FileText, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
    { key: 'resource' as const, label: k("Resources"), icon: Link, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
    { key: 'document' as const, label: k("Documents"), icon: BookOpen, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950' },
];

function getItemColor(item: SearchResultItem): string {
    switch (item.type) {
        case 'project': return item.color;
        case 'node': return item.projectColor || '#3B82F6';
        case 'resource': return item.projectColor || '#3B82F6';
        case 'document': return item.projectColor || '#3B82F6';
    }
}

function getItemSubtitle(item: SearchResultItem): string {
    switch (item.type) {
        case 'project':
            return '';
        case 'node':
            return item.projectName || '';
        case 'resource':
            if (item.projectName && item.nodeTitle) {
                return `${item.projectName} / ${item.nodeTitle}`;
            }
            return item.nodeTitle || item.projectName || '';
        case 'document':
            return item.projectName || '';
    }
}

function getItemSnippet(item: SearchResultItem): string {
    switch (item.type) {
        case 'project': return item.snippet;
        case 'node': return item.snippet;
        case 'resource': return item.snippet;
        case 'document': return item.snippet;
    }
}

function getItemMatchField(item: SearchResultItem): string {
    switch (item.type) {
        case 'project': return item.matchField;
        case 'node': return item.matchField;
        case 'resource': return item.matchField;
        case 'document': return item.matchField;
    }
}

function getItemMatchRanges(item: SearchResultItem): Array<{ start: number; end: number }> {
    switch (item.type) {
        case 'project': return item.matchRanges;
        case 'node': return item.matchRanges;
        case 'resource': return item.matchRanges;
        case 'document': return item.matchRanges;
    }
}

function HighlightedText({ text, ranges }: { text: string; ranges: Array<{ start: number; end: number }> }) {
    if (ranges.length === 0) return <>{text}</>;

    const parts: JSX.Element[] = [];
    let last = 0;
    let key = 0;

    for (const { start, end } of ranges) {
        if (start < last) continue;
        if (start > last) {
            parts.push(<span key={key++}>{text.slice(last, start)}</span>);
        }
        parts.push(
            <mark
                key={key++}
                className="bg-yellow-200 dark:bg-yellow-800/60 text-yellow-900 dark:text-yellow-100 rounded-sm"
            >
                {text.slice(start, end)}
            </mark>
        );
        last = end;
    }
    if (last < text.length) {
        parts.push(<span key={key++}>{text.slice(last)}</span>);
    }
    return <>{parts}</>;
}

function ResultItem({
    item,
    isSelected,
    onSelect,
}: {
    item: SearchResultItem;
    isSelected: boolean;
    onSelect: () => void;
}) {
    const { t: tr } = useTranslation();
    const cat = CATEGORIES.find(c => c.key === item.type) || CATEGORIES[1];
    const Icon = cat.icon;
    const color = getItemColor(item);

    const subtitle = getItemSubtitle(item);

    const snippet = getItemSnippet(item);
    const matchField = getItemMatchField(item);
    const matchRanges = getItemMatchRanges(item);

    return (
        <button
            className={`w-full flex items-start gap-3 px-4 py-3 text-left border-b border-slate-100 dark:border-slate-700 last:border-0 ${isSelected
                ? 'bg-accent/10 ring-2 ring-inset ring-accent/60'
                : 'transition-colors hover:bg-slate-50 dark:hover:bg-slate-700/50'
                }`}
            onClick={onSelect}
        >
            <div
                className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                style={{ backgroundColor: color + '20' }}
            >
                <Icon className="w-4 h-4" style={{ color }} />
            </div>
            <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-900 dark:text-white truncate">
                    <HighlightedText text={item.title} ranges={matchRanges} />
                </p>

                {(subtitle || (matchField && matchField !== 'title')) && (
                    <div className="flex items-center gap-2 mt-0.5">
                        {subtitle && (
                            <span className="text-xs text-slate-500 dark:text-slate-400 truncate">
                                {subtitle}
                            </span>
                        )}
                        {matchField && matchField !== 'title' && (
                            <>
                                {subtitle && (
                                    <span className="text-slate-300 dark:text-slate-600">·</span>
                                )}
                                <span className="text-xs text-slate-500 dark:text-slate-400">
                                    {tr("in {{matchField}}", { matchField })}
                                </span>
                            </>
                        )}
                    </div>
                )}

                {snippet && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">
                        <HighlightedText text={snippet} ranges={matchRanges} />
                    </p>
                )}
            </div>
        </button>
    );
}

export default function SearchBar() {
    const { t: tr } = useTranslation();
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const resultsRef = useRef<HTMLDivElement>(null);
    // Keyboard hints are shown by *capability*, not screen width — a phone in
    // landscape clears `sm:` but still has no keys to press.
    const hasKeyboard = usePhysicalKeyboard();

    const navigate = useNavigate();
    const projects = useStore(s => s.projects);
    const nodes = useStore(s => s.nodes);
    const currentProjectId = useStore(s => s.currentProjectId);
    const searchResults = useStore(s => s.searchResults);
    const searchLoading = useStore(s => s.searchLoading);
    const performSearch = useStore(s => s.performSearch);
    const setSearchOpen = useStore(s => s.setSearchOpen);

    const debouncedQuery = useDebounce(query, 300);

    // Instant frontend fuzzy results (no network)
    const instantResults = useMemo(() => {
        if (query.trim().length < 2) return [];
        const tokens = query.toLowerCase().trim().split(/\s+/).filter(t => t.length >= 2);
        if (tokens.length === 0) return [];

        const results: SearchResultItem[] = [];

        for (const p of projects) {
            const nameMatch = tokens.every(t => p.name.toLowerCase().includes(t));
            const descMatch = tokens.every(t => (p.description || '').toLowerCase().includes(t));
            if (nameMatch || descMatch) {
                results.push({
                    type: 'project',
                    projectId: p.id,
                    title: p.name,
                    color: p.color,
                    icon: p.icon,
                    matchField: nameMatch ? 'title' : 'description',
                    snippet: descMatch && !nameMatch ? (p.description || '').slice(0, 100) : '',
                    matchRanges: [],
                    score: nameMatch ? 0.9 : 0.5,
                });
            }
        }

        for (const n of nodes) {
            if (currentProjectId && n.project_id !== currentProjectId) continue;
            const titleMatch = tokens.every(t => n.title.toLowerCase().includes(t));
            const descMatch = tokens.every(t => (n.description || '').toLowerCase().includes(t));
            const notesMatch = tokens.every(t => (n.notes || '').toLowerCase().includes(t));
            if (titleMatch || descMatch || notesMatch) {
                const project = projects.find(p => p.id === n.project_id);
                const bestField = titleMatch ? 'title' : descMatch ? 'description' : 'notes';
                const snippet = bestField !== 'title'
                    ? (bestField === 'description' ? n.description : n.notes || '').slice(0, 120).replace(/\n/g, ' ')
                    : '';
                results.push({
                    type: 'node',
                    projectId: n.project_id,
                    projectName: project?.name,
                    projectColor: project?.color,
                    nodeId: n.id,
                    title: n.title,
                    status: n.status,
                    matchField: bestField,
                    snippet,
                    matchRanges: [],
                    score: titleMatch ? 0.85 : descMatch ? 0.5 : 0.3,
                });
            }
        }

        return results.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 15);
    }, [query, projects, nodes, currentProjectId]);

    // Combine backend results with instant results, deduplicating by type+id+title
    const allResults = useMemo(() => {
        if (!searchResults) return instantResults;

        const combined: SearchResultItem[] = [];
        const seen = new Set<string>();

        for (const item of [
            ...searchResults.projects,
            ...searchResults.nodes,
            ...searchResults.resources,
            ...searchResults.documents,
        ]) {
            const itemId = item.type === 'node'
                ? (item as SearchNodeResult).nodeId
                : item.type === 'resource'
                    ? (item as SearchResourceResult).nodeId
                    : item.type === 'document'
                        ? (item as SearchDocumentResult).documentId
                        : item.projectId;
            const key = `${item.type}-${itemId}-${item.title}`;
            if (!seen.has(key)) {
                seen.add(key);
                combined.push(item);
            }
        }

        for (const item of instantResults) {
            const itemId = item.type === 'node'
                ? (item as SearchNodeResult).nodeId
                : item.type === 'project'
                    ? (item as SearchProjectResult).projectId
                    : 0;
            const key = `${item.type}-${itemId}-${item.title}`;
            if (!seen.has(key)) {
                seen.add(key);
                combined.push(item);
            }
        }

        return combined
            .sort((a, b) => (b.score || 0) - (a.score || 0))
            .slice(0, 30);
    }, [searchResults, instantResults]);

    // Trigger backend search on debounced query
    useEffect(() => {
        if (debouncedQuery.trim().length >= 2) {
            performSearch(debouncedQuery);
        }
    }, [debouncedQuery, performSearch]);

    // Reset selected index when results change
    useEffect(() => {
        setSelectedIndex(0);
    }, [allResults.length]);

    // Keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // `key` is case-sensitive: with Caps Lock (or Shift) held this is
            // 'K', which silently missed the shortcut.
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setIsOpen(prev => !prev);
            }
            if (e.key === 'Escape' && isOpen) {
                e.preventDefault();
                handleClose();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen]);

    // Focus input when opening
    useEffect(() => {
        if (isOpen) {
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [isOpen]);

    // Auto-scroll selected item into view
    useEffect(() => {
        if (!resultsRef.current) return;
        const selected = resultsRef.current.querySelector('[data-selected="true"]');
        selected?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    const handleClose = () => {
        setIsOpen(false);
        setQuery('');
        setSearchOpen(false);
    };

    const handleResultClick = (item: SearchResultItem) => {
        // Navigate straight to the target URL. The router sync (applyRoute) loads
        // the project if needed and reveals the node (expanding its ancestors),
        // so no manual openProject/expand/select dance is required here.
        if (item.type === 'project') {
            navigate(`/project/${item.projectId}`);
        } else if (item.type === 'node') {
            const nodeItem = item as SearchNodeResult;
            navigate(`/project/${nodeItem.projectId}/tree/${nodeItem.nodeId}`);
        } else if (item.type === 'resource') {
            const resItem = item as SearchResourceResult;
            navigate(`/project/${resItem.projectId}/tree/${resItem.nodeId}`);
            if (resItem.url) {
                window.open(resItem.url, '_blank', 'noopener,noreferrer');
            }
        } else if (item.type === 'document') {
            const docItem = item as SearchDocumentResult;
            navigate(docItem.nodeId
                ? `/project/${docItem.projectId}/tree/${docItem.nodeId}`
                : `/project/${docItem.projectId}`);
        }
        handleClose();
    };

    // Keyboard navigation within results (walks display/grouped order)
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(i => Math.min(i + 1, displayResults.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter' && displayResults[selectedIndex]) {
            e.preventDefault();
            handleResultClick(displayResults[selectedIndex]);
        }
    };

    // Group results by category for display
    const groupedResults = useMemo(() => {
        const groups: Record<string, SearchResultItem[]> = {};
        for (const item of allResults) {
            const key = item.type;
            if (!groups[key]) groups[key] = [];
            groups[key].push(item);
        }
        return groups;
    }, [allResults]);

    // Flattened in *display* (grouped) order — keyboard navigation walks this so
    // the highlight moves one visible row at a time instead of following the
    // score-sorted order of `allResults` (which interleaves categories).
    const displayResults = useMemo(
        () => Object.values(groupedResults).flat(),
        [groupedResults]
    );

    const totalResults = displayResults.length;

    return (
        <>
            <button
                type="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setIsOpen(true); }}
                aria-label={tr("Search")}
                className="flex items-center gap-2 px-2 sm:px-3 py-1.5 text-sm text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition"
            >
                <Search className="w-4 h-4" />
                <span className="hidden sm:inline">{tr("Search…")}</span>
                {hasKeyboard && (
                    <kbd className="px-1.5 py-0.5 text-xs bg-slate-200 dark:bg-slate-700 rounded">{modShortcut('K')}</kbd>
                )}
            </button>

            {isOpen && createPortal(
                <div className="fixed inset-0 z-[9999]">
                    <div className="absolute inset-0 bg-black/50" onClick={handleClose} />

                    <div className="absolute inset-0 flex items-start justify-center pt-[10vh] pointer-events-none">
                        <div
                            className="w-full max-w-2xl mx-4 bg-white dark:bg-slate-800 rounded-2xl shadow-2xl overflow-hidden pointer-events-auto"
                            onClick={e => e.stopPropagation()}
                        >
                            <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-700">
                                <Search className="w-5 h-5 text-slate-400 shrink-0" />
                                <input
                                    ref={inputRef}
                                    type="text"
                                    value={query}
                                    onChange={e => setQuery(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    placeholder={tr("Search projects, topics, resources, documents…")}
                                    className="flex-1 bg-transparent text-slate-900 dark:text-white placeholder-slate-400 outline-none text-base"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    autoCapitalize="off"
                                    spellCheck={false}
                                />
                                {searchLoading && (
                                    <Loader2 className="w-4 h-4 text-accent-fg animate-spin shrink-0" />
                                )}
                                <button
                                    type="button"
                                    onClick={handleClose}
                                    aria-label={tr("Close search")}
                                    className="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded shrink-0"
                                >
                                    <X className="w-5 h-5 text-slate-400" />
                                </button>
                            </div>

                            <div ref={resultsRef} className="max-h-[60vh] overflow-auto">
                                {totalResults > 0 ? (
                                    Object.entries(groupedResults).map(([category, items]) => {
                                        const catConfig = CATEGORIES.find(c => c.key === category);
                                        if (!catConfig || items.length === 0) return null;
                                        const CatIcon = catConfig.icon;

                                        return (
                                            <div key={category}>
                                                <div className={`px-4 py-2 text-xs font-semibold ${catConfig.bg} ${catConfig.color} sticky top-0 z-10`}>
                                                    <span className="flex items-center gap-1.5">
                                                        <CatIcon className="w-3 h-3" />
                                                        {tr(catConfig.label)}
                                                        <span className="text-slate-500 dark:text-slate-400 font-normal">({items.length})</span>
                                                    </span>
                                                </div>
                                                {items.map((item, idx) => {
                                                    const globalIdx = displayResults.indexOf(item);
                                                    return (
                                                        <div key={`${category}-${idx}`} data-selected={globalIdx === selectedIndex}>
                                                            <ResultItem
                                                                item={item}
                                                                isSelected={globalIdx === selectedIndex}
                                                                onSelect={() => handleResultClick(item)}
                                                            />
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        );
                                    })
                                ) : query.trim().length >= 2 ? (
                                    <div className="px-4 py-8 text-center">
                                        <Search className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                                        <p className="text-sm text-slate-500 dark:text-slate-400">
                                            {tr("No results for “{{query}}”", { query })}
                                        </p>
                                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                                            {tr("Try different keywords or check for typos")}
                                        </p>
                                    </div>
                                ) : (
                                    <div className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
                                        <p className="text-sm">{tr("Start typing to search…")}</p>
                                        <p className="text-xs mt-1 text-slate-500 dark:text-slate-400">
                                            {tr("Searches projects, topics, resources, and documents")}
                                        </p>
                                    </div>
                                )}
                            </div>

                            {totalResults > 0 && (
                                <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                                    <span>
                                        {tr("{{totalResults}} results", { count: totalResults, totalResults })}
                                        {searchLoading && tr("· searching...")}
                                    </span>
                                    <div className={`items-center gap-3 ${hasKeyboard ? 'flex' : 'hidden'}`}>
                                        <span>
                                            <kbd className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded">↑↓</kbd> {tr("navigate")}
                                        </span>
                                        <span>
                                            <kbd className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded">↵</kbd> {tr("open")}
                                        </span>
                                        <span>
                                            <kbd className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded">esc</kbd> {tr("close")}
                                        </span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </>
    );
}