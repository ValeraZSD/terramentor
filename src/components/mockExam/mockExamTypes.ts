import type { QuizQuestion } from '../../types';

// The shapes server/mockExams.js sends: a past paper with its points table,
// one go at it (a "mock"), and what the marks add up to.

export interface ExamPart {
    id: number;
    question: string;
    part: string;
    points: number;
    nodeId: number | null;
    topic: string | null;
}

export interface ExamPaper {
    id: number;
    projectId: number;
    title: string;
    minutes: number;
    gradeMin: number | null;
    gradeMax: number | null;
    passGrade: number | null;
    paperDocumentId: number | null;
    solutionDocumentId: number | null;
    /** The solution's file kind ('pdf', 'png'...): only a PDF is shown beside the points. */
    solutionKind: string | null;
    total: number;
    passPoints: number | null;
    parts: ExamPart[];
}

export type MockStatus = 'writing' | 'marking' | 'done';

export interface MockSitting {
    id: number;
    paperId: number;
    question: string | null;
    status: MockStatus;
    timeAllowed: number;
    elapsed: number;
    running: boolean;
    timeUp: boolean;
    startedAt: string;
    finishedAt: string | null;
}

export interface MockListSitting extends MockSitting {
    earned: number;
    total: number;
    grade: number | null;
    passed: boolean | null;
}

export interface MockQuestionResult {
    question: string;
    points: number;
    earned: number;
    lost: number;
    topics: { id: number; title: string }[];
}

export interface MockResult {
    earned: number;
    total: number;
    unmarked: number;
    grade: number | null;
    passPoints: number | null;
    passed: boolean | null;
    parts: (ExamPart & { earned: number | null })[];
    questions: MockQuestionResult[];
    /** The topic that lost the most points, null when no topic lost any. */
    weakest: { id: number; title: string; points: number; lost: number } | null;
}

export interface MockDetail {
    sitting: MockSitting;
    paper: ExamPaper;
    result: MockResult;
}

export interface MockExamList {
    papers: (ExamPaper & { sittings: MockListSitting[] })[];
    topics: { id: number; title: string }[];
    documents: { id: number; title: string; fileType: string }[];
    course: CourseReadiness;
    courseSittings: CourseListSitting[];
}

export interface ExamPaperInput {
    title: string;
    minutes: number;
    gradeMin: number | null;
    gradeMax: number | null;
    passGrade: number | null;
    paperDocumentId: number | null;
    solutionDocumentId: number | null;
    /** The total printed on the paper: the parts must add up to it. */
    printedTotal?: number | null;
    parts: { question: string; part: string; points: number; nodeId: number | null }[];
}

// ---- a mock drawn from the course's own questions ------------------------------

/** The course's real exam as described: on paper, or on screen with its length and pass line. */
export interface RealExam {
    onScreen: boolean;
    questions: number | null;
    minutes: number | null;
    passRight: number | null;
}

/** What a draw from this course could ask, what it leaves out, and the set-up's defaults. */
export interface CourseReadiness {
    ready: number;
    topics: number;
    studied: number;
    notStudied: number;
    writtenLeftOut: number;
    held: number;
    exam: RealExam | null;
    clockOn: boolean;
    defaultSize: number;
}

export interface CourseListSitting extends MockSitting {
    source: 'course';
    questions: number;
    answered: number;
    right: number | null;
    total: number;
}

/** One question of an open mock: what the input needs, never the key. */
export interface CourseQuestion {
    partId: number;
    n: number;
    ref: string | null;
    question: QuizQuestion;
    answer: string | null;
    later: boolean;
}

export type ReviewGroup = 'wrong' | 'wrong_later' | 'none' | 'right';

export interface CourseReviewItem {
    partId: number;
    n: number;
    ref: string | null;
    nodeId: number | null;
    topic: string | null;
    question: QuizQuestion;
    answer: string | null;
    correct: boolean;
    later: boolean;
    group: ReviewGroup;
}

export interface CourseTopicResult {
    id: number;
    title: string;
    right: number;
    total: number;
    marks: ('right' | 'wrong' | 'none')[];
}

export interface CourseResult {
    right: number;
    total: number;
    notAnswered: number;
    late: { right: number; answered: number } | null;
    spread: { low: number; high: number } | null;
    passRight: number | null;
    passed: boolean | null;
    notGrade: boolean;
    reported: number;
    topics: CourseTopicResult[];
    review: CourseReviewItem[];
}

export interface CourseMockDetail {
    sitting: MockSitting;
    paper: { id: number; projectId: number; source: 'course'; title: string; questions: number; passRight: number | null };
    exam: RealExam | null;
    course: { questions: CourseQuestion[]; answered: number; left: number; later: number };
    result: CourseResult | null;
}

export const isCourseDetail = (d: MockDetail | CourseMockDetail): d is CourseMockDetail => 'course' in d;
