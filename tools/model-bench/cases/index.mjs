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
 *       mutants: [{ name, reply }],        // hand-broken replies the scorer must fail
 *     }],
 *   }
 *
 * `golden` and `mutants` are only read by mutate.mjs, which serves them in
 * place of the model to prove each scorer passes a good answer and fails
 * broken ones.
 */
const FAMILIES = [
    'verify', 'grading', 'explainBack', 'paper', 'quiz', 'flashcards', 'lessons', 'audit',
    'outline', 'identity', 'searchWords', 'regions', 'chat', 'assistant', 'visuals', 'vision',
];

export async function loadFamilies() {
    const out = [];
    for (const name of FAMILIES) {
        // A family that fails to load fails the run: a silently missing one
        // would shrink the benchmark and still pass the scorer check.
        const mod = await import(`./${name}.mjs`);
        out.push({ name, ...mod.default });
    }
    return out;
}

/** The flat case list, each bound to its family's fixture. */
export async function loadCases(app) {
    const ids = new Set();
    const cases = [];
    for (const f of await loadFamilies()) {
        const fx = f.setup ? await f.setup(app) : {};
        for (const c of f.cases) {
            if (ids.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
            ids.add(c.id);
            cases.push({
                ...c, category: f.category, label: f.label,
                run: (a) => c.run(fx, a),
                score: (out, a) => c.score(out, fx, a),
            });
        }
    }
    return cases;
}
