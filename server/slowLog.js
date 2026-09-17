// server/slowLog.js — records the slow moments instead of asking someone to
// reproduce them.
//
// Why this exists: "every page loads for minutes sometimes" was reported while
// every measurement taken against a warm server said the opposite — 23 projects,
// 4,740 nodes and 12,697 cards answered every GET in under 35 ms, the eight
// files on the boot critical path arrived brotli-compressed in ~200 ms, and the
// heaviest routes rendered with no main-thread task over 120 ms (measured
// 2026-09-10). A stall nobody can reproduce on demand cannot be found by
// measuring again later; it has to be caught while it happens.
//
// Two instruments, because a stall shows up in exactly one of two shapes:
//
//   a slow REQUEST     — one handler took a long time (a model call on a path
//                        that answers the UI, a query that got expensive as the
//                        library grew, the disk waking up).
//   event-loop LAG     — no single request is slow but the whole process stops
//                        answering, because something between two awaits held
//                        the one thread. Every request in flight stalls together
//                        and none of them looks guilty on its own.
//
// Both stay silent until something is actually wrong, so this costs a timestamp
// per request and a timer every half second in the normal case, and the log is
// worth reading precisely because it is usually empty.

// Anything slower than this is worth a line. A local request here answers in
// single-digit milliseconds, so a whole second is already a hundredfold miss —
// low enough to catch the real thing, high enough that a cold atlas rebuild
// (~1.7 s, once per restart) is the only routine entry.
const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS) || 1000;

// The lag a person can feel. Node's timers are not precise to the millisecond
// and Windows schedules coarsely, so the floor has to sit clear of ordinary
// jitter; 250 ms is well past that and still under the threshold of "the app
// froze".
const LOOP_LAG_MS = Number(process.env.LOOP_LAG_MS) || 250;

const LAG_SAMPLE_MS = 500;

function stamp() {
    return new Date().toISOString().slice(11, 23);
}

/**
 * Express middleware: log the requests that took too long.
 *
 * Mounted first, so the time measured is the time the CLIENT waited — including
 * everything the body parser, the auth gate and the compression wrapper spend,
 * which a timer inside a route handler would miss.
 */
export function slowRequestLog() {
    return (req, res, next) => {
        const started = process.hrtime.bigint();
        res.on('finish', () => {
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            if (ms < SLOW_REQUEST_MS) return;
            // Streams are long by design: a tutor turn holds its socket open for
            // as long as the model talks, and a task feed for as long as the tab
            // is open. Logging those would bury the one line that matters.
            const type = String(res.getHeader('content-type') || '');
            if (type.includes('text/event-stream')) return;
            console.warn(`[Slow] ${stamp()} ${Math.round(ms)}ms ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
        });
        next();
    };
}

/**
 * Watch for the one thread going away.
 *
 * A timer set for `LAG_SAMPLE_MS` that fires late by more than `LOOP_LAG_MS`
 * proves the event loop was blocked for the difference, because nothing else can
 * delay it. That is the measurement — not an estimate of one.
 *
 * Returns the timer so a caller can stop it; unref'd so it never holds the
 * process open on shutdown.
 */
export function startEventLoopMonitor() {
    let expected = Date.now() + LAG_SAMPLE_MS;
    const timer = setInterval(() => {
        const now = Date.now();
        const lag = now - expected;
        expected = now + LAG_SAMPLE_MS;
        if (lag < LOOP_LAG_MS) return;
        // What was in flight matters more than the number: the point of the line
        // is to name the suspect, and a stall with a task running reads very
        // differently from one with the process apparently idle.
        console.warn(`[Stall] ${stamp()} the event loop was blocked for ${lag}ms`);
    }, LAG_SAMPLE_MS);
    timer.unref();
    return timer;
}
