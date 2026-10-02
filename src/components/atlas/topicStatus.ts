import type { AtlasTopic } from '../../types';
import { k } from '../../i18n';

/**
 * What the atlas's topic card says about how far along a topic is, as a list
 * of (translation key, values) lines — pure, so tools/deck-gates.mjs can hold
 * it to the rule without a browser.
 *
 * Mastery evidence alone cannot answer it: the root of a deck with 491 cards
 * met, a section with 86 of 86 met and every chapter heading of every course
 * carry none, and "Not started" is false for all of them. So the card says what
 * IS known, counted the way the topic's project is counted (`countsInCards`,
 * the grid's rule):
 *
 *   closed                → Proven (or Skipped)
 *   answers on it         → its mastery and how many were answered
 *   counted in cards      → cards met
 *   otherwise, a heading  → topics done under it, and its cards met if any
 *   otherwise, a topic    → its cards met if any
 *   none of the above     → In progress, or Not started — the only place that
 *                           word is still used, where it is true
 */
export type StatusLine = { key: string; values: Record<string, string | number> };

export function topicStatusLines(topic: AtlasTopic, num: (n: number) => string): StatusLine[] {
    if (topic.status === 'completed') return [{ key: k("Proven"), values: {} }];
    if (topic.status === 'skipped') return [{ key: k("Skipped"), values: {} }];
    const lines: StatusLine[] = [];
    if (topic.attempts > 0) {
        lines.push({
            key: k("{{round}}% · {{attempts}} answered"),
            values: { round: Math.round(topic.mastery * 100), attempts: topic.attempts },
        });
    }
    const cards = topic.cards ?? 0;
    const cardsMet: StatusLine = {
        key: k("{{value}} / {{value2}} cards met"),
        values: { count: cards, value: num(topic.seen ?? 0), value2: num(cards) },
    };
    if (topic.inCards && cards > 0) {
        lines.push(cardsMet);
    } else {
        const total = topic.topics ?? 0;
        if (total > 0) {
            lines.push(total === 1
                ? { key: k("{{done}} / {{total}} topic done"), values: { done: num(topic.closed ?? 0), total: num(1) } }
                : { key: k("{{done}} / {{total}} topics done"), values: { done: num(topic.closed ?? 0), total: num(total) } });
        }
        if (cards > 0) lines.push(cardsMet);
    }
    if (lines.length === 0) {
        lines.push({ key: topic.status === 'in_progress' ? k("In progress") : k("Not started"), values: {} });
    }
    return lines;
}
