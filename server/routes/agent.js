// /api/agent/*: what an outside agent reads, and the one thing it may record —
// the app side of the MCP server (mcp/, docs/MCP.md).
//
// Behind the password check like every /api route: with a password set the MCP
// server must carry the library's API key (Settings → Security), without one
// only this computer is let in (server/auth.js). Every route here READS except
// POST /api/agent/claims, which writes a claim (server/claims.js) and never
// evidence. A capture goes through the app's own POST /api/capture.
//
// Each answer is `{ text, ... }`: `text` is what the agent's model reads, the
// rest is the same content as data, for an agent that wants it structured.
import { agentDue, agentFind, agentMastery, agentProjectState, agentTopic, noTopicText } from '../agentReads.js';
import { ClaimError, recordClaim } from '../claims.js';
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
        if (err instanceof ClaimError) return res.status(err.status).json({ error: err.message });
        console.error('[Agent] claim failed:', err.message);
        res.status(500).json({ error: clientError(err) });
    }
});

export const routes = app.takeRoutes();
