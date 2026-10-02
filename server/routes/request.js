// Small request helpers every route file uses.

// Express 4 does not forward a rejected promise to the error middleware, and the
// process-level `unhandledRejection` handler in server/index.js only logs — so a throw inside
// an async handler left the request hanging until the client gave up. `wrap`
// routes the rejection to next(), i.e. to the JSON 500 at the end of server/app.js.
// Applied to the async handlers that are not already wholly inside their own
// try/catch; a handler that catches everything itself needs nothing.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// score/total are validated for real inside updateMasteryFromAttempt, which
// every attempt route funnels through; this only decides whether the request is
// well-formed enough to get there, so a malformed body is a 400 rather than the
// 500 a thrown validation error would produce.
function readAttempt(body) {
    const score = body?.score;
    const total = body?.total;
    if (!Number.isInteger(score) || !Number.isInteger(total)) return null;
    if (total < 1 || score < 0 || score > total) return null;
    return { score, total };
}

export { readAttempt, wrap };
