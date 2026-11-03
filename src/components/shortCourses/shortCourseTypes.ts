// What the Projects page's short-course section draws. MOCKUP (branch
// t3code/short-courses): the shapes the server will return once the reader and
// the short creation run exist; today `mockShortCourses.ts` fills them.

/** Where a short course's text came from. */
export type SourceKind = 'video' | 'page' | 'pdf' | 'file' | 'text';

/** The source box, one state at a time. */
export type SourceState =
    | { state: 'empty' }
    | { state: 'reading'; where: string; step: string }
    | { state: 'read'; kind: SourceKind; title: string; detail: string }
    | { state: 'unreadable'; kind: SourceKind; title: string; reason: string; fix: 'transcript' | 'topic' }
    | { state: 'transcript'; kind: SourceKind; title: string; detail: string; pasted: string }
    | { state: 'too-big'; kind: SourceKind; title: string; detail: string }
    | { state: 'too-small'; kind: SourceKind; title: string; detail: string }
    | { state: 'no-ai'; kind: SourceKind; title: string; detail: string };

export type RowState = 'building' | 'ready' | 'studying' | 'finished';

export interface ShortCourseRow {
    id: number;
    name: string;
    icon: string;
    color: string;
    kind: SourceKind;
    /** The source, as the learner would recognise it: a site or a file name. */
    from: string;
    topics: number;
    done: number;
    state: RowState;
}
