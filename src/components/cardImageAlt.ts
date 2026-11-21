import type { MediaDescriber } from '../types';

/**
 * What a screen reader reads for a picture on a card, in order of trust:
 *
 *  1. the alt text the deck carried for this use of the picture (its author's);
 *  2. the description stored on the FILE (`media_files.description`): the
 *     author's, the learner's own correction, or a vision model's. A model's
 *     is said to be one (`aiLabel`), because it can be wrong and a listener
 *     cannot see the picture to tell;
 *  3. the filename, which on a vocabulary deck is often the word itself.
 *
 * Never empty: a card picture is content, not decoration, so `alt=""` would
 * hide it. Pinned by `tools/alt-text-gates.mjs`.
 */
export function imageAltText(
    item: { alt?: string; name?: string },
    info: { description: string | null; described_by: MediaDescriber | null } | null | undefined,
    aiLabel: (description: string) => string,
): string {
    const own = item.alt?.trim();
    if (own) return own;
    const stored = info?.description?.trim();
    if (stored) return info?.described_by === 'vision' ? aiLabel(stored) : stored;
    return item.name?.trim() || 'Card image';
}

/** Does this picture still need its stored description looked up? Only when the card carried none. */
export const needsStoredDescription = (item: { alt?: string }) => !item.alt?.trim();
