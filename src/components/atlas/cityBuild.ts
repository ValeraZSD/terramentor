/**
 * Every country's cities for one atlas, built once and shared.
 *
 * Built in a worker (`citiesWorker.ts`) so the map opens and turns while it
 * works; where no worker can start (a test page, a browser that refuses one)
 * the same function runs here, after the first frame has been drawn.
 *
 * Kept for the last atlas asked for, not per map: the Map and Terra are the
 * same planet, and switching between them, or filming a course while the page
 * shows it, must not cut every country again. The key is the land itself —
 * every territory and every topic's place — so a rebuilt atlas that moved
 * nothing reuses the answer, and one that moved anything does not.
 */
import { CountryCities, buildCities } from './globeCities';
import { Vec3 } from './globeProjection';
import { Territory } from './globeTerritories';

export type CityMap = Map<number, CountryCities>;
export interface CityRegion { id: number; u: Vec3; topics: { id: number; u: Vec3 }[] }

let done: { key: string; cities: CityMap } | null = null;
let running: { key: string; job: Promise<CityMap> } | null = null;
/** The atlas last asked about. Only its cities are kept: a slower build for
 *  one already replaced must not overwrite them when it finally lands. */
let wanted: string | null = null;

/** A short, stable name for one set of places (FNV-1a over the numbers). */
export function cityKey(territories: Territory[], regions: CityRegion[]): string {
    let h = 0x811c9dc5;
    const mix = (n: number) => {
        // Rounded: a place that moved less than this moved nowhere a reader sees.
        h ^= Math.round(n * 1e6) | 0;
        h = Math.imul(h, 0x01000193);
    };
    for (const t of territories) {
        mix(t.id);
        // Every coordinate: a coast redrawn with the same number of points
        // and the same ends is still another coast (some 100,000 numbers, a
        // millisecond, once per atlas).
        for (const l of t.loops) { mix(l.pts.length); for (let i = 0; i < l.pts.length; i++) mix(l.pts[i]); }
    }
    for (const r of regions) {
        mix(r.id); mix(r.u[0]); mix(r.u[1]); mix(r.u[2]);
        for (const t of r.topics) { mix(t.id); mix(t.u[0]); mix(t.u[1]); mix(t.u[2]); }
    }
    return `${territories.length}:${regions.length}:${(h >>> 0).toString(36)}`;
}

/** The cities already built for this key, or null. */
export function citiesReady(key: string): CityMap | null {
    wanted = key;
    return done?.key === key ? done.cities : null;
}

function onThisThread(territories: Territory[], regions: CityRegion[]): Promise<CityMap> {
    return new Promise((resolve, reject) => {
        // A throw inside the timer would otherwise leave this promise, and every
        // map waiting on it, unsettled for good.
        setTimeout(() => {
            try { resolve(buildCities(territories, regions)); } catch (err) { reject(err); }
        }, 0);
    });
}

function inWorker(territories: Territory[], regions: CityRegion[], key: string): Promise<CityMap> {
    if (typeof Worker === 'undefined') return onThisThread(territories, regions);
    return new Promise((resolve, reject) => {
        let worker: Worker;
        try {
            worker = new Worker(new URL('./citiesWorker.ts', import.meta.url), { type: 'module' });
        } catch {
            resolve(onThisThread(territories, regions));
            return;
        }
        // The worker could not run at all (refused, or failed to load): the
        // page's thread does the same work instead.
        worker.onerror = () => {
            worker.terminate();
            resolve(onThisThread(territories, regions));
        };
        worker.onmessage = (e: MessageEvent) => {
            if (e.data?.key !== key) return;
            worker.terminate();
            // A build that failed in the worker would fail the same way here,
            // after seconds of a page that does not turn: that is the answer.
            if (e.data.type === 'done') resolve(e.data.cities as CityMap);
            else reject(new Error(e.data.message || 'the cities could not be built'));
        };
        worker.postMessage({
            key,
            territories: territories.map(t => ({ id: t.id, loops: t.loops })),
            regions,
        });
    });
}

/** Every country's cities for these places: at once if built, else when ready. */
export function citiesFor(territories: Territory[], regions: CityRegion[], key = cityKey(territories, regions)): Promise<CityMap> {
    const ready = citiesReady(key);
    if (ready) return Promise.resolve(ready);
    if (running?.key === key) return running.job;
    const job = inWorker(territories, regions, key).then(
        cities => {
            if (wanted === key) done = { key, cities };
            if (running?.key === key) running = null;
            return cities;
        },
        err => {
            // Forgotten, so the next map of this atlas asks again rather than
            // inheriting a promise that has already failed.
            if (running?.key === key) running = null;
            throw err;
        });
    running = { key, job };
    return job;
}
