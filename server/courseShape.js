// server/courseShape.js — what a new course becomes: a SHORT course (one level
// of a few topics, written in one call by server/shortCourses.js) or a course
// IN PHASES (phases, sections, topics; how many of each is then the phase
// plan's call, server/courseSize.js).
//
// The learner never picks. The New course window has one Create form, and its
// material takes any mix of files and links; one short model call judges the
// shape from the name, the goal and a summary of that material (what each
// source is, how long, its top-level contents), before anything else is
// asked. A learner may say it outright ("a quick intro", "everything for my
// exam"), and a single short video with a plain goal is a short course.
//
// The bounds the model cannot move are here, in code:
//   - material longer than one short course holds (SHORT.maxWords) is always
//     a course in phases, and the model is not asked;
//   - a reply that names neither shape, a refusal or a failed call keeps the
//     course in phases, which is what this window always made.
// There is no floor: SHORT.minWords is the assistant's door, where a source IS
// the course. Here a name alone may be a short course, written from what the
// subject needs, so a 40-word note beside a goal is context, not too little.
//
// A short course is written in one call that names it and says what it is for,
// so it takes no identity call (server/projectIdentity.js) of its own: a typed
// name is kept, as the short courses' own door always kept it, and the goal is
// its description. One is made only to settle a language that is open
// (routes/createProject.js `settleIdentity`).

import { generateResponse } from './ai.js';
import { promptTitle } from './citations.js';
import { shapeBlock } from './sourceMaterial.js';
import { SHORT } from './shortCourses.js';

export const COURSE_SHAPES = Object.freeze(['short', 'phased']);

/** The shape the bounds alone decide, or null when the model is to judge. */
export function shapeByBounds({ words = 0 } = {}) {
    return words > SHORT.maxWords ? 'phased' : null;
}

/** The shape a reply names, or null: `{"shape": "short"}`, in a fence or not. */
export function readShapeReply(raw) {
    const text = String(raw ?? '');
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (json) {
        try {
            const shape = String(JSON.parse(json)?.shape ?? '').trim().toLowerCase();
            return COURSE_SHAPES.includes(shape) ? shape : null;
        } catch { /* not JSON: read as words below */ }
    }
    // A model that answers with the word alone.
    const word = text.trim().toLowerCase().replace(/^["'`]+|["'`.!]+$/g, '');
    return COURSE_SHAPES.includes(word) ? word : null;
}

const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The prompt pair for the shape call. `block` is `shapeBlock(src, words)`. */
export function coursePrompt({ name = '', goal = '', block = '', words = 0 } = {}) {
    return {
        system: `You decide what shape a new course takes, before any of it is written. There are two:
- "short": ONE level of ${SHORT.minTopics} to ${SHORT.maxTopics} topics and no phases, learned in one to a few sittings. Right for what one video, one article, one chapter or one small document teaches, and for one small practical skill.
- "phased": phases, then sections, then topics, studied over weeks. Right for a whole subject, a book, an exam, a language level or a qualification, and for material too broad for a few sittings.
Judge from the NAME, the GOAL and the MATERIAL. When the learner says how big they want it ("a quick intro", "in an afternoon", "everything for my exam", "the whole book"), that decides. With no material, judge by how much the subject itself needs. When unsure, choose "phased".
CRITICAL: Output ONLY a JSON object: {"shape": "short"} or {"shape": "phased"}`,
        user: `NAME: ${oneLine(name, 300) ? promptTitle(oneLine(name, 300)) : '(none given)'}
GOAL: ${oneLine(goal, 600) ? promptTitle(oneLine(goal, 600)) : '(none given)'}
MATERIAL: ${block ? `${words} words in all.${block}` : 'none'}`,
    };
}

/**
 * Short or phased, for a creation about to start. `src` and `words` describe
 * the learner's material (sourceMaterial.js creationSources, a word count per
 * source). Never throws for the model's sake: a failed call is a course in
 * phases. A cancel still throws (the run stops), and so does a final refusal
 * (aiJobs.js fallsOver): the phases would meet it call by call.
 *
 * Returns `{ shape, by }`: `by` is 'bounds', 'model' or 'fallback'.
 */
export async function decideCourseShape({ name = '', goal = '', src = null, words = [], signal, generate = generateResponse } = {}) {
    const total = words.reduce((n, w) => n + (Number(w) || 0), 0);
    const bound = shapeByBounds({ words: total });
    if (bound) return { shape: bound, by: 'bounds', words: total };
    const { system, user } = coursePrompt({ name, goal, block: shapeBlock(src, words), words: total });
    try {
        const raw = await generate(user, system, [], {
            signal, temperature: 0.1, top_p: 0.8, operation: 'course_shape', job: 'courses', timeout: 60_000,
        });
        const shape = readShapeReply(raw);
        return shape ? { shape, by: 'model', words: total } : { shape: 'phased', by: 'fallback', words: total };
    } catch (err) {
        if (signal?.aborted || err?.final === true) throw err;
        console.log(`[AI] Course shape call failed, building in phases: ${String(err?.message || err).slice(0, 120)}`);
        return { shape: 'phased', by: 'fallback', words: total };
    }
}
