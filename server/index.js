import express from 'express';
import cors from 'cors';
import { randomUUID, createHash } from 'node:crypto';
import db, { NOW_ISO } from './database.js';
import {
    getAISettings,
    checkOllamaHealth,
    generateResponse,
    streamResponse,
    streamProjectThinking,
    buildNodeContext,
    searchDocuments,
    chunkText,
    getInstalledModels,
    probeAiReachable,
    pullModel,
    deleteModel,
    checkAnswerWithAI,
    streamRepairVisualSpec,
    streamReviseVisualSpec,
    captionVisual,
    aiConcurrency,
    stripCodeFence,
    widgetSpecLabel,
    VISUAL_BRIEF_KINDS,
    AI_PROMPTS,
    aiProvenance,
    isReasoningLoop,
    normalizeOpenAIBaseUrl,
} from './ai.js';

import {
    recordVisualFeedback,
    recordVisualOutcome,
    visualFeedbackSummary,
    readVisualFeedback,
    clearVisualFeedback,
    visualFeedbackPath,
} from './visualFeedback.js';
import { compileWidget, getCachedBuild, specHashOf } from './widgets.js';
import { authorVisual, getCachedVisual, visualBriefHash, visualBriefLabel } from './visualAuthor.js';

import {
    requireAuth,
    isAuthEnabled,
    isRequestAuthenticated,
    isAuthSettingKey,
    isSecretSettingKey,
    checkPassword,
    setPassword,
    clearAuth,
    issueToken,
    setSessionCookie,
    clearSessionCookie,
    isSecureRequest,
    getApiKey,
    regenerateApiKey,
    deleteApiKey,
    loginBlocked,
    recordLoginFailure,
    recordLoginSuccess,
} from './auth.js';

import {
    parseJsonWithRepair,
    searchAndCurateResources,
    sanitizeQuestionMedia,
} from './agentic.js';
import { normalizeQuestionFormat } from './answerFormats.js';
import { questionDefects } from './feedQuality.js';

import {
    allocateSchedule,
    persistSchedule,
    recalibrateSchedule,
    calculatePace,
    getScheduleSummary,
    daysBetween,
} from './scheduling.js';

import {
    updateMasteryFromAttempt,
    checkMasteryEligibility,
    getProjectMasteryStats,
    getNodeMasteryDetail,
    getDecayingNodes,
    hasProvenTopics,
} from './mastery.js';

import {
    generateDailyPlan,
    getGhostQuestions,
} from './dailyPlan.js';

import {
    buildTodayData,
    buildTodayActivity,
    buildTodayBriefingContext,
    buildCalendarRange,
    LEAF_NODE,
    WORK_LEAF,
    OPEN_WORK_LEAF,
    ACTIVE_PROJECT_JOIN,
    structuralChildren,
    workLeaves,
} from './today.js';

import { composeFeed, buildFeedHeader, consumeFeedItem, replaceSpecInContent } from './feed.js';
import { formatSourceContext, resolveCitations } from './citations.js';
import { webAllowedForTurn } from './webContext.js';
import { chatTools, runToolRounds } from './aiTools.js';
import { decidePaperVision, gradePaperAttempt, recordSelfGrade } from './paper.js';
import {
    buildQuizPrompt, buildFlashcardPrompt, finalizeQuiz, finalizeFlashcards, vetQuiz,
} from './studyMaterial.js';
import { bulkCandidates, startBulk, bulkStatus, cancelBulk, bulkEstimates, MAX_BULK_NODES } from './bulkGen.js';
import { createCapture, enrichCapture } from './capture.js';
import { LANGUAGES, isSupportedLanguage, invalidateProjectLanguage, getLanguage, getUiLanguage } from './language.js';
import {
    listProviders, getProvider, setProviderEnabled, saveProvider, deleteProvider,
    syncBuiltinProviders, PROVIDER_KINDS, PROVIDER_ICONS, PROVIDER_SURFACES,
} from './searchProviders.js';
import * as feedGen from './feedGen.js';

import * as tasks from './tasks.js';
import {
    logActivity, readActivity, activityStats, streamActivityLog, clearActivityLog,
    invalidateActivityLogSetting,
} from './activityLog.js';

// The queue asks this on every pump, so switching provider in Settings changes
// the parallelism on the next task: one slot on a local model, three on a
// hosted API (see aiConcurrency in ai.js).
tasks.setConcurrencyProvider(aiConcurrency);

// Every background job leaves one line behind: what kind it was, how long it
// ran, and why it stopped. The task's LABEL never travels — it is the topic's
// title, which is the learner's content; the kind and the project id say enough
// to find it again.
tasks.setTaskObserver(({ phase, kind, projectId, ms, error }) => {
    logActivity({
        area: 'task',
        event: `task.${phase}`,
        level: phase === 'error' ? 'error' : 'info',
        ms,
        projectId: projectId ?? undefined,
        detail: error ? `${kind} · ${error}` : kind,
    });
});

import {
    indexDocument,
    removeChunkVectors,
    getEmbeddingConfig,
    setEmbeddingSettings,
    embeddingStats,
    probeEmbedding,
    reindexAll,
} from './embeddings.js';

import {
    similarNodes,
    searchNodesSemantic,
    scheduleNodeSync,
    reindexAllNodes,
    nodeEmbeddingStats,
    MIN_SIMILARITY,
} from './nodeEmbeddings.js';

import {
    computeTransfer,
    getTransferInfo,
    applyTransfer,
    scheduleTransferSweep,
} from './masteryTransfer.js';

import {
    probeAvailability,
    getProbe,
    getProbeById,
    createProbe,
    generateProbeQuestions,
    answerProbeQuestion,
    finishProbe,
    discardProbe,
    summariseProbe,
} from './placement.js';

import {
    parseApkg, buildPreview, stageImport, getStaged, dropStaged, commitImport, sweepOrphanMedia,
    findStagedMedia,
} from './ankiImport.js';

import { buildAtlas, invalidateAtlas } from './atlas.js';
import { validateUserName, setRegionName, clearRegionName, regionNameStats } from './regionNaming.js';

import {
    buildDeckData, deckCounts, studyQueue, globalStudyQueue, setNewPerDay, getNewPerDay, reviewDue,
} from './decks.js';
import {
    backfillNodeRoles, projectTeaches, setProjectTeaches, TOPIC_NODE, isPagination,
} from './nodeRole.js';

import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import vaultStorage, { sha256, mediaStorage } from './vaultStorage.js';
import { buildProjectApkg } from './ankiExport.js';
import {
    describeMedia, describeStats, describeProgress, startDescribeSweep, cancelDescribeSweep,
} from './mediaDescribe.js';
import { extractText, MAX_FILE_BYTES, assertZipSafe } from './extract.js';
import { queueRecovery, resumePendingRecovery } from './pdfRecovery.js';
import {
    VALID_NODE_STATUSES,
    sanitizeResourceType,
    ImportError,
    normalizeImportProject,
    normalizeImportTree,
    normalizeMaterialPayload,
    matchMaterialToLeaves,
    leafHasMaterial,
    MATERIAL_MIN_CHARS,
} from './curriculumSchema.js';
import { buildOutlineBrief, buildMaterialBrief } from './authoringBrief.js';
import { sanitizeUrl, MAX_URL_LENGTH, SAFE_URL_PROTOCOLS } from './urlSafety.js';
import { originGuard, isAllowedOrigin } from './originGuard.js';
import { compressJson, precompressedStatic } from './httpCompression.js';
import { slowRequestLog, startEventLoopMonitor } from './slowLog.js';
import { buildId } from './buildId.js';
import { Worker } from 'node:worker_threads';
import { logReview, undoLastReview, normalizeRating, reviewLogStats, loadReviewSequences } from './reviewLog.js';
import { recordCardEvidence } from './cardEvidence.js';
import { DEFAULT_W, MIN_FIT_REVIEWS, isValidW, retentionReport } from './fsrsOptimizer.js';
import { loadAttemptSequences, fit as fitBktRates, MIN_FIT_ATTEMPTS } from './bktOptimizer.js';
import { getLearnerBktParams, reloadLearnerBktParams, BKT_PARAMS } from './mastery.js';
import {
    appVersion, fetchLatestRelease, updateStatus, REPO_URL,
    CHECK_INTERVAL_MS, RETRY_DELAY_MS,
} from './version.js';
import { createDesktop, isDesktop, NOT_DESKTOP } from './desktop.js';
import { closeDatabase, DB_PATH } from './database.js';
import { createAppIconRouter } from './appIcon.js';
import { appIconFromSettings, ICON_SETTING_KEYS } from './iconArt.js';
import { dataPaths } from './paths.js';
import { loadProjectSummaries } from './projectSummary.js';
import { projectProgress, topicFraction, topicWeight } from './progress.js';
import { projectCompletion, markCelebrated } from './completion.js';

/** Read a single setting value with a fallback. */
function getSetting(key, fallback) {
    try {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row && row.value != null ? row.value : fallback;
    } catch {
        return fallback;
    }
}

/** Resolved configuration for the mastery / completion gate. */
function getGateConfig() {
    const mode = getSetting('mastery_gate_mode', 'advisory');
    return {
        mode: ['off', 'advisory', 'enforced'].includes(mode) ? mode : 'advisory',
        threshold: parseFloat(getSetting('mastery_threshold', '0.85')) || 0.85,
        bossPass: parseFloat(getSetting('boss_fight_pass', '0.8')) || 0.8,
        decayDays: parseInt(getSetting('decay_days', '14'), 10) || 14,
    };
}

// Uploads are buffered in memory (we hash + extract them immediately, then
// hand the bytes to the content-addressed blob store) and hard-capped per file.
const vaultUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 100 },
});

// Multipart bodies are buffered in memory, and multer's caps are PER FILE —
// `files: 100` × a 25 MB file cap is 2.5 GB of buffers if they all land at
// once. Browsers always send Content-Length on uploads, so a cheap pre-check
// refuses the oversized aggregate before multer reads a byte. A chunked upload
// with no Content-Length slips past this check and is bounded only by the
// per-file caps; browsers do not send file uploads that way.
function rejectOversizedBody(capBytes) {
    return (req, res, next) => {
        const len = Number(req.headers['content-length']);
        if (Number.isFinite(len) && len > capBytes) {
            return res.status(413).json({ error: `Upload too large — the limit is ${Math.round(capBytes / (1024 * 1024))} MB` });
        }
        next();
    };
}

// MIME type for inline viewing of an original by its logical kind/extension.
const MIME_BY_KIND = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    text: 'text/plain; charset=utf-8',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
};
const IMAGE_KINDS = ['jpg', 'png', 'webp'];

// Process-level error handlers
// Unhandled rejections are logged but NOT fatal — they typically
// come from async route handlers (SSE streams, AI calls, etc.)
// that Express 4.x cannot catch.  Killing the process here causes
// a cascade where Express tries to clean up mid-shutdown and
// triggers "Cannot read properties of undefined (reading 'method')".

process.on('unhandledRejection', (err) => {
    console.error('[ERROR] Unhandled Rejection (non-fatal):', err);
    // Individual request errors should be handled by Express error
    // middleware and route-level try/catch.
});

process.on('uncaughtException', (err) => {
    // Truly unexpected synchronous errors are still fatal,
    // but we log extra context to aid debugging.
    console.error('[FATAL] Uncaught Exception:', err);
    console.error('[FATAL] This is likely caused by a bug in Express or a native module.');
    console.error('[FATAL] Try: rm -rf node_modules && npm install');
    process.exit(1);
});

// App setup

const app = express();
// Trust a loopback proxy only (e.g. `tailscale serve` → localhost). This lets
// req.secure / X-Forwarded-Proto be honoured for the cookie Secure flag without
// trusting arbitrary client-supplied forwarding headers.
app.set('trust proxy', 'loopback');
// First in the chain on purpose: this measures what the CLIENT waited for, so it
// has to start counting before the body parser and the auth gate. Silent unless
// a request crosses a second. See server/slowLog.js.
app.use(slowRequestLog());
// Cross-origin access is refused rather than granted by default: both supported
// deployments (Vite's /api proxy in dev, the single-origin standalone build) are
// same-origin, and a browser never consults CORS headers on a same-origin
// response — so reflection here serves ONLY the explicit embedders listed in
// ALLOWED_ORIGINS. Everything else is judged — and refused outright — by the
// originGuard mounted below. See server/originGuard.js.
app.use(cors({
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    credentials: true,
}));
// 25 MB of JSON is a full curriculum with materials several times over (the
// largest project in a real library measures well under 10 MB of text) — the
// old 50 MB asked a request to be able to park 50 MB of parsed objects in RAM
// for no payload anyone has.
app.use(express.json({ limit: '25mb' }));
// Gzip the large answers (the atlas is 677 KB of JSON, the project list 333 KB).
// Mounted here so it wraps `res.json` for every route below, including the ones
// that answer before the auth gate. See server/httpCompression.js.
app.use(compressJson());

// Baseline response headers. The CSP half is deliberately REPORT-ONLY: the app
// has never carried one, and turning one on blind would break KaTeX's injected
// styles, Mermaid's, and the sandboxed visual frames before anything is
// measured to need it. Report-only puts every violation in the browser console
// while breaking nothing, which is how an enforced policy gets written later.
// `no-referrer` is the one with teeth today: saved links open external sites,
// and a local origin has no business being announced to them.
const CSP_REPORT_ONLY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "frame-src 'self' blob:",
    "frame-ancestors 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
].join('; ');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY);
    next();
});

// Refuse the request itself, not just the answer. Mounted before the auth gate
// so a drive-by cannot even spend a login attempt.
app.use('/api', originGuard);

// Express 4 does not forward a rejected promise to the error middleware, and the
// process-level `unhandledRejection` handler above only logs — so a throw inside
// an async handler left the request hanging until the client gave up. `wrap`
// routes the rejection to next(), i.e. to the JSON 500 at the end of this file.
// Applied to the async handlers that are not already wholly inside their own
// try/catch; a handler that catches everything itself needs nothing.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- Single-user auth gate ---------------------------------------------------
// Public auth endpoints are registered BEFORE requireAuth so they stay reachable
// while the app is locked. Everything mounted after requireAuth is protected
// (no-op when no password is configured — see server/auth.js).

// Unauthenticated-safe: tells the client whether a gate exists and whether this
// caller is already past it, so the UI can decide to show the login screen.
app.get('/api/auth/status', (req, res) => {
    const enabled = isAuthEnabled();
    res.json({ enabled, authenticated: enabled ? isRequestAuthenticated(req) : true });
});

app.post('/api/auth/login', (req, res) => {
    if (!isAuthEnabled()) return res.json({ ok: true, enabled: false });
    const ip = req.ip || 'unknown';
    const wait = loginBlocked(ip);
    if (wait > 0) {
        return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.`, retryAfter: wait });
    }
    const password = req.body && req.body.password;
    if (typeof password !== 'string' || !checkPassword(password)) {
        recordLoginFailure(ip);
        return res.status(401).json({ error: 'Incorrect password' });
    }
    recordLoginSuccess(ip);
    setSessionCookie(res, issueToken(), isSecureRequest(req));
    res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res, isSecureRequest(req));
    res.json({ ok: true });
});

// First-run: set the initial password. Allowed only while no password exists yet;
// once set, use /change (which requires the current password).
app.post('/api/auth/setup', (req, res) => {
    if (isAuthEnabled()) return res.status(409).json({ error: 'A password is already set' });
    const password = req.body && req.body.password;
    if (typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    setPassword(password);
    setSessionCookie(res, issueToken(), isSecureRequest(req)); // log the setter in
    res.json({ ok: true });
});

app.post('/api/auth/change', (req, res) => {
    if (!isAuthEnabled()) return res.status(409).json({ error: 'No password is set' });
    if (!isRequestAuthenticated(req)) return res.status(401).json({ error: 'Authentication required', authRequired: true });
    const { currentPassword, newPassword } = req.body || {};
    if (!checkPassword(String(currentPassword ?? ''))) {
        return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    setPassword(newPassword); // rotates the session secret → logs out other devices
    setSessionCookie(res, issueToken(), isSecureRequest(req)); // keep THIS device logged in
    res.json({ ok: true });
});

// Remove the gate entirely (requires the current password).
app.post('/api/auth/disable', (req, res) => {
    if (!isAuthEnabled()) return res.json({ ok: true });
    if (!isRequestAuthenticated(req)) return res.status(401).json({ error: 'Authentication required', authRequired: true });
    if (!checkPassword(String((req.body && req.body.password) ?? ''))) {
        return res.status(401).json({ error: 'Password is incorrect' });
    }
    clearAuth();
    clearSessionCookie(res, isSecureRequest(req));
    res.json({ ok: true });
});

// API key for programmatic clients (bot / curl / scripts). Requires auth.
app.get('/api/auth/apikey', (req, res) => {
    if (!isAuthEnabled() || !isRequestAuthenticated(req)) {
        return res.status(401).json({ error: 'Authentication required', authRequired: true });
    }
    res.json({ apiKey: getApiKey() });
});
app.post('/api/auth/apikey/regenerate', (req, res) => {
    if (!isAuthEnabled() || !isRequestAuthenticated(req)) {
        return res.status(401).json({ error: 'Authentication required', authRequired: true });
    }
    res.json({ apiKey: regenerateApiKey() });
});
// Withdraw the key. Regenerating answers "it leaked"; this answers "nothing
// uses one any more", and without it the only way to stop a standing bearer
// credential existing was to take the password off the whole app.
app.delete('/api/auth/apikey', (req, res) => {
    if (!isAuthEnabled() || !isRequestAuthenticated(req)) {
        return res.status(401).json({ error: 'Authentication required', authRequired: true });
    }
    deleteApiKey();
    res.json({ apiKey: null });
});

// --- Desktop lifecycle (server/desktop.js) ------------------------------------
// Present only when the desktop launcher started this process. The status probe
// and the heartbeat are public: the launcher is not a browser and holds no
// session, and the locked screen must count as an open window too.
let boundPort = Number(process.env.PORT) || 3001;
const desktop = isDesktop()
    ? createDesktop({
        dataDir: dataPaths().dataDir,
        dbPath: DB_PATH,
        version: appVersion().version,
        port: () => boundPort,
        getSetting,
        setSetting: (key, value) =>
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value),
        onShutdown: shutdownProcess,
    })
    : null;
if (desktop) app.use(desktop.publicRouter);
else app.get('/api/desktop/status', (req, res) => res.json(NOT_DESKTOP));

// --- The app's icon (server/appIcon.js) ---------------------------------------
// The manifest and the icon PNGs, rendered from the three settings rows that say
// which cut of the mark, what colour its tile is and how round it is.
//
// PUBLIC, and above the auth gate on purpose: a locked app still has a tab and
// still has to be installable, and the one thing these endpoints disclose is a
// logo. They are also the reason the pictures live under `/api` at all — the
// service worker caches every other same-origin GET cache-FIRST, which would
// pin an icon to the build rather than to the setting.
app.use(createAppIconRouter({
    readIcon: () => appIconFromSettings({
        [ICON_SETTING_KEYS.style]: getSetting(ICON_SETTING_KEYS.style, null),
        [ICON_SETTING_KEYS.background]: getSetting(ICON_SETTING_KEYS.background, null),
        [ICON_SETTING_KEYS.radius]: getSetting(ICON_SETTING_KEYS.radius, null),
    }),
}));

// Everything below this line requires a valid session/bearer when a password is set.
app.use('/api', requireAuth);
if (desktop) app.use(desktop.protectedRouter);

// sanitizeResourceType comes from curriculumSchema.js along with the list it
// checks against — both had drifted into three copies (here, agentic.js, and
// the importer's own opinion) that disagreed about `course_link` and `link`.

const normalizeWhitespace = (text = '') =>
    String(text ?? '').replace(/\s+/g, ' ').trim();

const truncateWords = (text = '', count = 20) =>
    normalizeWhitespace(text).split(' ').filter(Boolean).slice(0, count).join(' ');

const stripCodeFences = (text = '') =>
    String(text ?? '').replace(/```json/gi, '```').replace(/```/g, '').trim();

const buildProjectDescription = (summary = '') => {
    const clean = truncateWords(stripCodeFences(summary), 24) || 'AI-generated learning project';
    return clean;
};

// AI validation helpers

function cleanSummary(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/```json?\s*\n?/gi, '')
        .replace(/```/g, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/__(.*?)__/g, '$1')
        .replace(/_(.*?)_/g, '$1')
        .replace(/`(.*?)`/g, '$1')
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .replace(/^#+\s*/gm, '')
        .trim();
}

function validateCategories(data) {
    if (!data) return [];
    const arr = Array.isArray(data) ? data : (data.categories || []);
    if (!Array.isArray(arr)) return [];
    return arr
        .filter(c => c && typeof c === 'object' && c.title)
        .map(c => ({
            title: String(c.title).slice(0, 500),
            description: String(c.description || '').slice(0, 10000),
        }));
}

function validateElements(data) {
    if (!data) return [];
    const arr = Array.isArray(data) ? data : (data.elements || []);
    if (!Array.isArray(arr)) return [];
    return arr
        .filter(e => e && typeof e === 'object' && e.title)
        .map(e => ({
            title: String(e.title).slice(0, 500),
            description: String(e.description || '').slice(0, 10000),
        }));
}

function validateSubElements(data) {
    if (!data) return [];
    const arr = Array.isArray(data) ? data : (data.subElements || []);
    if (!Array.isArray(arr)) return [];
    return arr
        .filter(s => s && typeof s === 'object' && s.title)
        .map(s => ({
            title: String(s.title).slice(0, 500),
            description: String(s.description || '').slice(0, 10000),
        }));
}

const normalizeTitle = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Validate one BATCHED sub-element response — every topic of a phase expanded in
 * a single call — into `Map<elementIndex, subElements[]>`.
 *
 * Matching is by normalized title first; whatever is left over is assigned to
 * still-unmatched elements in order, because a model that lightly rewords a
 * title ("Ohm's Law" → "Ohms law basics") still emitted the groups in the order
 * it was given. Anything that can't be placed is simply dropped — the caller
 * falls back to the per-element prompt for elements that came back empty, so a
 * partial batch is a partial saving, never a hole in the tree.
 */
function validateSubElementBatch(data, elements) {
    const out = new Map();
    if (!data) return out;
    const groups = Array.isArray(data) ? data : (data.topics || data.elements || []);
    if (!Array.isArray(groups)) return out;

    const byTitle = new Map(elements.map((e, i) => [normalizeTitle(e.title), i]));
    const leftovers = [];

    for (const g of groups) {
        if (!g || typeof g !== 'object') continue;
        const subs = validateSubElements({ subElements: g.subElements || g.sub_elements || g.children });
        if (subs.length === 0) continue;
        const idx = byTitle.get(normalizeTitle(g.element || g.title || g.topic));
        if (idx != null && !out.has(idx)) out.set(idx, subs);
        else leftovers.push(subs);
    }

    for (let i = 0; i < elements.length && leftovers.length > 0; i++) {
        if (!out.has(i)) out.set(i, leftovers.shift());
    }
    return out;
}

// Generate → parse → validate one structure phase (categories / elements /
// sub-elements), retrying a couple of times when the model returns unusable
// JSON. Previously each phase was a single shot: a garbled response made the
// matching validate*() return [], silently leaving a category or element with
// no children. A cheap retry (with the temperature nudged up each attempt to
// escape a deterministic bad output) recovers most of those. The common case is
// unchanged — a valid first response returns immediately without extra calls.
async function generateStructure(promptPair, validate, { signal, minItems = 1 } = {}) {
    let best = [];
    for (let attempt = 0; attempt < 3; attempt++) {
        if (signal?.aborted) throw new Error('Cancelled');
        const resp = await generateResponse(promptPair.user, promptPair.system, [], {
            signal, temperature: 0.2 + attempt * 0.15, top_p: 0.8, operation: 'structure',
        });
        const data = validate(parseJsonWithRepair(resp));
        if (data.length > best.length) best = data;
        if (data.length >= minItems) return data;
    }
    return best;
}

async function findResourcesForSubElement(
    projectName, categoryTitle, elementTitle,
    subElementTitle, subElementDescription,
    signal, projectSummary
) {
    try {
        const results = await searchAndCurateResources(
            projectName, projectSummary || '',
            categoryTitle, elementTitle,
            subElementTitle, subElementDescription || '',
            signal
        );
        return results.map(r => ({
            title: r.title || 'Resource',
            url: r.url || '',
            type: sanitizeResourceType(r.type),
        }));
    } catch (e) {
        console.log('[Resources] findResourcesForSubElement failed:', e.message);
        return [];
    }
}

// DB helpers

// A new project goes to the end of the list. Prepared once: the import doors
// run it inside a transaction, so re-preparing it there recompiled the same SQL
// on every imported course.
const nextProjectPositionStmt = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 as pos FROM projects');
const nextProjectPosition = () => nextProjectPositionStmt.get().pos;

// The project lookup every :projectId route opens with. Returns the row, or
// sends the 404 and returns null so the caller can `if (!project) return;`.
const projectByIdStmt = db.prepare('SELECT id FROM projects WHERE id = ?');
function requireProject(req, res) {
    const id = req.params.projectId ?? req.params.id;
    const project = projectByIdStmt.get(id);
    if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return null;
    }
    return project;
}

// score/total are validated for real inside updateMasteryFromAttempt, which
// every attempt route funnels through; this only decides whether the request is
// well-formed enough to get there, so a malformed body is a 400 rather than the
// 500 a thrown validation error would produce.
function readAttempt(body) {
    const score = body?.score;
    const total = body?.total;
    if (!Number.isInteger(score) || !Number.isInteger(total)) return null;
    if (total < 1 || score < 0 || score > total) return null;
    return { score, total };
}

function setGeneratingFlag(projectId, value) {
    if (!projectId) return;
    db.prepare('UPDATE projects SET ai_generating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(value ? 1 : 0, projectId);
}

function upsertUnfinishedNotice(projectId, reason) {
    if (!projectId) return;
    const projectExists = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!projectExists) {
        console.log('[upsertUnfinishedNotice] Project not found, skipping notice insertion');
        return;
    }
    const title = 'AI generation failed';
    const body = `${reason}\n\nThis project was partially generated by AI and may be incomplete.\nYou can continue editing it manually.`;
    const existing = db.prepare(`
        SELECT id FROM nodes
        WHERE project_id = ? AND is_note = 1 AND title = ?
        LIMIT 1
    `).get(projectId, title);
    if (existing) {
        db.prepare(`
            UPDATE nodes
            SET description = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(body, body, existing.id);
        return;
    }
    const maxPos = db.prepare(`
        SELECT COALESCE(MAX(position), -1) + 1 as pos
        FROM nodes
        WHERE project_id = ? AND parent_id IS NULL
    `).get(projectId);
    db.prepare(`
        INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position)
        VALUES (?, NULL, ?, ?, ?, 'not_started', 1, ?)
    `).run(projectId, title, body, body, maxPos.pos);
}

function markProjectAsUnfinished(projectId, reason) {
    upsertUnfinishedNotice(projectId, reason);
}

// PROJECTS

app.get('/api/projects', (req, res) => {
    try {
        res.json(loadProjectSummaries());
    } catch (err) {
        console.error('[Projects] DB error:', err.message);
        res.status(500).json({ error: 'Failed to load projects', detail: err.message });
    }
});

app.get('/api/ai/generation-status', (req, res) => {
    const generating = db.prepare('SELECT id, name, ai_generating FROM projects WHERE ai_generating = 1').all();
    res.json({ generating });
});

// BACKGROUND AI TASKS (see server/tasks.js)
//
// Every AI generation runs as a background task; the SSE responses below are
// mere subscriptions. These endpoints expose the registry to the UI: the
// global task dock follows /api/tasks/stream, a reopened panel reattaches via
// /api/tasks/:id/stream, and cancel/dismiss are explicit actions — a dropped
// connection never cancels anything.

// Shared SSE plumbing for task subscriptions: disable socket timeouts (a
// thinking model can be silent for minutes), keepalive comments, and a write
// that no-ops once the socket is gone. Mirrors startAiStream, minus the
// abort-on-disconnect semantics (detaching must not cancel the task).
function startSseResponse(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    req.setTimeout(0);
    res.setTimeout(0);
    if (res.socket) res.socket.setTimeout(0);

    let keepAlive = setInterval(() => {
        if (!res.writableEnded) res.write(': keepalive\n\n');
    }, 15000);
    const stopKeepAlive = () => {
        if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    };
    const write = (obj) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const end = () => {
        stopKeepAlive();
        if (!res.writableEnded) { try { res.end(); } catch { } }
    };
    return { write, end, stopKeepAlive };
}

// Attach an HTTP response to a task's event stream. Replays accumulated
// output first (so a reattach shows everything generated so far), then
// follows live until the terminal done/error/cancelled frame.
function attachTaskStream(req, res, taskId) {
    const { write, end, stopKeepAlive } = startSseResponse(req, res);
    const unsub = tasks.subscribe(taskId, (evt) => {
        write(evt);
        if (evt.done || evt.error || evt.cancelled) end();
    });
    if (!unsub) {
        write({ error: 'Task not found — it may have already finished and expired.' });
        return end();
    }
    // Client went away: detach only. The task keeps running; the dock keeps
    // tracking it; a later subscriber replays from the accumulators.
    res.on('close', () => { stopKeepAlive(); unsub(); });
}

// Project display fields for a node-scoped task chip (dock shows the
// project's colour + name next to the label).
function nodeTaskInfo(nodeId) {
    return db.prepare(`
        SELECT n.id, n.title, n.project_id as projectId, p.name as projectName, p.color as projectColor
        FROM nodes n JOIN projects p ON p.id = n.project_id
        WHERE n.id = ?
    `).get(nodeId);
}

app.get('/api/tasks', (req, res) => {
    res.json(tasks.listTasks());
});

// Live task-list feed for the global dock: a full snapshot on connect, then a
// coalesced snapshot whenever anything changes (status, progress, queue order).
app.get('/api/tasks/stream', (req, res) => {
    const { write, stopKeepAlive } = startSseResponse(req, res);
    write({ tasks: tasks.listTasks() });
    const unsub = tasks.onListChange((list) => write({ tasks: list }));
    res.on('close', () => { stopKeepAlive(); unsub(); });
});

app.get('/api/tasks/:id/stream', (req, res) => {
    attachTaskStream(req, res, req.params.id);
});

app.post('/api/tasks/:id/cancel', (req, res) => {
    const result = tasks.cancelTask(req.params.id);
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json({ success: true });
});

// Dismiss a finished task from the list (the dock's ✕ on a done/failed chip).
app.delete('/api/tasks/:id', (req, res) => {
    const result = tasks.dismissTask(req.params.id);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
});

app.put('/api/projects/reorder', (req, res) => {
    const { projectIds } = req.body;
    const transaction = db.transaction(() => {
        projectIds.forEach((id, index) => {
            db.prepare('UPDATE projects SET position = ? WHERE id = ?').run(index, id);
        });
    });
    transaction();
    // Same shape as GET /api/projects — a degraded row set here would corrupt
    // the grid if a client ever replaces its state with this response. Sharing
    // the query is what keeps that true.
    res.json(loadProjectSummaries());
});

app.get('/api/projects/:id', (req, res) => {
    // `baseline_schedule` is deliberately absent: server/scheduling.js reads the
    // snapshot from the row itself, no client has ever read it, and selecting it
    // here made one archived project's detail 133 kB of a 134 kB reply.
    const project = db.prepare(`
        SELECT id, name, description, summary, color, icon, position, ai_generating,
               start_date, deadline, study_days, status,
               created_at, updated_at
        FROM projects WHERE id = ?
    `).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
});

app.post('/api/projects', (req, res) => {
    const { name, description, color, icon, content_language } = req.body;
    const lang = isSupportedLanguage(content_language) ? (content_language || '') : '';
    const result = db.prepare('INSERT INTO projects (name, description, color, icon, position, content_language) VALUES (?, ?, ?, ?, ?, ?)')
        .run(name, description || '', color || '#3B82F6', icon || 'folder', nextProjectPosition(), lang);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
    // The id, not the name: the name is the learner's, and the id is what every
    // later row in this log will refer to.
    logActivity({ area: 'project', event: 'project.created', projectId: project.id });
    res.json(project);
});

app.put('/api/projects/:id', (req, res) => {
    const { name, description, color, icon, position, start_date, deadline, study_days, status, content_language } = req.body;
    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (description !== undefined) { updates.push('description = ?'); values.push(description); }
    if (color !== undefined) { updates.push('color = ?'); values.push(color); }
    if (icon !== undefined) { updates.push('icon = ?'); values.push(icon); }
    if (position !== undefined) { updates.push('position = ?'); values.push(position); }
    if (status !== undefined && ['active', 'completed', 'archived'].includes(status)) {
        updates.push('status = ?'); values.push(status);
    }
    if (start_date !== undefined) { updates.push('start_date = ?'); values.push(start_date); }
    if (deadline !== undefined) { updates.push('deadline = ?'); values.push(deadline); }
    if (study_days !== undefined) { updates.push('study_days = ?'); values.push(typeof study_days === 'string' ? study_days : JSON.stringify(study_days)); }
    // '' is a valid value ("follow the material"), so the guard is membership in
    // the catalog, not truthiness. An unknown code is ignored rather than stored:
    // a bogus one would be handed to every authoring prompt as an instruction.
    if (content_language !== undefined && isSupportedLanguage(content_language)) {
        updates.push('content_language = ?'); values.push(content_language || '');
    }

    if (updates.length === 0) {
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
        return res.json(project);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id);
    db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    // The language is cached per project for the life of the process, and it
    // steers every authoring prompt — a stale entry would keep writing lessons
    // in the old language after the learner switched.
    invalidateProjectLanguage(Number(req.params.id));
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    res.json(project);
});

// The catalog the project form's language picker is built from, so the list
// lives in exactly one place (server/language.js) rather than being duplicated
// into the client and drifting.
app.get('/api/languages', (req, res) => {
    res.json(LANGUAGES.map(l => ({ code: l.code, name: l.name, endonym: l.endonym })));
});

// --- Search providers (server/searchProviders.js) --------------------------
// Declarative manifests, no code execution anywhere in this path. These were
// served at /api/addons until 0.69; the name oversold them and spent a word the
// future marketplace needs (docs/ADDONS.md).

app.get('/api/search-providers', (req, res) => {
    const { kind, enabled } = req.query;
    res.json({
        providers: listProviders({
            kind: kind && PROVIDER_KINDS.includes(kind) ? kind : null,
            enabledOnly: enabled === 'true',
        }),
        kinds: PROVIDER_KINDS,
        icons: PROVIDER_ICONS,
        surfaces: PROVIDER_SURFACES,
    });
});

app.post('/api/search-providers', (req, res) => {
    const result = saveProvider(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result.provider);
});

app.put('/api/search-providers/:id', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    if (!setProviderEnabled(req.params.id, enabled)) return res.status(404).json({ error: 'Search provider not found' });
    res.json(getProvider(req.params.id));
});

app.delete('/api/search-providers/:id', (req, res) => {
    const result = deleteProvider(req.params.id);
    if (!result.ok) return res.status(result.error === 'not found' ? 404 : 400).json({ error: result.error });
    res.json({ success: true });
});

// Frees assets a document row leaves behind that aren't reachable through FK
// cascade: sqlite-vec's `vec_chunks` (rowid-keyed, not a real FK) and the
// content-addressed blob on disk (shared/deduped across documents, so only
// GC'd once no other document still points at the same hash). Callers must
// capture `docs`/`chunkIds` BEFORE the delete and invoke this AFTER it, so the
// "still referenced?" check doesn't see the rows being removed.
function freeDocumentAssets(docs, chunkIds) {
    removeChunkVectors(chunkIds);
    const hashes = [...new Set(docs.map(d => d.file_hash).filter(Boolean))];
    for (const hash of hashes) {
        const stillUsed = db.prepare('SELECT 1 FROM documents WHERE file_hash = ? LIMIT 1').get(hash);
        if (!stillUsed) vaultStorage.remove(hash);
    }
}

