import { ReactNode, CSSProperties, forwardRef } from 'react';
import { useAccentVars } from '../../hooks/useAccentVars';
import { CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
    /** Project colour — re-points the accent vars inside the card (ProjectCard pattern). */
    projectColor?: string | null;
    projectName?: string | null;
    nodeTitle?: string | null;
    /** Small line under the project name, e.g. "Part 2 of 3 · Derivatives". */
    subtitle?: ReactNode;
    /** Chip rendered at the top-right (e.g. "Overdue", "New card"). */
    badge?: ReactNode;
    done?: boolean;
    onOpenNode?: () => void;
    children: ReactNode;
}

/**
 * Common chrome for every feed card: white rounded card, project-accent strip
 * and header, done-check. Done cards keep their full size (collapsing them
 * would shift the scroll position of everything below) — they just show the
 * check and let the reader scroll on.
 */
const FeedCardShell = forwardRef<HTMLElement, Props>(function FeedCardShell(
    { projectColor, projectName, nodeTitle, subtitle, badge, done = false, onOpenNode, children }, ref,
) {
    const { t } = useTranslation();
    // The rail is drawn exactly as in ChapterGroup: the card's own left border
    // at 4px, so it follows `rounded-2xl` around the top-left and bottom-left
    // corners instead of being cut flat by them. The colour is inline because
    // `dark:border-slate-700` on the same element beats a `border-l-accent`
    // class and turns the rail grey in dark mode.
    const accent = useAccentVars(projectColor);
    const accentStyle = accent && { ...accent, borderLeftColor: 'rgb(var(--accent-rgb))' } as CSSProperties;

    return (
        <section
            ref={ref}
            style={accentStyle}
            aria-label={nodeTitle || projectName || t("Feed card")}
            className={`relative bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden scroll-mt-20${projectColor ? ' border-l-4' : ''}`}
        >
            <div className="p-4 sm:p-6">
                {(projectName || nodeTitle || badge) && (
                    <div className="flex items-start justify-between gap-3 mb-3">
                        <div className="min-w-0">
                            {projectName && (
                                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 truncate">
                                    {projectName}
                                </p>
                            )}
                            {nodeTitle && (
                                onOpenNode ? (
                                    <button
                                        onClick={onOpenNode}
                                        className="text-left text-base font-semibold text-slate-900 dark:text-white hover:underline line-clamp-2 break-words block max-w-full"
                                        title={t("Open this topic")}
                                    >
                                        {nodeTitle}
                                    </button>
                                ) : (
                                    <h3 className="text-base font-semibold text-slate-900 dark:text-white line-clamp-2 break-words">
                                        {nodeTitle}
                                    </h3>
                                )
                            )}
                            {subtitle && (
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
                            )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            {badge}
                            {done && <CheckCircle2 className="w-5 h-5 text-emerald-500" aria-label={t("Done")} />}
                        </div>
                    </div>
                )}
                {children}
            </div>
        </section>
    );
});

export default FeedCardShell;
