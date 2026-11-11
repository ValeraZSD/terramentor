// /api/agent/*: what an outside agent reads, the one thing it may record, and
// the check and review the LEARNER takes in the agent host's window — the app
// side of the MCP server (mcp/, docs/MCP.md).
//
// Behind the password check like every /api route: with a password set the MCP
// server must carry the library's API key (Settings → Security), without one
// only this computer is let in (server/auth.js). The agent's own routes READ,
// except POST /api/agent/claims, which writes a claim (server/claims.js) and
// never evidence. A capture goes through the app's own POST /api/capture. The
// /check and /review routes write evidence and card schedules, but only what
// the learner answered in the view (server/agentSittings.js).
//
// Each answer is `{ text, ... }`: `text` is what the agent's model reads, the
// rest is the same content as data, for an agent that wants it structured.
import { agentDue, agentFind, agentMastery, agentProjectState, agentTopic, noTopicText } from '../agentReads.js';
import { ClaimError, recordClaim } from '../claims.js';
import {
    SittingError, checkCompletion, checkQuestions, checkTarget, closeCheck, markCheckCompleted, reviewNext, reviewRate, reviewReveal,
    reviewTarget, reviewUndo, startCheck, startReview, submitCheck,
} from '../agentSittings.js';
import { routeTable } from './routeTable.js';
import { clientError } from '../clientError.js';

const app = routeTable('agent');

/** The agent harness as it named itself (the MCP client's name), display-only. */
export const AGENT_CLIENT_HEADER = 'X-Agent-Client';

const QUERY_CHARS = 200;

/** A query-string value as one bounded string; an array or object (`?q=a&q=b`) is nothing. */
function queryText(value) {
    return typeof value === 'string' ? value.slice(0, QUERY_CHARS) : '';
}

/** Run a read and answer it, or 500 with a reason the agent can pass on. */
function answer(res, read) {
    try {
        res.json(read());
    } catch (err) {
        console.error('[Agent] read failed:', err.message);
        res.status(500).json({ error: clientError(err) });
    }
}

app.get('/api/agent/state', (req, res) => answer(res, () => agentProjectState(queryText(req.query.project))));

app.get('/api/agent/find', (req, res) => answer(res, () => agentFind(queryText(req.query.q))));

app.get('/api/agent/due', (req, res) => answer(res, () => agentDue()));

app.get('/api/agent/topic', (req, res) => {
    const from = Number(req.query.from);
    answer(res, () => agentTopic(queryText(req.query.topic), Number.isInteger(from) && from > 0 ? from : 0));
});

app.get('/api/agent/mastery', (req, res) => answer(res, () => {
    const topic = queryText(req.query.topic);
    return agentMastery(topic) || { text: noTopicText(topic), mastery: null };
}));

app.post('/api/agent/claims', (req, res) => {
    const { nodeId, correct, questionType, attemptId } = req.body || {};
    try {
        const claim = recordClaim({
            nodeId,
            correct,
            questionType: questionType ?? null,
            attemptId: attemptId ?? null,
            client: req.get(AGENT_CLIENT_HEADER) || null,
            source: 'mcp',
        });
        res.json(claim);
    } catch (err) {
        // A ClaimError is a 4xx refusal written for the caller: clientError
        // sends it as written (a path in it replaced), never a raw message.
        if (err instanceof ClaimError) return res.status(err.status).json({ error: clientError(err, err.status) });
        console.error('[Agent] claim failed:', err.message);
        res.status(500).json({ error: clientError(err) });
    }
});

// A mastery check and a card review drawn in the host's own window, or a
// check asked as one form (server/agentSittings.js). The token names a
// sitting; it reaches the view in a tool result's `_meta` (a form round in
// its `requestState`) and comes back on every call. Keys and answers never
// leave here before the check is submitted.
function sitting(res, run) {
    Promise.resolve()
        .then(run)
        .then((out) => res.json(out))
        .catch((err) => {
            if (err instanceof SittingError) return res.status(err.status).json({ error: clientError(err, err.status) });
            console.error('[Agent] sitting failed:', err.message);
            res.status(500).json({ error: clientError(err) });
        });
}
const token = (req) => (typeof req.body?.token === 'string' ? req.body.token : '');

// For a host that draws no views: where the check is, how many cards are due. Opens nothing.
app.get('/api/agent/check/where', (req, res) => sitting(res, () => checkTarget(queryText(req.query.topic))));
app.get('/api/agent/review/where', (req, res) => sitting(res, () => reviewTarget(queryText(req.query.project))));

app.post('/api/agent/check/start', (req, res) => sitting(res, () => startCheck({ topic: req.body?.topic, form: req.body?.form === true })));
app.post('/api/agent/check/questions', (req, res) => sitting(res, () => checkQuestions(token(req))));
app.post('/api/agent/check/submit', (req, res) => sitting(res, () => submitCheck(token(req), req.body?.answers)));
app.post('/api/agent/check/close', (req, res) => sitting(res, () => closeCheck(token(req))));
app.post('/api/agent/check/completion', (req, res) => sitting(res, () => checkCompletion(token(req))));
app.post('/api/agent/check/completed', (req, res) => sitting(res, () => markCheckCompleted(token(req))));

app.post('/api/agent/review/start', (req, res) => sitting(res, () => startReview({ project: req.body?.project })));
app.post('/api/agent/review/next', (req, res) => sitting(res, () => reviewNext(token(req), { anyway: req.body?.anyway === true })));
app.post('/api/agent/review/reveal', (req, res) => sitting(res, () => reviewReveal(token(req), req.body?.presentationId)));
app.post('/api/agent/review/rate', (req, res) => sitting(res, () => reviewRate(token(req), req.body?.presentationId, req.body?.rating)));
app.post('/api/agent/review/undo', (req, res) => sitting(res, () => reviewUndo(token(req), req.body?.presentationId)));

export const routes = app.takeRoutes();
