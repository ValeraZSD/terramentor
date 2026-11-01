/**
 * Opens a library the way the server does and reports the permission bits of
 * everything that opening wrote: the data directory, the database and its WAL
 * and shared-memory files, the snapshot taken before an upgrade, the vault and
 * its two blob stores, and one file put into each store.
 *
 * A separate process because `database.js` opens the library at import, so
 * each case needs its own environment (DB_PATH / VAULT_ROOT / DATA_DIR are set
 * by the caller in this child's env). The child does NOT set a umask: the
 * modes asserted here must come from the code that creates the files, so a
 * tool or a gate that opens a library without going through server/index.js
 * is covered too.
 *
 * Prints one JSON line: `{ modes: { name: "600" | null }, warnings: [...] }`.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const warnings = [];
const warn = console.warn;
console.warn = (...args) => { warnings.push(args.join(' ')); warn(...args); };

const { default: db, DB_PATH } = await import('../../server/database.js');
const { default: vault, mediaStorage } = await import('../../server/vaultStorage.js');
const { dataPaths } = await import('../../server/paths.js');

// A write, so the WAL and shared-memory files exist while the database is open.
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('data_file_modes_probe', '1')").run();
const blob = vault.put(Buffer.from('a vault original'));
const media = mediaStorage.put(Buffer.from('a card picture'));

const mode = (p) => { try { return (statSync(p).mode & 0o777).toString(8); } catch { return null; } };
const dir = dirname(DB_PATH);
const vaultRoot = dataPaths().vaultRoot;
const backups = readdirSync(dir).filter(f => f.includes('.pre-') && f.endsWith('.bak'));
const modes = {
    dataDir: mode(dir),
    db: mode(DB_PATH),
    wal: mode(`${DB_PATH}-wal`),
    shm: mode(`${DB_PATH}-shm`),
    vault: mode(vaultRoot),
    blobs: mode(join(vaultRoot, 'blobs')),
    media: mode(join(vaultRoot, 'media')),
    blobFile: mode(vault.pathFor(blob.hash)),
    mediaFile: mode(mediaStorage.pathFor(media.hash)),
    backup: backups.length ? mode(join(dir, backups[0])) : null,
};
console.log(JSON.stringify({ modes, backups, warnings }));
db.close();
