// server/curriculumLabel.js — a topic's name with its position in ONE course
// stripped off.
//
// "Module 9.5:", "7.3 —", "Phase 2:", "D3 —", "4.2.1:" say where a topic sits
// in the curriculum that happens to teach it. Two layers need that removed and
// they need to agree, which is why this is its own no-import module:
//
//  • the ATLAS draws names on a map whose whole purpose is to dissolve the
//    course boundary — a dot labelled "Module 9.5: Optional Advanced Extensi…"
//    spends its width on the part that means nothing here and cuts off the part
//    that means everything;
//  • the TOPIC EMBEDDINGS are worse off still. Numbering is boilerplate shared
//    by every topic in a course and by nothing outside it, so leaving it in the
//    embedded text pulls same-course topics together and pushes apart the
//    cross-course twins this layer exists to find. It is not neutral noise; it
//    is a signal pointing the wrong way.
//
// Conservative by construction: if stripping leaves nothing usable the original
// title stands, and the words that survive are always the author's own. A label
// that reads oddly beats a label that is gone.

const NUMBERING = [
    // "Module 9.5: …", "Phase 2 — …", "Week 3: …", "Domain C1: …"
    /^(module|phase|part|chapter|unit|lesson|week|day|section|domain|stage|step|topic|deel|hoofdstuk|les)\s+[\w.]{1,8}\s*[:\-–—]\s*/i,
    // "4.2.1: …", "1.2 — …", "3) …"
    // The separator class deliberately excludes "." — with a dot in it, "10.2
    // Highway Driving" matched as 10 + "." and came out as "2 Highway Driving".
    /^\d+(\.\d+)*\s*[:)\-–—]\s*/,
    // "1. Introduction", "3.2. Foo" — a dot that ENDS the numbering.
    /^\d+(\.\d+)*\.\s+/,
    // "13.2 Coach Period" — bare dotted numbering, no separator. Requires the
    // dot, so a title that opens with a plain number ("12 Angry Men") is safe.
    /^\d+(\.\d+)+\s+/,
    // "D3 — …", "A2: …"
    /^[A-Z]\d{1,2}\s*[:\-–—]\s*/,
];
const MIN_LABEL_CHARS = 3;

export function cleanRegionLabel(title) {
    let out = String(title || '').trim();
    // Twice: "Phase 2: 5.1 Use of the Road" carries two layers of numbering.
    for (let pass = 0; pass < 2; pass++) {
        const before = out;
        for (const re of NUMBERING) {
            const stripped = out.replace(re, '').trim();
            // Both conditions matter: `replace` returns the string UNCHANGED
            // when the pattern misses, and an unchanged string is long enough
            // to pass a length check — so testing length alone accepted the
            // first regex every time and no numeric prefix was ever stripped.
            if (stripped !== out && stripped.length >= MIN_LABEL_CHARS) { out = stripped; break; }
        }
        if (out === before) break;
    }
    return out.length >= MIN_LABEL_CHARS ? out : String(title || '').trim();
}
