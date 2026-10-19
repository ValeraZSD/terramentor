// Chat changes that are not a new turn: a message rewritten in place (a visual
// repaired and written back). The task feed forwards them, so every device
// showing that conversation reloads it instead of keeping the old text.
const listeners = new Set();

export function onChatChanged(fn) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function notifyChatChanged(conversationId) {
    for (const fn of listeners) {
        try { fn({ conversationId }); } catch { /* one dead socket must not stop the rest */ }
    }
}
