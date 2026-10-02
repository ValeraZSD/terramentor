/**
 * The answer as a HUMAN should get it — what Copy puts on the clipboard.
 *
 * Every marker convention in this app exists because a model cannot be trusted
 * to write a control: it writes `[[mastery-check]]`, `[[open:3:41]]`,
 * `[[set:theme:dark]]` or `[[src:2]]`, and the APP turns each into a button, a
 * chip or a citation. Each surface already strips the ones it knows about
 * before rendering — and that is exactly where this went wrong: the tutor's
 * Copy handed over `msg.content`, the RAW stored message, so an answer pasted
 * into someone's notes arrived with `[[next-topic]]` still in it. Scaffolding
 * that means something to this app and nothing anywhere else.
 *
 * So Copy goes through one function that knows about all of them, rather than
 * each surface remembering its own list. A marker another surface owns is a
 * no-op here, which is the point: the tutor never writes `[[set:…]]`, but
 * stripping it costs nothing and means a fifth marker only has to be added
 * once.
 *
 * What is deliberately KEPT: everything the learner can see. A fenced
 * ```mermaid spec is the diagram's source and belongs in a paste of the answer;
 * the resolved `Sources:` line is attribution and should travel with the text
 * it supports.
 */

import { splitTutorActions, splitOpenTargets, splitDestinations } from './tutorActions';
import { splitSettingChanges } from './assistantSettings';
import { splitChecks, writeBlocksAsText } from './assistantWrites';
import { stripCitationMarkers } from './citations';
import type { AiAction } from '../types';

/** English, deliberately: the same server-written voice as the `Sources:` line. */
const SEARCHED_PREFIX = 'Searched the web: ';

/**
 * Strip every app-only marker from a stored message.
 *
 * @param content the message as stored (or as streamed so far)
 * @param streaming true while the text is still arriving, so a half-written
 *        marker at the very end is stripped too rather than flashing
 */
export function readableAnswer(content: string, streaming = false, actions?: AiAction[] | null): string {
    if (typeof content !== 'string' || !content) return '';
    const withoutActions = splitTutorActions(content, streaming).body;
    const withoutTargets = splitOpenTargets(withoutActions, streaming).body;
    const withoutDestinations = splitDestinations(withoutTargets, streaming).body;
    const withoutSettings = splitSettingChanges(withoutDestinations, streaming).body;
    // A proposed card or note is content the learner can SEE in its preview,
    // so a paste carries it in words; the check marker is only a button.
    const withoutChecks = splitChecks(withoutSettings, streaming).body;
    const body = stripCitationMarkers(writeBlocksAsText(withoutChecks)).trim();

    // The web queries are shown in the conversation as rows, where they
    // happened — but a paste has no "inline", and this is the one thing in the
    // app that sent anything off the machine. So it travels as a line, the way
    // the cited sources already do. A search of the learner's own library is
    // not named: it opened no socket, and it is not the reader's business.
    const searched = (actions ?? [])
        .filter(a => a.tool === 'search_web' && a.arg)
        .map(a => `“${a.arg}”`);
    if (!searched.length || body.includes(`\n${SEARCHED_PREFIX}`)) return body;
    return `${body}\n\n${SEARCHED_PREFIX}${[...new Set(searched)].join(' · ')}`;
}
