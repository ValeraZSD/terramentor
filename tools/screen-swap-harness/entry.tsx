// Headless harness for moving between screens in one step: the REAL
// `screenSwap` (the hold, its cap, which reads it waits for), the REAL
// `useShownLocation` under the real react-router, and the REAL `RouteChunk`
// with its preload, mounted by React DOM into jsdom.
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act as domAct } from 'react';
import { MemoryRouter, Routes, Route, useNavigate, useParams } from 'react-router-dom';
import * as swap from '../../src/utils/screenSwap';
import { useShownLocation } from '../../src/hooks/useShownLocation';
import RouteChunk, { preloadRouteChunk } from '../../src/components/RouteChunk';

const act: any = (React as any).act || domAct;
const h = React.createElement;

let navigateTo: (to: string | number) => void = () => {};
/** The pathname the store would be told, each time it changes. */
const storeSaw: string[] = [];

function StoreProbe({ pathname }: { pathname: string }) {
    React.useEffect(() => { storeSaw.push(pathname); }, [pathname]);
    return null;
}

/** App's shape: the routes and the store both follow the SHOWN location. */
function Shell() {
    const shown = useShownLocation();
    navigateTo = useNavigate();
    return h(React.Fragment, null,
        h(StoreProbe, { pathname: shown.pathname }),
        h('main', null,
            h(Routes, { location: shown },
                h(Route, { path: '/a', element: h('p', null, 'screen A') }),
                h(Route, { path: '/b', element: h('p', null, 'screen B') }),
                h(Route, { path: '/c', element: h('p', null, 'screen C') }),
                h(Route, { path: '/project/:id/:view/:nodeId?', element: h(Course) }))));
}

function Course() {
    const { view, nodeId } = useParams();
    return h('p', null, `course ${view} topic ${nodeId ?? 'none'}`);
}

(globalThis as any).__harness = {
    React, createRoot, act, MemoryRouter, Shell, storeSaw, RouteChunk, preloadRouteChunk, swap,
    navigate: (to: string | number) => (navigateTo as (to: string | number) => void)(to),
};
