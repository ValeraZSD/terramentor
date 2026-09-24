import { createContext, useContext } from 'react';

/**
 * Which project an AI creation is running for, and how to open the modal.
 * Lives outside ProjectsGrid on purpose: the layout, the tree and a project
 * card all read it, and importing it from the grid pulled the whole grid into
 * the entry chunk, which undid its lazy route.
 */
export interface AICreationContextValue {
    generatingProjectId: number | null;
    isProjectGenerating: (projectId: number) => boolean;
    openGenerationModal: () => void;
}

export const AICreationContext = createContext<AICreationContextValue>({
    generatingProjectId: null,
    isProjectGenerating: () => false,
    openGenerationModal: () => { },
});

export function useAICreationContext() {
    return useContext(AICreationContext);
}