function documentChunkIds(docs) {
    if (docs.length === 0) return [];
    return db.prepare(
        `SELECT id FROM document_chunks WHERE document_id IN (${docs.map(() => '?').join(',')})`
    ).all(...docs.map(d => d.id)).map(r => r.id);
}

app.delete('/api/projects/:id', (req, res) => {
    // documents/document_chunks cascade via FK on this delete, but vec_chunks
    // and vault blobs don't — capture what's about to be removed first.
    const docs = db.prepare(
        'SELECT id, file_hash FROM documents WHERE project_id = ? OR node_id IN (SELECT id FROM nodes WHERE project_id = ?)'
    ).all(req.params.id, req.params.id);
    const chunkIds = documentChunkIds(docs);

    // Card media: `media_files` cascades with the project, but the bytes are in
    // the blob store, which no FK reaches. The sweep is the same set difference
    // the vault does by hand above — deleting an imported deck must give the
    // disk back, or "undo the import" is only true of the database.
    const hadMedia = db.prepare('SELECT 1 FROM media_files WHERE project_id = ? LIMIT 1').get(req.params.id);

    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);

    freeDocumentAssets(docs, chunkIds);
    if (hadMedia) sweepOrphanMedia({ allowEmpty: true });
    // Worth a line precisely because the row it points at is gone: this is the
    // answer to "where did my project go", and no foreign key may erase it.
    logActivity({
        area: 'project',
        event: 'project.deleted',
        level: 'warn',
        projectId: Number(req.params.id),
        detail: `${docs.length} document(s)${hadMedia ? ', media swept' : ''}`,
    });
    res.json({ success: true });
});

// NODES

// Query params are an API contract: an unrecognised one means the caller
// believes it asked for something we never did. Answering 200 with unfiltered
// rows reads as a successful filter and silently corrupts whatever the caller
// computes next, so reject instead of ignoring.
const NODES_QUERY_PARAMS = ['status', 'leavesOnly'];

app.get('/api/projects/:projectId/nodes', (req, res) => {
    const unknown = Object.keys(req.query).filter(k => !NODES_QUERY_PARAMS.includes(k));
    if (unknown.length > 0) {
        return res.status(400).json({
            error: `Unknown query parameter(s): ${unknown.join(', ')}`,
            supported: NODES_QUERY_PARAMS,
        });
    }

    const { status, leavesOnly } = req.query;
    if (status !== undefined && !VALID_NODE_STATUSES.includes(status)) {
        return res.status(400).json({
            error: `Invalid status "${status}"`,
            valid: VALID_NODE_STATUSES,
        });
    }

    const filters = ['n.project_id = ?'];
    const values = [req.params.projectId];
    if (status !== undefined) {
        filters.push('n.status = ?');
        values.push(status);
    }
    // Opt-in leaf scope: the unit of work the progress counts are based on.
    // Lets a caller reproduce node_count/completed_count without rebuilding
    // the tree client-side to find out which rows are section headers.
    if (leavesOnly === 'true') filters.push(LEAF_NODE);

    // The card counts ride along so the tree's own rollup can use the same
    // progress rule the server does (`topicFraction`, server/progress.js) —
    // without them the workspace bars would still be counting ticks while the
    // project card counts cards, which is exactly the two-numbers-for-one-thing
    // this app keeps having to fix. Aggregated once, not per row: a correlated
    // subquery here runs a thousand times on the big projects.
    const nodes = db.prepare(`
        SELECT n.id, n.uuid, n.project_id, n.parent_id, n.title, n.description, n.notes, n.status,
               n.is_note, n.role, n.position, n.scheduled_start, n.scheduled_end, n.estimated_weight,
               n.completed_at, n.created_at, n.updated_at,
               COALESCE(fc.cards, 0) AS cards, COALESCE(fc.seen, 0) AS seen
        FROM nodes n
        LEFT JOIN (
            SELECT f.node_id,
                   COUNT(*) AS cards,
                   SUM(CASE WHEN f.review_count > 0 AND f.last_reviewed IS NOT NULL THEN 1 ELSE 0 END) AS seen
            FROM flashcards f GROUP BY f.node_id
        ) fc ON fc.node_id = n.id
        WHERE ${filters.join(' AND ')} ORDER BY n.position
    `).all(...values);
    res.json(nodes);
});

// Hoisted: a reorder carries a whole sibling list, so preparing inside the loop
// re-compiles the same statement once per node on every drag.
const nodeProjectStmt = db.prepare('SELECT id, project_id FROM nodes WHERE id = ?');
const nodeRepositionStmt = db.prepare('UPDATE nodes SET position = ?, parent_id = ? WHERE id = ?');

app.put('/api/nodes/reorder', (req, res) => {
    const { nodeIds, parentId } = req.body;
    if (!Array.isArray(nodeIds)) return res.status(400).json({ error: 'nodeIds must be an array' });

    // This path re-parents too, so it owes the same guard as /move and /:id:
    // a cycle in parent_id makes buildTree drop the loop from every view and
    // never terminates the recursive CTE in DELETE /api/nodes/:id. It had none.
    const rows = nodeIds.map(id => nodeProjectStmt.get(id));
    for (let i = 0; i < nodeIds.length; i++) {
        if (!rows[i]) return res.status(400).json({ error: 'Node not found' });
        if (rows[i].project_id !== rows[0].project_id) {
            return res.status(400).json({ error: 'A node cannot be moved into another project' });
        }
        const bad = reparentError(nodeIds[i], parentId ?? null);
        if (bad) return res.status(400).json({ error: bad });
    }
    // reparentError only checks the parent against the node it is given, so a
    // null parentId (a move to the root) still needs the batch pinned to one
    // project — otherwise a mixed batch silently adopts rows from elsewhere.
    if (parentId != null) {
        const parent = nodeProjectStmt.get(parentId);
        if (!parent) return res.status(400).json({ error: 'Parent node not found' });
        if (rows.length && parent.project_id !== rows[0].project_id) {
            return res.status(400).json({ error: 'A node cannot be moved into another project' });
        }
    }

    const transaction = db.transaction(() => {
        nodeIds.forEach((id, index) => {
            nodeRepositionStmt.run(index, parentId, id);
        });
    });
    transaction();
    if (nodeIds.length > 0) {
        const node = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeIds[0]);
        if (node) {
            const nodes = db.prepare('SELECT * FROM nodes WHERE project_id = ? ORDER BY position').all(node.project_id);
            return res.json({ success: true, nodes });
        }
    }
    res.json({ success: true });
});

app.post('/api/nodes', (req, res) => {
    const { project_id, parent_id, title, description, notes, status, is_note } = req.body;
    if (status !== undefined && !VALID_NODE_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Invalid status "${status}".` });
    }
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 as pos FROM nodes WHERE project_id = ? AND parent_id IS ?')
        .get(project_id, parent_id || null);
    const result = db.prepare(`
        INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(project_id, parent_id || null, title, description || '', notes || '', status || 'not_started', is_note || 0, maxPos.pos);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(result.lastInsertRowid);
    scheduleNodeSync();
    res.json(node);
});

app.put('/api/nodes/:id', (req, res) => {
    const { title, description, notes, status, position, parent_id, is_note, estimated_weight, chat_draft } = req.body;
    const setClauses = [];
    const values = [];

    if (title !== undefined) { setClauses.push('title = ?'); values.push(title); }
    if (description !== undefined) { setClauses.push('description = ?'); values.push(description); }
    if (notes !== undefined) { setClauses.push('notes = ?'); values.push(notes); }
    if (status !== undefined) {
        if (!VALID_NODE_STATUSES.includes(status)) {
            return res.status(400).json({ error: `Invalid status "${status}".` });
        }

        const nodeId = Number(req.params.id);
        // `override` lets the learner consciously mark a topic done without
        // proving mastery (the "mark done anyway" path). 'skipped' never gates.
        const override = req.body.override === true;
        const gate = getGateConfig();

        // Mastery gate for completing a LEAF. Skipped/off/override bypass it.
        // In 'advisory' mode we still return the gate response (so the UI can
        // offer a Boss Fight) but flag it advisory — the learner can override.
        if (status === 'completed' && !override && gate.mode !== 'off') {
            const childCount = db.prepare(
                'SELECT COUNT(*) as c FROM nodes WHERE parent_id = ? AND is_note = 0'
            ).get(nodeId);

            if (childCount.c === 0) {
                const eligibility = checkMasteryEligibility(nodeId, gate.threshold, gate.bossPass);
                if (!eligibility.eligible) {
                    return res.status(400).json({
                        error: eligibility.has_evidence
                            ? `Not proven yet — best mastery ${(eligibility.mastery_score * 100).toFixed(0)}% (need ${(eligibility.threshold * 100).toFixed(0)}%, or pass a Boss Fight).`
                            : `Not proven yet. Take a quiz or Boss Fight to verify mastery${gate.mode === 'advisory' ? ', or mark it done anyway.' : '.'}`,
                        mastery_gate: true,
                        advisory: gate.mode === 'advisory',
                        mastery_score: eligibility.mastery_score,
                        threshold: eligibility.threshold,
                        evidence_count: eligibility.evidence_count,
                    });
                }
            }
        }

        setClauses.push('status = ?');
        values.push(status);
        // Only a verified 'completed' stamps completed_at; skipped is explicitly null.
        setClauses.push('completed_at = ?');
        values.push(status === 'completed' ? new Date().toISOString() : null);
    }
    if (position !== undefined) { setClauses.push('position = ?'); values.push(position); }
    if (parent_id !== undefined) {
        const bad = reparentError(Number(req.params.id), parent_id);
        if (bad) return res.status(400).json({ error: bad });
        setClauses.push('parent_id = ?'); values.push(parent_id);
    }
    if (is_note !== undefined) { setClauses.push('is_note = ?'); values.push(is_note); }
    if (estimated_weight !== undefined) { setClauses.push('estimated_weight = ?'); values.push(estimated_weight); }
    if (chat_draft !== undefined) { setClauses.push('chat_draft = ?'); values.push(chat_draft); }

    if (setClauses.length === 0) {
        const existing = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
        return res.json(existing);
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id);

    db.prepare(`UPDATE nodes SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
    // Only the fields that make up a topic's embedded text are worth a sweep —
    // `parent_id` counts because the parent's title is part of it. A status
    // change is deliberately excluded: the feed writes those constantly and
    // none of them can move a topic in the semantic space.
    if (title !== undefined || description !== undefined || is_note !== undefined || parent_id !== undefined) {
        scheduleNodeSync();
    }
    res.json(node);
});

app.delete('/api/nodes/:id', (req, res) => {
    // nodes.parent_id cascades recursively, so this can take an entire subtree
    // with it — collect every descendant's documents (vec_chunks/vault blobs
    // aren't covered by FK cascade) before deleting.
    const docs = db.prepare(`
        WITH RECURSIVE descendants(id) AS (
            SELECT id FROM nodes WHERE id = ?
            UNION ALL
            SELECT n.id FROM nodes n JOIN descendants d ON n.parent_id = d.id
        )
        SELECT doc.id, doc.file_hash FROM documents doc WHERE doc.node_id IN (SELECT id FROM descendants)
    `).all(req.params.id);
    const chunkIds = documentChunkIds(docs);

    db.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id);

    freeDocumentAssets(docs, chunkIds);
    scheduleNodeSync();   // vec_nodes has no FK — the sweep drops the orphans
    res.json({ success: true });
});

// A node may be re-parented only within its own project, and never under
// itself or one of its descendants. The client (`isDescendantTarget` in the
// sidebar) already refuses such drops, but the API is the boundary that has to:
// a cycle in `parent_id` makes `buildTree` silently drop the loop from every
// view, and the `UNION ALL` recursive CTE in DELETE /api/nodes/:id never
// terminates — a hung server from one bad request. Returns an error string or
// null. A visited set guards the walk against a cycle that already exists.
function reparentError(nodeId, parentId) {
    if (parentId == null) return null;
    const child = db.prepare('SELECT id, project_id FROM nodes WHERE id = ?').get(nodeId);
    const parent = db.prepare('SELECT id, project_id, parent_id FROM nodes WHERE id = ?').get(parentId);
    if (!child) return 'Node not found';
    if (!parent) return 'Parent node not found';
    if (parent.project_id !== child.project_id) return 'A node cannot be moved into another project';
    if (parent.id === child.id) return 'A node cannot be its own parent';
    const seen = new Set([parent.id]);
    let cur = parent;
    while (cur && cur.parent_id != null) {
        if (cur.parent_id === child.id) return 'A node cannot be moved under one of its own descendants';
        if (seen.has(cur.parent_id)) break;
        seen.add(cur.parent_id);
        cur = db.prepare('SELECT id, parent_id FROM nodes WHERE id = ?').get(cur.parent_id);
    }
    return null;
}

// Top-level category for each card's node, memoised per ancestor so a session
// of thousands of cards does not re-walk (and re-prepare) the same chain per
// card. Same result as the old per-card loop: the root ancestor's title + id.
const nodeParentStmt = db.prepare('SELECT id, title, parent_id FROM nodes WHERE id = ?');
function withTopCategory(cards) {
    const memo = new Map();
    const topOf = (id) => {
        if (id == null) return { categoryTitle: null, categoryId: null };
        if (memo.has(id)) return memo.get(id);
        let cur = nodeParentStmt.get(id);
        let depth = 0;
        let out = { categoryTitle: null, categoryId: null };
        while (cur && depth < 10) {
            if (cur.parent_id === null) { out = { categoryTitle: cur.title, categoryId: cur.id }; break; }
            cur = nodeParentStmt.get(cur.parent_id);
            depth++;
        }
        memo.set(id, out);
        return out;
    };
    return cards.map(card => ({ ...card, ...topOf(card.parent_id) }));
}

app.put('/api/nodes/:id/move', (req, res) => {
    const { parent_id, position } = req.body;
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const bad = reparentError(node.id, parent_id);
    if (bad) return res.status(400).json({ error: bad });
    const siblings = db.prepare(`
        SELECT * FROM nodes
        WHERE project_id = ? AND parent_id IS ? AND id != ?
        ORDER BY position
    `).all(node.project_id, parent_id, req.params.id);
    const transaction = db.transaction(() => {
        db.prepare('UPDATE nodes SET parent_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(parent_id, req.params.id);
        siblings.splice(position, 0, { id: node.id });
        siblings.forEach((s, idx) => {
            db.prepare('UPDATE nodes SET position = ? WHERE id = ?').run(idx, s.id);
        });
    });
    transaction();
    const nodes = db.prepare('SELECT * FROM nodes WHERE project_id = ? ORDER BY position').all(node.project_id);
    res.json(nodes);
});

// RESOURCES

app.get('/api/nodes/:nodeId/resources', (req, res) => {
    const resources = db.prepare('SELECT * FROM resources WHERE node_id = ? ORDER BY position').all(req.params.nodeId);
    res.json(resources);
});

// Registered BEFORE the parameterized routes below: Express matches in
// registration order, so '/api/resources/reorder' after '/api/resources/:id'
// would be captured by the :id route (id="reorder") and always fail.
app.put('/api/resources/reorder', (req, res) => {
    const { resourceIds } = req.body;
    const transaction = db.transaction(() => {
        resourceIds.forEach((id, index) => {
            db.prepare('UPDATE resources SET position = ? WHERE id = ?').run(index, id);
        });
    });
    transaction();
    res.json({ success: true });
});

app.post('/api/resources', (req, res) => {
    const { node_id, title, url, type } = req.body;
    // A resource URL is rendered as an href, so the scheme is checked at every
    // write path, not just on import (see server/urlSafety.js).
    const checked = sanitizeUrl(url);
    if (!checked.ok) return res.status(400).json({ error: `Invalid URL: ${checked.reason}` });
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 as pos FROM resources WHERE node_id = ?').get(node_id);
    const result = db.prepare('INSERT INTO resources (node_id, title, url, type, position) VALUES (?, ?, ?, ?, ?)')
        .run(node_id, title, checked.url, sanitizeResourceType(type), maxPos.pos);
    const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(result.lastInsertRowid);
    res.json(resource);
});

app.put('/api/resources/:id', (req, res) => {
    const { title, url, type, completed } = req.body;
    // COALESCE means undefined leaves the stored URL alone; only a supplied one
    // is checked (and normalized — "example.com/x" becomes an https URL).
    let nextUrl = url;
    if (url !== undefined && url !== null) {
        const checked = sanitizeUrl(url);
        if (!checked.ok) return res.status(400).json({ error: `Invalid URL: ${checked.reason}` });
        nextUrl = checked.url;
    }
    // Same vocabulary gate the POST applies — the PUT wrote `type` straight
    // through. Only when one is supplied: sanitizeResourceType(undefined) is
    // 'article', which under COALESCE would rewrite the stored type on a
    // title-only edit.
    const nextType = type === undefined || type === null ? type : sanitizeResourceType(type);
    db.prepare('UPDATE resources SET title = COALESCE(?, title), url = COALESCE(?, url), type = COALESCE(?, type), completed = COALESCE(?, completed) WHERE id = ?')
        .run(title, nextUrl, nextType, completed, req.params.id);
    const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id);
    res.json(resource);
});

app.delete('/api/resources/:id', (req, res) => {
    db.prepare('DELETE FROM resources WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// ONBOARDING
//
// There was no first-run experience at all: a new install got a seeded tutorial
// project and nothing that said what the feed, the gate or the vault were for.
// This is deliberately NOT a tour — no coach marks, no "next" buttons over a UI
// nobody asked to be walked through. It is a checklist of the five things that
// make the loop work, each one satisfied by DOING it, computed from real data.
// So it disappears by being used, and it cannot claim you did something you
// didn't. The copy lives on the client; the server only answers "done or not".
app.get('/api/onboarding', (req, res) => {
    try {
        const count = (sql, ...args) => db.prepare(sql).get(...args)?.c ?? 0;
        const inboxId = Number(getSetting('inbox_project_id', '')) || -1;

        // "A project of your own" — the Inbox is ours, not theirs, so it does
        // not tick this box. There was a seeded tutorial project excluded here
        // by name too; a new library now starts empty, so the only project
        // anyone has is one they made.
        const ownProjects = count('SELECT COUNT(*) c FROM projects WHERE id != ?', inboxId);

        res.json({
            dismissed: getSetting('onboarding_dismissed', 'false') === 'true',
            steps: {
                project: ownProjects > 0,
                schedule: count('SELECT COUNT(*) c FROM projects WHERE start_date IS NOT NULL AND deadline IS NOT NULL') > 0,
                lesson: count("SELECT COUNT(*) c FROM feed_items WHERE kind = 'lesson' AND consumed_at IS NOT NULL") > 0,
                answer: count('SELECT COUNT(*) c FROM mastery_evidence') > 0,
                prove: count("SELECT COUNT(*) c FROM mastery_evidence WHERE evidence_type = 'boss_fight'")
                    + count("SELECT COUNT(*) c FROM nodes WHERE status = 'completed'") > 0,
                vault: count('SELECT COUNT(*) c FROM documents') > 0,
            },
        });
    } catch (err) {
        console.error('[Onboarding] status failed:', err.message);
        res.json({ dismissed: true, steps: {} }); // never block the feed on this
    }
});

app.post('/api/onboarding/dismiss', (req, res) => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_dismissed', ?)")
        .run(req.body?.dismissed === false ? 'false' : 'true');
    res.json({ success: true });
});

// AD-HOC CAPTURE ("I read something and want to keep it")
//
// Two steps on purpose: the node is written synchronously and returned, then
// enrichment runs as a background task. Pressing Save can therefore never lose
// the thing the learner wanted to keep, whatever the AI does afterwards.
app.post('/api/capture', (req, res) => {
    const { text, url, title, hasFiles } = req.body || {};
    let created;
    try {
        created = createCapture({ text, url, title });
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }
    // Map the capture now — enrichment rewrites the title and Overview later,
    // and re-maps it itself when it does.
    scheduleNodeSync();

    // A file/photo capture has nothing to enrich yet — the client uploads the
    // files next and then calls /api/capture/:nodeId/enrich. Starting the
    // background task here would race that upload and see an empty node.
    let taskId = null;
    if (!hasFiles && getAISettings().model) {
        const { task } = tasks.createTask({
            kind: 'capture',
            label: 'Capture',
            projectId: created.projectId,
            nodeId: created.nodeId,
            run: ({ emit, signal }) => enrichCapture({ nodeId: created.nodeId, url, emit, signal }),
        });
        taskId = task.id;
    }

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(created.nodeId);
    res.json({ ...created, taskId, node });
});

// Second half of a file/photo capture — see the `hasFiles` note above.
app.post('/api/capture/:nodeId/enrich', (req, res) => {
    const nodeId = Number(req.params.nodeId);
    const node = db.prepare('SELECT id, project_id FROM nodes WHERE id = ?').get(nodeId);
    if (!node) return res.status(404).json({ error: 'Capture not found' });
    if (!getAISettings().model) return res.json({ taskId: null });

    const { url = '' } = req.body || {};
    const { task } = tasks.createTask({
        kind: 'capture',
        label: 'Capture',
        projectId: node.project_id,
        nodeId,
        run: ({ emit, signal }) => enrichCapture({ nodeId, url, emit, signal }),
    });
    res.json({ taskId: task.id });
});

// Resolve node ids → real titles, for the global planner's `[[open:…]]`
// markers. The model proposes an id; this decides whether it exists and what it
// is actually called, so the app never renders a topic name the model invented.
app.post('/api/nodes/labels', (req, res) => {
    const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 20)
        : [];
    if (ids.length === 0) return res.json([]);
    const rows = db.prepare(`
        SELECT n.id, n.title, n.project_id as projectId, p.name as projectName
        FROM nodes n JOIN projects p ON p.id = n.project_id
        WHERE n.id IN (${ids.map(() => '?').join(',')})
    `).all(...ids);
    res.json(rows);
});

// Curate resources for ONE topic, on demand.
//
// The counterpart to `creation_find_resources`: with per-leaf curation off at
// creation time (the pipeline's most expensive phase), this is how a topic gets
// its links — when the learner actually opens it, not for all 700 leaves up
// front. Also useful with curation ON, to top up a topic whose search came back
// thin. Appends; never removes what is already there.
app.post('/api/ai/nodes/:id/find-resources', async (req, res) => {
    const nodeId = Number(req.params.id);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!node) return res.status(404).json({ error: 'Node not found' });

    const project = db.prepare('SELECT name, summary FROM projects WHERE id = ?').get(node.project_id);

    // Walk up for the phase/topic titles the curator uses to disambiguate a
    // generic leaf title ("Basics" means nothing without its ancestors).
    const ancestors = [];
    let cursor = node.parent_id;
    for (let depth = 0; cursor && depth < 10; depth++) {
        const parent = db.prepare('SELECT id, parent_id, title FROM nodes WHERE id = ?').get(cursor);
        if (!parent) break;
        ancestors.unshift(parent.title);
        cursor = parent.parent_id;
    }

    try {
        const found = await findResourcesForSubElement(
            project?.name || '', ancestors[0] || '', ancestors[ancestors.length - 1] || '',
            node.title, node.description || '', undefined, project?.summary || ''
        );
        const existing = new Set(
            db.prepare('SELECT url FROM resources WHERE node_id = ?').all(nodeId).map(r => r.url)
        );
        const fresh = found.filter(r => r.url && !existing.has(r.url));

        let maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 as pos FROM resources WHERE node_id = ?').get(nodeId).pos;
        const insert = db.prepare('INSERT INTO resources (node_id, title, url, type, completed, position, generated_by) VALUES (?, ?, ?, ?, 0, ?, ?)');
        const provenance = aiProvenance();
        db.transaction(() => {
            for (const r of fresh) insert.run(nodeId, r.title, r.url, r.type, maxPos++, provenance);
        })();

        res.json({
            added: fresh.length,
            resources: db.prepare('SELECT * FROM resources WHERE node_id = ? ORDER BY position').all(nodeId),
        });
    } catch (error) {
        console.error('[Resources] On-demand curation failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// VERSION AND UPDATES
//
// See server/version.js for why the check is shaped the way it is. The short
// version: identity is free and always on, the network call is a button by
// default, and the daily poll is opt-in so SECURITY.md's "start it, sit idle,
// capture nothing" procedure stays literally true on a default install.

/** Who am I. No network, no database — safe to call from anywhere, including
 *  the "report a problem" builder, which needs it before anything else works. */
app.get('/api/version', (req, res) => {
    res.json(appVersion());
});

/** Read the last check's result. Deliberately does NOT check: a GET that reaches
 *  the network as a side effect is exactly the ping this design refuses. */
app.get('/api/updates', (req, res) => {
    res.json(readUpdateState());
});

/**
 * Check now. This is the button — user-initiated, so it is allowed to reach the
 * network even when the daily poll is off. Rate-limited to one call a minute so
 * a stuck client cannot turn a button into a poll.
 */
let lastManualCheck = 0;
app.post('/api/updates/check', wrap(async (req, res) => {
    const now = Date.now();
    if (now - lastManualCheck < 60_000) {
        return res.json({ ...readUpdateState(), throttled: true });
    }
    lastManualCheck = now;
    res.json(await runUpdateCheck());
}));

/** Turn the daily poll on or off. Its own endpoint rather than a generic setting
 *  write, because switching it ON is consent to an outbound call and should read
 *  that way in the code as well as in the UI — and because turning it on should
 *  answer immediately instead of leaving a blank panel until tomorrow. */
app.put('/api/updates/auto', wrap(async (req, res) => {
    const enabled = req.body?.enabled === true;
    setSettingValue('update_check', enabled ? 'on' : 'off');
    if (!enabled) {
        stopUpdatePoll();
        return res.json(readUpdateState());
    }
    startUpdatePoll();
    res.json(await runUpdateCheck());
}));

/** Fold the stored check into a status the UI can render. Pure read. */
function readUpdateState() {
    let latest = null;
    try {
        const raw = getSetting('update_latest', null);
        latest = raw ? JSON.parse(raw) : null;
    } catch { latest = null; }
    return {
        ...updateStatus({
            current: appVersion().version,
            latest,
            checkedAt: getSetting('update_last_check', null),
            enabled: getSetting('update_check', 'off') === 'on',
            error: getSetting('update_last_error', null) || null,
        }),
        repoUrl: REPO_URL,
        deployment: appVersion().deployment,
        updateCommand: appVersion().updateCommand,
    };
}

/**
 * Perform a check and persist the result.
 *
 * A FAILURE MUST NOT ERASE THE LAST GOOD ANSWER. One dropped request would
 * otherwise wipe a known-available update and report "up to date", which is the
 * vision-probe trap in a third costume: cache an answer, never the absence of
 * one. The error is recorded beside the answer so the panel can say the check
 * failed while still showing what it knew.
 */
async function runUpdateCheck() {
    const result = await fetchLatestRelease();
    if (result.ok) {
        setSettingValue('update_latest', result.latest ? JSON.stringify(result.latest) : '');
        setSettingValue('update_last_check', new Date().toISOString());
        setSettingValue('update_last_error', '');
    } else {
        setSettingValue('update_last_error', String(result.error).slice(0, 200));
    }
    return readUpdateState();
}

let pollTimer = null;
let retryTimer = null;

function stopUpdatePoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

/**
 * The opt-in daily poll: one call at startup, then one a day.
 *
 * `unref()` on both timers so a pending check can never be the reason the
 * process refuses to exit — a background convenience must not outrank Ctrl-C.
 * A failed startup check retries once after ten minutes, because a desktop that
 * boots the app before the network is up would otherwise go a full day blind.
 */
function startUpdatePoll() {
    stopUpdatePoll();
    if (getSetting('update_check', 'off') !== 'on') return;
    const tick = async () => {
        const state = await runUpdateCheck();
        if (state.error && !retryTimer) {
            retryTimer = setTimeout(() => { retryTimer = null; tick(); }, RETRY_DELAY_MS);
            retryTimer.unref?.();
        }
    };
    // Not at t=0: startup is already the busiest moment in the process, and
    // nothing about this answer is needed in the first few seconds.
    retryTimer = setTimeout(() => { retryTimer = null; tick(); }, 15_000);
    retryTimer.unref?.();
    pollTimer = setInterval(tick, CHECK_INTERVAL_MS);
    pollTimer.unref?.();
}

// SETTINGS

// Health check (no DB dependency)
app.get('/api/health', (req, res) => {
    let dbOk = false;
    try {
        db.prepare('SELECT 1').get();
        dbOk = true;
    } catch (_) { }
    res.json({
        status: dbOk ? 'ok' : 'degraded',
        database: dbOk ? 'connected' : 'error',
        uptime: process.uptime(),
    });
});

// Settings (wrapped)
app.get('/api/settings', (req, res) => {
    try {
        const settings = db.prepare('SELECT * FROM settings').all();
        const result = {};
        // Never expose secrets through the generic settings dump — it is
        // readable by anything that can reach the app's origin, so it carries
        // preferences and nothing credential-shaped: the auth rows are managed
        // via /api/auth/*, and the cloud provider key via /api/ai/key (the AI
        // panel learns whether a key is saved from /api/ai/status, never its
        // value — the dump used to hand the key itself out in plaintext).
        settings.forEach(s => { if (!isSecretSettingKey(s.key)) result[s.key] = s.value; });
        res.json(result);
    } catch (err) {
        console.error('[Settings] DB error:', err.message);
        res.status(500).json({ error: 'Failed to load settings', detail: err.message });
    }
});

app.put('/api/settings/:key', (req, res) => {
    // Secrets are managed only through their own endpoints (/api/auth/*, and
    // /api/ai/key for the provider key) — block the generic writer so a client
    // can't overwrite the password hash, the session secret or the key.
    if (isSecretSettingKey(req.params.key)) {
        return res.status(403).json({ error: 'This setting is managed via the security or AI settings' });
    }
    const { value } = req.body;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(req.params.key, value);
    // The log reads its own switch through a cache, so the switch has to say
    // when it moved. (Written before the log line below, so turning it ON
    // records that it was turned on and turning it OFF records nothing.)
    if (req.params.key === 'activity_log_enabled') invalidateActivityLogSetting();
    res.json({ success: true });
});

// THE LOCAL ACTIVITY LOG
//
// Read, export, clear. Nothing here reaches the network — the export is a file
// the person downloads and decides what to do with, in the same spirit as the
// bug-report block (src/utils/report.ts): the app assembles the facts, the
// person presses send, somewhere else.

app.get('/api/activity', (req, res) => {
    const { limit, level, area, before } = req.query;
    res.json({
        stats: activityStats(),
        events: readActivity({
            limit: limit ? Number(limit) : 50,
            level: level ? String(level) : null,
            area: area ? String(area) : null,
            before: before ? Number(before) : null,
        }),
    });
});

app.get('/api/activity/export', (req, res) => {
    // Streamed, not built: the cap is 20k rows and this runs on the machine the
    // app is already the heaviest thing on.
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="terramentor-activity-${stamp}.log"`);
    try {
        for (const chunk of streamActivityLog()) res.write(chunk);
        res.end();
    } catch (e) {
        // Headers are already out by then, so there is no status left to send;
        // saying so INSIDE the file beats a truncated download that looks whole.
        res.end(`\n# export failed: ${e.message}\n`);
    }
});

app.delete('/api/activity', (req, res) => {
    const ok = clearActivityLog();
    logActivity({ area: 'server', event: 'activity.cleared' });
    res.json({ success: ok });
});

// A SearXNG instance is deliberately exempt from `netSafety` — a private or
// loopback address is the normal case for one, so this is the one endpoint that
// fetches a private host on purpose. What it must NOT be is a general prober:
// the reply distinguishes reachable from refused from timed out, so without a
// scheme check and `redirect: 'manual'` it answers "is there something on this
// address" for any protocol the runtime speaks and any address a redirect
// points at. Both are cheap, and neither costs a real instance anything.
app.post('/api/searxng/test', async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string' || url.length > MAX_URL_LENGTH) {
        return res.status(400).json({ ok: false, error: 'URL is required' });
    }
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return res.status(400).json({ ok: false, error: 'Not a valid URL' });
    }
    if (!SAFE_URL_PROTOCOLS.includes(parsed.protocol)) {
        return res.status(400).json({ ok: false, error: 'Only http:// and https:// are supported' });
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const cleanUrl = url.replace(/\/+$/, '') + '/healthz';
        const response = await fetch(cleanUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) {
            res.json({ ok: true });
        } else {
            res.json({ ok: false, error: `SearXNG responded with status ${response.status}` });
        }
    } catch (e) {
        res.json({ ok: false, error: e.name === 'AbortError' ? 'Connection timed out' : e.message || 'Cannot reach SearXNG' });
    }
});

// AI / OLLAMA

app.get('/api/ai/status', wrap(async (req, res) => {
    // Never echo the API key (it may come from .env, not just the settings the
    // client already knows) — expose only whether one is configured.
    const { apiKey, ...settings } = getAISettings();
    const health = await checkOllamaHealth();
    res.json({ ...settings, hasApiKey: !!apiKey, ...health });
}));

// The provider key's own write route, beside the status endpoint that reports
// whether one exists. Write-only from the client's side: the panel types a
// replacement and never reads the old value back, and the generic settings
// dump stopped carrying the key for the same reason (isSecretSettingKey).
// An empty PUT and the DELETE both mean "no key" — the Clear button's word.
app.put('/api/ai/key', (req, res) => {
    const { apiKey } = req.body || {};
    if (typeof apiKey !== 'string') return res.status(400).json({ error: 'apiKey must be a string' });
    if (apiKey) {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ai_openai_api_key', apiKey);
    } else {
        db.prepare('DELETE FROM settings WHERE key = ?').run('ai_openai_api_key');
    }
    res.json({ success: true, hasApiKey: !!apiKey });
});
app.delete('/api/ai/key', (req, res) => {
    db.prepare('DELETE FROM settings WHERE key = ?').run('ai_openai_api_key');
    res.json({ success: true, hasApiKey: false });
});

app.get('/api/ai/models', wrap(async (req, res) => {
    const result = await getInstalledModels();
    res.json(result);
}));

/* Who can actually serve the chosen model.
 *
 * A model id on a router is a list of machines, not one: the id configured here
 * had 27 of them, differing by a factor of five in speed, by two steps in
 * quantisation, and in how much the model thinks before it answers. This is
 * what fills the provider list in Settings so the choice is made from what the
 * endpoint reports rather than from a table in a document that went stale.
 *
 * It asks THE ENDPOINT THE LEARNER CONFIGURED and nowhere else — the path is
 * built from their own base URL — so this adds no outbound host to the
 * inventory in SECURITY.md. An endpoint that does not publish the route (every
 * local engine, OpenAI itself) says so with `available:false`, which is an
 * answer: the panel hides the control rather than showing an empty list.
 */
app.get('/api/ai/endpoints', wrap(async (req, res) => {
    const settings = getAISettings();
    const model = typeof req.query.model === 'string' && req.query.model ? req.query.model : settings.model;
    if (settings.provider !== 'openai' || !model) return res.json({ available: false, endpoints: [] });

    const base = normalizeOpenAIBaseUrl(settings.baseUrl);
    // `/v1` + `/models/<id>/endpoints`. The id carries a slash of its own
    // (`vendor/model`) and must not be encoded away, so only the segments are.
    const path = model.split('/').map(encodeURIComponent).join('/');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const upstream = await fetch(`${base}/models/${path}/endpoints`, {
            headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
            signal: controller.signal,
        });
        if (!upstream.ok) return res.json({ available: false, endpoints: [] });
        const json = await upstream.json();
        const raw = Array.isArray(json?.data?.endpoints) ? json.data.endpoints : [];
        if (!raw.length) return res.json({ available: false, endpoints: [] });
        // Only the fields the panel draws, and the slug it will send back.
        const endpoints = raw.map(e => ({
            slug: String(e.tag || e.provider_name || '').split('/')[0],
            name: e.provider_name || e.tag || '',
            promptPrice: Number(e.pricing?.prompt) * 1e6 || 0,
            completionPrice: Number(e.pricing?.completion) * 1e6 || 0,
            quantization: e.quantization || null,
            contextLength: e.context_length ?? null,
            uptime: typeof e.uptime_last_30m === 'number' ? e.uptime_last_30m : null,
        })).filter(e => e.slug);
        res.json({ available: true, model, endpoints });
    } catch {
        res.json({ available: false, endpoints: [] });
    } finally {
        clearTimeout(timer);
    }
}));

