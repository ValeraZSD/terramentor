/**
 * The answers the assistant may offer under a question it asks, for the
 * learner to tap instead of typing: their limits, and when two lines of a
 * block are the same answer.
 *
 * One module for both sides: the assistant's prompt (`CHOICES_GUIDE` in
 * server/ai.js) states these numbers, and the client's parser
 * (src/utils/assistantChoices.ts) keeps to them, so the model is never told a
 * limit the app does not hold. tools/chat-choices-gates.mjs reads both.
 *
 * Two to four, as coding agents' ask-the-user tools offer: one answer is not a
 * choice, and past four the list is read rather than glanced at. Sixty
 * characters is two lines of a button at a phone's width.
 */
export const CHOICES_MIN = 2;
export const CHOICES_MAX = 4;
export const CHOICE_LABEL_MAX = 60;

// Full-width ASCII (U+FF01..U+FF5E) folds to its plain letter, and nothing
// else does: NFKC would also make "x²" the same answer as "x2" and "H₂O" as
// "H2O", and drop one of two different answers.
const halfWidth = (s) => Array.from(s, (ch) => {
    const c = ch.codePointAt(0);
    return c >= 0xFF01 && c <= 0xFF5E ? String.fromCodePoint(c - 0xFEE0) : ch;
}).join('');
// toLowerCase, not toLocaleLowerCase, so the device's language (a Turkish
// dotted i) never decides what counts as the same.
const plain = (s) => halfWidth(String(s ?? '').normalize('NFC')).replace(/\s+/g, ' ').trim().toLowerCase();

/** One answer, whatever its case, spacing or width: "Some basics", " some  basics", "Ｓｏｍｅ basics". */
export function sameAnswer(a, b) {
    const x = plain(a);
    return x !== '' && x === plain(b);
}
