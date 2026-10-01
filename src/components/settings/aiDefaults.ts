// The endpoints the server talks to when nothing is saved: `DEFAULT_OLLAMA_URL`
// and `DEFAULT_OPENAI_BASE_URL` in server/ai.js, which the page cannot import.
// Settings starts its fields on these and shows them as the placeholder, so a
// fresh install sees the address it is actually using.
// tools/settings-defaults-gates.mjs fails when the two copies disagree.
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
