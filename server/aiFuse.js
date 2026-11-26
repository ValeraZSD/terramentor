// A fuse on what each person at a site spends on the model.
//
// A site's front desk hands one model key to every library (site/libraries.js
// passes AI_* on), so a per-key spending limit at the provider is a limit for
// the whole site: one learner's loop, or one person generating in bulk, would
// spend everyone's month. Each library therefore counts its own spend per
// calendar month (UTC) and holds itself to two lines:
//
//   1. past AI_FUSE_SWITCH_USD (5) every model call goes to AI_FUSE_SMALL_MODEL
//      (a cheaper model) instead of the one it named;
//   2. past AI_FUSE_STOP_USD (10) no model call is made until the next month.
//      What exists keeps working: reviews, cards, checks and everything already
//      written read the library, not the model. The learner reads one sentence
//      (FUSE_STOPPED).
//
// It is a fuse against loops and abuse, not a quota: the defaults sit far above
// what a learner studying every day spends. The operator is told when a library
// crosses either line (aiSpend.js `notice`), because a switch on the day a
// library was made is what a loop looks like.
//
// Only a site library has a fuse. A desktop copy, and a hosted copy of its own
// (hosted/copy.sh, one key per copy with the provider's own limit), are never
// limited by the app.
//
// This file is pure (no database): the front desk reads it to check its
// settings at start, and must not open an app database. The counting is
// aiSpend.js, in the library.
import { isHosted } from './hosted.js';
import { isSiteLibrary } from './siteLibrary.js';
import { k } from './clientError.js';

export const FUSE_DEFAULTS = Object.freeze({
    switchUsd: 5,
    stopUsd: 10,
    smallModel: 'anthropic/claude-haiku-5.5',
});

/**
 * What a call is counted at when the endpoint reports no `cost`, in USD per
 * million tokens: OpenRouter's listed price for Claude Sonnet 5.5 (USD 2 in,
 * USD 10 out, openrouter.ai/anthropic/claude-sonnet-5.5, read 26 Nov 2026).
 * OpenRouter reports the cost of every call itself, so this counts only a
 * provider that does not; with no token counts either, four characters are
 * counted as one token.
 */
export const FALLBACK_USD_PER_MTOK = Object.freeze({ input: 2, output: 10 });

/** What a learner reads once their month's model allowance is spent. */
export const FUSE_STOPPED = k('AI is paused on your account until next month; your reviews, cards and everything already made keep working.');

const CONTROL = /[\u0000-\u001f\u007f]/;

function amount(env, name, fallback) {
    const raw = String(env[name] ?? '').trim();
    if (raw === '') return { value: fallback };
    const value = Number(raw);
    if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(value)) return { problem: `${name} is "${raw}"; it must be an amount in US dollars, such as 5 or 2.50.` };
    return { value };
}

/** The fuse's settings read from `env`, and the first thing wrong with them. */
function read(env) {
    const sw = amount(env, 'AI_FUSE_SWITCH_USD', FUSE_DEFAULTS.switchUsd);
    if (sw.problem) return { problem: sw.problem };
    const stop = amount(env, 'AI_FUSE_STOP_USD', FUSE_DEFAULTS.stopUsd);
    if (stop.problem) return { problem: stop.problem };
    if (!(stop.value > 0)) return { problem: 'AI_FUSE_STOP_USD is 0; it must be more than 0 (a site with no model at all sets no AI_MODEL).' };
    if (sw.value > stop.value) return { problem: `AI_FUSE_SWITCH_USD (${sw.value}) is more than AI_FUSE_STOP_USD (${stop.value}); the switch to the smaller model comes first.` };
    const smallModel = String(env.AI_FUSE_SMALL_MODEL ?? '').trim() || FUSE_DEFAULTS.smallModel;
    if (smallModel.length > 200 || CONTROL.test(smallModel)) return { problem: 'AI_FUSE_SMALL_MODEL is not a model name.' };
    const noticeUrl = String(env.AI_FUSE_NOTICE_URL ?? '').trim();
    if (noticeUrl) {
        let u = null;
        try { u = new URL(noticeUrl); } catch { /* said below */ }
        if (!u || !/^https?:$/.test(u.protocol)) return { problem: 'AI_FUSE_NOTICE_URL is not an http(s) address.' };
    }
    return { limits: Object.freeze({ switchUsd: sw.value, stopUsd: stop.value, smallModel, noticeUrl }) };
}

