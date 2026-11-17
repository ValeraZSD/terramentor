/**
 * The stored description of a card picture (server/mediaDescribe.js), asked
 * for once per file per page load and read as its alt text.
 *
 * A file with no description gives '' and is not asked again; one written
 * later reaches the card after a reload. A 4xx answer is final too (no such
 * file in the library: a 404 every time it is asked). Only a failure that may
 * pass (the network, a 5xx) is forgotten, so the next card showing the file
 * asks again. At most `MAX_KEPT` files are remembered, oldest dropped first.
 */
export const MAX_KEPT = 500;
const kept = new Map<string, Promise<string>>();

type InfoFetch = (hash: string) => Promise<{ description: string | null }>;

export function storedDescription(hash: string, fetchInfo: InfoFetch): Promise<string> {
    const known = kept.get(hash);
    if (known) return known;
    const pending = fetchInfo(hash).then(
        (r) => (r.description ?? '').trim(),
        (e: { status?: number } | null) => {
            const status = Number(e?.status);
            if (!(status >= 400 && status < 500)) kept.delete(hash);
            return '';
        },
    );
    kept.set(hash, pending);
    if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
    return pending;
}

/** For the gate: how many files are remembered now. */
export const keptCount = () => kept.size;
