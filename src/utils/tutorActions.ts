/**
 * Tutor action markers.
 *
 * When the tutor finishes a topic it wants to offer the learner a next move —
 * "shall we practise more, or move on?". Left to prose, a local model *invents*
 * the answer: it confidently announces a next topic that isn't in the
 * curriculum ("Next: Data Analysis and Uncertainty…") and declares the current
 * one complete on its own authority. Both are lies the learner can't check.
 *
 * So the model never gets to say what happens next. It emits a bare marker on
 * its own line — the only thing it's actually qualified to judge, i.e. "this
 * learner looks ready" — and the APP supplies the rest: which node is really
 * next, what it's really called, and what clicking does. The model signals
 * intent; the store is the source of truth. A hallucinated topic name is
 * structurally impossible because the model never writes one.
 *
 * Markers over a ```fence (the other option): a fence is parsed as a code block,
 * so a half-streamed one flashes raw source, and it's more syntax for a 9B model
 * to get wrong. These strip out in the same pre-pass as the visual fences, so a
 * malformed marker degrades to nothing rather than rendering as junk.
 */

import { k } from '../i18n';

export type TutorAction = 'boss_fight' | 'next_topic';

const MARKERS: Record<string, TutorAction> = {
    'boss-fight': 'boss_fight',
    'next-topic': 'next_topic',
};

/** A complete marker: `[[boss-fight]]`. Tolerates case and inner spacing. */
const MARKER_RE = /\[\[\s*(boss-fight|next-topic)\s*\]\]/gi;

/**
 * A marker still being typed at the very end of a streaming message
 * (`[[next-to`). Stripped while streaming so the learner never sees the
 * scaffolding leak for a few frames before it completes.
 */
const PARTIAL_MARKER_RE = /\[\[[a-z0-9:-]*\]?$/i;

/**
 * The GLOBAL assistant's one marker: `[[open:projectId:nodeId]]`.
 *
 * Same contract as the markers above, stretched by exactly as much as it has to
 * be. The global coach talks across projects, so "open that" needs a referent —
 * but it still never writes the topic's NAME. It names an id; the app resolves
 * that id through POST /api/nodes/labels and renders the real title. An id the
 * model invented resolves to nothing and the button silently doesn't appear,
 * which is the same failure mode as a malformed marker: nothing, never a lie.
 */
/**
 * `[[open:projectId:nodeId]]` — matched LOOSELY and validated after.
 *
 * It used to require digits in both slots, which quietly broke the one rule
 * every marker here has: a model that wrote `[[open:2:NONE]]` (measured
 * 2026-09-15, a 9B asked to point at a project, which has no node id) did not
 * match, so it was not stripped, and the scaffolding was rendered to the
 * learner as literal text in the middle of an answer. An id that is not a
 * number must fail the way an invented one already does — no button, and
 * nothing on screen.
 */
const OPEN_MARKER_RE = /\[\[\s*open\s*:\s*([^\]:]*?)\s*:\s*([^\]:]*?)\s*\]\]/gi;

