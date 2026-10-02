import { useCallback } from 'react';
import { useStore } from '../store';
import { isRunLive, openCreationRun, useCreationRuns } from './creation/creationRuns';

/**
 * Is an AI creation writing into this project, and how to open its screen.
 *
 * A hook, not a React context: it reads the run store and the project row's
 * own flag, so every reader (the header, the tree, the grid) gets the same
 * answer for every run, wherever it is mounted.
 */
export interface AICreationContextValue {
    isProjectGenerating: (projectId: number) => boolean;
    /** Open the screen of the run writing into this project, if one is known here. */
    openGenerationModal: (projectId: number) => void;
}

export function useAICreationContext(): AICreationContextValue {
    const projects = useStore(s => s.projects);
    const runs = useCreationRuns(s => s.runs);
    const isProjectGenerating = useCallback((projectId: number) => {
        if (Object.values(runs).some(r => r.projectId === projectId && isRunLive(r))) return true;
        return projects.find(p => p.id === projectId)?.ai_generating === 1;
    }, [projects, runs]);
    const openGenerationModal = useCallback((projectId: number) => {
        const run = Object.values(runs).find(r => r.projectId === projectId);
        if (run) openCreationRun(run.key);
    }, [runs]);
    return { isProjectGenerating, openGenerationModal };
}
