import type { ConnectionKind } from '../../../api';
import { accentSolidTriplet } from '../../../utils/color.ts';
import { contrastRatio, inkFor, INK_LIGHT } from '../../../../server/iconArt.js';

/**
 * Each company's own colour, for the square that carries its initials.
 *
 * Only a colour the company itself publishes, read on its own page and dated
 * here, never one taken from a logo site, an icon pack or a screenshot: those
 * are someone's guess about a brand. A company whose colour could not be read
 * at its own source stays neutral, with the reason, so the tile is not
 * "fixed" later from one of those sites. Machines (Ollama, a server of the
 * learner's own) are not companies and stay neutral too.
 *
 * Only the square, and only where a service is picked (`ProviderMark`): the
 * app's own look (accent, tint, every surface) stays the learner's, and the
 * saved list keeps the accent square for the connection in use.
 *
 * Guard: tools/provider-colour-gates.mjs.
 */
export type Brand =
    | { colour: string; name: string; source: string; read: string }
    | { colour: null; why: string };

export const BRANDS: Record<ConnectionKind, Brand> = {
    // The brand page names four logo colours; Grape is the one "for light
    // backgrounds" and the only one a white letter reads on (Volt is #C8FF00).
    openrouter: { colour: '#7624F4', name: 'Grape', source: 'https://openrouter.ai/brand/logos/transparent/glyph/svg/glyph-grape.svg', read: '2026-10-13' },
    // Anthropic's own brand-guidelines skill: "Orange: #d97757 - Primary accent".
    anthropic: { colour: '#D97757', name: 'Orange', source: 'https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md', read: '2026-10-13' },
    // One company, so one decision for both tiles.
    chatgpt: { colour: null, why: "OpenAI's brand page (openai.com/brand) refuses automated readers, and nothing else of OpenAI's names a colour." },
    openai: { colour: null, why: "OpenAI's brand page (openai.com/brand) refuses automated readers, and nothing else of OpenAI's names a colour." },
    gemini: { colour: null, why: 'Google publishes no colour for Gemini that could be found; its mark is a gradient.' },
    // The whale in the logo DeepSeek ships in its own repository.
    deepseek: { colour: '#4D6BFE', name: 'logo blue', source: 'https://github.com/deepseek-ai/DeepSeek-LLM/blob/main/images/logo.svg', read: '2026-10-13' },
    zai: { colour: null, why: 'Z.ai (Zhipu) publishes no brand page or colour that could be found on z.ai or bigmodel.cn.' },
    qwen: { colour: null, why: "Neither Qwen nor Alibaba Cloud publishes a brand colour page that could be found; only third-party lists." },
    // The Kimi Brand Book's colour system, "centered around our signature brand
    // blue"; it lists its swatches without names, and this is its brand blue.
    kimi: { colour: '#007CFF', name: 'brand blue', source: 'https://www.kimi.com/en/resources/kimi-brand', read: '2026-10-13' },
    ollama: { colour: null, why: 'A program on this computer, not a company: it keeps the machine icon.' },
    custom: { colour: null, why: "A server of the learner's own, not a company: it keeps the machine icon." },
};

export interface MarkPaint {
    fill: string;
    ink: string;
    /** False when the published colour had to be darkened for its initials. */
    exact: boolean;
}

const toHex = (triplet: string) => '#' + triplet.split(' ').map(n => Number(n).toString(16).padStart(2, '0')).join('');

/**
 * How the square is painted, the same in both themes. The ink is the app
 * icon's (`inkFor`: white or near-black, whichever reads better). A colour
 * neither ink reads at 4.5:1 is darkened just enough for white, the bargain
 * the accent makes (`accentSolidTriplet`), and says so.
 */
export function brandPaint(kind: ConnectionKind): MarkPaint | null {
    const brand = BRANDS[kind];
    if (!brand || brand.colour === null) return null;
    const ink = inkFor(brand.colour);
    if (contrastRatio(brand.colour, ink) >= 4.5) return { fill: brand.colour, ink, exact: true };
    return { fill: toHex(accentSolidTriplet(brand.colour)), ink: INK_LIGHT, exact: false };
}
