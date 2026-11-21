/**
 * Does this course's Study open on a written lesson yet? The creation screen
 * offers "Start Studying" once it does (`runFoot`), so the press lands on the
 * lesson and not on the Overview that stands in for one while it is written.
 *
 * Asked while the screen is open and `asking` (`footOffersStudy`): once on
 * opening, and again each time the lesson writer moves to its next item, the
 * signal the study page itself pulls new lessons on (`feedGenSignal`). Every
 * answer counts, a no after a yes too: a lesson part that fails its fact
 * check is deleted and written again, and the button must not open Study on
 * the stand-in meanwhile.
 *
 * One request at a time: a move while one is out asks once more when it
 * settles. A failed request is tried once more a few seconds later (a
 * finished run sends no more moves), then waits for the writer's next move.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import { feedGenSignal } from '../../utils/feedPlacement';

const RETRY_MS = 5000;

export function useFirstLessonWritten(projectId: number | null, asking: boolean): boolean {
    // A string, so the task list's ~4 snapshots a second re-render nothing
    // until the writer actually moves on.
    const signal = useStore(s => feedGenSignal(s.aiTasks));
    // The latest answer per course, so switching between two runs' screens
    // keeps each one's instead of asking from nothing.
    const [answers, setAnswers] = useState<ReadonlyMap<number, boolean>>(() => new Map());
    const [nudge, setNudge] = useState(0);
    const busy = useRef(false);
    const again = useRef(false);
    const retried = useRef(false);
    const mounted = useRef(true);
    const timer = useRef<number | undefined>(undefined);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; window.clearTimeout(timer.current); };
    }, []);

    useEffect(() => {
        if (projectId == null || !asking) return;
        if (busy.current) { again.current = true; return; }
        busy.current = true;
        api.getFirstLesson(projectId)
            .then(r => {
                retried.current = false;
                if (!mounted.current) return;
                setAnswers(m => (m.get(projectId) === r.written ? m : new Map(m).set(projectId, r.written)));
            })
            .catch(() => {
                if (retried.current || !mounted.current) return;
                retried.current = true;
                timer.current = window.setTimeout(() => setNudge(n => n + 1), RETRY_MS);
            })
            .finally(() => {
                busy.current = false;
                if (again.current && mounted.current) { again.current = false; setNudge(n => n + 1); }
            });
    }, [projectId, asking, signal, nudge]);

    return projectId != null && answers.get(projectId) === true;
}
