// What a failure WAS, in words that may go anywhere a sentence may not, such as
// the activity log (server/activityLog.js). No import here touches the
// database, so a process without a library can use it too.

/** A network failure's own code (`ECONNREFUSED`, `UND_ERR_SOCKET`): a closed
 *  vocabulary by shape, so it may travel where a sentence may not. */
const NETWORK_CODE = /^(?:E[A-Z]{2,20}|UND_ERR_[A-Z_]{2,30})$/;
const FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_calls']);

/**
 * What a failure WAS, from its structured fields only — never its message.
 *
 * An error's message is free text, and a provider's is whatever it chose to
 * send back: OpenRouter and llama.cpp both echo the request into a 400, so the
 * message of a failed call can hold the learner's prompt, a line of their
 * document, or the key the request carried. So a failed event says which kind
 * of failure (`timeout`, `aborted`, `looped`, `emptyReply`, `http`, a network
 * code, else `error`), the HTTP status, how many attempts and the finish
 * reason — every one a number or a word from a fixed list. Takes a thrown
 * error or the task's failure record (tasks.js `describeFailure`), which carry
 * the same field names.
 */
export function failureFacts(err) {
    const e = err && typeof err === 'object' ? err : {};
    const status = Number(e.httpStatus);
    const http = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    const net = [e.code, e.cause?.code].find(c => typeof c === 'string' && NETWORK_CODE.test(c)) || null;
    let kind = 'error';
    if (e.emptyReply === true) kind = 'emptyReply';
    else if (e.looped === true) kind = 'looped';
    else if (e.name === 'TimeoutError') kind = 'timeout';
    else if (e.name === 'AbortError') kind = 'aborted';
    else if (http) kind = 'http';
    else if (net) kind = net;
    // A refusal is just its status ("http 400"); any other kind keeps its word.
    const bits = kind === 'http' ? [] : [kind];
    if (http) bits.push(`http ${http}`);
    if (net && net !== kind) bits.push(net);
    const attempts = Number(e.attempts);
    if (Number.isInteger(attempts) && attempts > 0 && attempts < 100) bits.push(`${attempts} attempt${attempts === 1 ? '' : 's'}`);
    if (FINISH_REASONS.has(e.finishReason)) bits.push(`finish ${e.finishReason}`);
    return bits.join(' · ');
}
