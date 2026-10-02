/**
 * `accentVars` with the theme read off the store — what a component wants.
 *
 * Subscribes to the MODE and the TINT, because both move the answer: the mode
 * decides which way the text colour is driven and the tint decides what it is
 * driven against. Subscribing to the mode alone is what left accent text
 * measured against a page nobody was looking at.
 */
import { useStore, isDarkTheme } from '../store';
import { accentVars } from '../utils/accentVars';

export function useAccentVars(color: string | null | undefined) {
    const theme = useStore(s => s.theme);
    const tint = useStore(s => s.themeTint);
    return accentVars(color, isDarkTheme(theme) ? 'dark' : 'light', tint);
}
