import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Platform / input-capability detection for the UI.
 *
 * Two mistakes this module exists to stop:
 *
 *  1. **Hardcoding Mac keycaps.** `⌘K` is wrong on Windows and Linux, where the
 *     same shortcut is Ctrl+K. The handler already accepts both (`metaKey ||
 *     ctrlKey`); only the *label* was Apple-only.
 *  2. **Using a width breakpoint as a stand-in for "has a keyboard".** A phone
 *     turned 90° is ≥640px wide, so `hidden sm:inline` happily showed keyboard
 *     hints — and hid touch affordances behind `:hover` — on a device with
 *     neither a keyboard nor a hover pointer. Capability is a media *feature*
 *     (`pointer`/`hover`), never a width.
 */

/** True on macOS / iOS / iPadOS — the only platforms whose modifier is ⌘. */
export function isAppleOS(): boolean {
    if (typeof navigator === 'undefined') return false;
    // userAgentData.platform is the non-deprecated source where it exists.
    const uaPlatform = (navigator as Navigator & {
        userAgentData?: { platform?: string };
    }).userAgentData?.platform;
    const raw = uaPlatform || navigator.platform || navigator.userAgent || '';
    return /mac|iphone|ipad|ipod/i.test(raw);
}

/** The label for the "command" modifier on this platform: `⌘` or `Ctrl`. */
export const MOD_KEY = isAppleOS() ? '⌘' : 'Ctrl';

/** `⌘K` on Apple, `Ctrl K` elsewhere. */
export function modShortcut(key: string): string {
    return isAppleOS() ? `⌘${key}` : `Ctrl ${key}`;
}

const KEYBOARD_QUERY = '(pointer: fine)';
const HOVER_QUERY = '(hover: hover) and (pointer: fine)';

function media(query: string): MediaQueryList | null {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    return window.matchMedia(query);
}

function keyboardMedia(): MediaQueryList | null {
    return media(KEYBOARD_QUERY);
}

/**
 * True when the device is driven by a precise pointer — the reliable proxy for
 * "a physical keyboard is attached", and the same signal `AssistantDrawer` uses
 * to decide whether typing is cheap. A touchscreen reports `pointer: coarse`
 * regardless of orientation, which is exactly the case the `sm:` breakpoint got
 * wrong.
 */
export function hasPhysicalKeyboard(): boolean {
    return keyboardMedia()?.matches ?? false;
}

/** True when the pointer can hover — i.e. `:hover` styles are actually reachable. */
export function canHover(): boolean {
    return media(HOVER_QUERY)?.matches ?? false;
}

function subscribeTo(query: string) {
    return (onChange: () => void): (() => void) => {
        const mq = media(query);
        if (!mq) return () => { };
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    };
}

const subscribeKeyboard = subscribeTo(KEYBOARD_QUERY);
const subscribeHover = subscribeTo(HOVER_QUERY);

/**
 * Reactive `hasPhysicalKeyboard()` — re-renders when a keyboard/mouse is
 * attached or detached (a tablet dropped into a keyboard case, a laptop
 * switched to tablet mode), so hints appear and disappear with the hardware.
 */
export function usePhysicalKeyboard(): boolean {
    return useSyncExternalStore(subscribeKeyboard, hasPhysicalKeyboard, () => false);
}

/**
 * The verb for "activate this thing" in prose: `Click` with a mouse, `Tap` with
 * a finger. Reactive, so it follows the pointer actually in use.
 *
 * TRANSLATED here, not at the call site. It is interpolated into sentences that
 * are themselves keys ("{{pointerVerb}} to edit"), so an English verb handed to
 * a Russian sentence produced "Click, чтобы изменить" — half a sentence in
 * each language, in four places.
 */
export function usePointerVerb(): string {
    const { t } = useTranslation();
    return useCanHover() ? t("Click") : t("Tap");
}

/**
 * Reactive `canHover()`. Use it for controls revealed by `onMouseEnter` state:
 * on a touchscreen that event never fires, so the control would stay hidden
 * forever. The CSS equivalent is the `can-hover:` Tailwind variant.
 */
export function useCanHover(): boolean {
    return useSyncExternalStore(subscribeHover, canHover, () => false);
}
