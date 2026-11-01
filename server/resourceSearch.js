// Finding study resources for one topic, shared by project creation and the per-topic Find.
import { planSectionQueries, searchAndCurateResources } from './agentic.js';
import { sanitizeResourceType } from './curriculumSchema.js';

// `queries`: this topic's row of a section plan (planSectionQueries), or null
// to plan its own.
async function findResourcesForSubElement(
    projectName, categoryTitle, elementTitle,
    subElementTitle, subElementDescription,
    signal, projectSummary, lang = null, queries = null
) {
    try {
        const results = await searchAndCurateResources(
            projectName, projectSummary || '',
            categoryTitle, elementTitle,
            subElementTitle, subElementDescription || '',
            signal, lang, queries
        );
        return results.map(r => ({
            title: r.title || 'Resource',
            url: r.url || '',
            type: sanitizeResourceType(r.type),
        }));
    } catch (e) {
        console.log('[Resources] findResourcesForSubElement failed:', e.message);
        return [];
    }
}

export { findResourcesForSubElement, planSectionQueries };
