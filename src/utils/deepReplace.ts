/**
 * Replace a substring in every string inside a value, however deeply nested,
 * without knowing the value's shape.
 *
 * Written for one job: splicing a repaired visual spec into the feed card it
 * was read in. A lesson card keeps its markdown in `markdown`, a question card
 * its spec in `question` (and possibly `explanation`), a practice card in
 * `brief` or `solution` — three shapes, one repair. Naming the field per kind
 * meant a fourth card shape would silently not persist its repairs, which is
 * exactly the class of bug the write-back exists to prevent.
 *
 * Identity is the signal: the same object comes back when nothing matched, so a
 * caller can skip the state update and the network call in one check.
 */
export function deepReplaceStrings<T>(value: T, from: string, to: string): T {
    if (!from || from === to) return value;

    if (typeof value === 'string') {
        return (value.includes(from) ? value.split(from).join(to) : value) as unknown as T;
    }
    if (Array.isArray(value)) {
        let changed = false;
        const next = value.map(v => {
            const r = deepReplaceStrings(v, from, to);
            if (r !== v) changed = true;
            return r;
        });
        return (changed ? next : value) as unknown as T;
    }
    if (value && typeof value === 'object') {
        let changed = false;
        const next: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const r = deepReplaceStrings(v, from, to);
            if (r !== v) changed = true;
            next[k] = r;
        }
        return (changed ? next : value) as unknown as T;
    }
    return value;
}
