// server/officeProcess.js — mammoth / ExcelJS in a child process of their own,
// started by `parseOfficeIsolated` (extract.js) with a heap ceiling. A document
// whose tree outgrows it ends this process, never the server: a worker thread
// was tried first and V8 aborted the WHOLE process on some inputs ("Reached heap
// limit") before the worker's own out-of-memory handling could step in.

import { parseOffice } from './extract.js';

process.once('message', async ({ kind, buffer }) => {
    let reply;
    try {
        const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        reply = { result: await parseOffice(kind, bytes) };
    } catch (err) {
        reply = { error: String(err?.message || err) };
    }
    process.send(reply, () => process.exit(0));
});
