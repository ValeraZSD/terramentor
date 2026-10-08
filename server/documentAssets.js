// Cleanup of a vault document's stored files and vectors, shared by every route that deletes one.
import db from './database.js';
import { removeChunkVectors } from './embeddings.js';
import { freeVaultBlobs } from './vaultBlobs.js';

// Frees assets a document row leaves behind that aren't reachable through FK
// cascade: sqlite-vec's `vec_chunks` (rowid-keyed, not a real FK) and the
// content-addressed blob on disk (shared/deduped across documents, staged files
// and chat attachments, so only GC'd once nothing points at the same hash).
// Callers must capture `docs`/`chunkIds` BEFORE the delete and invoke this
// AFTER it, so the "still referenced?" check doesn't see the rows being removed.
function freeDocumentAssets(docs, chunkIds) {
    removeChunkVectors(chunkIds);
    freeVaultBlobs(docs.map(d => d.file_hash));
}

function documentChunkIds(docs) {
    if (docs.length === 0) return [];
    return db.prepare(
        `SELECT id FROM document_chunks WHERE document_id IN (${docs.map(() => '?').join(',')})`
    ).all(...docs.map(d => d.id)).map(r => r.id);
}

export { documentChunkIds, freeDocumentAssets };
