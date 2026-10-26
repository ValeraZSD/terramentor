// Where a drag-and-drop puts things. Pure, so the gate can drive it without a
// browser (`tools/drag-order-gates.mjs`).
import type { Node } from '../types';

export type ProjectStatusValue = 'active' | 'completed' | 'archived';

const STATUSES: ProjectStatusValue[] = ['active', 'completed', 'archived'];

type Placed = { id: number; status?: string | null };

// A status outside the three is drawn in Active by the grid, so it is placed there too.
const statusOf = (p: Placed): ProjectStatusValue =>
    STATUSES.includes(p.status as ProjectStatusValue) ? (p.status as ProjectStatusValue) : 'active';

/**
 * The project list after `draggedId` is dropped on `overId` — another card, or
 * an empty section's zone (`status:<name>`). Null when nothing moves.
 *
 * Within one section this is `arrayMove`: the dropped card takes the target's
 * SLOT, whichever way it travelled. Inserting it "before the target" instead
 * is right going left and a no-op going right (A B C, drag B onto C: remove B,
 * insert before C, A B C again), which is how a card could be dropped onto a
 * neighbour on its left but never on its right. Into another section it goes
 * before the card it was dropped on, or last on an empty zone (only an EMPTY
 * section has a zone, so it cannot land last in a full one). The order stays
 * grouped active → completed → archived.
 */
export function projectOrderAfterDrop<P extends Placed>(projects: P[], draggedId: number, overId: number | string): P[] | null {
    const dragged = projects.find(p => p.id === draggedId);
    if (!dragged || overId === draggedId) return null;
    const source = statusOf(dragged);

    let target: ProjectStatusValue;
    let overCard: P | undefined;
    if (typeof overId === 'string') {
        if (!overId.startsWith('status:')) return null;
        target = overId.slice('status:'.length) as ProjectStatusValue;
        if (!STATUSES.includes(target) || target === source) return null;
    } else {
        overCard = projects.find(p => p.id === overId);
        if (!overCard) return null;
        target = statusOf(overCard);
    }

    const section = (s: ProjectStatusValue) => projects.filter(p => statusOf(p) === s);
    const sections = new Map(STATUSES.map(s => [s, section(s)]));

    if (target === source) {
        const list = sections.get(source)!;
        const from = list.indexOf(dragged);
        const to = list.indexOf(overCard!);
        list.splice(from, 1);
        list.splice(to, 0, dragged);
    } else {
        sections.set(source, sections.get(source)!.filter(p => p !== dragged));
        const list = sections.get(target)!;
        const at = overCard ? list.indexOf(overCard) : list.length;
        list.splice(at, 0, { ...dragged, status: target });
    }
    return STATUSES.flatMap(s => sections.get(s)!);
}

/**
 * The node rows after `PUT /api/nodes/:id/move` — the server's own rule
 * (`server/routes/nodes.js`): the node takes `parentId`, and its new siblings,
 * itself spliced in at `position`, are numbered 0..n. Applied BEFORE the
 * request so a dropped row stays where it was dropped instead of snapping back
 * for the length of a round trip and a full refetch. The old siblings keep
 * their numbers, as they do on the server.
 */
export function nodesAfterMove(nodes: Node[], id: number, parentId: number | null, position: number): Node[] {
    const moving = nodes.find(n => n.id === id);
    if (!moving) return nodes;
    const siblings = nodes
        .filter(n => n.project_id === moving.project_id && n.parent_id === parentId && n.id !== id)
        .sort((a, b) => a.position - b.position);
    // `splice` exactly as the route calls it, so a position past the end, NaN
    // or a negative one lands where the server puts it.
    siblings.splice(position, 0, moving);
    const placed = new Map(siblings.map((n, i) => [n.id, i]));
    return nodes.map(n => {
        if (!placed.has(n.id)) return n;
        const next = { ...n, position: placed.get(n.id)! };
        if (n.id === id) next.parent_id = parentId;
        return next;
    });
}

