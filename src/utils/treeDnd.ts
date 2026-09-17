import { arrayMove } from '@dnd-kit/sortable';
import { TreeNode } from '../types';

/**
 * Shared drag-and-drop engine for the node tree.
 *
 * This is the canonical dnd-kit "sortable tree" pattern (flatten → project →
 * single drop-line), used by BOTH the sidebar ("Navigation") and the category
 * cards ("Categories"). The core idea that makes tree DnD feel good:
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
