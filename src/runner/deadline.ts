import { RUNNER_LIMITS } from '../../server/runnerFrame.js';

/**
 * `work`, or a rejection once the start-up limit has passed. A chunk or a file
 * that never arrives would otherwise leave "Starting…" on screen and a grade
 * waiting for ever; a promise kept in a cache would hold every later run too.
 */
export function withinLoadLimit<T>(work: Promise<T>, what: string, ms: number = RUNNER_LIMITS.loadMs): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`runner: ${what} did not arrive in ${Math.round(ms / 1000)} s`)), ms);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
