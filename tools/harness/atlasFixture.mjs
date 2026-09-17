/**
 * A library for the atlas harness to draw, when the machine running it has none.
 *
 * The harness was written against the author's own database, which is the right
 * instrument for catching a rendering bug that only a real 1,885-topic library
 * produces. It is the wrong instrument for a stranger, for a fresh clone, and
 * for CI: there the database is the seeded tutorial with no topic vectors in it,
 * `buildAtlas` correctly answers "nothing has been mapped", and the harness
 * exits 1 — a red suite on the first `npm test` anyone ever runs.
 *
 * So: use the real library when there is one, and otherwise build a small
 * synthetic one here. The payload still comes from the real `buildAtlas` over
 * real `sqlite-vec` vectors — only the topics are invented, in three
 * well-separated subject areas plus a deliberately dense cluster, which is
 * enough shape for the label-placement, level-of-detail and gesture assertions
 * to mean something.
 *
 * This module MUST be imported before anything that touches `server/database.js`,
 * because it decides `DB_PATH`, and that module opens its connection at import.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const require = createRequire(import.meta.url);

/** How many topic vectors make the real library worth preferring over a fixture. */
const MIN_REAL_TOPICS = 40;

/**
 * Does the database this process would open already hold a mapped library?
 * Asked by opening the file directly, read-only — importing `database.js` to
 * find out would pin the connection to whichever path we were trying to choose.
 */
function realLibraryIsMapped() {
    // fileURLToPath, not URL.pathname — on Windows the latter yields "/D:/..."
    const path = process.env.DB_PATH
        || join(fileURLToPath(new URL('../../server/', import.meta.url)), 'terramentor.db');
    try {
        const Database = require('better-sqlite3');
        const db = new Database(path, { readonly: true, fileMustExist: true });
        try {
            const n = db.prepare('SELECT COUNT(*) AS n FROM node_embeddings').get().n;
            return n >= MIN_REAL_TOPICS;
        } finally {
            db.close();
        }
    } catch {
        return false; // no file, no such table, locked — all mean "not usable here"
    }
}

/** Four axes: waves, calculus, cooking, and a filler direction for everything else. */
const SPACE = [
    [/wave|harmonic|antinode|resonan/i, [1, 0.05, 0, 0]],
    [/fourier|integral|derivative|series|limit/i, [0.05, 1, 0, 0]],
    [/dough|bread|proof|crumb|knead|ferment/i, [0, 0, 1, 0.05]],
];

const TOPICS = [
    // The last of these is deliberately on the CALCULUS axis, so the course
    // below crosses the map instead of circling one region. A journey whose
    // legs are all short is a journey the camera barely has to travel, and the
    // motion assertions then measure a camera with nothing to do: the flight
    // spends most of a short beat inside the one frame that carries no travel
    // by design, and "it never stops dead" reads a ride that never really
    // started. Both went red on the fixture while the real library was green.
    ['Waves', ['Standing waves on a string', 'Nodes and antinodes', 'Harmonic series of a pipe',
        'Resonance and driving frequency', 'Wave speed and tension', 'Beats between two frequencies',
        'Fourier series of a plucked string']],
    ['Calculus', ['Limits and continuity', 'The derivative as a rate', 'Integration by substitution',
        'Fourier series of a square wave', 'Taylor series and remainder', 'The fundamental theorem']],
    ['Baking', ['Kneading and gluten', 'Bulk fermentation', 'Shaping and proofing',
        'Reading the crumb', 'Sourdough starter maintenance', 'Oven spring']],
];

// A dense run of near-identical titles: this is what makes one region large
// enough to be split, and what gives the label placer names that collide.
const DENSE = Array.from({ length: 24 }, (_, i) => `Practice set ${i + 1}: harmonic problems`);

/**
 * Prepare a library for `buildAtlas` to draw. Returns a `{ mode, cleanup }`
 * pair; `mode` is 'real' or 'fixture' so the harness can say which it proved.
 * Call this BEFORE importing any `server/` module.
 */
export async function prepareAtlasLibrary() {
    if (realLibraryIsMapped()) return { mode: 'real', cleanup: async () => { } };

    const scratch = mkdtempSync(join(tmpdir(), 'atlas-harness-'));
    process.env.DB_PATH = join(scratch, 'test.db');
    // The startup media sweep answers to VAULT_ROOT, and a scratch database next
    // to the real blob store is how 12,531 real files were once deleted. Never
    // point a scratch run at the default vault.
    process.env.VAULT_ROOT = join(scratch, 'vault');

    const stub = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const { input } = JSON.parse(body || '{}');
            const texts = Array.isArray(input) ? input : [input];
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
                embeddings: texts.map((t) => {
                    const dense = t.match(/Practice set (\d+)/);
                    if (dense) {
                        // A tight arc: adjacent items all but identical, the ends
                        // merely similar — a region that deserves subdividing.
                        const a = (Number(dense[1]) / 24) * 0.35;
                        return [Math.cos(a), Math.sin(a) * 0.4, 0, 0];
                    }
                    return SPACE.find(([re]) => re.test(t))?.[1] ?? [0.1, 0.1, 0.1, 1];
                }),
            }));
        });
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));

    const B = new URL('../../server/', import.meta.url).href;
    const { default: db, vecAvailable } = await import(B + 'database.js');
    const { syncNodeEmbeddings } = await import(B + 'nodeEmbeddings.js');

    const setSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                                   ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    setSetting.run('ai_ollama_url', `http://127.0.0.1:${stub.address().port}`);
    setSetting.run('embedding_model', 'stub-embed');
    setSetting.run('embedding_provider', 'ollama');

    const addProject = db.prepare('INSERT INTO projects (name, color) VALUES (?, ?)');
    const addNode = db.prepare(
        'INSERT INTO nodes (project_id, parent_id, title, description) VALUES (?, ?, ?, ?)');
    // A course nobody has walked draws no path at all, and the paths layer
    // would then be unreachable from here. So the first course carries a
    // finished run through it, on successive days: real enough to order, long
    // enough to have an old end and a recent one.
    const finish = db.prepare(
        "UPDATE nodes SET status = 'completed', completed_at = ? WHERE id = ?");

    for (const [project, titles] of TOPICS) {
        const pid = addProject.run(project, '#8B5CF6').lastInsertRowid;
        const root = addNode.run(pid, null, project, `Everything about ${project.toLowerCase()}.`)
            .lastInsertRowid;
        const children = titles.map(title =>
            addNode.run(pid, root, title, `On ${title.toLowerCase()}.`).lastInsertRowid);
        if (project === 'Waves') {
            for (const title of DENSE) addNode.run(pid, root, title, title);
            // Deliberately NOT in the order they were authored: the journey is
            // ordered by when things were closed, and a fixture that agrees
            // with the curriculum order cannot tell the two apart. Index 6 is
            // the Fourier topic, which sits in another region entirely — the
            // course leaves its own neighbourhood and comes back.
            [3, 0, 6, 5, 1].forEach((i, step) =>
                finish.run(`2026-0${step + 1}-1${step}T09:00:00.000Z`, children[i]));
        }
    }

    await syncNodeEmbeddings();

    return {
        mode: 'fixture',
        vecAvailable,
        cleanup: async () => {
            await new Promise((r) => stub.close(r));
            try { db.close(); } catch { }
            try { rmSync(scratch, { recursive: true, force: true }); } catch { }
        },
    };
}
