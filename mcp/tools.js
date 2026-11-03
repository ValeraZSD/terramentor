// The tools an agent harness sees, each a thin call to the running app
// (mcp/app.js → server/routes/agent.js). Five READ the library; two PROPOSE:
// a capture into the Inbox, and a claim that the learner answered something;
// two OPEN a view the host draws (mcp/views.js): the app's own mastery check
// and card review, which the learner takes in the host's window. Nothing the
// model sends can prove a topic: the mastery gate is cleared only by the app's
// own mastery check, quizzes and paper exercises (server/claims.js says what a
// claim may and may not move), and a check in a view is the app's check, with
// the learner's answers. tools/mcp-gates.mjs pins the list, the annotations
// and that boundary.

import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { AppError } from './app.js';
import { VIEWS, VIEW_MIME, viewHtml } from './views.js';

export const SERVER_NAME = 'terramentor';

const INSTRUCTIONS = [
    'Terramentor is the learner\'s own study app, running on their computer: their courses (projects of sections and topics),',
    'lessons, cards, what is due and how well each topic is known. Read it before teaching: project_state or find_in_library',
    'to see what they study and to get real ids, get_due for today, topic_material for a topic\'s lesson text, get_mastery for',
    'where a topic stands. Use only ids these tools returned; never invent one.',
    'When the learner answers a question you asked them on a topic, send record_claim. A claim is a note, not proof: it never',
    'raises a topic\'s mastery, and only Terramentor\'s own mastery check proves a topic, so send the learner there to prove it.',
    'add_capture saves something to study later into their Inbox.',
    'To prove a topic, open mastery_check: where this host draws views the learner takes Terramentor\'s own check right here,',
    'and you see only that it is open and then the score; never answer it or quiz them on it in its place. review_cards opens',
    'their due cards the same way.',
].join(' ');

/** The MCP Apps extension (spec 2026-01-26): a host that draws views says so in its capabilities. */
const UI_EXTENSION = 'io.modelcontextprotocol/ui';
/** Where the view finds its sitting and language in a tool result: `_meta`, which a host keeps from its model. */
const SITTING = 'terramentor/sitting';
const LANGUAGE = 'terramentor/language';
const NOTHING = 'terramentor/nothing';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const PROPOSE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const reply = (text, structuredContent) => ({
    content: [{ type: 'text', text }],
    ...(structuredContent && typeof structuredContent === 'object' ? { structuredContent } : {}),
});
const failure = (text) => ({ content: [{ type: 'text', text }], isError: true });

/** Run a tool body; an app failure is the tool's answer, worded for the model. */
async function guarded(body) {
    try {
        return await body();
    } catch (err) {
        if (err instanceof AppError) return failure(err.message);
        return failure(`The Terramentor MCP server failed: ${String(err?.message || err).slice(0, 300)}`);
    }
}

/**
 * A topic named by nodeId or title. A number is taken too: models and the
 * Inspector both send an id as one, and refusing `3` for `"3"` helps nobody.
 */
const topicRef = z.union([z.string().min(1).max(200), z.number().int().positive()]);

/** A topic reference for record_claim: the nodeId, as a number or its digits. */
function nodeIdOf(topic) {
    const s = String(topic ?? '').trim();
    return /^\d{1,15}$/.test(s) ? Number(s) : null;
}

/**
 * One McpServer over one app client. `appFor()` returns the client for the
 * current request, so the HTTP listener can bind each request's own key.
 */
