import { DEFAULT_PACE, HOLD_MAX_MS, ReplayPace, SPEED_MAX, SPEED_MIN } from './coursePaths';

/**
 * What the reader has decided about the atlas VIEWER — the replay's pace, what
 * the map is allowed to print on itself, and the shape of a video made of it.
 *
 * One object and one stored key rather than five, because it is one panel and
 * every value in it is read by the same two components: five keys would be five
 * round trips on "reset to defaults" and five chances for a half-applied reset.
 * `fsrs_params` already stores JSON in a setting, so this is not a new shape.
 *
 * It is a PREFERENCE, like `atlas_surface` and `atlas_color_mode` beside it: a
 * reader who slowed the replay down to read the topic names wants it slow
 * tomorrow, and a video rendered at 9:16 for a phone is almost never a one-off.
 * It belongs to the viewer and not to a course — the same dials on every course
 * on both surfaces.
 *
 * Everything here is normalised on the way IN (`normalizeAtlasSettings`) rather
 * than trusted, because the value arrives as text from a database that a
 * different build wrote: an unknown aspect must fall back to a drawable one the
 * way an unknown `atlas_surface` falls back to the flat map, and a speed of 0
 * would divide the replay's beat into an arrow that never lands.
 */
export interface AtlasSettings {
    /** ×1 is the built-in pace; higher is quicker. */
    speed: number;
    /** Extra milliseconds the arrow stands on each topic before leaving. */
    holdMs: number;
    /** Whether the regions print their names — the big blobs' labels. */
    regionNames: boolean;
    /** Frames a second in a rendered video. */
    fps: number;
    /** The video frame's shape. */
    aspect: AspectId;
    /** …and its SHORT edge in pixels, which with the aspect gives the frame. */
    resolution: number;
    /** A video file, or a GIF — which carries its own size and rate (`GIF_RESOLUTION`). */
    output: OutputId;
}

export type AspectId = '16:9' | '9:16' | '1:1';
export type OutputId = 'video' | 'gif';
export const OUTPUTS: OutputId[] = ['video', 'gif'];

/**
 * A GIF's frame is fixed rather than a choice, and small, because a GIF is 256
 * colours and LZW with no motion compression: a following camera changes every
 * pixel of every frame. Measured on the Physics journey at ×3 (13 s): 854×480
 * at 15 fps was 8.8 MB on the map; 712×400 at 12 fps is 6.5 MB on Terra, where
 * a 1280×720 WebM of the same film is 3.1 MB. So a GIF is picked for WHERE it
 * plays, never for its size — and fewer colours do not buy much back (63
 * instead of 255 saved 6%), nor does writing unchanged pixels as transparent
 * (it grew the file 8%: a turning planet leaves almost none unchanged, and the
 * holes break the runs LZW lives on). It is rendered AT this size rather
 * than recorded at the video's and shrunk — the frame is the preview scaled
 * (`atlasCapture.ts`), so the picture is the same either way, and drawing
 * 1920×1080 only to throw most of it away is what makes a replay stutter.
 */
export const GIF_RESOLUTION = 400;
export const GIF_FPS = 12;

/**
 * The frame shapes on offer, and deliberately only three: the one a desktop
 * screen is, the one a phone held upright is, and the one every feed crops to
 * anyway. A free ratio field would be a number to get wrong for a picture whose
 * whole content is a camera move.
 *
 * `w`/`h` are the ratio, not a size — the size comes from `resolution` below,
 * so "portrait" and "1080" are two independent decisions rather than six
 * presets that go stale the moment a fourth is wanted.
 */
export const ASPECTS: { id: AspectId; w: number; h: number }[] = [
    { id: '16:9', w: 16, h: 9 },
    { id: '9:16', w: 9, h: 16 },
    { id: '1:1', w: 1, h: 1 },
];

