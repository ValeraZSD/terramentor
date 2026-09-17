// Mounts the REAL TaskDock over the REAL store, so the ✕ is exercised end to
// end: the button, the store action, and the list the dock renders from. Only
// the network is a stub (`run.mjs` substitutes `src/api`).
import * as React from 'react';
// The interface language runtime, as main.tsx loads it: without it react-i18next
// has no instance and t() returns raw keys with their {{placeholders}} unfilled.
import '../../src/i18n';
import { createRoot } from 'react-dom/client';
import { act as domAct } from 'react-dom/test-utils';
import TaskDock from '../../src/components/TaskDock';
import { useStore } from '../../src/store';

const act: any = (React as any).act || domAct;

(globalThis as any).__act = (fn: () => void) => act(fn);
(globalThis as any).__store = useStore;
(globalThis as any).__mount = (el: HTMLElement) => {
    const root = createRoot(el);
    act(() => { root.render(React.createElement(TaskDock as any)); });
    return root;
};
