import { useMemo } from 'react';
import { useNavigate, type NavigateFunction } from 'react-router-dom';
import { placeNavigate } from '../utils/placeHistory';

/** The router's `navigate`, keeping one history entry per place
 *  (`utils/placeHistory.ts`). Every screen navigates through this, never
 *  through `useNavigate` itself (`place-history-gates.mjs`). */
export function useAppNavigate(): NavigateFunction {
    const navigate = useNavigate();
    return useMemo(() => placeNavigate(navigate), [navigate]);
}
