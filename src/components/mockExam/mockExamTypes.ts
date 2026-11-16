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
}

export interface ExamPaperInput {
    title: string;
    minutes: number;
    gradeMin: number | null;
    gradeMax: number | null;
    passGrade: number | null;
    paperDocumentId: number | null;
    solutionDocumentId: number | null;
    parts: { question: string; part: string; points: number; nodeId: number | null }[];
}
