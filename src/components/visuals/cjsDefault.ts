/**
 * The function a CommonJS package exports as `default`, whichever way the
 * bundler wrapped it.
 *
 * function-plot ships only CommonJS (`exports.default = functionPlot`, flagged
 * `__esModule`). Vite's dev server hands that over as `{ default: fn }`, but
 * the production build (Vite 8, Rolldown) wraps it the way Node does, where
 * `default` is the WHOLE `module.exports`: `{ default: { default: fn, … } }`.
 * Destructuring `default` therefore got an object in every built app, and
 * every graph failed with "u is not a function" while dev looked fine.
 */
export function cjsDefault<T>(mod: unknown, name: string): T {
    const outer = (mod as { default?: unknown } | null)?.default;
    if (typeof outer === 'function') return outer as T;
    const inner = (outer as { default?: unknown } | null)?.default;
    if (typeof inner === 'function') return inner as T;
    throw new Error(`${name} did not load: it has no default export to call.`);
}
