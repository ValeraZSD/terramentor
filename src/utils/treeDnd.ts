import { arrayMove } from '@dnd-kit/sortable';
import { TreeNode } from '../types';

/**
 * Shared drag-and-drop engine for the node tree.
 *
 * This is the canonical dnd-kit "sortable tree" pattern (flatten → project →
 * single drop-line), used by BOTH the sidebar ("Navigation") and the category
 * cards of the Outline board. The core idea that makes tree DnD feel good:
 *
 *   1. Flatten the *visible* tree into a linear list of rows.
 *   2. Reorder with a plain vertical SortableContext (no gap-shifting hacks).
 *   3. Each frame, derive a single {depth, parentId} PROJECTION from the row we
 *      hover plus the horizontal drag offset — the pointer's X decides nesting
 *      depth, clamped to what's structurally legal. Render exactly ONE drop-line.
 *   4. Remove the dragged node's own subtree from the list while dragging, so a
 *      node can never be dropped inside itself.
 *
 * Depth is controlled by dragging left/right (INDENTATION_WIDTH px per level),
 * which is unambiguous and live — unlike guessing "inside" from a stale pointer.
 */

export const INDENTATION_WIDTH = 20;

export interface FlatItem {
    id: number;
    depth: number;
    /** Parent id in the flattened frame; null for a real top-level node (sidebar roots). */
    parentId: number | null;
    node: TreeNode;
    /** Ids of every ancestor, nearest-last — used to exclude a node's own subtree. */
    ancestorIds: number[];
}

export interface Projection {
    depth: number;
    parentId: number | null;
}

/**
 * Flatten the currently-*visible* rows (collapsed subtrees are skipped) into a
 * linear list. `rootParentId` is the parent id assigned to top-level rows —
 * `null` for the sidebar (real DB parent), or a category id when flattening a
 * single category's children.
 */
export function flattenVisible(
    nodes: TreeNode[],
    expanded: Record<number, boolean>,
    rootParentId: number | null = null,
    depth = 0,
    ancestorIds: number[] = []
): FlatItem[] {
    return nodes.flatMap((node) => {
        const item: FlatItem = { id: node.id, depth, parentId: rootParentId, node, ancestorIds };
        const isExpanded = expanded[node.id] !== false;
        if (!isExpanded || node.children.length === 0) return [item];
        return [
            item,
            ...flattenVisible(node.children, expanded, node.id, depth + 1, [...ancestorIds, node.id]),
        ];
    });
}

/** Drop the dragged node's descendants (but keep the node itself, as the drop-line anchor). */
export function removeDescendants(items: FlatItem[], activeId: number): FlatItem[] {
    return items.filter((item) => !item.ancestorIds.includes(activeId));
}

/**
 * Derive the target {depth, parentId} from the hovered row + horizontal offset.
 * `items` must include the active row but NOT its descendants (see removeDescendants).
 */
export function getProjection(
    items: FlatItem[],
    activeId: number,
    overId: number,
    dragOffsetX: number,
    rootParentId: number | null,
    indentationWidth: number = INDENTATION_WIDTH
): Projection {
    const activeIndex = items.findIndex((i) => i.id === activeId);
    const overIndex = items.findIndex((i) => i.id === overId);
    if (activeIndex === -1 || overIndex === -1) return { depth: 0, parentId: rootParentId };

    const reordered = arrayMove(items, activeIndex, overIndex);
    const newActiveIndex = reordered.findIndex((i) => i.id === activeId);
    const itemAbove = reordered[newActiveIndex - 1];
    const itemBelow = reordered[newActiveIndex + 1];

    // Legal depth window: you may nest one level under the row above, and you
    // must be at least as deep as the row below (so it stays your sibling/child).
    const maxDepth = itemAbove ? itemAbove.depth + 1 : 0;
    const minDepth = itemBelow ? itemBelow.depth : 0;

    const depthOffset = Math.round(dragOffsetX / indentationWidth);
    const rawDepth = items[activeIndex].depth + depthOffset;
    const projectedDepth = Math.max(minDepth, Math.min(maxDepth, rawDepth));

    let parentId: number | null = rootParentId;
    if (projectedDepth > 0 && itemAbove) {
        if (itemAbove.depth === projectedDepth - 1) {
            parentId = itemAbove.id;
        } else if (itemAbove.depth >= projectedDepth) {
            // Walk back to the nearest row exactly one level shallower — that's the parent.
            for (let i = newActiveIndex - 1; i >= 0; i--) {
                const item = reordered[i];
                if (item.id === activeId) continue;
                if (item.depth === projectedDepth - 1) { parentId = item.id; break; }
                if (item.depth < projectedDepth - 1) break;
            }
        } else {
            parentId = itemAbove.id;
        }
    }

    return { depth: projectedDepth, parentId };
}

