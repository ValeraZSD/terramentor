/**
 * Does this course's Study open on a written lesson yet? The creation screen
 * offers "Start studying" once it does (`runFoot`), so the press lands on the
 * lesson and not on the Overview that stands in for one while it is written.
 *
 * Asked while the screen is open and `asking` (a foot that could offer it):
 * once on opening, and again each time the lesson writer moves to its next
 * item, the signal the study page itself pulls new lessons on
 * (`feedGenSignal`). Yes stays yes: a written lesson is never unwritten, so
 * the asking stops there. A failed request is asked again on the next signal.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import { feedGenSignal } from '../../utils/feedPlacement';

export function useFirstLessonWritten(projectId: number | null, asking: boolean): boolean {
    // A string, so the task list's ~4 snapshots a second re-render nothing
    // until the writer actually moves on.
    const signal = useStore(s => feedGenSignal(s.aiTasks));
    const [writtenFor, setWrittenFor] = useState<number | null>(null);
    const written = projectId != null && writtenFor === projectId;
    // An answer is kept only for the course still on screen. Not cancelled on
    // a newer signal: an older answer is still true, and a writer moving on
    // every second would otherwise drop every one.
    const shown = useRef(projectId);
    shown.current = projectId;

    useEffect(() => {
        if (projectId == null || !asking || written) return;
        api.getFirstLesson(projectId)
            .then(r => { if (r.written && shown.current === projectId) setWrittenFor(projectId); })
            .catch(() => { /* asked again on the writer's next move */ });
    }, [projectId, asking, written, signal]);

    return written;
}
