/**
 * How wide a course's three columns are drawn: the sidebar, the view in the
 * middle and a topic's panel, inside the row that holds them.
 *
 * The stored widths are the learner's choice and stay as they are; this only
 * decides what fits in the room the row has NOW. That room is the window less
 * whatever stands beside the app (a docked assistant), so it is measured, never
 * read off the window: a width capped against the window let a panel stored at
 * 600px run 96px past the row's edge with the assistant open, Close and all.
 *
 * What gives way, in order:
 *  1. the panel, from its stored width down to its minimum;
 *  2. the sidebar, from its stored width down to its minimum;
 *  3. the middle view, which is not drawn at all once it cannot have its
 *     minimum: the panel takes its place (a strip of a dashboard helps nobody,
 *     and the topic is what the learner just opened). With the middle view
 *     gone the sidebar gets its stored width back and the panel takes all the
 *     rest, past its stored width if need be: the row is never left empty;
 *  4. the sidebar, when even the panel's minimum does not fit beside it.
 */

/** The narrowest the sidebar is drawn (the store's lower clamp). */
export const SIDEBAR_MIN = 200;
/** The narrowest a topic's panel is drawn beside the middle view (the store's lower clamp). */
export const PANEL_MIN = 300;
/** The narrowest the middle view is drawn, in rem: it follows the interface scale. */
export const CENTER_MIN_REM = 20;

export interface FitInput {
    /** The row's width in px; 0 = not measured yet. */
    room: number;
    /** Stored widths, px. */
    sidebar: number;
    panel: number;
    /** Whether the sidebar and a panel are on this screen at all. */
    showSidebar: boolean;
    showPanel: boolean;
    /** The middle view's minimum, px. */
    centerMin: number;
    /** The sidebar's minimum, px, when the page sets one above SIDEBAR_MIN
     *  ("Larger text and buttons" gives it a CSS floor of its own). */
    sidebarMin?: number;
}

export interface Fit {
    /** Drawn widths, px; 0 = not drawn. */
    sidebar: number;
    panel: number;
    /** Whether the middle view is drawn. */
    center: boolean;
    /** The widest a drag may make the sidebar / the panel while all columns stay drawn; 0 = no room to trade. */
    sidebarMax: number;
    panelMax: number;
}

export function fitColumns({ room, sidebar: storedSidebar, panel, showSidebar, showPanel, centerMin, sidebarMin: floor = 0 }: FitInput): Fit {
    // The sidebar is never drawn under its floor, whatever is stored: the
    // arithmetic below must count what the page will really draw.
    const SIDEBAR_FLOOR = Math.max(SIDEBAR_MIN, floor);
    const sidebar = Math.max(storedSidebar, SIDEBAR_FLOOR);
    if (room <= 0) {
        return {
            sidebar: showSidebar ? sidebar : 0, panel: showPanel ? panel : 0, center: true,
            sidebarMax: sidebar, panelMax: panel,
        };
    }
    if (!showPanel) {
        const most = Math.max(SIDEBAR_FLOOR, room - centerMin);
        return {
            sidebar: showSidebar ? Math.min(sidebar, most) : 0, panel: 0, center: true,
            sidebarMax: showSidebar ? most : 0, panelMax: 0,
        };
    }
    const sidebarMin = showSidebar ? SIDEBAR_FLOOR : 0;
    if (sidebarMin + centerMin + PANEL_MIN <= room) {
        const sidebarMax = showSidebar ? room - centerMin - PANEL_MIN : 0;
        const drawnSidebar = showSidebar ? Math.min(sidebar, sidebarMax) : 0;
        const panelMax = room - drawnSidebar - centerMin;
        return {
            sidebar: drawnSidebar,
            panel: Math.max(PANEL_MIN, Math.min(panel, panelMax)),
            center: true,
            sidebarMax,
            panelMax,
        };
    }
    // The middle view does not fit: the panel stands in its place.
    if (showSidebar && room - SIDEBAR_FLOOR >= PANEL_MIN) {
        const drawnSidebar = Math.min(sidebar, room - PANEL_MIN);
        return { sidebar: drawnSidebar, panel: room - drawnSidebar, center: false, sidebarMax: room - PANEL_MIN, panelMax: 0 };
    }
    return { sidebar: 0, panel: room, center: false, sidebarMax: 0, panelMax: 0 };
}
