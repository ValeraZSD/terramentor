/**
 * function-plot's draw function and its expression evaluator, from whichever
 * shape the bundler hands back.
 *
 * function-plot ships CommonJS with `exports.default = functionPlot` beside
 * named exports such as `EvalBuiltIn`. A bundler's interop may give `import()`
 * `{ default: functionPlot, EvalBuiltIn }`, or `{ default: exports }` where both
 * live on `exports`, or the second with the named exports copied up beside it.
 * v1.3.0 shipped the second shape in its production build, so `default` was an
 * object, every function graph threw "is not a function", and lessons and the
 * Settings sample drew nothing.
 *
 * Both parts are read from the SAME namespace, the one holding the draw
 * function. Reading the evaluator off the outer object instead works only while
 * a bundler copies the named exports up; without it the evaluator is
 * undefined, the y range fit gives up silently, and the graph draws in
 * function-plot's default window, often missing the curves.
 */
export function functionPlotParts<F extends (...args: never[]) => unknown, E extends (...args: never[]) => unknown>(
    mod: { default?: unknown },
): { functionPlot: F; EvalBuiltIn: E } {
    const outer = mod as Record<string, unknown>;
    const d = outer.default;
    const inner = d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
    const ns = typeof d === 'function' ? outer : inner && typeof inner.default === 'function' ? inner : null;
    if (!ns) throw new Error('function-plot did not load: its module has no draw function.');
    const evaluator = ns.EvalBuiltIn ?? outer.EvalBuiltIn;
    if (typeof evaluator !== 'function') throw new Error('function-plot did not load: its module has no evaluator.');
    return { functionPlot: ns.default as F, EvalBuiltIn: evaluator as E };
}
