import { useState, useMemo, useCallback } from 'react';
import { api } from '../api';
import {
  DndContext, DragEndEvent, closestCenter,
  PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '../store';
import { safeHref } from '../utils/url';
import {
  Plus, ExternalLink, Trash2, Link2, Video, BookOpen, FileText,
  GripVertical, Edit2, CheckCircle2, Circle,
  FileCode2, Wrench, GraduationCap, Globe, Keyboard,
  Sparkles, Loader2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { k } from '../i18n';

// Type configuration

interface TypeConfig {
  icon: typeof FileText;
  label: string;
  accent: string;         // Tailwind text color
  bg: string;             // Tailwind bg color
  border: string;         // Tailwind border color
  dot: string;            // Raw CSS color for the dot
}

const TYPE_CONFIG: Record<string, TypeConfig> = {
  article: { icon: FileText, label: k("Article"), accent: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-900/20', border: 'border-blue-200 dark:border-blue-800/40', dot: '#3b82f6' },
  video: { icon: Video, label: k("Video"), accent: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20', border: 'border-rose-200 dark:border-rose-800/40', dot: '#f43f5e' },
  book: { icon: BookOpen, label: k("Book"), accent: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-amber-200 dark:border-amber-800/40', dot: '#f59e0b' },
  documentation: { icon: FileCode2, label: k("Docs"), accent: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20', border: 'border-emerald-200 dark:border-emerald-800/40', dot: '#10b981' },
  tutorial: { icon: GraduationCap, label: k("Tutorial"), accent: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-900/20', border: 'border-violet-200 dark:border-violet-800/40', dot: '#8b5cf6' },
  tool: { icon: Wrench, label: k("Tool"), accent: 'text-slate-700 dark:text-slate-200', bg: 'bg-slate-100 dark:bg-slate-600/50', border: 'border-slate-300 dark:border-slate-500/50', dot: '#94a3b8' },
  course: { icon: Globe, label: k("Course"), accent: 'text-indigo-600 dark:text-indigo-400', bg: 'bg-indigo-50 dark:bg-indigo-900/20', border: 'border-indigo-200 dark:border-indigo-800/40', dot: '#6366f1' },
  course_link: { icon: Globe, label: k("Course"), accent: 'text-indigo-600 dark:text-indigo-400', bg: 'bg-indigo-50 dark:bg-indigo-900/20', border: 'border-indigo-200 dark:border-indigo-800/40', dot: '#6366f1' },
  practice: { icon: Keyboard, label: k("Practice"), accent: 'text-cyan-600 dark:text-cyan-400', bg: 'bg-cyan-50 dark:bg-cyan-900/20', border: 'border-cyan-200 dark:border-cyan-800/40', dot: '#06b6d4' },
  link: { icon: Link2, label: k("Link"), accent: 'text-sky-600 dark:text-sky-400', bg: 'bg-sky-50 dark:bg-sky-900/20', border: 'border-sky-200 dark:border-sky-800/40', dot: '#0ea5e9' },
};

function getTypeConfig(type: string): TypeConfig {
  return TYPE_CONFIG[type] || TYPE_CONFIG.link;
}

// URL helpers

function extractDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

function detectTypeFromUrl(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const p = new URL(url).pathname.toLowerCase();
    if (h.includes('youtube.com') || h.includes('youtu.be') || h.includes('vimeo.com')) return 'video';
    if (h.includes('github.com')) return 'documentation';
    if (h.includes('docs.') || p.includes('/docs/') || p.includes('/documentation/')) return 'documentation';
    if (h.includes('medium.com') || h.includes('dev.to') || h.includes('blog.')) return 'article';
    if (h.includes('udemy.com') || h.includes('coursera.org') || h.includes('edx.org') || h.includes('pluralsight.com')) return 'course';
    return 'link';
  } catch { return 'link'; }
}

function looksLikeUrl(text: string): boolean {
  return /^https?:\/\//i.test(text.trim()) || /^www\./i.test(text.trim());
}

// Sortable resource card

function ResourceCard({ resource, onToggle, onEdit, onDelete }: {
  resource: any;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t: tr } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: resource.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const cfg = getTypeConfig(resource.type);
  // Never put a stored URL straight into an href: rows imported before the
  // write-path guard existed can still hold a javascript: URL, which in an href
  // is script execution in this app's own origin. An unsafe URL renders the
  // title as plain text instead of a link.
  const href = safeHref(resource.url);
  const domain = href ? extractDomain(href) : '';
  const Icon = cfg.icon;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-stretch rounded-xl border transition-all duration-150
                        ${resource.completed
          ? 'bg-emerald-50/40 dark:bg-emerald-900/10 border-emerald-200/50 dark:border-emerald-800/30'
          : 'bg-slate-50 dark:bg-slate-900/40 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 hover:shadow-sm'
        }`}
    >
      {/* Left color accent */}
      <div className="w-1 rounded-l-xl shrink-0" style={{ backgroundColor: cfg.dot, opacity: resource.completed ? 0.35 : 1 }} />

      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        aria-label={tr("Drag to reorder resource")}
        className="flex items-center px-1.5 cursor-grab active:cursor-grabbing text-slate-300 dark:text-slate-600
                           hover:text-slate-500 dark:hover:text-slate-400 transition-opacity touch-none
                           can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:focus-visible:opacity-100"
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>

      {/* Completion checkbox */}
      <button
        onClick={onToggle}
        className="flex items-center pl-1 pr-1 shrink-0"
        title={resource.completed ? tr("Mark incomplete") : tr("Mark complete")}
      >
        {resource.completed
          ? <CheckCircle2 className="w-[18px] h-[18px] text-emerald-500" />
          : <Circle className="w-[18px] h-[18px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors" />
        }
      </button>

      {/* Main content */}
      <div className="flex-1 min-w-0 py-2 pr-2">
        <div className="flex items-center gap-2">
          <Icon className={`w-3.5 h-3.5 shrink-0 ${cfg.accent} ${resource.completed ? 'opacity-40' : ''}`} />
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className={`text-sm truncate hover:underline ${resource.completed ? 'line-through text-slate-500 dark:text-slate-200' : 'text-slate-800 dark:text-slate-200'}`}
            >
              {resource.title}
            </a>
          ) : (
            <span className={`text-sm truncate ${resource.completed ? 'line-through text-slate-500 dark:text-slate-200' : 'text-slate-800 dark:text-slate-200'}`}>
              {resource.title}
            </span>
          )}
        </div>

        {/* Domain + type pill */}
        <div className="flex items-center gap-2 mt-0.5 min-w-0">
          {domain && (
            <span className="text-[12px] text-slate-400 dark:text-slate-300 truncate min-w-0">
              {domain}
            </span>
          )}
          <span className={`inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium leading-none ${cfg.bg} ${cfg.accent}`}>
            {tr(cfg.label)}
          </span>
        </div>
      </div>

      {/* Actions */}
      {/* Open / Edit / Delete. Revealed on hover where hovering is possible; on a
          touchscreen there is no hover, so they stay visible instead of vanishing. */}
      <div className="flex items-center gap-0.5 pr-2 transition-opacity shrink-0
                      can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:focus-within:opacity-100">
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="p-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:text-accent-fg hover:bg-accent/10 transition-colors"
            title={tr("Open link")}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
        <button
          onClick={onEdit}
          className="p-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
          title={tr("Edit")}
        >
          <Edit2 className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onDelete}
          className="p-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          title={tr("Delete")}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// Main component

const ALL_TYPES = Object.keys(TYPE_CONFIG);

export default function ResourceList({ nodeId }: { nodeId: number }) {
  const { t: tr } = useTranslation();
  const resources = useStore(s => s.resources);
  const createResource = useStore(s => s.createResource);
  const updateResource = useStore(s => s.updateResource);
  const deleteResource = useStore(s => s.deleteResource);
  const reorderResources = useStore(s => s.reorderResources);

  const [quickAddText, setQuickAddText] = useState('');
  const [showExpandedAdd, setShowExpandedAdd] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addType, setAddType] = useState('link');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editType, setEditType] = useState('link');
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  // Derived
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of resources) {
      counts[r.type] = (counts[r.type] || 0) + 1;
    }
    return counts;
  }, [resources]);

  const completedCount = useMemo(() => resources.filter(r => r.completed).length, [resources]);

  const filteredResources = useMemo(() => {
    if (!typeFilter) return resources;
    return resources.filter(r => r.type === typeFilter);
  }, [resources, typeFilter]);

  const handleQuickAdd = useCallback(async () => {
    const text = quickAddText.trim();
    if (!text) return;

    const isUrl = looksLikeUrl(text);
    const url = isUrl ? (text.startsWith('http') ? text : `https://${text}`) : '';
    const title = isUrl ? extractDomain(url) || text : text;
    const type = isUrl ? detectTypeFromUrl(url) : 'link';

    await createResource({ node_id: nodeId, title, url, type });
    setQuickAddText('');
  }, [quickAddText, nodeId, createResource]);

  const handleQuickAddKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleQuickAdd(); }
  }, [handleQuickAdd]);

  const handleExpandedAdd = useCallback(async () => {
    if (!addTitle.trim()) return;
    const url = addUrl.trim();
    const finalUrl = url && !url.startsWith('http') ? `https://${url}` : url;
    await createResource({ node_id: nodeId, title: addTitle, url: finalUrl, type: addType });
    setAddTitle('');
    setAddUrl('');
    setAddType('link');
    setShowExpandedAdd(false);
  }, [addTitle, addUrl, addType, nodeId, createResource]);

  const startEdit = useCallback((resource: typeof resources[0]) => {
    setEditingId(resource.id);
    setEditTitle(resource.title);
    setEditUrl(resource.url);
    setEditType(resource.type);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingId) return;
    await updateResource(editingId, { title: editTitle, url: editUrl, type: editType });
    setEditingId(null);
  }, [editingId, editTitle, editUrl, editType, updateResource]);

  const cancelEdit = useCallback(() => setEditingId(null), []);

  const confirmDelete = useCallback(async (id: number) => {
    await deleteResource(id);
    setDeleteConfirmId(null);
  }, [deleteResource]);

  const toggleComplete = useCallback(async (id: number, current: number) => {
    await updateResource(id, { completed: current ? 0 : 1 });
  }, [updateResource]);

  // On-demand resource curation.
  //
  // Project creation can be told to SKIP per-topic link hunting (Settings →
  // AI & Models → "Resource hunting"), because paying for a web search plus a
  // model call on all 700 leaves up front is its single biggest cost. This is
  // where that cost gets paid instead: once, for the topic actually being
  // studied. Appends only — it never touches links already in the list.
  const findResources = useCallback(async () => {
    if (finding) return;
    setFinding(true);
    try {
      const res = await api.findNodeResources(nodeId);
      await useStore.getState().loadResources(nodeId);
      useStore.getState().addToast(
        res.added > 0 ? 'success' : 'info',
        res.added > 0 ? tr("Added {{count}} resources", { count: res.added }) : tr("No new resources found"),
        res.added > 0 ? undefined : tr("The search came back with nothing this topic didn’t already have."),
      );
    } catch (e: any) {
      useStore.getState().addToast('error', tr("Could not find resources"), e.message);
    } finally {
      setFinding(false);
    }
  }, [nodeId, finding]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = resources.findIndex(r => r.id === active.id);
    const newIdx = resources.findIndex(r => r.id === over.id);
    if (oldIdx !== -1 && newIdx !== -1) {
      await reorderResources(arrayMove(resources, oldIdx, newIdx).map(r => r.id));
    }
  }, [resources, reorderResources]);

  // RENDER

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-300 flex items-center gap-1.5">
          <Link2 className="w-3 h-3" />
          {tr("Resources")}
          {resources.length > 0 && (
            <span className="font-normal normal-case tracking-normal">
              · {completedCount}/{resources.length}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1">
          <button
            onClick={findResources}
            disabled={finding}
            title={tr("Search the web and add the best links for this topic")}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium
                                 text-accent-fg hover:bg-accent/10 disabled:opacity-60 transition-colors"
          >
            {finding
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Sparkles className="w-3 h-3" />}
            {finding ? tr("Searching…") : tr("Find")}
          </button>
          <button
            onClick={() => setShowExpandedAdd(v => !v)}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium
                                 text-accent-fg hover:bg-accent/10 transition-colors"
          >
            <Plus className="w-3 h-3" />
            {tr("Add")}
          </button>
        </span>
      </div>

      {/* Quick-add bar */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 relative">
          <Plus className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-300 dark:text-slate-600" />
          <input
            value={quickAddText}
            onChange={e => setQuickAddText(e.target.value)}
            onKeyDown={handleQuickAddKeyDown}
            placeholder={tr("Paste a URL or type a title…")}
            className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700
                                   bg-white dark:bg-slate-800 text-slate-900 dark:text-white
                                   placeholder:text-slate-300 dark:placeholder:text-slate-600
                                   focus:ring-2 focus:ring-accent focus:border-accent transition-colors"
          />
        </div>
      </div>

      {/* Expanded add form */}
      {showExpandedAdd && (
        <div className="p-3 mb-3 bg-slate-50 dark:bg-slate-900/40 rounded-xl border border-slate-200 dark:border-slate-700 space-y-3 animate-fade-in">
          <input
            value={addTitle}
            onChange={e => setAddTitle(e.target.value)}
            placeholder={tr("Title")}
            className="w-full px-3 py-2 text-sm border border-slate-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
            autoFocus
          />
          <input
            value={addUrl}
            onChange={e => setAddUrl(e.target.value)}
            placeholder={tr("URL (optional)")}
            className="w-full px-3 py-2 text-sm border border-slate-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
          />
          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">{tr("Type")}</label>
            <div className="flex flex-wrap gap-1.5">
              {ALL_TYPES.map(t => {
                const c = TYPE_CONFIG[t];
                const Icon = c.icon;
                const active = addType === t;
                return (
                  <button
                    key={t}
                    onClick={() => setAddType(t)}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors
                                            ${active ? `${c.bg} ${c.accent} ring-1 ring-current` : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
                  >
                    <Icon className="w-3 h-3" />
                    {tr(c.label)}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowExpandedAdd(false)} className="px-3 py-1.5 text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg">{tr("Cancel")}</button>
            <button
              onClick={handleExpandedAdd}
              disabled={!addTitle.trim()}
              className="px-3 py-1.5 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-40 transition-colors"
            >
              {tr("Add Resource")}
            </button>
          </div>
        </div>
      )}

      {/* Type filter pills */}
      {resources.length > 5 && (
        <div className="flex items-center gap-1 mb-3 flex-wrap">
          <button
            onClick={() => setTypeFilter(null)}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors
                            ${!typeFilter ? 'bg-slate-200 dark:bg-slate-600 text-slate-700 dark:text-slate-200' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
          >
            {tr("All ({{length}})", { length: resources.length })}
          </button>
          {Object.entries(typeCounts).map(([type, count]) => {
            const c = TYPE_CONFIG[type] || TYPE_CONFIG.link;
            return (
              <button
                key={type}
                onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors
                                    ${typeFilter === type ? `${c.bg} ${c.accent}` : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
              >
                {tr(c.label)} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Completion progress bar */}
      {resources.length > 1 && (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-slate-400">{tr("Progress")}</span>
            <span className="text-[10px] text-slate-500 dark:text-slate-400 font-medium tabular-nums">
              {completedCount}/{resources.length}
            </span>
          </div>
          <div className="h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${resources.length > 0 ? (completedCount / resources.length) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Resource list */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={filteredResources.map(r => r.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-1.5">
            {filteredResources.map(resource => (
              <div key={resource.id}>
                {/* Inline edit mode */}
                {editingId === resource.id ? (
                  <div className="p-3 bg-accent/10 rounded-xl border border-accent/30 space-y-2 animate-fade-in">
                    <input
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-sm border border-slate-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                      autoFocus
                    />
                    <input
                      value={editUrl}
                      onChange={e => setEditUrl(e.target.value)}
                      placeholder={tr("URL")}
                      className="w-full px-2.5 py-1.5 text-sm border border-slate-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                    />
                    <div className="flex flex-wrap gap-1">
                      {ALL_TYPES.slice(0, 7).map(t => {
                        const c = TYPE_CONFIG[t];
                        const active = editType === t;
                        return (
                          <button
                            key={t}
                            onClick={() => setEditType(t)}
                            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors
                                                            ${active ? `${c.bg} ${c.accent}` : 'text-slate-400 hover:bg-white dark:hover:bg-slate-600'}`}
                          >
                            {tr(c.label)}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex justify-end gap-2">
                      <button onClick={cancelEdit} className="px-2.5 py-1 text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md">{tr("Cancel")}</button>
                      <button onClick={saveEdit} className="px-2.5 py-1 text-xs font-medium bg-accent text-white rounded-md hover:bg-accent/90">{tr("Save")}</button>
                    </div>
                  </div>
                ) : (
                  /* Delete confirmation */
                  deleteConfirmId === resource.id ? (
                    <div className="flex items-center justify-between p-3 bg-red-50 dark:bg-red-900/10 rounded-xl border border-red-200 dark:border-red-800/40 animate-fade-in">
                      <span className="text-sm text-red-700 dark:text-red-300">{tr("Delete \"{{title}}\"?", { title: resource.title })}</span>
                      <div className="flex gap-2">
                        <button onClick={() => setDeleteConfirmId(null)} className="px-2.5 py-1 text-xs text-slate-500 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-700 rounded-md">{tr("Cancel")}</button>
                        <button onClick={() => confirmDelete(resource.id)} className="px-2.5 py-1 text-xs font-medium bg-red-600 text-white rounded-md hover:bg-red-700">{tr("Delete")}</button>
                      </div>
                    </div>
                  ) : (
                    <ResourceCard
                      resource={resource}
                      onToggle={() => toggleComplete(resource.id, resource.completed)}
                      onEdit={() => startEdit(resource)}
                      onDelete={() => setDeleteConfirmId(resource.id)}
                    />
                  )
                )}
              </div>
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Empty state */}
      {resources.length === 0 && (
        <div className="py-8 text-center">
          <div className="flex flex-col items-center gap-2 text-slate-500 dark:text-slate-400">
            <Link2 className="w-10 h-10 opacity-30" />
            <p className="text-sm font-medium">{tr("No resources yet")}</p>
            <p className="text-xs opacity-60 max-w-[200px]">{tr("Paste a URL above to get started, or click Add for more options")}</p>
          </div>
        </div>
      )}
    </div>
  );
}