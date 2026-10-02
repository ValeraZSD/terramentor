import { Globe, FolderSearch, Gauge, Loader2, Check, X, Search, Files, FileText, BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AiAction } from '../types';
import { useNumberFormat } from '../hooks/useNumberFormat';
import { summarizeLookups } from '../utils/turnTimeline';

/**
 * What the answer DID, shown where it happened.
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
 * So a row appears the moment the model asks for a lookup and fills in when it
 * lands, AT ITS PLACE in the turn: inside the reasoning panel when the model
 * looked while still thinking, between the answer's paragraphs when it looked
 * after it had begun (utils/turnTimeline.ts). This component draws one group
 * of rows wherever it is put; `compact` is the size it takes inside the
 * reasoning panel, whose text is a size smaller than the answer's.
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
    list_documents: Files,
    read_document: FileText,
    read_topic: BookOpen,
};

/** Tools whose single result is the thing named on the row, never "1 result". */
const ONE_THING = new Set(['project_state', 'read_document', 'read_topic']);

export default function AiActions({ actions, className = '', compact = false }: {
    actions: AiAction[] | null | undefined;
    className?: string;
    /** Inside the reasoning panel: the panel's own text size. */
    compact?: boolean;
}) {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    if (!actions?.length) return null;

    const icon = compact ? 'w-3.5 h-3.5' : 'w-4 h-4';
    return (
        <ul className={`space-y-1 ${className}`}>
            {actions.map((a, i) => {
                const Icon = TOOL_ICON[a.tool] ?? Search;
                const running = a.state === 'running';
                // A lookup that could not run (an engine that refused, a tool
                // that broke) is not one that found nothing: it gets its own
                // word and mark. `failed` is set by server/aiTools.js; the
                // summary test reads web rows stored before the flag existed.
                const failed = !running && (a.failed === true || a.summary === 'the search failed');
                // The verb says which machine was asked, because that is the
                // difference the learner cares about: one of these opened a
                // socket and the others read their own database.
                const verb = a.tool === 'search_web' ? tr("Searched the web")
                    : a.tool === 'find_in_library' ? tr("Looked through your library")
                        // A label, not a verb: "Read the state of" before a
                        // quoted name has an English word order.
                        : a.tool === 'project_state' ? tr("Project state")
                            : a.tool === 'list_documents' ? tr("Listed the documents in")
                                : a.tool === 'read_document' ? tr("Read the document")
                                    : a.tool === 'read_topic' ? tr("Read the topic")
                                        : a.tool;
                // A read or a project has one answer, not "1 result": the row
                // names the thing it read, and says so only when there was none.
                const oneThing = ONE_THING.has(a.tool);
                const part = a.part;
                const partText = !part ? ''
                    : part.unit === 'page'
                        ? (part.from === part.to
                            ? tr("page {{from}} of {{total}}", { from: num(part.from), total: num(part.of) })
                            : tr("pages {{from}}–{{to}} of {{total}}", { from: num(part.from), to: num(part.to), total: num(part.of) }))
                        : tr("characters {{from}}–{{to}} of {{total}}", { from: num(part.from), to: num(part.to), total: num(part.of) });
                const outcome = running ? ''
                    : failed ? tr("failed")
                    : typeof a.count !== 'number' ? ''
                    : a.count === 0 ? tr("nothing")
                        : oneThing ? partText
                            : a.tool === 'list_documents' ? tr("{{documents}} documents", { count: a.count, documents: num(a.count) })
                                : `${a.count} ${a.count === 1 ? tr("result") : tr("results")}`;
                return (
                    <li
                        key={`${a.tool}:${a.arg}:${i}`}
                        className={`flex items-start gap-2 ${compact ? 'text-xs' : 'text-sm'} text-slate-500 dark:text-slate-400`}
                    >
                        <Icon className={`${icon} mt-0.5 shrink-0 text-slate-400 dark:text-slate-500`} aria-hidden="true" />
                        <span className="min-w-0 break-words">
                            <span className="text-slate-600 dark:text-slate-300">{verb}</span>
                            {' '}
                            <span className="text-slate-500 dark:text-slate-400">“{a.label || a.arg}”</span>
                            {outcome && (
                                <>
                                    {' · '}
                                    <span>{outcome}</span>
                                </>
                            )}
                        </span>
                        {running
                            ? <Loader2 className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} mt-1 shrink-0 animate-spin text-slate-400`} aria-hidden="true" />
                            : failed
                                ? <X className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} mt-1 shrink-0 text-slate-400 dark:text-slate-500`} aria-hidden="true" />
                                : <Check className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} mt-1 shrink-0 text-slate-400 dark:text-slate-500`} aria-hidden="true" />}
                    </li>
                );
            })}
        </ul>
    );
}

/** A name as the header quotes it: short enough that two fit on one line. */
const quoteName = (s: string) => `“${s.length > 48 ? `${s.slice(0, 47).trimEnd()}…` : s}”`;

/**
 * What a group of rows did, in words, one phrase per tool — the reasoning
 * panel's header, which has to say what the turn looked up even while the
 * panel is folded shut ("searched the web 2 times · looked up “VWO Physics”").
 * Every phrase is a `count` key, so it plurals in every language.
 */
export function describeLookups(actions: AiAction[] | null | undefined, tr: TFunction): string[] {
    return summarizeLookups(actions).map(({ tool, count, names }) => {
        const named = names.slice(0, 2).map(quoteName).join(', ');
        switch (tool) {
            case 'search_web':
                return tr("searched the web {{count}} times", { count });
            case 'find_in_library':
                return tr("looked through your library {{count}} times", { count });
            case 'project_state':
                return names.length && names.length <= 2
                    ? tr("looked up {{names}}", { names: named })
                    : tr("looked up {{count}} projects", { count: names.length || count });
            case 'list_documents':
                return names.length && names.length <= 2
                    ? tr("listed the documents in {{names}}", { names: named })
                    : tr("listed documents {{count}} times", { count });
            case 'read_document':
                return names.length && names.length <= 2
                    ? tr("read {{names}}", { names: named })
                    : tr("read {{count}} documents", { count: names.length || count });
            case 'read_topic':
                return names.length && names.length <= 2
                    ? tr("read the topic {{names}}", { names: named })
                    : tr("read {{count}} topics", { count: names.length || count });
            default:
                return tool;
        }
    });
}
