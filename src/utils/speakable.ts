/**
 * An assistant answer as words a screen reader can say: the Markdown's markup
 * taken off, the words kept (the app's own markers go first, through
 * `readableAnswer`). Only markup, never a character inside a word:
 * `snake_case`, `2*3*4` and `a|b` in prose stay as written.
 *
 * Long answers are cut at `max` characters, at the end of a sentence when one
 * is near, and `cut` says so: the caller adds that the answer goes on in the
 * conversation, rather than letting it stop mid-sentence.
 */
export function speakable(markdown: string, max = 2000): { text: string; cut: boolean } {
    const s = markdown
        .replace(/^\s*(```|~~~).*$/gm, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s{0,3}>\s?/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        // A table's rule row, then its cell walls.
        .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, '')
        .replace(/^[ \t]*\|[ \t]*|[ \t]*\|[ \t]*$/gm, '')
        .replace(/[ \t]+\|[ \t]+/g, ', ')
        .replace(/`+/g, '')
        .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
        .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2')
        .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, '$1$2')
        .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
    if (s.length <= max) return { text: s, cut: false };
    const head = s.slice(0, max);
    const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
    const space = head.lastIndexOf(' ');
    const at = sentence > max * 0.6 ? sentence + 1 : space > 0 ? space : max;
    return { text: s.slice(0, at).trim(), cut: true };
}
