/**
 * Read aloud with the voices the computer already has (`speechSynthesis`).
 *
 * LOCAL VOICES ONLY. A browser may list voices that are a network service
 * (Edge's "Online (Natural)" voices, Chrome's Google voices): speaking with one
 * sends the text of the card to that service, which a local-first app must not
 * do behind a speaker icon. Only voices with `localService` are offered, and
 * when the content's language has none the learner is told so in plain words,
 * never handed a voice for another language that would mispronounce every word.
 *
 * One utterance at a time, app-wide: pressing a second button stops the first.
 * The button that is speaking is a tiny external store, so every button can
 * show Stop on itself and Read aloud everywhere else.
 */

let speakingId: string | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

export const speechAvailable = (): boolean =>
    typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';

export function subscribeSpeaking(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export const currentSpeaker = (): string | null => speakingId;

/** The installed voices that run on this computer, for a language tag
 *  (`nl`, `pt-BR`). An exact region match first, then the language alone; the
 *  system's default voice first within each. */
export function localVoicesFor(lang: string | null | undefined): SpeechSynthesisVoice[] {
    if (!speechAvailable() || !lang) return [];
    const want = lang.toLowerCase().replace('_', '-');
    const base = want.split('-')[0];
    const local = window.speechSynthesis.getVoices().filter(v => v.localService);
    const tag = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace('_', '-');
    const rank = (v: SpeechSynthesisVoice) => (tag(v) === want ? 0 : 1) * 2 + (v.default ? 0 : 1);
    return local.filter(v => tag(v).split('-')[0] === base).sort((a, b) => rank(a) - rank(b));
}

/** Every local voice, for the settings line that says what is installed. */
export const localVoices = (): SpeechSynthesisVoice[] =>
    speechAvailable() ? window.speechSynthesis.getVoices().filter(v => v.localService) : [];

/** Calls `onChange` when the voice list arrives or changes (it loads late). */
export function watchVoices(onChange: () => void): () => void {
    if (!speechAvailable()) return () => {};
    const synth = window.speechSynthesis;
    synth.addEventListener?.('voiceschanged', onChange);
    return () => synth.removeEventListener?.('voiceschanged', onChange);
}

/** Resolves once the browser has listed its voices (Chromium lists none until
 *  `voiceschanged`), or after a second and a half, whichever is first: an
 *  empty list then is a computer with no voices, not one still loading. */
export function voicesReady(): Promise<void> {
    if (!speechAvailable() || window.speechSynthesis.getVoices().length) return Promise.resolve();
    return new Promise(resolve => {
        const stop = watchVoices(() => { stop(); clearTimeout(timer); resolve(); });
        const timer = setTimeout(() => { stop(); resolve(); }, 1500);
    });
}

export function stopSpeaking(): void {
    if (!speechAvailable()) return;
    window.speechSynthesis.cancel();
    if (speakingId !== null) { speakingId = null; notify(); }
}

/**
 * Speak `text` in `lang` at `ratePct` percent. Returns 'no-voice' when the
 * computer has no local voice for the language (nothing is spoken), else
 * 'speaking'.
 */
export function speak(id: string, text: string, lang: string, ratePct: number): 'speaking' | 'no-voice' | 'unavailable' {
    if (!speechAvailable()) return 'unavailable';
    const voice = localVoicesFor(lang)[0];
    if (!voice) return 'no-voice';
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = Math.max(0.5, Math.min(2, ratePct / 100));
    const done = () => { if (speakingId === id) { speakingId = null; notify(); } };
    u.onend = done;
    u.onerror = done;
    speakingId = id;
    notify();
    synth.speak(u);
    return 'speaking';
}

/**
 * The words of an element as a listener should hear them: text a screen
 * reader would read, without the controls inside it, without anything hidden
 * from assistive technology (KaTeX's visual copy of a formula, decorative
 * glyphs), and without a formula's TeX source. Blocks become sentence breaks.
 */
export function speakableText(root: HTMLElement): string {
    const parts: string[] = [];
    const skip = (el: Element) =>
        el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('data-read-skip')
        || /^(BUTTON|SCRIPT|STYLE|ANNOTATION|NOSCRIPT|TEMPLATE)$/i.test(el.tagName)
        || (el instanceof HTMLElement && el.hidden);
    const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent ?? ''); return; }
        if (!(node instanceof Element) || skip(node)) return;
        const block = node instanceof HTMLElement && /^(P|DIV|LI|H[1-6]|TR|BLOCKQUOTE|PRE|SECTION|ARTICLE|BR|DT|DD)$/.test(node.tagName);
        if (block) parts.push('\n');
        for (const child of Array.from(node.childNodes)) walk(child);
        if (block) parts.push('\n');
    };
    walk(root);
    return parts.join('').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
