import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useStore } from '../store';
import { taughtLanguage } from './searchProviders';
import type { CourseLanguages } from './pronunciation';

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
 *
 * The same provider carries the language the course TEACHES, if any, for the
 * card lines a speaker can say (`utils/pronunciation.ts`).
 */
const ContentLangContext = createContext<string | undefined>(undefined);
const CourseLanguagesContext = createContext<CourseLanguages | null>(null);

/** A stored `content_language` as a `lang` value, or undefined when there is none to give. */
export function langAttr(code: string | null | undefined): string | undefined {
    const s = (code ?? '').trim();
    return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(s) ? s : undefined;
}

/** The `lang` for course text rendered here, or undefined to inherit the page's. */
export function useContentLang(): string | undefined {
    return useContext(ContentLangContext);
}

/** The course's two languages when it teaches one, else null. */
export function useCourseLanguages(): CourseLanguages | null {
    return useContext(CourseLanguagesContext);
}

/** Course text inside takes the language of project `projectId`; `null` clears it (the assistant). */
export function ContentLang({ projectId, children }: { projectId: number | null | undefined; children: ReactNode }) {
    const project = (s: ReturnType<typeof useStore.getState>) => (projectId == null ? undefined : s.projects.find(p => p.id === projectId));
    const code = useStore(s => project(s)?.content_language);
    const stored = useStore(s => project(s)?.learning_language);
    const name = useStore(s => project(s)?.name);
    const description = useStore(s => project(s)?.description);
    const known = name !== undefined;
    const langs = useMemo<CourseLanguages | null>(() => {
        if (!known) return null;
        const learning = langAttr(taughtLanguage({ learningLanguage: stored, name, description }));
        return learning ? { learning, content: langAttr(code) ?? '' } : null;
    }, [known, stored, name, description, code]);
    return (
        <ContentLangContext.Provider value={langAttr(code)}>
            <CourseLanguagesContext.Provider value={langs}>{children}</CourseLanguagesContext.Provider>
        </ContentLangContext.Provider>
    );
}