app.post('/api/ai/models/pull', async (req, res) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'Model name is required' });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    try {
        for await (const progress of pullModel(name.trim())) {
            res.write(`data: ${JSON.stringify(progress)}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
    } catch (error) {
        console.error('Model pull error:', error);
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        res.end();
    }
});

app.delete('/api/ai/models/:name', wrap(async (req, res) => {
    const result = await deleteModel(req.params.name);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: result.error });
    }
}));

// AI CHAT

/**
 * A stored message on its way to the client: the `actions` column is JSON and
 * the client wants a list. A row written by an older build (or by hand) has
 * null, and a row that somehow holds something else is treated as none — a
 * conversation must render, whatever is in one column of it.
 */
function withActions(row) {
    let actions = null;
    try {
        const parsed = row.actions ? JSON.parse(row.actions) : null;
        if (Array.isArray(parsed) && parsed.length) actions = parsed;
    } catch { /* not JSON: the message still renders */ }
    return { ...row, actions };
}

// Retrieve up to 3 document chunks relevant to a tutor turn, formatted as RAG
// context (or '' when RAG is off / nothing matches). The learner's message is
// the primary query, but short or anaphoric turns ("explain this again", "why?")
// carry no retrievable terms and used to return nothing — so when the message
// finds no chunks we fall back to a query built from the node's own title.
// Retrieval is now hybrid (FTS5 keyword + sqlite-vec semantic, fused via RRF in
// searchDocuments) and degrades to keyword-only when embeddings are off — hence
// async (embedding the query is a network call).
/**
 * Assemble everything one turn may cite: the learner's own vault, then whatever
 * the model asked to look up before answering (server/aiTools.js — the live
 * web, gated; a search of the learner's own library, local and free).
 *
 * The vault is retrieved unconditionally from the learner's own wording, which
 * costs nothing and needs no permission. Everything after it is the model's
 * decision, and `calls` carries what it decided so the answer can say so.
 *
 * Returns the prompt block AND the numbered source list behind it: the answer
 * cites by number (`[[src:2]]`) and the app resolves those markers into real
 * titles (and, for a web page, a real link) afterwards, so a claim taken from
 * the learner's notes or from a page says which. See server/citations.js.
 *
 * The vault is searched first and listed first: it is the learner's own
 * material, and a model reads the top of a long context best.
 */
async function buildSourceContext(nodeId, projectId, message, { limit = 3, useVault = true, useWeb, useLibrary = false, pageContext = '', emit, signal } = {}) {
    let chunks = [];
    try {
        if (useVault) chunks = await searchDocuments(message, nodeId, projectId, limit);
        // Retry on the topic's title when the learner's phrasing finds nothing —
        // only meaningful when there IS a topic. The global assistant has none, so
        // it simply gets no fallback rather than a second identical search.
        if (useVault && chunks.length === 0 && nodeId != null) {
            const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get(nodeId);
            if (node?.title) chunks = await searchDocuments(node.title, nodeId, projectId, limit);
        }
    } catch (e) {
        console.error('[sources] vault search failed:', e.message);
    }

    const items = chunks.map(c => ({ title: c.doc_title, content: c.content }));

    // What the model wants looked up, in its own words. Runs even with the
    // vault empty — a question about the live web has nothing to do with
    // whether this learner keeps documents.
    const tools = chatTools({ web: webAllowedForTurn(useWeb), library: useLibrary });
    const { items: found, context: looked, calls } = await runToolRounds({
        question: message,
        tools,
        pageContext,
        emit,
        signal,
    });
    items.push(...found);

    // What a lookup found that is not a CITABLE source — the learner's own
    // filing. It goes in as plain context: it must reach the answer, and it
    // must never end up numbered, because an answer signed "Sources: Your
    // library" cites nothing anyone can go and check.
    const looking = looked.length ? `\n\n${looked.join('\n\n')}` : '';

    const { text, sources } = formatSourceContext(items);
    // A lookup that came back with NOTHING has to reach the answer, or the
    // turn's two halves contradict each other: the answer confidently states
    // the thing from memory, and the line underneath it says the web was
    // searched for exactly that. The model decided it could not be sure — an
    // empty result is the answer to that, not a reason to forget the doubt.
    const empty = calls.filter(c => !c.summary || /^(no results|nothing|the search failed)$/.test(c.summary));
    const gap = empty.length
        ? `\n\nLooked up and found NOTHING: ${empty.map(c => `“${c.arg}”`).join(', ')}. `
        + 'Say plainly that you could not check it, and answer from what you do know while naming what you could not confirm. Do not present a remembered figure, date or rule as current when the search for it came back empty.'
        : '';

    return { text: (text ? `\n\n${text}` : '') + looking + gap, sources, calls };
}

app.post('/api/ai/chat', async (req, res) => {
    const { nodeId, message, useRag = true, useWeb } = req.body;
    let aiResponse = null;
    try {
        let context = '';
        if (nodeId) context = buildNodeContext(nodeId, { completedTopics: true, curriculumPosition: true });
        let ragContext = '';
        let ragSources = [];
        let toolCalls = [];
        if (nodeId) {
            const node = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeId);
            if (node) ({ text: ragContext, sources: ragSources, calls: toolCalls = [] } =
                await buildSourceContext(nodeId, node.project_id, message, { useVault: useRag, useWeb }));
        }
        const history = db.prepare(`
            SELECT role, content FROM chat_messages
            WHERE node_id = ?
            ORDER BY created_at DESC, id DESC LIMIT 10
        `).all(nodeId || -1).reverse();
        const { system, user } = AI_PROMPTS.tutor(context, ragContext, message, getUiLanguage());

        aiResponse = await generateResponse(user, system, history, { think: true, temperature: 0.35, operation: 'chat' });
        // Markers out, the documents they named in. Runs before the row is
        // written, so what is stored is what the learner reads.
        ({ text: aiResponse } = resolveCitations(aiResponse, ragSources));

        if (nodeId) {
            const node = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeId);
            db.prepare('INSERT INTO chat_messages (node_id, project_id, role, content) VALUES (?, ?, ?, ?)')
                .run(nodeId, node?.project_id, 'user', message);
            // Only the assistant row carries provenance — the user's turn was
            // written by a person, and stamping it would be a lie.
            db.prepare('INSERT INTO chat_messages (node_id, project_id, role, content, actions, generated_by) VALUES (?, ?, ?, ?, ?, ?)')
                .run(nodeId, node?.project_id, 'assistant', aiResponse,
                    toolCalls.length ? JSON.stringify(toolCalls) : null, aiProvenance());
        }
        res.json({ response: aiResponse });
    } catch (error) {
        console.error('AI chat error:', error);
        res.status(500).json({
            error: error.message,
            rawResponse: aiResponse
        });
    }
});

// One tutor turn as a background task: reads history, saves the user turn
// up-front (so a reload mid-generation already shows the question), streams
// the model, then persists the assistant turn WITH its reasoning trace. On
// cancel it persists whatever partial answer/reasoning exists and resolves
// { cancelled: true } so the queue moves on. Shared by the node tutor and the
// global Today planning chat (nodeId/projectId both null there).
async function runChatTurn({ nodeId, projectId, message, useRag, useWeb, emit, signal, pageContext = '', ragProjectId = null }) {
    const isGlobal = nodeId == null;
    let context, system, user, history;
    // The documents retrieved for this turn, so the answer's `[[src:N]]`
    // markers can be resolved into their real titles before it is stored.
    let ragSources = [];
    // And what the model chose to look up to get them — the web half of which
    // is written into the answer itself.
    let toolCalls = [];
    if (isGlobal) {
        const contextPayload = buildTodayBriefingContext({ decayDays: getGateConfig().decayDays });
        let ragContext = '';
        ({ text: ragContext, sources: ragSources, calls: toolCalls = [] } = await buildSourceContext(
            null, ragProjectId, message, {
                useVault: useRag, useWeb,
                // The assistant is the surface with no curriculum in front of
                // it: its snapshot is today's cross-project state, so a question
                // about anything the learner is NOT currently behind on was
                // unanswerable until it could go and look.
                useLibrary: true, pageContext, emit, signal,
            }));
        history = db.prepare(`
            SELECT role, content FROM chat_messages
            WHERE node_id IS NULL AND project_id IS NULL
            ORDER BY created_at DESC, id DESC LIMIT 10
        `).all().reverse();
        ({ system, user } = AI_PROMPTS.today_planner(contextPayload, message, pageContext, ragContext, getUiLanguage()));
    } else {
        context = buildNodeContext(nodeId, { completedTopics: true, curriculumPosition: true });
        let ragContext = '';
        // No library search here: the tutor is answering about ONE topic whose
        // material it already has in full, and a tool nobody needs is a round
        // trip every turn pays for.
        ({ text: ragContext, sources: ragSources, calls: toolCalls = [] } = await buildSourceContext(
            nodeId, projectId, message, {
                useVault: useRag, useWeb, emit, signal,
            }));
        // History is read BEFORE inserting the new user row — the prompt
        // already carries the message itself.
        history = db.prepare(`
            SELECT role, content FROM chat_messages
            WHERE node_id = ?
            ORDER BY created_at DESC, id DESC LIMIT 10
        `).all(nodeId).reverse();
        ({ system, user } = AI_PROMPTS.tutor(context, ragContext, message, getUiLanguage()));
    }

    const userInfo = db.prepare('INSERT INTO chat_messages (node_id, project_id, role, content) VALUES (?, ?, ?, ?)')
        .run(nodeId, projectId, 'user', message);
    const userMessageId = Number(userInfo.lastInsertRowid);
    emit({ userMessageId });

    let fullResponse = '';
    let thinkingChars = 0;
    let thinkingText = '';
    // Reasoning is persisted with the message so the panel survives reloads,
    // but bounded — a runaway reasoning loop must not bloat the DB.
    const REASONING_SAVE_CAP = 120000;

    // The assistant row's DB id is returned in the terminal event so the
    // client can map its provisional message id to the persisted row (visual
    // repair write-back).
    //
    // A turn that produced NOTHING — not an answer, not a line of reasoning —
    // did not happen, and its question is taken back out with it. The question
    // is written up-front on purpose, so that a reload mid-generation already
    // shows what was asked; the cost of that is an orphan row whenever the turn
    // then fails, and the client's own rule for the same case has always been
    // to drop the optimistic bubble, because an unanswered question left on
    // screen looks asked. It read as a duplicate rather than as an orphan: a
    // failure hands the text back for a retry, each retry writes another
    // question row, and the DEVICE THAT RETRIED never saw them (it renders its
    // own optimistic list) while a second device reading the same conversation
    // out of the database opened on three identical bubbles and no answer.
    //
    // Citations are resolved HERE, at the moment the answer becomes a stored
    // message: `[[src:2]]` out, the document it named in. The streamed text
    // still carries the raw markers (they are written token by token, long
    // before the turn knows it is finished), so the terminal event hands the
    // client this resolved text to replace what it rendered — and the client
    // strips any marker on its own while streaming, so none is ever read.
    let finalContent = '';
    const saveAssistant = () => {
        if (!fullResponse.trim() && !thinkingText.trim()) {
            db.prepare('DELETE FROM chat_messages WHERE id = ?').run(userMessageId);
            return null;
        }
        finalContent = resolveCitations(fullResponse, ragSources).text;
        // What the turn DID, stored beside what it said. Same argument the
        // reasoning column already made: a record that only exists while the
        // answer streams is a record the learner cannot go back to, and this
        // one is the app's disclosure of what left the machine.
        const info = db.prepare('INSERT INTO chat_messages (node_id, project_id, role, content, reasoning, actions, generated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(nodeId, projectId, 'assistant', finalContent,
                thinkingText ? thinkingText.slice(0, REASONING_SAVE_CAP) : null,
                toolCalls.length ? JSON.stringify(toolCalls) : null,
                aiProvenance());
        return Number(info.lastInsertRowid);
    };

    // One pass over the model's stream. `think` is a parameter because the
    // pass may run twice: a model that loops in its reasoning (see
    // reasoningLoopDetected in ai.js) is stopped and asked once more WITHOUT
    // extended reasoning — the loop lives in the thinking channel, and a
    // direct answer is what the learner wanted anyway.
    const attempt = async (think) => {
        // think:true lets a reasoning-capable model (qwen3, deepseek-r1, …) process
        // the injected context and teaching scaffold BEFORE answering, instead of
        // emitting the final reply from token one. streamResponse gates this on the
        // model's advertised capability, so it's a no-op on non-thinking models.
        // Lower temperature than the streamResponse default (0.5): the tutor emits
        // fenced visual specs (p5/vega-lite/mermaid) inline, and a small local
        // model's spec accuracy degrades sharply with temperature. 0.35 keeps the
        // prose warm while making the machine-readable blocks far more reliable.
        for await (const part of streamResponse(user, system, history, { temperature: isGlobal ? 0.5 : 0.35, think, signal })) {
            let chunkText = '';
            if (typeof part === 'string') {
                chunkText = part;
            } else if (part && typeof part === 'object') {
                if (part.type === 'content' && part.content) {
                    chunkText = part.content;
                } else if (part.type === 'thinking' && part.content) {
                    // Stream a running reasoning-character count AND the raw delta
                    // text, so the UI can show both a live "Thinking (N chars)…"
                    // progress indicator and the actual reasoning content in a
                    // collapsible panel (not just its length).
                    thinkingChars += part.content.length;
                    thinkingText += part.content;
                    emit({ thinking: thinkingChars, thinkingChunk: part.content });
                }
            }
            if (chunkText) {
                fullResponse += chunkText;
                emit({ chunk: chunkText });
            }
        }
    };

    try {
        try {
            await attempt(true);
        } catch (error) {
            // Retry only when nothing of the ANSWER has been shown — a second
            // pass would otherwise splice two replies together. The note goes
            // into the reasoning panel, where the loop it explains is.
            if (!isReasoningLoop(error) || fullResponse.trim() || signal.aborted) throw error;
            const note = `\n\n[The model was repeating itself and was stopped after ${thinkingChars.toLocaleString('en-US')} characters. Answering again without extended reasoning.]\n\n`;
            thinkingChars += note.length;
            thinkingText += note;
            emit({ thinking: thinkingChars, thinkingChunk: note });
            await attempt(false);
        }
    } catch (error) {
        if (signal.aborted) {
            // Explicit Stop/cancel: keep the partial answer + reasoning in the
            // conversation so it can be continued (server-side context intact).
            const assistantMessageId = saveAssistant();
            return { cancelled: true, assistantMessageId, partial: !!fullResponse.trim(), content: finalContent || null };
        }
        // Same on an outright failure: whatever arrived before it broke is kept,
        // and a turn that arrived at nothing takes its question with it.
        saveAssistant();
        throw error;
    }
    if (signal.aborted) {
        const assistantMessageId = saveAssistant();
        return { cancelled: true, assistantMessageId, partial: !!fullResponse.trim(), content: finalContent || null };
    }
    const assistantMessageId = saveAssistant();
    return { assistantMessageId, content: finalContent || null };
}

app.post('/api/ai/chat/stream', (req, res) => {
    const { nodeId, message, useRag = true, useWeb } = req.body;
    if (!nodeId || !message || !String(message).trim()) {
        return res.status(400).json({ error: 'nodeId and message are required' });
    }
    const info = nodeTaskInfo(Number(nodeId));
    if (!info) return res.status(404).json({ error: 'Node not found' });

    // One tutor conversation per node: a second question while a turn is
    // still generating must reattach to it (the panel does that on mount),
    // not fork a parallel turn with stale history.
    if (tasks.findActive({ kind: 'chat', nodeId: Number(nodeId) })) {
        return res.status(409).json({ error: 'The tutor is still answering for this topic. Wait for it to finish or stop it first.' });
    }

    const { task } = tasks.createTask({
        kind: 'chat',
        label: info.title,
        nodeId: Number(nodeId),
        projectId: info.projectId,
        projectName: info.projectName,
        projectColor: info.projectColor,
        meta: { message: String(message) },
        run: ({ emit, signal }) => runChatTurn({
            nodeId: Number(nodeId), projectId: info.projectId,
            message: String(message), useRag, useWeb, emit, signal,
        }),
    });
    attachTaskStream(req, res, task.id);
});

app.get('/api/ai/chat/:nodeId', (req, res) => {
    const messages = db.prepare(`
        SELECT id, role, content, reasoning, actions, created_at
        FROM chat_messages
        WHERE node_id = ?
        ORDER BY created_at
    `).all(req.params.nodeId);
    res.json(messages.map(withActions));
});

app.delete('/api/ai/chat/:nodeId', (req, res) => {
    db.prepare('DELETE FROM chat_messages WHERE node_id = ?').run(req.params.nodeId);
    res.json({ success: true });
});

// Overwrite a stored message's content. Used when a visual block inside an
// assistant reply is repaired (deterministically or via the AI repair loop) so
// the fix is persisted — a reopened chat then renders the corrected spec instead
// of the broken original. Content-only; role/node are immutable here.
app.put('/api/ai/chat/message/:id', (req, res) => {
    const id = Number(req.params.id);
    const { content } = req.body || {};
    if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'content (non-empty string) required' });
    }
    const info = db.prepare('UPDATE chat_messages SET content = ? WHERE id = ?').run(content, id);
    if (info.changes === 0) return res.status(404).json({ error: 'Message not found' });
    res.json({ success: true });
});

// Persist chat messages produced outside the normal stream save. Used when the
// user Stops a generation: /chat/stream only writes to the DB after its loop
// finishes, so an aborted turn saves nothing — the client sends the user turn +
// the partial assistant reply here so the conversation keeps full context (and
// can be continued).
app.post('/api/ai/chat/:nodeId/messages', (req, res) => {
    const nodeId = Number(req.params.nodeId);
    const node = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeId);
    if (!node) return res.status(404).json({ error: 'Node not found' });

    const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const valid = incoming.filter(m =>
        m && (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' && m.content.trim()
    );

    const insert = db.prepare('INSERT INTO chat_messages (node_id, project_id, role, content) VALUES (?, ?, ?, ?)');
    const saved = [];
    db.transaction(() => {
        for (const m of valid) {
            const info = insert.run(nodeId, node.project_id, m.role, m.content);
            saved.push({ id: Number(info.lastInsertRowid), role: m.role, content: m.content });
        }
    })();

    res.json({ success: true, messages: saved });
});

// AI QUIZ

app.post('/api/ai/quiz', async (req, res) => {
    const { nodeId, questionCount = 5, questionType = 'both', includeGhosts = false } = req.body;
    let aiResponse = null;
    try {
        const { system, user } = buildQuizPrompt(nodeId, questionCount, questionType);
        aiResponse = await generateResponse(user, system);
        const quiz = finalizeQuiz(nodeId, aiResponse, includeGhosts, { decayDays: getGateConfig().decayDays, questionType });
        res.json(await vetQuiz(nodeId, quiz));
    } catch (error) {
        console.error('Quiz generation error:', error);
        res.status(500).json({
            error: error.message,
            rawResponse: aiResponse
        });
    }
});

// Quiz generation as a background task. Ported from the old inline handler:
// probe first (fail fast when the model server is down), then a "warming up"
// heartbeat until the first token (a cold model swap holds the request open
// for up to a minute with zero bytes — without the phase events the client
// sees a dead-looking 0-char spinner and can't tell loading from failure).
async function runQuizGeneration({ nodeId, questionCount, questionType, includeGhosts, emit, signal }) {
    let aiResponse = '';
    let thinkingChars = 0;
    // Keep a bounded copy of the reasoning channel so that when a thinking model
    // spends its whole budget "thinking" and emits no answer, we can still show
    // the learner *something* as raw output instead of an empty box.
    let thinkingText = '';
    const THINKING_RAW_CAP = 8000;
    let firstTokenSeen = false;
    let loadingTimer = null;
    const startedAt = Date.now();
    const stopLoadingHeartbeat = () => {
        if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
    };
    try {
        const reachable = await probeAiReachable();
        if (!reachable.ok) throw new Error(reachable.error);

        loadingTimer = setInterval(() => {
            if (!firstTokenSeen && !signal.aborted) {
                emit({ phase: 'loading_model', waitedMs: Date.now() - startedAt });
            }
        }, 2000);

        const { system, user } = buildQuizPrompt(nodeId, questionCount, questionType);
        for await (const part of streamResponse(user, system, [], { signal, temperature: 0.35, think: true })) {
            if (part && (part.type === 'content' || part.type === 'thinking') && part.content) {
                // First token of either channel means the model is loaded and
                // actively generating — drop out of the "loading model" phase.
                if (!firstTokenSeen) { firstTokenSeen = true; stopLoadingHeartbeat(); emit({ phase: 'generating' }); }
            }
            if (part && part.type === 'content' && part.content) {
                aiResponse += part.content;
                emit({ progress: aiResponse.length });
            } else if (part && part.type === 'thinking' && part.content) {
                thinkingChars += part.content.length;
                if (thinkingText.length < THINKING_RAW_CAP) thinkingText += part.content;
                emit({ thinking: thinkingChars });
            }
        }
        stopLoadingHeartbeat();
        // A reasoning model can finish having emitted only a thinking stream and no
        // answer. finalizeQuiz would then throw the opaque "No JSON array found";
        // give an actionable message and surface the reasoning as raw output.
        if (!aiResponse.trim()) {
            throw Object.assign(
                new Error('The AI model returned no answer text — it may have spent its whole budget "thinking". Try again, lower the question count, or switch to a model that emits a final answer.'),
                { rawResponse: thinkingText || null }
            );
        }
        // The quiz row is saved here, server-side — so a generation whose
        // subscriber went away (modal closed, page reloaded) still lands, and
        // reopening the Boss Fight finds the saved questions.
        const quiz = finalizeQuiz(nodeId, aiResponse, includeGhosts, { decayDays: getGateConfig().decayDays, questionType });
        // Each question now gets solved cold by a second pass. It is the most
        // expensive thing this endpoint does after the generation itself, so it
        // reports progress on the same phase channel the "warming up" heartbeat
        // uses — a silent minute here would read as a hang.
        emit({ phase: 'verifying', verified: 0, verifyTotal: quiz.questions.filter(q => !q.isGhost).length });
        return await vetQuiz(nodeId, quiz, {
            signal,
            onProgress: (verified, verifyTotal) => emit({ phase: 'verifying', verified, verifyTotal }),
        });
    } catch (error) {
        stopLoadingHeartbeat();
        if (signal.aborted) return { cancelled: true };
        console.error('Quiz generation error:', error);
        if (error.rawResponse === undefined) {
            error.rawResponse = aiResponse || thinkingText || null;
        }
        throw error;
    }
}

app.post('/api/ai/quiz/stream', (req, res) => {
    const { nodeId, questionCount = 5, questionType = 'both', includeGhosts = false, bossFight = false } = req.body;
    if (!nodeId) return res.status(400).json({ error: 'Missing required field: nodeId' });
    const info = nodeTaskInfo(Number(nodeId));
    if (!info) return res.status(404).json({ error: 'Node not found' });

    // Deduped on the node: reopening the Boss Fight (or quiz panel) while a
    // generation is already running REATTACHES to it — replaying progress so
    // far — instead of starting a duplicate generation.
    const { task } = tasks.createTask({
        kind: bossFight ? 'boss_fight' : 'quiz',
        label: info.title,
        nodeId: Number(nodeId),
        projectId: info.projectId,
        projectName: info.projectName,
        projectColor: info.projectColor,
        dedupeKey: `quiz:${nodeId}`,
        run: ({ emit, signal }) => runQuizGeneration({
            nodeId: Number(nodeId), questionCount, questionType, includeGhosts, emit, signal,
        }),
    });
    attachTaskStream(req, res, task.id);
});

app.get('/api/ai/quizzes/:nodeId', (req, res) => {
    const quizzes = db.prepare(`
        SELECT q.*,
            (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.quiz_id = q.id) as attempt_count,
            (SELECT MAX(qa.score * 100 / qa.total) FROM quiz_attempts qa WHERE qa.quiz_id = q.id) as best_score
        FROM quizzes q
        WHERE q.node_id = ?
        ORDER BY q.created_at DESC
    `).all(req.params.nodeId);
    res.json(quizzes.map(q => {
        try { return { ...q, questions: JSON.parse(q.questions) }; }
        catch { return { ...q, questions: [] }; }
    }));
});

app.post('/api/ai/quizzes/:quizId/attempt', (req, res) => {
    const { answers, ghostResults } = req.body || {};
    const attempt = readAttempt(req.body);
    if (!attempt) {
        return res.status(400).json({ error: 'score and total must be integers with 0 <= score <= total' });
    }
    const { score, total } = attempt;
    // score/total cover only this quiz's *own* (non-ghost) questions, so the node's
    // recorded mastery stays an honest assessment of its own material.
    const result = db.prepare('INSERT INTO quiz_attempts (quiz_id, score, total, answers) VALUES (?, ?, ?, ?)')
        .run(req.params.quizId, score, total, JSON.stringify(answers));

    // PHASE 3: Update mastery score for this quiz's node
    let masteryResult = null;
    try {
        const quiz = db.prepare('SELECT node_id FROM quizzes WHERE id = ?').get(req.params.quizId);
        if (quiz) {
            masteryResult = updateMasteryFromAttempt(quiz.node_id, score, total, 'quiz', {
                quiz_id: Number(req.params.quizId),
                answers,
            });
        }
    } catch (e) {
        console.error('[Mastery] Failed to update from quiz attempt:', e.message);
    }

    // "Remember" loop: credit each decaying topic that was reviewed via ghost
    // questions, refreshing its mastery and (crucially) its decay timer.
    if (Array.isArray(ghostResults)) {
        for (const g of ghostResults) {
            try {
                if (g && g.nodeId && g.total > 0) {
                    updateMasteryFromAttempt(g.nodeId, g.score, g.total, 'quiz', {
                        quiz_id: Number(req.params.quizId),
                        ghost: true,
                    });
                }
            } catch (e) {
                console.error('[Ghost] Failed to update decaying-node mastery:', e.message);
            }
        }
    }

    res.json({ id: result.lastInsertRowid, score, total, mastery: masteryResult });
});

app.delete('/api/ai/quizzes/:quizId', (req, res) => {
    db.prepare('DELETE FROM quizzes WHERE id = ?').run(req.params.quizId);
    res.json({ success: true });
});

// AI ANSWER CHECK

// Teach one missed question, in place. Blocking JSON (like check-answer, and
// unlike the streaming tutor) because it is a short, single-shot explanation
// the learner requested from a results screen — and because it must NOT land in
// the node's tutor chat history, which streamChat would do.
app.post('/api/ai/explain-question', async (req, res) => {
    const { nodeId, question, correctAnswer, userAnswer } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });
    try {
        const node = nodeId ? db.prepare('SELECT title FROM nodes WHERE id = ?').get(nodeId) : null;
        const context = nodeId ? buildNodeContext(nodeId) : '';
        const { system, user } = AI_PROMPTS.explain_question(
            node?.title || 'this topic',
            context,
            question,
            correctAnswer || '',
            userAnswer || ''
        );
        const explanation = await generateResponse(user, system, [], { operation: 'explain' });
        if (!explanation || !explanation.trim()) {
            return res.status(502).json({ error: 'The model returned an empty explanation. Try again.' });
        }
        res.json({ explanation: explanation.trim() });
    } catch (error) {
        console.error('Explain question error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/ai/check-answer', async (req, res) => {
    const { question, correctAnswer, userAnswer, format, language } = req.body;
    if (!question || !correctAnswer || !userAnswer) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
        // `format` says what the checker is reading: code is judged on
        // behaviour, prose on meaning. Anything else is graded as prose.
        const result = await checkAnswerWithAI(question, correctAnswer, userAnswer, {
            format: format === 'code' ? 'code' : 'short_answer',
            language: typeof language === 'string' ? language.slice(0, 24) : '',
        });
        res.json(result);
    } catch (error) {
        console.error('Answer check error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Repair a broken visual spec (render-validate-repair loop). The frontend calls
// this when a ```mermaid / ```vega-lite / ```plot / ```smiles / ```math block
// fails to render, passing the raw spec and the renderer's parse error.
//
// A BACKGROUND TASK since 2026-09-07, like the author endpoint above it. It
// used to be a bare SSE response that aborted the model call the moment the
// socket closed — right for a Cancel button, and exactly wrong for a phone:
// the OS drops the socket when the app goes to the background, so a rebuild
// pressed on the phone died whenever the learner switched apps, and came
// back to the same broken drawing. Now the rebuild runs to the end whatever
// the socket does, is cancelled only through the dock (or the block's Cancel,
// which cancels the task by id), and a client that re-POSTs the identical
// request — which is what the returning phone does — joins the running task
// through `dedupeKey` and has its progress replayed.
async function runVisualRepair({ kindText, code, error, feedback, brief, feedbackId, themeText, emit, signal }) {
    const revising = typeof feedback === 'string' && feedback.trim().length > 0;
    try {
        let full = '';
        // The client draws ONE bar over what can be two model calls, so every
        // frame names its phase, its running length, its reasoning length and
        // the length this phase is expected to reach. Before 2026-09-05 it was
        // a bare running length scaled against the BRIEF, which pinned the bar
        // at the 99% clamp for the whole of the drawing call — the slow one —
        // and reported nothing at all while a reasoning model was thinking.
        // A phase's estimate is a yardstick, never a promise: the client's
        // ramp handles an answer that runs past it (repairProgress.ts).
        // `progress` rides along so the task's replay accumulator (tasks.js
        // keeps `progress`, not `chars`) has a running length for the dock.
        const firstPhase = revising && brief && VISUAL_BRIEF_KINDS.has(kindText) ? 'brief' : 'spec';
        const firstEst = Math.max(1, code.trim().length);
        let firstThinking = 0;
        const emitFirst = () => emit({ phase: firstPhase, chars: full.length, progress: full.length, thinking: firstThinking, est: firstEst });
        const onThinking = (chars) => { firstThinking = chars; emitFirst(); };
        const stream = revising
            ? streamReviseVisualSpec(kindText, code, feedback, { signal, brief: !!brief, theme: themeText, onThinking })
            : streamRepairVisualSpec(kindText, code, error, { signal, onThinking });
        for await (const chunk of stream) {
            full += chunk;
            emitFirst();
        }
        const revised = stripCodeFence(full);
        const briefChanged = revised.trim() !== code.trim();

        // A BRIEF-backed visual: the words were revised above, but the reader
        // was looking at a DRAWING, and until 2026-09-05 their note never
        // reached it — the drawer was called blind from the new words, with no
        // previous drawing, and a brief that already said what they asked for
        // (measured: 4 of 14 brief reports) could not be fixed at all. So the
        // drawing is revised HERE, from the reader's own words plus the cached
        // previous drawing, and cached under the revised brief's hash so the
        // client's cache-first resolve finds it without a second model call.
        let drawing = null;
        if (revising && brief && VISUAL_BRIEF_KINDS.has(kindText)) {
            const nextBrief = briefChanged ? revised : code;
            const previous = getCachedVisual(visualBriefHash(kindText, code.trim()))?.spec || '';
            // The drawing this one replaces is a real yardstick for its length;
            // with no cached previous, a middling animation's worth of markup.
            const drawEst = Math.max(500, previous.trim().length || 4500);
            let drawChars = 0, drawThinking = 0;
            const emitDraw = () => emit({ phase: 'draw', chars: drawChars, progress: drawChars, thinking: drawThinking, est: drawEst });
            emitDraw();   // hand the bar over the moment the second call starts
            const result = await authorVisual({
                kind: kindText,
                brief: nextBrief,
                readerNote: feedback,
                previousSpec: previous,
                theme: themeText,
                signal,
                emit: (evt) => {
                    if (typeof evt?.progress === 'number') { drawChars = evt.progress; emitDraw(); }
                    else if (typeof evt?.thinking === 'number') { drawThinking = evt.thinking; emitDraw(); }
                },
            });
            if (result?.cancelled) return { cancelled: true };
            drawing = { spec: result.spec, changed: result.spec.trim() !== previous.trim() };
        }

        // Close the loop on the learner's report: the record is only a bug
        // report once it carries what the model did about it (visualFeedback.js).
        if (revising && feedbackId) {
            recordVisualOutcome(String(feedbackId), {
                revisedSpec: revised,
                revisedDrawing: drawing?.spec,
                accepted: briefChanged || !!drawing?.changed,
            });
        }
        // `redrawn` tells the client a cached drawing changed even when the
        // words did not, so it re-renders rather than reporting "same drawing".
        return { code: revised, redrawn: !!drawing?.changed };
    } catch (err) {
        if (signal.aborted) return { cancelled: true };
        if (revising && feedbackId) recordVisualOutcome(String(feedbackId), { error: err.message, accepted: false });
        console.error('Visual repair error:', err);
        throw err;
    }
}

app.post('/api/ai/repair-visual', (req, res) => {
    // Two jobs, one endpoint, because the client shows one progress bar for
    // both: `error` is a renderer exception (the spec is broken), `feedback` is
    // a PERSON saying the drawing is wrong (the spec renders fine). They take
    // different prompts — see reviseVisualPrompt in ai.js — and telling a model
    // that a working spec "failed with error: the axes do not move" sends it
    // looking for a syntax fault that is not there.
    const { kind, code, error, feedback, brief, feedbackId, theme } = req.body || {};
    if (!kind || !code) return res.status(400).json({ error: 'Missing required fields: kind, code' });
    const kindText = String(kind);
    const codeText = String(code);
    const errorText = error ? String(error) : '';
    const feedbackText = typeof feedback === 'string' ? feedback : '';
    const revising = feedbackText.trim().length > 0;
    const themeText = typeof theme === 'string' ? theme : '';
    // The same spec with the same complaint is the same rebuild: a second
    // request joins the first rather than starting a second model call. The
    // theme is part of it because "make it white" is a different instruction
    // on a dark page (readerColourNote).
    const dedupeKey = 'visual-repair:' + createHash('sha1')
        .update([kindText, codeText.trim(), revising ? `f:${feedbackText.trim()}` : `e:${errorText}`, brief ? 'brief' : '', themeText].join('\0'))
        .digest('hex');
    const { task } = tasks.createTask({
        kind: 'visual',
        label: `${revising ? 'Rebuilding' : 'Repairing'} ${kindText === 'vega' ? 'chart' : kindText === 'p5' ? 'simulation' : kindText}`,
        dedupeKey,
        run: ({ emit, signal }) => runVisualRepair({
            kindText, code: codeText, error: errorText, feedback: feedbackText,
            brief: !!brief, feedbackId, themeText, emit, signal,
        }),
    });
    attachTaskStream(req, res, task.id);
});

// A title and caption for a visual leaving the app as an image or GIF. The
// picture goes without the lesson around it, so the export can carry one line
// of context; the learner edits the words before saving, this only drafts them.
app.post('/api/ai/visual/caption', async (req, res) => {
    const { kind, spec, context } = req.body || {};
    if (typeof kind !== 'string' || !kind.trim()) return res.status(400).json({ error: 'kind required' });
    if (typeof spec !== 'string' || !spec.trim()) return res.status(400).json({ error: 'spec required' });
    try {
        res.json(await captionVisual(kind.trim(), spec, typeof context === 'string' ? context : ''));
    } catch (err) {
        console.error('Visual caption error:', err.message);
        res.status(502).json({ error: err.message });
    }
});

// VISUAL FEEDBACK — what a person said was wrong with a drawing.
//
// A visual that renders and is WRONG throws nothing: the repair loop cannot see
// it, the coherence gate cannot see it, and the only detector is a learner who
// knows what they were meant to be looking at. These endpoints are that
// detector's memory. Nothing is sent anywhere — the app appends to a local file
// and hands it back when asked, so a learner who wants to open an issue has the
// spec, their own words and the model's answer already in one place.

app.post('/api/visual-feedback', (req, res) => {
    const { kind, language, spec, feedback, surface, nodeId, messageId, theme } = req.body || {};
    if (typeof feedback !== 'string' || !feedback.trim()) {
        return res.status(400).json({ error: 'feedback (non-empty string) required' });
    }
    if (typeof spec !== 'string' || !spec.trim()) {
        return res.status(400).json({ error: 'spec (non-empty string) required' });
    }
    // The model that drew it is part of the report: a lesson authored by a 4B
    // and one authored by a 30B are not the same artifact (the provenance rule).
    const ai = getAISettings();
    const id = recordVisualFeedback({
        kind, language, spec, feedback, surface, nodeId, messageId, theme,
        provider: ai?.provider, model: ai?.model, appVersion: appVersion()?.version,
    });
    res.json({ id });
});

app.get('/api/visual-feedback', (req, res) => {
    res.json(visualFeedbackSummary());
});

// The whole file, as a download. `.jsonl` and not `.json` on purpose: it is one
// record per line so it can be appended to safely and read with grep, and a
// half-written last line never invalidates the rest.
app.get('/api/visual-feedback/export', (req, res) => {
    const body = readVisualFeedback();
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="visual-feedback.jsonl"');
    res.send(body);
});

app.delete('/api/visual-feedback', (req, res) => {
    const ok = clearVisualFeedback();
    res.json({ success: ok, path: visualFeedbackPath() });
});

// INTERACTIVE WIDGETS (```widget spec → compiled sandbox HTML)
//
// The tutor's reply carries only a small functional spec; compiling it into a
// runnable widget is a separate, queued LLM pass (the "construction crew" of
// the two-agent split — see widgetCompilePrompt in ai.js). Running it through
// tasks.js means a compile requested mid-reply starts only AFTER the chat
// generation that emitted the spec finishes — on a single-threaded local model
// the reply always streams to completion first, then queued widgets build one
// by one. Verified builds are cached in widget_builds by spec hash, so
// reopening an old chat renders instantly with zero LLM calls.
//
// The compile itself lives in server/widgets.js because feedGen shares it: the
// feed PRE-builds a lesson's widget in the background, so by the time the card
// is served the cache is already warm and this endpoint answers from it.

app.post('/api/ai/widget/compile', (req, res) => {
    const { spec, error, previousHtml, force, cacheOnly } = req.body || {};
    const specText = typeof spec === 'string' ? spec.trim() : '';
    if (!specText) return res.status(400).json({ error: 'Missing required field: spec' });
    const specHash = specHashOf(specText);

    // Cache hit (and not an explicit rebuild/fix): answer instantly without
    // occupying the queue or the task dock. `cacheOnly` turns a miss into a
    // cheap negative answer instead of a build — history blocks probe with it
    // so re-opening an old chat never silently enqueues LLM work.
    if (!error && !force) {
        const cached = getCachedBuild(specHash);
        if (cached) {
            const { write, end } = startSseResponse(req, res);
            write({ done: true, html: cached.html, specHash, cached: true });
            return end();
        }
        if (cacheOnly) {
            const { write, end } = startSseResponse(req, res);
            write({ miss: true, specHash });
            return end();
        }
    }

    // dedupeKey folds concurrent requests for the same spec (a re-mounted chat
    // while a build is in flight) into one task; the SSE below replays it.
    const { task } = tasks.createTask({
        kind: 'widget',
        label: widgetSpecLabel(specText),
        dedupeKey: `widget:${specHash}`,
        run: ({ emit, signal }) => compileWidget({
            spec: specText,
            specHash,
            error: error ? String(error) : '',
            previousHtml: typeof previousHtml === 'string' ? previousHtml : '',
            emit,
            signal,
        }),
    });
    attachTaskStream(req, res, task.id);
});

// The specialist authoring pass for the two hard visual kinds (```animation
// and ```p5). Same shape as the widget compiler above and for the same reason
// — see server/visualAuthor.js — so it shares the queue, the cache-first
// answer and the dedupe: a brief the conversational model wrote is compiled by
// a second call carrying the full rendering rules for that one kind.
app.post('/api/ai/visual/author', (req, res) => {
    const { kind, brief, error, previousSpec, force, cacheOnly } = req.body || {};
    const kindText = typeof kind === 'string' ? kind.trim() : '';
    const briefText = typeof brief === 'string' ? brief.trim() : '';
    if (!briefText) return res.status(400).json({ error: 'Missing required field: brief' });
    if (!VISUAL_BRIEF_KINDS.has(kindText)) {
        return res.status(400).json({ error: `"${kindText}" is not authored by the specialist pass` });
    }
    const briefHash = visualBriefHash(kindText, briefText);

    if (!error && !force) {
        const cached = getCachedVisual(briefHash);
        if (cached) {
            const { write, end } = startSseResponse(req, res);
            write({ done: true, spec: cached.spec, briefHash, cached: true });
            return end();
        }
        if (cacheOnly) {
            const { write, end } = startSseResponse(req, res);
            write({ miss: true, briefHash });
            return end();
        }
    }

    const { task } = tasks.createTask({
        kind: 'visual',
        label: visualBriefLabel(kindText, briefText),
        dedupeKey: `visual:${briefHash}`,
        run: ({ emit, signal }) => authorVisual({
            kind: kindText,
            brief: briefText,
            briefHash,
            error: error ? String(error) : '',
            previousSpec: typeof previousSpec === 'string' ? previousSpec : '',
            emit,
            signal,
        }),
    });
    attachTaskStream(req, res, task.id);
});

// AI FLASHCARDS

// Parse the model's raw output into saved flashcard rows. Shared by the
// blocking and streaming flashcard endpoints (mirrors finalizeQuiz above).
app.post('/api/ai/flashcards', async (req, res) => {
    const { nodeId, count = 10 } = req.body;
    let aiResponse = null;
    try {
        const { system, user } = buildFlashcardPrompt(nodeId, count);
        aiResponse = await generateResponse(user, system);
        res.json(finalizeFlashcards(nodeId, aiResponse));
    } catch (error) {
        console.error('Flashcard generation error:', error);
        res.status(500).json({
            error: error.message,
            rawResponse: aiResponse
        });
    }
});

// Streaming variant: same result as /api/ai/flashcards, but runs as a
// background task (survives the client going away; visible/cancellable in
// the global task dock) and emits the model's reasoning + running output
// length so the client can show live "Thinking… / Generating…" counts.
async function runFlashcardGeneration({ nodeId, count, emit, signal }) {
    let aiResponse = '';
    let thinkingChars = 0;
    try {
        const { system, user } = buildFlashcardPrompt(nodeId, count);
        for await (const part of streamResponse(user, system, [], { signal, temperature: 0.5, think: true })) {
            if (part && part.type === 'content' && part.content) {
                aiResponse += part.content;
                emit({ progress: aiResponse.length });
            } else if (part && part.type === 'thinking' && part.content) {
                thinkingChars += part.content.length;
                emit({ thinking: thinkingChars });
            }
        }
        return finalizeFlashcards(nodeId, aiResponse);
    } catch (error) {
        if (signal.aborted) return { cancelled: true };
        console.error('Flashcard generation error:', error);
        if (error.rawResponse === undefined) error.rawResponse = aiResponse || null;
        throw error;
    }
}

app.post('/api/ai/flashcards/stream', (req, res) => {
    const { nodeId, count = 10 } = req.body;
    if (!nodeId) return res.status(400).json({ error: 'Missing required field: nodeId' });
    const info = nodeTaskInfo(Number(nodeId));
    if (!info) return res.status(404).json({ error: 'Node not found' });

    const { task } = tasks.createTask({
        kind: 'flashcards',
        label: info.title,
        nodeId: Number(nodeId),
        projectId: info.projectId,
        projectName: info.projectName,
        projectColor: info.projectColor,
        dedupeKey: `flashcards:${nodeId}`,
        run: ({ emit, signal }) => runFlashcardGeneration({ nodeId: Number(nodeId), count, emit, signal }),
    });
    attachTaskStream(req, res, task.id);
});

// BULK STUDY MATERIAL
//
// One request covers many topics. Deliberately NOT an SSE stream: the job
// outlives any page (it is on bulkGen's own chain, mirrored into the TaskDock),
// so the client polls a plain status endpoint and can close the dialog, walk
// away, or reload without touching the run.

app.get('/api/projects/:id/bulk-candidates', (req, res) => {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'Bad project id' });
    try {
        res.json({
            candidates: bulkCandidates(projectId),
            max: MAX_BULK_NODES,
            // Measured per-call timings, so the dialog can state the size of the
            // request in minutes rather than only in model calls.
            estimates: bulkEstimates(),
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/ai/bulk', (req, res) => {
    const { projectId, nodeIds, kinds, questionCount, cardCount, skipExisting = true } = req.body || {};
    if (!Number.isInteger(Number(projectId))) {
        return res.status(400).json({ error: 'Missing required field: projectId' });
    }
    if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
        return res.status(400).json({ error: 'Pick at least one topic.' });
    }
    try {
        res.json(startBulk({
            projectId: Number(projectId),
            nodeIds,
            kinds: Array.isArray(kinds) ? kinds : [],
            questionCount, cardCount, skipExisting,
        }));
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

app.get('/api/ai/bulk', (req, res) => res.json(bulkStatus()));

app.delete('/api/ai/bulk', (req, res) => res.json({ cancelled: cancelBulk() }));

app.get('/api/ai/flashcards/:nodeId', (req, res) => {
    const flashcards = db.prepare('SELECT * FROM flashcards WHERE node_id = ? ORDER BY created_at').all(req.params.nodeId);
    res.json(flashcards);
});

app.put('/api/ai/flashcards/:id', (req, res) => {
    const { front, back, extra, extra_front, difficulty, last_reviewed, next_review, ease_factor, last_interval,
        stability, fsrs_difficulty, state, lapses, learning_steps, review_count, rating, undo_review } = req.body;
    // The row as it was, for the review log: a review is "this rating, from
    // this state, after this many days" and only the pre-update row knows it.
    const before = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(req.params.id);
    if (!before) return res.status(404).json({ error: 'Flashcard not found' });
    const updates = [];
    const values = [];
    if (front !== undefined) { updates.push('front = ?'); values.push(front); }
    if (back !== undefined) { updates.push('back = ?'); values.push(back); }
    // The supporting lines under the answer (reading, example sentence, its
    // translation). Editable for the same reason front/back are: the card is
    // the learner's, and an imported one is somebody else's guess about it.
    if (extra !== undefined) { updates.push('extra = ?'); values.push(extra); }
    if (extra_front !== undefined) { updates.push('extra_front = ?'); values.push(extra_front); }
    if (difficulty !== undefined) { updates.push('difficulty = ?'); values.push(difficulty); }
    if (last_reviewed !== undefined) { updates.push('last_reviewed = ?'); values.push(last_reviewed); }
    if (next_review !== undefined) { updates.push('next_review = ?'); values.push(next_review); }
    if (ease_factor !== undefined) { updates.push('ease_factor = ?'); values.push(ease_factor); }
    if (last_interval !== undefined) { updates.push('last_interval = ?'); values.push(last_interval); }
    // FSRS-6 card state. Whitelisted like every other field — the client sends
    // what src/utils/srs.ts computed, and anything not listed here is ignored.
    if (stability !== undefined) { updates.push('stability = ?'); values.push(stability); }
    if (fsrs_difficulty !== undefined) { updates.push('fsrs_difficulty = ?'); values.push(fsrs_difficulty); }
    if (state !== undefined) { updates.push('state = ?'); values.push(state); }
    if (lapses !== undefined) { updates.push('lapses = ?'); values.push(lapses); }
    // The (re)learning ladder rung. In the whitelist for the same reason
    // `state` is: it is scheduler state the client computed, and leaving it out
    // would silently restart the ladder on the card's next rating.
    if (learning_steps !== undefined) {
        updates.push('learning_steps = ?');
        values.push(Math.max(0, Math.round(Number(learning_steps) || 0)));
    }
    if (updates.length > 0) {
        // Only an actual SRS review (which stamps last_reviewed) counts as a
        // review — editing a card's text must not inflate its review history.
        //
        // An EXPLICIT review_count wins over the implicit bump, and that is what
        // makes a review undoable: taking a rating back restores the card's
        // whole prior state, `last_reviewed` included, and re-stamping it must
        // not leave the tally one higher than before the review it just erased.
        // Both in one UPDATE is not an option — the same column twice.
        if (review_count !== undefined) {
            updates.push('review_count = ?');
            values.push(Math.max(0, Math.round(Number(review_count) || 0)));
        } else if (last_reviewed !== undefined) {
            updates.push('review_count = review_count + 1');
        }
        values.push(req.params.id);
        db.prepare(`UPDATE flashcards SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }
    // History. A review carries a `rating` and stamps `last_reviewed`; an undo
    // carries `undo_review` (src/utils/srs.ts puts it on every snapshot) and
    // takes the newest in-app review back out, because a rating that was
    // undone must not be fitted on as if it happened. A plain edit carries
    // neither and touches nothing here.
    const reviewRating = normalizeRating(rating);
    if (reviewRating && last_reviewed !== undefined) {
        const at = last_reviewed ? new Date(last_reviewed) : new Date();
        logReview({
            before, rating: reviewRating,
            after: { stability, fsrs_difficulty },
            now: Number.isNaN(at.getTime()) ? new Date() : at,
        });
        // …and tell the LEARNER MODEL, which for the app's whole life this
        // wrote nothing to: a batch of ratings is one observation about the
        // topic the cards hang off (server/cardEvidence.js). Never fatal — a
        // rating that was taken is a rating that stands, whatever the estimate
        // does with it.
        try {
            recordCardEvidence(before.id);
        } catch (err) {
            console.error('[cards] mastery evidence failed:', err.message);
        }
    } else if (undo_review === true) {
        undoLastReview(before.id);
    }
    const flashcard = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(req.params.id);
    res.json(flashcard);
});

app.delete('/api/ai/flashcards/:id', (req, res) => {
    db.prepare('DELETE FROM flashcards WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// SPACED-REPETITION TUNING — the review log and the FSRS parameter fit.
// (server/reviewLog.js, server/fsrsOptimizer.js; the client scheduler in
// src/utils/srs.ts reads `fsrs_params` on every settings load.)

function readFsrsParams() {
    try {
        const raw = getSetting('fsrs_params', null);
        const w = raw ? JSON.parse(raw) : null;
        return isValidW(w) ? w : null;
    } catch {
        return null;
    }
}
function readFsrsMeta() {
    try {
        const raw = getSetting('fsrs_params_meta', null);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}
const setSettingValue = (key, value) =>
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);

app.get('/api/srs/status', (req, res) => {
    try {
        const sequences = loadReviewSequences();
        const predicted = sequences.reduce((a, s) => a + Math.max(0, s.reviews.length - 1), 0);
        res.json({
            log: reviewLogStats(),
            predicted,
            minReviews: MIN_FIT_REVIEWS,
            // Calibration against the parameters actually in use.
            retention: retentionReport(readFsrsParams() || DEFAULT_W, sequences),
            params: readFsrsParams(),
            meta: readFsrsMeta(),
            defaults: DEFAULT_W,
            running: !!srsOptimizeRunning,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

let srsOptimizeRunning = null;
app.post('/api/srs/optimize', async (req, res) => {
    if (srsOptimizeRunning) return res.status(409).json({ error: 'An optimisation is already running.' });
    const sequences = loadReviewSequences();
    const predicted = sequences.reduce((a, s) => a + Math.max(0, s.reviews.length - 1), 0);
    if (predicted < MIN_FIT_REVIEWS) {
        return res.status(400).json({
            error: `Needs at least ${MIN_FIT_REVIEWS} day-level reviews to fit on — there are ${predicted}. Keep reviewing; the log fills as you go.`,
            predicted, minReviews: MIN_FIT_REVIEWS,
        });
    }
    // Off the request thread: a fit is seconds of pure arithmetic, and the
    // server is single-threaded with a synchronous database — see
    // server/fsrsOptimizerWorker.js.
    let cancelled = false;
    const worker = new Worker(new URL('./fsrsOptimizerWorker.js', import.meta.url), {
        workerData: { sequences, options: { steps: 200 } },
    });
    srsOptimizeRunning = worker;
    const handle = tasks.registerExternal({
        kind: 'srs_optimize',
        label: 'Tuning spaced repetition',
        cancel: () => { cancelled = true; worker.terminate(); },
    });
    try {
        const result = await new Promise((resolve, reject) => {
            worker.on('message', (m) => {
                if (m.progress) handle.update({ percent: Math.min(99, Math.round(m.progress.step / 2)), message: `step ${m.progress.step} · loss ${m.progress.best.toFixed(4)}` });
                if (m.result) resolve(m.result);
                if (m.error) reject(new Error(m.error));
            });
            worker.on('error', reject);
            worker.on('exit', (code) => { if (code !== 0) reject(new Error(cancelled ? 'cancelled' : `optimiser exited with code ${code}`)); });
        });
        if (result.accepted) {
            setSettingValue('fsrs_params', JSON.stringify(result.w));
            setSettingValue('fsrs_params_meta', JSON.stringify({ at: new Date().toISOString(), stats: result.stats, source: 'app' }));
        }
        handle.finish();
        res.json(result);
    } catch (err) {
        if (cancelled) handle.cancelled(); else handle.fail(err.message);
        res.status(cancelled ? 409 : 500).json({ error: err.message });
    } finally {
        srsOptimizeRunning = null;
    }
});

app.delete('/api/srs/params', (req, res) => {
    db.prepare(`DELETE FROM settings WHERE key IN ('fsrs_params', 'fsrs_params_meta')`).run();
    res.json({ ok: true });
});

// MASTERY MODEL TUNING — the learner's own BKT rates (server/bktOptimizer.js).
// A grid over two bounded rates on a few hundred attempts is milliseconds, so
// unlike the FSRS fit it runs on the request thread.
app.get('/api/mastery/model', (req, res) => {
    try {
        const sequences = loadAttemptSequences();
        let meta = null;
        try { const raw = getSetting('bkt_params_meta', null); meta = raw ? JSON.parse(raw) : null; } catch { meta = null; }
        res.json({
            attempts: sequences.reduce((a, s) => a + s.attempts.length, 0),
            topics: sequences.length,
            minAttempts: MIN_FIT_ATTEMPTS,
            params: getLearnerBktParams(),
            defaults: { p_T: BKT_PARAMS.p_T, p_S: BKT_PARAMS.p_S },
            meta,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/mastery/optimize', (req, res) => {
    try {
        const sequences = loadAttemptSequences();
        const result = fitBktRates(sequences);
        if (result.accepted) {
            setSettingValue('bkt_params', JSON.stringify(result.params));
            setSettingValue('bkt_params_meta', JSON.stringify({ at: new Date().toISOString(), stats: result.stats, source: 'app' }));
            reloadLearnerBktParams();
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/mastery/params', (req, res) => {
    db.prepare(`DELETE FROM settings WHERE key IN ('bkt_params', 'bkt_params_meta')`).run();
    reloadLearnerBktParams();
    res.json({ ok: true });
});

// AI INSIGHTS

function buildInsightContext(projectId) {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return {};

    const nodes = db.prepare(`
        SELECT id, parent_id, title, status, is_note, scheduled_start, scheduled_end, completed_at
        FROM nodes WHERE project_id = ? AND is_note = 0 ORDER BY position
    `).all(projectId);

    const nodeMap = new Map(nodes.map(n => [n.id, { ...n, children: [] }]));
    const tree = [];
    for (const node of nodes) {
        if (node.parent_id && nodeMap.has(node.parent_id)) {
            nodeMap.get(node.parent_id).children.push(nodeMap.get(node.id));
        } else {
            tree.push(nodeMap.get(node.id));
        }
    }

    const today = new Date().toISOString().split('T')[0];
    // App-wide convention: 'skipped' counts as closed (advances progress, never
    // overdue) — the insight context must agree with the rest of the app.
    const isClosed = (status) => status === 'completed' || status === 'skipped';
    const processNode = (node) => {
        const isOverdue = !isClosed(node.status) && node.scheduled_end && node.scheduled_end < today;
        let childrenData = [], completedCount = 0, totalCount = 0;

        if (node.children.length > 0) {
            childrenData = node.children.map(processNode);
            completedCount = childrenData.reduce((sum, c) => sum + c.completedCount, 0);
            totalCount = childrenData.reduce((sum, c) => sum + c.totalCount, 0);
        } else {
            totalCount = 1;
            completedCount = isClosed(node.status) ? 1 : 0;
        }

        return {
            title: node.title, status: node.status,
            progress: totalCount > 0 ? `${Math.round((completedCount / totalCount) * 100)}%` : '0%',
            isOverdue, scheduled_end: node.scheduled_end, completedCount, totalCount,
            children: childrenData.length > 0 ? childrenData : undefined
        };
    };

    const condensedTree = tree.map(processNode);

    // Only query LEAF nodes (child_count = 0) for temporal lists.
    // Parent nodes are never manually marked 'completed' in the DB, so they
    // incorrectly show up as pending/overdue even when all their children are done.
    const todayTasks = db.prepare(`
        SELECT n.id, n.title
        FROM nodes n
        WHERE n.project_id = ? AND ${OPEN_WORK_LEAF}
        AND n.scheduled_start <= ? AND n.scheduled_end >= ?
    `).all(projectId, today, today).map(n => ({ title: n.title, nodeId: n.id }));

    const overdueTasks = db.prepare(`
        SELECT n.id, n.title
        FROM nodes n
        WHERE n.project_id = ? AND ${OPEN_WORK_LEAF}
        AND n.scheduled_end < ?
    `).all(projectId, today).map(n => ({ title: n.title, nodeId: n.id }));

    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const threeDaysAgoStr = threeDaysAgo.toISOString().split('T')[0];

    const recentlyCompleted = db.prepare(`
        SELECT n.id, n.title
        FROM nodes n
        WHERE n.project_id = ? AND ${WORK_LEAF}
        AND n.status = 'completed'
        AND n.completed_at >= ?
    `).all(projectId, threeDaysAgoStr).map(n => n.title);

    let weakQuizAreas = [];
    try {
        // Added n.id as node_id so the AI can reference it
        weakQuizAreas = db.prepare(`
            SELECT n.title as weak_area, n.id as node_id, ROUND(AVG(qa.score * 100.0 / qa.total)) as avg_score
            FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id JOIN nodes n ON n.id = q.node_id
            WHERE n.project_id = ? GROUP BY q.node_id HAVING avg_score < 75 ORDER BY avg_score ASC LIMIT 3
        `).all(projectId);
    } catch (e) { }

    let fcStats = { total: 0, due: 0 };
    try {
        fcStats = db.prepare(`
            SELECT COUNT(*) as total, SUM(CASE WHEN ${reviewDue('f')} THEN 1 ELSE 0 END) as due
            FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ?
        `).get(projectId) || { total: 0, due: 0 };
    } catch (e) { }

    let pace = { message: 'No schedule', daysBehind: 0, expectedProgress: 0, actualProgress: 0, paceStatus: 'no_schedule' };
    if (project.start_date && project.deadline) {
        try { pace = calculatePace(projectId); } catch (e) { }
    }

    return {
        projectName: project.name, deadline: project.deadline,
        paceStatus: pace.paceStatus, daysBehind: pace.daysBehind,
        expectedProgress: pace.expectedProgress, actualProgress: pace.actualProgress,
        weakQuizAreas, flashcardsDue: fcStats.due || 0,
        todayTasks, overdueTasks, recentlyCompleted,
        projectTree: condensedTree
    };
}

// Parse the model's raw output into a saved insights payload. Shared by the
// blocking and streaming insights endpoints (mirrors finalizeQuiz above).
function finalizeInsights(projectId, contextPayload, aiResponse) {
    let parsedInsights;
    try {
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        parsedInsights = jsonMatch ? JSON.parse(jsonMatch[0]) : { message: aiResponse, actions: [] };
    } catch (e) {
        parsedInsights = { message: aiResponse, actions: [] };
    }

    // A local model sometimes emits `message` as a nested object/array/number
    // instead of a string. Persisting that non-string crashes the client (the
    // Markdown renderer calls `.split` on it). Coerce to a string at the source.
    if (parsedInsights && typeof parsedInsights === 'object' && typeof parsedInsights.message !== 'string') {
        parsedInsights.message = parsedInsights.message == null
            ? ''
            : typeof parsedInsights.message === 'object'
                ? JSON.stringify(parsedInsights.message)
                : String(parsedInsights.message);
    }

    // Drop actions whose nodeId the model invented or copied wrong — otherwise
    // the UI renders a "Start Task" / "Review" button that opens nothing. Every
    // node-scoped action must reference a real node in THIS project; only
    // 'recalibrate' legitimately carries no nodeId.
    if (parsedInsights && Array.isArray(parsedInsights.actions)) {
        const validIds = new Set(
            db.prepare('SELECT id FROM nodes WHERE project_id = ?').all(projectId).map(n => n.id)
        );
        parsedInsights.actions = parsedInsights.actions
            .filter(a => a && typeof a === 'object' && a.type)
            .filter(a => {
                if (a.type === 'recalibrate') return true;
                const id = Number(a.nodeId);
                if (!validIds.has(id)) return false;
                a.nodeId = id; // normalize to a clean integer for the client
                return true;
            });
    }

    saveInsightsToDb(projectId, JSON.stringify(parsedInsights));
    return {
        stats: {
            completed: contextPayload.projectTree ? contextPayload.projectTree.reduce((a, c) => a + c.completedCount, 0) : 0,
            inProgress: 0,
            total: contextPayload.projectTree ? contextPayload.projectTree.reduce((a, c) => a + c.totalCount, 0) : 0
        },
        insights: parsedInsights
    };
}

app.post('/api/ai/insights', async (req, res) => {
    const { projectId } = req.body;
    let aiResponse = null;
    try {
        const contextPayload = buildInsightContext(projectId);
        const { system, user } = AI_PROMPTS.insights(contextPayload);
        aiResponse = await generateResponse(user, system, [], { operation: 'insights' });
        res.json(finalizeInsights(projectId, contextPayload, aiResponse));
    } catch (error) {
        console.error('Insights error:', error);
        res.status(500).json({
            error: error.message,
            rawResponse: aiResponse
        });
    }
});

// Streaming variant: same result as /api/ai/insights, but runs as a
// background task — the result is cached server-side (projects.insights), so
// a generation whose subscriber navigated away still lands and the dashboard
// picks it up from the cache on return.
async function runInsightsGeneration({ projectId, emit, signal }) {
    let aiResponse = '';
    let thinkingChars = 0;
    try {
        const contextPayload = buildInsightContext(projectId);
        const { system, user } = AI_PROMPTS.insights(contextPayload);
        for await (const part of streamResponse(user, system, [], { signal, temperature: 0.5, think: true })) {
            if (part && part.type === 'content' && part.content) {
                aiResponse += part.content;
                emit({ progress: aiResponse.length });
            } else if (part && part.type === 'thinking' && part.content) {
                thinkingChars += part.content.length;
                emit({ thinking: thinkingChars });
            }
        }
        return finalizeInsights(projectId, contextPayload, aiResponse);
    } catch (error) {
        if (signal.aborted) return { cancelled: true };
        console.error('Insights error:', error);
        if (error.rawResponse === undefined) error.rawResponse = aiResponse || null;
        throw error;
    }
}

app.post('/api/ai/insights/stream', (req, res) => {
    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: 'Missing required field: projectId' });
    const project = db.prepare('SELECT id, name, color FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { task } = tasks.createTask({
        kind: 'insights',
        label: project.name,
        projectId: Number(projectId),
        projectName: project.name,
        projectColor: project.color,
        dedupeKey: `insights:${projectId}`,
        run: ({ emit, signal }) => runInsightsGeneration({ projectId: Number(projectId), emit, signal }),
    });
    attachTaskStream(req, res, task.id);
});

app.get('/api/projects/:id/insights', (req, res) => {
    const project = db.prepare(
        'SELECT insights, insights_generated_at FROM projects WHERE id = ?'
    ).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let parsedInsights = null;
    if (project.insights) {
        if (typeof project.insights === 'string') {
            try {
                parsedInsights = JSON.parse(project.insights);
            } catch (e) {
                parsedInsights = project.insights;
            }
        } else {
            parsedInsights = project.insights;
        }
    }

    res.json({
        insights: parsedInsights,
        generatedAt: project.insights_generated_at,
    });
});

function saveInsightsToDb(projectId, insightsText) {
    try {
        // Use JavaScript ISO string so the timestamp includes the 'Z' UTC suffix,
        // making it unambiguous for client-side parsing regardless of timezone.
        const isoNow = new Date().toISOString();
        db.prepare(`
            UPDATE projects
            SET insights = ?, insights_generated_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(insightsText, isoNow, projectId);
    } catch (err) {
        console.error('[Insights] Failed to save:', err.message);
    }
}

// CROSS-PROJECT DAILY BRIEFING + PLANNING CHAT (global Today hub)

// Parse and validate the briefing. Every action must reference a real node in
// an ACTIVE project — a small local model copies ids imperfectly, and an
// unvalidated button that opens nothing erodes trust (same rationale as
// finalizeInsights, but pairs span projects here).
function finalizeTodayBriefing(aiResponse) {
    let parsed;
    try {
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { message: aiResponse, actions: [] };
    } catch (e) {
        parsed = { message: aiResponse, actions: [] };
    }

    if (parsed && Array.isArray(parsed.actions)) {
        const nodeProject = new Map(
            db.prepare(`
                SELECT n.id, n.project_id FROM nodes n
                ${ACTIVE_PROJECT_JOIN}
            `).all().map(r => [r.id, r.project_id])
        );
        const schedulableProjects = new Set(
            db.prepare(`
                SELECT id FROM projects
                WHERE COALESCE(status, 'active') = 'active'
                  AND start_date IS NOT NULL AND deadline IS NOT NULL
            `).all().map(p => p.id)
        );
        parsed.actions = parsed.actions
            .filter(a => a && typeof a === 'object' && a.type)
            .filter(a => {
                if (a.type === 'review_flashcards') {
                    delete a.nodeId; delete a.projectId;
                    return true;
                }
                if (a.type === 'recalibrate') {
                    const pid = Number(a.projectId);
                    if (!schedulableProjects.has(pid)) return false;
                    a.projectId = pid; delete a.nodeId;
                    return true;
                }
                if (a.type === 'open_node') {
                    const nid = Number(a.nodeId);
                    const realPid = nodeProject.get(nid);
                    if (realPid == null) return false;
                    // Trust the node id; correct a mis-copied projectId silently.
                    a.nodeId = nid; a.projectId = realPid;
                    return true;
                }
                return false;
            });
    } else if (parsed) {
        parsed.actions = [];
    }

    // No project row exists for a global artifact — cache in the settings kv.
    try {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
            'today_briefing',
            JSON.stringify({ insights: parsed, generatedAt: new Date().toISOString() })
        );
    } catch (err) {
        console.error('[TodayBriefing] Failed to cache:', err.message);
    }

    return parsed;
}

// Briefing generation as a background task: the result is cached in the
// settings kv (finalizeTodayBriefing), so a generation that outlives its
// subscriber still lands and the Today hub reads it from the cache on return.
async function runTodayBriefing({ emit, signal }) {
    let aiResponse = '';
    let thinkingChars = 0;
    // Bounded copy of the reasoning channel: a thinking model can burn its whole
    // budget reasoning and emit no answer, so we surface that text as raw output
    // instead of failing with an empty box (mirrors runQuizGeneration).
    let thinkingText = '';
    const THINKING_RAW_CAP = 8000;
    // "Warming up the model" heartbeat until the first token lands — a cold model
    // swap holds the upstream request open for up to a minute with zero bytes.
    let firstTokenSeen = false;
    let loadingTimer = null;
    const startedAt = Date.now();
    const stopLoadingHeartbeat = () => {
        if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
    };
    try {
        // Fail fast if the model server is down; stay patient if it's merely loading.
        const reachable = await probeAiReachable();
        if (!reachable.ok) throw new Error(reachable.error);

        loadingTimer = setInterval(() => {
            if (!firstTokenSeen && !signal.aborted) {
                emit({ phase: 'loading_model', waitedMs: Date.now() - startedAt });
            }
        }, 2000);

        const contextPayload = buildTodayBriefingContext({ decayDays: getGateConfig().decayDays });
        const { system, user } = AI_PROMPTS.today_briefing(contextPayload);
        for await (const part of streamResponse(user, system, [], { signal, temperature: 0.5, think: true })) {
            if (part && (part.type === 'content' || part.type === 'thinking') && part.content) {
                if (!firstTokenSeen) { firstTokenSeen = true; stopLoadingHeartbeat(); emit({ phase: 'generating' }); }
            }
            if (part && part.type === 'content' && part.content) {
                aiResponse += part.content;
                emit({ progress: aiResponse.length });
            } else if (part && part.type === 'thinking' && part.content) {
                thinkingChars += part.content.length;
                if (thinkingText.length < THINKING_RAW_CAP) thinkingText += part.content;
                emit({ thinking: thinkingChars });
            }
        }
        stopLoadingHeartbeat();
        // A reasoning model can finish having emitted only a thinking stream and no
        // answer. Don't cache an empty briefing — give an actionable error and
        // surface the reasoning as raw output.
        if (!aiResponse.trim()) {
            throw Object.assign(
                new Error('The AI model returned no briefing text — it may have spent its whole budget "thinking". Try again, or switch to a model that emits a final answer.'),
                { rawResponse: thinkingText || null }
            );
        }
        return { insights: finalizeTodayBriefing(aiResponse) };
    } catch (error) {
        stopLoadingHeartbeat();
        if (signal.aborted) return { cancelled: true };
        console.error('Today briefing error:', error);
        if (error.rawResponse === undefined) {
            error.rawResponse = aiResponse || thinkingText || null;
        }
        throw error;
    }
}

app.post('/api/ai/today-briefing/stream', (req, res) => {
    // Deduped globally: re-requesting a briefing while one is generating
    // reattaches instead of racing a second one against the cache.
    const { task } = tasks.createTask({
        kind: 'briefing',
        label: 'Daily briefing',
        dedupeKey: 'briefing',
        run: ({ emit, signal }) => runTodayBriefing({ emit, signal }),
    });
    attachTaskStream(req, res, task.id);
});

app.get('/api/today/briefing', (req, res) => {
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'today_briefing'").get();
        if (!row?.value) return res.json({ insights: null, generatedAt: null });
        const cached = JSON.parse(row.value);
        res.json({ insights: cached.insights ?? null, generatedAt: cached.generatedAt ?? null });
    } catch (err) {
        res.json({ insights: null, generatedAt: null });
    }
});

// Budgets for the page context. It sits in front of the cross-project snapshot,
// so it has to stay a briefing, not a dump — but "teach the topic on screen" is
// impossible from a title, which is what it used to amount to.
const PAGE_OVERVIEW_CHARS = 600;
const PAGE_MATERIAL_CHARS = 1800;
const PAGE_LESSON_CHARS = 2500;
const PAGE_MISSES = 3;
const PAGE_MISS_CHARS = 220;

/**
 * The learner's own material under a topic: its `is_note` children, which is
 * where a curriculum's real depth lives (the feed teaches them as the lesson
 * body). Budgeted across however many there are, so one long reading can't eat
 * the whole allowance.
 */
function topicMaterial(nodeId) {
    const notes = db.prepare(`
        SELECT title, description FROM nodes
        WHERE parent_id = ? AND is_note = 1
        ORDER BY position ASC LIMIT 4
    `).all(nodeId).filter(n => String(n.description || '').trim());
    if (!notes.length) return '';
    const per = Math.max(300, Math.floor(PAGE_MATERIAL_CHARS / notes.length));
    return notes.map(n => `- ${n.title}: ${String(n.description).trim().slice(0, per)}`).join('\n');
}

/**
 * What the learner recently got WRONG on this topic — the single most useful
 * thing the assistant can know when asked "why don't I get this". Read from the
 * feed's own consumed questions (result = {correct, answer}), so it reflects
 * what actually happened, not what a model assumes happened.
 */
function recentMisses(nodeId) {
    let rows = [];
    try {
        rows = db.prepare(`
            SELECT content, result FROM feed_items
            WHERE node_id = ? AND kind = 'question' AND status = 'consumed' AND result IS NOT NULL
            ORDER BY consumed_at DESC LIMIT 12
        `).all(nodeId);
    } catch { return ''; }

    const out = [];
    for (const r of rows) {
        if (out.length >= PAGE_MISSES) break;
        let res = null;
        let q = null;
        try { res = JSON.parse(r.result); } catch { continue; }
        if (!res || res.correct !== false) continue;
        try { q = JSON.parse(r.content); } catch { continue; }
        const stem = String(q?.question || '').replace(/```[\s\S]*?```/g, '[diagram]').trim();
        if (!stem) continue;
        out.push(`- Asked: ${stem.slice(0, PAGE_MISS_CHARS)}`
            + (res.answer ? `\n  They answered: ${String(res.answer).slice(0, 120)}` : '')
            + (q?.answer ? `\n  Correct: ${String(q.answer).slice(0, 120)}` : ''));
    }
    return out.join('\n');
}

/**
 * Describe the screen the learner is on, for the global assistant.
 *
 * Takes ids, returns prose — and every name in that prose is read out of the
 * database here. The client is trusted to say *where* it is, never *what* is
 * there, so no amount of client (or injected) text can put a fabricated topic
 * into the model's context as fact. `feedItemId` obeys the same rule: it names
 * a row, and the row's own text is what gets quoted.
 *
 * Returns { text, projectId } — the id is the RAG scope, so a question asked
 * inside a project searches that project's vault first instead of everything.
 */
function buildPageContext(context) {
    const empty = { text: '', projectId: null };
    if (!context || typeof context !== 'object') return empty;
    const view = typeof context.view === 'string' ? context.view : '';
    const nodeId = Number(context.nodeId);
    const projectId = Number(context.projectId);
    const feedItemId = Number(context.feedItemId);
    const lines = [];
    let scopeProjectId = Number.isInteger(projectId) ? projectId : null;

    // On the feed there is no "selected node" — the card in front of the reader
    // is the context, and the client reports it by row id.
    let focusNodeId = Number.isInteger(nodeId) ? nodeId : null;
    let feedItem = null;
    if (!focusNodeId && Number.isInteger(feedItemId)) {
        feedItem = db.prepare('SELECT id, node_id, kind, content FROM feed_items WHERE id = ?').get(feedItemId);
        if (feedItem) focusNodeId = feedItem.node_id;
    }

    if (focusNodeId) {
        const node = db.prepare(`
            SELECT n.id, n.title, n.status, n.description, p.id AS pid, p.name AS pname
            FROM nodes n JOIN projects p ON p.id = n.project_id WHERE n.id = ?
        `).get(focusNodeId);
        if (node) {
            scopeProjectId = node.pid;
            lines.push(`Open topic: "${node.title}" (projectId ${node.pid}, nodeId ${node.id}) in project "${node.pname}" — status ${node.status}.`);
            if (node.description) lines.push(`Its overview: ${String(node.description).slice(0, PAGE_OVERVIEW_CHARS)}`);

            const material = topicMaterial(node.id);
            if (material) lines.push(`Material attached to this topic:\n${material}`);

            if (feedItem?.kind === 'lesson') {
                lines.push(`The card they are reading right now (quote and build on THIS, do not re-teach it from scratch):\n${String(feedItem.content).slice(0, PAGE_LESSON_CHARS)}`);
            } else if (feedItem?.kind === 'question') {
                let q = null;
                try { q = JSON.parse(feedItem.content); } catch { /* keep going without it */ }
                if (q?.question) lines.push(`The question on their screen: ${String(q.question).slice(0, 600)}`);
            }

            const misses = recentMisses(node.id);
            if (misses) lines.push(`Recently answered WRONG on this topic:\n${misses}`);
        }
    } else if (Number.isInteger(projectId)) {
        const project = db.prepare('SELECT id, name, summary FROM projects WHERE id = ?').get(projectId);
        if (project) {
            lines.push(`Open project: "${project.name}" (projectId ${project.id}).`);
            if (project.summary) lines.push(`Its summary: ${String(project.summary).slice(0, 400)}`);
        }
    }

    const SCREENS = {
        today: 'the learning feed (the home page)',
        projects: 'the projects grid',
        calendar: 'the global calendar',
        settings: 'the settings screen',
        workspace: 'a project workspace',
    };
    if (SCREENS[view]) lines.push(`Screen: ${SCREENS[view]}.`);
    return { text: lines.join('\n'), projectId: scopeProjectId };
}

// Global planning chat. History lives in chat_messages with node_id AND
// project_id NULL — the orphan cleanup in database.js must keep skipping
// NULL node_id rows, or this history would be swept on startup.
app.post('/api/ai/today-chat/stream', (req, res) => {
    const { message, context, useWeb } = req.body;
    if (!message || !String(message).trim()) {
        return res.status(400).json({ error: 'Missing required field: message' });
    }
    // The client sends only WHERE it is (a view name and ids). The description
    // is built here from the database, so the prompt can never be fed prose the
    // client made up about a topic that doesn't exist.
    const page = buildPageContext(context);
    // Single global planning conversation — same one-turn-at-a-time rule as
    // the node tutor (the Today chat reattaches on mount).
    if (tasks.findActive({ kind: 'today_chat' })) {
        return res.status(409).json({ error: 'The planner is still answering. Wait for it to finish or stop it first.' });
    }
    const { task } = tasks.createTask({
        kind: 'today_chat',
        label: 'Planning chat',
        meta: { message: String(message) },
        // The vault is searched for the assistant too: it is the only surface
        // reachable from every screen, and answering "what does my textbook say
        // about X" from a title alone is guessing. Scope follows the page — the
        // open project's documents first, the whole vault from a global screen.
        run: ({ emit, signal }) => runChatTurn({
            nodeId: null, projectId: null, message: String(message),
            useRag: true, useWeb, ragProjectId: page.projectId,
            emit, signal, pageContext: page.text,
        }),
    });
    attachTaskStream(req, res, task.id);
});

app.get('/api/ai/today-chat', (req, res) => {
    const messages = db.prepare(`
        SELECT id, role, content, reasoning, actions, created_at
        FROM chat_messages
        WHERE node_id IS NULL AND project_id IS NULL
        ORDER BY created_at
    `).all();
    res.json(messages.map(withActions));
});

app.delete('/api/ai/today-chat', (req, res) => {
    db.prepare('DELETE FROM chat_messages WHERE node_id IS NULL AND project_id IS NULL').run();
    res.json({ success: true });
});

// AI PROJECT CREATION (SSE)

// Registry of in-flight AI generations, keyed by projectId. Lets the
// cancel endpoint reach into a running generation and actually stop it
// (abort the Ollama request + break the phase loop) rather than merely
// disconnecting the SSE stream and letting it finish in the background.
const activeGenerations = new Map();

app.post('/api/ai/create-project', (req, res) => {
    const { name, description, summary, color, icon, content_language } = req.body;
    if (!name) return res.status(400).json({ error: 'Project name is required' });

    const projectColor = color || '#3B82F6';
    const projectIcon = icon || 'folder';
    const projectLanguage = isSupportedLanguage(content_language) ? (content_language || '') : '';
    // Resolved from the catalog, not the DB: the project row does not exist yet
    // when the first structure call runs.
    const creationLang = getLanguage(projectLanguage);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    req.setTimeout(0);
    res.setTimeout(0);
    if (res.socket) res.socket.setTimeout(0);

    let keepAlive = setInterval(() => {
        if (keepAlive && !res.writableEnded) {
            res.write(': keepalive\n\n');
        }
    }, 15000);

    const clearKeepAlive = () => {
        if (keepAlive) {
            clearInterval(keepAlive);
            keepAlive = null;
        }
    };

    let userCancelled = false;
    let completed = false;
    const abortController = new AbortController();
    // Hoisted to the outer scope so the `res.on('close', ...)` handler below
    // can reference it for logging. The inner async IIFE assigns to it once
    // the project shell is inserted into the DB.
    let projectId = null;

    // Registered in `activeGenerations` immediately (keyed by a temp id, not
    // projectId — the project row doesn't exist yet during the thinking phase)
    // so POST /api/ai/cancel-creation can actually stop a run before the client
    // knows the real projectId. Re-keyed to projectId once it's known. Without
    // this, cancelling during "Analyzing project scope..." only dropped the
    // client's SSE connection while the server kept generating in the background.
    const cancelHandle = {
        cancel: () => {
            userCancelled = true;
            abortController.abort();
        },
    };
    const pendingGenKey = `pending-${randomUUID()}`;
    activeGenerations.set(pendingGenKey, cancelHandle);

    // Mirror this creation into the background-task registry so the global
    // task dock shows its progress and can cancel it. Creation long predates
    // the task queue and manages its own pipeline, so it registers as an
    // *external* task (runs alongside queued tasks, not through them).
    const mirrorTask = tasks.registerExternal({
        kind: 'create_project',
        label: name,
        projectColor,
        cancel: () => {
            userCancelled = true;
            abortController.abort();
        },
    });

    const send = (data) => {
        mirrorTask.update({
            percent: typeof data.overallProgress === 'number' ? data.overallProgress : undefined,
            message: typeof data.message === 'string' ? data.message : undefined,
            phase: typeof data.phase === 'string' ? data.phase : undefined,
        });
        if (res.writableEnded) return false;
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        return true;
    };

    // Listen on `res`, not `req`: `req` 'close' fires as soon as the POST body is
    // consumed by body-parser (≈1ms in), which would clear the keepalive and log a
    // bogus "client disconnected" on every creation. `res` 'close' fires on a real
    // connection close; `writableEnded` guards against our own `res.end()`.
    res.on('close', () => {
        if (completed || res.writableEnded) return;

        // ✅ Client disconnected (e.g. Vite HMR, page reload, or navigation).
        // Do NOT abort the generation. Let it continue in the background.
        // The frontend's completion polling will detect when it finishes.
        // The `send()` and `finish()` helpers already guard on `res.writableEnded`,
        // so SSE writes to a dead socket are silently dropped without crashing.
        clearKeepAlive(); // Stop sending keepalive pings to a dead connection

        console.log(
            `[AI Creation] Client disconnected` +
            (projectId ? ` for project ${projectId}` : ' (no projectId yet)') +
            `. Generation continuing in background.`
        );
    });

    const isCancelled = () => userCancelled && abortController.signal.aborted;

    const finish = (finalData) => {
        completed = true;
        clearKeepAlive();
        activeGenerations.delete(pendingGenKey);
        if (projectId) activeGenerations.delete(projectId);
        // Settle the mirror task (no-ops if the catch below already settled it
        // with a more specific error/cancelled state).
        if (finalData) mirrorTask.finish();
        else if (userCancelled) mirrorTask.cancelled();
        else mirrorTask.fail('AI creation failed');
        if (!res.writableEnded) {
            if (finalData) send({ ...finalData, done: true });
            res.end();
        }
    };

    (async () => {
        // `projectId` is intentionally NOT redeclared here — it is hoisted
        // to the outer scope (next to `userCancelled` and `completed`) so the
        // `res.on('close', ...)` handler can also reference it for logging.
        let projectSummary = '';
        let thinkingText = '';
        let totalCategories = 0;
        // Actual counts, accumulated as each level is really written. Kept
        // strictly apart from the `est*` figures below: those exist only to
        // size the progress bar before anything is generated, and mixing the
        // two made the final `stats` report a guess (and, for resources, an
        // estimate plus the real count on top of it).
        let totalElements = 0;
        let totalSubElements = 0;
        let totalResources = 0;
        let estElements = 0;
        let estSubElements = 0;
        let overallProgress = 0;

        const W_CAT = 10, W_EL = 5, W_SE = 3, W_RES = 1;
        // Per-leaf resource curation is opt-out (Settings → AI & Models). Read
        // once, at the start, so flipping the setting mid-run can't desync the
        // progress estimate from the work actually being done.
        const curateResources = getSetting('creation_find_resources', 'true') !== 'false';
        const EST_EL_PER_CAT = 4, EST_SE_PER_EL = 4, EST_RES_PER_SE = curateResources ? 2 : 0;

        let totalWorkUnits = 0;
        let completedWorkUnits = 0;

        const aiSettings = getAISettings();

        try {
            send({
                phase: 'thinking',
                message: 'Analyzing project scope...',
            });

            try {
                // Reuses outer-scope `thinkingText` so the value survives past this try block.
                for await (const part of streamProjectThinking(
                    name, description, abortController.signal
                )) {
                    if (part.type === 'thinking') {
                        thinkingText += part.content;
                        send({ phase: 'thinking', thinkingChunk: part.content });
                    } else if (part.type === 'content') {
                        thinkingText += part.content;
                        send({ phase: 'thinking', contentChunk: part.content });
                    }
                }
                send({ phase: 'thinking_done' });
            } catch (thinkingError) {
                console.log('[AI] Thinking phase failed:', thinkingError.message);
                if (abortController.signal.aborted) throw thinkingError;
            }

            send({ phase: 'init', message: 'Checking AI model availability...' });

            const healthCheck = await checkOllamaHealth();
            if (!healthCheck.available) {
                throw new Error(`AI provider is not available: ${healthCheck.error}`);
            }

            const availableModels = healthCheck.models.map(m => m.name);
            // No built-in default model anymore — an unselected model is a clean
            // "pick one" error for either provider, not a confusing "" lookup.
            if (!aiSettings.model) {
                throw new Error('No model selected — choose or install one in Settings → AI Connection');
            }
            // Strict only for Ollama — OpenAI-compatible servers may accept
            // aliases that /v1/models doesn't list (llama-swap's `aliases:`),
            // so there a mismatch is the provider's problem, not a hard stop.
            if (aiSettings.provider === 'ollama' && !availableModels.includes(aiSettings.model)) {
                throw new Error(
                    `Model "${aiSettings.model}" is not installed. ` +
                    `Available: ${availableModels.length > 0 ? availableModels.join(', ') : 'none'}`
                );
            }

            send({
                phase: 'init',
                message: `Model "${aiSettings.model}" is available.`,
                model: aiSettings.model,
            });

            const projectResult = db.prepare(
                'INSERT INTO projects (name, description, color, icon, position, content_language, ai_generating) VALUES (?, ?, ?, ?, ?, ?, 1)'
            ).run(
                name.substring(0, 500),
                name.substring(0, 5000),
                projectColor,
                projectIcon,
                nextProjectPosition(),
                projectLanguage
            );
            projectId = projectResult.lastInsertRowid;
            mirrorTask.setProject(Number(projectId), name.substring(0, 500), projectColor);

            // Re-key the cancel handle from the temp pending id to the now-known
            // projectId so POST /api/ai/cancel-creation can target it by projectId too.
            activeGenerations.delete(pendingGenKey);
            activeGenerations.set(projectId, cancelHandle);

            send({
                phase: 'init',
                message: 'Project shell created.',
                projectId,
            });

            send({ phase: 'summary', message: 'Generating project summary...' });

            try {
                const { system: sumSys, user: sumUser } = AI_PROMPTS.summarizeProjectDescription(name, description);
                const summaryResult = await generateResponse(sumUser, sumSys, [], { signal: abortController.signal, temperature: 0.2, top_p: 0.8, operation: 'summary' });
                projectSummary = cleanSummary(summaryResult);
                db.prepare('UPDATE projects SET summary = ? WHERE id = ?')
                    .run(projectSummary, projectId);
                db.prepare('UPDATE projects SET description = ? WHERE id = ?')
                    .run(buildProjectDescription(projectSummary), projectId);

                send({
                    phase: 'summary',
                    summary: projectSummary,
                });
            } catch (summaryError) {
                console.log('[AI] Summary failed:', summaryError.message);
                projectSummary = name;
            }

            send({
                phase: 'generating_categories',
                message: `Generating category structure for "${name}"...`,
            });

            const categories = await generateStructure(
                AI_PROMPTS.generate_categories(name, description || 'No description provided', thinkingText.substring(0, 2000), projectSummary, { lang: creationLang }),
                validateCategories,
                { signal: abortController.signal, minItems: 1 }
            );
            totalCategories = categories.length;

            estElements = totalCategories * EST_EL_PER_CAT;
            estSubElements = estElements * EST_SE_PER_EL;
            totalWorkUnits =
                totalCategories * W_CAT +
                estElements * W_EL +
                estSubElements * W_SE +
                estSubElements * EST_RES_PER_SE * W_RES;

            completedWorkUnits += totalCategories * W_CAT;
            overallProgress = Math.round((completedWorkUnits / totalWorkUnits) * 100);

            send({
                phase: 'categories_generated',
                categories: categories.map((c, i) => ({
                    index: i,
                    title: c.title,
                    description: c.description,
                })),
                overallProgress,
            });

            // Every node this pipeline writes carries an AI-authored Overview
            // (`description`), so the whole tree is stamped — one identity taken
            // once, since a creation run is a single generation session.
            const creationProvenance = aiProvenance();
            const insertNode = db.prepare(`
                INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position, generated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const categoryIds = [];
            const catTransaction = db.transaction(() => {
                categories.forEach((cat, idx) => {
                    const result = insertNode.run(
                        projectId, null, cat.title, cat.description,
                        '', 'not_started', 0, idx, creationProvenance
                    );
                    categoryIds.push(result.lastInsertRowid);
                });
            });
            catTransaction();

            await new Promise(resolve => setImmediate(resolve));

            for (let catIdx = 0; catIdx < categories.length; catIdx++) {
                if (isCancelled()) throw new Error('Cancelled');

                const category = categories[catIdx];
                const categoryId = categoryIds[catIdx];

                send({
                    phase: 'generating_elements',
                    message: `Generating elements for ${category.title}...`,
                    currentCategory: category.title,
                    categoryIndex: catIdx,
                    totalCategories,
                });

                const elements = await generateStructure(
                    AI_PROMPTS.generate_elements(name, projectSummary, category.title, category.description, { lang: creationLang }),
                    validateElements,
                    { signal: abortController.signal, minItems: 1 }
                );

                totalElements += elements.length;
                completedWorkUnits += elements.length * W_EL;
                overallProgress = Math.round((completedWorkUnits / totalWorkUnits) * 100);

                send({
                    phase: 'elements_generated',
                    categoryIndex: catIdx,
                    categoryTitle: category.title,
                    currentCategory: category.title,
                    elements: elements.map((e, i) => ({
                        index: i,
                        title: e.title,
                        description: e.description,
                    })),
                    overallProgress,
                });

                const elementIds = [];
                const elTransaction = db.transaction(() => {
                    elements.forEach((el, idx) => {
                        const result = insertNode.run(
                            projectId, categoryId, el.title, el.description,
                            '', 'not_started', 0, idx, creationProvenance
                        );
                        elementIds.push(result.lastInsertRowid);
                    });
                });
                elTransaction();

                await new Promise(resolve => setImmediate(resolve));

                // Phase: Sub-elements
                //
                // One batched call expands the whole phase. Creation used to
                // pay a full round trip (prefill + a possible model warm-up)
                // PER element, which is the single biggest fixed cost in the
                // pipeline; a 5-element phase now costs one request instead of
                // five. Skipped for a 1-element phase (nothing to batch) and
                // for an unusually wide one (the response would risk
                // truncation) — and any element the batch misses still gets its
                // own call below, so quality never depends on the batch landing.
                let batchedSubs = new Map();
                if (elements.length >= 2 && elements.length <= 10) {
                    send({
                        phase: 'generating_sub_elements',
                        message: `Expanding ${elements.length} topics in ${category.title}...`,
                        currentCategory: category.title,
                    });
                    try {
                        const batchPrompt = AI_PROMPTS.generate_sub_elements_batch(
                            name, projectSummary, description || '',
                            category.title, category.description, elements,
                            { lang: creationLang }
                        );
                        const raw = await generateResponse(batchPrompt.user, batchPrompt.system, [], {
                            signal: abortController.signal, temperature: 0.2, top_p: 0.8, operation: 'structure',
                        });
                        batchedSubs = validateSubElementBatch(parseJsonWithRepair(raw), elements);
                    } catch (batchErr) {
                        if (abortController.signal.aborted) throw batchErr;
                        console.log('[AI] Batched sub-elements failed, falling back per topic:', batchErr.message);
                    }
                    // Close the step the client opened above: without it the
                    // batch is logged as started and never as finished, and the
                    // activity log keeps a spinner running for the rest of the
                    // build.
                    send({
                        phase: 'sub_elements_batched',
                        currentCategory: category.title,
                        batched: batchedSubs.size,
                        message: batchedSubs.size > 0
                            ? `${category.title}: ${batchedSubs.size} topics expanded`
                            : `${category.title}: expanding topics one by one`,
                    });
                }

                for (let elIdx = 0; elIdx < elements.length; elIdx++) {
                    if (isCancelled()) throw new Error('Cancelled');

                    const element = elements[elIdx];
                    const elementId = elementIds[elIdx];

                    let subElements = batchedSubs.get(elIdx) || [];
                    if (subElements.length === 0) {
                        send({
                            phase: 'generating_sub_elements',
                            message: `Generating sub-elements for ${element.title}...`,
                            currentElement: element.title,
                            currentCategory: category.title,
                        });

                        const allElementTitles = elements.map(e => e.title).join(', ');
                        subElements = await generateStructure(
                            AI_PROMPTS.generate_sub_elements(name, projectSummary, description || '', category.title, category.description, allElementTitles, element.title, element.description, { lang: creationLang }),
                            validateSubElements,
                            { signal: abortController.signal, minItems: 1 }
                        );
                    }

                    totalSubElements += subElements.length;
                    completedWorkUnits += subElements.length * W_SE;
                    overallProgress = Math.round((completedWorkUnits / totalWorkUnits) * 100);

                    send({
                        phase: 'sub_elements_generated',
                        categoryIndex: catIdx,
                        elementIndex: elIdx,
                        elementTitle: element.title,
                        currentCategory: category.title,
                        currentElement: element.title,
                        subElements: subElements.map((s, i) => ({
                            index: i,
                            title: s.title,
                            description: s.description,
                        })),
                        overallProgress,
                    });

                    const seIds = [];
                    const seTransaction = db.transaction(() => {
                        subElements.forEach((se, idx) => {
                            const result = insertNode.run(
                                projectId, elementId, se.title, se.description,
                                '', 'not_started', 0, idx, creationProvenance
                            );
                            seIds.push(result.lastInsertRowid);
                        });

                        // NOTE: sibling order is captured by `position` and nothing
                        // else. The generator used to also write hard dependency
                        // edges between siblings; those silently locked topics the
                        // learner may already know, which is why both the edges and
                        // the whole dependency layer are gone (2026-09-04).
                    });
                    seTransaction();

                    await new Promise(resolve => setImmediate(resolve));

                    // Phase: Resources
                    //
                    // The most expensive phase by far: a web search plus a
                    // curation call PER leaf, so a 700-leaf curriculum spends
                    // 700 model round trips on links before the learner has
                    // read a word. With `creation_find_resources` off it is
                    // skipped entirely and resources are fetched on demand from
                    // the node itself (POST /api/ai/nodes/:id/find-resources) —
                    // paying the cost only for the topic actually being studied.

                    for (let seIdx = 0; seIdx < subElements.length; seIdx++) {
                        if (isCancelled()) throw new Error('Cancelled');

                        const subElement = subElements[seIdx];
                        const subElementId = seIds[seIdx];

                        if (curateResources) send({
                            phase: 'finding_resources',
                            message: `Finding resources for ${subElement.title}...`,
                            currentSubElement: subElement.title,
                            currentElement: element.title,
                            currentCategory: category.title,
                        });

                        let resources = [];
                        try {
                            if (curateResources) resources = await findResourcesForSubElement(
                                name, category.title, element.title,
                                subElement.title, subElement.description,
                                abortController.signal, projectSummary
                            );
                        } catch (e) {
                            console.log(`[Resources] Failed:`, e.message);
                        }

                        totalResources += resources.length;

                        if (resources.length > 0) {
                            const insertResource = db.prepare(`
                                INSERT INTO resources (node_id, title, url, type, completed, position, generated_by)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                            `);
                            const rTransaction = db.transaction(() => {
                                resources.forEach((r, rIdx) => {
                                    insertResource.run(
                                        subElementId, r.title, r.url, r.type, 0, rIdx, creationProvenance
                                    );
                                });
                            });
                            rTransaction();
                        }

                        completedWorkUnits += resources.length * W_RES;
                        overallProgress = Math.round((completedWorkUnits / totalWorkUnits) * 100);

                        // The client keys its live tree off these coordinates —
                        // without them a leaf never leaves "pending", so the
                        // finished project reported "4 / 94 cards" (only the
                        // phases) no matter how much had really been written.
                        send({
                            phase: 'resources_saved',
                            nodeId: subElementId,
                            nodeTitle: subElement.title,
                            categoryIndex: catIdx,
                            elementIndex: elIdx,
                            subElementIndex: seIdx,
                            currentCategory: category.title,
                            currentElement: element.title,
                            currentSubElement: subElement.title,
                            // With resource hunting off no search ran, so this
                            // event exists only to advance the tree — the client
                            // must not log a "resources checked" row per leaf.
                            curated: curateResources,
                            resourceCount: resources.length,
                            totalResources,
                            overallProgress,
                        });

                        await new Promise(resolve => setImmediate(resolve));
                    }
                }
            }

            // Completion

            db.prepare(
                'UPDATE projects SET description = ?, ai_generating = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            ).run(buildProjectDescription(projectSummary), projectId);

            // A whole curriculum just landed; map it once the writes settle.
            scheduleNodeSync();

            return finish({
                phase: 'complete',
                projectId,
                message: 'Project created successfully!',
                stats: {
                    categories: totalCategories,
                    elements: totalElements,
                    subElements: totalSubElements,
                    resources: totalResources,
                },
            });

        } catch (error) {
            console.error(`[AI Creation] Error:`, error.message);

            const wasCancelled =
                userCancelled || error.name === 'AbortError';

            if (projectId) {
                try {
                    setGeneratingFlag(projectId, false);
                    markProjectAsUnfinished(
                        projectId,
                        wasCancelled
                            ? 'AI creation was cancelled.'
                            : `AI creation failed: ${error.message}`
                    );
                } catch (cleanupError) {
                    console.error('[Cleanup] Failed:', cleanupError);
                }
            }

            if (!wasCancelled) {
                send({ phase: 'error', error: error.message, projectId });
                mirrorTask.fail(error.message);
            }

            return finish();
        }
    })();
});

// Cancel an in-flight AI project creation. With a projectId, stops that one
// run; without one, stops every active run (covers the pre-init window where
// the client doesn't yet know the projectId). Cancellation aborts the Ollama
// request and breaks the generation loop; partial content is preserved and
// ai_generating is cleared by the generation's own error/cleanup path.
app.post('/api/ai/cancel-creation', (req, res) => {
    const { projectId } = req.body || {};

    if (projectId !== undefined && projectId !== null) {
        const gen = activeGenerations.get(Number(projectId));
        if (gen) {
            gen.cancel();
            return res.json({ success: true, projectId: Number(projectId), message: 'Cancellation requested' });
        }
        return res.json({ success: false, projectId: Number(projectId), message: 'No active generation found for that project' });
    }

    if (activeGenerations.size === 0) {
        return res.json({ success: false, projectId: null, message: 'No active generation to cancel' });
    }
    for (const gen of activeGenerations.values()) gen.cancel();
    res.json({ success: true, projectId: null, message: 'All active generations cancelled' });
});

// SEARCH

import { searchAll, quickSuggest } from './search.js';

app.get('/api/search', (req, res) => {
    const { q, projectId, limit } = req.query;
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
        return res.json({ projects: [], nodes: [], resources: [], documents: [] });
    }
    try {
        const results = searchAll(q, {
            projectId: projectId ? Number(projectId) : null,
            limit: limit ? Math.min(Number(limit), 50) : 10,
        });
        res.json(results);
    } catch (err) {
        console.error('[Search] Error:', err.message);
        res.status(500).json({ error: 'Search failed', detail: err.message });
    }
});

app.get('/api/search/suggest', (req, res) => {
    const { q, projectId, limit } = req.query;
    if (!q || typeof q !== 'string' || q.trim().length < 1) {
        return res.json([]);
    }
    try {
        const results = quickSuggest(
            q,
            projectId ? Number(projectId) : null,
            limit ? Math.min(Number(limit), 20) : 8
        );
        res.json(results);
    } catch (err) {
        console.error('[Search/Suggest] Error:', err.message);
        res.status(500).json({ error: 'Suggest failed', detail: err.message });
    }
});

// DOCUMENTS

app.post('/api/documents', (req, res) => {
    const { nodeId, projectId, title, content, fileType = 'text' } = req.body;
    const result = db.prepare('INSERT INTO documents (node_id, project_id, title, content, file_type) VALUES (?, ?, ?, ?, ?)')
        .run(nodeId || null, projectId || null, title, content, fileType);
    const docId = result.lastInsertRowid;
    const chunks = chunkText(content);
    const insertChunk = db.prepare('INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, ?, ?)');
    const transaction = db.transaction(() => {
        chunks.forEach((chunk, index) => {
            insertChunk.run(docId, index, chunk);
        });
    });
    transaction();
    indexDocument(docId); // background semantic indexing (no-op if embeddings off)
    res.json({ id: docId, chunks: chunks.length });
});

// Upload one or more original files into a project/node vault. Each file is
// type-validated (magic bytes), text-extracted, its original stored in the
// content-addressed blob store, and indexed for RAG. A file that fails to parse
// is recorded with status='failed' + error so the user sees why — it never
// aborts the batch or crashes the server.
const handleVaultUpload = (req, res, next) =>
    // 256 MB aggregate: 100 × 25 MB is the per-file shape, but a batch that
    // size buffered in memory at once is not a shape anything wants.
    rejectOversizedBody(256 * 1024 * 1024)(req, res, () =>
        vaultUpload.array('files')(req, res, (err) => {
            if (err) {
                const msg = err.code === 'LIMIT_FILE_SIZE'
                    ? `File exceeds the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit`
                    : err.code === 'LIMIT_FILE_COUNT'
                        ? 'Too many files in one upload (max 100) — please upload in smaller batches'
                        : err.message || 'Upload failed';
                return res.status(400).json({ error: msg });
            }
            next();
        }));

app.post('/api/documents/upload', handleVaultUpload, async (req, res) => {
    const projectId = req.body.projectId ? Number(req.body.projectId) : null;
    const nodeId = req.body.nodeId ? Number(req.body.nodeId) : null;
    if (!projectId && !nodeId) return res.status(400).json({ error: 'projectId or nodeId is required' });

    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const results = [];
    for (const file of files) {
        const title = (file.originalname || 'file').slice(0, 500);
        try {
            // Extraction also validates the type (throws on disallowed/mismatched).
            const { text, kind, meta } = await extractText(file.buffer, file.originalname);
            const { hash, size } = vaultStorage.put(file.buffer);
            const persist = db.transaction(() => {
                const r = db.prepare(`INSERT INTO documents
                    (node_id, project_id, title, content, file_type, original_filename, file_hash, file_size, status, page_count)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`)
                    .run(nodeId, projectId, title, text, kind, file.originalname, hash, size, meta.pageCount ?? null);
                const docId = r.lastInsertRowid;
                const chunks = chunkText(text);
                const insertChunk = db.prepare('INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, ?, ?)');
                chunks.forEach((c, i) => insertChunk.run(docId, i, c));
                return { docId, chunkCount: chunks.length };
            });
            const { docId, chunkCount } = persist();
            indexDocument(docId); // background semantic indexing (serialized; no-op if embeddings off)
            // PDFs may have dropped their math at the text layer (subsetted fonts
            // with no ToUnicode) — queue a background pass that re-reads degraded
            // pages from the render (vision → OCR). No-op for clean PDFs and if
            // recovery is switched off. See server/pdfRecovery.js.
            if (kind === 'pdf') queueRecovery(docId);
            results.push({ ok: true, id: docId, title, file_type: kind, file_hash: hash, file_size: size, page_count: meta.pageCount ?? null, status: 'ready', chunks: chunkCount });
        } catch (err) {
            const r = db.prepare(`INSERT INTO documents
                (node_id, project_id, title, content, file_type, original_filename, status, error)
                VALUES (?, ?, ?, '', 'unknown', ?, 'failed', ?)`)
                .run(nodeId, projectId, title, file.originalname, String(err.message || 'Extraction failed').slice(0, 500));
            results.push({ ok: false, id: r.lastInsertRowid, title, status: 'failed', error: err.message || 'Extraction failed' });
        }
    }
    res.json({ documents: results });
});

app.get('/api/documents', (req, res) => {
    const { nodeId, projectId } = req.query;
    // char_count exposes how much text was extracted per file (shown in the vault
    // list, e.g. "12,340 chars"). LENGTH() counts characters on a TEXT column.
    let sql = `SELECT id, node_id, project_id, title, file_type, original_filename,
                      file_hash, file_size, status, error, page_count, embedding_status,
                      recovery_status, recovery_meta, created_at,
                      LENGTH(content) as char_count
               FROM documents`;
    const params = [];
    // Passing both scopes returns node-or-project docs (matches RAG retrieval, so
    // the tutor's "Use docs (N)" count includes the project vault); a single scope
    // filters to just that level.
    if (nodeId && projectId) { sql += ' WHERE (node_id = ? OR project_id = ?)'; params.push(nodeId, projectId); }
    else if (nodeId) { sql += ' WHERE node_id = ?'; params.push(nodeId); }
    else if (projectId) { sql += ' WHERE project_id = ?'; params.push(projectId); }
    sql += ' ORDER BY created_at DESC';
    const documents = db.prepare(sql).all(...params);
    res.json(documents);
});

// Return the full extracted text of one document, for the "view extracted text"
// preview in the vault. Capped so a huge file can't blow up the response.
app.get('/api/documents/:id/text', (req, res) => {
    const doc = db.prepare('SELECT title, content, status, error FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json({
        title: doc.title,
        status: doc.status,
        error: doc.error,
        char_count: doc.content ? doc.content.length : 0,
        content: doc.content || '',
    });
});

// Re-run math recovery for one PDF. Used after the user connects a vision model
// (recovery doesn't self-heal — a doc that fell back to OCR, or ran with no
// vision model, won't retry on its own). `force` bypasses the settings gate and
// the "already recovered" guard so this always re-reads the original.
app.post('/api/documents/:id/recover', (req, res) => {
    const doc = db.prepare('SELECT id, file_type, file_hash, status FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.file_type !== 'pdf') return res.status(400).json({ error: 'Math recovery only applies to PDFs' });
    if (!doc.file_hash) return res.status(400).json({ error: 'No original stored for this document' });
    // Same eligibility the vault UI applies: a doc whose extraction failed has no
    // text layer to improve on — re-upload is the fix, not recovery.
    if (doc.status === 'failed') return res.status(400).json({ error: 'Document extraction failed — re-upload it instead' });
    db.prepare('UPDATE documents SET recovery_status = ? WHERE id = ?').run('pending', doc.id);
    queueRecovery(doc.id, { force: true });
    res.json({ ok: true, recovery_status: 'pending' });
});

// Stream the stored original for "open original". Served inline so PDFs/images
// open in the browser; falls back to download for office formats.
app.get('/api/documents/:id/original', (req, res) => {
    const doc = db.prepare('SELECT title, file_type, file_hash, original_filename FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!doc.file_hash) return res.status(404).json({ error: 'No original stored for this document (text-only)' });
    let filePath;
    try {
        filePath = vaultStorage.pathFor(doc.file_hash);
    } catch {
        return res.status(404).json({ error: 'Original file is missing from the vault' });
    }
    // The same header trap as /api/media: a vault original stored under a
    // non-Latin-1 filename would have thrown here too.
    const inline = doc.file_type === 'pdf' || doc.file_type === 'text' || IMAGE_KINDS.includes(doc.file_type);
    res.setHeader('Content-Type', MIME_BY_KIND[doc.file_type] || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(doc.original_filename || doc.title, { inline }));
    fs.createReadStream(filePath).on('error', () => { if (!res.headersSent) res.status(500).end(); }).pipe(res);
});

app.delete('/api/documents/:id', (req, res) => {
    const doc = db.prepare('SELECT id, file_hash FROM documents WHERE id = ?').get(req.params.id);
    const docs = doc ? [doc] : [];
    const chunkIds = documentChunkIds(docs);

    db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);

    freeDocumentAssets(docs, chunkIds);
    res.json({ success: true });
});

app.post('/api/documents/search', wrap(async (req, res) => {
    const { query, nodeId, projectId, limit = 5 } = req.body;
    const results = await searchDocuments(query, nodeId, projectId, limit);
    res.json(results);
}));

// EMBEDDINGS / SEMANTIC SEARCH (Vault)

// Config + index stats + a live probe of whether an embedding model answers.
// Powers the Settings → "Semantic search" panel; the probe is cached server-side.
app.get('/api/embeddings/status', async (req, res) => {
    try {
        const config = getEmbeddingConfig();
        const stats = embeddingStats();
        const probe = req.query.probe === 'false' ? null : await probeEmbedding({ force: req.query.force === 'true' });
        res.json({ config, stats, probe });
    } catch (err) {
        console.error('[Embeddings/status] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Toggle the feature on/off, set the embedding model name, and pick which
// provider serves embeddings ('auto' = follow the chat provider).
app.post('/api/embeddings/settings', (req, res) => {
    const { enabled, model, provider } = req.body || {};
    setEmbeddingSettings({ enabled, model, provider });
    res.json({ config: getEmbeddingConfig() });
});

// Re-embed every ready document (after enabling the feature or switching model).
app.post('/api/embeddings/reindex', (req, res) => {
    if (!getEmbeddingConfig().vecAvailable)
        return res.status(400).json({ error: 'sqlite-vec extension is not loaded — semantic search is unavailable on this build.' });
    res.json(reindexAll());
});

// TOPIC EMBEDDINGS (the curriculum itself, not the vault)

// How much of the curriculum is mapped into the shared topic space. Same shape
// of answer as /api/embeddings/status, minus the probe — one embedding model
// serves both, so probing twice would just swap a llama-swap model for nothing.
app.get('/api/node-embeddings/status', (req, res) => {
    try {
        res.json({ config: getEmbeddingConfig(), stats: nodeEmbeddingStats() });
    } catch (err) {
        console.error('[NodeEmbeddings/status] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/node-embeddings/reindex', (req, res) => {
    if (!getEmbeddingConfig().vecAvailable)
        return res.status(400).json({ error: 'sqlite-vec extension is not loaded — semantic search is unavailable on this build.' });
    invalidateAtlas();   // every vector is about to be rewritten
    res.json(reindexAllNodes());
});

// ATLAS — the library as one space (server/atlas.js)

// Never 500s on a missing topic space: an unmapped library is a legitimate
// state (no embedding model), and the client renders `available:false` with
// `reason` as an explanation rather than an error.
app.get('/api/atlas', async (req, res) => {
    try {
        const raw = Number(req.query.similarity);
        const atlas = await buildAtlas({
            regionSimilarity: Number.isFinite(raw) ? Math.max(0.5, Math.min(0.95, raw)) : undefined,
            includeArchived: req.query.archived === 'true',
            refresh: req.query.refresh === 'true',
        });
        // Attached per request rather than baked into the cached atlas: the
        // naming sweep runs behind the map, so this is the one part of the
        // answer that is stale the moment it is cached.
        res.json({ ...atlas, naming: regionNameStats() });
    } catch (err) {
        console.error('[Atlas] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Name a region by hand.
//
// The map names regions after their most central topic, and a model rewrites
// that where it can — but both are guesses about someone else's library, and
// the learner is the one person who knows what a place on it is called. One
// edit settles what no amount of prompt tuning can, so it exists.
//
// Addressed by SIGNATURE, not by index: a region has no id of its own (it is
// derived, and renumbered on every rebuild), while its member set is exactly
// what identifies it across builds — the same key the name cache uses.
app.put('/api/atlas/regions/:signature/name', (req, res) => {
    try {
        const signature = String(req.params.signature || '');
        if (!/^[0-9a-f]{64}$/.test(signature)) return res.status(400).json({ error: 'Not a region signature.' });
        const verdict = validateUserName(req.body?.label);
        if (!verdict.ok) {
            return res.status(400).json({
                error: verdict.reason === 'empty' ? 'A region needs a name.'
                    : verdict.reason === 'too-long' ? 'That name is too long for the map.'
                        : 'A region name is plain text.',
            });
        }
        setRegionName(signature, verdict.label, Number(req.body?.size) || null);
        // The atlas is cached against the topic space, which a rename does not
        // touch — without this the learner's own name would not appear until
        // something else forced a rebuild.
        invalidateAtlas();
        res.json({ label: verdict.label, labelSource: 'user' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Hand a region back to the map: the medoid now, a fresh model name later.
app.delete('/api/atlas/regions/:signature/name', (req, res) => {
    try {
        const signature = String(req.params.signature || '');
        if (!/^[0-9a-f]{64}$/.test(signature)) return res.status(400).json({ error: 'Not a region signature.' });
        clearRegionName(signature);
        invalidateAtlas();
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Topics that mean roughly the same thing as this one. An empty list is a
// legitimate answer (nothing similar, or no embedding model) — never an error,
// because every consumer treats neighbours as an enhancement.
app.get('/api/nodes/:id/similar', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
        const min = req.query.min !== undefined ? Number(req.query.min) : MIN_SIMILARITY;
        const results = await similarNodes(Number(req.params.id), {
            limit,
            minSimilarity: Number.isFinite(min) ? Math.max(0, Math.min(1, min)) : MIN_SIMILARITY,
            crossProjectOnly: req.query.crossProject === 'true',
            masteredOnly: req.query.mastered === 'true',
            threshold: getGateConfig().threshold,
        });
        res.json({ results });
    } catch (err) {
        console.error('[NodeEmbeddings/similar] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Has this topic already been proven elsewhere? Returns the stored head start
// when the sweep has already found one, and otherwise computes it live — the
// detail panel is opened on one node at a time, so a single KNN (and, for a
// node that isn't mapped yet, a single embedding call) is the right cost.
app.get('/api/nodes/:id/transfer', async (req, res) => {
    try {
        const nodeId = Number(req.params.id);
        const stored = getTransferInfo(nodeId);
        if (stored) return res.json({ transfer: stored });

        const gate = getGateConfig();
        // Persist it if the node is eligible, so the feed sees it without
        // waiting for the next sweep; fall back to a preview when it isn't.
        const applied = await applyTransfer(nodeId, { threshold: gate.threshold, decayDays: gate.decayDays });
        if (applied.applied) return res.json({ transfer: getTransferInfo(nodeId) });

        const preview = await computeTransfer(nodeId, { threshold: gate.threshold, decayDays: gate.decayDays });
        res.json({ transfer: preview.sources.length ? { ...preview, spent: true, at: null } : null });
    } catch (err) {
        console.error('[Transfer] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Free-text search over topics ("where have I studied convolution?").
app.get('/api/nodes/search-semantic', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
        const results = await searchNodesSemantic(String(req.query.q || ''), {
            limit,
            projectId: req.query.projectId ? Number(req.query.projectId) : null,
        });
        res.json({ results });
    } catch (err) {
        console.error('[NodeEmbeddings/search] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// SESSIONS

app.post('/api/sessions', (req, res) => {
    const { projectId, nodeId, activityType, durationSeconds, metadata } = req.body;
    const result = db.prepare('INSERT INTO learning_sessions (project_id, node_id, activity_type, duration_seconds, metadata) VALUES (?, ?, ?, ?, ?)')
        .run(projectId, nodeId || null, activityType, durationSeconds || 0, metadata ? JSON.stringify(metadata) : null);
    res.json({ id: result.lastInsertRowid });
});

// IMPORT / EXPORT

/**
 * A topic's graded questions, in the shape the importer reads back.
 *
 * Always exported, like `description` and unlike `notes` — a question is
 * authored course content, not learner data, and a "course" file that loses
 * the practice on the way out is the same hole the import side had. What stays
 * behind is the learner's own record: `quiz_attempts` never travel.
 *
 * Several quizzes on one topic flatten into one array, because that is what
 * comes back: the importer writes a topic's questions as ONE quiz. A round
 * trip therefore merges two same-topic quizzes into one, which is a change to
 * the filing and not to a single question.
 */
const exportedQuestions = (nodeId) => {
    const rows = db.prepare('SELECT questions FROM quizzes WHERE node_id = ? ORDER BY id').all(nodeId);
    const out = [];
    for (const row of rows) {
        try {
            const parsed = JSON.parse(row.questions);
            if (Array.isArray(parsed)) out.push(...parsed);
        } catch { /* a quiz whose JSON no longer parses is not exportable; the rest are */ }
    }
    return out.length ? out : undefined;
};

app.get('/api/export/:projectId', (req, res) => {
    const { includeNotes, includeResources, includeProgress } = req.query;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const allNodes = db.prepare('SELECT * FROM nodes WHERE project_id = ? ORDER BY position').all(req.params.projectId);
    const buildExportTree = (parentId) => {
        return allNodes
            .filter(n => n.parent_id === parentId)
            .map(n => {
                const node = {
                    title: n.title,
                    uuid: n.uuid || undefined,
                    description: n.description || undefined,
                    notes: includeNotes === 'true' && n.notes ? n.notes : undefined,
                    status: includeProgress === 'true' ? n.status : undefined,
                    is_note: n.is_note ? true : undefined,
                    questions: exportedQuestions(n.id),
                };
                if (includeResources === 'true') {
                    const resources = db.prepare('SELECT uuid, title, url, type, completed FROM resources WHERE node_id = ? ORDER BY position').all(n.id);
                    if (resources.length > 0) {
                        node.resources = resources.map(r => {
                            const resource = { title: r.title };
                            if (r.uuid) resource.uuid = r.uuid;
                            if (r.url) resource.url = r.url;
                            if (r.type && r.type !== 'link') resource.type = r.type;
                            if (includeProgress === 'true' && r.completed) resource.completed = true;
                            return resource;
                        });
                    }
                }
                const children = buildExportTree(n.id);
                if (children.length > 0) node.children = children;
                Object.keys(node).forEach(key => { if (node[key] === undefined) delete node[key]; });
                return node;
            });
    };
    // No top-level `version`. It read "2.0" for years, nothing ever parsed it,
    // and there was never a v1 to branch on — a format version that no reader
    // consults is decoration that invites people to bump it. If the container
    // ever does change incompatibly, the *absence* of a marker is the signal
    // that a file is one of these, and a marker can be added then, by a reader
    // that actually exists.
    res.json({
        exported_at: new Date().toISOString(),
        // uuid and content_language travel with the curriculum. The language,
        // because a shared Dutch course that imports as "follow the material"
        // has its lessons authored in whatever the importer's model guesses from
        // the titles. The uuid, because it is the only thing that makes "is this
        // the course I already have, or a different one?" answerable at all —
        // and `version` is the author's answer to "which edition?".
        project: {
            name: project.name,
            uuid: project.uuid || undefined,
            version: project.version || undefined,
            description: project.description || undefined,
            color: project.color,
            icon: project.icon,
            content_language: project.content_language || undefined,
        },
        nodes: buildExportTree(null)
    });
});

/**
 * A supplied uuid is honoured only if it is free.
 *
 * The point of exporting uuids is that identity survives the trip between
 * machines — but the column is UNIQUE, so importing the same course twice would
 * otherwise abort the second import inside the transaction. Free = keep it (the
 * rows really are the same rows, on a new machine); taken = pass NULL and let
 * database.js's AFTER INSERT trigger mint a fresh one, because a second copy on
 * the SAME machine is a genuinely different project row.
 */
const claimUuid = (table, uuid) => {
    if (!uuid) return null;
    const taken = db.prepare(`SELECT 1 FROM ${table} WHERE uuid = ?`).get(uuid);
    return taken ? null : uuid;
};

/**
 * What `normalizeImportTree` needs before it will accept a node's `questions`.
 *
 * `curriculumSchema.js` is a no-import module on purpose — `tools/import-gates.mjs`
 * applies its rules without opening a database — and all three of these reach
 * `database.js`, so they are handed in rather than imported there. One object,
 * both import doors: a course must not be vetted differently depending on
 * whether it arrived as bare JSON or inside a bundle.
 */
const IMPORT_QUESTION_DEPS = { normalizeQuestionFormat, questionDefects, sanitizeQuestionMedia };

/**
 * Insert a tree that `normalizeImportTree` has already cleaned. Shared by both
 * import paths so a course cannot be treated differently depending on whether it
 * arrived as bare JSON or inside a bundle.
 *
 * @param {(node: object, newNodeId: number, path: string[]) => void} [onNode]
 *   The bundle importer uses this to build its title-path → id map for
 *   re-linking documents.
 */
function insertImportedTree(newProjectId, nodes, onNode) {
    const insertNode = db.prepare(`
        INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position, uuid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertResource = db.prepare(`
        INSERT INTO resources (node_id, title, url, type, completed, position, uuid)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // `generated_by` stays NULL: no model this app called wrote these. That
    // column means "which of OUR calls produced this row", and backfilling it
    // with the importer's name would make a hand-authored course indexable as
    // AI-written for the rest of its life.
    const insertQuiz = db.prepare(`
        INSERT INTO quizzes (node_id, title, questions, generated_by) VALUES (?, ?, ?, NULL)
    `);

    const walk = (node, parentId, position, parentPath) => {
        const path = [...parentPath, node.title];
        const result = insertNode.run(
            newProjectId, parentId, node.title, node.description, node.notes,
            node.status, node.is_note, position, claimUuid('nodes', node.uuid),
        );
        const newNodeId = result.lastInsertRowid;
        if (onNode) onNode(node, newNodeId, path);

        node.resources.forEach((resource, idx) => {
            insertResource.run(newNodeId, resource.title, resource.url, resource.type,
                resource.completed, idx, claimUuid('resources', resource.uuid));
        });
        // The topic's practice, as ONE saved quiz. One row rather than one per
        // question because that is what a quiz already is here — the set the
        // Boss Fight reuses and the Tests tab lists — and because the feed
        // reaches a saved quiz's questions one at a time anyway. An author who
        // wants two sets writes two topics, which is a decision about the
        // course, not about the file format.
        if (node.questions.length) {
            insertQuiz.run(newNodeId, node.title, JSON.stringify(node.questions));
        }
        node.children.forEach((child, idx) => walk(child, newNodeId, idx, path));
    };

    nodes.forEach((node, idx) => walk(node, null, idx, []));
}

app.post('/api/import', (req, res) => {
    let normalized;
    try {
        const header = normalizeImportProject(req.body?.project, { isSupportedLanguage });
        const tree = normalizeImportTree(req.body?.nodes, IMPORT_QUESTION_DEPS);
        normalized = {
            project: header.project, nodes: tree.nodes, questionCount: tree.questionCount,
            warnings: [...header.warnings, ...tree.warnings],
        };
    } catch (err) {
        if (err instanceof ImportError) return res.status(400).json({ error: err.message });
        throw err;
    }

    const { project, nodes, questionCount, warnings } = normalized;

    // Importing always creates a NEW project — merging an updated edition into a
    // curriculum the learner has already made progress against is a different
    // feature, and doing it implicitly would be the wrong default. But staying
    // silent about it means quietly ending up with two copies of the same
    // course, so it is reported.
    const twin = project.uuid ? db.prepare('SELECT id, name, version FROM projects WHERE uuid = ?').get(project.uuid) : null;
    if (twin) {
        const editions = project.version && twin.version && project.version !== twin.version
            ? ` (you have ${twin.version}, this file is ${project.version})`
            : '';
        warnings.push(`You already have this course as "${twin.name}"${editions} — it was imported as a separate copy.`);
    }

    const transaction = db.transaction(() => {
        const projectResult = db.prepare(`
            INSERT INTO projects (name, description, color, icon, position, content_language, version, uuid)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(project.name, project.description, project.color, project.icon, nextProjectPosition(),
            project.content_language, project.version, claimUuid('projects', project.uuid));
        const newProjectId = projectResult.lastInsertRowid;
        insertImportedTree(newProjectId, nodes);
        return newProjectId;
    });

    try {
        const newProjectId = transaction();
        const newProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(newProjectId);
        console.log(`Successfully imported project "${newProject.name}" with id ${newProjectId}${questionCount ? ` (${questionCount} question(s))` : ''}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
        scheduleNodeSync();   // map the imported curriculum into the topic space
        // Counts only, never the thing counted: `activity-log-gates.mjs` scans
        // every call site below for the vocabulary a learner's own words would
        // arrive in, and it is right to — this log is meant to be handable to a
        // stranger.
        logActivity({
            area: 'project',
            event: 'project.imported',
            projectId: newProjectId,
            level: warnings.length ? 'warn' : 'info',
            detail: `curriculum · ${questionCount} graded item(s) · ${warnings.length} warning(s)`,
        });
        res.json({ ...newProject, questionCount, warnings });
    } catch (err) {
        console.error('Import error:', err);
        res.status(400).json({ error: `Database error: ${err.message}` });
    }
});

// --- Authoring with an external model ------------------------------------
//
// Two prompts and one merge. The reasoning for the split is in
// `authoringBrief.js`; what matters here is that pass two lands on a project
// that already exists, which `POST /api/import` deliberately never does.
//
// Nothing on these routes calls a model. The learner runs the prompt in
// whatever chat they already pay for (or don't) and brings the reply back — so
// the privacy cost is paid in that chat, and the app stays local.

/** The outline prompt, with the learner's brief filled in. */
app.post('/api/authoring/outline-brief', (req, res) => {
    res.json({ prompt: buildOutlineBrief(req.body || {}) });
});

/**
 * A project's phases, with the leaf count and how much of each is already
 * written. This is what makes "deepen phase 3 next month" answerable without
 * the learner keeping track themselves.
 */
app.get('/api/projects/:projectId/authoring/phases', (req, res) => {
    const projectId = Number(req.params.projectId);
    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const phases = db.prepare(`
        SELECT id, title FROM nodes
        WHERE project_id = ? AND parent_id IS NULL AND is_note = 0
        ORDER BY position, id
    `).all(projectId);

    // A phase's leaves are the leaves of its whole subtree, so the recursion
    // has to run per phase rather than one level down.
    const subtree = db.prepare(`
        WITH RECURSIVE sub(id) AS (
            SELECT ? UNION ALL
            SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
        )
        SELECT n.id, n.title,
               EXISTS(SELECT 1 FROM nodes m WHERE m.parent_id = n.id AND m.is_note = 1) AS hasNotes,
               length(COALESCE(n.description, '')) AS descriptionLength
        FROM nodes n WHERE n.id IN (SELECT id FROM sub) AND ${WORK_LEAF}
        ORDER BY n.position, n.id
    `);

    res.json({
        project,
        phases: phases.map(phase => {
            const leaves = subtree.all(phase.id);
            return {
                id: phase.id,
                title: phase.title,
                leaves: leaves.length,
                withMaterial: leaves.filter(l => leafHasMaterial(l)).length,
            };
        }),
    });
});

/** The material prompt for one phase, carrying that phase's exact leaf titles. */
app.get('/api/projects/:projectId/authoring/material-brief', (req, res) => {
    const projectId = Number(req.params.projectId);
    const project = db.prepare('SELECT id, name, description, content_language FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const phaseId = Number(req.query.phaseId);
    const phase = phaseId
        ? db.prepare('SELECT id, title FROM nodes WHERE id = ? AND project_id = ?').get(phaseId, projectId)
        : null;
    if (phaseId && !phase) return res.status(404).json({ error: 'Phase not found in this project' });

    // "Unwritten" = no attached reading AND an Overview still the length of a
    // signpost (MATERIAL_MIN_CHARS): pass two writes into the Overview.
    const rows = phase
        ? db.prepare(`
            WITH RECURSIVE sub(id) AS (
                SELECT ? UNION ALL
                SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
            )
            SELECT n.id, n.title FROM nodes n
            WHERE n.id IN (SELECT id FROM sub) AND ${WORK_LEAF}
              AND NOT EXISTS(SELECT 1 FROM nodes m WHERE m.parent_id = n.id AND m.is_note = 1)
              AND length(COALESCE(n.description, '')) < ${MATERIAL_MIN_CHARS}
            ORDER BY n.position, n.id
        `).all(phase.id)
        : db.prepare(`
            SELECT n.id, n.title FROM nodes n
            WHERE n.project_id = ? AND ${WORK_LEAF}
              AND NOT EXISTS(SELECT 1 FROM nodes m WHERE m.parent_id = n.id AND m.is_note = 1)
              AND length(COALESCE(n.description, '')) < ${MATERIAL_MIN_CHARS}
            ORDER BY n.position, n.id
        `).all(projectId);

    res.json({
        prompt: buildMaterialBrief({
            project,
            phaseTitle: phase ? phase.title : '',
            leaves: rows.map(r => r.title),
        }),
        phase: phase || null,
        leaves: rows.length,
    });
});

/**
 * Merge one pass-two reply into the project.
 *
 * Writes each matched leaf's reading into its Overview (`overview`) and, for
 * the rare separable extra, adds `is_note` children (`material`). Nothing
 * else changes — no renames, no reordering, no scheduling, no status. A topic
 * that already has material (an attached reading, or an Overview past
 * MATERIAL_MIN_CHARS) is REPORTED and skipped unless `replace` is set: this
 * endpoint is meant to be run several times against the same project, so the
 * safe outcome for a repeated file is that it does nothing twice.
 */
app.post('/api/projects/:projectId/authoring/material', (req, res) => {
    const projectId = Number(req.params.projectId);
    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let payload;
    try {
        payload = normalizeMaterialPayload(req.body);
    } catch (err) {
        if (err instanceof ImportError) return res.status(400).json({ error: err.message });
        throw err;
    }

    const courseLeaves = db.prepare(`
        SELECT n.id, n.title,
               EXISTS(SELECT 1 FROM nodes m WHERE m.parent_id = n.id AND m.is_note = 1) AS hasNotes,
               length(COALESCE(n.description, '')) AS descriptionLength
        FROM nodes n WHERE n.project_id = ? AND ${WORK_LEAF}
        ORDER BY n.position, n.id
    `).all(projectId).map(r => ({ id: r.id, title: r.title, hasMaterial: leafHasMaterial(r) }));

    const replace = req.body?.replace === true;
    const { matches, unmatched } = matchMaterialToLeaves(payload.leaves, courseLeaves, { replace });

    if (!matches.length) {
        return res.status(400).json({
            error: 'None of the topics in this file matched a topic in this project.',
            unmatched,
            warnings: payload.warnings,
        });
    }

    const insertNode = db.prepare(`
        INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position)
        VALUES (?, ?, ?, ?, '', 'not_started', 1, ?)
    `);
    const dropMaterial = db.prepare('DELETE FROM nodes WHERE parent_id = ? AND is_note = 1');
    const writeOverview = db.prepare('UPDATE nodes SET description = ? WHERE id = ?');
    const nextPosition = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM nodes WHERE parent_id = ?');

    let added = 0;
    const transaction = db.transaction(() => {
        for (const match of matches) {
            if (replace && match.replacing) dropMaterial.run(match.nodeId);
            if (match.overview) {
                writeOverview.run(match.overview, match.nodeId);
                added++;
            }
            let position = nextPosition.get(match.nodeId).pos;
            for (const item of match.material) {
                insertNode.run(projectId, match.nodeId, item.title, item.description, position++);
                added++;
            }
        }
    });
    transaction();

    // A note is material, not structure, so no leaf became a non-leaf and no
    // count moved — but the topic space keys on description text, and these
    // nodes are new rows.
    scheduleNodeSync();

    res.json({
        added,
        topics: matches.map(m => ({ title: m.title, overview: !!m.overview, readings: m.material.length, replaced: m.replacing })),
        unmatched,
        warnings: payload.warnings,
    });
});

// --- Anki import (.apkg) --------------------------------------------------
//
// Two phases on purpose. `inspect` parses and reports; `commit` writes. Nothing
// touches the library until the learner has SEEN what the import will produce —
// which is the only way the one mistake this can make (a reversed front/back)
// gets caught before it becomes two thousand backwards cards.
//
// The upload is held only long enough to parse. What is staged afterwards is the
// extracted TEXT, never the zip, so a 300 MB deck full of audio does not sit in
// memory while somebody reads a preview.
const ankiUpload = multer({
    storage: multer.memoryStorage(),
    // Big enough for a real collection with media; media is not imported, but it
    // is inside the file we have to unzip to reach the collection.
    limits: { fileSize: 500 * 1024 * 1024 },
});

// --- card media -----------------------------------------------------------
//
// Everything a card can show, served from the local blob store by the SHA-256
// of its own bytes. Three properties fall out of that and all three matter:
//
//   * the URL cannot address anything the database does not already know about
//     — the hash is looked up in `media_files` first, so a path can never be
//     crafted (the store validates the hex shape too, but a serving endpoint
//     should not be the only thing standing between a URL and the disk);
//   * the content type comes from the row, which was decided by SNIFFING the
//     bytes at import (`sniffMediaType`), never from the filename — an `.mp3`
//     that is really HTML must not be served as anything a browser will run;
//   * the bytes at a hash never change, so the response is immutable and the
//     browser stops asking. A deck with 4,000 clips is unusable otherwise.
//
// `Content-Disposition: inline` with a `nosniff` header keeps the browser from
// second-guessing the type on a file that came out of an untrusted zip.
const MEDIA_HASH_RE = /^[a-f0-9]{64}$/;

/**
 * A `Content-Disposition` value that survives a filename in any script.
 *
 * HTTP header values are Latin-1. A Japanese deck's clip is called
 * `早い_ハヤ＼イ_2_NHK-2016.mp3`, and putting that straight into the header
 * throws — so the first Japanese card served returned a 500 where an English
 * one worked, which is [[content-language-and-gates]] in a new place: the code
 * path was never wrong for ASCII, so nothing but a non-Latin deck could find it.
 *
 * RFC 5987 is the fix and it needs BOTH halves: an ASCII `filename` any client
 * can read, and `filename*` carrying the real name percent-encoded as UTF-8.
 */
function contentDisposition(name, { inline = true } = {}) {
    const raw = String(name || 'file');
    const ascii = raw.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
    return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

app.get('/api/media/:hash', (req, res) => {
    const hash = String(req.params.hash || '').replace(/\.[a-z0-9]+$/i, '');
    if (!MEDIA_HASH_RE.test(hash)) return res.status(400).json({ error: 'Bad media id' });

    // The registry first, then any live staging record — an import that has been
    // inspected but not committed has its bytes on disk and no row yet, and the
    // preview screen is exactly the moment those bytes need serving.
    const row = db.prepare('SELECT mime, kind, filename FROM media_files WHERE hash = ? LIMIT 1').get(hash)
        || findStagedMedia(hash);
    if (!row) return res.status(404).json({ error: 'No such media' });

    let filePath;
    try {
        filePath = mediaStorage.pathFor(hash);
    } catch {
        // The row survived and the bytes did not — the one state the orphan
        // sweep cannot produce, and worth saying plainly rather than 500ing.
        return res.status(404).json({ error: 'That file is missing from the media store.' });
    }
    res.setHeader('Content-Type', row.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Disposition', contentDisposition(row.filename || hash));
    fs.createReadStream(filePath)
        .on('error', () => { if (!res.headersSent) res.status(500).end(); })
        .pipe(res);
});

/** What is known ABOUT a file — the description the tutor and a screen reader read. */
app.get('/api/media/:hash/info', (req, res) => {
    const hash = String(req.params.hash || '');
    if (!MEDIA_HASH_RE.test(hash)) return res.status(400).json({ error: 'Bad media id' });
    const row = db.prepare(
        'SELECT hash, filename, mime, kind, size, description, described_by, project_id FROM media_files WHERE hash = ? LIMIT 1'
    ).get(hash);
    if (!row) return res.status(404).json({ error: 'No such media' });
    res.json(row);
});

// --- describing pictures --------------------------------------------------
//
// A card whose question is a photograph reads to the tutor as an empty card, and
// to a screen reader as a filename. One description fixes both, so it is stored
// on the file rather than generated per prompt. See server/mediaDescribe.js.

app.get('/api/media-descriptions/status', (req, res) => {
    const projectId = req.query.projectId ? Number(req.query.projectId) : null;
    res.json({ ...describeStats(projectId), ...describeProgress() });
});

app.post('/api/media/:hash/describe', wrap(async (req, res) => {
    const hash = String(req.params.hash || '');
    if (!MEDIA_HASH_RE.test(hash)) return res.status(400).json({ error: 'Bad media id' });
    const { use, model } = await decidePaperVision();
    if (use !== 'yes') {
        return res.status(503).json({ error: 'No verified vision model is available — set one in Settings → AI & Models.' });
    }
    const result = await describeMedia(hash, { force: !!req.body?.force, model });
    if (!result.ok) return res.status(422).json({ error: result.reason });
    res.json(result);
}));

app.post('/api/media-descriptions/run', wrap(async (req, res) => {
    const projectId = req.body?.projectId ? Number(req.body.projectId) : null;
    res.json(await startDescribeSweep(projectId));
}));

app.post('/api/media-descriptions/cancel', (req, res) => {
    cancelDescribeSweep();
    res.json({ ok: true });
});

app.post('/api/import/anki/inspect', rejectOversizedBody(512 * 1024 * 1024), ankiUpload.single('deck'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
    try {
        const parsed = await parseApkg(req.file.buffer, {
            importMedia: req.body?.importMedia !== 'false',
        });
        if (parsed.stats.cards === 0) {
            // An honest dead end rather than an empty project: say what was found
            // and why none of it could become a card.
            return res.status(400).json({
                error: parsed.stats.notes === 0
                    ? 'This deck is empty — it contains no notes.'
                    : `None of the ${parsed.stats.notes} notes in this deck could become a flashcard.`,
                stats: parsed.stats,
                warnings: parsed.warnings,
            });
        }
        const stagingId = stageImport(parsed);
        res.json({ stagingId, ...buildPreview(parsed) });
    } catch (err) {
        console.error('[Anki] inspect failed:', err);
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/import/anki/commit', (req, res) => {
    const { stagingId, projectName, swapFrontBack, keepSchedule, color, includeMedia } = req.body || {};
    const parsed = getStaged(stagingId);
    if (!parsed) {
        return res.status(410).json({ error: 'That import expired — upload the deck again.' });
    }
    try {
        const result = commitImport(parsed, {
            projectName,
            swapFrontBack: !!swapFrontBack,
            keepSchedule: keepSchedule !== false,
            includeMedia: includeMedia !== false,
            color,
        });
        dropStaged(stagingId);
        // Declining media leaves the extracted blobs unreferenced; reclaim now
        // rather than at the next restart.
        if (includeMedia === false) sweepOrphanMedia({ allowEmpty: true });
        scheduleNodeSync();   // map the imported deck into the topic space
        logActivity({
            area: 'deck',
            event: 'deck.imported',
            projectId: result?.projectId ?? result?.id ?? undefined,
            detail: `${result?.cards ?? '?'} card(s), ${result?.dropped ?? 0} dropped`,
        });
        res.json(result);
    } catch (err) {
        console.error('[Anki] commit failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Cancelling is explicit so a staged parse is released rather than waiting out
// its TTL.
app.delete('/api/import/anki/:stagingId', (req, res) => {
    dropStaged(req.params.stagingId);
    // Media is written to the blob store during inspect (so the preview costs no
    // memory), which means a cancelled import leaves exactly the bytes it
    // extracted and nothing pointing at them. Cancelling is the moment to
    // reclaim those — waiting for a restart would let a few abandoned attempts
    // at a 100 MB deck sit on disk indefinitely.
    const { removed, bytes } = sweepOrphanMedia({ allowEmpty: true });
    res.json({ success: true, mediaRemoved: removed, bytesFreed: bytes });
});

/**
 * An ASCII-only, quote-free fallback filename for `Content-Disposition`.
 *
 * A header value is Latin-1, so a Japanese or Cyrillic project name in the
 * plain `filename=` parameter throws a 500 before a byte is sent — the same
 * live bug that made every Japanese audio clip fail. The real name still
 * travels, in the RFC 5987 `filename*` parameter beside this one.
 */
function asciiFilename(name) {
    let out = '';
    for (const ch of String(name || '')) {
        const c = ch.codePointAt(0);
        const printable = c >= 0x20 && c <= 0x7e;
        const quoteOrSlash = ch === '"' || c === 0x5c;
        out += printable && !quoteOrSlash ? ch : '_';
    }
    return out.trim();
}

// --- Anki export (.apkg) - the exit door ----------------------------------
//
// The counterpart to the .apkg importer. A local-first app that says "your data
// is yours" and can only absorb collections has not said anything; this is the
// claim made checkable. Cards, their media and the intervals they have earned
// leave in the format the rest of the world reads. Mastery, placement and the
// curriculum's prose do NOT - Anki has nowhere to put them, and they leave
// through the JSON / .studyvault exporters that were built for them.
app.get('/api/export/:projectId/anki', async (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'Invalid project id' });
    try {
        const { zip, stats } = await buildProjectApkg({ db, mediaStorage }, projectId);
        if (!stats.notes) {
            // An empty .apkg is a valid archive and a useless download; say why
            // rather than handing over a file that imports as nothing.
            return res.status(404).json({ error: 'This project has no flashcards to export.' });
        }
        // RFC 5987, for the same reason /api/documents/:id/original needs it:
        // a header value is Latin-1, so a Japanese project name 500s without it.
        const ascii = asciiFilename(stats.project) || 'deck';
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition',
            `attachment; filename="${ascii}.apkg"; filename*=UTF-8''${encodeURIComponent(stats.project)}.apkg`);
        res.setHeader('X-Export-Stats', JSON.stringify(stats));

        // Streamed, not buffered. A real deck's archive is ~108 MB and building
        // it in memory took this process to 687 MB and killed it. There is no
        // Content-Length as a result — the response is chunked, which every
        // client here already handles, and a download with no total is a far
        // better outcome than a server that dies mid-export.
        const stream = zip.generateNodeStream({ type: 'nodebuffer', compression: 'DEFLATE' });
        stream.on('error', (err) => {
            // Headers are already out, so there is no status left to send: log
            // it and cut the connection, which is what tells the client the
            // download is incomplete rather than handing over a truncated file
            // that looks whole.
            console.error('[ANKI EXPORT] stream', err);
            res.destroy(err);
        });
        res.on('close', () => { if (!res.writableEnded) stream.destroy(); });
        return stream.pipe(res);
    } catch (err) {
        console.error('[ANKI EXPORT]', err);
        return res.status(String(err?.message || '').startsWith('No such project') ? 404 : 500)
            .json({ error: err?.message || 'Export failed' });
    }
});

// --- Vault-aware bundle export/import (.studyvault) -----------------------
// A bundle is a zip: manifest.json (project + node tree + documents metadata +
// extracted text) plus blobs/<sha256> originals. This is the portable, shareable
// artifact — the same shape a future marketplace "publish" would ship. Plain
// JSON export/import above stays for the lightweight, files-free case.
const bundleUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }, // a bundle holds many originals
});

// A bundle legitimately packs many originals, so the per-file Office caps are
// too tight here — but it's still untrusted input that must be bounded.
const BUNDLE_ZIP_LIMITS = { maxEntries: 20000, maxTotalBytes: 1024 * 1024 * 1024 };

app.get('/api/export/:projectId/bundle', async (req, res) => {
    const { projectId } = req.params;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Same opt-in contract as the plain JSON export, and it was missing here:
    // this builder used to write every learner's private `notes` into the
    // artifact whose own comment calls it "the shape a future marketplace
    // publish would ship". Default off, exactly like the other path — the
    // curriculum always ships, personal notes only on request.
    const includeNotes = req.query.includeNotes === 'true';
    const includeProgress = req.query.includeProgress === 'true';

    const allNodes = db.prepare('SELECT * FROM nodes WHERE project_id = ? ORDER BY position').all(projectId);
    const nodeById = new Map(allNodes.map(n => [n.id, n]));
    const pathOf = (nodeId) => {
        const titles = [];
        let cur = nodeById.get(nodeId);
        while (cur) { titles.unshift(cur.title); cur = cur.parent_id ? nodeById.get(cur.parent_id) : null; }
        return titles;
    };

    const buildTree = (parentId) => allNodes.filter(n => n.parent_id === parentId).map(n => {
        const node = {
            title: n.title,
            uuid: n.uuid || undefined,
            description: n.description || undefined,
            notes: includeNotes && n.notes ? n.notes : undefined,
            status: includeProgress ? n.status : undefined,
            is_note: n.is_note ? true : undefined,
            questions: exportedQuestions(n.id),
        };
        const resources = db.prepare('SELECT uuid, title, url, type, completed FROM resources WHERE node_id = ? ORDER BY position').all(n.id);
        if (resources.length) {
            node.resources = resources.map(r => {
                const out = { title: r.title };
                if (r.uuid) out.uuid = r.uuid;
                if (r.url) out.url = r.url;
                if (r.type && r.type !== 'link') out.type = r.type;
                if (includeProgress && r.completed) out.completed = true;
                return out;
            });
        }
        const children = buildTree(n.id);
        if (children.length) node.children = children;
        Object.keys(node).forEach(k => { if (node[k] === undefined) delete node[k]; });
        return node;
    });

    const docs = db.prepare(`SELECT * FROM documents
        WHERE project_id = ? OR node_id IN (SELECT id FROM nodes WHERE project_id = ?)`).all(projectId, projectId);

    try {
        const zip = new JSZip();
        const manifestDocs = [];
        for (const d of docs) {
            manifestDocs.push({
                title: d.title,
                file_type: d.file_type,
                original_filename: d.original_filename || undefined,
                file_hash: d.file_hash || undefined,
                file_size: d.file_size || undefined,
                page_count: d.page_count || undefined,
                status: d.status,
                content: d.content || '',
                node_path: d.node_id ? pathOf(d.node_id) : undefined,
            });
            if (d.file_hash && vaultStorage.exists(d.file_hash)) {
                // A read stream, not the bytes: a vault of originals is the same
                // shape of load the Anki export was killed by (687 MB peak), and
                // buffering them here holds every original AND JSZip's copy.
                zip.file(`blobs/${d.file_hash}`, fs.createReadStream(vaultStorage.pathFor(d.file_hash)));
            }
        }
        const manifest = {
            exported_at: new Date().toISOString(),
            project: {
                name: project.name,
                uuid: project.uuid || undefined,
                version: project.version || undefined,
                description: project.description || undefined,
                color: project.color,
                icon: project.icon,
                content_language: project.content_language || undefined,
            },
            nodes: buildTree(null),
            documents: manifestDocs,
        };
        zip.file('manifest.json', JSON.stringify(manifest, null, 2));

        const safeName = (project.name || 'project').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60) || 'project';
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}.studyvault"`);

        // Streamed for the same reason the Anki export is, and no Content-Length
        // as a result: a chunked download with no total beats a server that dies
        // holding three copies of the same originals.
        const stream = zip.generateNodeStream({ type: 'nodebuffer', compression: 'DEFLATE' });
        stream.on('error', (err) => {
            // Headers are out, so there is no status left to send: log and cut
            // the connection, which tells the client the download is incomplete
            // rather than handing over a truncated file that looks whole.
            console.error('[Bundle export] stream', err);
            res.destroy(err);
        });
        res.on('close', () => { if (!res.writableEnded) stream.destroy(); });
        return stream.pipe(res);
    } catch (err) {
        console.error('[Bundle export] Error:', err);
        res.status(500).json({ error: `Failed to build bundle: ${err.message}` });
    }
});

app.post('/api/import/bundle', rejectOversizedBody(208 * 1024 * 1024), bundleUpload.single('bundle'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No bundle uploaded' });

    let manifest, zip;
    try {
        zip = await JSZip.loadAsync(req.file.buffer);
        // A .studyvault is untrusted input (the marketplace's whole point is
        // sharing them) — reject zip bombs before inflating any entry.
        assertZipSafe(zip, BUNDLE_ZIP_LIMITS);
        const mf = zip.file('manifest.json');
        if (!mf) return res.status(400).json({ error: 'Invalid bundle: missing manifest.json' });
        manifest = JSON.parse(await mf.async('string'));
    } catch (e) {
        return res.status(400).json({ error: `Invalid bundle: ${e.message}` });
    }

    const { documents } = manifest;

    // Exactly the same normalizer as POST /api/import. These two paths had
    // drifted into different opinions about the same file — the bundle clamped
    // an unknown status where the JSON path rejected it, and neither looked at a
    // resource URL — even though a bundle is the *more* likely thing to have
    // been handed to you by a stranger.
    let project, nodes, warnings;
    try {
        const header = normalizeImportProject(manifest.project, { isSupportedLanguage });
        const tree = normalizeImportTree(manifest.nodes || [], IMPORT_QUESTION_DEPS);
        project = header.project;
        nodes = tree.nodes;
        warnings = [...header.warnings, ...tree.warnings];
    } catch (err) {
        if (err instanceof ImportError) return res.status(400).json({ error: `Invalid bundle: ${err.message}` });
        throw err;
    }

    const twin = project.uuid ? db.prepare('SELECT id, name, version FROM projects WHERE uuid = ?').get(project.uuid) : null;
    if (twin) {
        const editions = project.version && twin.version && project.version !== twin.version
            ? ` (you have ${twin.version}, this bundle is ${project.version})`
            : '';
        warnings.push(`You already have this course as "${twin.name}"${editions} — it was imported as a separate copy.`);
    }

    // Restore originals into the (deduped) blob store BEFORE the DB transaction.
    // We re-hash each blob and trust the bytes — the stored key is always the
    // true content hash, so a tampered manifest hash can't poison the store.
    const restoredHash = new Map();  // manifestHash -> actualHash
    const reExtracted = new Map();    // actualHash -> freshly re-extracted text
    try {
        for (const d of (documents || [])) {
            if (!d.file_hash || restoredHash.has(d.file_hash)) continue;
            const entry = zip.file(`blobs/${d.file_hash}`);
            if (!entry) continue; // text-only / original not included
            const buf = await entry.async('nodebuffer');
            const { hash } = vaultStorage.put(buf);
            restoredHash.set(d.file_hash, hash);
            // Don't trust the publisher's extracted text — re-extract from the
            // actual bytes (also re-runs type + zip-bomb validation). On failure
            // we fall back to the manifest's content below.
            if (buf.length <= MAX_FILE_BYTES) {
                try {
                    const { text } = await extractText(buf, d.original_filename || d.title || '');
                    reExtracted.set(hash, text);
                } catch { /* keep manifest content as fallback */ }
            }
        }
    } catch (e) {
        return res.status(400).json({ error: `Failed to restore vault files: ${e.message}` });
    }

    try {
        const pathKey = (titles) => (titles || []).join('\u0000');
        const newNodeIdByPath = new Map();
        const importedDocIds = [];
        const importedPdfIds = [];

        const result = db.transaction(() => {
            const projectResult = db.prepare(`
                INSERT INTO projects (name, description, color, icon, position, content_language, version, uuid)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(project.name, project.description, project.color, project.icon, nextProjectPosition(),
                project.content_language, project.version, claimUuid('projects', project.uuid));
            const newProjectId = projectResult.lastInsertRowid;

            insertImportedTree(newProjectId, nodes, (_node, newNodeId, path) => {
                newNodeIdByPath.set(pathKey(path), newNodeId);
            });

            const insertChunk = db.prepare('INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, ?, ?)');
            for (const d of (documents || [])) {
                // Re-link to a node by its title path; fall back to project-level.
                const nodeId = d.node_path ? (newNodeIdByPath.get(pathKey(d.node_path)) || null) : null;
                const realHash = d.file_hash ? (restoredHash.get(d.file_hash) || null) : null;
                const content = (realHash && reExtracted.has(realHash))
                    ? reExtracted.get(realHash)
                    : (typeof d.content === 'string' ? d.content : '');
                const docRes = db.prepare(`INSERT INTO documents
                    (node_id, project_id, title, content, file_type, original_filename, file_hash, file_size, status, page_count)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(nodeId, nodeId ? null : newProjectId, (d.title || 'document').substring(0, 500), content, d.file_type || 'text', d.original_filename || null, realHash, d.file_size || null, d.status || 'ready', d.page_count || null);
                const docId = docRes.lastInsertRowid;
                if (content) { chunkText(content).forEach((c, i) => insertChunk.run(docId, i, c)); importedDocIds.push(docId); }
                if ((d.file_type || 'text') === 'pdf' && realHash) importedPdfIds.push(docId);
            }
            return newProjectId;
        })();

        // Semantic-index the restored documents in the background (after commit).
        importedDocIds.forEach(id => indexDocument(id));
        // ...and the restored curriculum, so a shared course joins the atlas.
        scheduleNodeSync();
        // Re-read any math dropped by a restored PDF's text layer (no-op if clean
        // or if recovery is off) — the blob was restored above, so it's available.
        importedPdfIds.forEach(id => queueRecovery(id));

        const newProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(result);
        console.log(`Imported bundle "${newProject.name}" (id ${result}) with ${(documents || []).length} document(s)${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
        res.json({ ...newProject, warnings });
    } catch (err) {
        console.error('Bundle import error:', err);
        res.status(400).json({ error: `Database error: ${err.message}` });
    }
});

// SCHEDULING ROUTES

/**
 * Cross-project scheduling overview — one row per project for the schedule
 * board, where every project shares ONE horizontal time axis.
 *
 * The board's whole point is seeing which projects overlap and where the
 * crunch is, so it needs three things the projects list alone cannot answer:
 * how many open leaves a drag would reschedule (the confirm dialog quotes it,
 * and a number the learner can check is what makes an irreversible-feeling
 * action safe to accept), and the ACTUAL extent of the scheduled topics.
 *
 * That extent is the honest half. `projects.start_date` / `deadline` are the
 * declared window; the topics inside it carry their own dates and the two can
 * disagree — after a manual node edit, or a window moved without rescheduling.
 * A board that drew only the declared window would render that disagreement
 * invisible, which is exactly the lie the drag-then-confirm flow exists to
 * avoid. So both are returned and the client draws the drift.
 */
app.get('/api/schedule/overview', (req, res) => {
    try {
        const projects = db.prepare(`
            SELECT id, uuid, name, color, icon, position, status,
                   start_date, deadline, study_days
            FROM projects
            WHERE COALESCE(status, 'active') != 'archived'
            ORDER BY position ASC, id ASC
        `).all();

        // Leaf counts and true scheduled extent, per project, in two grouped
        // passes rather than a query per project.
        const openCounts = new Map(db.prepare(`
            SELECT n.project_id AS pid, COUNT(*) AS c
            FROM nodes n WHERE ${OPEN_WORK_LEAF} GROUP BY n.project_id
        `).all().map(r => [r.pid, r.c]));

        const leafCounts = new Map(db.prepare(`
            SELECT n.project_id AS pid, COUNT(*) AS c
            FROM nodes n WHERE ${WORK_LEAF} GROUP BY n.project_id
        `).all().map(r => [r.pid, r.c]));

        const extents = new Map(db.prepare(`
            SELECT n.project_id AS pid,
                   MIN(n.scheduled_start) AS first_start,
                   MAX(n.scheduled_end)   AS last_end,
                   COUNT(n.scheduled_start) AS scheduled_count
            FROM nodes n
            WHERE ${WORK_LEAF} AND n.scheduled_start IS NOT NULL
            GROUP BY n.project_id
        `).all().map(r => [r.pid, r]));

        // Cards, and how many have stopped being strangers — the same pair, by
        // the same rule, as `PROJECT_SUMMARY_SQL` (server/projectSummary.js).
        // A collection of cards has no topics to count, so a board that knows
        // only about topics says "0 / 1 topic done" about 300 cards, while the
        // Projects grid beside it says how many are met. Grouped in one pass
        // rather than joined row-wise: nodes × flashcards fans out.
        const cardCounts = new Map(db.prepare(`
            SELECT n.project_id AS pid,
                   COUNT(*) AS cards,
                   SUM(CASE WHEN f.review_count > 0 AND f.last_reviewed IS NOT NULL
                            THEN 1 ELSE 0 END) AS seen
            FROM flashcards f
            JOIN nodes n ON n.id = f.node_id
            GROUP BY n.project_id
        `).all().map(r => [r.pid, r]));

        const rows = projects.map(p => {
            const ext = extents.get(p.id) || {};
            // Pace — how far through the plan says you should be against how
            // far you are. `calculatePace` is the SAME function the project
            // card, the study dashboard and the phase bars read, so this board
            // cannot print a different number for the same project; its
            // `message` is deliberately dropped, because server-written text
            // stays English and the client builds the sentence from these
            // fields through i18n. Only asked of a project that HAS a window:
            // without one it returns `no_schedule` after a single lookup.
            let pace = null;
            if (p.start_date && p.deadline) {
                try {
                    const full = calculatePace(p.id);
                    pace = {
                        paceStatus: full.paceStatus,
                        expectedProgress: full.expectedProgress,
                        actualProgress: full.actualProgress,
                        drift: full.drift ?? 0,
                        totalDays: full.totalDays ?? 0,
                    };
                } catch { pace = null; }
            }
            const cc = cardCounts.get(p.id) || {};
            return {
                ...p,
                openLeaves: openCounts.get(p.id) || 0,
                totalLeaves: leafCounts.get(p.id) || 0,
                scheduledLeaves: ext.scheduled_count || 0,
                firstScheduledStart: ext.first_start || null,
                lastScheduledEnd: ext.last_end || null,
                cardCount: cc.cards || 0,
                seenCardCount: cc.seen || 0,
                // Whether its topics may be taught, which is half of "is this
                // measured in topics or in cards" — the other half is having no
                // topics at all. Two indexed lookups per project, the same call
                // the grid's row makes.
                teaches: projectTeaches(p.id),
                pace,
            };
        });
        res.json({ projects: rows, today: new Date().toISOString().split('T')[0] });
    } catch (err) {
        console.error('[Schedule overview] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/projects/:id/schedule', (req, res) => {
    const { id } = req.params;
    // `hoursPerDay` is deliberately not read. It was a project column and a
    // slider, and it cancelled itself out of the allocator's arithmetic — an
    // older client may still send it, and it is ignored rather than rejected.
    const { startDate, deadline, studyDays } = req.body;

    if (!startDate || !deadline) return res.status(400).json({ error: 'Start date and deadline are required.' });
    if (startDate > deadline) return res.status(400).json({ error: 'Start date must be before deadline.' });

    const days = studyDays || [1, 2, 3, 4, 5];

    if (!Array.isArray(days) || days.length === 0) return res.status(400).json({ error: 'At least one study day must be selected.' });

    if (!requireProject(req, res)) return;

    try {
        const result = allocateSchedule(id, startDate, deadline, days);
        if (!result.success) return res.status(400).json({ error: result.error });

        persistSchedule(id, result.assignments, result.baselineSnapshot, {
            startDate, deadline, studyDays: days,
        });

        const updatedProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
        const nodes = db.prepare(`
            SELECT id, project_id, parent_id, title, description, notes, status,
                   is_note, position, scheduled_start, scheduled_end, estimated_weight,
                   completed_at, created_at, updated_at
            FROM nodes WHERE project_id = ?
        `).all(id);

        res.json({ success: true, project: updatedProject, nodes, warnings: result.warnings, stats: result.stats });
    } catch (err) {
        console.error('[Schedule] Error:', err);
        res.status(500).json({ error: `Failed to generate schedule: ${err.message}` });
    }
});

app.post('/api/projects/:id/recalibrate', (req, res) => {
    const { id } = req.params;
    if (!requireProject(req, res)) return;

    try {
        const result = recalibrateSchedule(id);
        if (!result.success) {
            return res.status(400).json({ error: result.error, suggestedDeadline: result.suggestedDeadline });
        }
        if (result.unchanged) return res.json({ success: true, message: 'All tasks completed!', unchanged: true });

        const updateNodeSchedule = db.prepare(`UPDATE nodes SET scheduled_start = ?, scheduled_end = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
        const clearSchedules = db.prepare(`UPDATE nodes SET scheduled_start = NULL, scheduled_end = NULL, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?`);
        const transaction = db.transaction(() => {
            clearSchedules.run(id);
            for (const [nodeId, data] of result.assignments) {
                if (data.scheduled_start && data.scheduled_end) {
                    updateNodeSchedule.run(data.scheduled_start, data.scheduled_end, nodeId);
                }
            }
        });
        transaction();

        const nodes = db.prepare(`
            SELECT id, project_id, parent_id, title, description, notes, status,
                   is_note, position, scheduled_start, scheduled_end, estimated_weight,
                   completed_at, created_at, updated_at
            FROM nodes WHERE project_id = ?
        `).all(id);

        res.json({ success: true, nodes, warnings: result.warnings, stats: result.stats });
    } catch (err) {
        console.error('[Recalibrate] Error:', err);
        res.status(500).json({ error: `Failed to recalibrate: ${err.message}` });
    }
});

app.get('/api/projects/:id/pace', (req, res) => {
    const { id } = req.params;
    if (!requireProject(req, res)) return;
    try {
        const pace = calculatePace(id);
        res.json(pace);
    } catch (err) {
        console.error('[Pace] Error:', err);
        res.status(500).json({ error: `Failed to calculate pace: ${err.message}` });
    }
});

// Is this project finished, and what did finishing it take? (server/completion.js)
//
// Always 200 with a payload — `complete: false` is the normal answer and the
// client needs the rest of it anyway to offer the summary from the project's
// own menu after the fact.
app.get('/api/projects/:projectId/completion', (req, res) => {
    const { projectId } = req.params;
    try {
        const summary = projectCompletion(projectId);
        if (!summary) return res.status(404).json({ error: 'Project not found' });
        res.json(summary);
    } catch (err) {
        console.error('[Completion] Error:', err);
        res.status(500).json({ error: `Failed to summarise the project: ${err.message}` });
    }
});

// "I have seen this." Stops the summary opening itself again — and nothing
// else: the project's status is changed through the ordinary PUT, because
// moving a project to Completed is a decision and closing a dialog is not.
app.post('/api/projects/:projectId/completion/seen', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;
    try {
        markCelebrated(projectId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: `Failed to record that: ${err.message}` });
    }
});

app.delete('/api/projects/:id/schedule', (req, res) => {
    const { id } = req.params;
    if (!requireProject(req, res)) return;

    try {
        const clearNodeSchedules = db.prepare(`UPDATE nodes SET scheduled_start = NULL, scheduled_end = NULL, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?`);
        const clearProjectSchedule = db.prepare(`UPDATE projects SET start_date = NULL, deadline = NULL, study_days = '[1,2,3,4,5]', baseline_schedule = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
        const transaction = db.transaction(() => {
            clearNodeSchedules.run(id);
            clearProjectSchedule.run(id);
        });
        transaction();
        res.json({ success: true });
    } catch (err) {
        console.error('[Delete Schedule] Error:', err);
        res.status(500).json({ error: `Failed to remove schedule: ${err.message}` });
    }
});

app.put('/api/nodes/:id/weight', (req, res) => {
    const { id } = req.params;
    const { estimated_weight } = req.body;
    if (typeof estimated_weight !== 'number' || estimated_weight < 0) {
        return res.status(400).json({ error: 'Weight must be a non-negative number.' });
    }
    try {
        const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
        if (!node) return res.status(404).json({ error: 'Node not found.' });
        db.prepare(`UPDATE nodes SET estimated_weight = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(estimated_weight, id);
        const updated = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DECK (card-collection projects)
//
// A deck answers different questions from a curriculum — see server/decks.js.
// These endpoints exist only for `projects.kind = 'deck'`; nothing else in the
// API branches on kind.

app.get('/api/projects/:projectId/deck', (req, res) => {
    const { projectId } = req.params;
    try {
        const data = buildDeckData(projectId, {
            forecastDays: Math.min(60, Math.max(7, Number.parseInt(req.query.days, 10) || 14)),
        });
        if (!data) return res.status(404).json({ error: 'Project not found' });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: `Failed to load deck: ${err.message}` });
    }
});

// The session queue: reviews that are actually owed, plus new cards up to the
// day's remaining allowance. Deliberately NOT `/flashcards/due`, which treats
// every never-reviewed card as due — right for a topic's handful of AI cards,
// and the reason an imported deck greeted its owner with "1,483 cards due" on
// day one.
// How far a "study ahead" session may reach into the future. Two weeks is
// enough to make an empty day studiable and short enough that the learner is
// still reviewing things they are about to need.
const MAX_AHEAD_DAYS = 14;

app.get('/api/projects/:projectId/deck/queue', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;
    try {
        const limitParam = req.query.newLimit;
        const newLimit = limitParam == null || limitParam === ''
            ? null
            : Math.max(0, Number.parseInt(limitParam, 10) || 0);
        // The stage is passed INTO the queue, never used to filter its result:
        // the day's new cards are taken in deck order, so a finished queue holds
        // only the current stage's cards and filtering it by any other stage
        // yields nothing. See studyQueue.
        const stageRaw = req.query.stage ? Number.parseInt(req.query.stage, 10) : null;
        const stageId = Number.isFinite(stageRaw) ? stageRaw : null;
        // `ahead` is a horizon in DAYS, capped: pulling a month of reviews
        // forward would hand the learner the whole deck and undo the scheduling
        // they have earned. A deliberate session, not a new default.
        const aheadRaw = req.query.ahead ? Number.parseInt(req.query.ahead, 10) : 0;
        const aheadDays = Number.isFinite(aheadRaw) ? Math.max(0, Math.min(MAX_AHEAD_DAYS, aheadRaw)) : 0;
        const { reviews, fresh, counts } = studyQueue(projectId, { newLimit, stageId, aheadDays });
        res.json({ cards: [...reviews, ...fresh], counts, reviews: reviews.length, fresh: fresh.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Turn teaching on or off for one project.
//
// Off by default for an import: somebody who brings in a 5,000-card deck wants
// to study cards tonight, and 32 background lesson plans is a surprise, not a
// feature. On for anything authored here. The switch exists because the answer
// is the learner's, not the importer's — one measured import's 32 named
// subdecks are a curriculum and were permanently untaught while `kind` decided
// this.
app.put('/api/projects/:projectId/teaching', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;
    try {
        const on = req.body?.teaches;
        const teaches = on == null
            ? projectTeaches(projectId)
            : setProjectTeaches(projectId, !(on === false || on === 'false' || on === 0 || on === '0'));
        res.json({ teaches });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/projects/:projectId/deck/settings', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;
    try {
        const newPerDay = req.body?.newPerDay != null
            ? setNewPerDay(projectId, req.body.newPerDay)
            : getNewPerDay(projectId);
        res.json({ newPerDay });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// STUDY DASHBOARD

app.get('/api/projects/:projectId/study-dashboard', (req, res) => {
    const { projectId } = req.params;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
        const todayDate = new Date().toISOString().split('T')[0];
        const allNodes = db.prepare(`
            SELECT id, parent_id, title, status, is_note,
                   scheduled_start, scheduled_end
            FROM nodes WHERE project_id = ? AND is_note = 0
            ORDER BY position
        `).all(projectId);

        const todaySchedule = [];
        const overdueTopics = [];

        // Only leaves are schedulable work. `allNodes` already excludes notes,
        // so a row is a leaf iff no other row lists it as parent_id — which is
        // the "no non-note children" rule, decided once instead of per node.
        const scheduleParentIds = new Set(allNodes.map(n => n.parent_id).filter(id => id != null));

        for (const node of allNodes) {
            if (node.status === 'completed' || node.status === 'skipped') continue;
            if (!node.scheduled_start || !node.scheduled_end) continue;
            if (scheduleParentIds.has(node.id)) continue;

            if (node.scheduled_end < todayDate) {
                const daysOverdue = daysBetween(node.scheduled_end, todayDate);
                overdueTopics.push({
                    id: node.id,
                    title: node.title,
                    status: node.status,
                    scheduled_end: node.scheduled_end,
                    parent_id: node.parent_id,
                    daysOverdue,
                });
            } else if (node.scheduled_start <= todayDate && node.scheduled_end >= todayDate) {
                todaySchedule.push({
                    id: node.id,
                    title: node.title,
                    status: node.status,
                    scheduled_start: node.scheduled_start,
                    scheduled_end: node.scheduled_end,
                    parent_id: node.parent_id,
                });
            }
        }

        const flashcardStats = db.prepare(`
            SELECT
                COUNT(*) as totalCards,
                SUM(CASE WHEN ${reviewDue('f')} THEN 1 ELSE 0 END) as dueCount,
                SUM(CASE WHEN f.difficulty >= 3 THEN 1 ELSE 0 END) as weakCount,
                SUM(CASE WHEN f.last_interval > 0 THEN 1 ELSE 0 END) as reviewedCount,
                SUM(CASE WHEN f.last_interval > 0 AND f.difficulty < 3 THEN 1 ELSE 0 END) as retainedCount
            FROM flashcards f
            JOIN nodes n ON n.id = f.node_id
            WHERE n.project_id = ?
        `).get(projectId);

        // One deck per top-level category, counting flashcards attached to the
        // category itself or ANY descendant (the tree nests arbitrarily deep —
        // a fixed three-level join silently dropped cards at other depths).
        const deckRows = db.prepare(`
            WITH RECURSIVE subtree AS (
                SELECT id, id as root_id FROM nodes
                WHERE project_id = ? AND parent_id IS NULL AND is_note = 0
                UNION ALL
                SELECT n.id, s.root_id FROM nodes n
                JOIN subtree s ON n.parent_id = s.id
            )
            SELECT
                cat.id as categoryId,
                cat.title as categoryTitle,
                COUNT(f.id) as totalCards,
                SUM(CASE WHEN ${reviewDue('f')} THEN 1 ELSE 0 END) as dueCount,
                SUM(CASE WHEN f.difficulty >= 3 THEN 1 ELSE 0 END) as weakCount
            FROM subtree s
            JOIN nodes cat ON cat.id = s.root_id
            JOIN flashcards f ON f.node_id = s.id
            GROUP BY cat.id
            HAVING totalCards > 0
            ORDER BY cat.position
        `).all(projectId);

        // Retention = share of *reviewed* cards that are still in good standing
        // (difficulty < 3). Null until at least one card has been reviewed, so we
        // don't imply 100% retention on a brand-new, never-reviewed deck.
        const reviewedCount = flashcardStats?.reviewedCount || 0;
        // The same counts the card panel draws, from the same function the
        // session is served by (server/decks.js). `dueCount` is reviews OWED,
        // and `newAvailable` is how many unseen cards today's allowance still
        // permits — two numbers, because they are two kinds of work. Merging
        // them was the "1,483 due" headline; dropping the second one would
        // leave a project with 600 written cards and nothing owed reading "0
        // due" beside a disabled Review button.
        const queueCounts = deckCounts(projectId);
        const flashcardSummary = {
            totalCards: flashcardStats?.totalCards || 0,
            dueCount: queueCounts.dueReviews,
            newAvailable: queueCounts.newAvailable,
            newPerDay: queueCounts.newPerDay,
            introducedToday: queueCounts.introducedToday,
            weakCount: flashcardStats?.weakCount || 0,
            retention: reviewedCount > 0
                ? Math.round(((flashcardStats?.retainedCount || 0) / reviewedCount) * 100)
                : null,
            decks: deckRows,
        };

        const weakTopics = db.prepare(`
            SELECT
                n.id as node_id,
                n.title,
                ROUND(AVG(qa.score * 100.0 / qa.total)) as avg_score,
                COUNT(*) as attempt_count
            FROM quiz_attempts qa
            JOIN quizzes q ON q.id = qa.quiz_id
            JOIN nodes n ON n.id = q.node_id
            WHERE n.project_id = ?
            GROUP BY q.node_id
            HAVING avg_score < 70
            ORDER BY avg_score ASC
            LIMIT 10
        `).all(projectId);

        const recentAttempts = db.prepare(`
            SELECT
                qa.score,
                qa.total,
                n.title as node_title,
                q.title as quiz_title,
                qa.created_at
            FROM quiz_attempts qa
            JOIN quizzes q ON q.id = qa.quiz_id
            JOIN nodes n ON n.id = q.node_id
            WHERE n.project_id = ?
            ORDER BY qa.created_at DESC
            LIMIT 10
        `).all(projectId);

        const quizStats = db.prepare(`
            SELECT 
                COUNT(DISTINCT q.id) as totalQuizzes,
                ROUND(AVG(qa.score * 100.0 / qa.total)) as averageScore
            FROM quizzes q
            JOIN nodes n ON n.id = q.node_id
            LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.id
            WHERE n.project_id = ?
        `).get(projectId);

        const quizSummary = {
            totalQuizzes: quizStats?.totalQuizzes || 0,
            averageScore: quizStats?.averageScore ?? null,
            weakTopics,
            recentAttempts,
        };

        let pace = null;
        if (project.start_date && project.deadline) {
            pace = calculatePace(projectId);
        }

        const allProjectNodes = db.prepare('SELECT * FROM nodes WHERE project_id = ? AND is_note = 0').all(projectId);
        // Progress is measured over WORK LEAVES only (a topic that gets proven),
        // never branch/category nodes and never a slice of an imported deck's
        // card order — otherwise this "% complete" diverges from the project
        // card and pace, which count the same set (`workLeaves`, today.js).
        const leafNodes = workLeaves(allProjectNodes);
        // Closed = verified completed OR consciously skipped; both advance progress.
        const completedNodes = leafNodes.filter(n => n.status === 'completed' || n.status === 'skipped').length;
        const totalNodes = leafNodes.length;
        // The COUNT stays a count of topics somebody closed; the PERCENTAGE is
        // the shared one (server/progress.js), which also credits a topic held
        // in cards for the cards met on it. The project card and pace read the
        // same function, so the three cannot drift.
        const progressPercent = Math.round(projectProgress(projectId).fraction * 100);

        let daysUntilDeadline = null;
        if (project.deadline) {
            daysUntilDeadline = daysBetween(todayDate, project.deadline);
        }

        // Cap overdue topics to 3 to prevent overwhelm
        const cappedOverdueTopics = overdueTopics.slice(0, 3);

        // "Remember" loop: topics the learner *proved* (mastery >= threshold)
        // whose faded estimate has since slipped back below that same threshold.
        // Both the bar (mastery_threshold) and the timescale (decay_days) are
        // settings — nothing hardcoded. `provenTopics` lets the client tell
        // "everything's still fresh" (celebrate) from "nothing proven yet" (hide).
        const gate = getGateConfig();
        let reviewTopics = [];
        let provenTopics = false;
        try {
            reviewTopics = getDecayingNodes(projectId, gate.decayDays, { threshold: gate.threshold }).map(n => ({
                id: n.node_id,
                title: n.title,
                masteryScore: n.mastery_score,
                decayedScore: n.decayed_score,
                status: n.status,
                lastReviewed: n.last_updated,
            }));
            provenTopics = hasProvenTopics(projectId, gate.threshold);
        } catch (e) {
            console.error('[StudyDashboard] decay lookup failed:', e.message);
        }

        // Calculate Hero Task (The single most important thing to do right now)
        let heroTask = null;
        if (overdueTopics.length > 0) {
            heroTask = overdueTopics[0];
        } else if (todaySchedule.length > 0) {
            heroTask = todaySchedule[0];
        } else {
            // Select the first incomplete LEAF node (child_count = 0).
            // We cannot rely on parent_id absence alone because a parent whose
            // children are all completed still has status != 'completed' in the DB
            // but is NOT an actionable item the user can tick off.
            const allNodesForHero = db.prepare(`
        SELECT n.id, n.title, n.status, n.scheduled_start, n.scheduled_end, n.parent_id,
               (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = n.id AND c.is_note = 0) as child_count
        FROM nodes n
        WHERE n.project_id = ? AND n.is_note = 0 AND ${TOPIC_NODE}
          AND n.status NOT IN ('completed', 'skipped')
        ORDER BY n.position ASC
    `).all(projectId);
            const firstLeaf = allNodesForHero.find(n => n.child_count === 0);
            if (firstLeaf) {
                heroTask = firstLeaf;
            }
        }

        // Calculate Milestones (Top-level categories progress)
        const topCategories = db.prepare(`
    SELECT id, title FROM nodes
    WHERE project_id = ? AND parent_id IS NULL AND is_note = 0
    ORDER BY position ASC
`).all(projectId);

        const milestones = topCategories.map(cat => {
            // 1. Fetch the category and all its descendants
            const allSubNodes = db.prepare(`
        WITH RECURSIVE descendants AS (
            SELECT id, parent_id, status, is_note, role FROM nodes WHERE id = ?
            UNION ALL
            SELECT n.id, n.parent_id, n.status, n.is_note, n.role FROM nodes n
            JOIN descendants d ON n.parent_id = d.id
        )
        SELECT d.id, d.parent_id, d.status, d.is_note, d.role,
               -- …and what its cards say, because a topic whose content is
               -- cards is finished by meeting them, not by being ticked
               -- (server/progress.js).
               (SELECT COUNT(*) FROM flashcards f WHERE f.node_id = d.id) AS cards,
               (SELECT COUNT(*) FROM flashcards f WHERE f.node_id = d.id
                  AND f.review_count > 0 AND f.last_reviewed IS NOT NULL) AS seen
        FROM descendants d
    `).all(cat.id);

            const nodeMap = new Map();
            for (const n of allSubNodes) {
                nodeMap.set(n.id, { ...n, children: [] });
            }
            for (const n of allSubNodes) {
                if (n.parent_id && nodeMap.has(n.parent_id)) {
                    nodeMap.get(n.parent_id).children.push(nodeMap.get(n.id));
                }
            }

            // Mirrors the ROLLUP half of `calcProgress` in src/utils/tree.ts:
            // the same leaf rule and the same sums, but nothing here writes a
            // `progress` field back onto the node or walks its note children —
            // this only has to return the pair the milestone bar prints.
            function calcProgress(node) {
                // Notes contribute 0 and their children are ignored for progress
                if (node.is_note) {
                    return { total: 0, completed: 0, done: 0, weight: 0 };
                }
                // So does a slice of card order: it holds cards, and nobody
                // finishes it (server/nodeRole.js). Counting one is what kept a
                // taught import's bar below full however much was proven.
                if (isPagination(node)) {
                    return { total: 0, completed: 0, done: 0, weight: 0 };
                }
                // Leaf = a non-note node with no NON-NOTE children (the tree
                // convention, mirrored by `structuralChildren` in
                // src/utils/tree.ts). Testing `children.length` instead counted
                // a topic that has readings hanging off it as a parent, and
                // since every note contributes 0 its whole phase then reported
                // 0/0 — a phase's progress bar emptied itself the moment
                // material was added to it.
                const structural = structuralChildren(node);
                // A leaf counts as 1, and is DONE by the shared rule: closed by
                // hand, or the share of its cards met (`topicFraction`). The
                // count of closed topics and the share done are tracked
                // separately because the bar prints one and the caption the
                // other — a topic 60% through its cards has not been completed.
                if (structural.length === 0) {
                    const completed = (node.status === 'completed' || node.status === 'skipped') ? 1 : 0;
                    const weight = topicWeight(node);
                    return { total: 1, completed, done: topicFraction(node) * weight, weight };
                }
                // Parent nodes sum up their children's progress
                let total = 0;
                let completed = 0;
                let done = 0;
                let weight = 0;
                for (const child of structural) {
                    const p = calcProgress(child);
                    total += p.total;
                    completed += p.completed;
                    done += p.done;
                    weight += p.weight;
                }
                return { total, completed, done, weight };
            }

            const root = nodeMap.get(cat.id);
            const { total, completed, done, weight } = root
                ? calcProgress(root)
                : { total: 0, completed: 0, done: 0, weight: 0 };
            const percentage = weight > 0 ? Math.round((done / weight) * 100) : 0;

            // Collect leaf-node segments for the segmented progress bar
            const segments = [];
            const collectLeaves = (node) => {
                if (node.is_note) return;
                // Structural children only, like calcProgress above: testing
                // `children.length` recursed into a topic's notes and pushed no
                // segment for it, so the bar drew fewer segments than the leaf
                // count printed beside it.
                const structural = structuralChildren(node);
                if (structural.length === 0) {
                    segments.push({
                        id: node.id,
                        title: node.title,
                        completed: node.status === 'completed' || node.status === 'skipped',
                        skipped: node.status === 'skipped',
                    });
                } else {
                    structural.forEach(collectLeaves);
                }
            };
            if (root) collectLeaves(root);

            return {
                id: cat.id,
                title: cat.title,
                percentage,
                completed,
                total,
                segments
            };
        });

        res.json({
            todaySchedule,
            overdueTopics: cappedOverdueTopics,
            heroTask,
            milestones,
            reviewTopics,
            provenTopics,
            flashcardSummary,
            quizSummary,
            insights: null,
            pace,
            stats: {
                totalNodes,
                completedNodes,
                progressPercent,
                daysUntilDeadline,
            },
        });
    } catch (err) {
        console.error('[StudyDashboard] Error:', err);
        res.status(500).json({ error: `Failed to load dashboard: ${err.message}` });
    }
});

// PROJECT-LEVEL FLASHCARD ENDPOINTS

app.get('/api/projects/:projectId/flashcards', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;

    try {
        const flashcards = db.prepare(`
            SELECT f.*,
                n.title as node_title,
                n.parent_id
            FROM flashcards f
            JOIN nodes n ON n.id = f.node_id
            WHERE n.project_id = ?
            ORDER BY n.position, f.created_at
        `).all(projectId);

        const enriched = flashcards.map(card => {
            let categoryTitle = null;
            let categoryId = null;
            let currentId = card.parent_id;
            let depth = 0;
            while (currentId && depth < 10) {
                const parent = db.prepare('SELECT id, title, parent_id FROM nodes WHERE id = ?').get(currentId);
                if (!parent) break;
                if (parent.parent_id === null) {
                    categoryTitle = parent.title;
                    categoryId = parent.id;
                    break;
                }
                currentId = parent.parent_id;
                depth++;
            }
            return { ...card, categoryTitle, categoryId };
        });

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/projects/:projectId/flashcards/due', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;

    try {
        // The session this serves is the same session the project's own screen
        // opens, so it comes from the same queue: reviews that are OWED, then
        // the day's remaining allowance of new cards. This used to be one SQL
        // query counting `next_review IS NULL` as due, which handed one real
        // curriculum project 615 cards — every card it has, never seen
        // — the moment its Review button was pressed. See server/decks.js.
        const { reviews, fresh } = studyQueue(projectId);
        const enriched = withTopCategory([...reviews, ...fresh]);

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PROJECT-LEVEL QUIZ ENDPOINT

app.get('/api/projects/:projectId/quizzes', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;

    try {
        const quizzes = db.prepare(`
            SELECT q.*,
                n.title as node_title,
                (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.quiz_id = q.id) as attempt_count,
                (SELECT MAX(qa.score * 100 / qa.total) FROM quiz_attempts qa WHERE qa.quiz_id = q.id) as best_score,
                (SELECT ROUND(AVG(qa.score * 100.0 / qa.total)) FROM quiz_attempts qa WHERE qa.quiz_id = q.id) as avg_score
            FROM quizzes q
            JOIN nodes n ON n.id = q.node_id
            WHERE n.project_id = ?
            ORDER BY q.created_at DESC
        `).all(projectId);

        res.json(quizzes.map(q => {
            try { return { ...q, questions: JSON.parse(q.questions) }; }
            catch { return { ...q, questions: [] }; }
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// MASTERY ROUTES

app.get('/api/nodes/:nodeId/mastery', (req, res) => {
    try {
        const gate = getGateConfig();
        const detail = getNodeMasteryDetail(req.params.nodeId, { threshold: gate.threshold, bossPass: gate.bossPass });
        res.json(detail);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/projects/:projectId/mastery', (req, res) => {
    try {
        const stats = getProjectMasteryStats(req.params.projectId);
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/nodes/:nodeId/mastery/quiz', (req, res) => {
    const attempt = readAttempt(req.body);
    if (!attempt) return res.status(400).json({ error: 'score and total are required' });
    const { score, total } = attempt;
    try {
        const result = updateMasteryFromAttempt(req.params.nodeId, score, total, 'quiz');
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Practice-drill round (D-023). Recorded under its own `drill` evidence type:
// updateMasteryFromAttempt applies BKT for any type, so a round sharpens the
// retention estimate and refreshes the decay timer — but checkMasteryEligibility's
// raw-score clause honours only `quiz`/`boss_fight`, so a drill can never clear
// the completion gate on its own. Practice tunes the estimate; proving needs an
// assessment.
app.post('/api/nodes/:nodeId/mastery/drill', (req, res) => {
    const attempt = readAttempt(req.body);
    if (!attempt) return res.status(400).json({ error: 'score and total (> 0) are required' });
    const { score, total } = attempt;
    try {
        const result = updateMasteryFromAttempt(req.params.nodeId, score, total, 'drill', { source: 'drill' });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// A flashcard's evidence has no endpoint: it is written on the rating path
// itself (server/cardEvidence.js), so every review surface produces it without
// having to remember to. The route that used to be here took one card's
// correct/total from a client, and in the app's whole life nothing ever called
// it — which is exactly why cards told the learner model nothing.

app.post('/api/projects/:projectId/mastery/boss-fight', (req, res) => {
    const { nodeId, questions } = req.body || {};
    const attempt = readAttempt(req.body);
    if (!nodeId || !attempt) {
        return res.status(400).json({ error: 'nodeId, score, and total are required' });
    }
    const { score, total } = attempt;
    try {
        const result = updateMasteryFromAttempt(nodeId, score, total, 'boss_fight', {
            questions,
            type: 'boss_fight',
        });

        // Also record the Boss Fight as a quiz attempt so the node's quiz no
        // longer shows "Not taken" after the learner proves mastery. Attach it
        // to the node's most recent quiz (the Boss Fight draws its questions
        // from there, or generated+saved one when none existed).
        try {
            const quiz = db.prepare('SELECT id FROM quizzes WHERE node_id = ? ORDER BY id DESC LIMIT 1').get(nodeId);
            if (quiz) {
                db.prepare('INSERT INTO quiz_attempts (quiz_id, score, total, answers) VALUES (?, ?, ?, ?)')
                    .run(quiz.id, score, total, JSON.stringify({ source: 'boss_fight' }));
            }
        } catch (e) {
            console.error('[boss-fight] failed to record quiz attempt:', e.message);
        }
        // Pass/fail is based on raw score percentage, not the BKT mastery score.
        // BKT can produce counterintuitive results (e.g. 8/10 correct → ~0.67 mastery)
        // because slip/guess probabilities and update ordering distort the mapping
        // between raw accuracy and the Bayesian posterior. We use the configured raw
        // pass threshold here, and `checkMasteryEligibility` honors the same raw
        // evidence, so a passing Boss Fight reliably unlocks completion.
        const { bossPass } = getGateConfig();
        const passed = score / total >= bossPass;
        // pass_threshold lets the UI show the *configured* bar instead of a
        // hardcoded percentage.
        res.json({ ...result, passed, raw_score_pct: Math.round((score / total) * 100), pass_threshold: bossPass });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DAILY PLAN / INTERVENTION ENGINE

app.get('/api/projects/:projectId/daily-plan', (req, res) => {
    try {
        const plan = generateDailyPlan(req.params.projectId, getGateConfig().decayDays);
        res.json(plan);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/projects/:projectId/ghost-questions', (req, res) => {
    const max = parseInt(req.query.max) || 2;
    try {
        const ghosts = getGhostQuestions(req.params.projectId, max, getGateConfig().decayDays);
        res.json(ghosts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GLOBAL "TODAY" HUB — cross-project aggregation

// ---- Placement probe --------------------------------------------------------
//
// "What do you already know?", asked once, before the feed starts teaching.
// The engine and its boundary live in server/placement.js; these endpoints only
// decide who may ask and what the client is allowed to see.
//
// The one rule enforced HERE rather than there: a question leaves the server
// without its answer key. Same contract as the paper loop's reference solution
// and `AnswerHelp` — the key and the explanation arrive on the way out, in the
// answer response, never with the question. A probe that shipped its own key in
// the payload would measure nothing at all, and the network tab is not a
// difficult place to look.
function publicProbeQuestion(q, index) {
    return {
        index,
        nodeId: q.node_id,
        nodeTitle: q.node_title,
        phaseTitle: q.phase_title,
        type: q.type,
        question: q.question,
        options: q.type === 'multiple_choice' ? q.options : undefined,
        verified: q.verified !== false,
    };
}

function publicProbe(probe) {
    if (!probe) return null;
    const answered = new Map(probe.answers.map(a => [a.questionIndex, a]));
    return {
        id: probe.id,
        projectId: probe.projectId,
        state: probe.state,
        error: probe.error,
        total: probe.questions.length,
        answeredCount: probe.answers.length,
        questions: probe.questions.map((q, i) => ({
            ...publicProbeQuestion(q, i),
            answered: answered.has(i),
            correct: answered.get(i)?.correct ?? null,
        })),
    };
}

app.get('/api/placement/:projectId', (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Invalid project id' });
    try {
        const availability = probeAvailability(projectId);
        const probe = getProbe(projectId);
        res.json({
            ...availability,
            probe: publicProbe(probe),
            summary: probe && probe.state === 'done' ? summariseProbe(probe) : null,
        });
    } catch (error) {
        console.error('[Placement] status failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// Authoring runs as a background task for the same reason quiz generation does:
// it is a minute of model calls, and a learner who navigates away or reloads
// must come back to a probe rather than to nothing. Deduped on the project, so
// reopening the modal reattaches to the run in progress instead of starting a
// second one.
app.post('/api/placement/:projectId/start', (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Invalid project id' });
    const project = db.prepare('SELECT id, name, color FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let probe;
    try {
        const existing = getProbe(projectId);
        // A probe already generated is resumed, not rebuilt — regenerating
        // would throw away answers the learner has already given.
        probe = existing && existing.state !== 'failed' && existing.state !== 'done'
            ? existing
            : createProbe(projectId, { limit: Number(req.body?.limit) || undefined });
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }

    if (probe.state === 'ready') {
        return res.json({ probe: publicProbe(probe), alreadyReady: true });
    }

    const { task } = tasks.createTask({
        kind: 'placement',
        label: `Placement — ${project.name}`,
        projectId,
        projectName: project.name,
        projectColor: project.color,
        dedupeKey: `placement:${projectId}`,
        run: async ({ emit, signal }) => {
            const finished = await generateProbeQuestions(probe, { emit, signal });
            return publicProbe(finished);
        },
    });
    attachTaskStream(req, res, task.id);
});

app.post('/api/placement/probe/:probeId/answer', async (req, res) => {
    const probeId = Number(req.params.probeId);
    const { questionIndex, answer } = req.body || {};
    if (!Number.isFinite(probeId) || !Number.isFinite(Number(questionIndex))) {
        return res.status(400).json({ error: 'Missing required fields: probeId, questionIndex' });
    }
    try {
        const result = await answerProbeQuestion(probeId, Number(questionIndex), answer);
        const probe = getProbeById(probeId);
        res.json({ ...result, probe: publicProbe(probe) });
    } catch (error) {
        console.error('[Placement] answer failed:', error);
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/placement/probe/:probeId/finish', (req, res) => {
    const probeId = Number(req.params.probeId);
    if (!Number.isFinite(probeId)) return res.status(400).json({ error: 'Invalid probe id' });
    try {
        const { probe, summary } = finishProbe(probeId);
        res.json({ probe: publicProbe(probe), summary });
    } catch (error) {
        console.error('[Placement] finish failed:', error);
        res.status(400).json({ error: error.message });
    }
});

// The escape hatch. A learner who disagrees with what the probe concluded must
// be able to undo all of it — otherwise taking the probe carries a risk that
// skipping it does not, and the honest move becomes the costly one.
app.delete('/api/placement/:projectId', (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Invalid project id' });
    try {
        res.json(discardProbe(projectId));
    } catch (error) {
        console.error('[Placement] discard failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/today', (req, res) => {
    try {
        res.json(buildTodayData({ decayDays: getGateConfig().decayDays }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// The ledger behind the feed header's chips: every card answered, question
// graded, lesson read and topic closed today, each with its own timestamp.
// `date` is optional and defaults to today (UTC, the app's study-day boundary).
app.get('/api/today/activity', (req, res) => {
    try {
        const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
            ? req.query.date
            : undefined;
        res.json(buildTodayActivity(date));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// LEARNING FEED — the home page's card stream (server/feed.js composes,
// server/feedGen.js pre-generates AI teaching content in the background).

const FEED_LIMIT_MAX = 30;
// 'practice' is consumed server-side by the paper grading endpoints, not by the
// client calling /consume — but it stays listed so a client that does call it
// (e.g. a learner dismissing an exercise) is not rejected.
const FEED_CARD_KINDS = new Set(['lesson', 'question', 'recall', 'practice']);

app.get('/api/feed', (req, res) => {
    try {
        const limit = Math.min(FEED_LIMIT_MAX, Math.max(1, parseInt(req.query.limit, 10) || 15));
        const excludeKeys = new Set(
            String(req.query.exclude || '').split(',').map(s => s.trim()).filter(Boolean)
        );
        const gate = getGateConfig();
        // ?nodeId= scopes the stream to one topic (or a section's leaves): the
        // "Study this" entry from a project. Same composer, same cards.
        const nodeId = parseInt(req.query.nodeId, 10);
        const scopedNode = Number.isInteger(nodeId) && nodeId > 0 ? nodeId : null;
        const { items, exhausted, transfers } = composeFeed({ limit, excludeKeys, gate, nodeId: scopedNode });
        const header = buildFeedHeader();
        res.json({ date: header.date, header, items, exhausted, transfers, nodeId: scopedNode });
        // Top up the teaching buffer in the background (never blocks the
        // response). A topic opened on purpose is written FIRST.
        if (scopedNode) feedGen.requestNode(scopedNode);
        else feedGen.ensureBuffer();
        // Refresh head starts. Fired here rather than on a timer because this is
        // the surface that displays them, and because proving a topic elsewhere
        // (which is what changes them) always ends with the learner back on the
        // feed. Debounced and model-free, so it costs nothing on a rapid scroll.
        scheduleTransferSweep({ threshold: gate.threshold, decayDays: gate.decayDays });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/feed/consume', (req, res) => {
    try {
        const { key, kind, feedItemId, nodeId, result } = req.body || {};
        if (!FEED_CARD_KINDS.has(kind)) {
            return res.status(400).json({ error: `kind must be one of: ${[...FEED_CARD_KINDS].join(', ')}` });
        }
        if ((kind === 'question' || kind === 'recall') && !Number.isInteger(nodeId)) {
            return res.status(400).json({ error: 'nodeId is required for question/recall cards' });
        }
        consumeFeedItem({
            key: typeof key === 'string' ? key : null,
            kind,
            feedItemId: Number.isInteger(feedItemId) ? feedItemId : null,
            nodeId: Number.isInteger(nodeId) ? nodeId : null,
            result: result && typeof result === 'object' ? result : null,
        });
        // Fresh counters so the client header ticks without a full refetch.
        res.json({ ok: true, stats: buildFeedHeader().stats });
        feedGen.ensureBuffer();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PAPER PRACTICE — work it by hand, photograph it, get it marked (server/paper.js).
//
// The photo arrives already perspective-corrected and contrast-boosted by the
// client (src/utils/scan/), which is why the cap here is small: a warped,
// downscaled page is a couple of hundred KB, and anything far above that means
// the client pipeline was bypassed. Keeping the processing client-side also
// keeps the slow leg short — this app is used on a phone over Tailscale, and
// uploading a 4 MB original to warp it server-side would spend the whole
// latency budget on bytes we are about to throw away.
const PAPER_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const paperUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: PAPER_IMAGE_MAX_BYTES, files: 1 },
});

/** Load a practice feed_item and its authored exercise, or null. */
function loadPracticeItem(feedItemId) {
    const row = db.prepare(`SELECT * FROM feed_items WHERE id = ? AND kind = 'practice'`).get(feedItemId);
    if (!row) return null;
    let exercise = null;
    try { exercise = JSON.parse(row.content); } catch { return null; }
    if (!exercise || !Array.isArray(exercise.rubric)) return null;
    return { row, exercise };
}

// Is a trustworthy vision model available? The card asks before showing a camera
// button, so the learner is never invited to photograph work that cannot be
// marked — they get the self-marking flow up front instead.
app.get('/api/paper/capability', async (_req, res) => {
    try {
        const { use, model } = await decidePaperVision();
        res.json({ vision: use === 'yes', model: use === 'yes' ? model : null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// The worked solution. Served ONLY on demand — never bundled with the exercise
// card, which would put the answer key in the page payload before the learner
// has picked up a pen.
app.get('/api/paper/:feedItemId/solution', (req, res) => {
    try {
        const item = loadPracticeItem(parseInt(req.params.feedItemId, 10));
        if (!item) return res.status(404).json({ error: 'Practice item not found' });
        res.json({
            referenceSolution: item.exercise.reference_solution || '',
            rubric: item.exercise.rubric,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Submit a photographed attempt for marking.
app.post('/api/paper/:feedItemId/grade', rejectOversizedBody(12 * 1024 * 1024), paperUpload.single('image'), async (req, res) => {
    try {
        const feedItemId = parseInt(req.params.feedItemId, 10);
        const item = loadPracticeItem(feedItemId);
        if (!item) return res.status(404).json({ error: 'Practice item not found' });
        if (!req.file?.buffer?.length) return res.status(400).json({ error: 'No image uploaded' });

        const result = await gradePaperAttempt({
            nodeId: item.row.node_id,
            feedItemId,
            exercise: item.exercise,
            imageBuffer: req.file.buffer,
        });

        // Only a real grade consumes the card. An unreadable photo or a model
        // failure must leave the exercise standing so the learner can retake it —
        // they did the work, and losing the card over a lighting problem would
        // mean doing it again from scratch.
        if (result.status === 'graded') {
            consumeFeedItem({
                key: `fi-${feedItemId}`, kind: 'practice', feedItemId,
                nodeId: item.row.node_id,
                result: { score: result.grade.score, total: result.grade.total },
            });
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Self-marked attempt (no vision model, or the learner chose to mark their own).
app.post('/api/paper/:feedItemId/self-grade', (req, res) => {
    try {
        const feedItemId = parseInt(req.params.feedItemId, 10);
        const item = loadPracticeItem(feedItemId);
        if (!item) return res.status(404).json({ error: 'Practice item not found' });

        const { metCount } = req.body || {};
        if (!Number.isInteger(metCount) || metCount < 0 || metCount > item.exercise.rubric.length) {
            return res.status(400).json({ error: `metCount must be an integer between 0 and ${item.exercise.rubric.length}` });
        }

        const result = recordSelfGrade({
            nodeId: item.row.node_id,
            feedItemId,
            exercise: item.exercise,
            metCount,
        });
        consumeFeedItem({
            key: `fi-${feedItemId}`, kind: 'practice', feedItemId,
            nodeId: item.row.node_id,
            result: { score: result.score, total: result.total, selfGraded: true },
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// The stored (processed) image of a past attempt — lets a learner look back at
// what the model actually saw when a grade seems wrong.
app.get('/api/paper/attempts/:id/image', (req, res) => {
    try {
        const row = db.prepare('SELECT image_hash FROM paper_attempts WHERE id = ?').get(parseInt(req.params.id, 10));
        if (!row?.image_hash) return res.status(404).json({ error: 'No image stored for this attempt' });
        res.type('image/jpeg').sendFile(vaultStorage.pathFor(row.image_hash));
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

// Overwrite a cached lesson's markdown. Used when a visual block inside a feed
// lesson is repaired, so the fix is persisted exactly like the chat equivalent
// (PUT /api/ai/chat/message/:id). Without this the lesson row keeps the broken
// spec and EVERY page load re-runs the AI repair from scratch — an LLM call per
// reload, and a spinner where the diagram should be.
// Persist a repaired visual spec into the cached card it was read in, for EVERY
// kind of feed card — the lesson this route used to be limited to, and the
// question and practice cards whose stems and briefs carry visuals too. The
// client sends the two specs, never the whole card: the row is the source of
// truth, and for a JSON payload the client does not have its stored form.
app.put('/api/feed/items/:id', (req, res) => {
    try {
        const id = Number(req.params.id);
        const { original, repaired } = req.body || {};
        if (typeof original !== 'string' || !original.trim() || typeof repaired !== 'string' || !repaired.trim()) {
            return res.status(400).json({ error: 'original and repaired (non-empty strings) required' });
        }
        const row = db.prepare('SELECT content FROM feed_items WHERE id = ?').get(id);
        if (!row) return res.status(404).json({ error: 'Feed item not found' });
        const content = replaceSpecInContent(row.content, original, repaired);
        // Not an error: the card may have been regenerated since it was read.
        // The on-screen render is already fixed either way.
        if (content == null) return res.json({ success: true, replaced: false });
        db.prepare('UPDATE feed_items SET content = ? WHERE id = ?').run(content, id);
        res.json({ success: true, replaced: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Due flashcards across every active project — feeds the global review session.
// Same shape as the per-project /flashcards/due, enriched with project identity
// so a mixed-project queue can badge each card.
app.get('/api/flashcards/due', (req, res) => {
    try {
        // Every project introduces its new cards through the same rationed
        // queue (server/decks.js). Counting never-seen cards as "due" here
        // handed the cross-project session 11,886 unseen cards in an 11 MB
        // payload on the real library — the "1,483 due" bug at library scale.
        // That was fixed for imports and left standing for everything else,
        // which is how the same card ended up rationed on one screen and dumped
        // in a pile on another.
        const { reviews, fresh } = globalStudyQueue();
        const enriched = withTopCategory([...reviews, ...fresh]);

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Global calendar feed: scheduled leaves of active projects in a date range.
// GlobalCalendarView's swipe carousel fetches the whole prev→next window in one
// request; in month mode that's three consecutive 6-week grids (up to ~104 days),
// so the cap must clear three month-grids with headroom. The query is a single
// range scan (cost is span-independent), so a generous bound is free.
const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CALENDAR_MAX_RANGE_DAYS = 120;

app.get('/api/calendar', (req, res) => {
    const { from, to } = req.query;
    if (!CALENDAR_DATE_RE.test(from || '') || !CALENDAR_DATE_RE.test(to || '')) {
        return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
    }
    const spanDays = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (!(spanDays >= 0 && spanDays <= CALENDAR_MAX_RANGE_DAYS)) {
        return res.status(400).json({ error: `Range must be 0-${CALENDAR_MAX_RANGE_DAYS} days` });
    }
    try {
        res.json(buildCalendarRange(from, to));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// SERVER

// Production standalone mode: once `npm run build` has produced ./dist, serve the
// built SPA from this same Express origin. That turns the project into a real
// single-origin installable app (no Vite dev server, no two-port mixed-content
// dance) — the difference between a genuine standalone app and a shortcut that
// just reopens the dev server in a window. Stays API-only (dev) when dist is absent.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');
const servingSPA = fs.existsSync(path.join(distDir, 'index.html'));

// Which build is on disk. The page polls this and reloads itself when the answer
// stops matching what it started with — see `src/utils/freshness.ts` and the note
// in server/buildId.js. Deliberately the cheapest endpoint in the app (a stat,
// then a cached string) because it is asked on every focus.
//
// `null` in a dev checkout: there is no dist, Vite's HMR is the freshness story
// there, and the client does nothing with a null.
app.get('/api/build', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ buildId: servingSPA ? buildId(path.join(distDir, 'index.html')) : null });
});

if (servingSPA) {
    // Serve the build's own `.br`/`.gz` twin when the caller takes one. Written
    // by `tools/precompress.mjs` at build time, so this costs a stat, not a
    // compression — and falls through untouched when the files aren't there.
    app.use(precompressedStatic(distDir));
    // Hashed assets are immutable; index.html / sw.js must always revalidate so a
    // rebuild is picked up instead of being pinned by a stale cache.
    app.use(express.static(distDir, {
        setHeaders: (res, filePath) => {
            if (filePath.includes(`${path.sep}assets${path.sep}`)) {
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            } else {
                res.setHeader('Cache-Control', 'no-cache');
            }
        },
    }));
    // SPA history fallback: any non-API GET returns index.html so deep links and
    // client-side routing work. Registered before the error handler below.
    //
    // `no-store`, not express's default `max-age=0`: this is the one response
    // that names every other file by hash, and a deep link served from a
    // heuristically-cached copy is a whole app from the previous build. The
    // static handler above says `no-cache` for the same reason; a fallback that
    // did not would have made deep links the stale door.
    app.use((req, res, next) => {
        if (req.method === 'GET' && !req.path.startsWith('/api')) {
            res.setHeader('Cache-Control', 'no-store');
            return res.sendFile(path.join(distDir, 'index.html'));
        }
        next();
    });
}

app.use((err, req, res, next) => {
    // Log the full error for debugging
    console.error('[Express Error Handler]', err.message || err);

    // If headers haven't been sent yet, send a proper error response
    if (!res.headersSent) {
        res.status(500).json({
            error: 'Internal server error',
            detail: process.env.NODE_ENV !== 'production'
                ? (err.message || String(err))
                : undefined,
        });
    }
    // If headers were already sent (e.g. SSE stream), just end the response
    else {
        try { res.end(); } catch (_) { /* connection already closed */ }
    }
});

const PORT = Number(process.env.PORT) || 3001;

// In standalone mode, serve over HTTPS when locally-trusted certs exist in ./.certs
// (mkcert) — a secure context is required for the PWA to install from a phone on the
// LAN. We only do this when serving the SPA: in dev, Express must stay plain http so
// Vite's proxy (target http://localhost:3001) keeps working.
const certDir = path.resolve(__dirname, '..', '.certs');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');
const httpsOpts = servingSPA && fs.existsSync(keyPath) && fs.existsSync(certPath)
    ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
    : null;

// Bind to loopback by default so the server is NOT directly reachable from the
// LAN or internet — remote access should go through an authenticated tunnel
// (e.g. `tailscale serve`, which proxies to localhost). Override with HOST=0.0.0.0
// only if you explicitly want to expose it on all interfaces (and then a password
// via the security settings is strongly recommended).
const HOST = process.env.HOST || '127.0.0.1';

// Refresh the shipped add-on manifests before serving. The user's enabled/
// disabled choices survive; only the manifests themselves are updated, so a
// corrected URL template reaches existing installs.
try { syncBuiltinProviders(); } catch (e) { console.warn('[SearchProviders] Built-in sync failed:', e.message); }

const server = httpsOpts ? https.createServer(httpsOpts, app) : http.createServer(app);
// Socket timeouts. Nothing here may bound a RESPONSE: SSE streams stay open as
// long as what they stream takes, and the long-lived paths decide this per
// connection themselves — startSseResponse and startAiStream both re-zero their
// own socket timeouts and send keepalive comments, so a thinking model's silent
// minutes are safe without a global free pass. What the defaults below restore
// is the REQUEST half: headers and body must arrive within bounded time, or a
// slow-drip socket parks a connection (and, with memoryStorage uploads, its
// bytes) indefinitely. requestTimeout is raised above Node's 5-minute default
// because a 500 MB deck on a slow link is a real upload here, not an attack.
server.timeout = 0;               // Node default — no socket-inactivity kill (SSE)
server.headersTimeout = 60_000;   // Node default — the slowloris bound
server.keepAliveTimeout = 5_000;  // Node default — idle keep-alive sockets close
server.requestTimeout = 900_000;  // 15 min to RECEIVE a request; Node default is 5 min

/**
 * Listen, and when the port is taken, try the next ones — but only when asked
 * (PORT_FALLBACK=1, which the desktop launcher sets). A developer who starts a
 * second server by mistake wants EADDRINUSE, loudly, on the port they named:
 * silently moving means the Vite proxy keeps talking to the OLD process, with
 * whatever database IT was started against. A desktop user who happens to run
 * something else on 3001 wants the app to open, and the launcher learns the
 * real port from the promise below rather than assuming one.
 */
const PORT_ATTEMPTS = process.env.PORT_FALLBACK === '1' ? 10 : 1;

function listenWithFallback(port, attemptsLeft) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.off('listening', onListening);
            if (err.code === 'EADDRINUSE' && attemptsLeft > 1) {
                console.warn(`[server] Port ${port} is in use — trying ${port + 1}`);
                resolve(listenWithFallback(port + 1, attemptsLeft - 1));
            } else {
                reject(err);
            }
        };
        const onListening = () => {
            server.off('error', onError);
            resolve(port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, HOST);
    });
}

/**
 * Resolves with `{port, host, proto, url}` once the server is accepting
 * connections; rejects when it never will. The desktop launcher awaits this to
 * learn where to point the window. In every other deployment nothing reads it.
 */
export const serverReady = listenWithFallback(PORT, PORT_ATTEMPTS).then((port) => {
    boundPort = port;
    const proto = httpsOpts ? 'https' : 'http';
    console.log(`Server running at ${proto}://localhost:${port} (bound to ${HOST})`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
        console.log(`[security] Listening on ${HOST} — reachable beyond this machine. Set a password in Settings → Security.`);
    }
    if (servingSPA) {
        console.log(`Serving standalone app from ${distDir}`);
    } else {
        console.log('API-only (dev mode) — run `npm run build` to serve the installable standalone app from here.');
    }
    console.log(`Data: ${DB_PATH}`);
    // A restart is the boundary between two runs, and half of reading a log is
    // knowing which run a line belongs to. No path here: `DB_PATH` is a place on
    // someone's disk, which is exactly the kind of fact the export must not carry.
    logActivity({
        area: 'server',
        event: 'server.started',
        detail: `${servingSPA ? 'standalone' : 'api-only'} · node ${process.versions.node} · ${process.platform}`,
    });
    return { port, host: HOST, proto, url: `${proto}://127.0.0.1:${port}` };
});
serverReady.catch((err) => {
    console.error(`[FATAL] Could not listen on ${HOST}:${PORT}: ${err.message}`);
    process.exit(1);
});

/**
 * Stop cleanly: no new connections, the WAL folded into the database file, and
 * the process gone. Used by the desktop lifecycle and by SIGINT/SIGTERM under
 * the launcher. A hard deadline covers a connection that never closes (an SSE
 * stream a browser forgot about) — `server.close` waits for those forever.
 *
 * EXPORTED for one caller: the desktop launcher, which under a Windows tray
 * icon is asked to stop by having its standard input closed. Windows has no
 * SIGTERM to send a child, and the HTTP quit endpoint is behind the password
 * gate — which is right, because that gate is what stops someone on the tailnet
 * shutting the app down, and a tray menu must not need an exception to it.
 */
export function shutdownProcess(reason = 'signal') {
    console.log(`[server] Shutting down (${reason})`);
    const deadline = setTimeout(() => process.exit(0), 3_000);
    deadline.unref();
    try { server.closeAllConnections?.(); } catch { /* older Node */ }
    server.close(() => {
        closeDatabase();
        process.exit(0);
    });
}
if (isDesktop()) {
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdownProcess(sig));
}

// Warm the learning feed's teaching buffer once the server has settled.
feedGen.startupKick();

// Nodes written before `nodes.role` existed: demote the stages the Anki importer
// cut out of card order. One shot (it records a flag), synchronous because it is
// a single indexed UPDATE over one transaction, and here rather than in
// database.js because the rule for what a stage IS lives with the rest of the
// role logic and database.js is what nodeRole.js imports.
try {
    const { updated, skipped } = backfillNodeRoles();
    if (!skipped && updated) console.log(`[Migration] marked ${updated} imported stage node(s) as pagination`);
} catch (e) {
    console.error('[Migration] node role backfill failed (non-fatal):', e.message);
}

// The opt-in update poll. A no-op unless the learner turned it on, which is what
// keeps SECURITY.md's idle-and-capture procedure true on a default install.
startUpdatePoll();

// Reconcile the topic space. Nodes can change while the server is down (a
// restored backup, a hand-edited DB, an upgrade that adds this feature to a
// library built over months), and the sweep is a no-op when nothing drifted —
// so startup is the one place that guarantees the map is never permanently
// behind the curriculum. Deferred well past boot: it wants the model, and the
// feed buffer asked first.
scheduleNodeSync({ delay: 20000 });

// ...and the head starts that ride on it. Behind the embedding sweep, because a
// topic with no vector yet has no twins to find.
scheduleTransferSweep({ delay: 45000, ...getGateConfig() });

// Resume any PDF math recovery interrupted by a restart (its in-memory queue was
// lost but the DB still shows it running/pending). Deferred so it doesn't compete
// with startup; runs on its own serial chain and yields to interactive work.
setTimeout(() => { try { resumePendingRecovery(); } catch { /* never fatal */ } }, 8000);

// Card media the database no longer points at. A staged import holds its blobs
// in memory-free storage rather than in memory, so a crash or a restart between
// inspect and commit strands them; startup is the only place that is guaranteed
// to run afterwards. Deferred past boot because it walks the media directory.
setTimeout(() => {
    const { removed, bytes } = sweepOrphanMedia();
    if (removed) console.log(`[Media] swept ${removed} unreferenced file(s), ${(bytes / 1048576).toFixed(1)} MB`);
}, 12000);
// Draw the atlas before anyone asks for it. Building it from cold takes ~1.8 s
// on a real library (measured 2026-09-09) and 13 ms once the cache behind
// `buildAtlas` is warm — so the only person who ever waited was whoever opened
// the map first after a restart. It reads vectors that are already on disk and
// calls no model, so warming costs nothing but the CPU it would have spent
// anyway; a library with no embeddings resolves immediately with
// `available:false`. Behind the embedding sweep, which may change the answer.
setTimeout(() => {
    buildAtlas().catch(() => { /* nothing has asked yet: a failure is not news */ });
}, 25000);

// Started last, and after the warm-up timers above, so the sweeps this file
// schedules on purpose are not reported as if they were the problem. Silent
// until the one thread actually stops answering. See server/slowLog.js.
startEventLoopMonitor();
