import { Globe, FolderSearch, Gauge, Loader2, Check, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AiAction } from '../types';

/**
 * What the answer DID before it answered, shown where it happened.
 *
 * The lookups a turn runs (server/aiTools.js) were first reported two ways, and
 * both were wrong in the same direction: a transient status line that vanished
 * the moment the first token arrived, and a `Searched the web: "…"` line
 * appended to the bottom of the finished answer. The first meant the four
 * seconds before an answer had no explanation you could still read; the second
 * put the record of a thing that happened FIRST underneath the thing it
 * happened for, where it reads as a footnote about the app rather than as a
 * step the answer took.
 *
 * So it is one list, at the top of the turn, in the order things happened — a
 * row appears the moment the model asks for a lookup and fills in when it
 * lands. That makes the waiting legible while it is happening, and leaves a
 * record afterwards, from the same component, with no second rendering path.
 *
 * WHAT A ROW MAY SAY. The verb and the outcome are the APP's words; the only
 * thing here the model wrote is the argument, and it is quoted so it reads as
 * one. A tool this build does not know still renders — a row saying something
 * happened is always better than a silent gap, and the name is at least true.
 */

const TOOL_ICON: Record<string, typeof Globe> = {
    search_web: Globe,
    find_in_library: FolderSearch,
    project_state: Gauge,
};

export default function AiActions({ actions, className = '' }: { actions: AiAction[] | null | undefined; className?: string }) {
    const { t: tr } = useTranslation();
    if (!actions?.length) return null;

    return (
        <ul className={`space-y-1 ${className}`}>
            {actions.map((a, i) => {
                const Icon = TOOL_ICON[a.tool] ?? Search;
                const running = a.state === 'running';
                // The verb says which machine was asked, because that is the
                // difference the learner cares about: one of these opened a
                // socket and the other read their own database.
                const verb = a.tool === 'search_web' ? tr("Searched the web")
                    : a.tool === 'find_in_library' ? tr("Looked through your library")
                        // A label, not a verb: "Read the state of" before a
                        // quoted name has an English word order.
                        : a.tool === 'project_state' ? tr("Project state")
                            : a.tool;
                // A project read has one answer, not "1 result": the row names
                // the project it read, and says so only when there was none.
                const oneThing = a.tool === 'project_state';
                return (
                    <li
                        key={`${a.tool}:${a.arg}:${i}`}
                        className="flex items-start gap-2 text-sm text-slate-500 dark:text-slate-400"
                    >
                        <Icon className="w-4 h-4 mt-0.5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                        <span className="min-w-0">
                            <span className="text-slate-600 dark:text-slate-300">{verb}</span>
                            {' '}
                            <span className="text-slate-500 dark:text-slate-400">“{a.label || a.arg}”</span>
                            {!running && typeof a.count === 'number' && !(oneThing && a.count > 0) && (
                                <>
                                    {' · '}
                                    <span>{a.count === 0
                                        ? tr("nothing")
                                        : `${a.count} ${a.count === 1 ? tr("result") : tr("results")}`}</span>
                                </>
                            )}
                        </span>
                        {running
                            ? <Loader2 className="w-3.5 h-3.5 mt-1 shrink-0 animate-spin text-slate-400" aria-hidden="true" />
                            : <Check className="w-3.5 h-3.5 mt-1 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />}
                    </li>
                );
            })}
        </ul>
    );
}
