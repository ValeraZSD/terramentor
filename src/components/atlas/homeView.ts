/**
 * Where each surface opens: the camera before the reader has touched it.
 *
 * The server holds the planet with its poles on sea and spins the weight of
 * its land to yaw 0 (`faceTheReader` in server/globe.js). That settles the
 * axis; it does not settle the first picture. Facing the weight of the land
 * works for one continent and fails for two: their mean is the sea between
 * them. So each surface asks its own question of the regions here.
 *
 * Both answers depend only on the regions' places and sizes — never on the
 * screen, the frame or the time — so the same library opens the same way.
 */
import { Vec3, faceOn, unit3 } from './globeProjection';
import { reachOf } from './globeTerritories';

export interface HomeRegion { u: Vec3; cap: number }

/** Candidate directions the globe could open facing. */
const VIEW_CANDIDATES = 600;
/** How sharply a view prefers land at its middle over land near its rim. At 1
 *  the score is the land's area on screen (a disc foreshortens by cos), which
 *  can open between two continents; at 8 it opened on the densest one with
 *  half the land out of sight. cos^3 halves at about 37° from the middle and
 *  passes both (`atlas-world-gates.mjs`, `globe-gates.mjs`). */
const VIEW_FOCUS = 3;

function spread(n: number): Vec3[] {
    const golden = Math.PI * (3 - Math.sqrt(5));
    return Array.from({ length: n }, (_, i) => {
        const z = 1 - (2 * i + 1) / n, r = Math.sqrt(Math.max(0, 1 - z * z)), a = i * golden;
        return [Math.cos(a) * r, Math.sin(a) * r, z] as Vec3;
    });
}

/**
 * The globe's opening view: facing the most land, weighted toward the middle
 * of the picture. Each region counts by its cap's area, so it is the ground a
 * reader sees and not a crowd of small regions. Null for a planet with no land.
 */
export function landView(regions: HomeRegion[]): { yaw: number; pitch: number } | null {
    if (!regions.length) return null;
    // Start from the weight of the land — the right answer for one continent,
    // and the tie-break toward the axis the server chose.
    let x = 0, y = 0, z = 0;
    for (const r of regions) {
        const w = 1 - Math.cos(r.cap);
        x += r.u[0] * w; y += r.u[1] * w; z += r.u[2] * w;
    }
    const score = (v: Vec3) => {
        let s = 0;
        for (const r of regions) {
            const c = r.u[0] * v[0] + r.u[1] * v[1] + r.u[2] * v[2];
            if (c > 0) s += (1 - Math.cos(r.cap)) * c ** VIEW_FOCUS;
        }
        return s;
    };
    let best: Vec3 | null = Math.hypot(x, y, z) > 1e-9 ? unit3([x, y, z]) : null;
    let top = best ? score(best) : -Infinity;
    for (const v of spread(VIEW_CANDIDATES)) {
        const s = score(v);
        if (s > top + 1e-12) { top = s; best = v; }
    }
    return best ? faceOn(best) : null;
}

/**
 * The flat map's opening yaw: where its seam — the back of the planet, cut
 * open to unroll it, drawn as the sheet's left and right edges — crosses the
 * least land. A country on the seam is drawn twice, half at each edge. The
 * seam runs pole to pole, and the poles are sea, so the only question is which
 * meridian; of the equally good ones, the one nearest the weight of the land.
 */
export function flatHomeYaw(regions: HomeRegion[]): number {
    if (!regions.length) return 0;
    const at = regions.map(r => ({
        lat: Math.asin(Math.max(-1, Math.min(1, r.u[2]))),
        lon: Math.atan2(r.u[0], r.u[1]),
        reach: r.cap + reachOf(r.cap),
        w: 1 - Math.cos(r.cap),
    }));
    let best = 0, least = Infinity;
    for (let step = 0; step < 360; step++) {
        // Nearest to yaw 0 first: 0, +1°, −1°, +2°… so a tie keeps the
        // server's choice.
        const k = Math.ceil(step / 2) * (step % 2 ? 1 : -1);
        const yaw = (k * Math.PI) / 180;
        const seam = yaw + Math.PI;
        let cut = 0;
        for (const r of at) {
            // How far the region is from the seam's half of the meridian.
            let d = Math.abs(((r.lon - seam + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
            d = d <= Math.PI / 2
                ? Math.asin(Math.min(1, Math.cos(r.lat) * Math.sin(d)))
                : Math.PI / 2 - Math.abs(r.lat);
            if (d < r.reach) cut += r.w * (r.reach - d);
        }
        if (cut < least - 1e-12) { least = cut; best = yaw; }
    }
    return best;
}
