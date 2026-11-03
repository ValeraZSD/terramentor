// What the short-course routes answer (server/routes/shortCourses.js), as the
// strip on Projects and the assistant's ```short card read them.
import type { StagedDocument } from '../../types';

/** Where a source came from: `topic` is "Write it from the title", no source at all. */
export type SourceKind = 'video' | 'page' | 'pdf' | 'file' | 'topic';

/** What the way on is for a source that could not be read (linkReader.js FIX). */
export type ReadFix = 'file' | 'retry' | 'transcript' | 'topic' | null;

/** One top-level part of a book, to pick a few of for a short course. */
export interface ShortChapter {
    /** The part's index in the source's map, sent back as `parts`. */
    part: number;
    title: string;
    from: number | null;
    to: number | null;
    words: number;
}

/** A source read and staged: `size` says whether it makes a short course. */
export interface ShortReadOk {
    ok: true;
    stagedId: string;
    kind: Exclude<SourceKind, 'topic'>;
    title: string;
    url: string | null;
    host: string | null;
    file: string | null;
    words: number;
    pages: number | null;
    minutes: number | null;
    captions: 'auto' | 'manual' | null;
    /** A YouTube Short. */
    short: boolean;
    size: 'too-small' | 'ok' | 'too-big';
    /** How many topics it would make. */
    topics: number;
    /** Writing it needs a model; reading it did not. */
    ai: boolean;
    /** A book: its chapters, and the file as the New course dialog takes it. */
    chapters?: ShortChapter[];
    staged?: StagedDocument;
}

/** A source that could not be read: why, and what the screen offers instead. */
export interface ShortReadFail {
    ok: false;
    reason: string;
    fix: ReadFix;
    title?: string | null;
    url?: string | null;
    host?: string | null;
}

export type ShortRead = ShortReadOk | ShortReadFail;

export type ShortRowState = 'building' | 'failed' | 'ready' | 'studying' | 'finished';

/** One short course on the strip (GET /api/short-courses). */
export interface ShortCourseRow {
    id: number;
    name: string;
    icon: string;
    color: string;
    kind: SourceKind;
    /** The source as the learner would recognise it: a site or a file name. */
    from: string | null;
    url: string | null;
    minutes: number | null;
    topics: number;
    done: number;
    state: ShortRowState;
    taskId: string | null;
}

/** What Create sends: one source, and what the assistant showed, if it was the assistant. */
export interface ShortCourseCreate {
    stagedId?: string;
    url?: string;
    attachmentId?: number;
    fromTopic?: { title: string };
    name?: string;
    icon?: string | null;
    color?: string;
    topics?: string[];
    /** Chapters of a book, by `ShortChapter.part`. */
    parts?: number[];
    via?: 'projects' | 'assistant';
    /** The assistant's card: a second press finds the course the first one made. */
    once?: boolean;
}
