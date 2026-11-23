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
 * A picture marked `prompt` is the thing a card asks about (the front of a
 * card made from a topic's photo, server/photoCards.js): its stored
 * description names the answer, so it is read as `promptLabel` and nothing
 * else, and the description is never even fetched.
 *
 * Never empty: a card picture is content, not decoration, so `alt=""` would
 * hide it. Pinned by `tools/alt-text-gates.mjs` and `tools/photo-practice-gates.mjs`.
 */
export function imageAltText(
    item: { alt?: string; name?: string; prompt?: boolean },
    info: { description: string | null; described_by: MediaDescriber | null } | null | undefined,
    aiLabel: (description: string) => string,
    promptLabel = 'Photo to recognise',
): string {
    if (item.prompt) return promptLabel;
    const own = item.alt?.trim();
    if (own) return own;
    const stored = info?.description?.trim();
    if (stored) return info?.described_by === 'vision' ? aiLabel(stored) : stored;
    return item.name?.trim() || 'Card image';
}

/** Does this picture still need its stored description looked up? Only when the card carried none, and never for a prompt. */
export const needsStoredDescription = (item: { alt?: string; prompt?: boolean }) => !item.prompt && !item.alt?.trim();
