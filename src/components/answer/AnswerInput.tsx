import { ComponentType } from 'react';
import type { QuizQuestion } from '../../types';
import type { AnswerFormat } from './formats';
import ChoiceInput from './ChoiceInput';
import TextAnswerInput from './TextAnswerInput';
import FillInInput from './FillInInput';
import NumericInput from './NumericInput';
import CodeInput from './CodeInput';
import SequenceInput from './SequenceInput';

/**
 * How a learner answers ONE question, whatever its format.
 *
 * The feed's inline check and the quiz used to each carry a hand-written copy
 * of every answer control — the tiles, the True/False pair, the textarea — and
 * grade them in their own way. This is the one place a format is turned into
 * an input; the surfaces own only what differs between them (grade on the
 * spot, or collect and submit; where the Check button sits; what the verdict
 * margin says).
 *
 * The value is always a STRING — a chosen option, typed prose, the code, an
 * ordering as JSON — because that is what `quiz_attempts.answers` and a feed
 * item's recorded result store, and a format whose answer does not fit a
 * string has to say so here, not discover it at write time.
 */
export interface AnswerInputProps {
    question: QuizQuestion;
    /** The draft; when `result` is set, the recorded answer is shown instead. */
    value: string;
    onChange: (value: string) => void;
    /** A closed format answered by choosing calls this with the choice — the feed grades on it. */
    onCommit?: (value: string) => void;
    disabled?: boolean;
    /** The recorded verdict: paints the key and the learner's pick, locks the input. */
    result?: { correct: boolean; answer: string } | null;
    /** Put the caret in the input on mount (an open format the learner is about to write in). */
    autoFocus?: boolean;
}

const INPUTS: Record<AnswerFormat, ComponentType<AnswerInputProps>> = {
    multiple_choice: ChoiceInput,
    true_false: ChoiceInput,
    short_answer: TextAnswerInput,
    fill_in: FillInInput,
    numeric: NumericInput,
    code: CodeInput,
    sequence: SequenceInput,
};

export default function AnswerInput(props: AnswerInputProps) {
    // A row written before a format existed, or one whose format this build
    // does not know, is answered as prose rather than not at all.
    const Input = INPUTS[props.question.type] ?? TextAnswerInput;
    return <Input {...props} />;
}
