/**
 * Post-render numeric sanity validation for Vega(-Lite) charts — the
 * "validate" step of sanitize → parse → compute → validate.
 *
 * The sanitizer (sanitizeVega.ts) is purely syntactic; it cannot see that a
 * chart is numerically broken. Under the "function, not values" contract
 * (VISUALS_GUIDE) the data is *computed* at render time by Vega's expression
 * engine, and the two silent failure modes are:
 *   - a `calculate` referencing a field that doesn't exist (`datum.v0y` never
 *     produced, sequence missing `as`) → NaN in every row → blank chart,
 *     no error thrown anywhere;
 *   - a degenerate data definition (sequence start ≥ stop, a filter dropping
 *     everything) → zero rows → blank chart, no error.
 * Both must throw a *descriptive* error here so the repair loop (D-018: the
 * error text becomes the repair prompt) gets semantic teeth.
 *
 * Deliberately NO physics/monotonicity assertions: without domain knowledge
 * they false-positive (cos is only monotonic on [0°, 90°]), and a validator
 * that rejects correct charts erodes trust in the repair loop. Formula-level
 * wrongness (sin-for-cos, degrees-vs-radians) stays the model's residual
 * responsibility; this catches the mechanically detectable failures.
 */

/** Structural subset of vega's View that validation needs (avoids a direct dependency on vega's types — it's a transitive dep via vega-embed). */
export interface VegaViewLike {
    getState(options: {
        data: (name: string) => boolean;
        signals: (name: string) => boolean;
    }): { data?: Record<string, unknown> };
    data(name: string): unknown[];
}

// Vega-Lite names user-data flows source_N / data_N. Everything else in the
// state (root, marks, …) is scenegraph plumbing — circular and irrelevant.
const USER_DATASET_RE = /^(source|data)_\d+$/;

export function validateVegaView(view: VegaViewLike): void {
    let names: string[];
    try {
        const state = view.getState({ data: () => true, signals: () => false });
        names = Object.keys(state.data ?? {}).filter((n) => USER_DATASET_RE.test(n));
    } catch {
        return; // introspection failure is not a chart failure
    }
    if (names.length === 0) return; // e.g. pure geo/graticule specs — nothing to assert

    let sawRows = false;
    for (const name of names) {
        let rows: unknown[];
        try {
            rows = view.data(name);
        } catch {
            continue;
        }
        if (!Array.isArray(rows) || rows.length === 0) continue;
        sawRows = true;
        for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            for (const [field, value] of Object.entries(row)) {
                if (typeof value === 'number' && !Number.isFinite(value)) {
                    throw new Error(
                        `the chart computed ${Number.isNaN(value) ? 'NaN' : 'Infinity'} for field "${field}" — ` +
                        'a "calculate" expression references a field that does not exist ' +
                        '(check every "datum.NAME" against the sequence "as" and transform "as" outputs) or divides by zero.',
                    );
                }
            }
        }
    }
    if (!sawRows) {
        throw new Error(
            'the chart computed zero data rows — check the "data" definition ' +
            '(a "sequence" needs start < stop and a positive step; a "filter" must not remove every row).',
        );
    }
}
