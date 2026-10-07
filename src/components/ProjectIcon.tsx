// src/components/ProjectIcon.tsx — a project's icon, drawn the same on every
// device.
//
// Icons were emoji, and an emoji is whatever the operating system's font says
// it is: the same 📚 is a different picture on Windows, macOS, Android and a
// Linux box with no colour-emoji font (where it is a box). So a project's icon
// is one of OUR drawings now — lucide's, bundled, stroked in the colour the
// surface asks for — and `projects.icon` stores its NAME.
//
// Nothing is migrated. A stored value is read through `iconName`, which also
// knows every name and emoji the old picker could store, so an existing
// project draws its old choice as the matching drawing. A value it does not
// know (a custom emoji or letter from the old "Choose another icon…") is still
// drawn as typed: it was the learner's own choice, and dropping it would be a
// silent loss.
import type { LucideIcon } from 'lucide-react';
import {
    Atom, Bike, BookOpen, Bookmark, Bot, Brain, Briefcase, Brush, Calculator, Camera, Car,
    ChartLine, ChefHat, CircleCheck, Clapperboard, Code, Coins, Cpu, Dices, Dna, Drama,
    Dumbbell, FlaskConical, Flag, Flame, Folder, Gamepad2, Globe, GraduationCap, Guitar, Heart,
    Hospital, Landmark, Languages, Leaf, Library, Lightbulb, Magnet, Map as MapIcon, Mic, Microscope,
    Mountain, Music, NotebookPen, Orbit, Palette, PenLine, Puzzle, Rocket, Ruler, Scale,
    ScrollText, Sigma, Smile, Sprout, SquareTerminal, Star, Stethoscope, Target, Telescope,
    TestTube, Trophy, Wrench, Zap,
} from 'lucide-react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { cx } from './ui/vocabulary';

export interface ProjectIconDef {
    /** What `projects.icon` stores. The old picker's forty names are kept as
     *  they were, so a project that stored one draws it unchanged. */
    name: string;
    Icon: LucideIcon;
    /** The tile's accessible name (English, like the stored name). */
    label: string;
}

/** Sixty-four: eight rows of the picker's eight columns, by subject. */
export const PROJECT_ICONS: readonly ProjectIconDef[] = [
    { name: 'folder', Icon: Folder, label: 'Folder' },
    { name: 'book', Icon: BookOpen, label: 'Book' },
    { name: 'graduation', Icon: GraduationCap, label: 'Graduation cap' },
    { name: 'idea', Icon: Lightbulb, label: 'Light bulb' },
    { name: 'target', Icon: Target, label: 'Target' },
    { name: 'star', Icon: Star, label: 'Star' },
    { name: 'heart', Icon: Heart, label: 'Heart' },
    { name: 'trophy', Icon: Trophy, label: 'Trophy' },

    { name: 'notebook', Icon: NotebookPen, label: 'Notebook' },
    { name: 'library', Icon: Library, label: 'Library' },
    { name: 'pen', Icon: PenLine, label: 'Pen' },
    { name: 'bookmark', Icon: Bookmark, label: 'Bookmark' },
    { name: 'puzzle', Icon: Puzzle, label: 'Puzzle' },
    { name: 'flag', Icon: Flag, label: 'Flag' },
    { name: 'tools', Icon: Wrench, label: 'Wrench' },
    { name: 'check', Icon: CircleCheck, label: 'Check' },

    { name: 'brain', Icon: Brain, label: 'Brain' },
    { name: 'testtube', Icon: TestTube, label: 'Test tube' },
    { name: 'flask', Icon: FlaskConical, label: 'Flask' },
    { name: 'microscope', Icon: Microscope, label: 'Microscope' },
    { name: 'dna', Icon: Dna, label: 'DNA' },
    { name: 'atom', Icon: Atom, label: 'Atom' },
    { name: 'magnet', Icon: Magnet, label: 'Magnet' },
    { name: 'telescope', Icon: Telescope, label: 'Telescope' },

    { name: 'calculator', Icon: Calculator, label: 'Calculator' },
    { name: 'sigma', Icon: Sigma, label: 'Sigma' },
    { name: 'ruler', Icon: Ruler, label: 'Ruler' },
    { name: 'chart', Icon: ChartLine, label: 'Chart' },
    { name: 'code', Icon: Code, label: 'Code' },
    { name: 'terminal', Icon: SquareTerminal, label: 'Terminal' },
    { name: 'cpu', Icon: Cpu, label: 'Chip' },
    { name: 'robot', Icon: Bot, label: 'Robot' },

    { name: 'globe', Icon: Globe, label: 'Globe' },
    { name: 'languages', Icon: Languages, label: 'Languages' },
    { name: 'map', Icon: MapIcon, label: 'Map' },
    { name: 'planet', Icon: Orbit, label: 'Orbit' },
    { name: 'rocket', Icon: Rocket, label: 'Rocket' },
    { name: 'mountain', Icon: Mountain, label: 'Mountain' },
    { name: 'leaf', Icon: Leaf, label: 'Leaf' },
    { name: 'sprout', Icon: Sprout, label: 'Sprout' },

    { name: 'palette', Icon: Palette, label: 'Palette' },
    { name: 'brush', Icon: Brush, label: 'Brush' },
    { name: 'camera', Icon: Camera, label: 'Camera' },
    { name: 'music', Icon: Music, label: 'Music' },
    { name: 'guitar', Icon: Guitar, label: 'Guitar' },
    { name: 'mic', Icon: Mic, label: 'Microphone' },
    { name: 'theater', Icon: Drama, label: 'Theatre' },
    { name: 'film', Icon: Clapperboard, label: 'Film' },

    { name: 'briefcase', Icon: Briefcase, label: 'Briefcase' },
    { name: 'money', Icon: Coins, label: 'Coins' },
    { name: 'scale', Icon: Scale, label: 'Scales' },
    { name: 'museum', Icon: Landmark, label: 'Landmark' },
    { name: 'hospital', Icon: Hospital, label: 'Hospital' },
    { name: 'stethoscope', Icon: Stethoscope, label: 'Stethoscope' },
    { name: 'chef', Icon: ChefHat, label: 'Chef' },
    { name: 'car', Icon: Car, label: 'Car' },

    { name: 'dumbbell', Icon: Dumbbell, label: 'Dumbbell' },
    { name: 'bike', Icon: Bike, label: 'Bicycle' },
    { name: 'gamepad', Icon: Gamepad2, label: 'Game controller' },
    { name: 'dice', Icon: Dices, label: 'Dice' },
    { name: 'smile', Icon: Smile, label: 'Smile' },
    { name: 'zap', Icon: Zap, label: 'Lightning' },
    { name: 'fire', Icon: Flame, label: 'Flame' },
    { name: 'history', Icon: ScrollText, label: 'Scroll' },
];

