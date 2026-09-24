import { useCallback, useSyncExternalStore } from 'react';
import {
    formatNumber, getNumberPreference, subscribeNumberPreference, NumberOptions,
} from '../utils/numberFormat';

/**
 * Write numbers the way this reader asked for them.
 *
 * A hook rather than a bare function so a component RE-RENDERS when the
 * preference changes: the separators are not a CSS variable and not a document
 * attribute, so unlike the theme and the ui scale there is nothing the DOM can
 * be told once. Without the subscription, changing the setting would repaint
 * Settings and leave every other screen on the old separators until something
 * else happened to re-render it — which is the kind of half-applied preference
 * that reads as a broken control.
 *
 * It subscribes to the preference itself, not to the app's store: this is used
 * by leaf components, and importing `store.ts` here dragged the whole
 * application state and the api client into a visual block's bundle.
 *
 * `num()` in `utils/numberFormat` is the same formatter for the call sites that
 * are not components at all (a widget's build log, a repair's progress line).
 */
export function useNumberFormat(): (value: number, options?: NumberOptions) => string {
    const preference = useSyncExternalStore(subscribeNumberPreference, getNumberPreference, getNumberPreference);
    return useCallback((value: number, options?: NumberOptions) => formatNumber(value, preference, options), [preference]);
}
