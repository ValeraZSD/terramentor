import type { SettingKey } from './assistantSettings';

/**
 * What each assistant turn did to the settings, kept OUTSIDE the chip that
 * shows it.
 *
 * The chip remounts whenever its message does, and a message remounts at
 * least once in its life: it is drawn under a provisional id while the turn
 * settles, and a history reload (the panel re-reads the conversation every
 * time the tab comes back) swaps that for the database's id. When the
 * apply-once guard and the before-values lived in the chip, the remount
 * claimed the turn a second time, read the ALREADY-CHANGED values as "before",
 * and its Undo restored what was on screen. An Undo pressed before the reload
 * was worse off still: the remount re-applied the change.
 *
 * Keyed by the turn (the drawer resolves both ids to the stored one), and held
 * for the life of the page. After a reload nothing is here, and the drawer
 * draws old turns in `record` mode, which applies nothing.
 */
export interface SettingRun {
    /** What each key held before this turn changed it. */
    before: Partial<Record<SettingKey, string | number>>;
    undone: boolean;
}

const runs = new Map<string, SettingRun>();

/** Claim a turn. True only the first time — the caller applies then, never again. */
export function beginRun(key: string, before: SettingRun['before']): boolean {
    if (runs.has(key)) return false;
    runs.set(key, { before, undone: false });
    return true;
}

export function runOf(key: string): SettingRun | undefined {
    return runs.get(key);
}

export function markRunUndone(key: string): void {
    const run = runs.get(key);
    if (run) runs.set(key, { ...run, undone: true });
}
