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
 * Two to four, as Claude's own ask-the-user options are: one answer is not a
 * choice, and past four the list is read rather than glanced at. Sixty
 * characters is two lines of a button at a phone's width.
 */
export const CHOICES_MIN = 2;
export const CHOICES_MAX = 4;
export const CHOICE_LABEL_MAX = 60;

const plain = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

/** One answer, whatever its case and spacing: "Some basics" and " some  basics". */
export function sameAnswer(a, b) {
    const x = plain(a);
    return x !== '' && x === plain(b);
}