export function buildServer({ version, appFor }) {
    const server = new McpServer({ name: SERVER_NAME, title: 'Terramentor', version }, { instructions: INSTRUCTIONS });

    server.registerTool('project_state', {
        title: 'Project outline and progress',
        description: 'The learner\'s study projects. With no project: every project with its projectId. '
            + 'With a projectId or a name: that project\'s outline — sections and topics with their nodeIds, status, '
            + 'dates, progress and what is due or overdue. Read it to see what the learner studies and where they are.',
        inputSchema: z.object({
            project: z.string().max(200).optional().describe('A projectId or (part of) a project\'s name. Leave out to list every project.'),
        }),
        annotations: READ,
    }, ({ project }) => guarded(async () => {
        const r = await appFor().get('/api/agent/state', { project });
        return reply(r.text, r.projectId ? { projectId: r.projectId } : undefined);
    }));

    server.registerTool('find_in_library', {
        title: 'Search the library',
        description: 'Search the whole library for a word or two: project names, topic titles and Overviews, saved links and '
            + 'documents. Returns each hit with its ids, or says plainly that nothing matches. Use it to find whether the learner '
            + 'already has a topic before teaching it.',
        inputSchema: z.object({
            query: z.string().min(1).max(200).describe('A word or two, e.g. "doppler" or "past tense".'),
        }),
        annotations: READ,
    }, ({ query }) => guarded(async () => reply((await appFor().get('/api/agent/find', { q: query })).text)));

    server.registerTool('get_due', {
        title: 'What is due today',
        description: 'Today\'s work across every active project, in the learner\'s own day: overdue and planned topics with their '
            + 'nodeIds, cards due for review, deadlines and pace, most urgent project first. Read it to pick what to study now.',
        inputSchema: z.object({}),
        annotations: READ,
    }, () => guarded(async () => {
        const r = await appFor().get('/api/agent/due');
        return reply(r.text, r.due);
    }));

    server.registerTool('topic_material', {
        title: 'A topic\'s lesson text',
        description: 'One topic as the course holds it: its Overview, its Material (the lesson text) and the topics under it. '
            + 'Teach from this so you follow the course\'s own notation and level. The learner\'s private notes are never included. '
            + 'A long topic comes in parts: the answer says which "from" to ask for next.',
        inputSchema: z.object({
            topic: topicRef.describe('The topic\'s nodeId (from project_state or find_in_library), or its title.'),
            from: z.number().int().min(0).optional().describe('Character offset to read on from, as the previous part said.'),
        }),
        annotations: READ,
    }, ({ topic, from }) => guarded(async () => {
        const r = await appFor().get('/api/agent/topic', { topic, from });
        return r.found ? reply(r.text) : failure(r.text);
    }));

    server.registerTool('get_mastery', {
        title: 'How well a topic is known',
        description: 'Where one topic stands: the estimated mastery, whether it has passed the mastery gate, the evidence the app '
            + 'measured (quizzes, checks, cards) and the claims agents sent, counted apart. Read it before deciding to review or move on.',
        inputSchema: z.object({
            topic: topicRef.describe('The topic\'s nodeId, or its title.'),
        }),
        annotations: READ,
    }, ({ topic }) => guarded(async () => {
        const r = await appFor().get('/api/agent/mastery', { topic });
        return r.mastery ? reply(r.text, r.mastery) : failure(r.text);
    }));

    server.registerTool('add_capture', {
        title: 'Save to the Inbox',
        description: 'Save something the learner wants to study later — a note, a question, a link — into their Terramentor Inbox, '
            + 'where they can turn it into a topic. A note with no link whose text is already there is not saved again; '
            + 'anything with a link is saved each time. If the app has an AI model connected, it '
            + 'tidies the note in the background as it does every capture.',
        inputSchema: z.object({
            text: z.string().max(20000).optional().describe('The note itself.'),
            url: z.string().max(2000).regex(/^https?:\/\/\S+$/i, 'url must be an http:// or https:// address').optional()
                .describe('A web link (http or https) to keep with it.'),
            title: z.string().max(200).optional().describe('A short title; made from the text when left out.'),
        }),
        annotations: PROPOSE,
    }, ({ text, url, title }) => guarded(async () => {
        if (!String(text || '').trim() && !String(url || '').trim()) return failure('Give the note\'s text, a url, or both.');
        const r = await appFor().post('/api/capture', { text, url, title, once: true, via: 'agent' });
        const saved = { nodeId: r.nodeId, projectId: r.projectId, existed: !!r.existed };
        return reply(r.existed
            ? `Already in the learner's Inbox (nodeId ${r.nodeId}); nothing was added.`
            : `Saved to the learner's Inbox as nodeId ${r.nodeId}. They can turn it into a topic from there.`, saved);
    }));

    server.registerTool('record_claim', {
        title: 'Record an answer you graded',
        description: 'Record that the learner answered one of YOUR questions on a topic, right or wrong, as you graded it. '
            + 'Terramentor keeps it as a claim beside its own evidence: a right claim never raises the topic\'s mastery and can never '
            + 'pass the mastery gate (only the app\'s own mastery check does); a wrong one may lower the estimate, once until the '
            + 'learner answers on that topic in the app again. Send one claim per answer, each with its own attempt_id.',
        inputSchema: z.object({
            topic: z.union([z.string().max(20), z.number().int()]).describe('The topic\'s nodeId (a number from project_state or find_in_library). Not a title.'),
            correct: z.boolean().describe('Whether the learner\'s answer was right.'),
            question_type: z.string().max(40).optional()
                .describe('The question\'s format, if it was one of: multiple_choice, true_false, short_answer, fill_in, numeric, code, sequence.'),
            attempt_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional()
                .describe('An id of your choice for this answer; sending the same id again records nothing new (safe to retry).'),
        }),
        annotations: PROPOSE,
    }, ({ topic, correct, question_type: questionType, attempt_id: attemptId }) => guarded(async () => {
        const nodeId = nodeIdOf(topic);
        if (nodeId == null) return failure('record_claim needs the topic\'s nodeId (a number) from project_state or find_in_library, not a title.');
        const r = await appFor().post('/api/agent/claims', { nodeId, correct, questionType, attemptId });
        const pct = (x) => `${Math.round(x * 100)}%`;
        const EFFECTS = {
            right: 'The estimate is unchanged: a claim never raises it.',
            lowered: `The estimate went from ${pct(r.masteryBefore)} to ${pct(r.masteryAfter)}.`,
            already_lowered: 'The estimate is unchanged: an earlier wrong claim already lowered it, and claims lower a topic '
                + 'once until the learner answers on it in Terramentor again.',
            at_seed: 'The estimate is unchanged: it sits at a head start (placement or another course) that only the '
                + 'learner\'s own answers in Terramentor can take away.',
            no_estimate: 'The topic has no estimate yet, so there was nothing to lower.',
            unchanged: 'The estimate is unchanged.',
        };
        const effect = EFFECTS[r.effect] || EFFECTS.unchanged;
        // A retry gets the first call's outcome back, which may be stale by
        // now: say only that it is a retry, not what it did.
        const said = r.duplicate
            ? `This ${correct ? 'right' : 'wrong'} answer on "${r.title}" (nodeId ${r.nodeId}) was already recorded as a claim (same attempt_id); nothing new was written.`
            : `Recorded a ${correct ? 'right' : 'wrong'} answer on "${r.title}" (nodeId ${r.nodeId}) as a claim. ${effect}`;
        return reply(`${said} A claim is not evidence the app measured: to prove the topic, the learner takes its mastery check in Terramentor.`, r);
    }));

    registerViews(server, appFor);
    return server;
}

