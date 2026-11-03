// mcp/views/check.js — a topic's mastery check, taken in the host's window.
//
// The same check as the app's gate dialog (MasteryGateModal): the questions
// the app drew, one at a time with Previous and Next, then "Submit mastery
// check" grades the whole sitting at once. The questions arrive without their
// keys; the score, each key and each explanation arrive only in the answer to
// the submit, and the app writes the result. A pass marks the topic completed
// on Continue, through the app's own completion gate.
(() => {
    const { h, icon, t, mount, showError, textOf, callTool, tellModel } = TM;

    const state = {
        sitting: null,
        topic: null,
        questions: [],
        answers: [],
        index: 0,
        passPct: 80,
        topicCompleted: false,
        result: null,
        phase: 'waiting',
        showReview: false,
        busy: false,
    };
    let counter = null;

    TM.start({ name: 'terramentor-mastery-check', onToolResult });
    render();

    function onToolResult(result) {
        const meta = (result && result._meta) || {};
        TM.setAppLanguage(meta['terramentor/language']);
        const sitting = meta['terramentor/sitting'];
        if (typeof sitting !== 'string' || !sitting) {
            // Nothing to take here (too few checked questions, or a refusal): the tool's own words.
            state.phase = 'message';
            state.message = textOf(result);
            return render();
        }
        if (sitting === state.sitting) return;
        state.sitting = sitting;
        state.phase = 'loading';
        render();
        callTool('check_questions', { sitting }).then((data) => {
            state.topic = data.topic || null;
            state.questions = Array.isArray(data.questions) ? data.questions : [];
            state.passPct = Number(data.passPct) || state.passPct;
            state.topicCompleted = !!data.topicCompleted;
            state.answers = state.questions.map(initialAnswer);
            state.result = data.result || null;
            state.phase = state.result ? 'result' : 'answering';
            render();
        }).catch(showError);
    }

    // ---- answers, as each format's input holds them
    const gapCount = (q) => String(q.template || '').split(/_{3,}/).length - 1;

    function initialAnswer(q) {
        if (q.type === 'sequence') return (q.items || []).slice();
        if (q.type === 'assemble') return new Array(gapCount(q)).fill(null);
        if (q.type === 'code') return q.starter || '';
        return '';
    }

    function isAnswered(q, a) {
        if (q.type === 'sequence') return true;
        if (q.type === 'assemble') return a.some(p => p != null);
        return typeof a === 'string' && a.trim() !== '' && !(q.type === 'code' && a === (q.starter || ''));
    }

    /** What the server grades: an ordering and an assembly as JSON, anything else as typed; nothing = null. */
    function encoded(q, a) {
        if (!isAnswered(q, a)) return null;
        if (q.type === 'sequence' || q.type === 'assemble') return JSON.stringify(a);
        return a;
    }

    const answeredCount = () => state.questions.reduce((n, q, i) => n + (isAnswered(q, state.answers[i]) ? 1 : 0), 0);

    function setAnswer(value, rerender) {
        state.answers[state.index] = value;
        if (rerender) render();
        else if (counter) counter.textContent = t('{{answeredCount}}/{{length}} answered', { answeredCount: answeredCount(), length: state.questions.length });
    }

    // ---- the inputs
    function choice(q, a, options) {
        return h('div', { class: 'options', role: 'radiogroup', 'aria-label': t('Your answer') },
            options.map(([value, label], i) => h('button', {
                type: 'button', role: 'radio', class: `option${a === value ? ' is-chosen' : ''}`,
                'aria-checked': a === value ? 'true' : 'false', 'data-focus': `option-${i}`,
                onClick: () => setAnswer(value, true),
            }, label)));
    }

    function textInput(q, a, { multiline = false, mono = false, placeholder }) {
        const props = {
            class: `field${mono ? ' mono' : ''}`, placeholder, 'aria-label': t('Your answer'), 'data-focus': 'answer',
            spellcheck: mono ? 'false' : null, autocomplete: 'off',
            onInput: (e) => setAnswer(e.target.value, false),
        };
        const el = multiline ? h('textarea', { ...props, rows: mono ? 8 : 4 }) : h('input', { ...props, type: 'text', inputmode: q.type === 'numeric' ? 'decimal' : null });
        el.value = a;
        return el;
    }

    function sequenceInput(q, a) {
        const move = (i, d) => {
            const next = a.slice();
            [next[i], next[i + d]] = [next[i + d], next[i]];
            setAnswer(next, true);
        };
        return h('ol', { class: 'sequence', 'aria-label': t('Your order') }, a.map((item, i) => h('li', { class: 'step' },
            h('span', { class: 'step-n', 'aria-hidden': 'true' }, String(i + 1)),
            h('span', { class: 'step-text' }, item),
            h('span', { class: 'step-moves' },
                h('button', { type: 'button', class: 'icon-button', 'aria-label': t('Move up'), title: t('Move up'), disabled: i === 0, 'data-focus': `up-${item}`, onClick: () => move(i, -1) }, icon('up')),
                h('button', { type: 'button', class: 'icon-button', 'aria-label': t('Move down'), title: t('Move down'), disabled: i === a.length - 1, 'data-focus': `down-${item}`, onClick: () => move(i, 1) }, icon('down'))))));
    }

    function assembleInput(q, a) {
        const parts = String(q.template || '').split(/_{3,}/);
        const tokens = q.tokens || [];
        // Which tokens are in use: each one fills one gap unless the bank may be reused.
        const used = new Array(tokens.length).fill(false);
        if (!q.reuse) {
            for (const piece of a) {
                if (piece == null) continue;
                const i = tokens.findIndex((tok, j) => !used[j] && tok === piece);
                if (i >= 0) used[i] = true;
            }
        }
        const place = (piece) => {
            const gap = a.indexOf(null);
            if (gap < 0) return;
            const next = a.slice();
            next[gap] = piece;
            setAnswer(next, true);
        };
        const clear = (gap) => {
            const next = a.slice();
            next[gap] = null;
            setAnswer(next, true);
        };
        const line = h('p', { class: 'template' });
        parts.forEach((part, i) => {
            line.append(document.createTextNode(part));
            if (i < parts.length - 1) {
                line.append(a[i] == null
                    ? h('span', { class: 'gap is-empty', role: 'img', 'aria-label': t('Gap {{n}}, empty', { n: i + 1 }) })
                    : h('button', { type: 'button', class: 'gap', 'data-focus': `gap-${i}`, 'aria-label': t('Gap {{n}}: {{piece}}. Press to take it out', { n: i + 1, piece: a[i] }), onClick: () => clear(i) }, a[i]));
            }
        });
        return h('div', { class: 'assemble' }, line,
            h('div', { class: 'pieces', role: 'group', 'aria-label': t('Pieces') }, tokens.map((tok, i) => h('button', {
                type: 'button', class: 'piece', disabled: used[i] || !a.includes(null), 'data-focus': `piece-${i}`, onClick: () => place(tok),
            }, tok))));
    }

    function input(q, a) {
        switch (q.type) {
            case 'multiple_choice': return choice(q, a, (q.options || []).map(o => [o, o]));
            case 'true_false': return choice(q, a, [['True', t('True')], ['False', t('False')]]);
            case 'sequence': return sequenceInput(q, a);
            case 'assemble': return assembleInput(q, a);
            case 'code': return textInput(q, a, { multiline: true, mono: true, placeholder: t('Write your solution here…') });
            case 'short_answer': return textInput(q, a, { multiline: true, placeholder: t('Type your answer…') });
            case 'numeric': return h('div', { class: 'with-unit' },
                textInput(q, a, { placeholder: q.unit ? t('Your answer, in {{unit}}', { unit: q.unit }) : t('Type your answer…') }),
                q.unit ? h('span', { class: 'unit' }, q.unit) : null);
            default: return textInput(q, a, { placeholder: t('Type your answer…') });
        }
    }

    // ---- the screens
    function header() {
        return h('header', { class: 'head' },
            h('p', { class: 'eyebrow' }, t('Mastery check')),
            h('h1', { class: 'title' }, (state.topic && state.topic.title) || ''));
    }

    function answering() {
        const total = state.questions.length;
        const q = state.questions[state.index];
        const last = state.index === total - 1;
        counter = h('span', { class: 'muted' }, t('{{answeredCount}}/{{length}} answered', { answeredCount: answeredCount(), length: total }));
        const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': state.index + 1 }, h('div', { class: 'bar-fill' }));
        bar.firstChild.style.setProperty('width', `${((state.index + 1) / total) * 100}%`);
        const go = (d) => { state.index += d; render(); };
        return [
            header(),
            h('div', { class: 'meta-row' }, h('span', {}, t('Question {{n}} of {{total}}', { n: state.index + 1, total })), counter),
            bar,
            h('section', { class: 'question', 'aria-label': t('Question {{n}} of {{total}}', { n: state.index + 1, total }) },
                h('p', { class: 'stem' }, q.question),
                q.hasPicture ? h('p', { class: 'notice' }, 'This question has a picture, which only Terramentor shows.') : null,
                input(q, state.answers[state.index])),
            h('footer', { class: 'actions' },
                h('button', { type: 'button', class: 'button', disabled: state.index === 0, 'data-focus': 'previous', onClick: () => go(-1) }, t('Previous')),
                last
                    ? h('button', { type: 'button', class: 'button primary', 'data-focus': 'submit', disabled: state.busy, onClick: submit }, t('Submit mastery check'))
                    : h('button', { type: 'button', class: 'button', 'data-focus': 'next', onClick: () => go(1) }, t('Next'))),
        ];
    }

    async function submit() {
        if (state.busy) return;
        state.busy = true;
        state.phase = 'grading';
        render();
        try {
            const data = await callTool('check_submit', {
                sitting: state.sitting,
                answers: state.questions.map((q, i) => encoded(q, state.answers[i])),
            });
            state.result = data.result;
            const r = state.result;
            const title = (state.topic && state.topic.title) || '';
            state.phase = 'result';
            if (r.unproven) {
                tellModel(`The mastery check on "${title}" could not count: too few of its questions are confirmed yet. `
                    + 'Terramentor recorded no result; the learner can try again later.', { counted: false });
            } else {
                const pct = Math.round((r.score / r.total) * 100);
                tellModel(`The learner finished the mastery check on "${title}": `
                    + `${r.score}/${r.total} (${pct}%), ${r.passed ? 'passed' : 'not passed'} (the pass mark is ${r.passPct}%). `
                    + 'Terramentor recorded it.', { score: r.score, total: r.total, passed: r.passed, passPct: r.passPct });
            }
        } catch (err) {
            // Free the button before the error's render, or Submit stays disabled.
            state.busy = false;
            state.phase = 'answering';
            return showErrorBelow(err);
        } finally {
            state.busy = false;
        }
        render();
    }

    async function complete() {
        if (state.busy) return;
        state.busy = true;
        render();
        try {
            const data = await callTool('check_complete', { sitting: state.sitting });
            if (data.result) state.result = data.result;
            else state.result.completed = true;
            tellModel(`"${(state.topic && state.topic.title) || ''}" is now marked completed in Terramentor.`);
        } catch (err) {
            state.error = String(err.message || err);
        } finally {
            state.busy = false;
        }
        render();
    }

    function showErrorBelow(err) {
        state.error = String((err && err.message) || err);
        render();
    }

    function resultScreen() {
        const r = state.result;
        // Too little of what was asked is confirmed to judge (the app says the
        // same): no evidence was written, so it is neither a pass nor a fail.
        if (r.unproven) {
            return [header(), h('p', { class: 'notice', role: 'status' }, r.proven > 0
                ? t("Too few of this topic's questions have been checked yet to count as a mastery check. The rest will be checked again in the background. Try again later.")
                : t('None of these questions could be checked yet, so they cannot count as a mastery check. They will be checked again in the background. Try again later.'))];
        }
        const pct = Math.round((r.score / r.total) * 100);
        const canComplete = r.passed && !state.topicCompleted && !r.completed;
        const line = r.passed
            ? (state.topicCompleted ? t('You proved it again — the topic stays completed.') : t('You proved it — this topic will be marked completed.'))
            : t('You need at least {{round}}% to pass this mastery check.', { round: r.passPct });
        return [
            header(),
            h('section', { class: `outcome ${r.passed ? 'is-pass' : 'is-fail'}` },
                h('span', { class: 'outcome-mark', 'aria-hidden': 'true' }, icon(r.passed ? 'check' : 'cross')),
                h('div', {},
                    h('h2', { class: 'outcome-title' }, r.passed ? t('Mastery check passed') : t('Not Yet Mastered')),
                    h('p', {}, t('You scored {{score}}/{{total}} ({{round}}%)', { score: r.score, total: r.total, round: pct })),
                    h('p', { class: 'muted' }, line))),
            h('footer', { class: 'actions' },
                h('button', { type: 'button', class: 'button', 'aria-expanded': state.showReview ? 'true' : 'false', 'data-focus': 'review', onClick: () => { state.showReview = !state.showReview; render(); } }, t('Review Answers')),
                canComplete ? h('button', { type: 'button', class: 'button primary', 'data-focus': 'continue', disabled: state.busy, onClick: complete }, t('Continue')) : null),
            state.showReview ? reviewList(r) : null,
        ];
    }

    const shown = (v) => (Array.isArray(v) ? v.join(' → ') : String(v ?? ''));

    function reviewList(r) {
        return h('ol', { class: 'review-list' }, (r.items || []).map((item, i) => {
            const q = state.questions[i] || {};
            const answered = Array.isArray(item.answer) ? item.answer.length > 0 : String(item.answer ?? '').trim() !== '';
            return h('li', { class: `review-item ${item.correct ? 'is-right' : 'is-wrong'}` },
                h('div', { class: 'review-head' },
                    h('span', { class: 'mark' }, icon(item.correct ? 'check' : 'cross'), item.correct ? t('Correct') : t('Wrong')),
                    h('span', { class: 'muted' }, t('Question {{n}} of {{total}}', { n: i + 1, total: r.total }))),
                h('p', { class: 'stem small' }, q.question || ''),
                h('p', {}, h('span', { class: 'label' }, t('Your answer:')), ' ', answered ? shown(item.answer) : t('(no answer)')),
                item.correct ? null : h('p', {}, h('span', { class: 'label' }, t('Correct answer:')), ' ', shown(item.correctAnswer)),
                item.explanation ? h('p', { class: 'explanation' }, item.explanation) : null);
        }));
    }

    function render() {
        const error = state.error ? h('p', { class: 'notice notice-error', role: 'alert' }, state.error) : null;
        state.error = '';
        switch (state.phase) {
            case 'waiting':
            case 'loading':
                return mount(h('p', { class: 'muted loading' }, t('Loading…')));
            case 'message':
                return mount(header(), h('p', { class: 'notice' }, state.message || ''));
            case 'grading':
                return mount(header(), h('p', { class: 'muted loading' }, t('Checking every answer…')));
            case 'result':
                return mount(...resultScreen(), error);
            default:
                return mount(...answering(), error);
        }
    }
})();
