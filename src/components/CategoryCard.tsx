import { useState, useMemo } from 'react';
import { onActivateKey } from '../utils/a11y';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  DragMoveEvent,
  DragOverlay,
  closestCenter,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  MeasuringStrategy,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useStore } from '../store';
import ProgressRing from './ProgressRing';
import TreeItemRow from './TreeItemRow';
import DropdownMenu from './DropdownMenu';
import Modal from './Modal';
import { TreeNode } from '../types';
import {
  INDENTATION_WIDTH,
  flattenVisible,
  removeDescendants,
  getProjection,
  getDropPosition,
  isDescendantTarget,
} from '../utils/treeDnd';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  MoreVertical,
  FolderOpen,
  FileText,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  node: TreeNode;
  isDragOverlay?: boolean;
  /** Grid-level drop hint while another card is dragged over this one. */
  dropIndicator?: 'before' | 'after' | 'inside' | null;
}

export default function CategoryCard({ node, isDragOverlay, dropIndicator }: Props) {
  const { t } = useTranslation();
  const selectNode = useStore((s) => s.selectNode);
  const createNode = useStore((s) => s.createNode);
  const deleteNode = useStore((s) => s.deleteNode);
  const expanded = useStore((s) => s.expanded);
  const toggleExpanded = useStore((s) => s.toggleExpanded);
  const setExpanded = useStore((s) => s.setExpanded);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const projects = useStore((s) => s.projects);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const moveNode = useStore((s) => s.moveNode);
  const showConfirm = useStore((s) => s.showConfirm);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newItemTitle, setNewItemTitle] = useState('');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const [dragOffsetX, setDragOffsetX] = useState(0);

  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: node.id, disabled: isDragOverlay });

  const sensors = useSensors(
    // Desktop: start dragging as soon as the mouse moves a little.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // Touch: require a short press-and-hold so a normal swipe scrolls instead of reordering.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
  );

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
    zIndex: isDragging ? 1000 : undefined,
  };

  const project = projects.find((p) => p.id === currentProjectId);
  const isExpanded = expanded[node.id] ?? true;
  const progress = node.progress?.percentage || 0;
  const isNote = !!node.is_note;

  const allFlatItems = useMemo(
    () => flattenVisible(node.children, expanded, node.id, 0, [node.id]),
    [node, expanded]
  );

  const flatItems = useMemo(() => {
    if (activeId == null) return allFlatItems;
    return removeDescendants(allFlatItems, activeId);
  }, [allFlatItems, activeId]);

  const flatIds = useMemo(() => flatItems.map((i) => i.id), [flatItems]);

  const projection = useMemo(() => {
    if (activeId == null || overId == null) return null;
    return getProjection(flatItems, activeId, overId, dragOffsetX, node.id);
  }, [flatItems, activeId, overId, dragOffsetX, node.id]);

  // The item the dragged row would nest INSIDE (depth > 0). When depth is 0 the
  // drop lands at the category's top level, so there is no parent item to point at.
  const dropParentId = projection && projection.depth > 0 ? projection.parentId : null;
  const dropParentTitle = dropParentId != null
    ? (allFlatItems.find((i) => i.id === dropParentId)?.node.title ?? null)
    : null;

  const handleAddChild = async () => {
    if (!newItemTitle.trim()) return;
    await createNode({ title: newItemTitle, parent_id: node.id });
    if (!expanded[node.id]) setExpanded(node.id, true);
    setShowAddModal(false);
    setNewItemTitle('');
  };

  const handleDelete = async () => {
    const confirmed = await showConfirm({
      title: t("Delete Category"),
      message: t("Delete \"{{title}}\" and all its contents? This action cannot be undone.", { title: node.title }),
      confirmLabel: t("Delete"),
      variant: 'danger',
    });
    if (!confirmed) return;
    await deleteNode(node.id);
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as number);
    setOverId(event.active.id as number);
    setDragOffsetX(0);
  };

  const handleDragMove = (event: DragMoveEvent) => {
    setDragOffsetX(event.delta.x);
    if (event.over) setOverId(event.over.id as number);
  };

  const handleDragOver = (event: any) => {
    if (event.over) setOverId(event.over.id as number);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const currentActiveId = activeId;
    const currentProjection = projection;
    setActiveId(null);
    setOverId(null);
    setDragOffsetX(0);
    if (!currentActiveId || !event.over || !currentProjection) return;
    const { parentId: newParentId } = currentProjection;
    // Never allow dropping a node into its own subtree.
    if (isDescendantTarget(allFlatItems, currentActiveId, newParentId)) return;
    const overId = event.over.id as number;
    const position = getDropPosition(flatItems, currentActiveId, overId, currentProjection);
    await moveNode(currentActiveId, newParentId, position);
    if (newParentId != null && newParentId !== node.id) setExpanded(newParentId, true);
  };

  const handleDragCancel = () => { setActiveId(null); setOverId(null); setDragOffsetX(0); };

  const progressColor = progress === 100 ? '#22C55E' : project?.color || '#8B5CF6';
  const cardColor = isNote ? '#64748B' : project?.color || '#8B5CF6';

  return (
    <>
      {/* A card must read as a raised surface, not as an outline. In light mode
          the canvas is one step off white (slate-100) and the card is white +
          shadow — the treatment every other card in the app already had
          (StudyDashboard, ProjectCard) and this board did not, so twelve
          categories sat on the page as faint rectangles. */}
      <div
        ref={setNodeRef}
        style={style}
        data-category-id={node.id}
        data-node-id={node.id}
        className={`relative bg-white dark:bg-slate-800 rounded-2xl border shadow-sm transition ${selectedNodeId === node.id
          ? 'border-accent/40 dark:border-accent shadow-md'
          : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 hover:shadow-md'
          } ${isDragging ? 'shadow-2xl' : ''} ${dropIndicator === 'inside' ? 'ring-2 ring-accent ring-offset-2 ring-offset-slate-100 dark:ring-offset-slate-900' : ''}`}
      >
        {/* Grid drop hints: a bar in the gutter for reorder, a badge for nesting. */}
        {dropIndicator === 'before' && (
          <div className="absolute -left-2.5 top-3 bottom-3 w-1 rounded-full bg-accent z-10" />
        )}
        {dropIndicator === 'after' && (
          <div className="absolute -right-2.5 top-3 bottom-3 w-1 rounded-full bg-accent z-10" />
        )}
        {dropIndicator === 'inside' && (
          <div className="absolute top-2 right-2 z-10 text-[11px] font-medium bg-accent text-white px-2 py-0.5 rounded-full shadow">
            {t("Drop to nest")}
          </div>
        )}
        {/* Header band. Light: slate-50 — a hair off the card's white, and now
            distinct from the canvas, which it used to match EXACTLY (both were
            slate-50, so the busiest half of the card was painted in the page
            colour). Dark: slate-700/50, a raised band over the slate-800 card. */}
        <div className="bg-slate-50 dark:bg-slate-700/50 rounded-t-2xl">
          <div
            {...attributes}
            {...listeners}
            title={t("Drag to reorder (press and hold on touch)")}
            className="flex justify-center py-2 cursor-grab active:cursor-grabbing opacity-50 hover:opacity-100 transition touch-pan-y"
          >
            <div className="flex gap-1">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500" />
              ))}
            </div>
          </div>
          <div onClick={() => !isDragging && selectNode(node.id)} onKeyDown={onActivateKey(() => !isDragging && selectNode(node.id))} role="button" tabIndex={0} aria-label={t("Open {{title}}", { title: node.title })} className="px-4 pb-4 cursor-pointer">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white shrink-0" style={{ backgroundColor: cardColor }}>
                  {isNote ? <FileText className="w-5 h-5" /> : <FolderOpen className="w-5 h-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-slate-900 dark:text-white truncate">{node.title}</h3>
                  {!isNote && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {node.progress?.completed || 0} / {node.progress?.total || 0} {t("completed")}
                    </p>
                  )}
                  {isNote && <p className="text-xs text-slate-500 dark:text-slate-400">{t("Note")}</p>}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {!isNote && <ProgressRing progress={progress} color={progressColor} size={36} />}
                <DropdownMenu
                  trigger={<button className="p-1.5 hover:bg-white/50 dark:hover:bg-slate-600/50 rounded-lg"><MoreVertical className="w-4 h-4 text-slate-400" /></button>}
                >
                  <button onClick={() => setShowAddModal(true)} className="w-full px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 flex items-center gap-2">
                    <Plus className="w-4 h-4" /> {t("Add Item")}
                  </button>
                  <button onClick={handleDelete} className="w-full px-3 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2">
                    <Trash2 className="w-4 h-4" /> {t("Delete")}
                  </button>
                </DropdownMenu>
              </div>
            </div>
            {node.children.length > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); toggleExpanded(node.id); }}
                className="flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                {isExpanded ? t("Collapse") : t("Expand")} {t("({{length}} items)", { count: node.children.length, length: node.children.length })}
              </button>
            )}
          </div>
        </div>

        {isExpanded && node.children.length > 0 && (
          /* `rounded-b-2xl` on the SCROLLER, not just the card: a scrollbar is
             painted inside its own element's box, so an unrounded scroll
             container in a rounded card drew its track straight through the
             bottom-right corner. The card itself cannot simply clip
             (`overflow-hidden`) — the drag-and-drop indicators are positioned
             outside its edges on purpose. */
          <div className="border-t border-slate-100 dark:border-slate-700 rounded-b-2xl px-2 py-2 max-h-80 overflow-auto">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragMove={handleDragMove} onDragOver={handleDragOver} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel} measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}>
              <SortableContext items={flatIds} strategy={verticalListSortingStrategy}>
                <div>
                  {flatItems.map((item) => (
                    <TreeItemRow
                      key={item.id}
                      item={item}
                      isActive={activeId === item.id}
                      projectedDepth={activeId === item.id && projection ? projection.depth : null}
                      indentationWidth={INDENTATION_WIDTH}
                      isDropParent={dropParentId != null && item.id === dropParentId}
                      dropParentTitle={activeId === item.id ? dropParentTitle : null}
                    />
                  ))}
                </div>
              </SortableContext>
              {/* Invisible overlay: keeps dnd-kit in "sorting" mode so the in-list
                  placeholder gets a vertical snap transform instead of following
                  the cursor. Rendered transparent — the placeholder is the only
                  visible drag feedback. */}
              <DragOverlay dropAnimation={null}>
                {activeId != null ? <div className="h-7 opacity-0 pointer-events-none" /> : null}
              </DragOverlay>
            </DndContext>
          </div>
        )}
        {isExpanded && node.children.length === 0 && (
          <div className="border-t border-slate-100 dark:border-slate-700 px-4 py-6 text-center">
            <p className="text-sm text-slate-500 dark:text-slate-400">{t("No items yet")}</p>
          </div>
        )}
      </div>

      <Modal isOpen={showAddModal} onClose={() => setShowAddModal(false)} title={t("Add New Item")}>
        <div className="space-y-4">
          <input
            value={newItemTitle}
            onChange={(e) => setNewItemTitle(e.target.value)}
            placeholder={t("Item title…")}
            className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-accent"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleAddChild()}
          />
          <div className="flex justify-end gap-3">
            <button onClick={() => setShowAddModal(false)} className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl">{t("Cancel")}</button>
            <button onClick={handleAddChild} disabled={!newItemTitle.trim()} className="px-4 py-2 bg-slate-900 dark:bg-accent text-white rounded-xl hover:bg-slate-800 dark:hover:bg-accent/90 disabled:opacity-50">{t("Add")}</button>
          </div>
        </div>
      </Modal>
    </>
  );
}