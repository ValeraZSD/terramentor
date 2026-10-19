import type { AITaskSummary } from '../../types';

/**
 * Where the task list stands on ONE visual build: every task carrying its key,
 * as `id:status`, in a fixed order. A block that is not following that build
 * (it looked before the build started, or saw it fail) re-checks when this
 * changes, so a build another device runs reaches it. '' when no task carries
 * the key. A string, so a store selector returning it re-renders only on a
 * real change.
 */
export function buildSignal(tasks: readonly AITaskSummary[], buildKey: string | null): string {
    if (!buildKey) return '';
    const parts: string[] = [];
    for (const t of tasks) if (t.buildKey === buildKey) parts.push(`${t.id}:${t.status}`);
    return parts.sort().join(',');
}
