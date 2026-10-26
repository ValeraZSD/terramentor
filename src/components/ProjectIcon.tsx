// src/components/ProjectIcon.tsx — a project's icon, drawn the same on every
// device.
//
// An emoji is whatever the operating system's font says it is: the same 📚 is
// a different picture on Windows, macOS, Android and a Linux box with no
// colour-emoji font (where it is a box). So a project's icon is one of OUR
// drawings — lucide's, bundled, stroked in the colour the surface asks for —
// and `projects.icon` stores its NAME.
//
// A stored value is read through `iconName`, which also knows the emoji and
// preset names an older value may hold, so such a project draws as the matching
// drawing. A value it does not know (a custom emoji or letter) is still drawn
// as typed: it was the learner's own choice, and dropping it would be a silent
// loss.
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
import { k } from '../i18n';

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
    { name: 'folder', Icon: Folder, label: k("Folder") },
    { name: 'book', Icon: BookOpen, label: k("Book") },
    { name: 'graduation', Icon: GraduationCap, label: k("Graduation cap") },
    { name: 'idea', Icon: Lightbulb, label: k("Light bulb") },
    { name: 'target', Icon: Target, label: k("Target") },
    { name: 'star', Icon: Star, label: k("Star") },
    { name: 'heart', Icon: Heart, label: k("Heart") },
    { name: 'trophy', Icon: Trophy, label: k("Trophy") },

    { name: 'notebook', Icon: NotebookPen, label: k("Notebook") },
    { name: 'library', Icon: Library, label: k("Library") },
    { name: 'pen', Icon: PenLine, label: k("Pen") },
    { name: 'bookmark', Icon: Bookmark, label: k("Bookmark") },
    { name: 'puzzle', Icon: Puzzle, label: k("Puzzle") },
    { name: 'flag', Icon: Flag, label: k("Flag") },
    { name: 'tools', Icon: Wrench, label: k("Wrench") },
    { name: 'check', Icon: CircleCheck, label: k("Check mark") },

    { name: 'brain', Icon: Brain, label: k("Brain") },
    { name: 'testtube', Icon: TestTube, label: k("Test tube") },
    { name: 'flask', Icon: FlaskConical, label: k("Flask") },
    { name: 'microscope', Icon: Microscope, label: k("Microscope") },
    { name: 'dna', Icon: Dna, label: k("DNA") },
    { name: 'atom', Icon: Atom, label: k("Atom") },
    { name: 'magnet', Icon: Magnet, label: k("Magnet") },
    { name: 'telescope', Icon: Telescope, label: k("Telescope") },

    { name: 'calculator', Icon: Calculator, label: k("Calculator") },
    { name: 'sigma', Icon: Sigma, label: k("Sigma") },
    { name: 'ruler', Icon: Ruler, label: k("Ruler") },
    { name: 'chart', Icon: ChartLine, label: k("Chart") },
    { name: 'code', Icon: Code, label: k("Code") },
    { name: 'terminal', Icon: SquareTerminal, label: k("Terminal") },
    { name: 'cpu', Icon: Cpu, label: k("Chip") },
    { name: 'robot', Icon: Bot, label: k("Robot") },

    { name: 'globe', Icon: Globe, label: k("Globe") },
    { name: 'languages', Icon: Languages, label: k("Languages") },
    { name: 'map', Icon: MapIcon, label: k("Map") },
    { name: 'planet', Icon: Orbit, label: k("Orbit") },
    { name: 'rocket', Icon: Rocket, label: k("Rocket") },
    { name: 'mountain', Icon: Mountain, label: k("Mountain") },
    { name: 'leaf', Icon: Leaf, label: k("Leaf") },
    { name: 'sprout', Icon: Sprout, label: k("Sprout") },

    { name: 'palette', Icon: Palette, label: k("Palette") },
    { name: 'brush', Icon: Brush, label: k("Brush") },
    { name: 'camera', Icon: Camera, label: k("Camera") },
    { name: 'music', Icon: Music, label: k("Music") },
    { name: 'guitar', Icon: Guitar, label: k("Guitar") },
    { name: 'mic', Icon: Mic, label: k("Microphone") },
    { name: 'theater', Icon: Drama, label: k("Theatre") },
    { name: 'film', Icon: Clapperboard, label: k("Film") },

    { name: 'briefcase', Icon: Briefcase, label: k("Briefcase") },
    { name: 'money', Icon: Coins, label: k("Coins") },
    { name: 'scale', Icon: Scale, label: k("Scales") },
    { name: 'museum', Icon: Landmark, label: k("Landmark") },
    { name: 'hospital', Icon: Hospital, label: k("Hospital") },
    { name: 'stethoscope', Icon: Stethoscope, label: k("Stethoscope") },
    { name: 'chef', Icon: ChefHat, label: k("Chef") },
    { name: 'car', Icon: Car, label: k("Car") },

    { name: 'dumbbell', Icon: Dumbbell, label: k("Dumbbell") },
    { name: 'bike', Icon: Bike, label: k("Bicycle") },
    { name: 'gamepad', Icon: Gamepad2, label: k("Game controller") },
    { name: 'dice', Icon: Dices, label: k("Dice") },
    { name: 'smile', Icon: Smile, label: k("Smile") },
    { name: 'zap', Icon: Zap, label: k("Lightning") },
    { name: 'fire', Icon: Flame, label: k("Flame") },
    { name: 'history', Icon: ScrollText, label: k("Scroll") },
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
 *  The emoji presentation selector (U+FE0F) is ignored: `❤️` and `❤` are both
 *  possible, depending on where the value was typed. */
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