/**
 * Translate a finished drag into the 0-based sibling index for `moveNode`.
 * Counts how many existing siblings of the target parent sit above the drop.
 */
export function getDropPosition(
    items: FlatItem[],
    activeId: number,
    overId: number,
    projection: Projection
): number {
    const activeIndex = items.findIndex((i) => i.id === activeId);
    const overIndex = items.findIndex((i) => i.id === overId);
    if (activeIndex === -1 || overIndex === -1) return 0;

    const reordered = arrayMove(items, activeIndex, overIndex);
    const newActiveIndex = reordered.findIndex((i) => i.id === activeId);

    let position = 0;
    for (let i = 0; i < newActiveIndex; i++) {
        const item = reordered[i];
        if (item.id === activeId) continue;
        if (item.parentId === projection.parentId && item.depth === projection.depth) position++;
    }
    return position;
}

/** True when `parentId` is inside the dragged node's subtree (illegal drop). */
export function isDescendantTarget(
    allItems: FlatItem[],
    activeId: number,
    parentId: number | null
): boolean {
    if (parentId == null) return false;
    if (parentId === activeId) return true;
    return allItems.some((i) => i.id === parentId && i.ancestorIds.includes(activeId));
}

/*
 * The Outline board: one drag across every category card.
 *
 * Each card shows its category's rows as its own flat list (`rootParentId` =
 * the category). One DndContext spans the board, because a context per card
 * keeps a row inside the card it started in, and a row carried over another
 * card is drawn IN that card's list
 * (`BoardHost`) — the dnd-kit "multiple containers" pattern — so the same
 * projection and drop position as inside one card decide where it lands.
 */

/** Where a row carried out of its own card is drawn: the card, its index in that card's rows, and the depth it arrives at. */
export interface BoardHost {
    cardId: number;
    index: number;
    depth: number;
}

/** Each card's visible rows, keyed by category id; while a row is dragged, without its subtree and inside the card hosting it. */
export function boardRows(
    cards: TreeNode[],
    expanded: Record<number, boolean>,
    activeId: number | null,
    host: BoardHost | null
): Map<number, FlatItem[]> {
    const lists = new Map(cards.map((c) => [c.id, flattenVisible(c.children, expanded, c.id, 0, [c.id])]));
    if (activeId == null) return lists;
    let moving: FlatItem | undefined;
    let source: number | undefined;
    for (const [cardId, items] of lists) {
        const trimmed = removeDescendants(items, activeId);
        lists.set(cardId, trimmed);
        const found = trimmed.find((i) => i.id === activeId);
        if (found) { moving = found; source = cardId; }
    }
    if (!moving || source == null || !host || host.cardId === source || !lists.has(host.cardId)) return lists;
    lists.set(source, lists.get(source)!.filter((i) => i.id !== activeId));
    const target = [...lists.get(host.cardId)!];
    target.splice(Math.max(0, Math.min(host.index, target.length)), 0, { ...moving, depth: host.depth });
    lists.set(host.cardId, target);
    return lists;
}

/** The category card whose subtree holds node `id`, read off the tree itself (collapsed rows included), or null. */
export function cardOfNode(cards: TreeNode[], id: number): number | null {
    const holds = (n: TreeNode): boolean => n.id === id || n.children.some(holds);
    return cards.find((c) => c.children.some(holds))?.id ?? null;
}

/** The card whose list holds row `id`, or null. */
export function cardOfRow(lists: Map<number, FlatItem[]>, id: number): number | null {
    for (const [cardId, items] of lists) if (items.some((i) => i.id === id)) return cardId;
    return null;
}

