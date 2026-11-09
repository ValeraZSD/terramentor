/**
 * The invented course `tools/docs-shots.mjs` checks the README's screens on.
 *
 * Two halves, because a library is half rows and half the app's own doing:
 *
 *   startFixture()  runs in the scratch server's process before the server is
 *                   imported: AI off, and topic vectors from a stub on
 *                   127.0.0.1 that answers by keyword, so no model is called.
 *   prepare()       runs in the parent once the server answers: the course
 *                   arrives through POST /api/import like any course file, its
 *                   history is written in, and it is planned through the
 *                   schedule routes. It ends by checking the course reads On
 *                   track, so every run shows the same screens.
 *
 * Everything is relative to today: the course started 18 days ago, five topics
 * were finished on earlier days, and the rest is planned from today.
 *
 * Nothing here may import a server module at the top: this file is also
 * imported by the parent process, which must never open a library.
 */
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);

const CHAPTERS = [
    ['The night sky', [
        'Constellations and star maps',
        'Phases of the Moon',
        'Eclipses of the Sun and Moon',
        'Seasons and the tilt of the Earth',
    ]],
    ['Light and telescopes', [
        'The electromagnetic spectrum',
        'Refracting and reflecting telescopes',
        'Spectra and what they reveal',
        'The Doppler shift of starlight',
    ]],
    ['Stars', [
        'Brightness and magnitude',
        'The life of a star',
        'White dwarfs and neutron stars',
        'Distances in light-years',
    ]],
];

/** Finished topics and how many days ago. */
const DONE = {
    'Constellations and star maps': 12,
    'Eclipses of the Sun and Moon': 9,
    'Seasons and the tilt of the Earth': 6,
    'The electromagnetic spectrum': 4,
    'Refracting and reflecting telescopes': 2,
};

const STUDY = 'Spectra and what they reveal';
const PROVE = 'Phases of the Moon';
const CARDS = 'Brightness and magnitude';
const HEADING = 'Reading the lines in a spectrum';

const mc = (question, correct, ...others) => ({
    question, type: 'multiple_choice', options: [correct, ...others], correct_answer: correct,
    explanation: `The answer is: ${correct}.`,
});

const MOON_BANK = [
    mc('What causes the phases of the Moon?', 'The changing angle between the Sun, Earth and Moon',
        "Earth's shadow falling on the Moon", 'Clouds covering part of the Moon', "The Moon's own rotation"),
    mc('About how long does one full cycle of phases take?', 'About 29.5 days', 'About 7 days', 'About 365 days', 'About 24 hours'),
    mc('Where is the Moon at new Moon?', 'Between the Earth and the Sun', 'On the far side of the Earth from the Sun',
        'At a right angle to the line from the Earth to the Sun', 'Inside the shadow of the Earth'),
    mc('What does "waxing" mean?', 'The lit part we see is growing', 'The lit part we see is shrinking',
        'The Moon is moving closer to the Earth', "The Moon is in the Earth's shadow"),
    mc('Which phase comes right after full Moon?', 'Waning gibbous', 'Waxing gibbous', 'New Moon', 'Waxing crescent'),
    mc('At first quarter, how much of the face we see is lit?', 'Half', 'A quarter', 'All of it', 'None of it'),
    mc('Why do we always see the same face of the Moon?', 'It turns once in the time it takes to orbit the Earth',
        'It does not turn at all', "The Earth's air hides the other side", 'The far side gives off no light'),
    mc('At which phase can an eclipse of the Moon happen?', 'Full Moon', 'New Moon', 'First quarter', 'Last quarter'),
    mc('How much of the Moon does the Sun light at any moment?', 'Half of it', 'All of it', 'A quarter of it', 'It depends on the phase'),
    mc('A thin crescent low in the west just after sunset is', 'A waxing crescent', 'A waning crescent', 'The last quarter', 'A full Moon'),
];

const card = (front, back) => ({ front, back });

