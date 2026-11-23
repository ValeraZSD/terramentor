// Cards made from a topic's photos: the photo on the front, the topic it
// belongs to on the back, with the example's name and what to look at under
// it (server/topicPhotos.js keeps the photos and their credit). The answer is
// the topic, not the building: the skill is telling the course's topics apart,
// and a card that asked for the example's name would train one picture.
//
// A card is made ONCE per photo and is then the learner's like any other
// card: scheduled by FSRS, edited, deleted. So the pass below only ever adds a
// card for a photo that has never had one (a deleted or reported card counts
// as had). It never deletes one and never writes its words. A kept photo never
// changes its picture ("Look again" searches only the examples with none), so
// neither does its card.
//
// The FRONT's picture is marked `prompt`: it is the thing asked about, so no
// screen reader or tooltip may describe it from the file's stored description,
// which names the answer (src/components/cardImageAlt.ts). Its credit is on
// the BACK, under the same photo, where the name is no longer a secret: the
// author and the file's page often name the place.
//
// Course files leave these cards out (server/courseFiles.js): they are made
// from the photos, which travel, and the importing library makes them again,
// with the model the file names for the photo's words.

import db, { NOW_ISO } from './database.js';
import { standingRefs } from './itemReports.js';
import { derivedUuid } from './syncTables.js';

const statements = new Map();
const stmt = (sql) => {
    let s = statements.get(sql);
    if (!s) { s = db.prepare(sql); statements.set(sql, s); }
    return s;
};

/** The two sides' pictures for one photo row. */
export function photoCardMedia(photo) {
    return {
        front: [{ hash: photo.hash, kind: 'image', prompt: true }],
        back: [{
            hash: photo.hash, kind: 'image',
            credit: {
                author: photo.author ?? null,
                licence: photo.licence ?? null,
                licenceUrl: photo.licence_url ?? null,
                sourceUrl: photo.source_url ?? null,
            },
        }],
    };
}

/**
 * Make the missing cards of one course. Returns `{ added }`. Synchronous SQL
 * only, so an importer can call it inside its own transaction.
 */
export function syncPhotoCards(projectId) {
    // `card_made_at`: the photo remembers its card, so one the learner deleted,
    // even one later removed for good from Recently deleted, is never made again.
    const photos = stmt(`
        SELECT p.*, n.title AS topic_title FROM node_photos p JOIN live_nodes n ON n.id = p.node_id
        WHERE n.project_id = ? AND p.status = 'found' AND p.hash IS NOT NULL AND p.uuid IS NOT NULL
          AND p.card_made_at IS NULL
        ORDER BY n.id, p.position, p.id
    `).all(projectId);
    if (!photos.length) return { added: 0 };
    // A photo reported as wrong before it had a card gets none until the
    // report is undone (server/itemReports.js takes the card of one reported after).
    const reported = standingRefs('photo:');
    let added = 0;
    db.transaction(() => {
        for (const p of photos) {
            if (reported.has(`photo:${p.uuid}`)) continue;
            // OR IGNORE: the index allows one card per photo, so a second
            // process making the same card at the same moment adds nothing.
            // Its uuid comes from the photo's, so two copies of one library
            // that each made it name the same card (server/syncTables.js).
            added += stmt(`INSERT OR IGNORE INTO flashcards (node_id, front, back, extra, media, generated_by, photo_uuid, uuid)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(p.node_id, '', p.topic_title, [p.subject, p.shows].filter(Boolean).join('\n'),
                JSON.stringify(photoCardMedia(p)), p.generated_by ?? null, p.uuid, derivedUuid(['photo-card', p.uuid])).changes;
            stmt(`UPDATE node_photos SET card_made_at = ${NOW_ISO} WHERE id = ?`).run(p.id);
        }
    })();
    return { added };
}

/** Every course with a found photo, at startup: a library from before cards were made gets them. */
export function syncAllPhotoCards() {
    const ids = stmt(`
        SELECT DISTINCT n.project_id AS id FROM node_photos p JOIN live_nodes n ON n.id = p.node_id
        WHERE p.status = 'found' AND p.hash IS NOT NULL
    `).all().map(r => r.id);
    let added = 0;
    for (const id of ids) added += syncPhotoCards(id).added;
    return { added };
}
