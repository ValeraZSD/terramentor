/**
 * The library the atlas harness draws. Built here, in a scratch directory,
 * every time — and never the one the learner is using.
 *
 * It used to prefer the author's own database whenever that held 40 or more
 * topic vectors, on the reasoning that a real 1,885-topic library is the right
 * instrument for a rendering bug only a real library produces. Two things were
 * wrong with that, and the second is the serious one:
 *
 *   1. The 85 assertions downstream then measure a DIFFERENT SUBJECT on every
 *      machine — a green run says the harness agreed with whatever library
 *      happened to be on that disk, which is not a statement about the code.
 *      The one concrete gap that preference ever named is recorded at `TOPICS`
 *      below: two motion assertions were red on the fixture and green on the
 *      real library, because the fixture's course never left its own
 *      neighbourhood. That was fixed IN THE FIXTURE (the Fourier topic sits on
 *      the calculus axis), so the comment names a closed gap, not a live one.
 *   2. It chose that path WITHOUT SETTING `DB_PATH` OR `VAULT_ROOT`, so every
 *      `server/` import in `run.mjs` opened the real library WRITABLE and ran
 *      migrations, the orphan cleanup and the startup media sweep against it.
 *      On this machine `node_embeddings` is empty, so the branch was dormant —
 *      it armed itself the first time anyone pressed "Re-index all". The sweep
 *      is the one that deleted 12,531 real files once.
 *
 * So the fixture is the only mode, and `assertScratchLibrary` proves it rather
 * than asserting it in prose: it resolves the paths the way the app itself
 * resolves them (`resolveDataPaths`, the ONE reader of `DB_PATH`/`VAULT_ROOT`/
 * `DATA_DIR`) and throws if either one landed on the repo's own. It runs twice
 * — once on the environment this process was STARTED with, which is what
 * refuses `DB_PATH=server/terramentor.db node tools/harness/run.mjs`, and once
 * on the paths the fixture itself just chose, which is what catches a future
 * edit here that forgets to redirect one of them.
 *
 * Looking at a real library is still possible and is now a deliberate act:
 * `ATLAS_HARNESS_DB=<path>` names one. Point it at a COPY — it is opened
 * writable and migrated like any other library, and the copy must include the
 * `-wal` file or it is a stale snapshot. The guard refuses the repo's own
 * database there too.
 *
 * The payload still comes from the real `buildAtlas` over real `sqlite-vec`
 * vectors — only the topics are invented, in three well-separated subject areas
 * plus a deliberately dense cluster, which is enough shape for the
 * label-placement, level-of-detail and gesture assertions to mean something.
 *
 * This module MUST be imported before anything that touches `server/database.js`,
 * because it decides `DB_PATH`, and that module opens its connection at import.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
// A leaf, and pure until `dataPaths()` is called — importing it opens nothing
// and memoises nothing, so it is safe to reach for before the choice is made.
import { resolveDataPaths } from '../../server/paths.js';

// fileURLToPath, not URL.pathname — on Windows the latter yields "/D:/..."
const SERVER_DIR = fileURLToPath(new URL('../../server/', import.meta.url));
/** The historical in-repo layout: what `paths.js` falls back to, and the one
 *  library this harness may never open. */
const REPO_DB = join(SERVER_DIR, 'terramentor.db');
const REPO_VAULT = join(SERVER_DIR, 'vault');

/** Compared the way the file system compares: resolved, and case-insensitively
 *  on Windows — the same normalisation `libraryId` in paths.js uses. */
const samePath = (a, b) => {
    const norm = (p) => (process.platform === 'win32' ? resolve(String(p)).toLowerCase() : resolve(String(p)));
    return norm(a) === norm(b);
};

/**
 * Refuse to run against the repo's own library, loudly, before anything under
 * `server/` is imported.
 *
 * Asked through `resolveDataPaths` rather than by reading `process.env.DB_PATH`
 * directly, because that is the function that will actually decide: a bare
 * `DATA_DIR` with no `DB_PATH` resolves to a database too, and reading the one
 * variable would wave it through.
 */
export function assertScratchLibrary(stage, { allowUnset = false } = {}) {
    const { dbPath, vaultRoot, source } = resolveDataPaths();
    // `legacy` means nothing in the environment named a library at all, which
    // is the normal way this is run and the state the fixture is one line away
    // from replacing. Only the BEFORE check is allowed to shrug at it; the
    // check after the fixture has chosen is unconditional, because by then
    // `source` is `env` unless something went wrong.
    if (allowUnset && source === 'legacy') return null;
    const refuse = (what, path) => {
        throw new Error(
            `atlas harness refuses to run against the repo's own ${what}: ${path}\n`
            + `  (${stage}; paths decided by the ${source} rule)\n`
            + '  This harness imports server/database.js, which opens the file WRITABLE and runs\n'
            + '  migrations, the orphan cleanup and the startup media sweep against it.\n'
            + '  Run it with no DB_PATH/DATA_DIR for the fixture, or point ATLAS_HARNESS_DB at a COPY.');
    };
    if (samePath(dbPath, REPO_DB)) refuse('database', dbPath);
    if (samePath(vaultRoot, REPO_VAULT)) refuse('blob store', vaultRoot);
    return { dbPath, vaultRoot };
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
    // started. Both went red on the fixture while the real library was green —
    // which is why the fixture, not the preference for the real library, is
    // what had to be fixed.
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
 * pair; `mode` is 'fixture', or 'real' when `ATLAS_HARNESS_DB` named one, so
 * the harness can say which it proved.
 * Call this BEFORE importing any `server/` module.
 */
export async function prepareAtlasLibrary() {
    // Whatever the shell was carrying, this harness decides. `DATA_DIR` is the
    // precedence-2 rule in paths.js and the desktop launcher sets it to the
    // learner's own folder, so leaving it in place would point a test run at a
    // real library without `DB_PATH` ever being mentioned.
    const named = process.env.ATLAS_HARNESS_DB;
    assertScratchLibrary('the environment this process was started with', { allowUnset: true });
    delete process.env.DATA_DIR;
    delete process.env.DB_PATH;
    delete process.env.VAULT_ROOT;

    const scratch = mkdtempSync(join(tmpdir(), 'atlas-harness-'));
    // The startup media sweep answers to VAULT_ROOT, and a scratch database next
    // to the real blob store is how 12,531 real files were once deleted. Never
    // point a scratch run at the default vault.
    process.env.VAULT_ROOT = join(scratch, 'vault');
    process.env.DB_PATH = named ? resolve(named) : join(scratch, 'test.db');
    assertScratchLibrary(named ? 'ATLAS_HARNESS_DB' : 'the scratch library this fixture just chose');

    const B = new URL('../../server/', import.meta.url).href;

    if (named) {
        // A library somebody explicitly named. Nothing is seeded into it and
        // nothing is invented; it is opened, migrated and drawn as it is.
        const { default: db, vecAvailable } = await import(B + 'database.js');
        return {
            mode: 'real',
            vecAvailable,
            cleanup: async () => {
                try { db.close(); } catch { /* already closed */ }
                try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
            },
        };
    }

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
