import { KeyboardEvent, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Course } from './coursePaths';
import { CourseSwatch } from './atlasColors';
import { useNumberFormat } from '../../hooks/useNumberFormat';

interface Props {
    courses: Course[];
    /** The traced course, or null for none. */
    value: number | null;
    /** Pick a course to trace; the picked one pressed again lets it go. */
    onChange: (projectId: number | null) => void;
    /**
     * Each course's ladder in its own hue, when the map paints by course; empty
     * when it paints in the app's one colour, where a chip per course would be
     * a key to colours the map does not use.
     */
    swatches: CourseSwatch[];
}

/**
 * Every course on the map, and the way to trace one.
 *
 * It replaces two things that said the same list twice: the course select on
 * the map and the colour key under it. A colour key nobody can act on is
 * decoration, and a select of the same names says nothing about colour or
 * progress — one list does both, so each course is named once, beside the
 * colour the map paints it in and how much of it is finished.
 *
 * A listbox, because that is what it is: one choice out of many, made by
 * pressing a row, with the arrow keys moving between rows and one tab stop for
 * the whole list.
 */
export default function CourseList({ courses, value, onChange, swatches }: Props) {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const listRef = useRef<HTMLUListElement | null>(null);
    const byId = new Map(swatches.map(s => [s.id, s]));
    // The one row that takes Tab: the traced course, else the first.
    const tabRow = value != null && courses.some(c => c.id === value) ? value : courses[0]?.id;

    if (courses.length === 0) {
        return <p className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">{tr("No courses to show.")}</p>;
    }

    const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, i: number) => {
        const rows = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
        if (!rows) return;
        const go = (j: number) => { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, j))]?.focus(); };
        if (e.key === 'ArrowDown') go(i + 1);
        else if (e.key === 'ArrowUp') go(i - 1);
        else if (e.key === 'Home') go(0);
        else if (e.key === 'End') go(rows.length - 1);
        else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const id = courses[i].id;
            onChange(id === value ? null : id);
        }
    };

    return (
        <ul ref={listRef} role="listbox" aria-label={tr("Trace a course on the map")} className="py-1">
            {courses.map((c, i) => {
                const picked = c.id === value;
                const done = c.finished + c.undated;
                const sw = byId.get(c.id);
                return (
                    <li
                        key={c.id}
                        role="option"
                        aria-selected={picked}
                        tabIndex={c.id === tabRow ? 0 : -1}
                        data-row
                        onClick={() => onChange(picked ? null : c.id)}
                        onKeyDown={e => onKeyDown(e, i)}
                        className={`flex items-center gap-2.5 px-3 py-2 min-h-11 rounded-lg cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors ${picked
                            ? 'bg-accent/10 text-slate-900 dark:text-white'
                            : 'text-slate-700 dark:text-slate-200 can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-700/60'}`}
                    >
                        {sw && (
                            // The course's own five steps, untouched to all
                            // proven: hue says which course, lightness how far.
                            <span aria-hidden="true" className="flex shrink-0 rounded-sm overflow-hidden ring-1 ring-black/10 dark:ring-white/10">
                                {sw.steps.map((col, j) => <span key={j} className="w-1.5 h-3.5" style={{ background: col }} />)}
                            </span>
                        )}
                        <span className={`min-w-0 flex-1 truncate text-sm ${picked ? 'font-medium' : ''}`} title={c.name}>{c.name}</span>
                        {/* A label on a plain span is not read by every screen
                            reader, so the sentence is text and the figure is
                            only drawn. */}
                        <span aria-hidden="true" className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                            {num(done)}/{num(c.topics)}
                        </span>
                        <span className="sr-only">
                            {tr("{{done}} of {{count}} topics finished", { done: num(done), count: c.topics })}
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}
