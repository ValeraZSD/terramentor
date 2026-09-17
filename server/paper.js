// Paper practice — exercises the learner works BY HAND, photographs, and gets
// marked on.
//
// Why this exists: exams are still written on paper, and the skills that carry a
// learner through one (deriving without autocomplete, drawing a construction,
// laying out working someone else can follow) are exactly the skills a
// tap-the-right-option feed never touches. Everything else in this engine
// measures recognition; this measures production.
//
// The pipeline:
//
//   client  photograph → perspective-correct → contrast (see src/utils/scan/)
//   server  image + rubric + reference solution → the model → a grade, in ONE
//           pass. The model that looks at the page is the model that marks it.
//
// It used to be two: a vision model turned the image into words, then the main
// text model marked the words. That split was inherited from pdfRecovery.js,
// where it is still correct — nothing downstream of recovery needs to SEE a
// page, only to read it. Marking is the opposite. Which working sits under
// which question number, whether both ends of a drawing carry a label, what a
// struck-out line said: all of it survives a photograph and dies in a paragraph
// of prose. It cost a real learner two marks — the transcriber wrote
// "[diagram: standing wave pattern with 3 antinodes]" for a diagram that was
// correct and fully labelled, and the marker, correctly refusing to credit what
// it could not see, marked it not met.
//
// The split's premise was "the local vision model is the smaller one, so let the
// big text model reason over what the small one could see". Current models are
// natively multimodal — on this dev box vision and text are the same weights —
// so it bought a second full generation and a lossy hand-off for nothing.
// `gradeTranscription` survives as a FALLBACK only: seeing, reading, judging and
// emitting JSON at once is a heavier ask than either half, and a 9-14B local
// model that fumbles it should get a second, simpler route rather than an error.
//
// The failure mode this file is most careful about is FABRICATION. A text-only
// model handed an image it cannot process does not error — it invents a
// plausible page and grades it. A learner told "correct!" about working they
// never did, or told they made a mistake they did not make, loses trust in every
// grade the app will ever give them. So: vision must be verified or explicitly
// vouched for, and an unreadable page is reported as unreadable, never guessed.

import db from './database.js';
import {
    transcribeImageToText,
    visionAvailability,
    generateResponse,
    getAISettings,
    AI_PROMPTS,
    buildNodeContext,
    aiProvenance,
} from './ai.js';
import { parseObjectResponse } from './agentic.js';
import { updateMasteryFromAttempt } from './mastery.js';
import { getNodeLanguage } from './language.js';
import vaultStorage from './vaultStorage.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Mirrors pdf_recovery_vision exactly, and for the same reason — see decideVision
// in pdfRecovery.js. 'auto' trusts vision only where it can be VERIFIED.
const VISION_MODE_SETTING = 'paper_vision';        // 'auto' (default) | 'always' | 'never'
const VISION_MODEL_SETTING = 'paper_vision_model'; // '' = use the chat model

function getSetting(key) {
    try {
        return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    } catch {
        return null;
    }
}

function getPaperVisionModel() {
    const configured = (getSetting(VISION_MODEL_SETTING) || '').trim();
    // Fall back to the PDF-recovery vision model before the chat model: a user
    // who has already told the app which of their models can see images should
    // not have to say it twice.
    const recovery = (getSetting('pdf_recovery_vision_model') || '').trim();
    return configured || recovery || getAISettings().model;
}

/**
 * The effective vision decision for grading: { use: 'yes'|'no', model }.
 *
 * 'auto' requires a VERIFIED vision capability (Ollama advertises it). An
 * OpenAI-compatible endpoint reports 'maybe' — unknowable — and a text-only
 * model behind one would hallucinate a page rather than fail, so auto declines
 * and the card falls back to self-marking. 'always' is the user taking
 * responsibility for an endpoint they know serves a vision model.
 */
export async function decidePaperVision() {
    const mode = getSetting(VISION_MODE_SETTING) ?? 'auto';
    const model = getPaperVisionModel();
    if (!model || mode === 'never' || !getAISettings().enabled) return { use: 'no', model };
    if (mode === 'always') return { use: 'yes', model };
    const cap = await visionAvailability(model);
    return { use: cap === 'yes' ? 'yes' : 'no', model };
}

