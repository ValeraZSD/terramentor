/**
 * Updating an installed course from a newer file: what changes, decided as
 * arithmetic over three snapshots.
 *
 * - `upstream`: the course as the newer file writes it.
 * - `local`:    the course as it stands in this library now.
 * - `base`:     what each author-owned field held when the course was installed
 *               or last updated (a hash per field), whether the learner has
 *               edited that field since (set only by the routes a person edits
 *               through), and the `exported_at` of that file.
 *
 * The rule per field is the three-way one package managers use for config
 * files: the file did not change it, keep the local value; the file changed it
 * and the local value is the base one, or was changed by the app itself (a
 * repaired visual, a model-written Overview), take the file's; the file changed
 * it AND the learner edited it, a conflict, which keeps the learner's version
 * unless they choose otherwise. A field with no base (a course installed before
 * the base was recorded) that differs is a conflict too: nothing says who
 * changed it.
 *
 * Per item: new in the file, inserted; moved, moved (the row keeps its id, so
 * mastery, evidence and the review history follow it); gone from the file,
 * deleted only when nothing of the learner's hangs on it, otherwise kept and
 * reported. A question the author rewrote loses its ask-record, so it counts as
 * never asked; evidence is aggregate and stays.
 *
 * The learner's state never appears here: every write this plan asks for is to
 * an author-owned field or to a row nothing of the learner's hangs on. The
 * plan is deterministic, so running it again after it was applied plans
 * nothing; and nothing here reads the database or a file, which is what lets
 * `tools/course-update-gates.mjs` assert the rules on bare objects.
 */
import { createHash } from 'node:crypto';

/** The author-owned fields of each kind of item. `parent` is the owning node's
 *  uuid (a topic's parent, a question's, card's or link's topic). */
export const ENTITY_FIELDS = Object.freeze({
    node: ['title', 'description', 'is_note', 'role', 'parent'],
    question: ['content', 'parent'],
    card: ['front', 'back', 'extra', 'extra_front', 'media', 'parent'],
    resource: ['title', 'url', 'type', 'parent'],
});
export const PROJECT_FIELDS = Object.freeze(['name', 'description', 'content_language', 'learning_language', 'version']);
/** Kinds in the order they are matched: an item's topic must be matched first. */
export const KINDS = Object.freeze(['node', 'question', 'card', 'resource']);
/** Kinds whose order among siblings is the author's. */
const ORDERED = new Set(['node', 'resource']);

