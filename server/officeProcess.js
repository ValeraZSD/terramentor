// server/officeProcess.js — mammoth / ExcelJS in a child process of their own,
// started by `parseOfficeIsolated` (extract.js) with a heap ceiling. A document
// whose tree outgrows it ends this process, never the server: in a worker thread
// V8 aborts the WHOLE process on some inputs ("Reached heap limit") before the
// worker's own out-of-memory handling can step in.

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
