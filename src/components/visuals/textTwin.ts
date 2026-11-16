/**
 * The text twin of an AI visual: what the picture says, as words a screen
 * reader (or an agent reading the page) can follow.
 *
 * Every visual here is drawn from a SPEC the model wrote, and the spec already
 * holds what the picture shows: a chart's rows, a diagram's arrows, a graph's
 * formulas. So the twin is read from the spec, never from pixels and never by a
 * model call: it costs nothing, it cannot disagree with the drawing, and it
 * exists the moment the drawing does. `VisualBlock` names its stage with the
 * title and points `aria-describedby` at the twin.
 *
 * Pinned by `tools/text-twin-gates.mjs`.
 */
import { normalizeTitle } from './chartTitle';

export interface TextTwin {
    /** The visual's own title, '' when it has none. */
    title: string;
    /** A chart's rows, as written in its data. */
    table?: { columns: string[]; rows: string[][]; total: number };
    /** A diagram's statements (`A → B`), a graph's formulas, a scene's summary. */
    lines?: string[];
}

/** Enough to follow; a longer list is cut and says how many it had. */
export const TWIN_MAX_ROWS = 50;
export const TWIN_MAX_LINES = 40;

const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
};

function parseJson(code: string): Record<string, any> | null {
    try {
        const v = JSON.parse(code);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

/** Rows written as delimited text (`"values": "a,b\n1,2"`). */
function rowsFromText(text: string, type: string | undefined): Record<string, string>[] {
    const sep = type === 'tsv' ? '\t' : ',';
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];
    const head = lines[0].split(sep).map(s => s.trim());
    return lines.slice(1).map(line => {
        const parts = line.split(sep);
        return Object.fromEntries(head.map((h, i) => [h, (parts[i] ?? '').trim()]));
    });
}

function dataRows(spec: Record<string, any>): Record<string, unknown>[] {
    const sources = [spec.data, ...(Array.isArray(spec.layer) ? spec.layer.map((l: any) => l?.data) : [])];
    for (const data of sources) {
        const values = data?.values;
        if (Array.isArray(values) && values.length) {
            return values.filter(v => v && typeof v === 'object' && !Array.isArray(v));
        }
        if (typeof values === 'string') {
            const rows = rowsFromText(values, data?.format?.type);
            if (rows.length) return rows;
        }
    }
    return [];
}

function vegaTwin(code: string): TextTwin {
    const spec = parseJson(code);
    if (!spec) return { title: '' };
    const title = normalizeTitle(spec.title)?.text ?? '';
    const rows = dataRows(spec);
    if (!rows.length) return { title };
    const columns: string[] = [];
    for (const row of rows.slice(0, TWIN_MAX_ROWS)) {
        for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
    }
    return {
        title,
        table: {
            columns,
            rows: rows.slice(0, TWIN_MAX_ROWS).map(row => columns.map(c => cell(row[c]))),
            total: rows.length,
        },
    };
}

function plotTwin(code: string): TextTwin {
    const spec = parseJson(code);
    if (!spec) return { title: '' };
    const title = normalizeTitle(spec.title)?.text ?? '';
    const series: any[] = Array.isArray(spec.data) ? spec.data : (typeof spec.fn === 'string' ? [{ fn: spec.fn }] : []);
    const lines: string[] = [];
    for (const s of series) {
        if (typeof s?.fn === 'string') lines.push(`y = ${s.fn}`);
        else if (typeof s?.x === 'string' && typeof s?.y === 'string') lines.push(`x = ${s.x}, y = ${s.y}`);
        else if (typeof s?.r === 'string') lines.push(`r = ${s.r}`);
        else if (Array.isArray(s?.points)) lines.push(s.points.slice(0, TWIN_MAX_ROWS).map((p: unknown) => (Array.isArray(p) ? `(${p.join(', ')})` : '')).filter(Boolean).join(' '));
    }
    const domain = (axis: any) => (Array.isArray(axis?.domain) && axis.domain.length === 2 ? `${axis.domain[0]} to ${axis.domain[1]}` : '');
    const x = domain(spec.xAxis);
    const y = domain(spec.yAxis);
    if (x) lines.push(`${spec.xAxis?.label || 'x'}: ${x}`);
    if (y) lines.push(`${spec.yAxis?.label || 'y'}: ${y}`);
    return { title, lines: lines.filter(Boolean) };
}

// A node written with its label: A[Label], A(Label), A{Label}, A((Label)),
// A>Label], A[/Label/], A[(Label)] …; the label is what a reader is told.
const NODE_RE = /^([A-Za-z0-9_\-.]+)\s*(?:\[\[|\[\(|\(\(|\[\/|\[\\|\{\{|\[|\(|\{|>)\s*"?(.*?)"?\s*(?:\]\]|\)\]|\)\)|\/\]|\\\]|\}\}|\]|\)|\})?\s*$/;
// Every arrow mermaid draws between two nodes, with the label it can carry
// either between dashes (`-- yes -->`) or after it in pipes (`-->|yes|`).
const ARROW_RE = /\s*(?:--\s+([^-|>][^|>]*?)\s+-->|-\.\s+([^.|>][^|>]*?)\s+\.->|==\s+([^=|>][^|>]*?)\s+==>|<?-->|<?-\.->|<?==>|---|--o|--x|-\.-|===)(?:\|([^|]*)\|)?\s*/g;
const SKIP_RE = /^(%%|style\s|classDef\s|class\s|linkStyle\s|click\s|subgraph\b|end$|direction\s)/;

function mermaidTwin(code: string): TextTwin {
    const all = code.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let title = '';
    const front = all.findIndex(l => /^title\s*:?\s+/i.test(l));
    if (front !== -1) title = all[front].replace(/^title\s*:?\s+/i, '').trim();
    const body = all.filter((l, i) => i !== front && l !== '---');
    const header = (body[0] || '').toLowerCase();
    const lines = body.slice(1).filter(l => !SKIP_RE.test(l));

    if (header.startsWith('pie')) {
        const titleInHeader = body[0].replace(/^pie\s*(showData)?\s*/i, '').replace(/^title\s+/i, '').trim();
        if (!title && titleInHeader) title = titleInHeader;
        const rows = lines
            .map(l => l.match(/^"([^"]+)"\s*:\s*([-\d.]+)/))
            .filter((m): m is RegExpMatchArray => !!m)
            .map(m => [m[1], m[2]]);
        if (rows.length) return { title, table: { columns: ['Label', 'Value'], rows: rows.slice(0, TWIN_MAX_ROWS), total: rows.length } };
    }

    if (header.startsWith('sequencediagram')) {
        const out = lines
            .map(l => l.match(/^(.+?)\s*-{1,2}(?:>>|>|x|\))[+-]?\s*(.+?)\s*:\s*(.*)$/))
            .filter((m): m is RegExpMatchArray => !!m)
            .map(m => `${m[1]} → ${m[2]}: ${m[3]}`);
        if (out.length) return { title, lines: out.slice(0, TWIN_MAX_LINES) };
    }

    if (/^(flowchart|graph|statediagram)/.test(header)) {
        const labels = new Map<string, string>();
        const name = (token: string) => {
            const clean = token.replace(/:::\S+$/, '').trim();
            const m = clean.match(NODE_RE);
            if (!m) return clean;
            if (m[2]) labels.set(m[1], m[2]);
            return m[1];
        };
        const edges: { from: string; to: string; label: string }[] = [];
        for (const line of lines) {
            const parts: string[] = [];
            const edgeLabels: string[] = [];
            let last = 0;
            ARROW_RE.lastIndex = 0;
            for (let m = ARROW_RE.exec(line); m; m = ARROW_RE.exec(line)) {
                parts.push(line.slice(last, m.index));
                edgeLabels.push((m[1] || m[2] || m[3] || m[4] || '').trim());
                last = m.index + m[0].length;
            }
            if (!edgeLabels.length) { name(line.replace(/\s*:\s*.*$/, '')); continue; }
            parts.push(line.slice(last));
            // `A --> B : label` (a state diagram) puts the label after a colon.
            const tail = parts[parts.length - 1].match(/^(.*?)\s*:\s*(.+)$/);
            if (tail) { parts[parts.length - 1] = tail[1]; edgeLabels[edgeLabels.length - 1] ||= tail[2]; }
            const ids = parts.map(p => p.split('&').map(name));
            for (let i = 0; i < edgeLabels.length; i++) {
                for (const from of ids[i]) for (const to of ids[i + 1] || []) edges.push({ from, to, label: edgeLabels[i] });
            }
        }
        const say = (id: string) => (id === '[*]' ? 'start/end' : labels.get(id) || id);
        const out = edges.map(e => `${say(e.from)} → ${say(e.to)}${e.label ? ` (${e.label})` : ''}`);
        if (out.length) return { title, lines: out.slice(0, TWIN_MAX_LINES) };
    }

    // Any other diagram: its own statements, which mermaid's grammar keeps
    // close to sentences (a mindmap's branches, a timeline's events).
    return { title, lines: lines.map(l => l.replace(/\s+/g, ' ')).slice(0, TWIN_MAX_LINES) };
}

