import db from './database.js';
import { generateResponse, getAISettings, fetchPageContent, AI_PROMPTS, transcribeImageToText, visionAvailability, aiProvenance } from './ai.js';
import { parseJsonWithRepair } from './agentic.js';
import { normalizeFeedQuestion } from './feed.js';
import { bankTitle } from './studyMaterial.js';
import vaultStorage from './vaultStorage.js';
import { scheduleNodeSync } from './nodeEmbeddings.js';

/**
 * Ad-hoc capture — "I read something and I want to keep it."
 *
 * Deliberately NOT a new subsystem. Everything downstream of this app (the
 * feed, BKT mastery, SM-2 flashcards, checkpoints, the vault) already keys on
 * `node_id` + `project_id`, so a capture is just a node in one permanent,
 * unscheduled project called Inbox. That buys the entire study loop for free:
 * the moment a capture lands it can be taught, questioned and reviewed exactly
 * like a curriculum topic, with zero scheduling interaction (the Inbox has no
 * start_date/deadline, so it never enters pace or recalibration maths).
 *
 * Shape of a captured node, matching the three-tier content model:
 *   - `title`            — the AI's short name for it (or the learner's)
 *   - `description`      — the AI-written Overview: what this is, why it matters
 *   - one `is_note` child — the raw captured text, verbatim, as Material
 * The raw text is written FIRST and never overwritten, so a failed or absent AI
 * costs polish, never the thing the learner wanted to keep.
 */

const INBOX_SETTING = 'inbox_project_id';
const INBOX_NAME = 'Inbox';

const nextProjectPositionStmt = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 as pos FROM projects');

function getSetting(key) {
    try {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row?.value ?? null;
    } catch {
        return null;
    }
}

/**
 * The Inbox project, created on first capture and re-created if the learner
 * deletes it. Never scheduled: `getFocusNodes` gives it a standing slot in the
 * feed instead (see server/feed.js), so a capture surfaces the same day without
 * a fake deadline that would turn "unread" into "overdue" by tomorrow.
 */
export function getOrCreateInboxProject() {
    const stored = Number(getSetting(INBOX_SETTING));
    if (stored) {
        const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(stored);
        if (existing) return existing.id;
    }

    // A project literally named Inbox counts — covers an upgrade from a version
    // before the setting existed, and a learner who renamed nothing.
    const byName = db.prepare('SELECT id FROM projects WHERE name = ? ORDER BY id LIMIT 1').get(INBOX_NAME);
    if (byName) {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(INBOX_SETTING, String(byName.id));
        return byName.id;
    }

    const result = db.prepare(
        'INSERT INTO projects (name, description, summary, color, icon, position) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
        INBOX_NAME,
        'Things you captured on the fly — articles, notes, links. They flow into your feed and reviews like any other topic.',
        'Ad-hoc captures: anything you read and wanted to keep.',
        '#0EA5E9',
        'inbox',
        nextProjectPositionStmt.get().pos
    );
    const id = Number(result.lastInsertRowid);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(INBOX_SETTING, String(id));
    return id;
}

