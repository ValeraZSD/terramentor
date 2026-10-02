// tools/course-context-gates.mjs — the feed's lesson writer knows where its
// topic sits in the course, and does not pretend the learner was just there.
//
// Run:  node tools/course-context-gates.mjs
//
// `buildNodeContext` hands an author one topic. A lesson on Doppler could not
// know that Beats came right before it — nor that "right before" was seven weeks
// ago for this learner, which is how a lesson ends up opening "as you just
// learned". `server/courseContext.js` adds a bounded block for the LESSON writer
// only: a few topics either side in course order with where the learner stands
// on each, and the previous topic as the learner was shown it. This asserts:
//
//   * the wording is a pure function of data and an injected clock — calendar
//     days in UTC ("yesterday" across a midnight), weeks, months, never a date;
//   * course order is the TREE walk, never a sort on `position` (which is per
//     parent) — and the outline planner's sibling list, which did sort on
//     position, now keeps the very next topic in view (the pre-fix query is run
//     against the same fixture as the control);
//   * the previous topic's text is what was SERVED (consumed lessons, visuals
//     stripped), else its Overview and Material, bounded to PREVIOUS_TOPIC_CHARS;
//   * the block reaches the lesson writer and no assessment: the question
//     writer, the mastery-check bank and the cards stay pinned to their topic;
//   * a lesson that talks as if the learner had just studied the previous topic
//     is a defect the writer is sent back over, and the forms that must not
//     fire (recalling the previous PART of the same topic) do not.
//
// Deterministic: a scratch database, no model, no network.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'course-context-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
const cc = await import(B + 'courseContext.js');
const { siblingTitles } = await import(B + 'feedGen.js');
const { lessonDefects, staleRecallFaults } = await import(B + 'feedQuality.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---- the words, from an injected clock --------------------------------------

console.log('\n--- how long ago, in words ---');
const NOW = Date.parse('2026-09-28T15:30:00Z');
const at = (iso) => Date.parse(iso);
eq('earlier the same UTC day is today', cc.recencyPhrase(at('2026-09-28T01:00:00Z'), NOW), 'today');
eq('twenty hours ago across a midnight is yesterday, not today', cc.recencyPhrase(at('2026-09-27T19:26:38Z'), NOW), 'yesterday');
eq('five days', cc.recencyPhrase(at('2026-09-23T12:00:00Z'), NOW), '5 days ago');
eq('seven weeks, not 51 days', cc.recencyPhrase(at('2026-08-08T12:00:00Z'), NOW), '7 weeks ago');
eq('months past two', cc.recencyPhrase(at('2026-05-01T12:00:00Z'), NOW), '5 months ago');
eq('over a year', cc.recencyPhrase(at('2025-06-01T12:00:00Z'), NOW), 'over a year ago');
eq('a future stamp says nothing', cc.recencyPhrase(at('2026-10-01T12:00:00Z'), NOW), null);
eq('SQLite\'s CURRENT_TIMESTAMP shape is read as UTC', cc.parseStamp('2026-09-27 19:26:38'), at('2026-09-27T19:26:38Z'));

eq('a finished topic says when', cc.learnerStanding({ status: 'completed', completedAt: '2026-08-08T12:00:00.000Z' }, NOW), 'finished 7 weeks ago');
eq('a started one says when it was last studied', cc.learnerStanding({ status: 'in_progress', lastStudiedAt: '2026-09-27T19:26:38.584Z' }, NOW), 'started, last studied yesterday');
eq('an untouched one says so', cc.learnerStanding({ status: 'not_started' }, NOW), 'not studied yet');
eq('skipped is not finished', cc.learnerStanding({ status: 'skipped' }, NOW), 'skipped');

console.log('\n--- bounded, never cut mid-sentence ---');
const para = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i} explains one more step of the idea in a sentence or two.`).join('\n\n');
const tail = cc.boundText(para(200), 600, 'end');
check('the tail is within the bound (plus its marker)', tail.length <= 600 + 4, String(tail.length));
check('…starts at a paragraph and says it was cut', tail.startsWith('[…] Paragraph '), tail.slice(0, 40));
check('…and keeps the END, which is what came right before this topic', tail.endsWith('Paragraph 199 explains one more step of the idea in a sentence or two.'));
const head = cc.boundText(para(200), 600, 'start');
check('the head keeps the START (an Overview says what the topic is first)', head.startsWith('Paragraph 0 ') && head.endsWith('[…]'), head.slice(-40));
check('short text is untouched', cc.boundText('One line.', 600) === 'One line.');
eq('served text loses its visual specs but keeps real code',
    cc.shownLessonText(['Before.\n```mermaid\ngraph TD; A-->B\n```\nAfter.', '```js\nconst x = 1;\n```']),
    'Before.\n[visual]\nAfter.\n\n```js\nconst x = 1;\n```');

console.log('\n--- the block ---');
const data = {
    current: { title: 'Electromagnetic Spectrum', trail: 'Domain B › B1 — Waves' },
    before: [
        { title: 'Beats', trail: 'Domain B › B1 — Waves', status: 'completed', completedAt: '2026-08-08T12:00:00Z' },
        { title: 'Doppler Effect', trail: 'Domain B › B1 — Waves', status: 'in_progress', lastStudiedAt: '2026-09-27T19:26:38Z' },
    ],
    after: [{ title: 'Ultrasound Imaging', trail: 'Domain B › B2 — Imaging', status: 'not_started' }],
    previous: { title: 'Doppler Effect', status: 'in_progress', lastStudiedAt: '2026-09-27T19:26:38Z', source: 'shown', text: para(200) },
};
const block = cc.formatCourseContext(data, { now: NOW });
const lines = block.split('\n');
check('earlier topics come before this one, later ones after', block.indexOf('- Beats') < block.indexOf('- Doppler Effect') && block.indexOf('- Doppler Effect') < block.indexOf('This topic: Electromagnetic Spectrum') && block.indexOf('This topic:') < block.indexOf('Ultrasound Imaging'));
check('each neighbour says where the learner stands', block.includes('- Beats (finished 7 weeks ago)') && block.includes('- Doppler Effect (started, last studied yesterday)'));
check('the section is said once; a neighbour in another section carries its own path',
    lines.filter(l => l.includes('Domain B › B1 — Waves')).length === 1 && block.includes('- Domain B › B2 — Imaging › Ultrasound Imaging (not studied yet)'));
check('it forbids "as you just learned" in so many words', /Do not write "as you just learned"/.test(block));
check('it asks for a neutral recall ("earlier in the course…")', /earlier in the course…/.test(block));
check('it forbids pre-empting the later topics', /Do not teach or pre-empt the later topics/.test(block));
check('it forbids writing about the order, the dates or progress', /Never mention this list, the order of the course, dates, or anyone's progress/.test(block));
check('it never prints a date', !/\d{4}-\d{2}-\d{2}/.test(block));
check('the previous topic is bounded to PREVIOUS_TOPIC_CHARS', block.length < cc.PREVIOUS_TOPIC_CHARS + 2600, `${block.length} chars`);
check('…and labelled as what the learner was shown', /as the learner was shown it in the feed/.test(block));
eq('nothing either side is nothing at all', cc.formatCourseContext({ current: { title: 'x' }, before: [], after: [] }), '');

// ---- the database half ------------------------------------------------------

console.log('\n--- course order is the tree walk ---');
const mkProject = (name) => db.prepare('INSERT INTO projects (name) VALUES (?)').run(name).lastInsertRowid;
const mkNode = (projectId, parentId, title, position, extra = {}) => db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position, status, completed_at, description, is_note, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
).run(projectId, parentId, title, position, extra.status || 'not_started', extra.completedAt || null,
    extra.description || null, extra.isNote ? 1 : 0, extra.role || 'topic').lastInsertRowid;

const p = mkProject('Physics — Course Context Fixture');
// Twelve sections, each with topics at positions 0..3 — the shape that made the
// position sort useless: every section has a topic at every position.
const sections = [];
for (let s = 0; s < 12; s++) sections.push(mkNode(p, null, `Section ${s}`, s));
const topic = {};
for (let s = 0; s < 12; s++) {
    for (let i = 0; i < 4; i++) topic[`${s}.${i}`] = mkNode(p, sections[s], `Topic ${s}.${i}`, i);
}
// A note (material, not a topic) and a pagination stage (card order, not work)
// inside section 5: neither is in the course's order.
mkNode(p, sections[5], 'A note on units', 9, { isNote: true, description: 'Units are SI.' });
mkNode(p, sections[5], 'Stage 7', 10, { role: 'pagination' });

const order = cc.courseLeaves(p).map(l => l.title);
eq('48 work leaves, section by section, position within section', [order.length, order[0], order[3], order[4], order[47]],
    [48, 'Topic 0.0', 'Topic 0.3', 'Topic 1.0', 'Topic 11.3']);
check('notes and card-order stages are not topics of the course', !order.includes('A note on units') && !order.includes('Stage 7'));
eq('each topic carries its section trail', cc.courseLeaves(p)[5].trail, 'Section 1');

console.log('\n--- the outline planner sees its real neighbours ---');
// Topic 5.3's next topic is 6.0. Under the old sort on |position − 3| every
// section's position-3 and position-2 topic came first, and 6.0 — the one a plan
// annexes — was cut behind twenty-odd unrelated ones at a limit of 20.
const oldSiblings = (nodeId, limit) => db.prepare(`
    SELECT n.title FROM nodes n
    WHERE n.project_id = (SELECT project_id FROM nodes WHERE id = ?)
      AND n.id != ? AND n.is_note = 0
      AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id AND c.is_note = 0)
    ORDER BY ABS(n.position - (SELECT position FROM nodes WHERE id = ?))
    LIMIT ?
