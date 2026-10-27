// server/officeProcess.js — mammoth / ExcelJS in a child process of their own,
// started by `parseOfficeIsolated` (extract.js) through `runIsolated` with a
// heap ceiling. A document whose tree outgrows it ends this process, never the
// server: in a worker thread V8 aborts the WHOLE process on some inputs
// ("Reached heap limit") before the worker's own out-of-memory handling can
// step in.

import { parseOffice } from './extract.js';
import { serveIsolated } from './isolatedProcess.js';

serveIsolated(({ kind, buffer }) => {
    const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return parseOffice(kind, bytes);
});
