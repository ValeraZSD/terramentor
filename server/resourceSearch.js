// Finding study resources for one topic, shared by project creation and the per-topic Find.
import { searchAndCurateResources } from './agentic.js';
import { sanitizeResourceType } from './curriculumSchema.js';

async function findResourcesForSubElement(
    projectName, categoryTitle, elementTitle,
    subElementTitle, subElementDescription,
    signal, projectSummary, lang = null
) {
    try {
        const results = await searchAndCurateResources(
            projectName, projectSummary || '',
            categoryTitle, elementTitle,
            subElementTitle, subElementDescription || '',
            signal, lang
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

export { findResourcesForSubElement };
