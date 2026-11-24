/**
 * The benchmark's case sets. `standard` (cases/) is the everyday work the app
 * gives a model; `hard` (cases-hard/) is the same kind of work on material
 * where a model has to be right, not merely well formed, built to spread
 * models apart. Every tool takes `--suite <name>` (default standard) and the
 * worker reads BENCH_SUITE.
 */
const SUITES = { standard: 'cases', hard: 'cases-hard' };

export const suiteNames = () => Object.keys(SUITES);

export function suiteName(value) {
    const name = value || 'standard';
    if (!Object.hasOwn(SUITES, name)) throw new Error(`unknown suite "${name}" (known: ${suiteNames().join(', ')})`);
    return name;
}

/** The suite's index module: { loadFamilies, loadCases }. */
export const loadSuite = (value) => import(`./${SUITES[suiteName(value)]}/index.mjs`);

/**
 * The loader both index files share. A family file exports
 * { category, label, setup?, cases }; see cases/index.mjs for the contract.
 */
export function familyLoader(baseUrl, names) {
    async function loadFamilies() {
        const out = [];
        for (const name of names) {
            // A family that fails to load fails the run: a silently missing one
            // would shrink the benchmark and still pass the scorer check.
            const mod = await import(new URL(`./${name}.mjs`, baseUrl).href);
            out.push({ name, ...mod.default });
        }
        return out;
    }

    /** The flat case list, each bound to its family's fixture. */
    async function loadCases(app) {
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
    return { loadFamilies, loadCases };
}
