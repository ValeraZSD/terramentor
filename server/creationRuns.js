// The AI project creations running right now, read by the creation routes and by the chat.

// AI PROJECT CREATION (SSE)

// Registry of in-flight AI generations, keyed by projectId. Lets the
// cancel endpoint reach into a running generation and actually stop it
// (abort the Ollama request + break the phase loop) rather than merely
// disconnecting the SSE stream and letting it finish in the background.
const activeGenerations = new Map();

export { activeGenerations };