/** Why the fuse's settings in `env` cannot be used, or null. The front desk refuses to start on one. */
export function fuseConfigProblem(env = process.env) {
    return read(env).problem || null;
}

/**
 * This process's fuse, or null when it has none (anything but a site library).
 * Settings the front desk would have refused throw: a library with an
 * unreadable fuse makes no model call rather than an unlimited one.
 */
export function fuseLimits(env = process.env) {
    if (!isSiteLibrary(env) || !isHosted(env)) return null;
    const { limits, problem } = read(env);
    if (problem) throw new Error(`[ai-fuse] ${problem}`);
    return limits;
}

/** The month a spend is counted in: `YYYY-MM`, UTC, like OpenRouter's own monthly reset. */
export const monthOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);

/** `main` (the model the call named), `small` (AI_FUSE_SMALL_MODEL) or `stopped`. */
export function stageOf(spentUsd, limits) {
    if (spentUsd >= limits.stopUsd) return 'stopped';
    if (spentUsd >= limits.switchUsd) return 'small';
    return 'main';
}

const finite = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);

/**
 * What one answered call cost, in USD. OpenRouter sends `usage.cost` on every
 * response ("Cost in credits", openrouter.ai/docs/use-cases/usage-accounting;
 * "OpenRouter uses a credit system where the base currency is US dollars",
 * openrouter.ai/docs/faq); `cost_details.upstream_inference_cost` is what the
 * provider behind it charged, and the larger of the two is taken. Without a
 * cost the tokens are priced at FALLBACK_USD_PER_MTOK, and without tokens the
 * characters sent and received.
 */
export function costOf(usage, { inChars = 0, outChars = 0 } = {}) {
    const reported = finite(usage?.cost);
    if (reported != null) {
        const upstream = finite(usage?.cost_details?.upstream_inference_cost) ?? 0;
        return { usd: Math.max(reported, upstream), how: 'reported' };
    }
    const input = finite(usage?.prompt_tokens);
    const output = finite(usage?.completion_tokens) ?? 0;
    if (input != null) {
        return { usd: (input * FALLBACK_USD_PER_MTOK.input + output * FALLBACK_USD_PER_MTOK.output) / 1e6, how: 'tokens' };
    }
    return { usd: ((inChars / 4) * FALLBACK_USD_PER_MTOK.input + (outChars / 4) * FALLBACK_USD_PER_MTOK.output) / 1e6, how: 'characters' };
}

const dollars = (x) => `USD ${x.toFixed(2)}`;

/**
 * The operator's line when a library crosses a line. Names the library by the
 * first eight characters of its id, as the front desk's log does, and how long
 * ago it was made; nothing the learner wrote.
 */
export function noticeText(event, { libraryId = '', spentUsd, limits, month, createdAt = '', now = Date.now() }) {
    const lib = `Library ${String(libraryId).slice(0, 8) || '(unknown)'}`;
    const made = Date.parse(createdAt);
    const days = Number.isFinite(made) ? Math.max(0, Math.floor((now - made) / 86_400_000)) : null;
    const age = days == null ? '' : days === 0 ? ' It was made today: a loop is the likely cause.' : ` It was made ${days} day${days === 1 ? '' : 's'} ago.`;
    const what = event === 'stop'
        ? `has spent ${dollars(spentUsd)} on the model in ${month}, past the ${dollars(limits.stopUsd)} stop (AI_FUSE_STOP_USD): it makes no model calls until next month.`
        : `has spent ${dollars(spentUsd)} on the model in ${month}, past ${dollars(limits.switchUsd)} (AI_FUSE_SWITCH_USD): its calls go to ${limits.smallModel} for the rest of the month.`;
    return `${lib} ${what}${age}`;
}
