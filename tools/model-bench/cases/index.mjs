/**
 * Every case family, in report order. A family file exports:
 *
 *   export default {
 *     category: 'grading',                 // slug, one per family
 *     label: 'Grading typed answers',      // the report's name for it
 *     async setup(app) { return fx },      // optional: fixture rows, once per library
 *     cases: [{
 *       id, vision?,                       // vision: needs a model that reads images
 *       run(fx, app),                      // calls the app's own code; returns its output
 *       score(output, fx, app),            // -> { pass, why }, deterministic
 *       golden,                            // a reply a sound model could give (string, or
 *                                          // one string per model request in order)
 *       variants?: [{ name, reply }],      // other sound replies the scorer must also pass
 *       mutants: [{ name, reply }],        // hand-broken replies the scorer must fail
 *     }],
 *   }
 *
 * `golden`, `variants` and `mutants` are only read by mutate.mjs, which serves them in
 * place of the model to prove each scorer passes a good answer and fails
 * broken ones.
 */
import { familyLoader } from '../suites.mjs';

const FAMILIES = [
    'verify', 'grading', 'explainBack', 'paper', 'quiz', 'flashcards', 'lessons', 'audit',
    'outline', 'identity', 'searchWords', 'regions', 'chat', 'assistant', 'visuals', 'vision',
];

export const { loadFamilies, loadCases } = familyLoader(import.meta.url, FAMILIES);
