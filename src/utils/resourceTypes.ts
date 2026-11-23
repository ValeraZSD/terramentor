/**
 * The kinds a topic's resource can be, as the resource list offers and counts
 * them.
 *
 * Stored rows can carry `course_link`, a legacy name for `course` that the
 * server still accepts (server/curriculumSchema.js), and an older row may carry
 * a type the list no longer knows. Both are read as the kind they are drawn
 * as: `course_link` as `course`, anything unknown as `link`. So the add and the
 * edit form offer one "Course", the filter counts both kinds of course row
 * under it, and an edit of a legacy row shows its kind selected.
 */

/** Every kind a learner can pick, in the order the forms show them. */
export const SELECTABLE_RESOURCE_TYPES = [
    'article', 'video', 'book', 'documentation', 'tutorial', 'tool', 'course', 'practice', 'link',
] as const;

const SELECTABLE = new Set<string>(SELECTABLE_RESOURCE_TYPES);

/** The kind a stored type is shown, counted and filtered as. */
export function canonicalResourceType(type: string | null | undefined): string {
    if (type === 'course_link') return 'course';
    return type && SELECTABLE.has(type) ? type : 'link';
}

/** Rows per kind, legacy and unknown types counted under the kind they show as. */
export function countResourceTypes(resources: ReadonlyArray<{ type: string }>): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const r of resources) {
        const t = canonicalResourceType(r.type);
        counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
}

/** The kind pills are drawn only for a list longer than this. */
export const TYPE_FILTER_AFTER = 5;

/**
 * The filter that applies: none unless its pills are on screen and its kind
 * still has rows. A filter picked on a long list stays chosen while rows are
 * deleted, and once the pills are gone it would hide rows with nothing on
 * screen to say so or to clear it.
 */
export function effectiveTypeFilter(filter: string | null, resources: ReadonlyArray<{ type: string }>): string | null {
    if (!filter || resources.length <= TYPE_FILTER_AFTER) return null;
    return resources.some(r => canonicalResourceType(r.type) === filter) ? filter : null;
}
