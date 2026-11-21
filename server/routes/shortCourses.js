// Short courses from a link or a file (server/shortCourses.js): read a source,
// make a course of it, list them for the strip on Projects, write one again.
import multer from 'multer';
import { createShortCourse, discardSource, listShortCourses, readSource, retryShortCourse, ShortCourseError } from '../shortCourses.js';
import { MAX_FILE_BYTES } from '../extract.js';
import { rejectOversizedBody } from '../uploadGuard.js';
import { routeTable } from './routeTable.js';
import { errorBody, keyed } from '../clientError.js';

const app = routeTable('shortCourses');

// One file, held in memory as the vault's own upload holds it. Browsers send a
// file's name as UTF-8 and multer reads it as latin1 unless told otherwise, so
// "Hoofdstuk één.pdf" would become the course's name as mojibake.
const oneFile = multer({ storage: multer.memoryStorage(), defParamCharset: 'utf8', limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
const handleOneFile = (req, res, next) =>
    rejectOversizedBody(MAX_FILE_BYTES + 1024 * 1024)(req, res, () =>
        oneFile.single('file')(req, res, (err) => {
            if (err) {
                if (err.code === 'LIMIT_FILE_SIZE') return res.json({ ok: false, reason: 'too_large', fix: null });
                return res.status(400).json(errorBody(err, 400));
            }
            next();
        }));

/** An AbortSignal that fires when the client goes away before the answer. */
function closedSignal(res) {
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    return ac.signal;
}

function fail(res, e) {
    if (e instanceof ShortCourseError) return res.status(e.status).json({ ...errorBody(e, e.status), ...e.extra });
    return res.status(500).json(errorBody(e, 500));
}

// Read: an unreadable source is an ANSWER (200, `ok: false`, its reason and
// what to do next), not an error; only a request with nothing to read is.
app.post('/api/short-courses/read', async (req, res) => {
    const { url, transcript, title } = req.body || {};
    try {
        res.json(await readSource({ url, transcript, title }, { acceptLanguage: req.headers['accept-language'], signal: closedSignal(res) }));
    } catch (e) {
        fail(res, e);
    }
});

app.post('/api/short-courses/read-file', handleOneFile, async (req, res) => {
    if (!req.file) return res.status(400).json(keyed('No file uploaded'));
    try {
        res.json(await readSource({ buffer: req.file.buffer, filename: req.file.originalname }, { acceptLanguage: req.headers['accept-language'] }));
    } catch (e) {
        fail(res, e);
    }
});

app.delete('/api/short-courses/read/:stagedId', (req, res) => {
    res.json({ ok: discardSource(req.params.stagedId) });
});

app.post('/api/short-courses', async (req, res) => {
    const via = req.body?.via === 'assistant' ? 'assistant' : 'projects';
    try {
        res.json(await createShortCourse(req.body || {}, {
            acceptLanguage: req.headers['accept-language'],
            origin: { surface: via },
            signal: closedSignal(res),
        }));
    } catch (e) {
        fail(res, e);
    }
});

app.get('/api/short-courses', (req, res) => {
    res.json({ courses: listShortCourses() });
});

app.post('/api/short-courses/:projectId/retry', (req, res) => {
    try {
        res.json(retryShortCourse(req.params.projectId));
    } catch (e) {
        fail(res, e);
    }
});

export const routes = app.takeRoutes();
