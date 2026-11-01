// The tools an agent harness sees, each a thin call to the running app
// (mcp/app.js → server/routes/agent.js). Five READ the library; two PROPOSE:
// a capture into the Inbox, and a claim that the learner answered something.
// Nothing here can prove a topic: the mastery gate is cleared only by the
// app's own mastery check, quizzes and paper exercises (server/claims.js says
// what a claim may and may not move). tools/mcp-gates.mjs pins the list, the
// annotations and that boundary.

import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { AppError } from './app.js';

export const SERVER_NAME = 'terramentor';

const INSTRUCTIONS = [
    'Terramentor is the learner\'s own study app, running on their computer: their courses (projects of sections and topics),',
    'lessons, cards, what is due and how well each topic is known. Read it before teaching: project_state or find_in_library',
    'to see what they study and to get real ids, get_due for today, topic_material for a topic\'s lesson text, get_mastery for',
    'where a topic stands. Use only ids these tools returned; never invent one.',
    'When the learner answers a question you asked them on a topic, send record_claim. A claim is a note, not proof: it never',
    'raises a topic\'s mastery, and only Terramentor\'s own mastery check proves a topic, so send the learner there to prove it.',
    'add_capture saves something to study later into their Inbox.',
].join(' ');

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
            + 'where they can turn it into a topic. The same text saved twice is kept once. If the app has an AI model connected, it '
            + 'tidies the note in the background as it does every capture.',
        inputSchema: z.object({
            text: z.string().max(20000).optional().describe('The note itself.'),
            url: z.string().url().max(2000).optional().describe('A link to keep with it.'),
            title: z.string().max(200).optional().describe('A short title; made from the text when left out.'),
        }),
        annotations: { ...PROPOSE, idempotentHint: true },
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
            + 'pass the mastery gate (only the app\'s own mastery check does); a wrong one may lower the estimate so the app reviews '
            + 'the topic sooner. Send one claim per answer.',
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
        const effect = r.lowered
            ? `The estimate went from ${pct(r.masteryBefore)} to ${pct(r.masteryAfter)}, so Terramentor will bring the topic back sooner.`
            : 'The estimate is unchanged: a claim never raises it.';
        const prefix = r.duplicate ? 'This claim was already recorded (same attempt_id); nothing new was written. ' : '';
        return reply(`${prefix}Recorded a ${correct ? 'right' : 'wrong'} answer on "${r.title}" (nodeId ${r.nodeId}) as a claim. ${effect} `
            + 'A claim is not evidence the app measured: to prove the topic, the learner takes its mastery check in Terramentor.', r);
    }));

    return server;
}
