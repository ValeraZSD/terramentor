import { useId } from 'react';
import { ArrowUpRight, History, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AtlasTopic } from '../../types';
import { k } from '../../i18n';
import { topicDotStatus } from './topicStatus';
import OwnLine from '../ui/OwnLine';

const STATUS_DOT: Record<string, string> = {
    completed: 'bg-emerald-500',
    in_progress: 'bg-amber-500',
    skipped: 'bg-slate-400',
    not_started: 'bg-slate-300 dark:bg-slate-600',
};

/** The dot's words: a colour alone says nothing to a screen reader or to a
 *  reader who cannot tell emerald from amber. */
const STATUS_WORD: Record<string, string> = {
    completed: k("Proven"),
    in_progress: k("In progress"),
    skipped: k("Skipped"),
    not_started: k("Not started"),
};

/**
 * One topic in the atlas's index: its status dot, its name, one muted line
 * under it, and the mark that says where the row goes.
 *
 * Shared by a region's topic list and "Study next". A region's row opens the
 * topic (the arrow: it leaves the map for the topic). A "Study next" row
 * starts the topic's lesson, so it carries a play mark and is named
 * "Study <topic>": two rows that look alike must not act differently.
 */
export default function TopicRow({ topic, detail, onOpen, studies = false }: {
    topic: AtlasTopic;
    /** The muted line under the name. */
    detail: string;
    onOpen: () => void;
    /** The row starts the lesson rather than opening the topic. */
    studies?: boolean;
}) {
    const { t: tr } = useTranslation();
    const dot = topicDotStatus(topic);
    const uid = useId();
    // Ids only where something points at them.
    const statusId = studies ? `${uid}s` : undefined;
    const detailId = studies ? `${uid}d` : undefined;
    const headStartId = studies && topic.transferred ? `${uid}h` : undefined;
    return (
        <button
            data-row
            onClick={onOpen}
            // A "Study next" row is named "Study <topic>" from a hidden phrase
            // in its own text, not an aria-label, which would hide the line
            // under the title from the name (label in name). The status, the
            // head-start note and that line are read as its description.
            aria-describedby={studies ? [statusId, headStartId, detailId].filter(Boolean).join(' ') : undefined}
            className="group w-full flex items-center gap-2 px-2 py-1.5 min-h-11 rounded-lg text-start can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-700/60 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
            <span
                aria-hidden="true"
                className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[dot] || STATUS_DOT.not_started}`}
            />
            <span id={statusId} aria-hidden={studies || undefined} className="sr-only">{tr(STATUS_WORD[dot] || STATUS_WORD.not_started)}</span>
            {studies && <span className="sr-only">{tr("Study {{title}}", { title: topic.title })}</span>}
            <span className="min-w-0 flex-1" aria-hidden={studies || undefined}>
                <span className="block text-sm text-slate-700 dark:text-slate-200 truncate">
                    <OwnLine>{topic.title}</OwnLine>
                    {topic.transferred && (
                        <>
                            <History className="inline w-3 h-3 ms-1 -mt-0.5 text-accent-fg" aria-hidden="true" />
                            <span id={headStartId} className="sr-only">{tr("started with a head start from another project")}</span>
                        </>
                    )}
                </span>
                <span id={detailId} className="block text-2xs text-slate-500 dark:text-slate-400 truncate">
                    {detail}
                </span>
            </span>
            {studies
                // Filled and in the accent at rest, like the play mark on
                // the cards panel's Study button: it is the row's action, not
                // a hint that shows on hover.
                ? <Play className="w-3.5 h-3.5 shrink-0 fill-current text-accent-fg" aria-hidden="true" />
                : <ArrowUpRight className="w-3.5 h-3.5 shrink-0 text-slate-400 dark:text-slate-500 can-hover:group-hover:text-accent-fg group-focus-visible:text-accent-fg" aria-hidden="true" />}
        </button>
    );
}
