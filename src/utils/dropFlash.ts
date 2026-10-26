// The flash that shows where a dragged item landed. A drop updates the list at
// once, so the item is simply somewhere else on the next frame and the eye has
// to hunt for it; its background then flashes once in the accent where it now
// sits (Atlassian's rule for Jira and Trello: the selected-background colour,
// 700 ms, cubic-bezier(0.25, 0.1, 0.25, 1)). Drawn by `.drop-flash` in
// `index.css`, requested by each drag surface on a drop that changed the order.
//
// Kept outside React because the item may not be the element that was dragged:
// a row carried into another category card REMOUNTS there, and a project moved
// to another section is a new card. The request is keyed by what moved
// (`node:<id>`, `project:<id>`) and stamped with when the flash starts, so a
// card mounted mid-flash resumes it (a negative animation delay) instead of
// replaying it, and a re-render changes nothing.

export const DROP_FLASH_MS = 700;

type Clock = { now: () => number; schedule: (run: () => void, ms: number) => void };

export function createDropFlash(clock: Clock) {
    const starts = new Map<string, number>();
    const listeners = new Set<() => void>();
    const notify = () => listeners.forEach((l) => l());
    return {
        /** Flash `key` where it lands, `after` ms from now (a drop animation still flying it home). */
        request(key: string, after = 0): void {
            const at = clock.now() + after;
            starts.set(key, at);
            notify();
            clock.schedule(() => {
                // A newer drop of the same item owns the entry now.
                if (starts.get(key) !== at) return;
                starts.delete(key);
                notify();
            }, after + DROP_FLASH_MS);
        },
        /** When `key`'s flash starts, or undefined when it is not flashing. */
        startOf(key: string): number | undefined {
            return starts.get(key);
        },
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        /** The animation delay an element mounted now gives a flash starting at `start`: negative once it is under way. */
        delayFor(start: number): number {
            return Math.round(start - clock.now());
        },
    };
}

const dropFlash = createDropFlash({
    now: () => performance.now(),
    schedule: (run, ms) => { setTimeout(run, ms); },
});

export const flashAfterDrop = dropFlash.request;
export const dropFlashStart = dropFlash.startOf;
export const subscribeDropFlash = dropFlash.subscribe;
export const dropFlashDelay = dropFlash.delayFor;
