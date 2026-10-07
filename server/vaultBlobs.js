// server/vaultBlobs.js — when a stored original may be deleted.
//
// The vault's blob store is content-addressed (vaultStorage.js): the same bytes
// uploaded twice are ONE file, held by every row that names its hash. Three
// tables name one — a library document, a file waiting in the New project
// dialog, a file attached to the assistant chat — and a blob is deleted only
// when none of them still does. Every place that drops such a row frees through
// here, so a fourth holder is one line in `HOLDERS`, not a fourth copy of the
// check that each of the others then forgets.
import db from './database.js';
import vaultStorage from './vaultStorage.js';

const HOLDERS = ['documents', 'staged_documents', 'chat_attachments'];

let held = null;
function heldStmts() {
    if (!held) held = HOLDERS.map(t => db.prepare(`SELECT 1 FROM ${t} WHERE file_hash = ? LIMIT 1`));
    return held;
}

/** Does any row still name these bytes? */
export function blobHeld(hash) {
    return heldStmts().some(s => s.get(hash));
}

/** Delete each blob no row names any more. Callers delete their rows FIRST. */
export function freeVaultBlobs(hashes) {
    for (const hash of new Set((hashes || []).filter(Boolean))) {
        if (!blobHeld(hash)) vaultStorage.remove(hash);
    }
}
