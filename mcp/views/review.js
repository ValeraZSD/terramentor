// mcp/views/review.js — a card review session in the host's window.
//
// The app's review session (ReviewSession, useReviewQueue) in a smaller frame:
// the front, "Reveal answer" (Space), then Again / Hard / Good / Easy (1–4)
// with what each would schedule under it, and Undo (Z). The back stays on the
// server until the answer is revealed, a rating is the app's scheduler's, and
// a card rated Again comes back in the same session as it does in the app.
(() => {
    const { h, icon, t, mount, showError, textOf, callTool, tellModel } = TM;

    const RATINGS = [['again', 'Again'], ['hard', 'Hard'], ['good', 'Good'], ['easy', 'Easy']];
    const state = {
        sitting: null,
        phase: 'waiting',
        view: null,
        busy: false,
        notice: '',
        told: false,
        project: '',
    };

    TM.start({ name: 'terramentor-card-review', onToolResult });
    render();

    function onToolResult(result) {
        const meta = (result && result._meta) || {};
        TM.setAppLanguage(meta['terramentor/language']);
        const sitting = meta['terramentor/sitting'];
        if (typeof sitting !== 'string' || !sitting) {
            state.phase = meta['terramentor/nothing'] === 'no_cards' ? 'empty' : 'message';
            state.message = textOf(result);
            return render();
        }
        if (sitting === state.sitting) return;
        state.sitting = sitting;
        state.phase = 'loading';
        render();
        run('review_next', {});
    }

    async function run(tool, args) {
        if (state.busy) return;
        state.busy = true;
        try {
            let view = await callTool(tool, { sitting: state.sitting, ...args });
            // A rating's answer is the rating; the next card is asked for at once.
            if (tool === 'review_rate') view = await callTool('review_next', { sitting: state.sitting });
            if (tool === 'review_undo' && view.undone === false) {
                state.notice = t('This card was reviewed again since, so that rating stays.');
                view = await callTool('review_next', { sitting: state.sitting });
            }
            state.view = view;
            // The finished session has no card to name its course; keep the last one's.
            if (view.card && view.card.project) state.project = view.card.project;
            state.phase = view.done ? 'done' : 'card';
            if (view.done && !state.told) {
                state.told = true;
                tellModel(`The learner finished the card review: ${view.rated} rating${view.rated === 1 ? '' : 's'}, `
                    + `${view.reviewed} of ${view.total} cards done${view.waiting ? `, ${view.waiting.count} still being learned` : ''}. Terramentor scheduled each card.`,
                { rated: view.rated, reviewed: view.reviewed, total: view.total });
            }
        } catch (err) {
            state.notice = String((err && err.message) || err);
        } finally {
            state.busy = false;
        }
        render();
    }

    const reveal = () => state.view && state.view.card && !state.view.revealed && run('review_reveal', { presentationId: state.view.card.presentationId });
    const rate = (rating) => state.view && state.view.revealed && run('review_rate', { presentationId: state.view.card.presentationId, rating });
    const undo = () => state.view && state.view.rated > 0 && run('review_undo', {});

    // The app's keys: Space reveals, 1–4 rate, Z or Ctrl+Z takes the last rating back.
    document.addEventListener('keydown', (e) => {
        if (e.altKey || state.busy || !state.view || (state.phase !== 'card' && state.phase !== 'done')) return;
        if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
        if (e.ctrlKey || e.metaKey || state.phase !== 'card') return;
        if (e.key === ' ' && !state.view.revealed) { e.preventDefault(); reveal(); }
        else if (/^[1-4]$/.test(e.key) && state.view.revealed) { e.preventDefault(); rate(RATINGS[Number(e.key) - 1][0]); }
    });

    function progress(v) {
        const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': v.total, 'aria-valuenow': v.reviewed }, h('div', { class: 'bar-fill' }));
        bar.firstChild.style.setProperty('width', `${v.total ? (v.reviewed / v.total) * 100 : 0}%`);
        return bar;
    }

    function header(v) {
        const course = (v && v.card && v.card.project) || state.project;
        return h('header', { class: 'head head-row' },
            h('div', {},
                h('p', { class: 'eyebrow' }, t('Flashcard Review')),
                course ? h('h1', { class: 'title' }, course) : null),
            h('div', { class: 'head-side' },
                v ? h('span', { class: 'muted' }, `${v.reviewed}/${v.total}`) : null,
                h('button', {
                    type: 'button', class: 'icon-button', 'data-focus': 'undo', disabled: !(v && v.rated > 0) || state.busy,
                    'aria-label': t('Undo the last rating'), title: `${t('Undo the last rating')} (Z)`, onClick: undo,
                }, icon('undo'))));
    }

    function cardScreen(v) {
        const c = v.card;
        const notice = state.notice ? h('p', { class: 'notice', role: 'status' }, state.notice) : null;
        state.notice = '';
        return [
            header(v),
            progress(v),
            notice,
            h('section', { class: 'card' },
                h('p', { class: 'eyebrow' }, c.topic || t('Question')),
                h('p', { class: 'card-front' }, c.front),
                c.extraFront ? h('p', { class: 'muted' }, c.extraFront) : null,
                c.hasMedia ? h('p', { class: 'notice' }, 'This card has a picture or sound, which only Terramentor plays.') : null,
                v.revealed ? h('hr', { class: 'rule' }) : null,
                v.revealed ? h('p', { class: 'card-back' }, c.back) : null,
                v.revealed && c.extra ? h('p', { class: 'muted' }, c.extra) : null),
            v.revealed
                ? h('section', { class: 'rate' },
                    h('p', { class: 'muted center' }, t('How well did you know this?')),
                    h('div', { class: 'ratings' }, RATINGS.map(([key, label], i) => h('button', {
                        type: 'button', class: `button rating rating-${key}`, 'data-focus': `rate-${key}`, disabled: state.busy,
                        title: `${t(label)} (${i + 1})`, onClick: () => rate(key),
                    }, h('span', {}, t(label)), h('span', { class: 'hint' }, (v.intervals && v.intervals[key]) || '')))))
                : h('footer', { class: 'actions single' },
                    h('button', { type: 'button', class: 'button primary wide', 'data-focus': 'reveal', disabled: state.busy, title: `${t('Reveal answer')} (Space)`, onClick: reveal }, t('Reveal answer'))),
        ];
    }

    function doneScreen(v) {
        const notice = state.notice ? h('p', { class: 'notice', role: 'status' }, state.notice) : null;
        state.notice = '';
        return [
            header(v),
            progress(v),
            notice,
            h('section', { class: 'outcome is-pass' },
                h('span', { class: 'outcome-mark', 'aria-hidden': 'true' }, icon('check')),
                h('div', {},
                    h('h2', { class: 'outcome-title' }, t('Session Complete!')),
                    h('p', {}, t('You reviewed {{count}} flashcards', { count: v.rated })),
                    v.waiting ? h('p', { class: 'muted' }, t('{{count}} cards are still being learned and come back {{readyIn}}.', { count: v.waiting.count, readyIn: v.waiting.readyIn })) : null)),
            v.waiting
                ? h('footer', { class: 'actions single' },
                    h('button', { type: 'button', class: 'button', 'data-focus': 'anyway', disabled: state.busy, onClick: () => { state.told = false; run('review_next', { anyway: true }); } }, t('Show them now anyway', { count: v.waiting.count })))
                : null,
        ];
    }

    function render() {
        switch (state.phase) {
            case 'waiting':
            case 'loading':
                if (state.notice) { const n = state.notice; state.notice = ''; return showError(n); }
                return mount(h('p', { class: 'muted loading' }, t('Loading…')));
            case 'empty':
                return mount(h('header', { class: 'head' }, h('p', { class: 'eyebrow' }, t('Flashcard Review')), h('h1', { class: 'title' }, t('No Cards Due'))),
                    h('p', { class: 'muted' }, state.message || ''));
            case 'message':
                return mount(h('header', { class: 'head' }, h('p', { class: 'eyebrow' }, t('Flashcard Review'))), h('p', { class: 'notice' }, state.message || ''));
            case 'done':
                return mount(...doneScreen(state.view));
            default:
                return mount(...cardScreen(state.view));
        }
    }
})();