/** Frames a second. 24 is film, 30 is the web's default, 60 is for a pan. */
export const FPS_CHOICES = [24, 30, 60];
/**
 * The frame's SHORT edge, in pixels. 720 for a quick one, 1080 for the one you
 * post.
 *
 * Short rather than long, because that is what the labels on the control mean
 * everywhere else: 1080p is 1920×1080 in landscape and 1080×1920 on a phone, and
 * in both of those the 1080 is the smaller number. Read as the LONG edge it
 * builds a "1080p" that is 1080×608 — a real frame, a valid file, and not the
 * one anybody asked for.
 */
export const RESOLUTIONS = [720, 1080];

export const DEFAULT_ATLAS_SETTINGS: AtlasSettings = {
    speed: DEFAULT_PACE.speed,
    holdMs: DEFAULT_PACE.holdMs,
    regionNames: true,
    fps: 30,
    aspect: '16:9',
    resolution: 1080,
    output: 'video',
};

/** The stored key. One row, one JSON object. */
export const ATLAS_SETTINGS_KEY = 'atlas_viewer';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const numberOr = (v: unknown, fallback: number) =>
    (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * Read a stored value into something the viewer can draw with.
 *
 * Takes the raw setting — a JSON string, an already-parsed object, null, or
 * whatever a future build put there — and returns a complete, in-range
 * `AtlasSettings` every time. It never throws and never returns a partial: a
 * map with no speed is a map with no replay.
 */
export function normalizeAtlasSettings(raw: unknown): AtlasSettings {
    let value: any = raw;
    if (typeof raw === 'string') {
        try { value = JSON.parse(raw); } catch { value = null; }
    }
    if (!value || typeof value !== 'object') return { ...DEFAULT_ATLAS_SETTINGS };
    const d = DEFAULT_ATLAS_SETTINGS;
    return {
        speed: clamp(numberOr(value.speed, d.speed), SPEED_MIN, SPEED_MAX),
        holdMs: Math.round(clamp(numberOr(value.holdMs, d.holdMs), 0, HOLD_MAX_MS)),
        // Absent means the default, and the default is ON — a map whose places
        // have no names is a choice, never something a missing row does to you.
        regionNames: value.regionNames === undefined ? d.regionNames : !!value.regionNames,
        fps: FPS_CHOICES.includes(value.fps) ? value.fps : d.fps,
        aspect: ASPECTS.some(a => a.id === value.aspect) ? value.aspect : d.aspect,
        resolution: RESOLUTIONS.includes(value.resolution) ? value.resolution : d.resolution,
        output: OUTPUTS.includes(value.output) ? value.output : d.output,
    };
}

/** The frame a render actually produces: the chosen size for a video, the fixed one for a GIF. */
export const outputFrame = (s: AtlasSettings) =>
    frameSize(s.aspect, s.output === 'gif' ? GIF_RESOLUTION : s.resolution);
/** …and its rate. */
export const outputFps = (s: AtlasSettings) => (s.output === 'gif' ? GIF_FPS : s.fps);

/** Is this the shipped default in every respect? — what "Reset" asks. */
export const isDefaultAtlasSettings = (s: AtlasSettings) =>
    (Object.keys(DEFAULT_ATLAS_SETTINGS) as (keyof AtlasSettings)[])
        .every(k => s[k] === DEFAULT_ATLAS_SETTINGS[k]);

/** The two dials the replay's arithmetic actually takes. */
export const paceOf = (s: AtlasSettings): ReplayPace => ({ speed: s.speed, holdMs: s.holdMs });

/**
 * The pixel size of one video frame: the short edge is `resolution`, the long
 * one follows the shape.
 *
 * Both edges are forced EVEN: every block-based encoder behind `MediaRecorder`
 * works in macroblocks, and an odd dimension is either refused outright or
 * quietly rounded — which produces a file whose size is not the size that was
 * asked for.
 */
export function frameSize(aspect: AspectId, resolution: number): { width: number; height: number } {
    const a = ASPECTS.find(x => x.id === aspect) ?? ASPECTS[0];
    const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
    return a.w >= a.h
        ? { width: even((resolution * a.w) / a.h), height: even(resolution) }
        : { width: even(resolution), height: even((resolution * a.h) / a.w) };
}
