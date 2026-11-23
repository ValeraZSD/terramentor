/**
 * Short labels for a set of topic titles: the part before a colon
 * ("Japanese Architecture" for "Japanese Architecture: Restraint, Timber and
 * Raised Floors"). Used where the titles are options to tell apart: the words
 * after the colon describe the answer, so matching them to the photo answers
 * the question without looking at it.
 *
 * All or nothing: when two titles would share a short label, every title keeps
 * its full text, so each label still names one topic. A title with no colon is
 * left as it is. Returns a map from each full title to its label.
 */
export function shortTitles(titles: string[]): Map<string, string> {
    const distinct = [...new Set(titles)];
    const heads = distinct.map(t => {
        const m = /^(.+?)\s*(?::\s+|：\s*)\S/.exec(t);
        return m ? m[1].trim() : t.trim();
    });
    const unique = new Set(heads.map(h => h.toLocaleLowerCase())).size === distinct.length;
    return new Map(distinct.map((t, i) => [t, unique ? heads[i] : t]));
}