const COURSE = {
    project: { name: 'Astronomy for Beginners', description: 'The night sky, light and the stars, from the ground up.', color: '#0EA5E9' },
    nodes: CHAPTERS.map(([chapter, topics]) => ({
        title: chapter,
        description: `${chapter}: what it is and how to read it.`,
        children: topics.map((title) => ({
            title,
            description: `What ${title.toLowerCase()} are, and how an observer uses them.`,
            ...(title === PROVE ? { questions: MOON_BANK } : {}),
            ...(title === 'Refracting and reflecting telescopes' ? {
                flashcards: [
                    card('What gathers the light in a refracting telescope?', 'A lens'),
                    card('What gathers the light in a reflecting telescope?', 'A curved mirror'),
                ],
            } : {}),
            ...(title === CARDS ? {
                flashcards: [
                    card('Which looks brighter: a star of magnitude 1 or one of magnitude 5?', 'Magnitude 1: smaller numbers are brighter'),
                    card('What is apparent magnitude?', 'How bright a star looks from the Earth'),
                    card('What is absolute magnitude?', 'How bright a star would look from 10 parsecs away'),
                    card('Five magnitudes apart means how many times brighter?', '100 times'),
                ],
            } : {}),
        })),
    })),
};

const SPECTRUM = `\`\`\`animation
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 200">
  <defs>
    <linearGradient id="s" x1="0" x2="1">
      <stop offset="0" stop-color="#7c3aed"/><stop offset="0.25" stop-color="#2563eb"/>
      <stop offset="0.5" stop-color="#16a34a"/><stop offset="0.75" stop-color="#eab308"/>
      <stop offset="1" stop-color="#dc2626"/>
    </linearGradient>
  </defs>
  <rect x="20" y="60" width="320" height="60" fill="url(#s)"/>
  <rect x="96" y="60" width="4" height="60" fill="#111827"/>
  <rect x="188" y="60" width="4" height="60" fill="#111827"/>
  <rect x="290" y="60" width="4" height="60" fill="#111827"/>
  <text x="20" y="40" font-family="sans-serif" font-size="14" fill="#111827">Light from a star, spread out</text>
  <text x="20" y="150" font-family="sans-serif" font-size="12" fill="#374151">blue</text>
  <text x="312" y="150" font-family="sans-serif" font-size="12" fill="#374151">red</text>
  <circle cx="98" cy="170" r="6" fill="#111827">
    <animate attributeName="cx" values="98;190;292;98" dur="6s" repeatCount="indefinite"/>
  </circle>
</svg>
\`\`\``;

const LESSON = `## ${HEADING}

Spread the light of a star through a prism and it becomes a band of colour. Across that band sit thin dark lines: colours the star's outer layers have taken out. Every element takes out its own set, so the lines name what the star is made of.

${SPECTRUM}

The pattern of lines from hydrogen is the same in a lamp on Earth and in a star across the galaxy. Matching the two is how astronomers read a star's make-up from its light alone.`;

const CHECK = mc('What do the dark lines in a star\'s spectrum tell us?', 'Which elements are in its outer layers',
    'How far away the star is', 'How old the star is', 'How fast the star turns');

