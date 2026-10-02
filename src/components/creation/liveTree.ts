// The live tree an AI project creation draws while it writes, and the pure
// helpers that fold the run's frames into it. Moved verbatim out of
// ProjectsGrid.tsx when a creation stopped being the grid's single piece of
// state (several runs may be live at once; each run holds its own tree).
// INCREMENTAL LIVE NODE TREE
export interface LiveNode {
    key: string;
    title: string;
    description: string;
    depth: number;
    status: 'pending' | 'generating' | 'created' | 'cancelled' | 'error';
    resourceCount: number;
    children: LiveNode[];
}

export function addCategories(
    tree: LiveNode[],
    categories: Array<{ index?: number; title: string; description?: string }>
): LiveNode[] {
    return [
        ...tree,
        ...categories.map((c, i) => ({
            key: `cat-${c.index ?? i}`,
            title: c.title,
            description: c.description || '',
            depth: 0,
            status: 'pending' as const,
            resourceCount: 0,
            children: [],
        })),
    ];
}

export function addElements(
    tree: LiveNode[],
    categoryIndex: number,
    elements: Array<{ index?: number; title: string; description?: string }>
): LiveNode[] {
    return tree.map((node, i) => {
        if (i !== categoryIndex) return node;
        return {
            ...node,
            status: 'generating' as const,
            children: [
                ...node.children,
                ...elements.map((e, ei) => ({
                    key: `${node.key}-el-${e.index ?? ei}`,
                    title: e.title,
                    description: e.description || '',
                    depth: 1,
                    status: 'pending' as const,
                    resourceCount: 0,
                    children: [],
                })),
            ],
        };
    });
}

export function addSubElements(
    tree: LiveNode[],
    categoryIndex: number,
    elementIndex: number,
    subElements: Array<{ index?: number; title: string; description?: string }>
): LiveNode[] {
    return tree.map((catNode, ci) => {
        if (ci !== categoryIndex) return catNode;
        return {
            ...catNode,
            children: catNode.children.map((elNode, ei) => {
                if (ei !== elementIndex) return elNode;
                return {
                    ...elNode,
                    status: 'generating' as const,
                    children: [
                        ...elNode.children,
                        ...subElements.map((se, sei) => ({
                            key: `${elNode.key}-se-${se.index ?? sei}`,
                            title: se.title,
                            description: se.description || '',
                            depth: 2,
                            status: 'pending' as const,
                            resourceCount: 0,
                            children: [],
                        })),
                    ],
                };
            }),
        };
    });
}

export function allCreated(nodes: LiveNode[]): boolean {
    return nodes.length > 0 && nodes.every(n => n.status === 'created');
}

/**
 * A detail is done once its resource pass has run — whether or not the search
 * found anything, because the node itself was written to the database before
 * that search started. Parents roll up from it: a topic is created once every
 * one of its details is, a phase once every one of its topics is.
 *
 * Addressed by index, not by title: the server sends the coordinates it
 * generated from, and two topics in different phases are free to share a name.
 */
export function markSubElementDone(
    tree: LiveNode[],
    categoryIndex: number,
    elementIndex: number,
    subElementIndex: number,
    resourceCount: number
): LiveNode[] {
    return tree.map((catNode, ci) => {
        if (ci !== categoryIndex) return catNode;
        const elements = catNode.children.map((elNode, ei) => {
            if (ei !== elementIndex) return elNode;
            const subElements = elNode.children.map((seNode, sei) => {
                if (sei !== subElementIndex) return seNode;
                return {
                    ...seNode,
                    status: 'created' as const,
                    resourceCount: seNode.resourceCount + resourceCount,
                };
            });
            return {
                ...elNode,
                status: allCreated(subElements) ? ('created' as const) : elNode.status,
                resourceCount: elNode.resourceCount + resourceCount,
                children: subElements,
            };
        });
        return {
            ...catNode,
            status: allCreated(elements) ? ('created' as const) : catNode.status,
            resourceCount: catNode.resourceCount + resourceCount,
            children: elements,
        };
    });
}

/**
 * The server only emits `complete` once every node is in the database, so
 * anything still reading as pending or generating at that point is an event the
 * client failed to match, never unfinished work — settle the tree so the final
 * counters state what was actually created. Cancelled/errored nodes keep their
 * status; those are outcomes, not gaps.
 */
export function markAllCreated(tree: LiveNode[]): LiveNode[] {
    return tree.map(node => ({
        ...node,
        status:
            node.status === 'cancelled' || node.status === 'error'
                ? node.status
                : ('created' as const),
        children: markAllCreated(node.children),
    }));
}

export function markCategoryGenerating(tree: LiveNode[], categoryIndex: number): LiveNode[] {
    return tree.map((node, i) => {
        if (i !== categoryIndex) return node;
        return { ...node, status: 'generating' as const };
    });
}

export function markElementGenerating(
    tree: LiveNode[],
    categoryIndex: number,
    elementIndex: number
): LiveNode[] {
    return tree.map((catNode, ci) => {
        if (ci !== categoryIndex) return catNode;
        return {
            ...catNode,
            children: catNode.children.map((elNode, ei) => {
                if (ei !== elementIndex) return elNode;
                return { ...elNode, status: 'generating' as const };
            }),
        };
    });
}

