// Which recall target a card is scheduled with: its course's own
// (`desired_retention` on the project row, server/decks.js `getRetention`), else
// the app-wide 0.90. Every review surface passes this to `computeSrsUpdate` and
// `computeNextInterval`, so the interval a button shows is the one it writes.

import { useStore } from '../store';
import { normalRetention, REQUEST_RETENTION } from './srs';

/**
 * The course's target, followed: a subscription, not a read at render, so a
 * surface drawn before the project list arrived (a cold start on the feed), or
 * one whose course changed its target on another device, re-renders with the
 * row and rates at it.
 */
export function useProjectRetention(projectId: number | null | undefined): number {
    return useStore(s => (projectId == null
        ? REQUEST_RETENTION
        : normalRetention(s.projects.find(p => p.id === projectId)?.desired_retention)));
}
