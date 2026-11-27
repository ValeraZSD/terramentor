// The proof a program on this computer sends to show it runs as the library's
// owner (server/auth.js `ownerProofRequired`, server/instanceKey.js
// `ownerProof`).
//
// The desktop app's server answers a loopback request without a password only
// when the request proves it can read `instance.key` beside the library: every
// account on a computer reaches 127.0.0.1, and only the account that owns the
// library can read that file. A harness starts this MCP server on stdio as the
// person who uses it, so the server can read the key the way the app's own
// launcher does, and sign a fresh proof for each request.
//
// The key is only READ here, never made: a library with no key has never been
// opened by the desktop app, and so has no server that asks for a proof.
//
// The HTTP listener never sends a proof (mcp/index.js): it answers any process
// on this computer, so a proof added there would let every account in.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { INSTANCE_KEY_FILE, OWNER_PROOF_HEADER, ownerProof, readInstanceKeyFile } from '../server/instanceKey.js';
import { resolveDataPaths } from '../server/paths.js';

/** The app folder this copy of mcp/ sits in: a checkout, or the desktop app's folder. */
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The folder of the library the desktop app opens from this copy, by the
 * launcher's own rule (desktop/lib.js `chooseDataDir`): DATA_DIR when set, a
 * `data` folder beside the app, the per-user folder of an installed copy, or a
 * checkout's `server/`. desktop/ is not in the Docker image, whose server never
 * asks for a proof; there only DATA_DIR or the checkout's default is read.
 */
export async function libraryDirFor({ env = process.env, appRoot = APP_ROOT } = {}) {
    let chooseDataDir = null;
    try { ({ chooseDataDir } = await import('../desktop/lib.js')); } catch { /* no desktop/ in this copy */ }
    if (chooseDataDir) {
        const chosen = chooseDataDir({
            envDataDir: env.DATA_DIR,
            appRoot,
            packaged: existsSync(join(appRoot, 'build.json')),
            platform: process.platform,
            env,
        });
        if (chosen.missing) return null;
        if (chosen.dir) return chosen.dir;
    }
    return resolveDataPaths({ env }).dataDir;
}

/**
 * Headers proving ownership to the app at `origin`, or {} when there is no key
 * to sign with. The key file is read on each call, so a library the desktop
 * app first opens after this server started is picked up without a restart.
 */
export async function ownerHeaders(origin, { env = process.env, appRoot = APP_ROOT } = {}) {
    const url = new URL(origin);
    const dir = await libraryDirFor({ env, appRoot });
    const key = dir ? readInstanceKeyFile(join(dir, INSTANCE_KEY_FILE)) : null;
    if (!key) return {};
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    return { [OWNER_PROOF_HEADER]: ownerProof(key, port) };
}
