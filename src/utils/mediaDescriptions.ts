import type { MediaInfo } from '../types';

/**
 * What is stored about a card picture (server/mediaDescribe.js), asked for once
 * per file per page load: a review shows the same picture many times, and its
 * description only changes when the learner edits it (`forgetStoredInfo`).
 *
 * Only an answer worth keeping is kept: a description, or a 4xx (no such file in
 * the library: a 404 every time it is asked). A picture the description sweep
 * has not reached yet, a network failure or a 5xx is forgotten, so the next card
 * showing the file asks again. At most `MAX_KEPT` files are remembered, oldest
 * dropped first.
 */
export const MAX_KEPT = 500;
const kept = new Map<string, Promise<MediaInfo | null>>();

type InfoFetch = (hash: string) => Promise<MediaInfo | null>;

export function storedInfo(hash: string, fetchInfo: InfoFetch): Promise<MediaInfo | null> {
    const known = kept.get(hash);
    if (known) return known;
    const pending = fetchInfo(hash).then(
        (info) => {
            if (!info?.description?.trim()) kept.delete(hash);
            return info ?? null;
        },
        (e: { status?: number } | null) => {
            const status = Number(e?.status);
            if (!(status >= 400 && status < 500)) kept.delete(hash);
            return null;
        },
    );
    kept.set(hash, pending);
    if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
    return pending;
}

/** Drop a file's kept answer after its description was edited, so the next card reads the new one. */
export function forgetStoredInfo(hash: string) {
    kept.delete(hash);
}

/** For the gate: how many files are remembered now. */
export const keptCount = () => kept.size;