/** `Title:`, `Shows:`, `Objective:` from a scene brief or a widget spec. */
function briefTwin(code: string): TextTwin {
    const lines = code.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const field = (name: string) => lines.find(l => new RegExp(`^${name}\\s*:`, 'i').test(l))?.replace(/^[^:]+:\s*/, '') ?? '';
    const title = field('title');
    const said = [field('shows'), field('objective')].filter(Boolean);
    return { title, lines: said.length ? said : lines.slice(0, 1) };
}

/** An animation's own SVG may carry `<title>` and `<desc>`; a brief says what it shows. */
function animationTwin(code: string): TextTwin {
    if (!/<svg[\s>]/i.test(code)) return briefTwin(code);
    const tag = (name: string) => code.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() ?? '';
    const desc = tag('desc');
    return { title: tag('title'), ...(desc ? { lines: [desc] } : {}) };
}

/**
 * The twin of one fenced visual, from its kind and spec. Never throws: a spec
 * the twin cannot read gives an empty twin, and the stage is still named by
 * its kind.
 */
export function textTwinFor(kind: string, code: string): TextTwin {
    try {
        switch (kind) {
            case 'vega': return vegaTwin(code);
            case 'plot': return plotTwin(code);
            case 'mermaid': return mermaidTwin(code);
            case 'smiles': return { title: '', lines: [`SMILES: ${code.trim()}`] };
            case 'animation': return animationTwin(code);
            case 'p5':
            case 'widget': return /\bfunction\s+(setup|draw)\s*\(/.test(code) ? { title: '' } : briefTwin(code);
            default: return { title: '' };
        }
    } catch {
        return { title: '' };
    }
}

/** Has the twin anything to say beyond the title? */
export const twinHasBody = (twin: TextTwin) => !!(twin.table?.rows.length || twin.lines?.length);
