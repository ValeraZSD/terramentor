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
//   trustProxy                Express's `trust proxy` value (default 'loopback').
//   requestGuard              Express middleware, first on every /api request.
//   authenticate(req)         null leaves the request to the password gate;
//                             `{ signedIn, fields }` decides it here: signed in,
//                             or refused with `fields` added to the 401 and to
//                             GET /api/auth/status.
//   setupCode()               the code that sets the first password from
//                             another device, when the deployment hands one
//                             over itself ('' for none). It is never printed.
//   settingRefusal(spec, key) a keyed refusal (clientError.js `k`) for a write
//                             through PUT /api/settings/:key, or null.
//   serverControls            false: the update and desktop controls are not
//                             offered (GET /api/updates `controls`).
//   modelChain(chain, job)    the connections a model call tries, in order
//                             (aiJobs.js chainFor). It may change them or throw;
//                             an error with `unavailable: true` makes a
//                             capability probe answer "no model" instead.
//   modelFetch(fetch, settings)  the fetch every OpenAI-shaped model request
//                             goes through (aiWire.js wireFetch), wrapped.
//
// A name that is not on this list stops the server from starting: a misspelt
// hook would otherwise be a hook that silently never runs.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXTENSION_HOOKS = Object.freeze([
    'startProblem', 'listenPath', 'stopOnSignals', 'quietStart',
    'trustProxy', 'requestGuard', 'authenticate', 'setupCode', 'settingRefusal', 'serverControls',
    'modelChain', 'modelFetch',
]);

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
    const mod = await import(pathToFileURL(path.resolve(name)).href);
    const hooks = mod.default;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
        throw new Error(`TERRAMENTOR_EXTENSION: ${name} has no default export object`);
    }
    const unknown = Object.keys(hooks).filter((key) => !EXTENSION_HOOKS.includes(key));
    if (unknown.length) throw new Error(`TERRAMENTOR_EXTENSION: ${name} names hooks this server does not have: ${unknown.join(', ')}`);
    loaded = Object.freeze({ ...hooks });
    return loaded;
}
