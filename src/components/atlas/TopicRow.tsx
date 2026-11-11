import { ArrowUpRight, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AtlasTopic } from '../../types';
import { topicDotStatus } from './topicStatus';

const STATUS_DOT: Record<string, string> = {
    completed: 'bg-emerald-500',
    in_progress: 'bg-amber-500',
    skipped: 'bg-slate-400',
    not_started: 'bg-slate-300 dark:bg-slate-600',
};

/**
 * One topic in the atlas's index: its status dot, its name, one muted line
 * under it, and the arrow that says the row leaves the map for the topic.
 *
 * Shared by a region's topic list and "Study next", so the two read as the
 * same kind of row: the second line is the only thing they say differently.
 */
export default function TopicRow({ topic, detail, onOpen }: {
    topic: AtlasTopic;
    /** The muted line under the name. */
    detail: string;
    onOpen: () => void;
}) {
    const { t: tr } = useTranslation();
    return (
        <button
            data-row
            onClick={onOpen}
            className="group w-full flex items-center gap-2 px-2 py-1.5 min-h-11 rounded-lg text-left can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-700/60 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
            <span
                aria-hidden="true"
                className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[topicDotStatus(topic)] || STATUS_DOT.not_started}`}
            />
            <span className="min-w-0 flex-1">
                <span className="block text-sm text-slate-700 dark:text-slate-200 truncate">
                    {topic.title}
                    {topic.transferred && (
                        <>
                            <Sparkles className="inline w-3 h-3 ml-1 -mt-0.5 text-accent-fg" aria-hidden="true" />
                            <span className="sr-only">{tr("started with a head start from another project")}</span>
                        </>
                    )}
                </span>
                <span className="block text-2xs text-slate-500 dark:text-slate-400 truncate">
                    {detail}
                </span>
            </span>
            <ArrowUpRight className="w-3.5 h-3.5 shrink-0 text-slate-400 dark:text-slate-500 can-hover:group-hover:text-accent-fg group-focus-visible:text-accent-fg" aria-hidden="true" />
        </button>
    );
}
