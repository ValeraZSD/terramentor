// MOCKUP DATA (branch t3code/short-courses). Sample short courses and every
// state of the source box, so the design can be judged before the reader and
// the short creation run are built. `?short=<state>` on /projects picks the
// source box's state; `?short=none` hides the rows (a library with none yet).
import type { ShortCourseRow, SourceState } from './shortCourseTypes';

export const MOCK_ROWS: ShortCourseRow[] = [
    { id: -1, name: 'Teaching a puppy to walk on a loose leash', icon: 'heart', color: '#cf8e6e', kind: 'pdf', from: 'loose-leash-training.pdf', topics: 4, done: 0, state: 'building' },
    { id: -2, name: 'Index funds, explained', icon: 'money', color: '#22C55E', kind: 'page', from: 'investopedia.com', topics: 5, done: 0, state: 'ready' },
    { id: -3, name: 'How a robot arm knows where it is', icon: 'robot', color: '#3B82F6', kind: 'video', from: 'youtube.com', topics: 4, done: 2, state: 'studying' },
    { id: -4, name: 'Reading a Dutch payslip', icon: 'briefcase', color: '#9f89d2', kind: 'page', from: 'rijksoverheid.nl', topics: 3, done: 3, state: 'finished' },
];

export const MOCK_SOURCES: Record<string, SourceState> = {
    empty: { state: 'empty' },
    reading: { state: 'reading', where: 'youtube.com/watch?v=9GJ6XeB-vMg', step: 'Fetching the captions' },
    read: { state: 'read', kind: 'video', title: 'Forward kinematics in 12 minutes', detail: 'Video, 12 min · English captions · about 4 topics' },
    unreadable: {
        state: 'unreadable', kind: 'video', title: 'Forward kinematics in 12 minutes',
        reason: 'YouTube did not let the app read the captions.',
        fix: 'transcript',
    },
    'no-captions': {
        state: 'unreadable', kind: 'video', title: 'Robot arm build, timelapse',
        reason: 'This video has no captions to read. A course can still be written on its topic.',
        fix: 'topic',
    },
    transcript: {
        state: 'transcript', kind: 'video', title: 'Forward kinematics in 12 minutes',
        detail: 'On YouTube, open the description and press Show transcript, then copy it here.',
        pasted: '0:00 So you have a robot arm with three joints, and you know the angle of each one.\n0:07 The question forward kinematics answers is: where is the hand?\n0:12 We start with one joint. The link is a fixed length, and the angle turns it…',
    },
    'too-big': { state: 'too-big', kind: 'pdf', title: 'Personal Finance for Dummies.pdf', detail: 'A whole book, 412 pages: a full course, or a few chapters for a short one.' },
    'too-small': { state: 'too-small', kind: 'video', title: 'Leave it! in 40 seconds', detail: 'Video, 40 s. Too little for a course, but it can be a note.' },
    'no-ai': { state: 'no-ai', kind: 'page', title: 'Index funds, explained', detail: 'Read: 2,300 words. Writing the lessons needs an AI connection.' },
};

/** The mockup's state from the address, so each one can be photographed. */
export function mockFromUrl(search: string): { source: SourceState; rows: ShortCourseRow[]; menuOpen: number | null } {
    const p = new URLSearchParams(search);
    const key = p.get('short') ?? 'empty';
    return {
        source: MOCK_SOURCES[key] ?? MOCK_SOURCES.empty,
        rows: p.get('rows') === 'none' ? [] : MOCK_ROWS,
        menuOpen: p.get('menu') ? Number(p.get('menu')) : null,
    };
}
