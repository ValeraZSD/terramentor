// server/ankiCollectionProcess.js — reads one Anki collection file and turns its
// notes into cards, in a child process of its own, started by
// `readCollectionIsolated` (ankiCollection.js) with a heap ceiling and a time
// limit. Whatever the file makes SQLite or the text patterns do ends here, never
// in the server.

import { readDeckCards } from './ankiCollection.js';
import { serveIsolated } from './isolatedProcess.js';

serveIsolated(({ path }) => readDeckCards(path));
