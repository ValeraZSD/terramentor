import { useState } from 'react';
import { FOCUS_RING } from './ui/vocabulary';
import { useSortable, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '../store';
import ProgressRing from './ProgressRing';
import TreeItemRow from './TreeItemRow';
import DropdownMenu from './DropdownMenu';
import Modal from './Modal';
import { TreeNode } from '../types';
import { INDENTATION_WIDTH, FlatItem } from '../utils/treeDnd';
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
import { useNumberFormat } from '../hooks/useNumberFormat';
import { useDropFlash } from '../hooks/useDropFlash';
import { countsInCards } from '../utils/projectShape';
import { Button, IconButton } from './ui/Button';
import { TextInput } from './ui/Field';
import { MenuItem } from './ui/Popover';

/** The row being dragged, when this card is the one drawing it. */
export interface CardRowDrag {
  activeId: number;
  projectedDepth: number | null;
  dropParentId: number | null;
  dropParentTitle: string | null;
}

interface Props {
  node: TreeNode;
  /** This card's visible rows, worked out by the board: during a drag, a row carried in from another card is among them. */
  rows: FlatItem[];
  /** Set on the card drawing the dragged row. */
  rowDrag?: CardRowDrag | null;
  /** A dragged row would land in this card, which shows no rows to point between (empty or collapsed). */
  rowTarget?: boolean;
  /** Grid-level drop hint while another card is dragged over this one: the side it lands on. */
  dropIndicator?: 'before' | 'after' | null;
}

export default function CategoryCard({ node, rows, rowDrag, rowTarget, dropIndicator }: Props) {
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
  const showConfirm = useStore((s) => s.showConfirm);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newItemTitle, setNewItemTitle] = useState('');

  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: node.id, data: { kind: 'card' } });
  const flash = useDropFlash(`node:${node.id}`, { wide: true });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
    zIndex: isDragging ? 1000 : undefined,
    ...flash?.style,
  };

  const project = projects.find((p) => p.id === currentProjectId);
  const isExpanded = expanded[node.id] ?? true;
  const progress = node.progress?.percentage || 0;
  const isNote = !!node.is_note;
  const num = useNumberFormat();
  // Counted the way its project is (`countsInCards`, the Projects grid's rule):
  // a section of a deck nobody teaches is worked through its cards, and
  // "0 / 6 completed" under a ring reading 10% was two answers to one question.
  const subtreeCards = node.progress?.cards ?? 0;
  const inCards = countsInCards({ teaches: project?.teaches, topics: node.progress?.total, cards: subtreeCards });

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

  const progressColor = progress === 100 ? '#22C55E' : project?.color || '#8B5CF6';
  const cardColor = isNote ? '#64748B' : project?.color || '#8B5CF6';

  return (
    <>
      {/* A card must read as a raised surface, not as an outline. In light mode
          the canvas is one step off white (slate-100) and the card is white +
          shadow — the treatment every other card in the app already had
          (StudyDashboard, ProjectCard) and this board did not, so twelve
          categories sat on the page as faint rectangles. The transition names
          its properties because a dragged card is drawn at opacity 0.3, and a
          plain `transition` faded it back in over 150 ms after every drop. */}
      <div
        ref={setNodeRef}
        style={style}
        data-category-id={node.id}
        data-node-id={node.id}
        className={`relative bg-white dark:bg-slate-800 rounded-2xl border shadow-sm transition-[border-color,box-shadow] ${selectedNodeId === node.id
          ? 'border-accent/40 dark:border-accent shadow-md'
          : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 hover:shadow-md'
          } ${isDragging ? 'shadow-2xl' : ''} ${flash?.className ?? ''} ${rowTarget ? 'ring-2 ring-accent ring-offset-2 ring-offset-slate-100 dark:ring-offset-slate-900' : ''}`}
      >
        {/* Grid drop hint: a bar in the gutter on the side the dragged card lands. */}
        {dropIndicator === 'before' && (
          <div className="absolute -left-2.5 top-3 bottom-3 w-1 rounded-full bg-accent z-10" />
        )}
        {dropIndicator === 'after' && (
          <div className="absolute -right-2.5 top-3 bottom-3 w-1 rounded-full bg-accent z-10" />
        )}
        {/* Header band. Light: slate-50 — a hair off the card's white, and
            distinct from the canvas. Dark: slate-700/50, a raised band over
            the slate-800 card. */}
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
          {/* The pointer opens the category anywhere on the card; the keyboard
              and a screen reader reach it through the title, a button of its
              own beside the ⋮ menu and the Expand toggle rather than around them. */}
          <div onClick={() => !isDragging && selectNode(node.id)} className="px-4 pb-4 cursor-pointer">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white shrink-0" style={{ backgroundColor: cardColor }}>
                  {isNote ? <FileText className="w-5 h-5" /> : <FolderOpen className="w-5 h-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-slate-900 dark:text-white truncate">
                    <button data-row="title"
                      type="button"
                      onClick={(e) => { e.stopPropagation(); if (!isDragging) selectNode(node.id); }}
                      aria-label={t("Open {{title}}", { title: node.title })}
                      className={`-mx-1 px-1 max-w-full truncate text-left rounded ${FOCUS_RING}`}
                    >
                      {node.title}
                    </button>
                  </h3>
                  {!isNote && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {inCards
                        ? t("{{value}} / {{value2}} cards met", { count: subtreeCards, value: num(node.progress?.seen ?? 0), value2: num(subtreeCards) })
                        : <>{node.progress?.completed || 0} / {node.progress?.total || 0} {t("completed")}</>}
                    </p>
                  )}
                  {isNote && <p className="text-xs text-slate-500 dark:text-slate-400">{t("Note")}</p>}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {!isNote && <ProgressRing progress={progress} color={progressColor} size={36} />}
                <DropdownMenu
                  trigger={<IconButton size="sm" tooltip={false} label={t("Actions for {{title}}", { title: node.title })} icon={<MoreVertical className="w-4 h-4" />} />}
                >
                  <MenuItem roving={false} onSelect={() => setShowAddModal(true)} icon={<Plus className="w-4 h-4" />}>
                    {t("Add Item")}
                  </MenuItem>
                  <MenuItem roving={false} tone="danger" onSelect={handleDelete} icon={<Trash2 className="w-4 h-4" />}>
                    {t("Delete")}
                  </MenuItem>
                </DropdownMenu>
              </div>
            </div>
            {node.children.length > 0 && (
              <Button
                size="sm"
                variant="quiet"
                aria-expanded={isExpanded}
                onClick={(e) => { e.stopPropagation(); toggleExpanded(node.id); }}
                icon={isExpanded ? <ChevronDown className="w-4 h-4" aria-hidden="true" /> : <ChevronRight className="w-4 h-4" aria-hidden="true" />}
                className="-ml-2.5"
              >
                {isExpanded ? t("Collapse") : t("Expand")} {t("({{length}} items)", { count: node.children.length, length: node.children.length })}
              </Button>
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
            {/* The drag context is the board's (NodeTree), so a row can be
                carried into another card; this card only lists its rows. */}
            <SortableContext items={rows.map((i) => i.id)} strategy={verticalListSortingStrategy}>
              <div>
                {rows.map((item) => (
                  <TreeItemRow
                    key={item.id}
                    item={item}
                    cardId={node.id}
                    isActive={rowDrag?.activeId === item.id}
                    projectedDepth={rowDrag?.activeId === item.id ? rowDrag.projectedDepth : null}
                    indentationWidth={INDENTATION_WIDTH}
                    isDropParent={rowDrag?.dropParentId != null && item.id === rowDrag.dropParentId}
                    dropParentTitle={rowDrag?.activeId === item.id ? rowDrag.dropParentTitle : null}
                  />
                ))}
              </div>
            </SortableContext>
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
          <TextInput
            value={newItemTitle}
            onChange={(e) => setNewItemTitle(e.target.value)}
            placeholder={t("Item title…")}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleAddChild()}
          />
          <div className="flex justify-end gap-3">
            <Button variant="quiet" onClick={() => setShowAddModal(false)}>{t("Cancel")}</Button>
            <Button variant="primary" onClick={handleAddChild} disabled={!newItemTitle.trim()}>{t("Add")}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}