// ---------------------------------------------------------------------------
// Exercise authoring (called from feedGen, in the background)
// ---------------------------------------------------------------------------

const VALID_MODES = ['document', 'photo'];
const MIN_RUBRIC = 4; // = mastery.js MIN_GATE_QUESTIONS; below this, paper work
const MAX_RUBRIC = 6; //   could never clear the completion gate.

/**
 * Validate and normalize a model-authored exercise. Returns null if it cannot be
 * repaired into something gradeable — the caller then simply does not offer a
 * practice card, which is strictly better than serving a broken one.
 */
export function validatePaperExercise(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const brief = restoreProseNewlines(raw.brief).trim();
    const reference = restoreProseNewlines(raw.reference_solution).trim();
    if (brief.length < 20 || reference.length < 20) return null;

    const mode = VALID_MODES.includes(raw.mode) ? raw.mode : 'photo'; // safer default: see prompt rule 1
    const rubricIn = Array.isArray(raw.rubric) ? raw.rubric : [];

    const rubric = rubricIn
        .map((r, i) => {
            const point = restoreProseNewlines(r?.point).trim();
            if (!point) return null;
            // Weights are the model's one arithmetic-adjacent output, so clamp
            // rather than trust: a stray 0 would make a point unscoreable and a
            // stray 10 would let one point swamp the rubric.
            const weight = Math.min(3, Math.max(1, Math.round(Number(r?.weight) || 1)));
            return { id: String(r?.id || `r${i + 1}`), point, weight };
        })
        .filter(Boolean)
        .slice(0, MAX_RUBRIC);

    // Ids must be unique — the grade is matched back by id, and duplicates would
    // silently collapse two points into one.
    const seen = new Set();
    for (const r of rubric) {
        if (seen.has(r.id)) r.id = `${r.id}_${seen.size}`;
        seen.add(r.id);
    }

    if (rubric.length < MIN_RUBRIC) return null;

    return {
        mode,
        brief,
        materials: String(raw.materials || '').trim().slice(0, 120),
        rubric,
        reference_solution: reference,
    };
}

/**
 * Put real line breaks back into prose that came through escapeLatexBackslashes.
 *
 * That helper deliberately escapes `\n`, `\t` and `\f` inside JSON strings,
 * because a local model writes LaTeX with single backslashes and `\nabla`,
 * `\times`, `\frac` would otherwise be silently eaten by JSON.parse as control
 * characters. For a one-line quiz question that trade is right. For a paper
 * exercise it inverts: the brief and the worked solution are multi-paragraph
 * markdown, so EVERY intended line break arrives as a literal backslash-n and
 * the card renders as one run-on wall of text.
 *
 * Rather than weaken the shared helper (its behaviour is load-bearing for every
 * quiz path), restore the newlines here — and only OUTSIDE math spans, since a
 * `\n` that matters as LaTeX is by definition inside `$…$` or `$$…$$`. Tabs and
 * form feeds are deliberately NOT restored: markdown has no use for them, while
 * `\times`, `\theta`, `\text` and `\frac` are constant, so the collision there
 * is worth losing in the other direction.
 */
// LaTeX commands beginning with n or r — the ONLY sequences where a backslash
// followed by 'n' or 'r' is real content rather than a mangled line break.
// Deliberately a closed list: it is short, stable, and being wrong about a
// member of it costs one broken formula, whereas being wrong the other way
// costs every line break in the document.
const LATEX_NR_COMMANDS = new Set([
    'nabla', 'ne', 'neq', 'ni', 'nleq', 'ngeq', 'not', 'notin', 'nu', 'nearrow',
    'nwarrow', 'nrightarrow', 'nleftarrow', 'nonumber', 'noindent', 'newline',
    'rho', 'right', 'rightarrow', 'rightleftharpoons', 'rangle', 'rfloor',
    'rceil', 'real', 'rm', 'ref', 'rbrace', 'rbrack', 'radians',
]);

