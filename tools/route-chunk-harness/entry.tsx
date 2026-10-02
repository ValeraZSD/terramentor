// Headless harness for the lazy-route retry: the REAL `RouteChunk` and the REAL
// `ErrorBoundary`, mounted by the real React DOM client into jsdom, so that what
// is asserted is React's behaviour rather than a second model of it.
//
// Both boundaries are given a plain-text `fallback`. The default error screen is
// not what is under test here — where the error lands and whether the retry
// re-imports is — and skipping it keeps the interface-language runtime and its
// eleven locale files out of a bundle this gate builds on every run.
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act as domAct } from 'react-dom/test-utils';
import RouteChunk, { isChunkLoadError } from '../../src/components/RouteChunk';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';

const act: any = (React as any).act || domAct;

const legacyLazies = new Map<string, any>();

/** Says which boundary caught it, and carries the retry the gate presses. */
const said = (name: string) => (error: Error, reset: () => void) =>
    React.createElement('div', null,
        React.createElement('span', null, `caught:${name}`),
        React.createElement('span', null, ` ${error.message}`),
        React.createElement('button', { onClick: reset }, 'Try Again'));

// The one module-level side effect the fix has that a test can watch: a chunk
// failure asks the freshness watcher, which reloads the page when the build on
// disk has moved. jsdom has no navigation, so the gate reads the fetch instead.
(globalThis as any).__harness = {
    React, createRoot, act, RouteChunk, ErrorBoundary, isChunkLoadError, said, Suspense: React.Suspense,
    // The shape App.tsx had before the fix, kept here as the gate's known-bad
    // input: one lazy at MODULE scope inside a plain boundary. If the assertions
    // cannot tell this apart from `RouteChunk`, they are not measuring anything.
    //
    // The map is what makes it module scope — `const ScheduleBoard = lazy(...)`
    // built its lazy once for the life of the page, and so does this. Holding it
    // in a `useMemo` instead is a THIRD behaviour, not the old one: a component
    // that suspends on its first render is discarded and mounted again, so the
    // memo re-runs, and the import loops until the heap goes. (Measured here on
    // the way to this file: the first draft of the fix did exactly that.)
    LegacyRoute: ({ name, load, fallback }: { name: string; load: () => Promise<any>; fallback?: any }) => {
        if (!legacyLazies.has(name)) legacyLazies.set(name, React.lazy(load));
        return React.createElement(ErrorBoundary, { componentName: name, fallback: fallback || said(name) },
            React.createElement(legacyLazies.get(name)));
    },
};