/** JSON with sorted keys and `undefined` as `null`, so equal values hash equally. */
export function canonical(value) {
    if (value === undefined || value === null) return 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (typeof value === 'object') {
        return `{${Object.keys(value).sort().filter(k => value[k] !== undefined)
            .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export const fieldHash = (value) => createHash('sha256').update(canonical(value)).digest('hex').slice(0, 32);

/** What two items' text is compared by when a file carries no ids: case, spacing
 *  and markup do not make a different card. */
export function matchText(s) {
    return String(s ?? '').normalize('NFKC').replace(/<[^>]*>/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The fallback key of an item: what an author would call "the same one". */
const fallbackKey = (e) => {
    switch (e.kind) {
        case 'node': return matchText(e.fields.title);
        case 'question': return matchText(e.fields.content?.question);
        case 'card': return matchText(e.fields.front);
        case 'resource': return matchText(e.fields.url || e.fields.title);
        default: return '';
    }
};
/** An item's text, for telling items apart by what they say. Media is left
 *  out: a plain JSON file brings none, and a card is the same card with or
 *  without its picture. */
const contentHash = (e) => fieldHash(Object.fromEntries(ENTITY_FIELDS[e.kind]
    .filter(f => f !== 'parent' && f !== 'media').map(f => [f, e.fields[f] ?? null])));

/**
 * Plan an update.
 *
 * @param {object} args
 * @param {{ exportedAt?: string|null, project: { fields: object }, entities: Array<{
 *   kind: string, uuid?: string|null, ref?: string, parentRef?: string|null, position?: number,
 *   fields: object, label?: string, where?: string }> }} args.upstream
 *   in file order, every node before its children. `ref` names an item inside
 *   the file (its uuid, or a made-up key when it has none); `parentRef` names
 *   its owner by that ref.
 * @param {{ project: { fields: object }, entities: Array<{ kind: string, uuid: string, id: number,
 *   parentUuid?: string|null, position?: number, fields: object, hasState?: boolean, label?: string, where?: string }> }} args.local
 * @param {{ exportedAt?: string|null, project: { fields: object }, entities: Map<string, { fields: Record<string, { hash: string, edited: boolean }> }> }} args.base
 *   keyed `${kind}:${uuid}`; project fields `{ field: { hash, edited } }`.
 * @param {Record<string, 'file'|'mine'>} [args.choices]  per conflict key; absent = mine
 */
export function planCourseUpdate({ upstream, local, base, choices = {} }) {
    const baseEntities = base?.entities instanceof Map ? base.entities : new Map();
    if (base?.exportedAt && upstream.exportedAt && String(upstream.exportedAt) < String(base.exportedAt)) {
        return { refused: 'older', installedAt: base.exportedAt, fileAt: upstream.exportedAt };
    }

    const key = (kind, uuid) => `${kind}:${uuid}`;
    const localByKey = new Map(local.entities.map(e => [key(e.kind, e.uuid), e]));
    const ups = upstream.entities.map((e, i) => ({ ...e, ref: e.ref ?? e.uuid ?? `#${i}` }));
    const upByRef = new Map(ups.map(e => [e.ref, e]));

    // ---- matching ---------------------------------------------------------------
    /** upstream ref -> the local entity it is. */
    const matched = new Map();
    const claimed = new Set();
    /** upstream refs no local item could be told apart for, and the local items involved. */
    const ambiguous = new Set();
    const protectedLocal = new Set();
    /** The local name of an upstream topic: its local uuid, or `new:<ref>` once it will be inserted. */
    const localParentOf = (ref) => {
        if (ref == null) return null;
        const m = matched.get(ref);
        if (m) return m.uuid;
        const up = upByRef.get(ref);
        return up && !ambiguous.has(ref) ? `new:${ref}` : undefined;
    };
    /** The name an upstream item is known by here. A question's id is unique
     *  only within its topic (curriculumSchema.js), so it is named through it. */
    const upKey = (u) => {
        if (!u.uuid) return null;
        return u.kind === 'question' ? `${localParentOf(u.parentRef) ?? ''}/${u.uuid}` : u.uuid;
    };

    for (const kind of KINDS) {
        const mine = ups.filter(e => e.kind === kind);
        for (const u of mine) {
            const l = u.uuid ? localByKey.get(key(kind, upKey(u))) : null;
            if (l && !claimed.has(l)) { matched.set(u.ref, l); claimed.add(l); }
        }
        // Files that predate item ids: an item the file names by no id is
        // matched by its text, within its topic, among the local items no id in
        // the file claimed. (An item the file DOES name by an id it does not
        // share with any local one is new: matching it by text would be a guess.
        // A course installed from such a file has ids minted here, which no file
        // will ever name, so the base rows under them do not stop the match.)
        const candidates = local.entities.filter(e => e.kind === kind && !claimed.has(e));
        const sameOwner = (u, l) => (localParentOf(u.parentRef) ?? null) === (l.parentUuid ?? null);
        const left = mine.filter(u => !matched.has(u.ref) && !u.uuid);
        for (const u of left) {
            const exact = candidates.find(l => !claimed.has(l) && sameOwner(u, l) && contentHash(l) === contentHash(u));
            if (exact) { matched.set(u.ref, exact); claimed.add(exact); }
        }
        for (const u of left) {
            if (matched.has(u.ref)) continue;
            const k = fallbackKey(u);
            if (!k) continue;
            const pool = candidates.filter(l => !claimed.has(l) && sameOwner(u, l) && fallbackKey(l) === k);
            if (!pool.length) continue;
            const peers = left.filter(o => !matched.has(o.ref) && fallbackKey(o) === k
                && (localParentOf(o.parentRef) ?? null) === (localParentOf(u.parentRef) ?? null));
            if (pool.length === 1 && peers.length === 1) { matched.set(u.ref, pool[0]); claimed.add(pool[0]); continue; }
            ambiguous.add(u.ref);
            pool.forEach(l => protectedLocal.add(l));
        }
    }

    // ---- per field ----------------------------------------------------------------
    const ops = [];
    const conflicts = [];
    const newBase = [];
    const touchedParents = new Set();   // `${kind}|${parent}`: siblings to put in the file's order
    const finalParent = new Map();      // local entity -> its parent after the plan
    const chosen = (k) => choices?.[k] === 'file';

    /** One field, three ways. Returns 'take' | 'keep' | 'same' | 'conflict'. */
    const decide = (up, loc, b) => {
        const uh = fieldHash(up);
        const lh = fieldHash(loc);
        if (uh === lh) return 'same';
        if (!b) return 'conflict';
        if (uh === b.hash) return 'keep';
        if (lh === b.hash || !b.edited) return 'take';
        return 'conflict';
    };

    for (const u of ups) {
        const l = matched.get(u.ref);
        if (!l) continue;
        const b = baseEntities.get(key(u.kind, l.uuid));
        const take = {};
        const baseFields = {};
        const upFields = { ...u.fields, parent: localParentOf(u.parentRef) ?? null };
        const localFields = { ...l.fields, parent: l.parentUuid ?? null };
        for (const f of ENTITY_FIELDS[u.kind]) {
            if (!(f in upFields) || upFields[f] === undefined && f === 'media') continue;
            const prev = b?.fields?.[f];
            const verdict = decide(upFields[f], localFields[f] ?? null, prev);
            const ck = `${u.kind}:${l.uuid}:${f}`;
            let edited = prev?.edited ? 1 : 0;
            if (verdict === 'take' || (verdict === 'conflict' && chosen(ck))) { take[f] = upFields[f]; edited = 0; }
            else if (verdict === 'same') edited = 0;
            else if (verdict === 'conflict') {
                edited = 1;
                conflicts.push({ key: ck, kind: u.kind, uuid: l.uuid, id: l.id, field: f, label: l.label ?? u.label, where: l.where ?? u.where,
                    mine: localFields[f] ?? null, file: upFields[f], unknownBase: !prev });
            }
            baseFields[f] = { hash: fieldHash(upFields[f]), edited };
        }
        if (ORDERED.has(u.kind)) {
            baseFields.position = { hash: fieldHash(u.position ?? null), edited: 0 };
            const prevPos = b?.fields?.position;
            if (!prevPos || prevPos.hash !== baseFields.position.hash) touchedParents.add(`${u.kind}|${upFields.parent}`);
        }
        finalParent.set(l, 'parent' in take ? take.parent : (l.parentUuid ?? null));
        if ('parent' in take) {
            if (ORDERED.has(u.kind)) touchedParents.add(`${u.kind}|${take.parent}`);
            if (ORDERED.has(u.kind)) touchedParents.add(`${u.kind}|${l.parentUuid ?? null}`);
        }
        if (Object.keys(take).length) {
            // Named as the learner's course shows it now, as a conflict is: the
            // file's title may be one they renamed and would not recognise.
            const op = { op: 'update', kind: u.kind, id: l.id, uuid: l.uuid, fields: take, source: u.source, label: l.label ?? u.label, where: l.where ?? u.where };
            // A rewritten question is a different question to the learner: its
            // ask-record goes, so it is drawn as never asked. Moving it does the
            // same, because the record is filed under the bank it was asked from.
            if (u.kind === 'question') op.clearAsked = true;
            if (u.kind === 'card' && l.hasState && ('front' in take || 'back' in take)) op.reviewedTextChanged = true;
            ops.push(op);
        }
        newBase.push({ kind: u.kind, uuid: l.uuid, fields: baseFields });
    }

    // ---- new in the file, or deleted here ----------------------------------------------
    for (const u of ups) {
        if (matched.has(u.ref) || ambiguous.has(u.ref)) continue;
        const parent = localParentOf(u.parentRef);
        // A link, question or card whose topic is not coming has nowhere to go.
        if (u.kind !== 'node' && u.parentRef != null && parent === undefined) { ambiguous.add(u.ref); continue; }
        const b = u.uuid ? baseEntities.get(key(u.kind, upKey(u))) : null;
        const upFields = { ...u.fields, parent: parent ?? null };
        const baseFields = Object.fromEntries(ENTITY_FIELDS[u.kind].filter(f => upFields[f] !== undefined)
            .map(f => [f, { hash: fieldHash(upFields[f]), edited: 0 }]));
        if (ORDERED.has(u.kind)) baseFields.position = { hash: fieldHash(u.position ?? null), edited: 0 };
        if (b) {
            // The learner deleted it. Unchanged in the file: it stays deleted.
            const changed = ENTITY_FIELDS[u.kind].some(f => f !== 'parent' && b.fields?.[f] && b.fields[f].hash !== fieldHash(upFields[f]));
            const ck = `${u.kind}:${upKey(u)}:deleted`;
            if (!changed) { newBase.push({ kind: u.kind, uuid: upKey(u), fields: baseFields }); continue; }
            if (!chosen(ck)) {
                conflicts.push({ key: ck, kind: u.kind, uuid: upKey(u), field: 'deleted', label: u.label, where: u.where, mine: null, file: u.fields, unknownBase: false });
                newBase.push({ kind: u.kind, uuid: upKey(u), fields: baseFields });
                continue;
            }
        }
        ops.push({ op: 'insert', kind: u.kind, ref: u.ref, uuid: u.uuid ?? null, parent: parent ?? null, position: u.position ?? 0,
            fields: u.fields, source: u.source, label: u.label, where: u.where, baseFields });
        if (ORDERED.has(u.kind)) touchedParents.add(`${u.kind}|${parent ?? null}`);
    }

    // ---- gone from the file ---------------------------------------------------------------
    const gone = local.entities.filter(l => !claimed.has(l) && !protectedLocal.has(l) && baseEntities.has(key(l.kind, l.uuid)));
    const goneSet = new Set(gone);
    const deleting = new Set();
    for (const l of gone) {
        if (l.kind === 'question' || ((l.kind === 'card' || l.kind === 'resource') && !l.hasState)) deleting.add(l);
    }
    // A topic goes only when nothing of the learner's is on it and everything
    // that will still be under it goes too. Children first, until nothing moves.
    const ownerAfter = (e) => (finalParent.has(e) ? finalParent.get(e) : (e.parentUuid ?? null));
    const goneNodes = gone.filter(l => l.kind === 'node' && !l.hasState);
    let moved = true;
    while (moved) {
        moved = false;
        for (const n of goneNodes) {
            if (deleting.has(n)) continue;
            const rest = local.entities.filter(e => ownerAfter(e) === n.uuid && !deleting.has(e));
            const inserts = ops.some(o => o.op === 'insert' && o.parent === n.uuid);
            if (!rest.length && !inserts) { deleting.add(n); moved = true; }
        }
    }
    // What is under a dropped topic follows the topic: kept with it when the
    // learner's progress keeps it, gone with it otherwise. Either way the preview
    // names the topic, not each thing in it.
    const goneNodeByUuid = new Map(gone.filter(l => l.kind === 'node').map(l => [l.uuid, l]));
    for (const l of gone) {
        const topic = goneNodeByUuid.get(ownerAfter(l));
        const inKeptTopic = !!topic && !deleting.has(topic);
        const op = deleting.has(l) && !inKeptTopic ? 'delete' : 'keepRemoved';
        ops.push({ op, kind: l.kind, id: l.id, uuid: l.uuid, label: l.label, where: l.where,
            clearAsked: op === 'delete' && l.kind === 'question', withTopic: !!topic });
    }

    // ---- the course itself ---------------------------------------------------------------
    const projectTake = {};
    const projectBase = {};
    for (const f of PROJECT_FIELDS) {
        if (upstream.project?.fields?.[f] === undefined) continue;
        const up = upstream.project.fields[f];
        const loc = local.project?.fields?.[f] ?? null;
        const prev = base?.project?.fields?.[f];
        const verdict = decide(up, loc, prev);
        const ck = `project::${f}`;
        let edited = prev?.edited ? 1 : 0;
        if (verdict === 'take' || (verdict === 'conflict' && chosen(ck))) { projectTake[f] = up; edited = 0; }
        else if (verdict === 'same') edited = 0;
        else if (verdict === 'conflict') {
            edited = 1;
            conflicts.push({ key: ck, kind: 'project', field: f, label: local.project?.fields?.name ?? null, mine: loc, file: up, unknownBase: !prev });
        }
        projectBase[f] = { hash: fieldHash(up), edited };
    }

    // ---- sibling order ----------------------------------------------------------------------
    // The file's order for the siblings it knows; a sibling it does not know
    // (the learner's own, or kept after the file dropped it) stays right after
    // the sibling it followed here.
    const reorder = [];
    for (const tp of touchedParents) {
        const [kind, rawParent] = tp.split('|');
        const parent = rawParent === 'null' ? null : rawParent;
        const fileOrder = ups.filter(u => u.kind === kind && !ambiguous.has(u.ref) && (localParentOf(u.parentRef) ?? null) === parent)
            .map(u => {
                const l = matched.get(u.ref);
                if (l) return ownerAfter(l) === parent ? l.uuid : null;
                return ops.some(o => o.op === 'insert' && o.ref === u.ref) ? `new:${u.ref}` : null;
            })
            .filter(Boolean);
        const known = new Set(fileOrder);
        const oldSiblings = local.entities.filter(e => e.kind === kind && (e.parentUuid ?? null) === parent)
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id - b.id);
        const others = local.entities.filter(e => e.kind === kind && ownerAfter(e) === parent && !known.has(e.uuid) && !deleting.has(e));
        const result = [...fileOrder];
        for (const o of others) {
            const at = oldSiblings.indexOf(o);
            let anchor = -1;
            for (let i = at - 1; i >= 0 && anchor < 0; i--) anchor = result.indexOf(oldSiblings[i].uuid);
            result.splice(anchor + 1, 0, o.uuid);
        }
        reorder.push({ kind, parent, children: result });
    }

    // ---- what the learner is shown ----------------------------------------------------------
    const labelled = (o) => ({ kind: o.kind, label: o.label ?? '', where: o.where ?? null });
    const updates = ops.filter(o => o.op === 'update');
    const contentChanged = updates.filter(o => Object.keys(o.fields).some(f => f !== 'parent'));
    const items = {
        changed: contentChanged.map(o => ({ ...labelled(o), fields: Object.keys(o.fields).filter(f => f !== 'parent') })),
        moved: updates.filter(o => 'parent' in o.fields).map(labelled),
        added: ops.filter(o => o.op === 'insert').map(labelled),
        removed: ops.filter(o => o.op === 'delete' && !o.withTopic).map(labelled),
        keptRemoved: ops.filter(o => o.op === 'keepRemoved' && !o.withTopic).map(labelled),
        reviewedCardsChanged: updates.filter(o => o.reviewedTextChanged).map(labelled),
        ambiguous: [...ambiguous].map(ref => labelled(upByRef.get(ref))),
        project: Object.keys(projectTake),
    };
    const summary = {
        changed: items.changed.length,
        moved: items.moved.length,
        added: items.added.length,
        removed: items.removed.length,
        keptRemoved: items.keptRemoved.length,
        conflicts: conflicts.length,
        ambiguous: items.ambiguous.length,
        reviewedCardsChanged: items.reviewedCardsChanged.length,
        questionsReset: updates.filter(o => o.clearAsked).length,
        projectFields: items.project.length,
    };
    summary.nothing = !ops.length && !conflicts.length && !items.project.length && !items.ambiguous.length;

    return {
        refused: null,
        ops,
        project: projectTake,
        projectBase,
        reorder: summary.nothing ? [] : reorder,
        conflicts,
        newBase,
        exportedAt: upstream.exportedAt ?? base?.exportedAt ?? null,
        summary,
        items,
    };
}
