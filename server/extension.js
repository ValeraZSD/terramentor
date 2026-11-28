// One optional module of server hooks, for a deployment that needs them.
//
// TERRAMENTOR_EXTENSION names a JavaScript module file when the server starts.
// server/index.js loads it once, before the app is built and before anything
// listens; nothing reads the variable again, and no setting, library or request
// can name a module. Whoever sets this process's environment already decides
// which code it runs, so the variable opens no new way in. With none named,
// every hook below is absent and the server runs as it always has.
//
// The module's default export is an object. Every member is optional:
//
//   startProblem()            why the server must not start, or null. Asked
//                             before it listens, so a refused server was never
//                             reachable.
//   listenPath                a socket (a named pipe on Windows) to listen on
//                             instead of HOST:PORT, in plain HTTP.
//   stopOnSignals             true: SIGINT and SIGTERM close the server and the
//                             database, as under the desktop launcher.
//   quietStart                true: the start-up work that asks a model, and
//                             the update poll, are not started.
//   trustProxy                Express's `trust proxy` value (default 'loopback');
//                             a value Express refuses stops the start.
//   requestGuard              Express middleware, first on every /api request.
//   authenticate(req)         asked once per request. null (or undefined)
//                             leaves the request to the password gate;
//                             `{ signedIn, fields }` decides it here: signed in,
//                             or refused with `fields` added to the 401 and to
//                             GET /api/auth/status. Either way the answer is
//                             final: a refused request is not let in by a
//                             session, the API key or a connected device, on
//                             the auth routes too. Synchronous; any other
//                             answer (false, a promise) is an error, so the
//                             request fails rather than passing the hook by.
//   setupCode()               the code that sets the first password from
//                             another device, when the deployment hands one
//                             over itself ('' for none). It is never printed,
//                             and asked each time: one withdrawn stops working
//                             and the server's own code takes its place.
//   settingRefusal(spec, key) a keyed refusal (clientError.js `k`) for a write
//                             through PUT /api/settings/:key, or null.
//   serverControls            false: the update and desktop controls are not
//                             offered (GET /api/updates `controls`).
//   modelChain(chain, job)    the connections a model call tries, in order
//                             (aiJobs.js chainFor), returned as an array,
//                             synchronously. It may change them or throw;
//                             an error with `unavailable: true` makes a
//                             capability probe answer "no model" instead. A
//                             list of its own is used as a copy that keeps the
//                             chain's route stamp, so it may be frozen.
//   modelFetch(fetch, settings)  the fetch every OpenAI-shaped model request
//                             goes through (aiWire.js wireFetch), wrapped.
//
// A name that is not on this list, or a member of the wrong type, stops the
// server from starting: a misspelt or mistyped hook would otherwise be a hook
// that silently never runs. The path must be absolute, so it does not depend
// on the folder the server was started from.
//
// What a module takes on: `authenticate` returning `{ signedIn: true }` stands
// for the password everywhere the password counts (the settings only the owner
// may change, connected devices, the API key, the update controls).
// `trustProxy` decides which client address and scheme a relayed request has
// (req.ip, req.secure): the sign-in throttle, the tailnet check behind
// Tailscale sign-in, the cookie's Secure flag and the address offered to a
// phone read them. A request carrying a forwarded header never counts as this
// machine (auth.js isLocalRequest), whatever the value. A page the deployment serves on
// the app's origin, outside the app, answers with the `X-Not-App-Shell` header
// so the service worker does not keep it as the app's shell.
import path from 'node:path';
import express from 'express';
import { pathToFileURL } from 'node:url';

/** Every hook and the type its value must have. */
const HOOK_TYPES = Object.freeze({
    startProblem: 'function', listenPath: 'string', stopOnSignals: 'boolean', quietStart: 'boolean',
    trustProxy: 'trust', requestGuard: 'function', authenticate: 'function', setupCode: 'function',
    settingRefusal: 'function', serverControls: 'boolean', modelChain: 'function', modelFetch: 'function',
});
export const EXTENSION_HOOKS = Object.freeze(Object.keys(HOOK_TYPES));

/** Whether `value` fits `type`; 'trust' is any value Express takes for `trust proxy`. */
function fits(type, value) {
    if (type === 'trust') {
        return ['boolean', 'number', 'string', 'function'].includes(typeof value)
            || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
    }
    return typeof value === type;
}

let loaded = Object.freeze({});

/** The loaded module's hooks; an empty object when none was named. */
export function extension() {
    return loaded;
}

/**
 * Load the module TERRAMENTOR_EXTENSION names. server/index.js calls this once
 * at start; a gate may call it with a file of its own. Throws when the module
 * cannot be loaded or names a hook this file does not know.
 */
export async function loadExtension(file = process.env.TERRAMENTOR_EXTENSION) {
    const name = String(file ?? '').trim();
    if (!name) return loaded;
    if (!path.isAbsolute(name)) throw new Error(`TERRAMENTOR_EXTENSION: ${name} is not an absolute path`);
    const mod = await import(pathToFileURL(name).href);
    const hooks = mod.default;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
        throw new Error(`TERRAMENTOR_EXTENSION: ${name} has no default export object`);
    }
    const unknown = Object.keys(hooks).filter((key) => !EXTENSION_HOOKS.includes(key));
    if (unknown.length) throw new Error(`TERRAMENTOR_EXTENSION: ${name} names hooks this server does not have: ${unknown.join(', ')}`);
    const mistyped = Object.entries(hooks).filter(([key, value]) => !fits(HOOK_TYPES[key], value)).map(([key]) => key);
    if (mistyped.length) throw new Error(`TERRAMENTOR_EXTENSION: ${name} has hooks of the wrong type: ${mistyped.join(', ')}`);
    if ('trustProxy' in hooks) {
        try {
            express().set('trust proxy', hooks.trustProxy);
        } catch (e) {
            throw new Error(`TERRAMENTOR_EXTENSION: ${name} has a trustProxy value Express refuses: ${e.message}`);
        }
    }
    loaded = Object.freeze({ ...hooks });
    return loaded;
}
