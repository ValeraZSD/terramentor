import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardSensor, useSensor, type Announcements, type ScreenReaderInstructions, type UniqueIdentifier } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useStore } from '../store';
import { announce } from '../utils/a11y';

/** Names for the lists that reorder, read when a move is announced. */
export const nodeTitle = (id: UniqueIdentifier) => useStore.getState().nodes.find((n) => n.id === id)?.title;
export const projectName = (id: UniqueIdentifier) => useStore.getState().projects.find((p) => p.id === id)?.name;
export const resourceTitle = (id: UniqueIdentifier) => useStore.getState().resources.find((r) => r.id === id)?.title;

/**
 * Reordering from the keyboard, and said aloud in the interface language.
 *
 * Every drag handle spreads dnd-kit's `attributes`, which make it a focusable
 * button that tells a screen reader "press Space to pick it up, then the
 * arrow keys". Without a KeyboardSensor nothing answered, so the handle
 * promised a move and did nothing. dnd-kit's own announcements are English
 * and name items by their numeric id; these name the item and the place.
 *
 *   const keyboard = useDragKeyboard();
 *   const sensors = useSensors(useSensor(MouseSensor), keyboard);
 *   <DndContext accessibility={useDragA11y(nodeTitle)} …>
 */
/**
 * Whether the card grid (`data-card-grid`) holding this element shows cards
 * side by side. A menu's "Move earlier / later" then moves a card left or
 * right, and its arrows must say so; in one column (a phone) they point up and
 * down. Tracks the grid's own columns, so a panel opening beside it counts.
 */
export function useSidewaysInGrid(ref: RefObject<HTMLElement | null>): boolean {
    const [sideways, setSideways] = useState(false);
    useLayoutEffect(() => {
        const grid = ref.current?.closest<HTMLElement>('[data-card-grid]');
        if (!grid) return;
        const measure = () => setSideways(getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length > 1);
        measure();
        window.addEventListener('resize', measure);
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
        ro?.observe(grid);
        return () => {
            window.removeEventListener('resize', measure);
            ro?.disconnect();
        };
    }, [ref]);
    return sideways;
}

export function useDragKeyboard() {
    return useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates });
}

/**
 * Where a drop over `over` would put the item in a flat list: the slot the
 * item takes, from the sortable list both are in. Null outside one list.
 */
type Spot = { id: UniqueIdentifier; data: { current?: { sortable?: { containerId: UniqueIdentifier; index: number; items: UniqueIdentifier[] } } | undefined } };
export function slotOf(active: Spot, over: Spot | null): { position: number; total: number } | null {
    const a = active.data.current?.sortable;
    const o = over?.data.current?.sortable;
    if (!a || !o || a.containerId !== o.containerId) return null;
    return { position: o.index + 1, total: o.items.length };
}

/**
 * dnd-kit's announcements, in the interface language and naming the item. A
 * flat list (`positions`) says the place as a number, "position 3 of 7"; a
 * tree, whose place is also a depth, names the row it is over.
 */
export function useDragA11y(nameOf: (id: UniqueIdentifier) => string | undefined, { positions = false } = {}): { announcements: Announcements; screenReaderInstructions: ScreenReaderInstructions } {
    const { t } = useTranslation();
    // dnd-kit reports the item over its own place right after the pick-up, and
    // that phrase replaces "Picked up" in the live region before a screen
    // reader has said it. That first report repeats the pick-up instead.
    const justPicked = useRef(false);
    return useMemo(() => {
        const name = (id: UniqueIdentifier) => nameOf(id) || t("this item");
        const slot = (active: Spot, over: Spot | null) => (positions ? slotOf(active, over) : null);
        return {
            screenReaderInstructions: {
                draggable: t("To move an item, press Space or Enter, use the arrow keys, then press Space or Enter again to drop it. Escape cancels."),
            },
            announcements: {
                onDragStart: ({ active }) => {
                    justPicked.current = true;
                    return t("Picked up {{item}}.", { item: name(active.id) });
                },
                onDragOver: ({ active, over }) => {
                    const first = justPicked.current;
                    justPicked.current = false;
                    if (first && over?.id === active.id) return t("Picked up {{item}}.", { item: name(active.id) });
                    const at = slot(active, over);
                    if (at) return t("{{item}} is at position {{position}} of {{total}}.", { item: name(active.id), ...at });
                    return over
                        ? t("{{item}} is over {{place}}.", { item: name(active.id), place: name(over.id) })
                        : t("{{item}} is not over a place to drop it.", { item: name(active.id) });
                },
                onDragEnd: ({ active, over }) => {
                    justPicked.current = false;
                    const at = slot(active, over);
                    if (at) return t("Dropped {{item}} at position {{position}} of {{total}}.", { item: name(active.id), ...at });
                    return over
                        ? t("Dropped {{item}} at {{place}}.", { item: name(active.id), place: name(over.id) })
                        : t("Dropped {{item}}.", { item: name(active.id) });
                },
                onDragCancel: ({ active }) => {
                    justPicked.current = false;
                    return t("Moving {{item}} was cancelled.", { item: name(active.id) });
                },
            },
        };
    }, [nameOf, positions, t]);
}

