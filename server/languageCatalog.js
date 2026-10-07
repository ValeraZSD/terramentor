/**
 * The content languages a course can be written in, with nothing else in the
 * file: no database, so the browser can import it too (the New course dialog
 * reads it through `learningLanguage.js`). `language.js` re-exports it.
 *
 * `scripts` lists the writing systems a lesson in this language is entitled to
 * use. `closerPatterns` presence is informational — the catalog is deliberately
 * wider than `CLOSERS`, because refusing to let someone study in Czech until
 * somebody writes a Czech regex would be the wrong trade.
 */
export const LANGUAGES = [
    { code: 'en', name: 'English', endonym: 'English', scripts: [] },
    { code: 'nl', name: 'Dutch', endonym: 'Nederlands', scripts: [] },
    { code: 'de', name: 'German', endonym: 'Deutsch', scripts: [] },
    { code: 'fr', name: 'French', endonym: 'Français', scripts: [] },
    { code: 'es', name: 'Spanish', endonym: 'Español', scripts: [] },
    { code: 'it', name: 'Italian', endonym: 'Italiano', scripts: [] },
    { code: 'pt', name: 'Portuguese', endonym: 'Português', scripts: [] },
    { code: 'pl', name: 'Polish', endonym: 'Polski', scripts: [] },
    { code: 'ro', name: 'Romanian', endonym: 'Română', scripts: [] },
    { code: 'uk', name: 'Ukrainian', endonym: 'Українська', scripts: ['Cyrillic'] },
    { code: 'ru', name: 'Russian', endonym: 'Русский', scripts: ['Cyrillic'] },
    { code: 'cs', name: 'Czech', endonym: 'Čeština', scripts: [] },
    { code: 'sv', name: 'Swedish', endonym: 'Svenska', scripts: [] },
    { code: 'da', name: 'Danish', endonym: 'Dansk', scripts: [] },
    { code: 'nb', name: 'Norwegian', endonym: 'Norsk', scripts: [] },
    { code: 'fi', name: 'Finnish', endonym: 'Suomi', scripts: [] },
    { code: 'hu', name: 'Hungarian', endonym: 'Magyar', scripts: [] },
    { code: 'el', name: 'Greek', endonym: 'Ελληνικά', scripts: [] },
    { code: 'tr', name: 'Turkish', endonym: 'Türkçe', scripts: [] },
    { code: 'bg', name: 'Bulgarian', endonym: 'Български', scripts: ['Cyrillic'] },
    { code: 'sr', name: 'Serbian', endonym: 'Српски', scripts: ['Cyrillic'] },
    { code: 'ja', name: 'Japanese', endonym: '日本語', scripts: ['Kana', 'Han'] },
    { code: 'zh', name: 'Chinese', endonym: '中文', scripts: ['Han'] },
    { code: 'ko', name: 'Korean', endonym: '한국어', scripts: ['Hangul'] },
    { code: 'ar', name: 'Arabic', endonym: 'العربية', scripts: ['Arabic'] },
    { code: 'he', name: 'Hebrew', endonym: 'עברית', scripts: ['Hebrew'] },
    { code: 'hi', name: 'Hindi', endonym: 'हिन्दी', scripts: ['Devanagari'] },
];
