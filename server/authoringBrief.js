// server/authoringBrief.js — the two prompts a learner pastes into a cloud model,
// and the one place they live.
//
// WHY THIS IS TWO PROMPTS AND NOT ONE. Measured over 25 externally-generated
// course files (six months, every major model): total output
// per file sits in a narrow band of 1.3k–12.3k words no matter who wrote it,
// while words-per-leaf falls monotonically as the tree grows — 827 at 14 leaves,
// 53 at 80, 28 at 394, 2 at 991. It is one conserved budget being divided, and
// the schema makes titles the cheapest thing to spend it on. Not one of those
// files contains a single material node at the 600-word target the old single
// prompt asked for; only 21% of the 118,723 words written landed in material at
// all, which is the only part the app teaches from.
//
// So the ask is split at the place the budget actually breaks. Pass one writes
// the tree, the Overviews and the verified links — the part models already
// finish successfully (4,992 real URLs across 694 hosts in those same files) —
// and is FORBIDDEN to write material, because a model offered the choice always
// takes the cheap half. Pass two is handed one phase's leaf titles and spends a
// whole reply on a dozen lessons. Trip count is the learner's: outline alone is
// a usable course skeleton, and any phase can be deepened later, in any order,
// including on a project the local pipeline generated.
//
// There is deliberately no third "small course, do both at once" prompt. Every
// model judges its own course small enough to qualify, which is precisely the
// failure being designed out.
//
// The prompt TEXT lives in `briefs/*.md` beside this file rather than in a
// template literal, for the reason docs/ARCHITECTURE.md gives about SQL: the briefs are
// full of backticks and fenced JSON, and escaping several hundred of them into
// a template literal is a silent-corruption hazard with no upside. They are read
// once at import and served from `POST /api/authoring/outline-brief` and
// `GET /api/projects/:projectId/authoring/material-brief` — one copy, which
// the UI renders, the learner copies, and `tools/import-gates.mjs` parses. The
// hand-maintained `PromptToGenerateProjectJSON.md` that used to duplicate the
// importer's field tables is gone; that file drifting from the validator is the
// exact failure the parity gate was written to catch, and one source removes it.

import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`./briefs/${name}`, import.meta.url), 'utf8');

export const OUTLINE_BRIEF = read('outline.md');
export const MATERIAL_BRIEF = read('material.md');

/** Cap on how much learner-supplied text is interpolated into a brief. */
const FIELD_MAX = 600;

const clean = (value, max = FIELD_MAX) =>
    String(value == null ? '' : value).replace(/\r/g, '').trim().slice(0, max);

/**
 * Fill the BRIEF block at the end of the outline prompt.
 *
 * Every field is optional: an unanswered line is rendered as an explicit
 * "not specified" rather than dropped, because a model handed a brief with a
 * missing heading invents a plausible answer for it, while one told the learner
 * did not say asks or picks a documented default.
 */
export function buildOutlineBrief(fields = {}) {
    const rows = [
        ['Subject', clean(fields.subject), 'not specified — ask before writing'],
        ['Learner’s current level', clean(fields.level), 'not specified — assume no prior knowledge of the subject and say so in the project description'],
        ['Goal', clean(fields.goal), 'not specified — write a general-purpose course'],
        ['Depth', clean(fields.depth), 'a semester course'],
        ['Language', clean(fields.language), 'English'],
    ];
    const block = rows
        .map(([label, value, fallback]) => `- **${label}:** ${value || `*(${fallback})*`}`)
        .join('\n');
    return OUTLINE_BRIEF.replace('{{BRIEF}}', block);
}

/**
 * Fill the material prompt for ONE phase.
 *
 * `leaves` are the exact titles as stored, and they are numbered in the prompt
 * only for the learner's benefit — the brief tells the model to echo the title,
 * and `matchMaterialToLeaves` strips any numbering the model adds back anyway.
 */
export function buildMaterialBrief({ project = {}, phaseTitle = '', leaves = [] } = {}) {
    const languageLine = project.content_language
        ? `The course language is **${clean(project.content_language, 20)}** — write everything in it.`
        : 'The course does not declare a language; write in the language of the titles below.';

    const context = [
        `- **Course:** ${clean(project.name) || 'untitled'}`,
        project.description ? `- **What it covers:** ${clean(project.description, 1200)}` : null,
        phaseTitle ? `- **Phase you are writing for:** ${clean(phaseTitle)}` : null,
        `- **Language:** ${languageLine}`,
    ].filter(Boolean).join('\n');

    const list = leaves.length
        ? leaves.map((title, i) => `${i + 1}. ${clean(title, 500)}`).join('\n')
        : '*(no topics were supplied — stop and say so rather than inventing any)*';

    return MATERIAL_BRIEF
        .replace('{{CONTEXT}}', context)
        .replace('{{LEAVES}}', list);
}
