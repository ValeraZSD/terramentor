/**
 * function-plot's draw function, from whichever shape the bundler hands back.
 *
 * function-plot ships CommonJS with `exports.default = functionPlot`. A
 * bundler's interop may give `import()` either `{ default: functionPlot }` or
 * `{ default: exports }`, where `exports.default` is the function. v1.3.0 shipped
 * the second shape in its production build and the dev server gives it too, so
 * `default` was an object, every function graph threw "is not a function", and
 * lessons and the Settings sample drew nothing (found 2026-11-01).
 */
export function functionPlotFrom<F extends (...args: never[]) => unknown>(mod: { default: unknown }): F {
    const d = mod.default as unknown;
    if (typeof d === 'function') return d as F;
    const inner = d && typeof d === 'object' ? (d as { default?: unknown }).default : undefined;
    if (typeof inner === 'function') return inner as F;
    throw new Error('function-plot did not load: its module has no draw function.');
}
