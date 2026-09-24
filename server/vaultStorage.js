// Content-addressed blob store for the project Vault.
//
// Originals dropped into a project's vault are stored on disk keyed by the
// SHA-256 of their bytes — exactly how Git and production object stores work.
// This buys us three things that matter for the road to a live, versioned
// marketplace:
//   1. Dedup    — the same BINAS PDF uploaded by many users is stored once.
//   2. Integrity — the key IS the checksum; a corrupted blob is detectable.
//   3. Versioning — blobs are immutable; a "publish" is just a list of hashes.
//
// Everything goes through the LocalDiskDriver below. To move to S3/R2/GCS in
// production you implement the same put/get/exists/remove surface against the
// object store and swap the exported instance — the DB schema (which stores
// only the hash) and every caller stay unchanged.

import { createHash } from 'node:crypto';
import { dataPaths } from './paths.js';
import path from 'node:path';
import fs from 'node:fs';


// A SHA-256 hex digest — used to validate any hash before it touches the
// filesystem so a caller can never craft a key that escapes the blob root.
const HASH_RE = /^[a-f0-9]{64}$/;

export function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

class LocalDiskDriver {
    constructor(root) {
        this.root = root;
        fs.mkdirSync(this.root, { recursive: true });
    }

    // Sharded layout (blobs/ab/abcd…) keeps any single directory small even
    // with tens of thousands of files.
    _pathFor(hash) {
        if (!HASH_RE.test(hash)) throw new Error(`Invalid blob hash: ${hash}`);
        return path.join(this.root, hash.slice(0, 2), hash);
    }

    exists(hash) {
        try {
            return fs.existsSync(this._pathFor(hash));
        } catch {
            return false;
        }
    }

    // Write the buffer if we don't already have it. Idempotent: re-uploading
    // identical bytes is a no-op that returns the same hash.
    put(buffer) {
        const hash = sha256(buffer);
        const dest = this._pathFor(hash);
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            // Write to a temp file then rename so a crash mid-write can never
            // leave a half-written blob under its final (truth-bearing) name.
            const tmp = `${dest}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, buffer);
            fs.renameSync(tmp, dest);
        }
        return { hash, size: buffer.length };
    }

    // Absolute path for streaming (e.g. res.sendFile / fs.createReadStream).
    pathFor(hash) {
        const p = this._pathFor(hash);
        if (!fs.existsSync(p)) throw new Error(`Blob not found: ${hash}`);
        return p;
    }

    readBuffer(hash) {
        return fs.readFileSync(this.pathFor(hash));
    }

    // Delete a blob. Callers must first confirm no other document row still
    // references this hash (ref-counting lives in the DB layer, not here).
    remove(hash) {
        try {
            const p = this._pathFor(hash);
            if (fs.existsSync(p)) fs.unlinkSync(p);
            return true;
        } catch {
            return false;
        }
    }

    // Every hash the store physically holds. Only a garbage collector needs
    // this — it is the "what is on disk" half of the set difference against
    // "what the database still references".
    listHashes() {
        const out = [];
        let shards = [];
        try { shards = fs.readdirSync(this.root); } catch { return out; }
        for (const shard of shards) {
            if (!/^[a-f0-9]{2}$/.test(shard)) continue;
            let names = [];
            try { names = fs.readdirSync(path.join(this.root, shard)); } catch { continue; }
            for (const name of names) if (HASH_RE.test(name)) out.push(name);
        }
        return out;
    }
}

// Where the blob roots live. `VAULT_ROOT` exists because the Docker image keeps
// the ONLY durable state on the /data volume: without this, originals and Anki
// media were written into the container's own filesystem and vanished on the
// next `docker compose up --build`, while the database that references them
// survived — the worst of the two failure modes, because the library still
// claims to hold files it can no longer serve. Unset (the native default) keeps
// the historical path, so an existing install finds its blobs where it left them.
// Resolved with the database's own location, so the two halves of the
// library can never end up in different places (server/paths.js).
const ROOT = dataPaths().vaultRoot;

export { LocalDiskDriver };

const vaultStorage = new LocalDiskDriver(path.join(ROOT, 'blobs'));

/**
 * A SECOND store, for media that belongs to a card rather than to the vault.
 *
 * Separate root, deliberately, and the reason is garbage collection: an
 * unreferenced blob can only be swept if "referenced" has one meaning, and the
 * two stores answer to different tables (`documents.file_hash` vs
 * `media_files.hash`). Sharing a root would make every sweep have to know about
 * every consumer, and the first consumer added without updating the sweep would
 * quietly delete somebody's files.
 */
export const mediaStorage = new LocalDiskDriver(path.join(ROOT, 'media'));

export default vaultStorage;