/** A readable placeholder title from whatever the learner actually gave us. */
function provisionalTitle({ title, text, url }) {
    const given = (title || '').trim();
    if (given) return given.slice(0, 200);

    // First line of the pasted text, cut at a word boundary. With no AI this IS
    // the title the learner lives with, so a hard 120-char chop mid-word (which
    // is what a pasted paragraph produces) is not good enough.
    const firstLine = (text || '').trim().split('\n').map(l => l.trim()).find(Boolean);
    if (firstLine) {
        const clean = firstLine.replace(/^#+\s*/, '');
        if (clean.length <= 80) return clean;
        const cut = clean.slice(0, 80);
        const lastSpace = cut.lastIndexOf(' ');
        return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '')}…`;
    }

    if (url) {
        try { return `Capture from ${new URL(url).hostname.replace(/^www\./, '')}`; } catch { /* not a URL */ }
    }
    return 'Captured note';
}

/**
 * Create the capture node immediately, before any AI runs.
 *
 * The order matters: the learner pressed Save because they did not want to lose
 * something. So it is in the database, verbatim, one synchronous statement
 * later — enrichment is a separate, cancellable, failable background step.
 */
/**
 * An Inbox capture whose text is exactly this, or null. The assistant's
 * prepared note asks before saving: its Save button is drawn again whenever the
 * conversation is re-read, and a second press must not file the note twice.
 * The header's Capture does not ask — a learner capturing the same words twice
 * on purpose is theirs to decide.
 */
export function findCapturedText(text) {
    const body = String(text || '').trim();
    if (!body) return null;
    const row = db.prepare(`
        SELECT n.id AS nodeId, n.project_id AS projectId
        FROM nodes m JOIN nodes n ON n.id = m.parent_id
        WHERE m.is_note = 1 AND m.title = 'Captured text' AND m.description = ? AND n.project_id = ?
        ORDER BY n.id DESC LIMIT 1
    `).get(body.slice(0, 100000), getOrCreateInboxProject());
    return row || null;
}

export function createCapture({ text = '', url = '', title = '' }) {
    const projectId = getOrCreateInboxProject();
    const body = String(text || '').trim();
    const link = String(url || '').trim();
    const givenTitle = String(title || '').trim();
    // A file-only capture (document/photo, attached right after this call
    // returns) has neither pasted text nor a URL — the client sends a title
    // instead (its own or the first filename) so this still has something to
    // anchor the node on.
    if (!body && !link && !givenTitle) throw new Error('A capture needs some text, a URL, or a title');

    const maxPos = db.prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 as pos FROM nodes WHERE project_id = ? AND parent_id IS NULL'
    ).get(projectId);

    const nodeId = Number(db.prepare(`
        INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position)
        VALUES (?, NULL, ?, '', '', 'not_started', 0, ?)
    `).run(projectId, provisionalTitle({ title, text: body, url: link }), maxPos.pos).lastInsertRowid);

    // The raw text as Material (an is_note child), which is exactly what the
    // feed teaches from when there is no generated lesson yet — so the capture
    // is readable in the feed even with the AI switched off entirely.
    if (body) {
        db.prepare(`
            INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position)
            VALUES (?, ?, 'Captured text', ?, '', 'not_started', 1, 0)
        `).run(projectId, nodeId, body.slice(0, 100000));
    }

    if (link) {
        db.prepare(`
            INSERT INTO resources (node_id, title, url, type, completed, position)
            VALUES (?, ?, ?, 'link', 0, 0)
        `).run(nodeId, 'Source', link);
    }

    return { nodeId, projectId };
}

// A photo dropped onto Capture (the "who are all these people" case) has no
// text at all — a vision model has to say what it shows before anything can
// be taught. Same fabrication discipline as paper.js/pdfRecovery.js: an
// unconfident name or fact is worse than none, so the prompt says so
// explicitly rather than trusting the model's default confidence.
const CAPTURE_VISION_PROMPT =
    'Look at this photo and decide what a learner saved it to study.\n' +
    'Output ONLY a JSON object, no other text:\n' +
    '{"sceneDescription": "1-3 sentences describing what the image actually shows", "multiEntity": true or false, "entities": [{"name": "...", "overview": "...", "flashcards": [{"front": "...", "back": "..."}]}]}\n' +
    'Rules:\n' +
    '1. Set "multiEntity": true ONLY when the image\'s main content is several distinct, individually notable subjects that deserve separate study — e.g. a group photo of named people, a labelled diagram of several distinct species or parts. A single object, scene, diagram or lone person is "multiEntity": false with "entities": [].\n' +
    '2. For each entity: "name" is who or what it is — a real name/identity ONLY if you recognize it with confidence, otherwise a short honest descriptive label (e.g. "person in the back row, glasses") — never invent a name you are not confident of.\n' +
    '3. "overview" is 2-4 sentences of real, verifiable facts relevant to why this subject is worth learning about. Return "" if you do not have enough reliable information — a thin overview beats an invented one.\n' +
    '4. "flashcards" is 0-3 cards on facts you are confident of. Return [] if unsure.\n' +
    '5. If "multiEntity" is false, "entities" MUST be [].';

const CAPTURE_IMAGE_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// Mirrors paper.js's decidePaperVision: reuse the PDF-recovery vision model if
// the learner already told the app which of their models can see images,
// otherwise the chat model. No dedicated capture setting — this path is opt-in
// by having a vision-capable model at all, and 'auto' (verified-only) is the
// only mode, since a wrongly-guessed identity is the one failure this cannot
// silently degrade from.
function getCaptureVisionModel() {
    const recovery = (getSetting('pdf_recovery_vision_model') || '').trim();
    return recovery || getAISettings().model;
}

/**
 * Turn the vision model's entity list into real child topics — one leaf per
 * identified subject, each with its own Overview and flashcards. The capture
 * node stops being a leaf itself once it has these children (see the
 * structural-children convention in docs/ARCHITECTURE.md), so each subject gets fed,
 * quizzed and reviewed independently rather than as one blended card.
 */
function fanOutEntities(node, entities) {
    return db.transaction(() => {
        let pos = db.prepare(
            'SELECT COALESCE(MAX(position), -1) + 1 as pos FROM nodes WHERE project_id = ? AND parent_id = ?'
        ).get(node.project_id, node.id).pos;
        // These entity nodes were derived by the model from the captured text.
        // The "Captured text" note further down is deliberately NOT stamped —
        // that is the learner's own paste, or a page we fetched verbatim.
        const insertNode = db.prepare(`
            INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position, generated_by)
            VALUES (?, ?, ?, ?, '', 'not_started', 0, ?, ?)
        `);
        const insertCard = db.prepare('INSERT INTO flashcards (node_id, front, back, difficulty, generated_by) VALUES (?, ?, ?, 2, ?)');
        const provenance = aiProvenance();

        let entityCount = 0;
        let cardTotal = 0;
        for (const e of entities.slice(0, 12)) {
            const name = String(e?.name || '').trim().slice(0, 200);
            if (!name) continue;
            const overview = String(e?.overview || '').trim().slice(0, 10000);
            const childId = Number(insertNode.run(node.project_id, node.id, name, overview, pos++, provenance).lastInsertRowid);
            entityCount++;
            const cards = Array.isArray(e?.flashcards) ? e.flashcards : [];
            for (const c of cards.slice(0, 5)) {
                const front = typeof c?.front === 'string' ? c.front.trim() : '';
                const back = typeof c?.back === 'string' ? c.back.trim() : '';
                if (!front || !back) continue;
                insertCard.run(childId, front.slice(0, 2000), back.slice(0, 5000), provenance);
                cardTotal++;
            }
        }
        return { entityCount, cardTotal };
    })();
}

/**
 * Second half: turn a raw capture into something the study loop can use — a
 * real title, an Overview, flashcards and a couple of questions. Runs as a
 * background task; every step is individually optional, because a capture that
 * only ever gets its raw text is still a capture.
 */
export async function enrichCapture({ nodeId, url = '', emit = () => { }, signal }) {
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!node) throw new Error('Capture not found');

    emit({ phase: 'reading', message: 'Reading the capture…' });

    let material = db.prepare(
        'SELECT description FROM nodes WHERE parent_id = ? AND is_note = 1 ORDER BY position LIMIT 1'
    ).get(nodeId)?.description || '';

    // A URL-only capture has nothing to work from until the page is fetched.
    if (!material.trim() && url) {
        const page = await fetchPageContent(url, 6000);
        if (page?.success && page.content?.trim()) {
            material = page.content.trim();
            db.prepare(`
                INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position)
                VALUES (?, ?, 'Captured text', ?, '', 'not_started', 1, 0)
            `).run(node.project_id, nodeId, material.slice(0, 100000));
        }
    }

    // A document capture (PDF/DOCX/etc. dropped onto Capture) has no is_note
    // child — its text lives in the vault document row the client attached via
    // the ordinary upload endpoint. Read it back the same way pasted text or a
    // fetched page would be read.
    if (!material.trim()) {
        const docRows = db.prepare(
            "SELECT content FROM documents WHERE node_id = ? AND content != '' ORDER BY id LIMIT 3"
        ).all(nodeId);
        if (docRows.length) material = docRows.map(r => r.content).join('\n\n---\n\n');
    }

    // An attached photo is ALWAYS looked at, whether or not `material` already
    // holds something — a short caption typed alongside it ("Solvay
    // conference, all people, biographies") must not silence the photo. It
    // used to: this check was gated on `!material.trim()`, same as the
    // doc-content fallback above it, so any caption at all — even one that is
    // itself just an instruction with no real content — pre-empted the vision
    // call entirely and sent the caption alone into capture_enrich, which
    // correctly (per its own no-fabrication rule) refused to invent bios from
    // a bare title. The caption is real signal for identifying the photo, so
    // it is now passed into the vision prompt as a hint instead of gating it
    // out. A photo of several distinct, notable subjects fans out into one
    // child topic per subject; anything else is merged into `material` and
    // falls through to the same capture_enrich path as text.
    const imageDoc = db.prepare(
        "SELECT file_hash, file_type FROM documents WHERE node_id = ? AND file_type IN ('jpg','png','webp') AND file_hash IS NOT NULL ORDER BY id LIMIT 1"
    ).get(nodeId);
    if (imageDoc) {
        const visionModel = getCaptureVisionModel();
        const cap = visionModel && getAISettings().enabled ? await visionAvailability(visionModel) : 'no';
        if (cap === 'yes') {
            emit({ phase: 'image', message: 'Looking at the photo…' });
            const caption = material.trim();
            try {
                const bytes = vaultStorage.readBuffer(imageDoc.file_hash);
                const prompt = caption
                    ? `${CAPTURE_VISION_PROMPT}\n\nThe learner captioned this photo: "${caption.slice(0, 300)}" — treat that as a hint about what/who it shows, but verify from the image itself; do not repeat it back as a fact.`
                    : CAPTURE_VISION_PROMPT;
                const raw = await transcribeImageToText(bytes, {
                    signal,
                    model: visionModel,
                    mime: CAPTURE_IMAGE_MIME[imageDoc.file_type] || 'image/jpeg',
                    prompt,
                });
                const parsed = parseJsonWithRepair(raw) || {};
                const scene = typeof parsed.sceneDescription === 'string' ? parsed.sceneDescription.trim() : '';
                const entities = Array.isArray(parsed.entities) ? parsed.entities.filter(e => e?.name) : [];

                if (parsed.multiEntity && entities.length >= 2) {
                    emit({ phase: 'entities', message: `Writing ${entities.length} topics…` });
                    const result = fanOutEntities(node, entities);
                    if (scene) {
                        db.prepare('UPDATE nodes SET description = COALESCE(NULLIF(?, \'\'), description) WHERE id = ?')
                            .run(scene.slice(0, 10000), nodeId);
                    }
                    return { enriched: true, cardCount: result.cardTotal, questionCount: 0, entityCount: result.entityCount };
                }

                material = [scene, caption].filter(Boolean).join('\n\n');
            } catch (err) {
                // The photo's contribution is lost, not the whole capture —
                // whatever caption/doc material already existed still goes
                // through capture_enrich below, unless it was all there was.
                if (!material.trim()) {
                    return { enriched: false, reason: `Could not read the photo: ${err.message}` };
                }
            }
        } else if (!material.trim()) {
            return { enriched: false, reason: 'No vision-capable model available — the photo was saved as-is.' };
        }
    }

    if (!material.trim()) {
        return { enriched: false, reason: 'Nothing to read — the capture had no text, the link could not be fetched, and the photo (if any) could not be read.' };
    }
    if (!getAISettings().model) {
        return { enriched: false, reason: 'No AI model selected — the capture was saved as-is.' };
    }

    emit({ phase: 'summarizing', message: 'Writing an overview…' });
    const { system, user } = AI_PROMPTS.capture_enrich(node.title, material.slice(0, 12000), url);
    const raw = await generateResponse(user, system, [], {
        signal, temperature: 0.3, top_p: 0.9, operation: 'capture',
    });
    const parsed = parseJsonWithRepair(raw) || {};

    const newTitle = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    const overview = typeof parsed.overview === 'string' ? parsed.overview.trim() : '';
    if (newTitle || overview) {
        db.prepare('UPDATE nodes SET title = COALESCE(NULLIF(?, \'\'), title), description = COALESCE(NULLIF(?, \'\'), description) WHERE id = ?')
            .run(newTitle.slice(0, 200), overview.slice(0, 10000), nodeId);
    }

    // Flashcards — brand new cards, so `next_review` is left NULL and the feed's
    // "new card" path introduces them (never-reviewed = new, see feed.js).
    let cardCount = 0;
    const cards = Array.isArray(parsed.flashcards) ? parsed.flashcards : [];
    if (cards.length > 0) {
        emit({ phase: 'flashcards', message: 'Making flashcards…' });
        const insert = db.prepare('INSERT INTO flashcards (node_id, front, back, difficulty, generated_by) VALUES (?, ?, ?, 2, ?)');
        const provenance = aiProvenance();
        db.transaction(() => {
            for (const c of cards.slice(0, 8)) {
                const front = typeof c?.front === 'string' ? c.front.trim() : '';
                const back = typeof c?.back === 'string' ? c.back.trim() : '';
                if (!front || !back) continue;
                insert.run(nodeId, front.slice(0, 2000), back.slice(0, 5000), provenance);
                cardCount++;
            }
        })();
    }

    // Questions go in as a saved quiz, which is exactly what the feed's
    // degraded (no-AI) path serves — so they are usable immediately and again
    // later, without re-generating anything.
    let questionCount = 0;
    const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
        .map(normalizeFeedQuestion)
        .filter(Boolean);
    if (questions.length > 0) {
        emit({ phase: 'questions', message: 'Writing check questions…' });
        db.prepare('INSERT INTO quizzes (node_id, title, questions, generated_by) VALUES (?, ?, ?, ?)')
            .run(nodeId, bankTitle(nodeId), JSON.stringify(questions), aiProvenance());
        questionCount = questions.length;
    }

    // Enrichment has just replaced the capture's title and Overview — the very
    // text a topic is embedded from — so the vector written for the raw capture
    // is now stale. Re-map it (debounced, and a no-op if embeddings are off).
    scheduleNodeSync();

    return { enriched: true, cardCount, questionCount };
}
