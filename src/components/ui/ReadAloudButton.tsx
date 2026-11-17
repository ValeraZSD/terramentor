import { useEffect, useId, useSyncExternalStore, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Square, Volume2 } from 'lucide-react';
import { IconButton } from './Button';
import { useStore } from '../../store';
import { uiLocale } from '../../utils/locale';
import { currentSpeaker, speak, speakableText, speechAvailable, stopSpeaking, subscribeSpeaking, voicesReady } from '../../utils/readAloud';

/** The language's name in the interface language ("Dutch", "Nederlands"). */
function languageName(tag: string): string {
    try { return new Intl.DisplayNames([uiLocale()], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}

/**
 * Read aloud: speaks the element `target` points at, in its own language (the
 * nearest `lang` attribute, which every course surface carries), at the speed
 * set in Settings → Accessibility. Pressed again, it stops. Shown only when
 * the reader turned read-aloud on there and the browser can speak at all.
 */
export default function ReadAloudButton({ target, find, lang, size = 'sm', className }: {
    target?: RefObject<HTMLElement | null>;
    /** For a button that sits in a list and has no ref of its own to point
     *  with: the element to read, found from the button. */
    find?: (button: HTMLButtonElement) => HTMLElement | null;
    /** The content's language when no `lang` attribute is around `target`. */
    lang?: string;
    size?: 'sm' | 'md';
    className?: string;
}) {
    const { t } = useTranslation();
    const on = useStore(s => s.a11y.readAloud);
    const rate = useStore(s => s.a11y.speechRate);
    const addToast = useStore(s => s.addToast);
    const id = useId();
    const speaking = useSyncExternalStore(subscribeSpeaking, currentSpeaker) === id;

    // Whatever this button started ends with it: the card moved on, the
    // question changed, the panel closed.
    useEffect(() => () => { if (currentSpeaker() === id) stopSpeaking(); }, [id]);

    if (!on || !speechAvailable()) return null;

    const press = async (button: HTMLButtonElement) => {
        if (speaking) { stopSpeaking(); return; }
        const el = target?.current ?? find?.(button) ?? null;
        if (!el) return;
        const text = speakableText(el);
        if (!text) return;
        const language = el.closest('[lang]')?.getAttribute('lang') || lang || document.documentElement.lang || 'en';
        await voicesReady();
        const result = speak(id, text, language, rate);
        if (result === 'no-voice') {
            addToast('info', t("This computer has no {{language}} voice installed. Add one in your system's speech settings, then reload the app.", { language: languageName(language) }));
        }
    };

    return (
        <IconButton
            size={size}
            variant="quiet"
            data-read-skip
            className={className}
            onClick={e => { e.stopPropagation(); void press(e.currentTarget); }}
            label={speaking ? t("Stop reading") : t("Read aloud")}
            icon={speaking
                ? <Square className="w-4 h-4" aria-hidden="true" />
                : <Volume2 className="w-4 h-4" aria-hidden="true" />}
        />
    );
}
