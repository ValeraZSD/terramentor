// One outline call of a course creation, given a second and a third chance when
// the model does not answer in time.
//
// A creation is a few dozen `structure` calls in a row, and one that timed out
// ended the whole run: the phases and topics already written were marked
// unfinished and the learner was shown "Request timeout after 120s". Measured
// on 8 Oct 2026 (GLM-5.3-Flash on OpenRouter, four creations of one course):
// two runs died on a single call past 120 s and a third lost three batched
// topic expansions to it, falling back to one call per topic for 25 minutes,
// while a direct call to the same model answered 3,034 tokens in 27 s. That is
// a slow TAIL, not a dead model, and the cure for a tail is asking again.
//
// So a timeout, and only a timeout, is retried, each time with a longer
// allowance: a call that was merely slow gets the room it needed, and a stalled
// one is cut and re-sent. A cancel is the learner's answer and is never
// retried; every other failure (a refusal, an empty reply, a dropped
// connection) already has its own handling in ai.js and passes through.
// When every allowance is spent the error says so, with the attempts on it, so
// the failure record reads "3 attempts" rather than one timeout.
import { generateResponse, getAISettings, tagAIError } from './ai.js';

// The first is the `structure` default in ai.js. Exported as a mutable array
// so a gate can shrink the allowances instead of waiting minutes per stall.
export const STRUCTURE_ALLOWANCES_MS = [120_000, 180_000, 240_000];

const isTimeout = (err) => err?.name === 'TimeoutError';
const secs = (ms) => `${Math.round(ms / 1000)}s`;

export async function structureCall(promptPair, { signal, temperature = 0.2, top_p = 0.8, label = 'structure call' } = {}) {
    const allowances = STRUCTURE_ALLOWANCES_MS.slice();
    for (let attempt = 0; ; attempt++) {
        try {
            return await generateResponse(promptPair.user, promptPair.system, [], {
                signal, temperature, top_p, operation: 'structure', timeout: allowances[attempt],
            });
        } catch (err) {
            // A cancel arrives as an AbortError, and one landing between two
            // attempts is refused by generateResponse before anything is sent.
            if (!isTimeout(err)) throw err;
            if (attempt + 1 < allowances.length) {
                console.log(`[AI] ${label} timed out after ${secs(allowances[attempt])}; `
                    + `asking again with ${secs(allowances[attempt + 1])} (${attempt + 2}/${allowances.length})`);
                continue;
            }
            const { provider, model } = (() => { try { return getAISettings(); } catch { return {}; } })();
            const spent = Object.assign(
                new Error(`The model did not answer in time, ${allowances.length} times in a row `
                    + `(${allowances.map(secs).join(', ')})`),
                { name: 'TimeoutError' },
            );
            throw tagAIError(spent, { attempts: allowances.length, provider, model });
        }
    }
}
