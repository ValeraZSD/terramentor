// The decisions of the mock exam screens that hold no React: where a mock
// opens, what its save line says, which clocks a closing page pauses.
// Kept apart so tools/mock-draw-gates.mjs can drive them.
import type { MockExamList } from './mockExamTypes';

/**
 * The question a mock opens on: the one this tab was on (`kept`, from
 * session storage), else the first not answered yet, else the first. Nothing
 * kept is not "question 1", though `Number(null)` is 0.
 */
export function openingPlace(kept: string | null, answered: boolean[]): number {
    const at = kept == null || kept.trim() === '' ? NaN : Number(kept);
    if (Number.isInteger(at) && at >= 0 && at < answered.length) return at;
    return Math.max(0, answered.findIndex(a => !a));
}

/** Failed sends in a row after which the save line stops saying "saving…". */
export const STUCK_AFTER = 3;

/**
 * What the save line says: nothing when all is written, "saving…" while a
 * save is on its way or being tried again, and that it is not saved once
 * `STUCK_AFTER` sends in a row have failed (no connection). The answers stay
 * queued and are still tried again either way.
 */
export function saveState(unsaved: number, failedInARow: number): 'saved' | 'saving' | 'stuck' {
    if (unsaved <= 0) return 'saved';
    return failedInARow >= STUCK_AFTER ? 'stuck' : 'saving';
}

/**
 * The mocks whose clock a closing page pauses: every running past paper and
 * course mock in the list (a course mock's own pause on leaving its screen
 * may have failed), and the one open now.
 */
export function runningSittings(data: Pick<MockExamList, 'papers' | 'courseSittings'> | null, open: number | null): number[] {
    const live = (s: { status: string; running: boolean }) => s.status === 'writing' && s.running;
    return [...new Set([
        ...(data?.papers.flatMap(p => p.sittings.filter(live).map(s => s.id)) ?? []),
        ...(data?.courseSittings.filter(live).map(s => s.id) ?? []),
        ...(open != null ? [open] : []),
    ])];
}
