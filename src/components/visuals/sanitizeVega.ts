/**
 * Deterministic Vega-Lite normalizer.
 *
 * A local model's Vega-Lite is usually valid JSON but structurally invalid: it
 * invents top-level properties that are really encoding channels (`color`,
 * `scale`, `axis` at the root) and emits malformed `transform` entries (mixing
 * `filter` + `aggregate` in one object, aggregates with no field). Vega-Lite's
 * compiler doesn't reject these cleanly — it throws an opaque
 * `Cannot read properties of undefined (reading 'length')` deep inside compile,
 * which is useless to the user and to the repair LLM.
 *
 * So, mirroring sanitizeMermaid, we mechanically strip the common breakers
 * before embedding: keep only real top-level keys (drop misplaced channel/scale
 * props) and drop malformed transform entries. What survives renders; fidelity
 * (a dropped colour scheme) is sacrificed for a chart that actually shows.
 */

// Valid Vega-Lite top-level keys (unit + layer/concat/facet container specs).
// Anything else at the root — color, scale, axis, legend, sort, x, y, … — is an
// encoding-level concept the model misplaced, so we drop it.
const VALID_TOP_LEVEL = new Set([
    '$schema', 'data', 'datasets', 'transform', 'mark', 'encoding',
    'width', 'height', 'title', 'name', 'description', 'background',
    'padding', 'autosize', 'config', 'params', 'projection', 'view',
    'resolve', 'bounds', 'spacing', 'center', 'align', 'columns',
    'layer', 'facet', 'repeat', 'concat', 'hconcat', 'vconcat', 'spec',
    'usermeta', 'meta', 'encode',
]);

// A transform object carries exactly one of these "operation" keys; everything
// else on it (groupby, as, from, frame, …) is a companion of that operation.
// Note: `sequence` is NOT here — Vega-Lite has a sequence *data generator*
// (data:{sequence:{…}}), not a sequence transform (that's full Vega). Models
// confuse the two; normalizeVegaLite migrates it into `data` instead.
const TRANSFORM_OPS = new Set([
    'filter', 'calculate', 'aggregate', 'bin', 'timeUnit', 'lookup',
    'fold', 'pivot', 'flatten', 'sample', 'stack', 'window',
    'joinaggregate', 'density', 'regression', 'loess', 'quantile',
    'impute', 'extent',
]);

// --- Vega expression cleanup -------------------------------------------------
// The "function, not values" contract (see VISUALS_GUIDE) makes `calculate`
// expressions the load-bearing part of a chart spec: the model transcribes a
// formula and Vega's expression engine computes the data, so the model never
// hand-computes a number. But Vega's expression language is a JS *subset* —
// no `Math.` namespace, no `**` operator — and local models write JS out of
// habit. Both are mechanically fixable.

// Simple operand: identifier chain (datum.angle), number, or one paren group.
const POW_OPERAND = String.raw`[A-Za-z_$][\w$.]*|\d+(?:\.\d+)?|\([^()]*\)`;
const POW_RE = new RegExp(String.raw`(${POW_OPERAND})\s*\*\*\s*(${POW_OPERAND})`);

export function sanitizeVegaExpression(expr: string): string {
    let out = expr
        .replace(/\bMath\.\s*/g, '') // Math.cos → cos, Math.PI → PI
        .replace(/π/g, 'PI');
    // a ** b → pow(a,b). Left-to-right (wrong for chained right-assoc `**`,
    // but models write simple squares; anything weirder still throws → repair).
    for (let guard = 0; guard < 10 && POW_RE.test(out); guard++) {
        out = out.replace(POW_RE, 'pow($1,$2)');
    }
    return out;
}

function sanitizeTransformExpressions(t: Record<string, unknown>): Record<string, unknown> {
    const out = { ...t };
    if (typeof out.calculate === 'string') out.calculate = sanitizeVegaExpression(out.calculate);
    if (typeof out.filter === 'string') out.filter = sanitizeVegaExpression(out.filter);
    return out;
}

function hasRealData(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.values)) return d.values.length > 0;
    return 'url' in d || 'sequence' in d || 'name' in d || 'graticule' in d || 'sphere' in d;
}