export function markAllRemainingCancelled(tree: LiveNode[]): LiveNode[] {
    return tree.map(node => ({
        ...node,
        status: node.status === 'created' ? 'created' : 'cancelled',
        children: markAllRemainingCancelled(node.children),
    }));
}

export function countNodes(tree: LiveNode[]): { created: number; total: number } {
    let created = 0, total = 0;
    const walk = (nodes: LiveNode[]) => {
        for (const n of nodes) {
            total++;
            if (n.status === 'created') created++;
            walk(n.children);
        }
    };
    walk(tree);
    return { created, total };
}

export function findGeneratingNode(tree: LiveNode[]): LiveNode | null {
    for (const node of tree) {
        if (node.status === 'generating') return node;
        const child = findGeneratingNode(node.children);
        if (child) return child;
    }
    return null;
}

export function isCategoryComplete(cat: LiveNode): boolean {
    if (cat.status !== 'created') return false;
    return cat.children.every(c => c.status === 'created');
}

export function isCategoryActive(cat: LiveNode): boolean {
    if (cat.status === 'generating') return true;
    return cat.children.some(c => c.status === 'generating' || isCategoryActive(c));
}

/**
 * Rebuild the live tree from the database for a reattach: a page reload mid-run
 * has no SSE frames to replay, so the tree is rebuilt from the nodes that
 * really exist, then the current activity front is painted on top from the
 * creation-status snapshot. Positions ARE the coordinates the stream used (the
 * pipeline inserts nodes at their loop index), so `currentCategoryIndex` etc.
 * map straight onto positions.
 *
 * Rules, mirroring what the live stream would have shown at this moment:
 *  - a category before the front is fully created;
 *  - the front category is generating; its topics before the front topic are
 *    created, the front topic is generating;
 *  - inside the front topic, details before the front detail are created
 *    (their resource pass ran), the front detail is generating (it is in its
 *    resource pass), details after it are written but pending;
 *  - topics after the front, and every later category, are pending;
 *  - with no activity front (shell/phases stages) everything that exists is
 *    pending.
 */
export const BUILD_LOOP_PHASES = new Set([
    'generating_elements', 'elements_generated',
    'generating_sub_elements', 'sub_elements_batched', 'sub_elements_generated',
    'finding_resources', 'resources_saved',
]);

export function buildLiveTreeFromDB(
    rows: Array<{ id: number; parent_id: number | null; title: string; description?: string; is_note?: number }>,
    status: {
        phase?: string;
        currentCategoryIndex?: number | null;
        currentElementIndex?: number | null;
        currentSubElementIndex?: number | null;
        resourceCounts?: Record<string, number>;
    }
): LiveNode[] {
    const tops = rows.filter(r => (r.parent_id === null || r.parent_id === 0) && !r.is_note);
    const kidsOf = (parentId: number) =>
        rows.filter(r => r.parent_id === parentId && !r.is_note);

    const inBuild = BUILD_LOOP_PHASES.has(status.phase || '');
    const catIdx = inBuild ? (status.currentCategoryIndex ?? null) : null;
    const elIdx = inBuild ? (status.currentElementIndex ?? null) : null;
    const seIdx = inBuild ? (status.currentSubElementIndex ?? null) : null;
    const counts = status.resourceCounts || {};

    const toNode = (
        row: { id: number; title: string; description?: string },
        depth: number,
        ci: number | null,
        ei: number | null,
        sei: number | null
    ): LiveNode => {
        let nodeStatus: LiveNode['status'] = 'pending';
        if (inBuild && ci !== null) {
            if (depth === 0) {
                nodeStatus = ci < (catIdx ?? Infinity) ? 'created' : ci === catIdx ? 'generating' : 'pending';
            } else if (depth === 1 && ci === catIdx) {
                nodeStatus = ei !== null && ei < (elIdx ?? Infinity) ? 'created' : ei === elIdx ? 'generating' : 'pending';
            } else if (depth === 2 && ci === catIdx && ei === elIdx) {
                nodeStatus = sei !== null && sei < (seIdx ?? Infinity) ? 'created' : sei === seIdx ? 'generating' : 'pending';
            } else if (depth === 2) {
                // A detail of an already-finished topic.
                nodeStatus = 'created';
            }
        }
        return {
            key: depth === 0 ? `cat-${ci}` : depth === 1 ? `cat-${ci}-el-${ei}` : `cat-${ci}-el-${ei}-se-${sei}`,
            title: row.title,
            description: row.description || '',
            depth,
            status: nodeStatus,
            resourceCount: counts[row.id] || 0,
            children: [],
        };
    };

    // Walk the rows in pipeline coordinates: category index, then topic index
    // within it, then detail index within that.
    const tree: LiveNode[] = [];
    tops.forEach((cat, ci) => {
        const catNode = toNode(cat, 0, ci, null, null);
        kidsOf(cat.id).forEach((el, ei) => {
            const elNode = toNode(el, 1, ci, ei, null);
            kidsOf(el.id).forEach((se, sei) => {
                elNode.children.push(toNode(se, 2, ci, ei, sei));
            });
            catNode.children.push(elNode);
        });
        tree.push(catNode);
    });
    return tree;
}
