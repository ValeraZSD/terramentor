import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardSensor, useSensor, type Announcements, type ScreenReaderInstructions, type UniqueIdentifier } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useStore } from '../store';

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
export function useDragKeyboard() {
    return useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates });
}

export function useDragA11y(nameOf: (id: UniqueIdentifier) => string | undefined): { announcements: Announcements; screenReaderInstructions: ScreenReaderInstructions } {
    const { t } = useTranslation();
    return useMemo(() => {
        const name = (id: UniqueIdentifier) => nameOf(id) || t("this item");
        return {
            screenReaderInstructions: {
                draggable: t("To move an item, press Space or Enter, use the arrow keys, then press Space or Enter again to drop it. Escape cancels."),
            },
            announcements: {
                onDragStart: ({ active }) => t("Picked up {{item}}.", { item: name(active.id) }),
                onDragOver: ({ active, over }) => over
                    ? t("{{item}} is over {{place}}.", { item: name(active.id), place: name(over.id) })
                    : t("{{item}} is not over a place to drop it.", { item: name(active.id) }),
                onDragEnd: ({ active, over }) => over
                    ? t("Dropped {{item}} at {{place}}.", { item: name(active.id), place: name(over.id) })
                    : t("Dropped {{item}}.", { item: name(active.id) }),
                onDragCancel: ({ active }) => t("Moving {{item}} was cancelled.", { item: name(active.id) }),
            },
        };
    }, [nameOf, t]);
}

/**
 * Move up / Move down for one node among its siblings: the same reorder a drag
 * ends in, from a menu, for anyone who cannot drag (WCAG 2.5.7). `up` or `down`
 * is null at that end of the list.
 */
export function useSiblingMove(node: { id: number; parent_id: number | null; project_id: number }) {
    const reorderNodes = useStore(s => s.reorderNodes);
    const parentId = node.parent_id ?? null;
    const siblingsOf = (nodes: { id: number; parent_id: number | null; project_id: number; position: number }[]) =>
        nodes.filter(n => (n.parent_id ?? null) === parentId && n.project_id === node.project_id);
    // Every row runs this selector on every store update, so it only asks
    // whether a sibling sits before or after this one: one pass, no sort, no
    // array. The order itself is read when a move is chosen.
    const ends = useStore(s => {
        const self = s.nodes.find(n => n.id === node.id);
        if (!self) return '';
        let before = false, after = false;
        for (const n of s.nodes) {
            if (n.id === node.id || (n.parent_id ?? null) !== parentId || n.project_id !== node.project_id) continue;
            if (n.position < self.position || (n.position === self.position && n.id < self.id)) before = true;
            else after = true;
        }
        return `${before ? 'u' : ''}${after ? 'd' : ''}`;
    });
    return useMemo(() => {
        const move = (delta: -1 | 1) => () => {
            const ids = siblingsOf(useStore.getState().nodes)
                .sort((a, b) => a.position - b.position || a.id - b.id)
                .map(n => n.id);
            const at = ids.indexOf(node.id);
            if (at < 0 || at + delta < 0 || at + delta >= ids.length) return;
            [ids[at], ids[at + delta]] = [ids[at + delta], ids[at]];
            void reorderNodes(ids, parentId, node.id);
        };
        return {
            up: ends.includes('u') ? move(-1) : null,
            down: ends.includes('d') ? move(1) : null,
        };
        // siblingsOf reads only parentId and node.project_id.
    }, [ends, node.id, node.project_id, parentId, reorderNodes]);
}