/**
 * If a sequence generator has no "as", the field silently defaults to "data"
 * and every `datum.x` reference in the calculates comes back undefined (NaN
 * rows, blank chart). When exactly one datum field is referenced but never
 * produced by a transform, that must be the sequence's intended field name.
 */
function inferSequenceAs(spec: Record<string, unknown>): void {
    const data = spec.data as Record<string, unknown> | undefined;
    const seq = data?.sequence as Record<string, unknown> | undefined;
    if (!seq || typeof seq !== 'object' || typeof seq.as === 'string') return;
    if (!Array.isArray(spec.transform)) return;

    const produced = new Set<string>();
    const referenced = new Set<string>();
    for (const t of spec.transform) {
        if (!t || typeof t !== 'object') continue;
        const entry = t as Record<string, unknown>;
        if (typeof entry.as === 'string') produced.add(entry.as);
        for (const key of ['calculate', 'filter']) {
            const expr = entry[key];
            if (typeof expr !== 'string') continue;
            for (const m of expr.matchAll(/\bdatum\.([A-Za-z_$][\w$]*)/g)) referenced.add(m[1]);
        }
    }
    const unproduced = [...referenced].filter((f) => !produced.has(f));
    if (unproduced.length === 1) seq.as = unproduced[0];
}

// --- Encoding-channel repair ------------------------------------------------
// A channel definition is "bound to data" iff it carries one of these. A def
// with only scale/axis/title/type maps nothing → the mark draws at a constant
// (or Vega-Lite throws an opaque error): the empty-`y` hollow-chart bug.
const CHANNEL_DATA_KEYS = ['field', 'value', 'datum', 'aggregate', 'condition'];

function encodingChannels(spec: Record<string, unknown>): [string, Record<string, unknown>][] {
    const enc = spec.encoding;
    if (!enc || typeof enc !== 'object' || Array.isArray(enc)) return [];
    return Object.entries(enc).filter(
        ([, d]) => d && typeof d === 'object' && !Array.isArray(d),
    ) as [string, Record<string, unknown>][];
}

function isEmptyChannelDef(def: Record<string, unknown>): boolean {
    return !CHANNEL_DATA_KEYS.some((k) => k in def);
}

/** Field names produced by transforms (calculate/aggregate/window/joinaggregate `as`). */
function producedFields(spec: Record<string, unknown>): Set<string> {
    const out = new Set<string>();
    if (!Array.isArray(spec.transform)) return out;
    for (const t of spec.transform) {
        if (!t || typeof t !== 'object') continue;
        const e = t as Record<string, unknown>;
        if (typeof e.as === 'string') out.add(e.as);
        for (const opKey of ['aggregate', 'window', 'joinaggregate']) {
            const arr = e[opKey];
            if (!Array.isArray(arr)) continue;
            for (const a of arr) {
                if (a && typeof a === 'object' && typeof (a as Record<string, unknown>).as === 'string') {
                    out.add((a as Record<string, unknown>).as as string);
                }
            }
        }
    }
    return out;
}

/** Field names actually placed on a visual channel via `field` (encoding + conditionals). */
function referencedFields(spec: Record<string, unknown>): Set<string> {
    const out = new Set<string>();
    for (const [, def] of encodingChannels(spec)) {
        if (typeof def.field === 'string') out.add(def.field);
        const cond = def.condition;
        const conds = Array.isArray(cond) ? cond : cond ? [cond] : [];
        for (const c of conds) {
            if (c && typeof c === 'object' && typeof (c as Record<string, unknown>).field === 'string') {
                out.add((c as Record<string, unknown>).field as string);
            }
        }
    }
    return out;
}

/**
 * Wire a computed field the model forgot to encode onto the empty channel it
 * left behind. The observed bug: a `calculate` produces `abs_uncertainty`, the
 * narration promises bar *heights*, but `y` is `{scale, axis:null}` with no
 * `field` — so the number drives nothing and the chart renders hollow (finite
 * rows, so validateVega can't see it). When there is EXACTLY one empty channel
 * and EXACTLY one produced-but-unplaced field, the intent is unambiguous: bind
 * them. Any other multiplicity stays for `findEmptyEncodingChannel` to reject
 * into the repair loop rather than guess.
 */