/**
 * Put real line breaks back into prose that came through escapeLatexBackslashes.
 *
 * That helper deliberately escapes `\n`, `\t` and `\f` inside JSON strings,
 * because a local model writes LaTeX with single backslashes and `\nabla`,
 * `\times`, `\frac` would otherwise be silently eaten by JSON.parse as control
 * characters. For a one-line quiz question that trade is right. For a paper
 * exercise it inverts: the brief and the worked solution are multi-paragraph
 * markdown, so EVERY intended line break arrives as a literal backslash-n and
 * the card renders as one run-on wall of text.
 *
 * Rather than weaken the shared helper (its behaviour is load-bearing for every
 * quiz path), restore the newlines here — resolving the one genuine ambiguity,
 * `\n` meaning "newline" versus `\n` starting a LaTeX command, by looking at
 * what actually follows the backslash.
 *
 * An earlier version instead skipped over `$…$` spans, on the theory that LaTeX
 * only lives inside math delimiters. That is true of LaTeX but NOT of `$`: a C#
 * interpolated string (`$"{name}"`), a shell variable or a price pairs with the
 * next `$` in the document and silently protects everything between them. A
 * generated C# exercise came out as a single line that way — the six broken
 * newlines sat inside a 128-character span the tokeniser had decided was maths.
 * Matching the commands directly has no pairing to get wrong.
 *
 * Tabs and form feeds are deliberately NOT restored: markdown has no use for
 * them, while `\times`, `\theta`, `\text` and `\frac` are constant, so that
 * collision is worth losing in the other direction.
 */
export function restoreProseNewlines(text) {
    const input = String(text || '');
    if (!input.includes('\\n') && !input.includes('\\r')) return input;

    // `\\` first so an escaped backslash is consumed whole and its trailing
    // character can't be mistaken for the start of a command.
    return input.replace(/\\\\|\\([a-zA-Z]+)|\\([nr])/g, (match, word, bare) => {
        if (match === '\\\\') return match;
        if (bare) return '\n';                       // \n or \r with no letters after it
        if (LATEX_NR_COMMANDS.has(word)) return match; // real LaTeX — leave alone
        const first = word[0];
        if (first === 'n' || first === 'r') {
            // A line break that ran straight into the next word (\npublic).
            return `\n${word.slice(1)}`;
        }
        return match;                                 // \times, \frac, \theta …
    });
}

/**
 * Author one paper exercise for a node. Returns a validated exercise or null.
 * Two attempts, like feedGen's question generation — a small model's first shot
 * at a strict schema often misses one field.
 */
