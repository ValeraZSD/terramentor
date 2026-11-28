/**
 * The hard suite: 100 cases built to spread models apart, where the standard
 * suite tops out near full marks for every strong model. Same family format as
 * cases/index.mjs; run it with `--suite hard`.
 *
 * Three things keep the floor low. Closed questions are solved cold by the
 * answer-key checker with six options or six to eight items to order, and the
 * distractors are the answers the usual mistake leads to. Judging tasks come
 * in pairs (a right answer that looks wrong with a wrong one that looks right,
 * a sound lesson segment with its planted twin), so a model that always says
 * yes or always says no scores nothing. Paper marking is scored on the exact
 * per-point vector.
 */
import { familyLoader } from '../suites.mjs';

const FAMILIES = ['math', 'science', 'code', 'language', 'knowledge', 'unsound', 'grading', 'audit', 'paper'];

export const { loadFamilies, loadCases } = familyLoader(import.meta.url, FAMILIES);
