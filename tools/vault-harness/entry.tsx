// Mounts the REAL VaultProjectView so the new bundle-export options popover is
// exercised as a component rather than read as source.
import * as React from 'react';
// The interface language runtime, as main.tsx loads it: without it react-i18next
// has no instance and t() returns raw keys with their {{placeholders}} unfilled.
import '../../src/i18n';
import { createRoot } from 'react-dom/client';
import { act as domAct } from 'react-dom/test-utils';
import VaultProjectView from '../../src/components/VaultProjectView';

const act: any = (React as any).act || domAct;
(globalThis as any).__act = (fn: () => void) => act(fn);
(globalThis as any).__mount = (el: HTMLElement) => {
    const root = createRoot(el);
    act(() => { root.render(React.createElement(VaultProjectView as any)); });
    return root;
};