export async function generatePaperExercise(nodeId, nodeTitle, { signal } = {}) {
    const context = buildNodeContext(nodeId);
    const lang = getNodeLanguage(nodeId);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const { system, user } = AI_PROMPTS.paper_exercise(nodeTitle, context, { lang });
            const resp = await generateResponse(user, system, [], { temperature: 0.5, signal, operation: 'authoring' });
            const exercise = validatePaperExercise(parseObjectResponse(resp));
            if (exercise) return exercise;
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Stage A — the image becomes words
// ---------------------------------------------------------------------------

// ONE prompt, both modes. The old pair — *transcribe* for `document`, *describe*
// for `photo` — split a capability the model does not have split: a vision model
// reads and sees in the same pass, and asking it for only one half is what made
// it blind, not any limit of its own. Real pages are both halves at once: the
// standing-waves attempt was six lines of algebra AND the diagram that two of its
// six marks were for, and the transcriber, told to transcribe, wrote
// "[diagram: standing wave pattern with 3 antinodes]" and threw the marked
// content away one stage before the marker could credit it.
//
// The contract this prompt owes stage B is EXHAUSTIVENESS, not brevity: the
// marker treats what this says as its own sight of the page, so an unmentioned
// label is indistinguishable from an absent one. That is why the drawing clause
// demands every label and its referent rather than a tidy summary.
const READ_PAGE_PROMPT =
    'You are the marker\'s eyes. You are looking at a photograph of a learner\'s handwritten work — writing, drawings, or both — and your report is the ONLY thing the marker will ever see of this page. Whatever you leave out cannot be credited to them.\n' +
    'Report the page in reading order as GitHub-flavoured Markdown, keeping every question or part label (1, 2, a, b, i, ii, ①) exactly where it sits on the page, so the marker can tell which working answers which part.\n' +
    'WRITING — transcribe it exactly, mathematics in LaTeX (inline $...$, displayed $$...$$). Copy mistakes faithfully: a wrong sign, a dropped term or a slip in arithmetic must survive exactly as written — you are not correcting the work, and silently fixing an error hides the very thing being marked. Mark what you genuinely cannot read as [illegible] rather than guessing. Note crossed-out working as ~~struck through~~ if it is still readable, otherwise ignore it.\n' +
    'DRAWINGS — never write "[diagram]" or a one-line summary. Describe the drawing completely enough that someone who cannot see it could redraw it: what is drawn, how many of each feature, where each sits relative to the others, which lines are straight, parallel or closed, what is shaded and how heavily, and EVERY letter, number and mark written on or beside it together with the thing each one labels ("four dots sit on the axis, one at each end and two evenly between them, each with N written under it; the three arcs between them each have A written above"). Be exhaustive about labels above all — the marker cannot tell an unmentioned label from a missing one.\n' +
    'Say plainly what is ABSENT where the absence is meaningful ("the right-hand end carries no label", "no axes are drawn").\n' +
    'Never judge, grade, score, correct or praise. Report what is there; the marking is not yours.\n' +
    'If the page carries no work at all, reply with exactly: BLANK PAGE\n' +
    'Output ONLY the report — no preamble, no commentary.';

// Phrases a model emits when it cannot actually see the image. A text-only model
// behind an OpenAI-compatible endpoint usually either says something like this
// or invents a page wholesale; this catches the honest half. The dishonest half
// is what `decidePaperVision`'s verified-only default is for.
//
// This guard is the difference between "bad photo, nothing recorded" and "a
// fabricated grade written into mastery evidence", so it must not be
// English-only. A model refuses in whatever language it was prompted in, and
// the exercise brief it is handed is in the project's language — so an
// English-only pattern silently fails open for every non-English learner, which
// is the exact failure the whole two-stage split exists to prevent.
const NO_IMAGE_PATTERNS = [
    // English
    /\b(?:i (?:can(?:not|'t)|am unable to|do not|don't) (?:see|view|access|process|read|analy[sz]e)|no image (?:was )?(?:provided|attached|found)|unable to (?:see|view|process|access) (?:the |any )?image|as an ai(?: language)? model|i don't have the ability to (?:see|view))/i,
    // Dutch
    /\b(?:ik kan (?:de |het )?(?:afbeelding|beeld|foto)? ?niet (?:zien|bekijken|openen|verwerken|lezen)|geen (?:afbeelding|foto) (?:ontvangen|gevonden|aangeleverd)|als (?:een )?ai[- ]?(?:taal)?model)/i,
    // German
    /\b(?:ich kann (?:das |die |kein )?(?:bild|foto)? ?nicht (?:sehen|anzeigen|öffnen|verarbeiten|lesen)|kein bild (?:vorhanden|gefunden|übermittelt)|als (?:ein )?ki[- ]?(?:sprach)?modell)/i,
    // French
    /\b(?:je ne (?:peux|suis) pas (?:voir|capable de voir|en mesure de voir)|je ne vois (?:pas|aucune) (?:d'|l')?image|aucune image (?:n'a été )?(?:fournie|trouvée|jointe)|en tant que mod[èe]le (?:de langage |d'ia)?)/i,
    // Spanish
    /\b(?:no puedo (?:ver|acceder a|procesar|leer) (?:la |ninguna )?imagen|no (?:se ha |he )?(?:recibido|encontrado|proporcionado) (?:ninguna )?imagen|como (?:un )?modelo de (?:lenguaje|ia))/i,
    // Italian
    /\b(?:non posso (?:vedere|accedere|elaborare|leggere) (?:l'|nessuna )?immagine|non vedo (?:alcuna |nessuna )?immagine|nessuna immagine (?:fornita|trovata|allegata)|come (?:un )?modello (?:linguistico|di ia))/i,
    // Portuguese
    /\b(?:não (?:posso|consigo) (?:ver|acessar|processar|ler) (?:a |nenhuma )?imagem|nenhuma imagem (?:foi )?(?:fornecida|encontrada|anexada)|como (?:um )?modelo de (?:linguagem|ia))/i,
    // Polish
    /(?:nie (?:mogę|moge) (?:zobaczyć|zobaczyc|wyświetlić|odczytać|przetworzyć)|nie widzę (?:żadnego )?(?:obrazu|zdjęcia)|brak (?:obrazu|zdjęcia)|jako model (?:językowy|ai))/i,
    // Romanian
    /(?:nu (?:pot|reu[șs]esc s[ăa]) (?:vedea|v[ăa]d|accesa|accesez|procesa|procesez|citi|citesc)|nu v[ăa]d (?:nicio )?imagine|nicio imagine (?:nu a fost )?(?:furnizat[ăa]|g[ăa]sit[ăa])|ca (?:un )?model (?:lingvistic|de ia))/i,
    // Ukrainian
    /(?:я не (?:можу|бачу) (?:побачити|переглянути|обробити|прочитати)?\s*(?:зображенн|фото|картинк)?|зображенн\p{L}* не (?:надано|знайдено)|як (?:мовна )?модель шту)/iu,
    // Russian
    /(?:я не (?:могу|вижу) (?:увидеть|просмотреть|обработать|прочитать)?\s*(?:изображени|фото|картинк)?|изображени\p{L}* не (?:предоставлено|найдено)|как (?:языкова́?я )?модель ии|как ии[- ]модель)/iu,
];

function looksLikeNoImage(text) {
    return NO_IMAGE_PATTERNS.some(re => re.test(text));
}

/** Exported so the fabrication guard can be tested without a model call — it is
 *  the difference between "retake the photo" and a grade invented from nothing. */
export function isUnreadable(text) {
    const t = String(text || '').trim();
    if (t.length < 12) return true;
    if (/^BLANK PAGE\.?$/i.test(t)) return true;
    if (looksLikeNoImage(t)) return true;
    return false;
}

/**
 * Read a photographed page into words. Throws on transport/model failure so the
 * caller can distinguish "the model broke" from "the page was blank".
 *
 * Takes no `mode`: that still shapes the SCAN (threshold vs levels) and the
 * marker's framing, but it no longer decides which half of the page the reader
 * is allowed to see, so the reader has no use for it.
 */
export async function readSheet(imageBuffer, { signal, model, mime = 'image/jpeg' } = {}) {
    const text = await transcribeImageToText(imageBuffer, { signal, model, prompt: READ_PAGE_PROMPT, mime, timeout: 180000 });
    return String(text || '').trim();
}

// ---------------------------------------------------------------------------
// Marking — the model that sees the page is the model that marks it
// ---------------------------------------------------------------------------

function normalizeGrade(raw, exercise) {
    if (!raw || typeof raw !== 'object') return null;

    const rubric = exercise.rubric || [];
    const byId = new Map(
        (Array.isArray(raw.rubric_results) ? raw.rubric_results : [])
            .filter(r => r && r.id != null)
            .map(r => [String(r.id), r])
    );

    // Build results from the AUTHORED rubric, not the model's list: a model that
    // returns five results for a four-point rubric, or renames an id, must not be
    // able to change what the learner is being marked on.
    const results = rubric.map(point => {
        const hit = byId.get(point.id);
        return {
            id: point.id,
            point: point.point,
            weight: point.weight,
            met: hit?.met === true,
            comment: restoreProseNewlines(hit?.comment).trim().slice(0, 400),
        };
    });

    // The score is COUNTED here, never taken from the model. Asking a model to
    // total its own marks invites exactly the hand-computed-arithmetic failure
    // the visuals pipeline already bans (D-021).
    const total = results.reduce((sum, r) => sum + r.weight, 0);
    const score = results.reduce((sum, r) => sum + (r.met ? r.weight : 0), 0);

    return {
        readable: raw.readable !== false,
        // Present on the one-pass path, absent when marking pre-read words. It is
        // multi-paragraph markdown arriving inside JSON, so it needs the same
        // newline restoration as the prose fields — the shared LaTeX escaper turns
        // every line break into a literal \n on the way in.
        transcription: restoreProseNewlines(raw.transcription).trim(),
        results,
        score,
        total,
        feedback: restoreProseNewlines(raw.feedback).trim(),
        nextAction: restoreProseNewlines(raw.next_action).trim().slice(0, 300),
    };
}

/**
 * Read and mark the page in ONE pass: the photo goes to the model that rules on
 * the rubric, so nothing about the page has to survive being turned into prose
 * first. Returns `{ grade, raw }` — `grade` is null when the model answered with
 * something that is not a usable object, and `raw` is its last reply so the
 * caller can tell a refusal ("I can't see an image") from a malformed grade.
 *
 * Throws only on transport/model failure, so "the model broke" stays
 * distinguishable from "the page was blank".
 */
export async function gradePage(exercise, imageBuffer, { signal, model, mime = 'image/jpeg', lang = null } = {}) {
    const prompt = AI_PROMPTS.paper_grade_visual(exercise, exercise.mode === 'photo', { lang });
    let raw = '';
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            raw = String(await transcribeImageToText(imageBuffer, { signal, model, prompt, mime, timeout: 180000 }) || '').trim();
            const grade = normalizeGrade(parseObjectResponse(raw), exercise);
            if (grade) return { grade, raw };
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            lastErr = err;
        }
    }
    if (lastErr && !raw) throw lastErr;
    return { grade: null, raw };
}

/**
 * Mark a transcription against the exercise. Returns a normalized grade, or null
 * if the model produced nothing usable after two attempts.
 */
export async function gradeTranscription(exercise, transcription, { signal, lang = null } = {}) {
    const isDrawing = exercise.mode === 'photo';
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const { system, user } = AI_PROMPTS.paper_grade(exercise, transcription, isDrawing, { lang });
            const resp = await generateResponse(user, system, [], { temperature: 0.2, signal });
            const grade = normalizeGrade(parseObjectResponse(resp), exercise);
            if (grade) return grade;
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Full submit path: store the processed image, read it, mark it, record the
 * evidence.
 *
 * Returns { status, ... }:
 *   'graded'     — a real grade; BKT evidence written under evidence_type 'paper'
 *   'unreadable' — the page could not be read; NOTHING is recorded, and the
 *                  learner is asked to retake rather than handed a fabricated 0.
 *                  A bad photo is not a wrong answer, and recording it as one
 *                  would poison the mastery estimate over a lighting problem.
 *   'no_vision'  — no trustworthy vision model; the card self-marks instead.
 */
export async function gradePaperAttempt({ nodeId, feedItemId = null, exercise, imageBuffer, signal }) {
    const mode = exercise.mode === 'photo' ? 'photo' : 'document';

    const { use, model } = await decidePaperVision();
    if (use !== 'yes') {
        return { status: 'no_vision', reason: 'No verified vision model — mark your own work against the solution.' };
    }

    // Store the PROCESSED image before grading: if the model call fails, the
    // learner's photo is still on disk and the attempt is retryable without
    // making them re-shoot the page.
    const { hash } = vaultStorage.put(imageBuffer);

    // The transcription follows the page; the feedback is read by the learner, so
    // it follows the PROJECT's language.
    const lang = getNodeLanguage(nodeId);
    let transcription = '';
    let grade = null;
    try {
        const pass = await gradePage(exercise, imageBuffer, { signal, model, lang });
        grade = pass.grade;
        transcription = grade ? grade.transcription : pass.raw;
        // A model that cannot actually see the image refuses in prose rather than
        // JSON, so the refusal lands in `raw` and never parses. Catch it here or
        // the fallback below spends a second call re-asking a blind model.
        if (!grade && isUnreadable(pass.raw)) {
            return {
                status: 'unreadable',
                imageHash: hash,
                transcription: pass.raw,
                reason: 'Nothing readable in that photo — check the lighting and that the whole page is inside the frame.',
            };
        }
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        return { status: 'error', imageHash: hash, error: `Could not read the photo: ${err.message}` };
    }

    // One pass asks a model to see, read, judge and emit JSON at once. That is a
    // heavier ask than either half alone, and this app still has to run on a
    // 9-14B local model — so when the single call comes back unusable, split the
    // work rather than failing the attempt. Never the default: the split is what
    // costs marks, and it is only reached once the direct route has failed twice.
    if (!grade) {
        try {
            transcription = await readSheet(imageBuffer, { signal, model });
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            return { status: 'error', imageHash: hash, error: `Could not read the photo: ${err.message}` };
        }
        if (isUnreadable(transcription)) {
            return {
                status: 'unreadable',
                imageHash: hash,
                transcription,
                reason: 'Nothing readable in that photo — check the lighting and that the whole page is inside the frame.',
            };
        }
        grade = await gradeTranscription(exercise, transcription, { signal, lang });
    }

    if (!grade) {
        return { status: 'error', imageHash: hash, transcription, error: 'The model did not return a usable grade.' };
    }
    if (isUnreadable(transcription)) {
        return {
            status: 'unreadable',
            imageHash: hash,
            transcription,
            reason: 'Nothing readable in that photo — check the lighting and that the whole page is inside the frame.',
        };
    }
    // The grader gets its own veto: it read the transcription and concluded there
    // was no attempt on the page. Trust it over the length heuristic above.
    if (!grade.readable || grade.total === 0) {
        return {
            status: 'unreadable',
            imageHash: hash,
            transcription,
            reason: grade.feedback || 'No attempt at this exercise could be found on the page.',
        };
    }

    // `graded_by` says HOW it was marked ('vision' vs 'self'); `generated_by`
    // says WHICH model did it. The self-grade path below deliberately leaves the
    // latter NULL — a person marked that one.
    const attempt = db.prepare(`
        INSERT INTO paper_attempts (node_id, feed_item_id, mode, image_hash, transcription, grade, score, total, graded_by, generated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'vision', ?)
    `).run(nodeId, feedItemId, mode, hash, transcription, JSON.stringify(grade), grade.score, grade.total, aiProvenance());

    // Evidence is recorded in rubric-weight units, so a 6-weight exercise carries
    // more than a 4-weight one — and clears MIN_GATE_QUESTIONS the same way a
    // real quiz does.
    const mastery = updateMasteryFromAttempt(nodeId, grade.score, grade.total, 'paper', {
        source: 'paper',
        mode,
        attemptId: attempt.lastInsertRowid,
    });

    return {
        status: 'graded',
        attemptId: attempt.lastInsertRowid,
        imageHash: hash,
        transcription,
        grade,
        mastery,
    };
}

/**
 * The no-vision path: the learner reads the reference solution and marks their
 * own work. Recorded honestly as `graded_by: 'self'` so a later look at the
 * history can tell a machine grade from a self-assessment — but it still feeds
 * BKT, because a learner who has just compared their working line-by-line
 * against a full worked solution has genuinely learned something, and refusing
 * to record it would make the whole feature worthless without a vision model.
 */
export function recordSelfGrade({ nodeId, feedItemId = null, exercise, metCount }) {
    const rubric = exercise.rubric || [];
    const total = rubric.reduce((sum, r) => sum + (r.weight || 1), 0);
    const clamped = Math.max(0, Math.min(rubric.length, Math.round(Number(metCount) || 0)));
    // The learner reports how many points they hit, not which — scale it onto the
    // weighted total so self-grades and machine grades live on one scale.
    const score = rubric.length === 0 ? 0 : Math.round((clamped / rubric.length) * total);

    const attempt = db.prepare(`
        INSERT INTO paper_attempts (node_id, feed_item_id, mode, score, total, graded_by)
        VALUES (?, ?, ?, ?, ?, 'self')
    `).run(nodeId, feedItemId, exercise.mode === 'photo' ? 'photo' : 'document', score, total);

    const mastery = updateMasteryFromAttempt(nodeId, score, total, 'paper', {
        source: 'paper',
        selfGraded: true,
        attemptId: attempt.lastInsertRowid,
    });

    return { status: 'graded', attemptId: attempt.lastInsertRowid, score, total, mastery, selfGraded: true };
}
