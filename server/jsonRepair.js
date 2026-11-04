/**
 * Reading JSON out of a model's reply — a leaf module with no imports, so the
 * chat client (ai.js) and the schema layer (agentic.js) can both use it
 * without importing each other.
 */

export function parseJsonWithRepair(text) {
    if (!text || !text.trim()) return null;
    // A reply's own fence goes; a fence INSIDE a string is content. A question
    // stem carries its graph as ```plot … ```, and stripping every fence left
    // the spec printed as text under the question.
    const at = text.search(/[[{]/);
    const dropFences = (s) => s.replace(/```json/gi, '').replace(/```/g, '');
    let cleaned = (at > 0 ? dropFences(text.slice(0, at)) + outsideStrings(text.slice(at), dropFences)
        : at === 0 ? outsideStrings(text, dropFences) : dropFences(text)).trim();

    // 1. Try native parse first (best case, if AI returned perfectly valid JSON)
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        // continue to repair
    }

    // The repairs stay out of the strings: inside one, `}{` is TeX
    // (`\frac{a}{b}`) and ", namely:" or ", 'wait':" is prose, and all of them
    // were rewritten. Prose before the JSON is left alone too: one quote in it
    // would read every string after it inside out.
    const jsonAt = cleaned.search(/[[{]/);
    const lead = jsonAt > 0 ? cleaned.slice(0, jsonAt) : '';
    cleaned = lead + outsideStrings(cleaned.slice(lead.length), (s) => s
        .replace(/([{,])\s*'(.*?)'\s*:/g, '$1"$2":')
        .replace(/:\s*'(.*?)'(\s*[,}])/g, ': "$1"$2')
        .replace(/(\{|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/}\s*{/g, '},{')
        .replace(/\]\s*\[/g, '],['));

    const objStart = cleaned.indexOf('{');
    const arrStart = cleaned.indexOf('[');

    // 2. Determine which bracket opens the JSON structure first
    const isArrFirst = arrStart !== -1 && (objStart === -1 || arrStart < objStart);
    const isObjFirst = objStart !== -1 && (arrStart === -1 || objStart < arrStart);

    if (isArrFirst) {
        try {
            const endBracket = findMatchingBracket(cleaned, arrStart, '[', ']');
            if (endBracket !== -1) return JSON.parse(cleaned.slice(arrStart, endBracket + 1));
        } catch (e) { }
    } else if (isObjFirst) {
        try {
            const endBrace = findMatchingBracket(cleaned, objStart, '{', '}');
            if (endBrace !== -1) return JSON.parse(cleaned.slice(objStart, endBrace + 1));
        } catch (e) { }
    }

    console.log('[JSON Repair] Failed to parse JSON. First 200 chars:', cleaned.slice(0, 200));
    return null;
}

/**
 * The JSON object a model's reply holds, or null.
 *
 * A reply that works its answer out first writes TeX before the JSON
 * (`$\dfrac{f'(h)}{h}$ … {"verdict": "ok"}`), and the old slice from the first
 * `{` to the last `}` began inside the TeX, so a verifier that agreed with the
 * key read as "returned nothing usable" and the question was served as
 * practice only (Taylor clip, 4 Nov 2026). So each balanced `{…}` is tried in
 * order, a ```json fenced one first: the first that parses as an object wins;
 * one that starts like JSON (`{"`) but needs repair is repaired, so a nested
 * object never wins over the broken one around it. Nothing found: the old
 * slice and repair, as before.
 *
 * `prepare` runs on each slice before it is parsed (the TeX-safe escaping
 * lives in agentic.js, which imports this module).
 */
export function readReplyObject(text, prepare = (s) => s) {
    const s = String(text ?? '');
    const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const slices = [...s.matchAll(/```(?:json)?[ \t]*\r?\n?(\{[\s\S]*?\})\s*```/gi)].map(m => m[1]);
    for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
        const end = findMatchingBracket(s, i, '{', '}');
        if (end !== -1) slices.push(s.slice(i, end + 1));
    }
    for (const slice of slices) {
        let prepared;
        try { prepared = prepare(slice); } catch { continue; }
        try { const v = JSON.parse(prepared); if (isObject(v)) return v; } catch { /* next */ }
        if (/^\{\s*"/.test(slice)) {
            const v = parseJsonWithRepair(prepared);
            if (isObject(v)) return v;
        }
    }
    const greedy = s.match(/\{[\s\S]*\}/);
    if (!greedy) return null;
    const v = parseJsonWithRepair(prepare(greedy[0]));
    return isObject(v) ? v : null;
}

/**
 * Run `fix` on the text between JSON strings only, each run of it whole, and
 * keep every double-quoted string (escapes included) as it was.
 */
function outsideStrings(text, fix) {
    let out = '', run = '', inString = false, escaped = false;
    for (const c of text) {
        if (inString) {
            out += c;
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
        } else if (c === '"') {
            out += fix(run) + c;
            run = '';
            inString = true;
        } else {
            run += c;
        }
    }
    return out + fix(run);
}

function findMatchingBracket(text, startIdx, openBracket, closeBracket) {
    let depth = 0, inString = false, escaped = false;
    for (let i = startIdx; i < text.length; i++) {
        const char = text[i];
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (char === openBracket) depth++;
        if (char === closeBracket) { depth--; if (depth === 0) return i; }
    }
    const lastBracket = text.lastIndexOf(closeBracket);
    if (lastBracket !== -1 && lastBracket > startIdx) {
        try { JSON.parse(text.slice(startIdx, lastBracket + 1)); return lastBracket; } catch { }
    }
    return -1;
}
