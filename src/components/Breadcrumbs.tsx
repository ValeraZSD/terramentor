import { useStore } from '../store';
import { getNodePath } from '../utils/tree';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The ANCESTOR trail of the selected node — never the node itself, which the
 * detail panel renders right below as one editable title.
 *
 * It gets its OWN LINE. Sharing the title's row is what made both unreadable:
 * this panel is a column, often 380px wide, and it also has to hold Study,
 * search and Close. Three ancestors at up to 150px each plus those buttons
 * left the title — the one string that says what you are looking at, and the
 * one you click to rename — squeezed to a single letter. On its own line the
 * trail can show the whole path and the title gets the full width.
 *
 * The middle of a long trail still collapses to an ellipsis: the top of the
 * tree and the immediate parent are what orient you; the levels between are a
 * click away in the tree itself.
 */
const MAX_CRUMBS = 4;

export default function Breadcrumbs() {
    const { t } = useTranslation();
    const tree = useStore(s => s.tree);
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const selectNode = useStore(s => s.selectNode);
    const setExpanded = useStore(s => s.setExpanded);

    if (!selectedNodeId) return null;

    const fullPath = getNodePath(tree, selectedNodeId);
    const path = fullPath.slice(0, -1);
    if (path.length === 0) return null;

    const handleClick = (nodeId: number) => {
        // Open every ancestor, so the tree shows where you have just gone.
        fullPath.forEach(node => {
            if (node.id !== nodeId) setExpanded(node.id, true);
        });
        selectNode(nodeId);
    };

    const collapsed = path.length > MAX_CRUMBS
        ? [path[0], null, ...path.slice(-(MAX_CRUMBS - 1))]
        : path;
    const hidden = path.length > MAX_CRUMBS
        ? path.slice(1, -(MAX_CRUMBS - 1)).map(n => n.title).join(' › ')
        : '';

    return (
        <nav
            aria-label={t("Breadcrumb")}
            className="flex items-center gap-0.5 min-w-0 overflow-hidden text-xs text-slate-500 dark:text-slate-400"
        >
            {collapsed.map((node, index) => (
                <div key={node ? node.id : 'gap'} className="flex items-center gap-0.5 min-w-0">
                    {index > 0 && (
                        <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-300 dark:text-slate-600" aria-hidden="true" />
                    )}
                    {node === null ? (
                        <span className="shrink-0 px-1" title={hidden} aria-label={hidden}>…</span>
                    ) : (
                        <button
                            onClick={() => handleClick(node.id)}
                            className="truncate max-w-[10rem] px-1.5 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-200 transition"
                            title={node.title}
                        >
                            {node.title}
                        </button>
                    )}
                </div>
            ))}
        </nav>
    );
}
