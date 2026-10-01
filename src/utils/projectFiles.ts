import { api } from '../api';
import type { ImportResult } from '../types';

/**
 * The two file formats a project travels in, and the one place that knows how
 * each is written and read. Every screen that offers an import or an export
 * goes through here, so a door cannot quietly support only one of them.
 *
 * - `.studyvault`: the whole course in one zip. Topics, questions and cards,
 *   the pictures and audio the cards name, the files uploaded to the vault.
 * - `.json`: the structure alone. Human-readable, and it carries no bytes, so a
 *   card's media and the vault's originals stay behind.
 *
 * A whole library is a `.studyvault` too (one course per project, side by side);
 * the importer tells the two apart by what the archive holds.
 */
export type ExportFormat = 'studyvault' | 'json';

/** What the learner chose to add to the curriculum, which always ships. */
export interface ExportChoices {
    format: ExportFormat;
    /** Private notes: off unless the learner turned them on. */
    includeNotes: boolean;
    includeProgress: boolean;
    includeResources: boolean;
}

/** The `accept` of every file picker that takes a course. */
export const IMPORT_ACCEPT = '.json,.studyvault';

/** Save a blob under a name. The object URL is revoked late: the browser reads
 *  the blob after the click, and a synchronous revoke cancels a large download
 *  with no error anywhere. */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The file name a JSON export is saved under: Latin-only slugs made every
 *  Russian or Japanese course save as `______`, so letters of any script stay. */
function jsonFileName(projectName: string): string {
    const slug = projectName.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'project';
    return `${slug}-${new Date().toISOString().split('T')[0]}.json`;
}

/** Export one project in the chosen format and hand it to the browser. */
export async function exportProjectToFile(projectId: number, c: ExportChoices): Promise<{ filename: string }> {
    if (c.format === 'studyvault') {
        const { blob, filename } = await api.exportBundle(projectId, c);
        downloadBlob(blob, filename);
        return { filename };
    }
    const data = await api.exportProject(projectId, c);
    const filename = jsonFileName(data.project.name);
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename);
    return { filename };
}

/** Import a `.studyvault` (a course or a whole library) or a `.json` file
 *  through the matching server door. Always makes NEW projects. */
export async function importProjectFile(file: File): Promise<ImportResult> {
    if (/\.studyvault$/i.test(file.name)) return api.importBundle(file);
    const data = JSON.parse(await file.text());
    if (!data?.project?.name || !Array.isArray(data.nodes)) throw new Error('Invalid project file format');
    return api.importProject(data);
}
