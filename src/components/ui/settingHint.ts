import { createContext, useContext } from 'react';

/**
 * The id of the one-line hint of the SettingRow a control sits in, so the
 * control can name it in `aria-describedby`: a screen reader that lands on
 * the switch or the segment then reads what it does, not only its name.
 * Undefined outside a row, or in a row without a hint.
 */
export const SettingHintContext = createContext<string | undefined>(undefined);

export const useSettingHint = (): string | undefined => useContext(SettingHintContext);
