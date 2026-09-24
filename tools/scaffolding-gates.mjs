#!/usr/bin/env node
/**
 * tools/scaffolding-gates.mjs — a question may be about the subject, never about
 * the app that is teaching it.
 *
 * Run:  node tools/scaffolding-gates.mjs
 *
 * `buildNodeContext` hands a question writer the topic's material and the app's
 * record of it — the project's name, the path of headings down to the node, the
 * node's status — in one undifferentiated block. Asked to write a question
 * "about the context", a model sometimes writes one about the record. Measured
 * on a real 2,337-question library on 2026-09-14, ten had:
 *
 *   "According to the schedule status, how many days behind is the project?"
 *       5 days | 7 days | 9 days | 12 days
 *   "Under which path is the 'Download Past Papers' task located?"
 *       01 — Study Phase | 00 — Setup, Logistics & Official Requirements | …
 *   "True or False: The Higher Physics project is currently on schedule."
 *
 * Every one of them was served, graded, and written into BKT as evidence about
 * physics or about English. Nobody can know these, and nobody can be taught them:
 * the answer changes when the learner reschedules.
 *
 * The `Schedule Status: … Days behind: N` line the first of those came from was
 * deleted from the context block in 955d905 — but deleting a fact is not a rule,
 * and the `Path:` and `Project:` lines are still there and still produced the
 * second one. Hence a gate.
 *
 * WHY THE CASES BELOW ARE HALF FALSE POSITIVES. Real subjects talk exactly this
 * way. Project management asks whether a job is behind schedule; a Linux course
 * asks under which path a binary lives; an exam-prep course legitimately teaches
 * calculator rules, passing grades and how a band score is computed. So a plan
 * word alone is never enough — the question must ALSO point at this particular
 * record, by the project's name, by one of this node's ancestor titles, or
 * deictically. Every "must not fire" case here is a real question from that same
 * library, and a looser rule reached for all of them.
 *
 * Deterministic: a scratch database, no model, no network.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'scaffolding-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const db = (await import('../server/database.js')).default;
const { scaffoldingFaults, questionDefects } = await import('../server/feedQuality.js');
const { AI_PROMPTS, buildNodeContext } = await import('../server/ai.js');

// ---- the fixture: the two courses the real questions came from --------------

const mkProject = (name) => db.prepare('INSERT INTO projects (name) VALUES (?)').run(name).lastInsertRowid;
const mkNode = (projectId, parentId, title) => db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, ?, ?, 0)',
).run(projectId, parentId, title).lastInsertRowid;

const physicsId = mkProject('Higher Physics — Entrance / Deficiency Exam');
const setup = mkNode(physicsId, null, '00 — Setup, Logistics & Official Requirements');
const papers = mkNode(physicsId, setup, 'Past Exam Papers Pipeline');
const download = mkNode(physicsId, papers, 'Download Past Papers, Marking Schemes and Errata');
const drills = mkNode(physicsId, mkNode(physicsId, setup, 'The Data Book: BINAS (Dutch & English Editions)'),
    'Data Table Speed Drills: Find 30 Key Quantities in Under 20 Seconds Each');
const waves = mkNode(physicsId, mkNode(physicsId, null, 'Domain B — Waves, Oscillations & Medical Imaging'),
    "Young's Double-Slit Experiment");

const ieltsId = mkProject('English Academic — Target Band 7.0+');
const listening = mkNode(ieltsId, null, 'Phase 1 — Listening (30 min + transfer time)');

// A course whose SUBJECT is the vocabulary this gate keys on. Nothing in it may
// ever trip: the rule has to survive the one domain that talks like the app.
const pmId = mkProject('Project Management Fundamentals');
const pmFloat = mkNode(pmId, mkNode(pmId, null, 'Critical Path Method'), 'Total Float and Free Float');

// A Linux course, for the other collision: "under which path" is a real
// question about a filesystem.
const linuxId = mkProject('Linux Cybersecurity Engineering');
const linuxFs = mkNode(linuxId, mkNode(linuxId, null, 'Filesystem Hierarchy'), 'System Binaries and $PATH');

const q = (question, options = null, extra = {}) => ({
    question,
    type: options ? 'multiple_choice' : 'true_false',
    options: options || undefined,
    correct_answer: options ? options[0] : 'True',
    explanation: 'Because of the reason given in the material.',
    ...extra,
});

const fires = (question, nodeId) => scaffoldingFaults(question, nodeId).length > 0;

// ---- must fire: every one of these was served to a learner -------------------

console.log('\n--- questions about the app, taken from the real library ---');

check('the schedule status cited as the source of truth',
    fires(q('According to the schedule status, how many days behind is the project?',
        ['5 days', '7 days', '9 days', '12 days']), download));

check('…and the same question with the two nouns swapped',
    fires(q('According to the project status, how many days behind is the schedule?',
        ['0 days', '5 days', '10 days', '15 days']), download));

check('the course named, and asked whether it is on schedule',
    fires(q("True or False: The project 'English Academic — Target Band 7.0+' is currently on schedule."), listening));

check('…the course named by its head alone ("the Higher Physics project")',
    fires(q('True or False: The Higher Physics project is currently on schedule.'), drills));

check('…the course referred to deictically, name spelled without its em dash',
    fires(q('True or False: The current project schedule for the English Academic Target Band 7.0+ is on track.'), listening));

check('where a topic sits in the tree, with an ancestor heading quoted',
    fires(q("True or False: The speed drills are part of the 'Setup, Logistics & Official Requirements' section of the path."), drills));

check('…and the same asked as a choice between the course\'s phase headings',
    fires(q("Under which path is the 'Download Past Papers' task located?",
        ['01 — Study Phase', '00 — Setup, Logistics & Official Requirements', '02 — Exam Execution', '03 — Review & Errata']), download));

check('the node\'s own status, which is bookkeeping and changes on its own',
    fires(q('What is the status of this topic in the course?',
        ['not started', 'in progress', 'completed', 'skipped']), waves));

// The vocabulary-free half: whatever words it used to ask, a question whose
// options are the curriculum's own headings is asking the learner to navigate.
check('options that are two of this course\'s own topic titles',
    fires(q('Which of the following comes first in this subject?',
        ["Young's Double-Slit Experiment", 'Past Exam Papers Pipeline', 'Beats', 'Resonance']), waves));

// ---- must NOT fire: all of these are real questions from the same library ----

console.log('\n--- questions about a subject that merely talks like the app ---');

check('project management asks about float on the critical path',
    !fires(q('A contractor reports the build is four days behind schedule, but the activity has six days of total float. True or False: the project completion date has slipped.'), pmFloat));

check('…and about a status report, which is that subject\'s own artefact',
    !fires(q('A project status report shows a planned completion date of June 15 and a forecast of June 10. True or False: the project is behind schedule.'), pmFloat));

check('a Linux course asks under which path a binary lives',
    !fires(q('Under which path does the Filesystem Hierarchy Standard place binaries needed for single-user mode?',
        ['/usr/bin', '/sbin', '/usr/local/bin', '/opt']), linuxFs));

check('an exam-prep course teaches the exam\'s own timing',
    !fires(q('What is the total time allocated for the English Academic Writing section (Task 1 and Task 2 combined)?',
        ['40 minutes', '60 minutes', '90 minutes', '120 minutes']), listening));

check('…and how its score is computed',
    !fires(q('How is the overall band score calculated from the four sections?',
        ['The sum of all sections divided by 4', 'The average of the 4 sections rounded to the nearest 0.5',
            'The highest score among the 4 sections', 'The average rounded down to a whole number']), listening));

check('…and how many times a recording is played',
    !fires(q('How many times is each recording played during the English Academic Listening test?',
        ['Once', 'Twice', 'Three times', 'Depending on the section']), listening));

check('a question that names the course but asks about its subject',
    !fires(q('Which of the following correctly lists the five domains covered in the Higher Physics exam?',
        ['A, B, C, D, E', 'A, B, C, D', 'I, II, III, IV, V', 'One through six']), waves));

check('milestone-based funding, in a startup history course',
    !fires(q('The founders are burning cash waiting on due diligence. Which structure best addresses this?',
        ['Negotiating a higher valuation', 'A revenue-sharing agreement',
            'Compressing evaluation and disbursement into one short cycle', 'Dividing the request into milestone-based tranches']), waves));

check('one option that happens to be a topic title is not navigation',
    !fires(q('Which phenomenon produces evenly spaced bright fringes on a distant screen?',
        ["Young's Double-Slit Experiment", 'Total internal reflection', 'Rayleigh scattering', 'The photoelectric effect']), waves));

check('a physics question with no plan vocabulary at all',
    !fires(q('A slit separation of $0.20\\ \\text{mm}$ gives fringes $3.0\\ \\text{mm}$ apart at $1.0\\ \\text{m}$. What is the wavelength?',
        ['600 nm', '450 nm', '750 nm', '300 nm']), waves));

// ---- it is a DEFECT, not a weakness -----------------------------------------

console.log('\n--- wired into the gate the generators already run ---');

const scaffolded = q('True or False: The Higher Physics project is currently on schedule.');

check('questionDefects refuses it once it knows the node',
    questionDefects(scaffolded, drills).some(d => /own schedule or place in the app/.test(d)));

// The three generator call sites pass a node; the repair tools and the format
// gates do not, and must keep working unchanged rather than crash on a null.
check('…and is unchanged for a caller with no node to check against',
    questionDefects(scaffolded).length === 0);

check('a sound question still passes with a node',
    questionDefects(q('Which phenomenon produces evenly spaced bright fringes?',
        ['Interference', 'Refraction', 'Absorption', 'Ionisation']), waves).length === 0);

check('a node id that no longer exists is not a crash',
    scaffoldingFaults(scaffolded, 999999).length === 0);

check('a malformed question is not a crash either',
    scaffoldingFaults({}, waves).length === 0);

// ---- the other half of the fix: the context block says which part is filing --

console.log('\n--- the context block and the prompts ---');

const context = buildNodeContext(download);
check('the Path line is labelled as the app\'s own filing',
    /Path \(the app's own filing[^)]*\):/.test(context), context.split('\n').find(l => l.startsWith('Path')) || '(no Path line)');

check('…and it still carries the path itself',
    context.includes('00 — Setup, Logistics & Official Requirements > Past Exam Papers Pipeline'));

// The schedule leak that started this. buildNodeContext must never hand a
// question writer the plan's state again — that is what the first six cases
// above are made of.
check('no schedule state reaches the authoring context',
    !/days behind|schedule status|on track/i.test(context), context.slice(0, 300));

const feedQuestion = AI_PROMPTS.feed_question('Young\'s Double-Slit Experiment', 'Part 1', 'lesson text', 'multiple_choice', {});
check('the feed question prompt forbids asking about the course',
    /NEVER ASK ABOUT THIS COURSE|ASK ABOUT THE SUBJECT, NEVER ABOUT THIS COURSE/i.test(feedQuestion.system));

const quizPrompt = AI_PROMPTS.quiz_generator('material', 5, 'multiple_choice', []);
check('…and so does the saved-quiz prompt, which wrote most of the library',
    /NEVER ASK ABOUT THE COURSE ITSELF/.test(quizPrompt.system));

const repairPrompt = AI_PROMPTS.quiz_question_repair('Topic', { question: 'x' }, 'a fault');
check('…and the repair prompt, so a rewrite cannot reintroduce one',
    /NEVER ASK ABOUT THE COURSE ITSELF/.test(repairPrompt.system));

// ---- report -----------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch { /* best effort */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows file locks */ }
process.exit(fail ? 1 : 0);
