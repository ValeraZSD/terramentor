// Headless harness: mounts the real atlas renderer against real atlas payload data.
import * as React from 'react';
// The interface language runtime, as main.tsx loads it: without it react-i18next
// has no instance and t() returns raw keys with their {{placeholders}} unfilled.
import '../../src/i18n';
import { createRoot } from 'react-dom/client';
import { act as domAct } from 'react';
import GlobeMap, { GlobeMapHandle } from '../../src/components/atlas/GlobeMap';
import { listCourses, traceCourse, stepDurationMs, FLIGHT_SHARE, STEP_MAX_MS, END_HOLD_MS } from '../../src/components/atlas/coursePaths';
import { courseHues } from '../../src/components/atlas/atlasColors';
// The projection itself, so a probe can ask where a point on the planet is
// DRAWN rather than re-deriving the arithmetic beside the thing it checks.
import { FLAT_DX_DLON, FLAT_HALF_H, FLAT_HALF_W, project, rotate, unrotate } from '../../src/components/atlas/globeProjection';
import { atlasSurfaces } from '../../src/utils/themeSurfaces';

const act: any = (React as any).act || domAct;

(globalThis as any).__act = (fn: () => void) => act(fn);
// The real course-paths module, so the harness traces what the page traces
// rather than a second implementation of the same arithmetic.
(globalThis as any).__coursePaths = {
    listCourses, traceCourse, stepDurationMs, FLIGHT_SHARE, STEP_MAX_MS, END_HOLD_MS,
};
// The real hue assignment, for the same reason: `AtlasView` gives both surfaces
// one map of course → hue, so the harness has to make it the same way the page
// does rather than hand the components an empty one.
(globalThis as any).__courseHues = (projects: any[]) => courseHues(projects);
(globalThis as any).__proj = { project, rotate, unrotate, FLAT_DX_DLON, FLAT_HALF_H, FLAT_HALF_W };
// The page's own surfaces, so a probe can tell the journey's ink and its halo
// from every other line on the map by the colour they are drawn in.
(globalThis as any).__atlasSurfaces = atlasSurfaces;
// The Map surface: the same renderer with the planet unrolled onto a sheet.
(globalThis as any).__element = (props: any) => React.createElement(GlobeMap as any, { flat: true, ...props });
(globalThis as any).__mountAtlas = (el: HTMLElement, props: any) => {
    const ref = React.createRef<GlobeMapHandle>();
    const root = createRoot(el);
    act(() => { root.render(React.createElement(GlobeMap as any, { flat: true, ...props, ref })); });
    return { ref, root };
};
// …and Terra. The page gives both surfaces the same instructions, so anything
// measuring what a replay DOES has to be able to ask either of them.
(globalThis as any).__globeElement = (props: any) => React.createElement(GlobeMap as any, props);
(globalThis as any).__mountGlobe = (el: HTMLElement, props: any) => {
    const ref = React.createRef<GlobeMapHandle>();
    const root = createRoot(el);
    act(() => { root.render(React.createElement(GlobeMap as any, { ...props, ref })); });
    return { ref, root };
};
