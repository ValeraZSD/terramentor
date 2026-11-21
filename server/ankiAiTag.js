// The Anki tag that says a model wrote a card: `ai-written::<model>`.
//
// An .apkg is a file, so the mark rides inside it as metadata (EU AI Act
// Art. 50(2); the Code of Practice marks text in a container this way). A tag
// is the one per-note field Anki shows and keeps without a custom note type,
// and `::` makes it a tag tree in Anki's browser: "ai-written", the model under
// it. The export writes it from `flashcards.generated_by` (ankiExport.js); our
// own importer reads it back as the card's claim (ankiNotes.js), and never as a
// tag that files the deck, or two models would split one deck in two.
//
// No imports: the note reader runs in its own process (ankiCollectionProcess.js).

const PREFIX = 'ai-written::';

/**
 * The tag for a card's `generated_by` stamp (`{"provider","model"}` or
 * `{"model","via":"import"}`), or '' when no model wrote it. A tag holds no
 * space, and a second `::` would add a level to the tree.
 */
export function aiWrittenTag(stamp) {
    let model = null;
    try { model = stamp ? JSON.parse(stamp)?.model : null; } catch { model = null; }
    if (typeof model !== 'string' || !model.trim()) return '';
    return PREFIX + model.trim().replace(/\s+/g, '_').replace(/:{2,}/g, ':');
}

/** The model a note's tags say wrote it, or null; and the tags without that mark. */
export function splitAiWrittenTag(tags) {
    let model = null;
    const rest = [];
    for (const tag of tags) {
        if (tag.toLowerCase().startsWith(PREFIX) && tag.length > PREFIX.length) model ??= tag.slice(PREFIX.length);
        else rest.push(tag);
    }
    return { model, tags: rest };
}