function bindOrphanComputedField(spec: Record<string, unknown>): void {
    const empties = encodingChannels(spec).filter(([, d]) => isEmptyChannelDef(d));
    if (empties.length !== 1) return;
    const produced = producedFields(spec);
    const referenced = referencedFields(spec);
    const orphans = [...produced].filter((f) => !referenced.has(f));
    if (orphans.length !== 1) return;
    const def = empties[0][1];
    def.field = orphans[0];
    if (typeof def.type !== 'string') def.type = 'quantitative';
}

// Vega renders no KaTeX: `$\Delta x$` in a title/axis label shows literal `$…$`
// characters (the same failure the p5 guide bans in text()). Strip the delimiters
// from matched `$…$` pairs, leaving the inner text.
function stripInlineLatex(s: string): string {
    return s.replace(/\$([^$]+)\$/g, '$1');
}

function stripTitleLatex(title: unknown): unknown {
    if (typeof title === 'string') return stripInlineLatex(title);
    if (title && typeof title === 'object' && !Array.isArray(title)) {
        const t = title as Record<string, unknown>;
        if (typeof t.text === 'string') return { ...t, text: stripInlineLatex(t.text) };
    }
    return title;
}

/**
 * Per-channel cleanup: (1) a conditional encoding's default is the key `value`,
 * not `other` — models invent `other`, which Vega ignores, silently dropping the
 * default colour; migrate it. (2) strip literal `$LaTeX$` from channel/axis/legend
 * titles.
 */
function sanitizeEncoding(spec: Record<string, unknown>): void {
    for (const [channel, def] of encodingChannels(spec)) {
        if ('condition' in def && 'other' in def && !('value' in def)
            && !('field' in def) && !('datum' in def)) {
            def.value = def.other;
            delete def.other;
        }
        // (3) A category axis keeps the DATA's order. Vega-Lite sorts a
        // nominal/ordinal axis alphabetically unless told otherwise, so the
        // tokens of "I saw the cat ." came out as ". I cat saw the" — the one
        // order that means nothing. What the author wrote the rows in is the
        // order they meant; a model that wants a sort still says `sort`.
        if ((channel === 'x' || channel === 'y') && (def.type === 'nominal' || def.type === 'ordinal')
            && typeof def.field === 'string' && !('sort' in def) && !('bin' in def) && !('timeUnit' in def)) {
            def.sort = null;
        }
        if ('title' in def) def.title = stripTitleLatex(def.title);
        for (const guideKey of ['axis', 'legend']) {
            const g = def[guideKey];
            if (g && typeof g === 'object' && !Array.isArray(g) && 'title' in (g as object)) {
                (g as Record<string, unknown>).title = stripTitleLatex((g as Record<string, unknown>).title);
            }
        }
    }
}

/** First encoding channel still bound to nothing after repair, or null. */
export function findEmptyEncodingChannel(spec: Record<string, unknown>): string | null {
    for (const [name, def] of encodingChannels(spec)) {
        if (isEmptyChannelDef(def)) return name;
    }
    return null;
}

/**
 * The fields Vega will actually put on each rendered row — the base data schema
 * plus every field a transform *adds*. Only computable when the schema is fully
 * known and every transform is purely additive/row-reducing: a `sequence` or
 * inline `values` base, with at most `calculate` (adds `as`) / `filter` (drops
 * rows, keeps columns) transforms. A `url`/named/geo source (unknown columns) or
 * any reshaping transform (aggregate/fold/pivot/flatten/bin/lookup/window/… that
 * renames or hides fields) returns null, so the caller skips the check rather
 * than risk a false positive — the cardinal sin of this pipeline.
 */
