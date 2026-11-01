import type { ReactNode } from 'react';
import { ArrowRight, type LucideIcon } from 'lucide-react';

/**
 * One section of a project's overview: the panel, its header and its padding.
 *
 * Sections that each pick their own padding, header icon colour and icon size
 * read top to bottom as a page of unrelated widgets, so the shape is decided
 * here once. The icon is the accent: colour on this page belongs to progress,
 * not to telling sections apart.
 */
export function DashboardSection({ icon: Icon, title, action, children }: {
    icon: LucideIcon;
    title: ReactNode;
    /** Something small at the header's far end (a dismiss, a count). */
    action?: ReactNode;
    children: ReactNode;
}) {
    return (
        // `h-full`: in a band of the course page the cells stretch to the
        // tallest one, and the panel has to fill its cell for neighbours to
        // share a bottom edge. Stacked, 100% of an auto height is auto.
        <section className="h-full rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5 sm:p-6 shadow-sm">
            <div className="mb-4 flex items-center gap-2 min-h-8">
                <Icon className="w-5 h-5 shrink-0 text-accent-fg" aria-hidden="true" />
                <h3 className="min-w-0 flex-1 text-sm font-semibold text-slate-900 dark:text-white">{title}</h3>
                {action}
            </div>
            {children}
        </section>
    );
}

/**
 * The tiles of a Tools section. Each tile is at least 18rem (icon, a title, a
 * one-line hint, the arrow) and grows to share its row, so every row is full
 * edge to edge however many tools there are and however wide the section is:
 * three across over the page's full width, one per row in a half-width cell.
 * A grid of fixed columns left five tools as three and two with a hole, and
 * divided full-width rows left the middle of every row empty.
 */
export function ToolGrid({ children }: { children: ReactNode }) {
    return <div className="flex flex-wrap gap-3 [&>*]:flex-[1_1_18rem]">{children}</div>;
}

/**
 * A door to a tool in the Tools section at the foot of the overview. The tools
 * are things a learner reaches for now and then (the saved quizzes, ask the
 * assistant, build material in bulk, add readings, take the placement after
 * putting it off), so they sit below the course, never between the learner
 * and it.
 */
export function ToolRow({ icon: Icon, title, hint, onClick }: {
    icon: LucideIcon;
    title: string;
    hint: string;
    onClick: () => void;
}) {
    return (
        <button data-row="tool"
            type="button"
            onClick={onClick}
            // A tile with its own edge, not a divided row: in a Tools section
            // the full width of the page, divided rows left their middle
            // empty (title at the left, arrow at the far right, nothing
            // between). Tiles wrap and GROW to fill each row (see `ToolGrid`).
            className="min-w-0 flex items-center gap-3 px-3 py-3 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/40 transition text-left group"
        >
            <span className="p-1.5 rounded-lg bg-accent/10 shrink-0" aria-hidden="true">
                <Icon className="w-4 h-4 text-accent-fg" />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-slate-900 dark:text-white">{title}</span>
                <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">{hint}</span>
            </span>
            <ArrowRight className="w-4 h-4 text-slate-400 shrink-0 group-hover:text-accent-fg transition" aria-hidden="true" />
        </button>
    );
}
