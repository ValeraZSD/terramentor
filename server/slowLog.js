// server/slowLog.js — records the slow moments instead of asking someone to
// reproduce them.
//
// Why this exists: a report of "every page loads for minutes sometimes" can
// coexist with every measurement against a warm server saying the opposite.
// A stall nobody can reproduce on demand cannot be found by measuring again
// later; it has to be caught while it happens.
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

// The requests seen lately, so a stall can say what was being answered while
// the thread was gone. Method and path only, never the query (the [Slow] line
// keeps its own shape).
const RECENT_MAX = 64;
const recent = [];

/** The requests in flight at any moment of [from, to], as at most three labels. */
export function requestsDuring(from, to, list = recent) {
    const labels = [];
    for (const r of list) {
        if (r.start > to || (r.end && r.end < from)) continue;
        // A stream is open by design (the task feed, a tutor turn): it would
        // stand in every stall line and name nothing.
        if (typeof r.isStream === 'function' ? r.isStream() : r.isStream) continue;
        if (!labels.includes(r.label)) labels.push(r.label);
    }
    return labels.slice(-3);
}

/**
 * What a stall was, from the CPU the process used while it lasted. A thread
 * held by work burns CPU the whole time; one held by a synchronous read the
 * disk is slow to answer, or by memory Windows paged out while the app sat
 * idle, burns almost none. The two need different fixes, and the bare
 * duration cannot tell them apart. Pure, for the gate.
 *
 * `cpuMs` is read once per tick, so it covers the whole time since the last
 * tick (`windowMs`: the sample period plus the lag), and it is weighed against
 * that same time: against the lag alone, 450 ms of work then 550 ms of waiting
 * read as computing.
 */
export function stallKind(lagMs, cpuMs, windowMs = lagMs) {
    const span = Math.max(lagMs, windowMs);
    if (cpuMs >= span * 0.6) return 'busy';
    if (cpuMs <= span * 0.3) return 'waiting';
    return 'mixed';
}

const KIND_TEXT = {
    busy: 'computing',
    waiting: 'waiting, not computing: the disk, or memory paged out',
    mixed: 'partly computing, partly waiting',
};

/** One [Stall] line. Pure, for the gate. */
export function stallLine({ at, lagMs, cpuMs, windowMs = lagMs, during }) {
    const what = during.length ? ` during ${during.join(', ')}` : ' with no request in flight';
    return `[Stall] ${at} the event loop was blocked for ${lagMs}ms (CPU ${cpuMs} ms, ${KIND_TEXT[stallKind(lagMs, cpuMs, windowMs)]})${what}`;
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
        const entry = {
            label: `${req.method} ${String(req.originalUrl || req.url).split('?')[0]}`, start: Date.now(), end: 0,
            isStream: () => String(res.getHeader('content-type') || '').includes('text/event-stream'),
        };
        recent.push(entry);
        if (recent.length > RECENT_MAX) recent.shift();
        const ended = () => { entry.end ||= Date.now(); };
        res.on('close', ended);
        res.on('finish', () => {
            ended();
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            if (ms < SLOW_REQUEST_MS) return;
            // Streams are long by design: a tutor turn holds its socket open for
            // as long as the model talks, and a task feed for as long as the tab
            // is open. Logging those would bury the one line that matters.
            const type = String(res.getHeader('content-type') || '');
            if (type.includes('text/event-stream')) return;
            // The path only: a query is search text, a filter, a topic's words.
            console.warn(`[Slow] ${stamp()} ${Math.round(ms)}ms ${entry.label} -> ${res.statusCode}`);
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
    // This thread's CPU, not the process's: zlib, file and crypto work on the
    // thread pool while the loop waits on a paged-out page would read as
    // "computing". (process.cpuUsage where the per-thread call is missing.)
    const usage = typeof process.threadCpuUsage === 'function' ? () => process.threadCpuUsage() : () => process.cpuUsage();
    let lastCpu = usage();
    let lastTick = Date.now();
    const timer = setInterval(() => {
        const now = Date.now();
        const lag = now - expected;
        expected = now + LAG_SAMPLE_MS;
        const at = usage();
        const cpu = { user: at.user - lastCpu.user, system: at.system - lastCpu.system };
        lastCpu = at;
        const windowMs = now - lastTick;
        lastTick = now;
        if (lag < LOOP_LAG_MS) return;
        // What was in flight matters more than the number: the point of the line
        // is to name the suspect, and a stall with a task running reads very
        // differently from one with the process apparently idle. The CPU spent
        // says whether the thread was working or waiting (stallKind).
        console.warn(stallLine({
            at: stamp(), lagMs: lag, cpuMs: Math.round((cpu.user + cpu.system) / 1000), windowMs,
            during: requestsDuring(now - lag - LAG_SAMPLE_MS, now),
        }));
    }, LAG_SAMPLE_MS);
    timer.unref();
    return timer;
}
