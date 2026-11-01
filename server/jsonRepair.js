/**
 * Reading JSON out of a model's reply — a leaf module with no imports, so the
 * chat client (ai.js) and the schema layer (agentic.js) can both use it
 * without importing each other.
 */

export function parseJsonWithRepair(text) {
    if (!text || !text.trim()) return null;
    let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();

    // 1. Try native parse first (best case, if AI returned perfectly valid JSON)
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        // continue to repair
    }

    cleaned = cleaned.replace(/([{,])\s*'(.*?)'\s*:/g, '$1"$2":');
    cleaned = cleaned.replace(/:\s*'(.*?)'(\s*[,}])/g, ': "$1"$2');
    // Structure repairs, so they stay out of the strings: inside one, `}{` is
    // TeX (`\frac{a}{b}`) and ", namely:" is prose, and both were rewritten.
    cleaned = outsideStrings(cleaned, (s) => s
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