/** In the server's process, before the server starts. */
export async function startFixture() {
    const { default: db } = await import(new URL('../server/database.js', import.meta.url).href);

    // Topic vectors by keyword: the three chapters are three directions.
    const SPACE = [
        [/star|magnitude|dwarf|neutron|light-year/i, [0, 0, 1, 0.05]],
        [/light|telescope|spectr|doppler/i, [0.05, 1, 0, 0]],
        [/sky|moon|eclipse|season|constellation/i, [1, 0.05, 0, 0]],
    ];
    const stub = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const { input } = JSON.parse(body || '{}');
            const texts = Array.isArray(input) ? input : [input];
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ embeddings: texts.map((t) => SPACE.find(([re]) => re.test(t))?.[1] ?? [0.1, 0.1, 0.1, 1]) }));
        });
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    stub.unref();

    const set = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                            ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    // A library someone has used: past the welcome and the first-run notes.
    for (const key of ['welcome_done', 'ai_setup_dismissed', 'onboarding_dismissed']) set.run(key, 'true');
    // Asked about update checks and said no: the strip stays away and nothing goes out.
    set.run('update_check_asked', '1');
    set.run('ai_enabled', 'false');
    set.run('ai_ollama_url', `http://127.0.0.1:${stub.address().port}`);
    set.run('embedding_model', 'stub-embed');
    set.run('embedding_provider', 'ollama');

    return {
        project: COURSE.project.name,
        study: { topic: STUDY, heading: HEADING },
        prove: { topic: PROVE, wrong: 2 },
        cards: { topic: CARDS },
    };
}

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** In the parent, once the server answers. Returns the ids the states need. */
export async function prepare({ api, dbPath }) {
    const imported = await api.post('/api/import', COURSE);
    if (imported.status !== 200) throw new Error(`fixture: import ${imported.status} ${JSON.stringify(imported.json)}`);
    const project = imported.json.id;

    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    const id = (title) => db.prepare('SELECT id FROM nodes WHERE project_id = ? AND title = ?').get(project, title).id;
    let ids;
    try {
        ids = { project, study: id(STUDY), prove: id(PROVE), cards: id(CARDS) };
        const finish = db.prepare("UPDATE nodes SET status = 'completed', completed_at = ? WHERE id = ?");
        for (const [title, ago] of Object.entries(DONE)) finish.run(`${day(-ago)}T09:00:00.000Z`, id(title));
        db.prepare("UPDATE nodes SET status = 'in_progress' WHERE id IN (?, ?)").run(id(STUDY), id(PROVE));

        // The study topic as the app stores a taught topic: its plan, a lesson part and its question.
        const item = db.prepare('INSERT INTO feed_items (node_id, kind, seq, content, meta, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        const now = new Date().toISOString();
        const part = { partIndex: 1, partCount: 1, partTitle: HEADING };
        item.run(id(STUDY), 'plan', 0, JSON.stringify({ parts: [{ title: HEADING, focus: 'Read the dark lines in a star\'s spectrum as the elements that made them.' }] }), null, 'internal', now);
        item.run(id(STUDY), 'lesson', 1, LESSON, JSON.stringify({ ...part, audited: true }), 'ready', now);
        item.run(id(STUDY), 'question', 2, JSON.stringify(CHECK), JSON.stringify({ ...part, questionType: 'multiple_choice', verified: true }), 'ready', now);
    } finally {
        db.close();
    }

    const planned = await api.post(`/api/projects/${project}/schedule`, { startDate: day(-18), deadline: day(42), studyDays: [1, 2, 3, 4, 5, 6, 7] });
    if (planned.status !== 200) throw new Error(`fixture: schedule ${planned.status} ${JSON.stringify(planned.json)}`);
    // Each finished topic was planned for the day it was finished; the rest is planned from today.
    const write = new Database(dbPath);
    try {
        write.pragma('busy_timeout = 5000');
        const bar = write.prepare('UPDATE nodes SET scheduled_start = ?, scheduled_end = ? WHERE project_id = ? AND title = ?');
        for (const [title, ago] of Object.entries(DONE)) bar.run(day(-ago), day(-ago), project, title);
    } finally {
        write.close();
    }
    const replanned = await api.post(`/api/projects/${project}/recalibrate`, {});
    if (replanned.status !== 200) throw new Error(`fixture: recalibrate ${replanned.status} ${JSON.stringify(replanned.json)}`);
    const pace = (await api.get(`/api/projects/${project}/pace`)).json;
    if (pace?.paceStatus !== 'on_track') throw new Error(`fixture: the course reads ${JSON.stringify(pace)}, not on track`);

    // The atlas draws only topics with a vector: wait for the import's sweep.
    const reader = new Database(dbPath, { readonly: true });
    try {
        const missing = reader.prepare(`SELECT COUNT(*) AS n FROM nodes n LEFT JOIN node_embeddings e ON e.node_id = n.id
                                        WHERE n.project_id = ? AND n.is_note = 0 AND (e.status IS NULL OR e.status <> 'indexed')`);
        for (const t0 = Date.now(); missing.get(project).n > 0;) {
            if (Date.now() - t0 > 60_000) throw new Error('fixture: the topic vectors were not written within a minute');
            await new Promise((r) => setTimeout(r, 500));
        }
    } finally {
        reader.close();
    }

    // The sweep leaves a finished chip in the task dock until it is closed; close it, so
    // whether a screen shows the dock does not depend on how soon it was opened.
    for (const t0 = Date.now(); ;) {
        const left = (await api.get('/api/tasks')).json ?? [];
        if (!left.length) break;
        if (Date.now() - t0 > 60_000) throw new Error(`fixture: background tasks still listed: ${left.map((t) => `${t.type}:${t.status}`).join(', ')}`);
        for (const task of left) await api.delete(`/api/tasks/${task.id}`);
        await new Promise((r) => setTimeout(r, 500));
    }

    return ids;
}
