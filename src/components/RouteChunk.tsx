import { ComponentType, ReactNode, Suspense, lazy, useReducer } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ErrorBoundary, DefaultErrorFallback } from './ErrorBoundary';
import { checkFreshness, reloadOntoNewBuild } from '../utils/freshness';

/**
 * A route that is downloaded when it is first opened, and an error screen that
 * offers the only thing that can actually work.
 *
 * ## The failure
 *
 * Every route but the feed is a `lazy()` chunk, and a chunk can fail to arrive.
 * The commonest way here is not a flaky network at all — it is a REBUILD under a
 * page that is already open. Asset filenames carry a content hash and `vite
 * build` empties `dist/`, so the chunk the running page will ask for by name no
 * longer exists; the server's SPA fallback answers that request with
 * `index.html`, 200, `text/html`, and the browser rejects it as a module.
 * Everything already downloaded keeps working, so the app looks fine until you
 * open the one screen you had not opened yet.
 *
 * What the reader saw was worse than the failure. With the shape `App.tsx` had —
 * one `<Suspense>` around the whole `<Routes>`, a module-level `lazy()`, a plain
 * boundary per route — opening a dead route produced an error screen, and
 * pressing its button produced a DIFFERENT error screen, and pressing that one
 * produced the first again, with a blank frame between each. Neither button ever
 * did anything. Both halves of that are measured facts, and each has its own
 * cause.
 *
 * ## Why it alternated: the boundary was below the Suspense
 *
 * A component that suspends on its first render is never committed, so React
 * throws that work away — the route's error boundary with it — and renders again
 * from the Suspense boundary when the promise settles. A boundary being built in
 * the same pass as the throw does not catch it: the error goes up to the next
 * one, which was the whole application, so the header and the navigation
 * disappeared too. Pressing Try Again THERE remounted the subtree, the route's
 * boundary came back as a committed instance, caught normally — and the cycle
 * closed.
 *
 * So this component carries its own `<Suspense>`, under its own boundary. The
 * boundary is committed before anything suspends, and it catches every attempt.
 * Verified in the running app against a chunk moved out of `dist/`: before, the
 * first failure said "The Application section…" with the header gone; after, it
 * says "The Atlas section…" with the navigation still there.
 *
 * ## Why the button could not work: the URL is poisoned, not the promise
 *
 * `React.lazy` memoises the promise it was handed, rejection included, so the
 * obvious fix is a fresh `lazy` per attempt. That is not enough, and the reason
 * is a layer below React: a module script that fails to load is recorded AS A
 * FAILURE in the browser's module map, keyed by URL, for the life of the
 * document. A second `import()` of that URL does not hit the network at all.
 *
 * Measured, in Chrome, on the real app: chunk moved aside, route opened, Try
 * Again pressed, chunk MOVED BACK, Try Again pressed again — still the error
 * screen, and `performance.getEntriesByType('resource')` listed exactly ONE
 * request for that URL across all three attempts.
 *
 * So for a chunk failure this offers a RELOAD, which is the only thing that
 * clears the module map, and it says so on the button. `reloadOntoNewBuild`
 * purges the caches first, and the route the reader asked for is in the URL, so
 * they land back where they were. An ordinary crash inside a route that DID load
 * is a different thing and still gets the ordinary "Try Again", which remounts
 * the subtree.
 *
 * On the way past, a chunk failure also asks `checkFreshness`: if the build on
 * disk has moved — which is what caused this nine times in ten — the existing
 * update road installs it without anyone pressing anything, or raises the banner
 * when reloading right now would cost something (`canReloadNow`).
 *
 * ## Why the lazy lives outside React
 *
 * It was in a `useMemo`, which is an INFINITE IMPORT LOOP while the Suspense is
 * above it: the discarded subtree takes its hooks with it, so the memo re-ran on
 * every remount, built another `lazy`, called `load` again and suspended again
 * (nine imports and climbing, then the heap — caught by the gate before this
 * shipped). The inner Suspense means that can no longer happen here, but the map
 * costs nothing and cannot loop however the tree above it is rearranged. It is
 * keyed by the route's NAME, a constant at every call site — unlike the loader,
 * which a caller could reasonably write as an inline arrow.
 */

/**
 * The three engines' words for "that module did not arrive", plus the MIME
 * complaint that the SPA fallback specifically produces. Chrome: "Failed to
 * fetch dynamically imported module: <url>" and "Failed to load module script:
 * Expected a JavaScript module script but the server responded with a MIME type
 * of text/html". Firefox: "error loading dynamically imported module". Safari:
 * "Importing a module script failed".
 *
 * A wording that is not here is not a mistake that shows: the route still gets
 * an error screen, it just offers a retry that cannot work instead of a reload
 * that can. Which is why the list is a gate assertion rather than a comment.
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

/** The lazy for this route, made once and then held across every remount. */
function chunkFor(name: string, load: Loader): Chunk {
    const held = chunks.get(name);
    if (held) return held;
    const made: Chunk = { attempt: 0, Component: lazy(load as never) };
    chunks.set(name, made);
    return made;
}

/** Start again from a fresh lazy — for a route that loaded and then crashed. */
function remountChunk(name: string, load: Loader): void {
    const held = chunks.get(name);
    chunks.set(name, { attempt: (held?.attempt ?? 0) + 1, Component: lazy(load as never) });
}

/**
 * The screen for a route that was not downloaded. It does not say "something
 * went wrong", because nothing did: the app was rebuilt while this page was
 * open, which is ordinary, and the one useful sentence is what to do about it.
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
                {/* `text-white`, never `text-accent-fg`: on a FILL, `accent-fg`
                    is the accent itself — measured here as rgb(35,175,251) on
                    rgb(3,105,161), about 2.6:1 — and the label all but vanishes.
                    Every other filled accent button in the app says white. */}
                <button
                    onClick={onReload}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-accent hover:brightness-95 text-white rounded-lg transition text-sm font-medium"
                >
                    <RefreshCw className="w-4 h-4" aria-hidden="true" />
                    {t("Reload")}
                </button>
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
    /** Shown while the chunk is on the wire. Deliberately blank by default: a
     *  chunk off the local disk arrives in a few milliseconds, and a spinner
     *  that flashes for one frame reads as the app stuttering. */
    pending?: ReactNode;
}

export default function RouteChunk<P extends object>({ name, load, props, fallback, pending }: RouteChunkProps<P>) {
    // Nothing is kept here — the map is the state. This only asks React for the
    // render in which the new chunk is read.
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    const chunk = chunkFor(name, load as Loader);
    const Component = chunk.Component;

    return (
        <ErrorBoundary
            key={chunk.attempt}
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