function availableFields(spec: Record<string, unknown>): Set<string> | null {
    const data = spec.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== 'object') return null;

    const fields = new Set<string>();
    if (data.sequence && typeof data.sequence === 'object') {
        // A sequence with no explicit `as` outputs the field literally named "data".
        const seq = data.sequence as Record<string, unknown>;
        fields.add(typeof seq.as === 'string' ? seq.as : 'data');
    } else if (Array.isArray(data.values)) {
        if (data.values.length === 0) return null; // empty inline data — a different failure
        for (const row of data.values) {
            if (row && typeof row === 'object' && !Array.isArray(row)) {
                for (const k of Object.keys(row as object)) fields.add(k);
            }
        }
    } else {
        return null; // url / named / graticule / sphere — columns unknowable here
    }

    if (Array.isArray(spec.transform)) {
        for (const t of spec.transform) {
            if (!t || typeof t !== 'object') continue;
            const e = t as Record<string, unknown>;
            const op = Object.keys(e).find((k) => TRANSFORM_OPS.has(k));
            if (op === 'calculate') {
                if (typeof e.as === 'string') fields.add(e.as);
            } else if (op === 'filter') {
                // row-reducing, column-preserving — adds nothing, hides nothing.
            } else {
                return null; // any reshaping/schema-opaque transform → can't be sure
            }
        }
    }
    return fields;
}

/**
 * A `field` placed on an encoding channel that the data will never contain: Vega
 * silently drops the invalid rows, so the chart renders blank with no error
 * anywhere (the phantom-field bug). When the full field universe is knowable
 * (see availableFields), return the first such field alongside what IS available,
 * so the repair prompt can name the exact fix. Null when unknowable or clean.
 */
export function findUnboundEncodingField(
    spec: Record<string, unknown>,
): { field: string; available: string[] } | null {
    const available = availableFields(spec);
    if (!available) return null;
    for (const field of referencedFields(spec)) {
        if (!available.has(field)) return { field, available: [...available] };
    }
    return null;
}

function isValidTransform(t: unknown): boolean {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
    const ops = Object.keys(t).filter((k) => TRANSFORM_OPS.has(k));
    if (ops.length !== 1) return false; // must be exactly one operation type
    if (ops[0] === 'aggregate') {
        const agg = (t as Record<string, unknown>).aggregate;
        return Array.isArray(agg) && agg.every(
            (a) => a && typeof a === 'object' && typeof (a as Record<string, unknown>).op === 'string',
        );
    }
    return true;
}


/**
 * Vega's expression language has no bare field references — a name that is not
 * a function or a constant is looked up as a SIGNAL, and a chart of a formula
 * therefore dies with `Unrecognized signal name: "vs"` while looking, to the
 * model that wrote it, exactly like the documented form.
 *
 * Live example, from a Doppler lesson:
 *   "data":{"sequence":{"start":-300,"stop":300,"step":10,"as":"vs"}},
 *   "transform":[{"calculate":"440*(343/(343-vs))","as":"f_obs"}]
 * The field is declared one line above the expression that uses it, so this is
 * not an ambiguity — it is a missing `datum.` prefix, and the app knows every
 * field name the data will carry.
 *
 * Deliberately narrow: only a name the spec ITSELF declares as a field is
 * touched (a sequence `as`, a key of inline `values`, a transform `as`). A
 * function call, a name inside a string, and anything already reached through a
 * dot are all left exactly as written — this may only ever bind a reference the
 * data can satisfy, never invent one.
 */
function declaredFieldNames(spec: Record<string, unknown>): Set<string> {
    const fields = new Set<string>();
    const data = spec.data as Record<string, unknown> | undefined;
    if (data && typeof data === 'object') {
        const seq = data.sequence as Record<string, unknown> | undefined;
        if (seq && typeof seq === 'object' && typeof seq.as === 'string') fields.add(seq.as);
        if (Array.isArray(data.values)) {
            for (const row of data.values) {
                if (row && typeof row === 'object' && !Array.isArray(row)) {
                    for (const k of Object.keys(row as object)) fields.add(k);
                }
            }
        }
    }
    if (Array.isArray(spec.transform)) {
        for (const t of spec.transform) {
            if (t && typeof t === 'object' && typeof (t as Record<string, unknown>).as === 'string') {
                fields.add((t as Record<string, unknown>).as as string);
            }
        }
    }
    // `datum` is never a field, and a spec that declares one has bigger problems.
    fields.delete('datum');
    return fields;
}

/** Quoted string | identifier, optionally followed by a call paren. */
const IDENT_SCAN = /'[^']*'|"[^"]*"|\b([A-Za-z_$][\w$]*)\b(\s*\()?/g;

