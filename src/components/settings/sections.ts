import type { ComponentType } from 'react';
import { BookOpen, Cpu, Globe, Library, Palette, ShieldCheck } from 'lucide-react';
import { k } from '../../i18n';

/**
 * The six parts of Settings, in the order a phone lists them and a wide window
 * rails them. Each is an address, `/settings#<id>`.
 *
 * `summary` is the line under the name on the phone's list: what someone looks
 * for, in their words, so "password" is findable without opening four sections
 * (Android's and WhatsApp's settings lists carry the same line).
 */
export type SettingsSection = 'general' | 'learning' | 'ai' | 'web' | 'devices' | 'library';

export const SETTINGS_SECTIONS: {
    id: SettingsSection;
    label: string;
    summary: string;
    icon: ComponentType<{ className?: string }>;
}[] = [
    { id: 'general', label: k("General"), summary: k("Theme, colours, text size, language"), icon: Palette },
    { id: 'learning', label: k("Learning"), summary: k("Mastery checks, your feed, your profile"), icon: BookOpen },
    { id: 'ai', label: k("AI & Models"), summary: k("Connect an AI, choose its model"), icon: Cpu },
    { id: 'web', label: k("Web & research"), summary: k("Answers from the web, search links"), icon: Globe },
    { id: 'devices', label: k("Devices & security"), summary: k("Your phone, other devices, password"), icon: ShieldCheck },
    { id: 'library', label: k("Library & about"), summary: k("Import, export, version, updates"), icon: Library },
];

/** Addresses from before the six, still followed: a bookmark, a link in an
 *  older build's notice. "Data" held the files, the devices and the password;
 *  its files are the larger half. */
const RENAMED: Record<string, SettingsSection> = { search: 'web', data: 'library' };

/** The section an address's first hash segment names, or null for none. */
export function sectionOf(tab: string): SettingsSection | null {
    if (SETTINGS_SECTIONS.some(s => s.id === tab)) return tab as SettingsSection;
    return isRenamedSection(tab) ? RENAMED[tab] : null;
}

/** True when the segment is an old name that should be rewritten in place.
 *  Own keys only: `#constructor` or `#toString` is not an old section. */
export function isRenamedSection(tab: string): boolean {
    return Object.prototype.hasOwnProperty.call(RENAMED, tab);
}

/**
 * The width, in rem, below which Settings is one pane at a time: the list,
 * then a section. Two panes need a 12rem rail, a 2rem gap and a column that
 * still reads (~31rem). Measured on Settings' own box, never the viewport:
 * a narrow desktop window gets the list, a phone on its side gets the rail.
 */
export const TWO_PANE_REM = 45;
