import { useState, useRef, useEffect } from 'react';
import {
    Youtube, Search, Globe, BookOpen, FileText, GraduationCap, Library,
    Microscope, Code, MessageCircle, Video, Link2, Sigma, ChevronDown,
} from 'lucide-react';
import { useStore } from '../store';
import { SearchProvider, ProviderSurface, buildProviderUrl, buildQuery, providerLabel, providersFor } from '../utils/searchProviders';
import { useTranslation } from 'react-i18next';

/**
 * "Look this up elsewhere" — one button per enabled search provider.
 *
 * This was a hardcoded YouTube button. YouTube is one opinion about where to go
 * when you want to hear someone explain a topic out loud, and it is the wrong
 * one for a law student (case database), a chemist (PubChem), or anyone whose
 * network does not reach it. So the destinations are configurable
 * (server/searchProviders.js) — pure JSON manifests, no code, edited in
 * Settings → Search links.
 *
 * Behaviour is unchanged when exactly one provider is on, which is the shipped
 * default: a single labelled link. Two or more collapse into a small menu rather
 * than a row of buttons, because this is a detour from studying and should not
 * out-compete the material for attention.
 *
 * Nothing is requested until the learner clicks. An offline or fully-local setup
 * is unaffected — the link simply will not resolve.
 */

const ICONS: Record<string, typeof Search> = {
    youtube: Youtube,
    search: Search,
    globe: Globe,
    book: BookOpen,
    'file-text': FileText,
    'graduation-cap': GraduationCap,
    library: Library,
    microscope: Microscope,
    sigma: Sigma,
    code: Code,
    'message-circle': MessageCircle,
    video: Video,
    link: Link2,
};

/** The provider's icon, or a magnifier for a name this build does not bundle.
 *  Exported so Settings draws the same icon the study surface will. */
export function iconFor(name: string) {
    return ICONS[name] || Search;
}

/** Every icon a manifest may name, in the order Settings offers them. Derived
 *  from the map above rather than retyped: a fourth copy of this list (the
 *  server's `PROVIDER_ICONS` and the map are already two) would be one nobody
 *  keeps in step, and `search-provider-gates.mjs` only pins the other two. */
export const PROVIDER_ICON_NAMES = Object.keys(ICONS);

interface Props {
    /** The topic to search for — normally a node title. */
    title: string;
    /** Project or parent topic, used only to disambiguate a thin title. */
    context?: string | null;
    /** Which surface this is, so a provider can opt out of one of them. */
    surface?: ProviderSurface;
    /** ISO code of the project's study language, for providers using {lang}. */
    lang?: string;
    /**
     * Project this topic belongs to, used only to resolve `lang` when it isn't
     * passed. The feed spans projects, so it must say which one; inside a
     * workspace the store's current project is already the right answer.
     */
    projectId?: number | null;
    /** `icon` for a bare icon button (tight headers), `full` for a labelled one. */
    variant?: 'icon' | 'full';
    className?: string;
}

export default function ExternalSearchButton({
    title, context, surface = 'topic', lang = '', projectId, variant = 'full', className = '',
}: Props) {
    const { t } = useTranslation();
    const searchProviders = useStore(s => s.searchProviders);
    // `{lang}` used to resolve to "en" on every surface, because no caller ever
    // passed it — a provider template built for the project's declared study
    // language (content_language) silently searched English for a Dutch course.
    // Resolve it here so every call site gets it without plumbing a prop.
    const projects = useStore(s => s.projects);
    const currentProjectId = useStore(s => s.currentProjectId);
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

    const owner = projectId ?? currentProjectId;
    const resolvedLang = lang || projects.find(p => p.id === owner)?.content_language || '';

    const providers = providersFor(searchProviders as SearchProvider[], surface);
    const query = buildQuery(title, context);

    useEffect(() => {
        if (!open) return;
        const close = (e: MouseEvent) => {
            if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', close);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    // No provider enabled is a legitimate configuration, not an error state.
    if (providers.length === 0) return null;

    const linkFor = (a: SearchProvider) => buildProviderUrl(a, query, resolvedLang);

    if (providers.length === 1) {
        const provider = providers[0];
        const href = linkFor(provider);
        // A manifest that fails client-side validation renders nothing rather
        // than a dead control — same contract as the tutor's [[open:…]] markers.
        if (!href) return null;
        const Icon = iconFor(provider.icon);
        const label = t('{{provider}} — "{{title}}" (opens in a new tab)', { provider: providerLabel(provider), title });

        if (variant === 'icon') {
            return (
                <a
                    href={href} target="_blank" rel="noopener noreferrer"
                    title={providerLabel(provider)} aria-label={label}
                    className={`shrink-0 p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-accent-fg hover:bg-accent/10 transition ${className}`}
                >
                    <Icon className="w-4 h-4" aria-hidden="true" />
                </a>
            );
        }
        return (
            <a
                href={href} target="_blank" rel="noopener noreferrer" aria-label={label}
                className={`inline-flex items-center gap-1.5 px-3 py-2 min-h-11 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-accent-fg hover:bg-accent/10 transition ${className}`}
            >
                <Icon className="w-4 h-4" aria-hidden="true" />
                {providerLabel(provider)}
            </a>
        );
    }

    return (
        <div ref={wrapRef} className={`relative inline-block ${className}`}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t("Look up \"{{title}}\" elsewhere", { title })}
                title={t("Look this up elsewhere")}
                className={variant === 'icon'
                    ? 'shrink-0 p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-accent-fg hover:bg-accent/10 transition'
                    : 'inline-flex items-center gap-1.5 px-3 py-2 min-h-11 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-accent-fg hover:bg-accent/10 transition'}
            >
                <Search className="w-4 h-4" aria-hidden="true" />
                {variant === 'full' && <>{t("Look it up")}<ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /></>}
            </button>

            {open && (
                <div
                    role="menu"
                    className="absolute right-0 z-30 mt-1 min-w-52 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg py-1"
                >
                    {providers.map(provider => {
                        const href = linkFor(provider);
                        if (!href) return null;
                        const Icon = iconFor(provider.icon);
                        return (
                            <a
                                key={provider.id}
                                role="menuitem"
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => setOpen(false)}
                                className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                            >
                                <Icon className="w-4 h-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                                {providerLabel(provider)}
                            </a>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
