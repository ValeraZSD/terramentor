// Where the data lives — one answer, for every way the app can be run.
//
// The database and the blob store used to resolve their own locations in two
// files, each defaulting to a path INSIDE `server/`. Fine for `npm run dev` on a
// checkout, and a data-loss bug in any packaged build: under Program Files the
// directory is unwritable, and an update or uninstall that replaces the
// application folder takes the learner's whole library with it. A packaged app
// keeps its data in the per-user application-data directory the platform
// reserves for exactly that, and the code that opens the database must not
// have to know which kind of install it is.
//
// Precedence, most specific first:
//   1. DB_PATH / VAULT_ROOT — each one explicitly, independently. Docker sets
//      both; a scratch server sets both; a batch tool may set one.
//   2. DATA_DIR — one directory holding the database, the vault, the logs. This
//      is what the desktop launcher sets (to the per-user app-data folder, or to
//      a `data/` folder beside a portable install).
//   3. The historical layout: `server/terramentor.db` and `server/vault`. A
//      checkout that has been running for a year finds its library exactly
//      where it left it — this default is the compatibility contract and it is
//      never inferred away.
//
// `resolveDataPaths` is a pure function of its inputs so `tools/desktop-gates.mjs`
// can assert the precedence table on every platform without touching the disk;
// `dataPaths` is the one call the app makes, against the real environment.

import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const serverDir = dirname(fileURLToPath(import.meta.url));

/** The folder name under the platform's app-data root. Changing the product
 *  name means changing this once — and migrating existing installs, which is
 *  why it is a constant here rather than read from package.json. */
export const DATA_FOLDER_NAME = 'Terramentor';

export const DB_FILE_NAME = 'terramentor.db';

/**
 * The per-user application-data directory for this app on a platform.
 *
 *   Windows  %LOCALAPPDATA%\Terramentor            (Local, not Roaming: a
 *            multi-GB library must not be synced to a domain profile)
 *   macOS    ~/Library/Application Support/Terramentor
 *   Linux    $XDG_DATA_HOME/Terramentor, else ~/.local/share/Terramentor
 */
export function userDataDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
    if (platform === 'win32') {
        const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
        return join(local, DATA_FOLDER_NAME);
    }
    if (platform === 'darwin') {
        return join(home, 'Library', 'Application Support', DATA_FOLDER_NAME);
    }
    const base = env.XDG_DATA_HOME || join(home, '.local', 'share');
    return join(base, DATA_FOLDER_NAME);
}

/**
 * Resolve the database file and the blob-store root from an environment.
 *
 * Returns `{ dataDir, dbPath, vaultRoot, source }` where `source` names which
 * rule decided: `env` (DB_PATH and/or VAULT_ROOT), `data-dir` (DATA_DIR), or
 * `legacy` (the historical in-repo layout). `dataDir` is the directory the app
 * may put OTHER per-install files in (logs, the browser profile); under the
 * legacy layout that is `server/` itself.
 */
export function resolveDataPaths({ env = process.env, root = serverDir } = {}) {
    const dataDir = env.DATA_DIR ? resolve(env.DATA_DIR) : null;
    const dbPath = env.DB_PATH
        ? resolve(env.DB_PATH)
        : dataDir ? join(dataDir, DB_FILE_NAME) : join(root, DB_FILE_NAME);
    const vaultRoot = env.VAULT_ROOT
        ? resolve(env.VAULT_ROOT)
        : dataDir ? join(dataDir, 'vault') : join(root, 'vault');
    const source = (env.DB_PATH || env.VAULT_ROOT) ? 'env' : dataDir ? 'data-dir' : 'legacy';
    return {
        dataDir: dataDir || (env.DB_PATH ? dirname(dbPath) : root),
        dbPath,
        vaultRoot,
        source,
    };
}

let resolved = null;

/**
 * The paths this process runs against. Resolved once, and the data directory
 * is created on first use: `new Database(path)` does not create parent
 * directories, and a fresh per-user folder does not exist until something
 * makes it.
 */
export function dataPaths() {
    if (resolved) return resolved;
    resolved = resolveDataPaths();
    try {
        mkdirSync(dirname(resolved.dbPath), { recursive: true });
    } catch { /* an unwritable location fails loudly one line later, in SQLite */ }
    return resolved;
}