/** What a project with no icon draws, and what a new one is given. */
export const DEFAULT_PROJECT_ICON = 'folder';

const BY_NAME = new Map(PROJECT_ICONS.map(d => [d.name, d]));

/** What the old emoji picker stored, by value: its forty presets as the emoji
 *  themselves (and, before that, as these names), plus one misspelt name. */
const LEGACY: Record<string, string> = {
    '📁': 'folder', '📚': 'book', '🎓': 'graduation', '💡': 'idea', '🎯': 'target', '⭐': 'star',
    '❤': 'heart', '😊': 'smile', '⚡': 'zap', '🔥': 'fire', '✅': 'check', '🏆': 'trophy',
    '🧠': 'brain', '💻': 'code', '🔢': 'calculator', '🧪': 'testtube', '🔬': 'microscope',
    '🧬': 'dna', '🪐': 'planet', '🚀': 'rocket', '🛠': 'tools', '🤖': 'robot',
    '🎨': 'palette', '📷': 'camera', '🎵': 'music', '🎭': 'theater', '🏛': 'museum', '🌍': 'globe',
    '🌿': 'leaf', '✍': 'pen', '📜': 'history',
    '💼': 'briefcase', '📈': 'chart', '💰': 'money', '🚗': 'car', '🏥': 'hospital', '⚖': 'scale',
    '🍳': 'chef', '💪': 'dumbbell', '🎮': 'gamepad',
    strenght: 'dumbbell',
};

/** The drawing a stored value means, or null for one we have no drawing of.
 *  The emoji presentation selector (U+FE0F) is ignored: `❤️` and `❤` were both
 *  stored, depending on where the value was typed. */
export function iconName(stored: string | null | undefined): string | null {
    const v = (stored || '').replace(/️/g, '').trim();
    if (!v) return DEFAULT_PROJECT_ICON;
    if (BY_NAME.has(v)) return v;
    return LEGACY[v] ?? null;
}

/** The drawing as a picture a canvas can paint (the finished-project poster),
 *  stroked in `colour`; null for a value with no drawing. Rendered through
 *  React into a detached node rather than by a second copy of lucide's paths. */
export async function projectIconImage(icon: string | null | undefined, colour: string, size: number): Promise<HTMLImageElement | null> {
    const def = BY_NAME.get(iconName(icon) ?? '');
    if (!def) return null;
    const host = document.createElement('div');
    const root = createRoot(host);
    flushSync(() => root.render(<def.Icon width={size} height={size} color={colour} strokeWidth={2} />));
    const svg = host.innerHTML;
    root.unmount();
    const img = new Image(size, size);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    return img;
}

/** A project's icon. `className` sizes and colours it (the stroke follows
 *  `currentColor`); a value with no drawing is drawn as its own text, at the
 *  surrounding font size. */
export function ProjectIcon({ icon, className, strokeWidth = 2 }: {
    icon: string | null | undefined;
    className?: string;
    strokeWidth?: number;
}) {
    const def = BY_NAME.get(iconName(icon) ?? '');
    if (def) return <def.Icon className={cx('shrink-0', className)} strokeWidth={strokeWidth} aria-hidden="true" />;
    return <span className="leading-none" aria-hidden="true">{icon}</span>;
}
