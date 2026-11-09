/**
 * The cities, cut off the page's thread.
 *
 * Every country of a whole library is seconds of work (2.2 s on 2,491 topics
 * in 129 countries), and on the main thread that is seconds of a map that does
 * not turn. The page hands over the territories and the topics once per atlas
 * and gets every country's cities back in one message (`cityBuild.ts`).
 */
import { buildCities } from './globeCities';

const post = (msg: unknown) =>
    (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg);

self.onmessage = (e: MessageEvent) => {
    const m = e.data;
    try {
        post({ type: 'done', key: m.key, cities: buildCities(m.territories, m.regions) });
    } catch (err: any) {
        post({ type: 'error', key: m.key, message: err?.message || String(err) });
    }
};
