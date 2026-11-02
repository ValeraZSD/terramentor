/**
 * Saving a switch that moves the moment it is pressed, before the write
 * answers. Presses can overlap and their answers can come back in any order,
 * so "put it back to the opposite of this press" is wrong when two presses
 * both fail (on, off, both refused: it ends ON over a stored OFF). Instead,
 * once the last answer is in, the switch goes where the last write that took
 * left it: a failed save never leaves it showing what was not written.
 *
 *   const saveAnyModel = useRef(switchSaver()).current;
 *   await saveAnyModel(on, setAnyModel, () => api.setSetting(...));  // rejects when the write failed
 */
export function switchSaver() {
    let pending = 0;
    let stored = false;
    return async function save(next: boolean, show: (on: boolean) => void, write: () => Promise<unknown>): Promise<void> {
        // The first press of a burst: the switch showed the other position, and that is what is stored.
        if (pending++ === 0) stored = !next;
        show(next);
        try {
            await write();
            stored = next;
        } finally {
            if (--pending === 0) show(stored);
        }
    };
}