/**
 * Whether `PUT /api/nodes/:id/move` with these arguments changes anything the
 * learner can see: another parent, or another place among its siblings. A row
 * dropped back where it started asks for its own slot, and that drop must not
 * flash as if it had gone somewhere.
 */
export function moveChangesPlace(nodes: Node[], id: number, parentId: number | null, position: number): boolean {
    const moving = nodes.find(n => n.id === id);
    if (!moving) return false;
    if (moving.parent_id !== parentId) return true;
    const order = (rows: Node[]) => rows
        .filter(n => n.project_id === moving.project_id && n.parent_id === parentId)
        .sort((a, b) => a.position - b.position)
        .map(n => n.id)
        .join(',');
    return order(nodes) !== order(nodesAfterMove(nodes, id, parentId, position));
}

export type NodeWriterDeps = {
    getNodes: () => Node[];
    show: (nodes: Node[]) => void;
    /** The server's rows, or null when they no longer belong on screen (another project opened). */
    fetch: () => Promise<Node[] | null>;
    fail: (message: string, error: unknown) => void;
};

/**
 * Tree moves as the learner makes them: each guess is shown at once, the
 * requests go to the server one at a time in the order they were made, and the
 * server's rows replace the guesses once, when the LAST of a burst settles. A
 * refetch that answered between two quick drops would put the second row back
 * where it started; one that arrives after a newer drop began is not shown. A
 * failure is said at once; if the refetch fails too (the server is gone), the
 * screen goes back to what it showed before the burst instead of keeping
 * guesses nothing saved.
 */
export function createNodeWriter(deps: NodeWriterDeps) {
    let queue: Promise<unknown> = Promise.resolve();
    let pending = 0;
    let generation = 0;
    let baseline: Node[] = [];
    let burstFailed = false;
    return async function write(guess: Node[], request: () => Promise<unknown>, failMessage: string): Promise<void> {
        if (pending === 0) {
            baseline = deps.getNodes();
            burstFailed = false;
        }
        pending++;
        generation++;
        deps.show(guess);
        const run = queue.then(request);
        queue = run.catch(() => undefined);
        try {
            await run;
        } catch (e) {
            burstFailed = true;
            deps.fail(failMessage, e);
        }
        pending--;
        if (pending > 0) return;
        const asked = generation;
        let rows: Node[] | null;
        try {
            rows = await deps.fetch();
        } catch {
            if (asked === generation && burstFailed) deps.show(baseline);
            return;
        }
        if (rows && asked === generation) deps.show(rows);
    };
}

/** The node rows after `PUT /api/nodes/reorder`: each listed id takes `parentId` and its index as its position. */
export function nodesAfterReorder(nodes: Node[], ids: number[], parentId: number | null): Node[] {
    const placed = new Map(ids.map((id, i) => [id, i]));
    return nodes.map(n => (placed.has(n.id) ? { ...n, parent_id: parentId, position: placed.get(n.id)! } : n));
}

/**
 * The top-level categories on the Outline board after one is dropped on
 * another: it takes that card's SLOT (`arrayMove`), whichever way it
 * travelled, the Projects grid's rule. A drop on a card never nests it,
 * wherever on the card it lands: people expect a drop on a card to reorder,
 * and nesting stays in the Navigation list.
 * Null when nothing moves.
 */
export function categoryOrderAfterDrop(ids: number[], draggedId: number, overId: number): number[] | null {
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(overId);
    if (from === -1 || to === -1 || from === to) return null;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, draggedId);
    return next;
}

/** Which side of the card it is dropped on the dragged category lands: before it going left, after it going right. */
export function categoryDropSide(ids: number[], draggedId: number, overId: number): 'before' | 'after' | null {
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(overId);
    if (from === -1 || to === -1 || from === to) return null;
    return from > to ? 'before' : 'after';
}