/**
 * Where the dragged row goes when it is carried over row `overId` of card
 * `cardId`: before that row, or after it when the pointer is below its middle,
 * at that row's depth, so it arrives as its sibling. Back over its own card it
 * is hosted nowhere (null) and sits in its own place again.
 */
export function hostOver(
    lists: Map<number, FlatItem[]>,
    activeId: number,
    sourceCardId: number,
    cardId: number,
    overId: number,
    below: boolean
): BoardHost | null {
    if (cardId === sourceCardId) return null;
    const items = (lists.get(cardId) ?? []).filter((i) => i.id !== activeId);
    const at = items.findIndex((i) => i.id === overId);
    if (at === -1) return null;
    return { cardId, index: at + (below ? 1 : 0), depth: items[at].depth };
}

/**
 * The projection of a dragged row on the board. In its own card the
 * horizontal drag decides the depth, as everywhere else; in ANOTHER card it
 * does not, because reaching that card is itself a sideways move of a whole
 * card's width, which read as ten levels of nesting under whatever row was
 * above the drop. There it lands at the depth it arrived with.
 */
export function boardProjection(
    lists: Map<number, FlatItem[]>,
    activeId: number,
    overId: number,
    dragOffsetX: number,
    sourceCardId: number,
    indentationWidth: number = INDENTATION_WIDTH
): { cardId: number; projection: Projection } | null {
    const cardId = cardOfRow(lists, activeId);
    if (cardId == null) return null;
    const items = lists.get(cardId)!;
    if (!items.some((i) => i.id === overId)) return null;
    const offset = cardId === sourceCardId ? dragOffsetX : 0;
    return { cardId, projection: getProjection(items, activeId, overId, offset, cardId, indentationWidth) };
}

/** Where a row dropped over row `overId` lands: `moveNode`'s parent and position, or null for an illegal drop. */
export function boardRowDrop(
    lists: Map<number, FlatItem[]>,
    allItems: FlatItem[],
    activeId: number,
    overId: number,
    dragOffsetX: number,
    sourceCardId: number,
    indentationWidth: number = INDENTATION_WIDTH
): { parentId: number; position: number } | null {
    const placed = boardProjection(lists, activeId, overId, dragOffsetX, sourceCardId, indentationWidth);
    if (!placed) return null;
    const { cardId, projection } = placed;
    if (isDescendantTarget(allItems, activeId, projection.parentId)) return null;
    return {
        parentId: projection.parentId ?? cardId,
        position: getDropPosition(lists.get(cardId)!, activeId, overId, projection),
    };
}

/**
 * Where a released row lands, given the host the screen DREW and the host the
 * final pointer asks for. They differ when the release comes before the last
 * move's host was drawn. A fresh host already puts the row in its slot beside
 * the row under the pointer, so the drop is "where it is now" (over itself):
 * measuring it against that neighbour again would carry it one place past it,
 * to the far side of the line the learner saw. Over a card with no rows to
 * point between, it goes last among that card's items.
 *
 * The card the row came from is read off the tree, never off the drag: once
 * the row is drawn in another card, dnd-kit's active item is the instance
 * mounted THERE, and its data names the hosting card.
 */
export function settleRowDrop(
    cards: TreeNode[],
    expanded: Record<number, boolean>,
    activeId: number,
    drawn: BoardHost | null,
    final: BoardHost | null,
    over: { kind: 'card' | 'row'; id: number },
    dragOffsetX: number,
    indentationWidth: number = INDENTATION_WIDTH
): { parentId: number; position: number } | null {
    if (over.kind === 'card') {
        const card = cards.find((c) => c.id === over.id);
        return card ? { parentId: card.id, position: card.children.filter((c) => c.id !== activeId).length } : null;
    }
    const sourceCardId = cardOfNode(cards, activeId);
    if (sourceCardId == null) return null;
    const lists = boardRows(cards, expanded, activeId, final);
    const allItems = [...boardRows(cards, expanded, null, null).values()].flat();
    const fresh = final != null
        && !(drawn && drawn.cardId === final.cardId && drawn.index === final.index && drawn.depth === final.depth);
    return boardRowDrop(lists, allItems, activeId, fresh ? activeId : over.id, dragOffsetX, sourceCardId, indentationWidth);
}