/** A slot that is a real positive id, or null. */
const asId = (raw: string): number | null => {
    const n = Number(String(raw).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
};

export interface OpenTarget {
    projectId: number;
    nodeId: number;
}

/**
 * Split `[[open:…]]` markers out of a global-assistant message.
 *
 * Returns the display text and the (unverified) targets, deduped by nodeId and
 * capped — the cap is a guard against a model that decides to point at
 * everything, not a design limit.
 */
export function splitOpenTargets(
    content: string,
    streaming = false,
): { body: string; targets: OpenTarget[] } {
    if (!content.includes('[[')) return { body: content, targets: [] };

    const targets: OpenTarget[] = [];
    // The marker comes OUT whatever is in it; only a well-formed one becomes a
    // button. Stripping is unconditional on purpose: leaked into the message it
    // is scaffolding the learner has to read past, and leaked into a Copy it is
    // nonsense in someone else's document.
    let body = content.replace(OPEN_MARKER_RE, (_m, pid: string, nid: string) => {
        const projectId = asId(pid);
        const nodeId = asId(nid);
        if (projectId !== null && nodeId !== null
            && targets.length < 3 && !targets.some(t => t.nodeId === nodeId)) {
            targets.push({ projectId, nodeId });
        }
        return '';
    });

    if (streaming) body = body.replace(PARTIAL_MARKER_RE, '');
    body = body.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');

    return { body, targets };
}

/**
 * Split tutor action markers out of a message.
 *
 * Returns the display text (markers removed) and the actions found, deduped and
 * in the order the model asked for them. Any text the model wrote *inside* a
 * marker is discarded — the label is ours to write, not its.
 */
export function splitTutorActions(
    content: string,
    streaming = false,
): { body: string; actions: TutorAction[] } {
    if (!content.includes('[[')) return { body: content, actions: [] };

    const actions: TutorAction[] = [];
    let body = content.replace(MARKER_RE, (_match, name: string) => {
        const action = MARKERS[name.toLowerCase()];
        if (action && !actions.includes(action)) actions.push(action);
        return '';
    });

    if (streaming) body = body.replace(PARTIAL_MARKER_RE, '');

    // Markers sit on their own line, so removing them leaves a blank line and a
    // trailing gap under the last paragraph.
    body = body.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');

    return { body, actions };
}

/**
 * The assistant's third marker: `[[go:SCREEN]]`.
 *
 * The drawer is reachable from every screen and, until this existed, could
 * reach none of them: it could point at a TOPIC (`[[open:p:n]]`) and at nothing
 * else, so "where do I see everything that's due this week?" ended in a
 * sentence describing a menu. Telling someone where a button is, from inside
 * the app that has the button, is the same obtuseness `[[set:…]]` was added to
 * fix.
 *
 * Same contract as every marker here, and for the same reason. The model names
 * a screen from a fixed list; it never writes the LABEL (the app does, in the
 * learner's language) and it never navigates (the learner presses). A key that
 * is not on this list produces nothing at all — no button, no error, no
 * apology. So the worst a hallucinated destination can do is not exist.
 *
 * These six are the app's own top-level routes (src/App.tsx) and the list is
 * deliberately exactly that: a destination that is not a route would need its
 * own mechanism to open, which is a different thing from navigation and should
 * look different when it arrives.
 */
export type DestinationKey = 'today' | 'projects' | 'calendar' | 'schedule' | 'atlas' | 'settings';

export interface Destination {
    key: DestinationKey;
    /** The route, exactly as App.tsx declares it. */
    path: string;
    /** English is the key; the drawer translates it at render. */
    label: string;
}

const DESTINATIONS: Record<DestinationKey, Destination> = {
    today: { key: 'today', path: '/', label: k('Today') },
    projects: { key: 'projects', path: '/projects', label: k('Projects') },
    calendar: { key: 'calendar', path: '/calendar', label: k('Calendar') },
    schedule: { key: 'schedule', path: '/schedule', label: k('Schedule') },
    atlas: { key: 'atlas', path: '/atlas', label: k('Atlas') },
    settings: { key: 'settings', path: '/settings', label: k('Settings') },
};

/** `[[go:calendar]]` — tolerant of case and inner spacing, like the others. */
const GO_MARKER_RE = /\[\[\s*go\s*:\s*([a-z_]+)\s*\]\]/gi;

/**
 * Split `[[go:…]]` markers out of an assistant message.
 *
 * Capped at two and deduped: a message that offers six places to go has stopped
 * answering the question and started being a menu.
 */
export function splitDestinations(
    content: string,
    streaming = false,
): { body: string; destinations: Destination[] } {
    if (!content.includes('[[')) return { body: content, destinations: [] };

    const destinations: Destination[] = [];
    let body = content.replace(GO_MARKER_RE, (_m, key: string) => {
        const found = DESTINATIONS[key.toLowerCase() as DestinationKey];
        if (found && destinations.length < 2 && !destinations.some(d => d.key === found.key)) {
            destinations.push(found);
        }
        return '';
    });

    if (streaming) body = body.replace(PARTIAL_MARKER_RE, '');
    body = body.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');

    return { body, destinations };
}
