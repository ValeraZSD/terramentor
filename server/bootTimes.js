// Where a start's time went, as one log line.
//
// A first launch of the day took 20-45 s with no log line between the
// launcher's "Data directory" and "Serving at", so a slow start could not be
// told apart into reading the app's files, opening the library, migrating it,
// or a machine too busy paging to run anything. Each phase now records when it
// ended and how much CPU the process had used by then; `bootLine` turns them
// into one `[Boot]` line when the server listens. CPU far below the wall time
// is waiting (a cold disk, memory paged out), the same verdict a `[Stall]`
// line gives (server/slowLog.js).
//
// No imports beyond Node's own: the marks are taken while the app's modules
// are still being evaluated.

import { performance } from 'node:perf_hooks';

const marks = [];

/** Record that the phase `name` ended now. Times are from process start. */
export function bootMark(name) {
    const { user, system } = process.cpuUsage();
    marks.push({ name, at: performance.now(), cpu: (user + system) / 1000 });
}

export function bootMarks() {
    return marks.slice();
}

const kindText = (wallMs, cpuMs) => {
    if (cpuMs >= wallMs * 0.6) return 'computing';
    if (cpuMs <= wallMs * 0.3) return 'mostly waiting: the disk, or memory paged out';
    return 'partly waiting';
};

const sec = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;

/**
 * `[Boot] listening 33.1 s after the process started (CPU 4.2 s, mostly waiting: …):
 * launcher 0.40 s, modules 28.0 s, …` — each phase is the time since the one
 * before it, in the order they were marked; the last is the listen itself.
 */
export function bootLine(list = marks) {
    if (!list.length) return null;
    const last = list[list.length - 1];
    let prev = 0;
    const parts = list.map((m) => {
        const part = `${m.name} ${sec(m.at - prev)}`;
        prev = m.at;
        return part;
    });
    return `[Boot] listening ${sec(last.at)} after the process started `
        + `(CPU ${sec(last.cpu)}, ${kindText(last.at, last.cpu)}): ${parts.join(', ')}`;
}
