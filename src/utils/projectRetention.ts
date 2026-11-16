// Which recall target a card is scheduled with: its course's own
// (`desired_retention` on the project row, server/decks.js `getRetention`), else
// the app-wide 0.90. Every review surface passes this to `computeSrsUpdate` and
// `computeNextInterval`, so the interval a button shows is the one it writes.

import { useStore } from '../store';
import { normalRetention, REQUEST_RETENTION } from './srs';

export function retentionOf(projectId: number | null | undefined): number {
    if (projectId == null) return REQUEST_RETENTION;
    const project = useStore.getState().projects.find(p => p.id === projectId);
    return normalRetention(project?.desired_retention);
}