`).all(nodeId, nodeId, nodeId, limit).map(r => r.title);
check('control: the pre-fix sort drops the very next topic', !oldSiblings(topic['5.3'], 20).includes('Topic 6.0'));
const sib = siblingTitles(topic['5.3'], 20);
check('now the very next and the very previous topic are both listed', sib.includes('Topic 6.0') && sib.includes('Topic 5.2'), JSON.stringify(sib));
check('…in course order, without the topic itself', !sib.includes('Topic 5.3') && sib.indexOf('Topic 5.2') < sib.indexOf('Topic 6.0'));
eq('…and at most the limit', sib.length, 20);

console.log('\n--- the previous topic, as it was shown ---');
const setStatus = (id, status, completedAt = null) => db.prepare('UPDATE nodes SET status = ?, completed_at = ? WHERE id = ?').run(status, completedAt, id);
setStatus(topic['5.1'], 'completed', '2026-08-08T12:00:00.000Z');
db.prepare(`UPDATE nodes SET description = ? WHERE id = ?`).run('Beats occur when two close frequencies overlap.', topic['5.1']);
mkNode(p, topic['5.1'], 'Worked example', 0, { isNote: true, description: 'Two forks at 440 and 444 Hz beat 4 times a second.' });
let n = cc.courseNeighbourhood(topic['5.2']);
eq('a finished previous topic with no served lessons falls back to its Overview and Material',
    [n.previous.source, n.previous.text.includes('Beats occur'), n.previous.text.includes('440 and 444 Hz')], ['overview', true, true]);

const addLesson = (nodeId, seq, content, status) => db.prepare(
    `INSERT INTO feed_items (node_id, kind, seq, content, meta, status, consumed_at) VALUES (?, 'lesson', ?, ?, '{}', ?, ?)`,
).run(nodeId, seq, content, status, status === 'consumed' ? '2026-09-27T19:26:38.584Z' : null);
addLesson(topic['5.2'], 1, 'Part one of Doppler, as served.\n```animation\nShows: a siren\n```', 'consumed');
addLesson(topic['5.2'], 3, 'Part two, served too.', 'consumed');
addLesson(topic['5.2'], 5, 'Part three, written but never shown.', 'ready');
n = cc.courseNeighbourhood(topic['5.3']);
eq('a previous topic with served lessons is represented by THOSE, in order, visuals stripped, unserved ones left out',
    [n.previous.source, n.previous.text], ['shown', 'Part one of Doppler, as served.\n[visual]\n\nPart two, served too.']);
eq('…and its standing comes from when it was last studied', cc.learnerStanding(n.previous, NOW), 'started, last studied yesterday');

// A lesson grounded in the course's documents is STORED with a Sources line of
// document titles (server/lessonSources.js). The line is made here by the real
// resolver, so the assertion follows the stored shape if it ever changes.
const { resolveLessonCitations } = await import(B + 'lessonSources.js');
const grounded = resolveLessonCitations(
    'Part four: the moving observer [[src:1]] hears a higher pitch [[src:2]].',
    [{ n: 1, title: 'Lecture 7 notes: Kessler' }, { n: 2, title: 'Acoustics handbook' }],
).text;
check('control: the stored grounded lesson really carries its Sources line', /\n---\nSources: Lecture 7 notes: Kessler/.test(grounded), JSON.stringify(grounded));
addLesson(topic['5.2'], 7, grounded, 'consumed');
n = cc.courseNeighbourhood(topic['5.3']);
check('a grounded lesson reaches the next topic\'s writer as what it TAUGHT, without its Sources line',
    n.previous.text.includes('Part four: the moving observer hears a higher pitch.')
        && !/Sources:|Kessler|Acoustics handbook|\n---/.test(n.previous.text),
    JSON.stringify(n.previous.text));
check('…and the rendered block carries no document title either',
    !/Kessler|Acoustics handbook/.test(cc.courseContextForNode(topic['5.3'])));
eq('the first topic of a course has nothing before it', [cc.courseNeighbourhood(topic['0.0']).before.length, cc.courseNeighbourhood(topic['0.0']).isFirst], [0, true]);
check('a note is not in the order, so it gets no block', cc.courseContextForNode(db.prepare(`SELECT id FROM nodes WHERE title = 'A note on units'`).get().id) === '');
check('a node that does not exist is an empty block, not a throw', cc.courseContextForNode(999999) === '');

// ---- who gets it -------------------------------------------------------------

console.log('\n--- the lesson writer gets it, assessment does not ---');
const feedGenSrc = readFileSync(new URL('../server/feedGen.js', import.meta.url), 'utf8');
check('the lesson context carries the block',
    /const lessonContext = buildNodeContext\(f\.nodeId, \{ completedTopics: true \}\) \+ courseContextForNode\(f\.nodeId\)/.test(feedGenSrc));
check('the question writer\'s context does not', /const qContext = buildNodeContext\(f\.nodeId\);/.test(feedGenSrc));
check('courseContextForNode is called exactly once in the generator', (feedGenSrc.match(/courseContextForNode\(/g) || []).length === 1);
for (const file of ['studyMaterial.js', 'placement.js', 'paper.js']) {
    const src = readFileSync(new URL(`../server/${file}`, import.meta.url), 'utf8');
    check(`${file} (assessment) never reads it`, !/courseContext/.test(src));
}

console.log('\n--- "as you just learned" is sent back ---');
const lessonBody = (s) => `${s} ${'The wavelength and the frequency are linked by the wave speed, and that link carries every result below. '.repeat(3)}`;
for (const bad of [
    'In the previous lesson we met beats.',
    'As you learned in the previous topic, beats are slow.',
    'Last time we saw how two tones interfere.',
    'Since the last lesson, you know the beat frequency.',
    "You've just finished the previous topic on beats.",
]) {
    check(`fires: "${bad}"`, staleRecallFaults(bad).length === 1);
}
for (const good of [
    'As you saw in Part 1, the fronts bunch up ahead of the source.',
    'Recall from earlier in the course that the beat frequency is |f1 − f2|.',
    'The last time the pendulum passes the centre, it is slowest.',
    'The previous frame of the animation shows the source further left.',
    'In the previous part we derived the formula.',
]) {
    check(`does not fire: "${good}"`, staleRecallFaults(good).length === 0, staleRecallFaults(good)[0]);
}
const fakeNode = topic['5.3'];
check('it is a lesson DEFECT, so the writer is sent back with the reason',
    lessonDefects(lessonBody('In the previous lesson we met beats.'), fakeNode).some(d => /as if the learner had just studied the previous topic/.test(d)));
check('…and words inside a visual spec are not read as the lesson\'s own',
    !lessonDefects(lessonBody('Fine.') + '\n\n```mermaid\ngraph TD\n  A["last time we met"] --> B\n```\n', fakeNode)
        .some(d => /previous topic/.test(d)));

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch { /* best effort */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows file locks */ }
process.exit(fail ? 1 : 0);
