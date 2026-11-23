/**
 * The mock exam clock's rules, kept apart from React so the gates can run
 * them (tools/mock-exam-gates.mjs, tools/mock-draw-gates.mjs).
 */

/** Seconds left at which a hidden clock shows again, the way an invigilator calls the last five minutes. */
export const REVEAL_AT = 300;

/** The clock may be hidden only while more than the last five minutes are left. */
export function canHideClock(secondsLeft: number): boolean {
    return secondsLeft > REVEAL_AT;
}

/** Whether the clock is hidden: the learner asked for it, and the last five minutes have not come. */
export function clockHidden(wanted: boolean, secondsLeft: number): boolean {
    return wanted && canHideClock(secondsLeft);
}

/**
 * The clock a mock will get: its own time stretched by the learner's Time
 * limits setting ('2', '3'), or 0 (no clock) when that is 'off'; any other
 * value is the normal time. The server sets the real clock by the same rule
 * when the mock starts (server/mockExams.js clockSeconds).
 */
export function mockClockSeconds(seconds: number, scale: string): number {
    if (scale === 'off') return 0;
    return scale === '2' || scale === '3' ? seconds * Number(scale) : seconds;
}
