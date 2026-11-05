import { CalendarViewMode } from '../../types';

// Which layout the calendar draws, from the width of the CALENDAR (its own
// ResizeObserver), never the screen's: it is also a panel beside a course's
// outline, ~390px wide on a 1200px screen.

/** Below 640px a 7-column grid stops being readable, whatever the screen is:
 *  the toolbar wraps, and a week is a list of days. */
export const isNarrowCalendar = (width: number): boolean => width < 640;

/**
 * Under 20rem the narrow toolbar's two rows do not hold: beside the arrows'
 * column the view switch broke into separate chips, and the date beside Today
 * split as "Sunday, Nov / 1". That is a phone at 130–160% `ui_scale` (390px is
 * 15.2rem at 160%); a 320px phone at 100% is exactly 20rem and keeps two rows.
 * In rem, so the interface scale moves it.
 */
export const isCompactCalendar = (width: number, rootFontSize: number): boolean =>
    width < 20 * rootFontSize;

/** Seven columns under ~1000px are ~115px each, and two-line titles then split
 *  words in the middle ("Нидерлан/дский"); a row per day keeps them whole. */
export const isWeekGrid = (viewMode: CalendarViewMode, width: number): boolean =>
    viewMode === 'week' && !isNarrowCalendar(width) && width >= 1000;

/**
 * Do the chips name their course?
 *
 * Always in the day list. In a week's columns only from 20rem a column, a
 * calendar 2240px wide at 100%: at 1280 the state and the dates fill the line
 * and the course name was cut to "· …", which named nothing and had taken the
 * legend's place. In rem, so a larger `ui_scale` needs a wider calendar.
 */
export const chipsNameCourse = (viewMode: CalendarViewMode, width: number, rootFontSize: number): boolean =>
    viewMode === 'day' || (isWeekGrid(viewMode, width) && width / 7 >= 20 * rootFontSize);
