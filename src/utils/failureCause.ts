import type { AITaskFailure } from '../types';
import { k } from '../i18n';

/** What a failure record must carry for a cause to be named: the message, and
 *  whichever of the record's facts the thrower knew. */
export type FailureFacts = Pick<AITaskFailure, 'message'> & Partial<AITaskFailure>;

/** The likeliest cause, in words, for the handful of failures that are
 *  recognisable from the record alone. Returns a messageKey plus params — the
 *  SAME shape the server's creation frames use, and callers render it
 *  through t(), so the diagnosis arrives in the reader's language like every
 *  other sentence. Returns null rather than speculating — an
 *  unrecognised failure gets the raw message and no invented explanation.
 *  Plain ifs, not ternaries: each arm is now an object, and an object literal
 *  inside a ternary is the shape i18n-source-gates' colon rule reads as an
 *  untranslated false branch.
 *
 *  Read by the failure dialog of a background task (TaskFailureModal) and by
 *  the screen of a course creation that stopped (CreationProgress). */
export function plainCause(f: FailureFacts): { messageKey: string; params?: Record<string, unknown> } | null {
    const msg = (f.message || '').toLowerCase();
    if (f.looped) {
        return { messageKey: k('The model went round in circles in its reasoning — the same few lines over and over — and was stopped. Local models do this most on long lists of instructions; a shorter question, or a different model in Settings → AI & Models, usually avoids it.') };
    }
    if (f.emptyReply) {
        // The message already carries the numbers (emptyReplyReason in
        // server/ai.js); this says what kind of failure they add up to, which
        // is the part that reads as an app fault when it is not one.
        if (f.reasoningTokens || f.produced?.thinkingChars) {
            return { messageKey: k('The endpoint answered, but the answer was empty: the model spent the reply thinking and never wrote any of it down. Reasoning-first models do this when their budget runs out mid-thought — ask for less thinking, or pick a model that answers directly.') };
        }
        return { messageKey: k('The endpoint answered with an empty reply. Nothing was generated, and nothing about the request explains why — if it repeats, the model or the endpoint is the thing to change.') };
    }
    if (f.httpStatus === 401 || f.httpStatus === 403) {
        return { messageKey: k('The endpoint rejected the API key. Check the key in Settings → AI & Models.') };
    }
    if (f.httpStatus === 402) {
        return { messageKey: k('The provider refused the request for billing reasons — the account is out of credit or the model is not on your plan.') };
    }
    if (f.httpStatus === 404) {
        if (f.model) {
            return { messageKey: k('The endpoint does not know the model "{{model}}". It may have been renamed, unloaded, or never installed.'), params: { model: f.model } };
        }
        return { messageKey: k('The endpoint does not know the model. It may have been renamed, unloaded, or never installed.') };
    }
    if (f.httpStatus === 429) {
        // The server already backs off and retries a 429 (see aiFetchWithRetry
        // in server/ai.js), so saying "retrying usually works" after several
        // attempts is advice that has already been taken and failed.
        if ((f.attempts ?? 1) > 1) {
            return { messageKey: k('The provider rate-limited the request and was still refusing after {{attempts}} attempts — the quota is spent rather than momentarily busy. Wait for the window to reset, or switch model in Settings → AI & Models.'), params: { attempts: f.attempts } };
        }
        return { messageKey: k('The provider rate-limited the request. Waiting and retrying usually works.') };
    }
    if (f.httpStatus != null && f.httpStatus >= 500) {
        return { messageKey: k('The endpoint itself errored. With a local server this usually means the model failed to load — often not enough free VRAM.') };
    }
    if (/econnrefused|failed to fetch|fetch failed|networkerror/i.test(msg)) {
        return { messageKey: k('Nothing answered at the endpoint. The model server is probably not running.') };
    }
    if (/abort|timeout|timed out|did not answer in time/i.test(msg)) {
        // A timeout reads as a dead endpoint, and the commonest one here is the
        // opposite: a model that talked the whole time without answering. The
        // record distinguishes them, so let it.
        if ((f.produced?.thinkingChars ?? 0) > 0 && !f.produced?.contentChars) {
            return { messageKey: k('The request ran out of time, and everything the model sent before it did was reasoning — it never began the answer. Ask for less thinking in Settings → AI & Models, or pick a model that answers directly.') };
        }
        return { messageKey: k('The request took too long and was given up on.') };
    }
    if (/no model selected/i.test(msg)) {
        return { messageKey: k('No model is configured. Pick one in Settings → AI & Models.') };
    }
    if (/json|parse|unexpected token/i.test(msg)) {
        return { messageKey: k('The model replied, but not in the shape this step needs. Smaller models do this more often; the raw reply is below.') };
    }
    return null;
}
