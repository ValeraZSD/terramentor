/**
 * How many AI project creations may talk to the model at once.
 *
 * A run is thousands of sequential calls, and on a single-slot local server
 * two unthrottled runs would
 * interleave inside the model server and each would wait on the other's every
 * call — both slower, and each one's timings (and so its "~x left") measuring
 * the other's work. So a run takes a SLOT for its whole length, and the number
 * of slots is the provider's own concurrency (`aiConcurrency`: 1 on a local
 * server, 3 on a hosted API). A run that finds none free waits in line and
 * says where it is; it can be cancelled while it waits.
 *
 * `limit` is read on every pump, so switching provider mid-queue takes effect
 * at the next release.
 */
export function createSlotGate(limit) {
    let running = 0;
    const waiting = [];   // { resolve, reject, onPosition, signal, onAbort }

    const cap = () => {
        let n = 1;
        try { n = Number(limit()); } catch { n = 1; }
        return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
    };

    const tellPositions = () => {
        waiting.forEach((w, i) => { try { w.onPosition?.(i + 1); } catch { /* a listener is never fatal */ } });
    };

    const grant = () => {
        running += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            running -= 1;
            pump();
        };
    };

    function pump() {
        while (waiting.length && running < cap()) {
            const w = waiting.shift();
            w.signal?.removeEventListener('abort', w.onAbort);
            w.resolve(grant());
        }
        tellPositions();
    }

    return {
        /**
         * Resolves with a `release()` once a slot is free. Rejects with an
         * AbortError if `signal` aborts while waiting. `onPosition(n)` hears the
         * 1-based place in line whenever it changes (never called when a slot
         * is free at once).
         */
        acquire(signal, onPosition) {
            if (signal?.aborted) return Promise.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
            if (running < cap() && waiting.length === 0) return Promise.resolve(grant());
            return new Promise((resolve, reject) => {
                const w = { resolve, reject, onPosition, signal, onAbort: null };
                w.onAbort = () => {
                    const i = waiting.indexOf(w);
                    if (i >= 0) waiting.splice(i, 1);
                    reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
                    tellPositions();
                };
                signal?.addEventListener('abort', w.onAbort, { once: true });
                waiting.push(w);
                tellPositions();
            });
        },
        running: () => running,
        waiting: () => waiting.length,
    };
}