/**
 * The mastery check and the card review, drawn by the host (MCP Apps). Two
 * tools the model may call open them; seven more are the views' own, listed
 * with visibility ["app"] and only to a host that draws views. The sitting's
 * token rides in the result's `_meta`, which reaches the view and not the
 * model; the questions, keys and cards travel only in the app-only tools'
 * answers, and keys only after the check is submitted (server/agentSittings.js).
 */
function registerViews(server, appFor) {
    const drawsViews = () => {
        const ext = server.server.getClientCapabilities()?.extensions?.[UI_EXTENSION];
        return Array.isArray(ext?.mimeTypes) && ext.mimeTypes.includes(VIEW_MIME);
    };
    const languageMeta = (r) => (typeof r.language === 'string' && r.language ? { [LANGUAGE]: r.language } : {});

    for (const [kind, view] of Object.entries(VIEWS)) {
        server.registerResource(view.name, view.uri, {
            title: view.title,
            description: view.description,
            mimeType: VIEW_MIME,
            _meta: { ui: { prefersBorder: true } },
        }, async () => ({
            contents: [{ uri: view.uri, mimeType: VIEW_MIME, text: viewHtml(kind), _meta: { ui: { prefersBorder: true } } }],
        }));
    }
    const opensView = (uri) => ({ ui: { resourceUri: uri }, 'ui/resourceUri': uri });
    const OPEN = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

    server.registerTool('mastery_check', {
        title: 'Take a mastery check',
        description: 'Open a topic\'s mastery check for the learner: questions drawn from the topic\'s checked bank, graded and '
            + 'recorded by Terramentor. It is the only way an agent can have a topic proved. Where this host draws app views the learner takes it '
            + 'right here; you never see its questions or answers, only that it is open and then the score. Elsewhere the answer '
            + 'is a link that opens the topic in Terramentor. Never answer it for the learner.',
        inputSchema: z.object({
            topic: topicRef.describe('The topic\'s nodeId (from project_state or find_in_library), or its title.'),
        }),
        annotations: OPEN,
        _meta: opensView(VIEWS.check.uri),
    }, ({ topic }) => guarded(async () => {
        const app = appFor();
        if (!drawsViews()) {
            const r = await app.get('/api/agent/check/where', { topic });
            const link = `${app.origin}/project/${r.projectId}/tree/${r.nodeId}`;
            return reply(`This host does not draw Terramentor's views, so the mastery check on "${r.title}" is taken in Terramentor: `
                + `${link} opens the topic, and its mastery check is there. Only that check proves the topic; do not quiz the learner on it in its place.`,
            { nodeId: r.nodeId, projectId: r.projectId, link });
        }
        const r = await app.post('/api/agent/check/start', { topic });
        return {
            content: [{ type: 'text', text: r.text }],
            structuredContent: { nodeId: r.nodeId, projectId: r.projectId, title: r.title, questions: r.count ?? 0, open: !!r.token },
            _meta: { ...(r.token ? { [SITTING]: r.token } : {}), ...languageMeta(r) },
        };
    }));

    server.registerTool('review_cards', {
        title: 'Review due cards',
        description: 'Open a review of the learner\'s due cards, in one project or across every active project. Where this host '
            + 'draws app views the learner reviews them right here, rating each card, and Terramentor schedules it; you never see '
            + 'the cards, only how the session ended. Elsewhere the answer says how many are due and links to them in Terramentor.',
        inputSchema: z.object({
            project: z.string().max(200).optional().describe('A projectId or (part of) a project\'s name. Leave out for every active project.'),
        }),
        annotations: OPEN,
        _meta: opensView(VIEWS.review.uri),
    }, ({ project }) => guarded(async () => {
        const app = appFor();
        if (!drawsViews()) {
            const r = await app.get('/api/agent/review/where', { project });
            const where = r.projectName ? `"${r.projectName}"` : 'the learner\'s active projects';
            const link = r.projectId ? `${app.origin}/project/${r.projectId}/study` : `${app.origin}/`;
            return reply(r.count
                ? `${r.count} card${r.count === 1 ? ' is' : 's are'} due in ${where}. This host does not draw Terramentor's views, so they are reviewed in Terramentor: ${link}`
                : `No cards are due in ${where} right now.`, { count: r.count, projectId: r.projectId, link });
        }
        const r = await app.post('/api/agent/review/start', { project });
        return {
            content: [{ type: 'text', text: r.text }],
            structuredContent: { projectId: r.projectId, cards: r.total ?? 0, open: !!r.token },
            _meta: { ...(r.token ? { [SITTING]: r.token } : { [NOTHING]: 'no_cards' }), ...languageMeta(r) },
        };
    }));

    // The views' own tools. Registered off, and switched on once the host's
    // initialize says it draws views; each also refuses a host that does not,
    // in case one calls a tool it was never listed.
    const appOnly = [];
    const sitting = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).describe('The sitting the view was handed in the tool result\'s _meta.');
    const presentationId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe('The card on screen, as review_next named it.');
    const viewTool = (name, { title, description, shape = {}, reads = false }, run) => {
        const tool = server.registerTool(name, {
            title,
            description,
            inputSchema: z.object({ sitting, ...shape }),
            annotations: reads ? READ : PROPOSE,
            _meta: { ui: { visibility: ['app'] } },
        }, (args) => guarded(async () => {
            if (!drawsViews()) return failure('This tool belongs to Terramentor\'s own view, which this host does not draw.');
            return run(appFor(), args);
        }));
        tool.disable();
        appOnly.push(tool);
    };
    const forView = (text, data) => reply(text, data);

    viewTool('check_questions', {
        title: 'The check\'s questions', reads: true,
        description: 'The questions of an open mastery check, as the view shows them (no keys).',
    }, async (app, { sitting: token }) => forView('The check\'s questions, for the view.', await app.post('/api/agent/check/questions', { token })));

    viewTool('check_submit', {
        title: 'Submit the check',
        description: 'Grade and record the whole check. One answer per question, in order; null for none.',
        shape: { answers: z.array(z.union([z.string().max(20000), z.null()])).max(100) },
    }, async (app, { sitting: token, answers }) => {
        const r = await app.post('/api/agent/check/submit', { token, answers }, { timeoutMs: 180_000 });
        return forView('The check is graded and recorded.', r);
    });

    viewTool('check_complete', {
        title: 'Mark the proven topic completed',
        description: 'After a passed check, mark its topic completed through the app\'s own completion gate.',
    }, async (app, { sitting: token }) => {
        const { nodeId } = await app.post('/api/agent/check/completion', { token });
        // The app's own completion, without override: its gate reads the evidence the check wrote.
        await app.put(`/api/nodes/${encodeURIComponent(nodeId)}`, { status: 'completed' });
        return forView('The topic is marked completed.', await app.post('/api/agent/check/completed', { token }));
    });

    viewTool('review_next', {
        title: 'The card on screen', reads: true,
        description: 'The card to show (its front only), or the end of the session.',
        shape: { anyway: z.boolean().optional().describe('Serve a card still being learned before its time.') },
    }, async (app, { sitting: token, anyway }) => forView('The next card, for the view.', await app.post('/api/agent/review/next', { token, anyway: anyway === true })));

    viewTool('review_reveal', {
        title: 'Reveal the answer',
        description: 'The answer side of the card on screen, and what each rating would schedule.',
        shape: { presentationId },
    }, async (app, { sitting: token, presentationId: id }) => forView('The answer side, for the view.', await app.post('/api/agent/review/reveal', { token, presentationId: id })));

    viewTool('review_rate', {
        title: 'Rate the card',
        description: 'Rate the card on screen once its answer is shown; the app schedules it.',
        shape: { presentationId, rating: z.enum(['again', 'hard', 'good', 'easy']) },
    }, async (app, { sitting: token, presentationId: id, rating }) => forView('The rating is saved.', await app.post('/api/agent/review/rate', { token, presentationId: id, rating })));

    viewTool('review_undo', {
        title: 'Take back the last rating',
        description: 'Restore the last rated card as it was and show it again. Name the rating (the session\'s undoable): '
            + 'the same name again gets the same answer and takes back nothing more.',
        shape: { presentationId },
    }, async (app, { sitting: token, presentationId: id }) => forView('The last rating is taken back.', await app.post('/api/agent/review/undo', { token, presentationId: id })));

    const prior = server.server.oninitialized;
    server.server.oninitialized = () => {
        prior?.();
        if (drawsViews()) for (const tool of appOnly) tool.enable();
    };
}
