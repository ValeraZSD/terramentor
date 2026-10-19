// Chat changes that are not a new turn: a message rewritten in place (a visual
// repaired and written back). The task feed forwards them, so every device
// showing that conversation reloads it instead of keeping the old text.
const listeners = new Set();

export function onChatChanged(fn) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** `from` is the writing window's own id (or null), so it can skip its echo. */
export function notifyChatChanged(conversationId, from = null) {
    for (const fn of listeners) {
        try { fn({ conversationId, from }); } catch { /* one dead socket must not stop the rest */ }
    }
}
