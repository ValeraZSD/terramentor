/**
 * What a log line may say about text the learner's work produced.
 *
 * The server's console is not private: the desktop launcher copies every line
 * into a log file beside the library (desktop/launcher.js), a Docker install
 * keeps it in `docker compose logs`, and both are what a person attaches when
 * they report a problem. A search query is written from a topic's title, and a
 * topic's title is what the learner is studying, so it has no place there.
 *
 * `textTag` stands in for the text: its length and the first eight hex digits
 * of its SHA-256. Enough to see that two lines are about the same query, or
 * that a query was empty or enormous; not enough to read it back.
 */
import { createHash } from 'node:crypto';

export function textTag(text) {
    const s = String(text ?? '');
    return `${s.length} chars #${createHash('sha256').update(s).digest('hex').slice(0, 8)}`;
}
