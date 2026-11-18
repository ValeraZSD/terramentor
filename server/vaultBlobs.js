// server/vaultBlobs.js — when a stored original may be deleted.
//
// The vault's blob store is content-addressed (vaultStorage.js): the same bytes
// uploaded twice are ONE file, held by every row that names its hash. Four
// tables name one — a library document, a file waiting in the New project
// dialog, a file attached to the assistant chat, the photo of a graded paper
// attempt — and a blob is deleted only when none of them still does.
// Every place that drops such a row frees through here, so a further holder is
// one line in `HOLDERS`, not another copy of the check that each of the others
// then forgets.
import db from './database.js';
import vaultStorage from './vaultStorage.js';

// [table, the column that holds the hash]
const HOLDERS = [
    ['documents', 'file_hash'],
    ['staged_documents', 'file_hash'],
    ['chat_attachments', 'file_hash'],
    // The learner's answer photo, stored in the same vault by paper.js. The same
    // bytes can also be a document or an attachment; deleting THAT row must not
    // take the picture a graded attempt still shows.
    ['paper_attempts', 'image_hash'],
];

let held = null;
function heldStmts() {
    if (!held) held = HOLDERS.map(([table, column]) => db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`));
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
