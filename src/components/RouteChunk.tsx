import { ComponentType, ReactNode, Suspense, lazy, useReducer } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/Button';
import { ErrorBoundary, DefaultErrorFallback } from './ErrorBoundary';
import { checkFreshness, reloadOntoNewBuild } from '../utils/freshness';

/**
 * A route downloaded when first opened, with an error screen that offers the only
 * remedy that works.
 *
 * A chunk most often fails to arrive because the app was REBUILT under an open page:
 * filenames carry a content hash and `vite build` empties `dist/`, so the SPA fallback
 * answers the old name with `index.html` and the browser rejects it as a module.
 *
 * **The boundary sits ABOVE its own `<Suspense>`.** A component that suspends on first
 * render is never committed, and a boundary built in that same discarded pass does not
 * catch the error — it escalates to the application boundary (header and navigation
 * gone), whose Try Again remounts the route boundary, and the two screens alternate.
 * Committed before anything suspends, this boundary catches every attempt.
 *
 * **A chunk failure offers a RELOAD, not a retry.** A fresh `lazy` is not enough: the
 * browser's module map records a failed URL as failed for the life of the document,
 * so a second `import()` never reaches the network. Only a reload clears it;
 * `reloadOntoNewBuild` purges the caches and the URL brings the reader back. A crash
 * inside a route that DID load still gets the ordinary Try Again (remount). A chunk
 * failure also asks `checkFreshness`, so a moved build installs through the usual
 * update road, or raises the banner when `canReloadNow` refuses.
 *
 * **The lazy lives in a module-level map, not a hook.** A `useMemo` loses its value
 * with the discarded subtree, so each remount built another `lazy` and imported again
 * without end. Keyed by the route's NAME, a constant at every call site, because the
 * loader may be an inline arrow.
 */

/**
 * The three engines' words for "that module did not arrive", plus the MIME
 * complaint the SPA fallback produces. Chrome: "Failed to fetch dynamically
 * imported module: <url>" and "…responded with a MIME type of text/html".
 * Firefox: "error loading dynamically imported module". Safari: "Importing a
 * module script failed".
 *
 * A missed wording fails silently (a retry that cannot work instead of a reload),
 * so the list is pinned by a gate.
 */
const CHUNK_FAILURE =
    /dynamically imported module|Importing a module script failed|module script failed|Loading chunk|ChunkLoadError|MIME type of/i;

export function isChunkLoadError(error: unknown): boolean {
    const message = (error as { message?: unknown } | null)?.message;
    return typeof message === 'string' && CHUNK_FAILURE.test(message);
}

type Loader = () => Promise<{ default: ComponentType<never> }>;
interface Chunk { attempt: number; Component: ComponentType<Record<string, unknown>> }

const chunks = new Map<string, Chunk>();
/** Routes whose module has arrived, by name: these render at once, with no
 *  suspension and so no blank frame. */
const loaded = new Map<string, ComponentType<Record<string, unknown>>>();
const preloading = new Set<string>();

/** The loader, recording the module the moment it arrives. */
function recording(name: string, load: Loader): () => Promise<{ default: ComponentType<never> }> {
    return () => load().then((m) => { loaded.set(name, m.default as ComponentType<Record<string, unknown>>); return m; });
}

/** The component for this route, made once and then held across every remount:
 *  the module itself when it is already here, else a lazy. A held lazy is kept
 *  even after it resolves, since swapping it for the module would remount the
 *  screen. */
function chunkFor(name: string, load: Loader): Chunk {
    const held = chunks.get(name);
    if (held) return held;
    const made: Chunk = { attempt: 0, Component: loaded.get(name) ?? lazy(recording(name, load) as never) };
    chunks.set(name, made);
    return made;
}

/** Start again from a fresh lazy — for a route that loaded and then crashed. */
function remountChunk(name: string, load: Loader): void {
    const held = chunks.get(name);
    chunks.set(name, { attempt: (held?.attempt ?? 0) + 1, Component: loaded.get(name) ?? lazy(recording(name, load) as never) });
}

/**
 * Fetch a route's module before it is opened, so the first visit draws the
 * screen at once instead of a blank page while the module arrives. A failure
 * is silent here: the visit then fails through the boundary below, which
 * offers the reload, exactly as it would have without the preload.
 */
export function preloadRouteChunk<P>(name: string, load: () => Promise<{ default: ComponentType<P> }>): Promise<void> {
    if (loaded.has(name) || preloading.has(name)) return Promise.resolve();
    preloading.add(name);
    return recording(name, load as Loader)().then(() => undefined, () => undefined)
        .finally(() => preloading.delete(name));
}

/**
 * The screen for a route that was not downloaded. Not "something went wrong":
 * a rebuild under an open page is ordinary, so it says what to do.
 */
function ChunkFailureScreen({ onReload }: { onReload: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="h-full flex items-center justify-center p-6">
            <div className="max-w-md w-full bg-white dark:bg-slate-800 rounded-xl shadow-lg border border-slate-200 dark:border-slate-700 p-6 text-center">
                <div className="mx-auto mb-3 w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center">
                    <RefreshCw className="w-5 h-5 text-accent-fg" aria-hidden="true" />
                </div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {t("This screen needs a reload")}
                </h2>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1 mb-4">
                    {t("It was not downloaded before the app was updated. Reloading picks up the new version and brings you back here.")}
                </p>
                {/* `text-white`, never `text-accent-fg`: on an accent FILL,
                    `accent-fg` has too little contrast. */}
                <Button variant="primary" size="lg" block onClick={onReload} icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />}>
                    {t("Reload")}
                </Button>
            </div>
        </div>
    );
}

interface RouteChunkProps<P> {
    /** Names the boundary in the fallback and in the console, and is the key
     *  this route's chunk is held under. Unique per route, constant per route. */
    name: string;
    /** The dynamic import. */
    load: () => Promise<{ default: ComponentType<P> }>;
    /** Props for the loaded component. */
    props?: P;
    /** Override the CRASH screen (the workspace draws a compact one). A chunk
     *  that never arrived is not a crash and is not routed here. */
    fallback?: (error: Error, reset: () => void) => ReactNode;
    /** Shown while the chunk loads. Blank by default: a local chunk arrives in
     *  milliseconds and a one-frame spinner reads as a stutter. */
    pending?: ReactNode;
}

export default function RouteChunk<P extends object>({ name, load, props, fallback, pending }: RouteChunkProps<P>) {
    // The map is the state; this only requests the render that reads the new chunk.
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    const chunk = chunkFor(name, load as Loader);
    const Component = chunk.Component;

    return (
        <ErrorBoundary
            // The route's name as well as the attempt: sibling routes share this
            // one element in the router's tree, so after a crash on one of them
            // a bare attempt count (0 for both) would keep the error on screen
            // for the route the reader just moved to.
            key={`${name}:${chunk.attempt}`}
            componentName={name}
            onError={(error) => { if (isChunkLoadError(error)) void checkFreshness(true); }}
            onReset={() => { remountChunk(name, load as Loader); rerender(); }}
            fallback={(error, reset) => (
                isChunkLoadError(error)
                    ? <ChunkFailureScreen onReload={() => { void reloadOntoNewBuild(); }} />
                    : fallback
                        ? fallback(error, reset)
                        : <DefaultErrorFallback error={error} componentName={name} onReset={reset} />
            )}
        >
            <Suspense fallback={pending ?? <div className="h-full" aria-busy="true" />}>
                <Component {...(props as Record<string, unknown> | undefined ?? {})} />
            </Suspense>
        </ErrorBoundary>
    );
}
