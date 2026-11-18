import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from '../store';

/**
 * The language a course is written in, for the `lang` attribute on its text.
 *
 * `<html lang>` is the interface language. A course's lessons and cards are
 * often in another (`projects.content_language`, an ISO code, '' = not
 * declared), and a screen reader picks its voice from `lang`: Dutch read by an
 * English voice is noise. So the surfaces that show one course's text (the
 * workspace, a feed card, a review card) provide its language here, and the
 * components that render course text (`Markdown`, `CardFace`) put it on their
 * own root. Buttons and labels around them stay in the interface language.
 */
const ContentLangContext = createContext<string | undefined>(undefined);

/** A stored `content_language` as a `lang` value, or undefined when there is none to give. */
export function langAttr(code: string | null | undefined): string | undefined {
    const s = (code ?? '').trim();
    return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(s) ? s : undefined;
}

/** The `lang` for course text rendered here, or undefined to inherit the page's. */
export function useContentLang(): string | undefined {
    return useContext(ContentLangContext);
}

/** Course text inside takes the language of project `projectId`; `null` clears it (the assistant). */
export function ContentLang({ projectId, children }: { projectId: number | null | undefined; children: ReactNode }) {
    const code = useStore(s => (projectId == null ? undefined : s.projects.find(p => p.id === projectId)?.content_language));
    return <ContentLangContext.Provider value={langAttr(code)}>{children}</ContentLangContext.Provider>;
}