/**
 * The words a menu move says once it is made ("Moved Waves to position 3 of
 * 7."), through `announce`: the menu item pressed is gone by then.
 */
export function useMovedSay() {
    const { t } = useTranslation();
    return useCallback((item: string | undefined, position: number, total: number) => {
        announce(t("Moved {{item}} to position {{position}} of {{total}}.", { item: item || t("this item"), position, total }));
    }, [t]);
}

/**
 * A drag handle's keys belong to the keyboard drag (useDragKeyboard), not to
 * a tree's own arrows, Enter and Escape: while a drag is on, all of them; on a
 * handle with no drag yet, only the two that pick it up. Arrows on a resting
 * handle still move through the tree.
 */
export function keyBelongsToDrag(key: string, onHandle: boolean, dragging: boolean): boolean {
    if (dragging) return true;
    return onHandle && (key === ' ' || key === 'Enter');
}

/**
 * For every node, whether a sibling sits before (`u`) and after (`d`) it:
 * one pass over the list, computed once per `nodes` array and shared by every
 * row that asks (each row reading the list itself was a pass per row).
 */
type Placed = { id: number; parent_id: number | null; project_id: number; position: number };
const endsCache = new WeakMap<readonly Placed[], Map<number, string>>();
export function siblingEnds(nodes: readonly Placed[]): Map<number, string> {
    const hit = endsCache.get(nodes);
    if (hit) return hit;
    const groups = new Map<string, Placed[]>();
    for (const n of nodes) {
        const k = `${n.project_id}:${n.parent_id ?? ''}`;
        const g = groups.get(k);
        if (g) g.push(n); else groups.set(k, [n]);
    }
    const ends = new Map<number, string>();
    for (const g of groups.values()) {
        g.sort((a, b) => a.position - b.position || a.id - b.id);
        g.forEach((n, i) => ends.set(n.id, `${i > 0 ? 'u' : ''}${i < g.length - 1 ? 'd' : ''}`));
    }
    endsCache.set(nodes, ends);
    return ends;
}

/**
 * Move up / Move down for one node among its siblings: the same reorder a drag
 * ends in, from a menu, for anyone who cannot drag (WCAG 2.5.7). It reorders
 * only: moving a node under another parent still takes a drag. `up` or `down`
 * is null at that end of the list.
 */
export function useSiblingMove(node: { id: number; parent_id: number | null; project_id: number }) {
    const reorderNodes = useStore(s => s.reorderNodes);
    const sayMoved = useMovedSay();
    const parentId = node.parent_id ?? null;
    // One shared pass per store change (`siblingEnds`), then a lookup per row.
    const ends = useStore(s => siblingEnds(s.nodes).get(node.id) ?? '');
    return useMemo(() => {
        const move = (delta: -1 | 1) => () => {
            const all = useStore.getState().nodes;
            const ids = all
                .filter(n => (n.parent_id ?? null) === parentId && n.project_id === node.project_id)
                .sort((a, b) => a.position - b.position || a.id - b.id)
                .map(n => n.id);
            const at = ids.indexOf(node.id);
            if (at < 0 || at + delta < 0 || at + delta >= ids.length) return;
            [ids[at], ids[at + delta]] = [ids[at + delta], ids[at]];
            void reorderNodes(ids, parentId, node.id);
            sayMoved(nodeTitle(node.id), at + delta + 1, ids.length);
        };
        return {
            up: ends.includes('u') ? move(-1) : null,
            down: ends.includes('d') ? move(1) : null,
        };
    }, [ends, node.id, node.project_id, parentId, reorderNodes, sayMoved]);
}
