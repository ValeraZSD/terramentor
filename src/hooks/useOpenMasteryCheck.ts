import { useCallback } from 'react';
import { api } from '../api';
import { useStore } from '../store';

/**
 * Open the app's own mastery check on a topic (`MasteryGateModal`, mounted in
 * Layout). The gate mode is the learner's setting, read on the PRESS and never
 * assumed: an enforced gate the learner switched to advisory must open as
 * advisory. The assistant's check button, a sitting's retake and a topic that
 * is ready to prove all open it this one way.
 */
export function useOpenMasteryCheck() {
    const openMasteryGate = useStore(s => s.openMasteryGate);
    return useCallback(async (nodeId: number, nodeTitle: string, projectId?: number | null) => {
        // The server's own default is enforced: a read that fails must not
        // offer a way past the check that the learner's setting may forbid.
        let advisory = false;
        try { advisory = (await api.getSettings()).mastery_gate_mode !== 'enforced'; } catch { /* enforced is the default */ }
        openMasteryGate(nodeId, nodeTitle, advisory, projectId ?? null);
    }, [openMasteryGate]);
}
