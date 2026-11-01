import { dsvFormat } from 'd3-dsv';
type VegaNamespace = typeof import('vega-embed').vega;

/**
 * Vega's readers for CSV, TSV and other delimited text, without building code
 * from a string.
 *
 * A chart may carry its rows as delimited text (`"values": "a,b\n1,2"` with
 * `"format": {"type": "csv"}`). vega-loader reads it with d3-dsv's `parse`,
 * which turns the header row into a function's source and compiles it with
 * `new Function`; the page's `script-src 'self'` refuses that, so such a chart
 * would draw with no rows. These readers split the text with the same d3-dsv
 * tokenizer (`parseRows`, which compiles nothing) and build each row by hand,
 * giving what vega-loader gives, row for row: the same rows, an empty string for
 * a missing cell, the last of two columns with one name, `columns` on the array,
 * `header` written above the text. tools/script-src-gates.mjs compares the two
 * on a set of inputs.
 */

type Format = { delimiter?: string; header?: unknown[] } & Record<string, unknown>;
type Rows = Record<string, string>[] & { columns: string[] };

// vega-util's stringValue, for a header name: JSON for a string, with the two
// line separators JavaScript reads as line breaks escaped.
const headerName = (x: unknown): unknown => (typeof x === 'string'
    ? JSON.stringify(x).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
    : x);

function readDelimited(data: unknown, format: Format): Rows {
    const delimiter = String(format.delimiter);
    let text = String(data);
    if (format.header) text = format.header.map(headerName).join(delimiter) + '\n' + text;
    let columns: string[] | undefined;
    const rows = dsvFormat(delimiter).parseRows(text, (row) => {
        if (!columns) {
            columns = row;
            return null;
        }
        const out: Record<string, string> = {};
        for (let i = 0; i < columns.length; i++) out[columns[i]] = row[i] || '';
        return out;
    }) as Rows;
    rows.columns = columns || [];
    return rows;
}

type Reader = ((data: unknown, format?: Format) => Rows) & { responseType: 'text' };

const withDelimiter = (delimiter: string): Reader => Object.assign(
    (data: unknown, format?: Format) => readDelimited(data, { ...(format || {}), delimiter }),
    { responseType: 'text' as const },
);

export const evalFreeDsv: Record<'csv' | 'tsv' | 'dsv', Reader> = {
    csv: withDelimiter(','),
    tsv: withDelimiter('\t'),
    dsv: Object.assign((data: unknown, format?: Format) => readDelimited(data, format || {}), { responseType: 'text' as const }),
};

/** Put the readers in vega's place of its own. Vega keeps one table of readers, so once is enough. */
export function registerEvalFreeDsv(vega: VegaNamespace): void {
    for (const [name, reader] of Object.entries(evalFreeDsv)) vega.formats(name, reader);
}
