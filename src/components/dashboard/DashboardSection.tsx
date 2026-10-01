import type { ReactNode } from 'react';
import { ArrowRight, type LucideIcon } from 'lucide-react';

/**
 * One section of a project's overview: the panel, its header and its padding.
 *
 * The overview grew one section at a time and each brought its own shape —
 * `p-6`, `p-5`, `p-4 sm:p-6`; a header icon in amber, emerald, sky, blue or the
 * accent; one card leading with a 36px tinted tile where the rest have a 20px
 * glyph beside the title. Read top to bottom that is a page of unrelated
 * widgets, so the shape is decided here once. The icon is the accent: colour on
 * this page belongs to progress, not to telling sections apart.
 */
export function DashboardSection({ icon: Icon, title, action, children }: {
    icon: LucideIcon;
    title: ReactNode;
    /** Something small at the header's far end (a dismiss, a count). */
    action?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5 sm:p-6 shadow-sm">
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
 * A door to a tool, one row of the Tools section at the foot of the overview.
 * The tools are things a learner reaches for now and then — ask the assistant,
 * build material in bulk, add readings, take the placement after putting it
 * off — so they sit below the course, never between the learner and it. Rows,
 * not a grid of tiles: a fourth tool in a three-across grid sat alone on a row
 * of its own, and a list has no such count.
 */
export function ToolRow({ icon: Icon, title, hint, onClick }: {
    icon: LucideIcon;
    title: string;
    hint: string;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            className="w-full flex items-center gap-3 px-2 py-3 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700/40 transition text-left group"
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