export function qualifyDatumFields(expr: string, fields: ReadonlySet<string>): string {
    if (!fields.size) return expr;
    return expr.replace(IDENT_SCAN, (whole, name: string | undefined, call: string | undefined, offset: number, source: string) => {
        if (!name || call) return whole;            // a quoted string, or a function call
        if (!fields.has(name)) return whole;        // not a field this spec declares
        if (/\.\s*$/.test(source.slice(0, offset))) return whole; // already reached through a dot
        return `datum.${whole}`;
    });
}

/** Apply the above to every expression a transform can carry. */
function qualifyTransformExpressions(spec: Record<string, unknown>): void {
    if (!Array.isArray(spec.transform)) return;
    const fields = declaredFieldNames(spec);
    if (!fields.size) return;
    for (const t of spec.transform) {
        if (!t || typeof t !== 'object') continue;
        const e = t as Record<string, unknown>;
        for (const key of ['calculate', 'filter']) {
            if (typeof e[key] === 'string') e[key] = qualifyDatumFields(e[key] as string, fields);
        }
    }
}

export function normalizeVegaLite(spec: Record<string, unknown>): Record<string, unknown> {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(spec)) {
        if (VALID_TOP_LEVEL.has(k)) out[k] = v;
        // else: misplaced encoding/scale prop at the root — drop it.
    }

    if (Array.isArray(out.transform)) {
        // Rescue a Vega-style sequence *transform*: Vega-Lite only knows the
        // sequence *data generator*, so move it into `data` (unless real data
        // already exists — then it's junk and the filter below drops it).
        const seqEntry = out.transform.find(
            (t) => t && typeof t === 'object' && !Array.isArray(t) && 'sequence' in (t as object),
        ) as Record<string, unknown> | undefined;
        if (seqEntry && !hasRealData(out.data)) {
            const seq = seqEntry.sequence;
            if (seq && typeof seq === 'object') {
                // Vega's transform puts the field name in a sibling `as`; the
                // data generator wants it inside the sequence object.
                if (typeof seqEntry.as === 'string' && typeof (seq as Record<string, unknown>).as !== 'string') {
                    (seq as Record<string, unknown>).as = seqEntry.as;
                }
                out.data = { sequence: seq };
            }
        }

        const kept = out.transform.filter(isValidTransform).map((t) =>
            sanitizeTransformExpressions(t as Record<string, unknown>),
        );
        if (kept.length) out.transform = kept;
        else delete out.transform;
    }

    // Rescue a sequence field name the model placed a level too high:
    // data:{sequence:{…}, as:"value"} instead of data:{sequence:{…, as:"value"}}.
    // The explicit name is better than inferSequenceAs's guess, so run it first.
    const dataObj = out.data as Record<string, unknown> | undefined;
    if (dataObj && dataObj.sequence && typeof dataObj.sequence === 'object' && 'as' in dataObj) {
        const seq = dataObj.sequence as Record<string, unknown>;
        if (typeof seq.as !== 'string' && typeof dataObj.as === 'string') seq.as = dataObj.as;
        delete dataObj.as;
    }

    inferSequenceAs(out);
    // After inferSequenceAs: the sequence's field name has to be known before a
    // bare reference to it can be recognised as a field rather than a signal.
    qualifyTransformExpressions(out);
    sanitizeEncoding(out);
    bindOrphanComputedField(out);

    // Models emit <br/> in titles; Vega renders it literally. Vega's multiline
    // title is an array of strings, so split on <br/> instead.
    out.title = fixMultilineTitle(stripTitleLatex(out.title));

    return out;
}

function fixMultilineTitle(title: unknown): unknown {
    const split = (s: string) =>
        s.includes('<br') ? s.split(/<br\s*\/?>/i).map((p) => p.trim()) : s;
    if (typeof title === 'string') return split(title);
    if (title && typeof title === 'object' && !Array.isArray(title)) {
        const t = title as Record<string, unknown>;
        if (typeof t.text === 'string') return { ...t, text: split(t.text) };
    }
    return title;
}

export default normalizeVegaLite;
