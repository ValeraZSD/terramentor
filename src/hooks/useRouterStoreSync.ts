import { useEffect } from 'react';
import { useLocation, useNavigate, matchPath } from 'react-router-dom';
import { useStore, RouteState, WorkspaceView } from '../store';

/** Decode the current pathname into the navigation state the store mirrors.
 *  Unknown paths fall back to the Today hub (the home page). */
function decodeRoute(pathname: string): RouteState {
    if (matchPath('/settings', pathname)) return { view: 'settings' };
    if (matchPath('/projects', pathname)) return { view: 'projects' };
    if (matchPath('/calendar', pathname)) return { view: 'calendar' };
    if (matchPath('/schedule', pathname)) return { view: 'schedule' };
    if (matchPath('/atlas', pathname)) return { view: 'atlas' };

    const m =
        matchPath('/project/:projectId/:view/:nodeId', pathname) ||
        matchPath('/project/:projectId/:view', pathname) ||
        matchPath('/project/:projectId', pathname);

    if (m) {
        // The `||` fallback chain yields a union of param shapes; widen it so the
        // optional :view / :nodeId segments are readable regardless of which
        // pattern matched.
        const params = m.params as { projectId?: string; view?: string; nodeId?: string };
        const projectId = Number(params.projectId);
        const nodeId = params.nodeId ? Number(params.nodeId) : null;
        return {
            view: 'workspace',
            projectId: Number.isNaN(projectId) ? null : projectId,
            workspaceView: (params.view as WorkspaceView) || 'dashboard',
            nodeId: nodeId != null && Number.isNaN(nodeId) ? null : nodeId,
        };
    }

    return { view: 'today' };
}

/** Bridges react-router and the Zustand store: injects `navigate` so store
 *  actions can drive the URL, and reconciles the store to the URL on every
 *  location change. Mount once, high in the tree (inside the Router). */
export function useRouterStoreSync() {
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const setNavigate = useStore(s => s.setNavigate);
    const applyRoute = useStore(s => s.applyRoute);

    // Give store actions access to navigate (declared before the sync effect so
    // `_navigate` is set before the first reconciliation runs).
    useEffect(() => { setNavigate(navigate); }, [navigate, setNavigate]);

    // URL → store: the single reconciliation point.
    useEffect(() => { applyRoute(decodeRoute(pathname)); }, [pathname, applyRoute]);
}
