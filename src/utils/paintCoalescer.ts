// One paint per interval for text that arrives in many small pieces.
//
// A streamed answer comes in a word or two at a time, 60+ pieces a second from a
// fast model, and the screen re-parses the whole answer as markdown on every
// paint. `push(text)` keeps only the newest text and paints it at most every
// `ms`; an empty text paints at once and drops a paint still waiting, so the
// last answer can never be painted over the start of the next turn.

export interface PaintTimers {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
}

const browserTimers: PaintTimers = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PaintCoalescer {
    push: (text: string) => void;
    /** Drop a paint still waiting (unmount). */
    cancel: () => void;
}

export function createPaintCoalescer(
    paint: (text: string) => void,
    ms: number,
    timers: PaintTimers = browserTimers,
): PaintCoalescer {
    let latest = '';
    let handle: unknown = null;
    const cancel = () => {
        if (handle != null) { timers.clear(handle); handle = null; }
    };
    return {
        push(text) {
            latest = text;
            if (!text) { cancel(); paint(''); return; }
            if (handle == null) {
                handle = timers.set(() => { handle = null; paint(latest); }, ms);
            }
        },
        cancel,
    };
}
