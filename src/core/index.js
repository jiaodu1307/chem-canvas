// Shared, dependency-free JSON transaction kernel. Timestamps are logical revisions.
const kinds = new Set(['molecule', 'question', 'hypothesis', 'evidence', 'plan', 'note', 'reaction', 'task', 'publication']);
const relationKinds = new Set(['relates_to', 'supports', 'contradicts', 'derived_from', 'tests', 'refers_to', 'reactant', 'product', 'reagent', 'catalyst', 'solvent']);
const own = (o, k) => Object.hasOwn(o, k);
const fail = (message, code = 'VALIDATION') => { throw Object.assign(new Error(message), { code }); };
const check = (ok, message, code) => { if (!ok) fail(message, code); };
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const integer = x => Number.isSafeInteger(x) && x >= 0;
const string = x => typeof x === 'string';
const idOK = x => string(x) && x.trim().length > 0 && !['__proto__', 'constructor', 'prototype'].includes(x);
const clone = x => structuredClone(x);
function json(value, seen = new Set()) {
  if (value === null || string(value) || typeof value === 'boolean') return;
  if (typeof value === 'number') return check(Number.isFinite(value), 'JSON numbers must be finite');
  check(Array.isArray(value) || record(value), 'Only plain JSON values are supported');
  check(!seen.has(value), 'Cyclic JSON is not supported');
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    check(typeof key === 'string', 'Symbol keys are not JSON');
    const desc = Object.getOwnPropertyDescriptor(value, key);
    check(desc.enumerable && own(desc, 'value'), 'JSON properties must be enumerable data');
    check(!['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe JSON key');
    json(desc.value, seen);
  }
  if (Array.isArray(value)) check(Object.keys(value).length === value.length, 'Sparse or decorated arrays are not JSON');
  seen.delete(value);
}
function canonical(x) {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (record(x)) return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}
function actor(a) { check(a === 'human' || a === 'agent', 'actor must be human or agent'); }
function fields(value, allowed, name) {
  check(record(value), `${name} must be an object`);
  check(Object.keys(value).every(k => allowed.includes(k)), `Unknown ${name} field`);
}
function domain(d) { return clone({ objects: d.objects, views: d.views, relations: d.relations, proposals: d.proposals, ...(d.schemeLayout ? {schemeLayout:d.schemeLayout} : {}) }); }
function validateDomain(d, revision) {
  check(record(d), 'Domain snapshot must be an object');
  if (own(d,'schemeLayout')) {
    const layout = d.schemeLayout;
    fields(layout,['version','rowWidth','starts','positions'],'scheme layout');
    check(integer(layout.version) && layout.version > 0 && layout.version <= revision && integer(layout.rowWidth) && layout.rowWidth >= 600 && layout.rowWidth <= 2400,'Invalid scheme version or width');
    check(Array.isArray(layout.starts) && layout.starts.every(idOK) && record(layout.positions),'Invalid scheme elements');
    for (const [id,point] of Object.entries(layout.positions)) {
      fields(point,['x','y'],'scheme point');
      check(idOK(id) && [point.x,point.y].every(value=>Number.isFinite(value) && value>=0 && value<=100000),'Invalid scheme position');
    }
  }
  for (const table of ['objects', 'views', 'relations', 'proposals']) check(record(d[table]), `${table} must be a map`);
  for (const [id, o] of Object.entries(d.objects)) {
    check(record(o) && idOK(id) && o.id === id && kinds.has(o.kind) && string(o.title), 'Invalid object');
    check(integer(o.version) && o.version > 0 && record(o.data), 'Invalid object version or data');
    const p = o.provenance;
    check(record(p), 'Object requires provenance'); actor(p.actor); actor(p.createdBy);
    check(integer(p.createdAt) && integer(p.updatedAt) && p.createdAt <= p.updatedAt && p.updatedAt <= revision, 'Invalid logical provenance timestamp');
  }
  for (const [id, v] of Object.entries(d.views)) {
    check(record(v) && idOK(id) && v.id === id && idOK(v.objectId) && own(d.objects, v.objectId), 'Invalid view reference');
    check(['x', 'y', 'width', 'height'].every(k => typeof v[k] === 'number' && Number.isFinite(v[k])) && v.width > 0 && v.height > 0, 'Invalid view geometry');
  }
  for (const [id, r] of Object.entries(d.relations)) {
    check(record(r) && idOK(id) && r.id === id && relationKinds.has(r.kind) && idOK(r.from) && idOK(r.to) && own(d.objects, r.from) && own(d.objects, r.to), 'Invalid relation reference or kind');
    for (const [key, endpoint] of [['sourceVersion', r.from], ['targetVersion', r.to]]) {
      check(integer(r[key]) && r[key] > 0 && r[key] <= d.objects[endpoint].version, 'Invalid relation endpoint version');
    }
    check(!own(r, 'note') || string(r.note), 'Invalid relation note');
    for (const [key, endpoint] of [['fromViewId', r.from], ['toViewId', r.to]]) {
      check(!own(r, key) || idOK(r[key]) && d.views[r[key]]?.objectId === endpoint, 'Invalid relation view anchor');
    }
  }
  for (const [id, p] of Object.entries(d.proposals)) {
    check(record(p) && idOK(id) && p.id === id && p.actor === 'agent' && idOK(p.operationId) && string(p.title) && string(p.rationale), 'Invalid proposal');
    check(integer(p.baselineRevision) && p.expectedRevision === p.baselineRevision && p.createdRevision === p.baselineRevision + 1 && p.createdRevision <= revision, 'Invalid proposal baseline');
    check(['pending', 'accepted', 'rejected'].includes(p.status), 'Invalid proposal status');
    if (own(p, 'reviewFeedback')) {
      check(p.status === 'rejected' && string(p.reviewFeedback) && p.reviewFeedback.trim() && p.reviewFeedback.length <= 4000,
        'Review feedback requires a rejected proposal and 1–4000 characters');
    }
    validateChanges(p.changes);
    if (p.status !== 'pending') {
      actor(p.resolvedBy);
      check(integer(p.resolvedRevision) && p.resolvedRevision > p.createdRevision && p.resolvedRevision <= revision, 'Invalid proposal resolution');
    }
  }
}
export function validateDocument(d) {
  json(d); check(record(d), 'Document must be an object');
  check(d.schemaVersion === 1 && idOK(d.id) && string(d.title) && integer(d.revision), 'Invalid document header');
  validateDomain(d, d.revision);
  check(Array.isArray(d.history) && record(d.appliedOperations) && record(d.identities), 'Invalid history or operation ledger');
  for (const table of ['objects', 'views', 'relations']) {
    check(record(d.identities[table]), 'Missing identity ledger');
    for (const [id, version] of Object.entries(d.identities[table])) check(idOK(id) && integer(version) && version > 0, 'Invalid identity ledger');
    for (const [id, item] of Object.entries(d[table])) check(own(d.identities[table], id) && (table !== 'objects' || d.identities[table][id] === item.version), 'Identity ledger mismatch');
  }
  let last = 0;
  const ops = new Set();
  for (const h of d.history) {
    check(record(h) && idOK(h.operationId) && !ops.has(h.operationId) && integer(h.revision) && h.revision > last && h.revision <= d.revision, 'Invalid history sequence');
    check(['operation', 'proposal', 'accept', 'reject', 'undo'].includes(h.type) && string(h.summary) && typeof h.reversible === 'boolean', 'Invalid history metadata');
    actor(h.actor); validateDomain(h.before, h.revision - 1); validateDomain(h.after, h.revision);
    const receipt = d.appliedOperations[h.operationId];
    check(record(receipt) && receipt.revision === h.revision && string(receipt.request), 'Invalid operation receipt');
    let request; try { request = JSON.parse(receipt.request); } catch { fail('Invalid receipt JSON'); }
    check(record(request) && record(request.input) && request.input.operationId === h.operationId && canonical(request) === receipt.request, 'Invalid operation fingerprint');
    check(request.input.actor === h.actor && integer(request.input.expectedRevision) && request.input.expectedRevision === h.revision - 1, 'Receipt does not match history');
    check(h.type === 'proposal' ? ['proposal', 'molecule-candidate'].includes(request.type) : request.type === (['accept', 'reject'].includes(h.type) ? 'resolve' : h.type), 'Receipt type does not match history');
    check(h.reversible === ['operation', 'accept'].includes(h.type), 'Invalid reversibility marker');
    if (h.type === 'undo') check(idOK(h.undoOf) && ops.has(h.undoOf), 'Invalid undo reference');
    ops.add(h.operationId); last = h.revision;
  }
  check(Object.keys(d.appliedOperations).length === ops.size, 'Untracked operation receipt');
  return true;
}
export function createDocument(input = {}) {
  json(input); check(record(input), 'Document options must be an object');
  const { id, title } = input;
  const d = { schemaVersion: 1, id, title, revision: 0, objects: {}, relations: {}, views: {}, proposals: {}, history: [], appliedOperations: {}, identities: { objects: {}, views: {}, relations: {} } };
  validateDocument(d); return d;
}
function begin(d, input, type) {
  validateDocument(d); json(input); check(record(input), 'Request must be an object');
  check(idOK(input.operationId) && integer(input.expectedRevision), 'operationId and expectedRevision are required'); actor(input.actor);
  const request = canonical({ type, input });
  if (own(d.appliedOperations, input.operationId)) {
    check(d.appliedOperations[input.operationId].request === request, 'operationId was already used with different content', 'CONFLICT');
    return { replay: clone(d) };
  }
  check(d.revision === input.expectedRevision, 'Document revision changed', 'CONFLICT');
  check(Number.isSafeInteger(d.revision + 1), 'Revision limit reached');
  return { next: clone(d), before: domain(d), request };
}
function finish(tx, input, type, summary, reversible, metadata = {}) {
  const d = tx.next; d.revision++;
  d.history.push({ operationId: input.operationId, revision: d.revision, actor: input.actor, type, summary, reversible, ...metadata, before: tx.before, after: domain(d) });
  d.appliedOperations[input.operationId] = { request: tx.request, revision: d.revision };
  validateDocument(d); return d;
}
const specifications = {
  createObject: ['type', 'object'], updateObject: ['type', 'id', 'patch'],
  createView: ['type', 'view'], moveView: ['type', 'id', 'x', 'y'], updateView: ['type', 'id', 'patch'],
  createRelation: ['type', 'relation'], deleteRelation: ['type', 'id'], deleteObject: ['type', 'id'], deleteView: ['type', 'id'],
};
function validateChanges(changes) {
  check(Array.isArray(changes) && changes.length > 0, 'changes must be a nonempty array');
  for (const c of changes) {
    check(record(c) && own(specifications, c.type), 'Unknown change type'); fields(c, specifications[c.type], 'change');
    if (specifications[c.type].includes('id')) check(idOK(c.id), 'Invalid change id');
    if (c.type === 'createObject') {
      fields(c.object, ['id', 'kind', 'title', 'data', 'provenance'], 'object');
      check(idOK(c.object.id) && kinds.has(c.object.kind) && string(c.object.title) && record(c.object.data), 'Invalid new object');
      check(!own(c.object, 'provenance') || record(c.object.provenance), 'Invalid source provenance');
    }
    if (c.type === 'updateObject') {
      fields(c.patch, ['title', 'data'], 'object patch'); check(Object.keys(c.patch).length > 0, 'Empty object patch');
      check(!own(c.patch, 'title') || string(c.patch.title), 'Invalid title');
      check(!own(c.patch, 'data') || record(c.patch.data), 'data must be an object');
    }
    if (c.type === 'createView') {
      fields(c.view, ['id', 'objectId', 'x', 'y', 'width', 'height'], 'view');
      check(idOK(c.view.id) && idOK(c.view.objectId), 'Invalid view id');
      check(['x', 'y', 'width', 'height'].every(k => typeof c.view[k] === 'number' && Number.isFinite(c.view[k])) && c.view.width > 0 && c.view.height > 0, 'Invalid view geometry');
    }
    if (c.type === 'moveView') check(Number.isFinite(c.x) && Number.isFinite(c.y), 'Invalid coordinates');
    if (c.type === 'updateView') {
      fields(c.patch, ['x', 'y', 'width', 'height'], 'view patch');
      check(Object.keys(c.patch).length > 0 && Object.entries(c.patch).every(([k, v]) => Number.isFinite(v) && (!['width', 'height'].includes(k) || v > 0)), 'Invalid view geometry patch');
    }
    if (c.type === 'createRelation') {
      fields(c.relation, ['id', 'kind', 'from', 'to', 'sourceVersion', 'targetVersion', 'note', 'fromViewId', 'toViewId'], 'relation');
      check(idOK(c.relation.id) && idOK(c.relation.from) && idOK(c.relation.to) && relationKinds.has(c.relation.kind), 'Invalid new relation');
      for (const key of ['sourceVersion', 'targetVersion']) check(!own(c.relation, key) || integer(c.relation[key]) && c.relation[key] > 0, 'Invalid endpoint version');
      check(!own(c.relation, 'note') || string(c.relation.note), 'Invalid relation note');
      for (const key of ['fromViewId', 'toViewId']) check(!own(c.relation, key) || idOK(c.relation[key]), 'Invalid relation view anchor ID');
    }
  }
}
function get(d, table, id) { check(idOK(id) && own(d[table], id), `${table} ${id} not found`, 'NOT_FOUND'); return d[table][id]; }
function add(d, table, item) {
  check(!own(d.identities[table], item.id), `${table} id already used`, 'CONFLICT');
  d[table][item.id] = item; d.identities[table][item.id] = item.version ?? 1;
}
function changeDomain(d, changes, by) {
  validateChanges(changes);
  for (const c of changes) {
    if (c.type === 'createObject') {
      const o = clone(c.object);
      o.version = 1; o.provenance = { ...o.provenance, actor: by, createdBy: by, createdAt: d.revision + 1, updatedAt: d.revision + 1 };
      add(d, 'objects', o);
    } else if (c.type === 'updateObject') {
      const o = get(d, 'objects', c.id); Object.assign(o, clone(c.patch)); o.version++;
      o.provenance.actor = by; o.provenance.updatedAt = d.revision + 1; d.identities.objects[o.id] = o.version;
    } else if (c.type === 'createView') {
      get(d, 'objects', c.view.objectId); add(d, 'views', clone(c.view));
    } else if (c.type === 'moveView') {
      Object.assign(get(d, 'views', c.id), { x: c.x, y: c.y });
    } else if (c.type === 'updateView') {
      Object.assign(get(d, 'views', c.id), clone(c.patch));
    } else if (c.type === 'createRelation') {
      const r = clone(c.relation);
      const from = get(d, 'objects', r.from), to = get(d, 'objects', r.to);
      r.sourceVersion ??= from.version; r.targetVersion ??= to.version; add(d, 'relations', r);
    } else if (c.type === 'deleteObject') {
      get(d, 'objects', c.id);
      check(!Object.values(d.views).some(v => v.objectId === c.id) && !Object.values(d.relations).some(r => r.from === c.id || r.to === c.id), 'Object is still referenced', 'CONFLICT');
      delete d.objects[c.id];
    } else {
      if (c.type === 'deleteView') check(!Object.values(d.relations).some(r => r.fromViewId === c.id || r.toViewId === c.id), 'View is still anchored by a relation', 'CONFLICT');
      const table = c.type === 'deleteView' ? 'views' : 'relations'; get(d, table, c.id); delete d[table][c.id];
    }
  }
  validateDomain(d, d.revision + 1);
}
export function applyOperation(document, operation) {
  const tx = begin(document, operation, 'operation'); if (tx.replay) return tx.replay;
  check(string(operation.intent) && operation.intent.trim().length > 0, 'intent is required');
  changeDomain(tx.next, operation.changes, operation.actor);
  return finish(tx, operation, 'operation', operation.intent, true);
}
export function createProposal(document, proposal) {
  return recordProposal(document, proposal, false);
}
// This is a server-internal entry point, not an HTTP request discriminator.
// Only molecule-workflow calls it after the chemistry adapter has constructed
// the candidate. Generic clients cannot opt in through review/scope metadata.
export function createMoleculeCandidateProposal(document, proposal) {
  return recordProposal(document, proposal, true);
}
function recordProposal(document, proposal, scoped) {
  const tx = begin(document, proposal, scoped ? 'molecule-candidate' : 'proposal'); if (tx.replay) return tx.replay;
  check(!own(proposal, 'scope'), 'Proposal scope is kernel-owned');
  check(proposal.actor === 'agent' && idOK(proposal.id) && string(proposal.title) && string(proposal.rationale), 'Invalid proposal');
  check(!own(document.proposals, proposal.id), 'Proposal id already used', 'CONFLICT');
  changeDomain(clone(document), proposal.changes, proposal.actor);
  const scope = scoped ? moleculeCandidateScope(document, proposal) : null;
  tx.next.proposals[proposal.id] = { ...clone(proposal), ...(scope ? { scope } : {}), baselineRevision: document.revision, createdRevision: document.revision + 1, status: 'pending' };
  return finish(tx, proposal, 'proposal', proposal.title, false);
}
function moleculeCandidateScope(baseline, proposal) {
  validateChanges(proposal.changes);
  const [change, view] = proposal.changes;
  const updating = proposal.changes.length === 1 && change.type === 'updateObject' && record(change.patch.data);
  const creating = proposal.changes.length === 2 && change.type === 'createObject' && change.object.kind === 'molecule'
    && view.type === 'createView' && view.view.objectId === change.object.id;
  check(updating || creating, 'Scoped candidates may only update one molecule or create one molecule and its view');
  const objectId = updating ? change.id : change.object.id;
  const object = baseline.objects[objectId];
  check(updating ? object?.kind === 'molecule' : !own(baseline.objects, objectId), 'Invalid candidate target');
  check(record(proposal.review) && proposal.review.kind === 'molecule-candidate' && proposal.review.objectId === objectId
    && proposal.review.baseObjectVersion === (object?.version ?? 0), 'Candidate review does not match its target baseline');
  const relations = Object.values(baseline.relations).filter(r => r.from === objectId || r.to === objectId).sort(byId);
  const objectIds = new Set(updating ? [objectId] : []);
  for (const r of relations) { objectIds.add(r.from); objectIds.add(r.to); }
  return {
    kind: 'molecule-candidate/1', targetObjectId: objectId,
    reads: {
      objects: [...objectIds].sort().map(id => ({ id, version: baseline.objects[id].version })),
      relations: relations.map(r => r.id), relationSets: [objectId],
    },
    writes: { objects: [objectId], views: creating ? [view.view.id] : [], relations: [] },
    creates: { objects: creating ? [objectId] : [], views: creating ? [view.view.id] : [] },
    externalReferences: 'embedded-values-only',
  };
}
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
function proposalConflict(reason, message, details = {}) {
  throw Object.assign(new Error(message), { code: 'CONFLICT', conflict: { reason, message, ...details } });
}
function proposalHistory(document, proposal) {
  const creationIndex = document.history.findIndex(h => h.operationId === proposal.operationId && h.revision === proposal.createdRevision && h.type === 'proposal');
  if (creationIndex < 0) proposalConflict('HISTORY_UNAVAILABLE', 'Proposal baseline history is unavailable');
  const creation = document.history[creationIndex], baseline = creation.after;
  if (canonical(baseline.proposals[proposal.id]) !== canonical(proposal)) proposalConflict('PROPOSAL_CHANGED', 'Proposal differs from its recorded baseline');
  const entries = document.history.slice(creationIndex + 1);
  // A whole, continuous history remains mandatory even for unrelated commits.
  // Verify it before reporting a local conflict so gaps are never hidden.
  let previous = creation;
  for (const entry of entries) {
    if (entry.revision !== previous.revision + 1 || canonical(entry.before) !== canonical(previous.after)) proposalConflict('HISTORY_INCOMPLETE', 'Proposal baseline history is incomplete', { atRevision: entry.revision });
    previous = entry;
  }
  if (previous.revision !== document.revision || canonical(previous.after) !== canonical(domain(document))) proposalConflict('HISTORY_INCOMPLETE', 'Proposal baseline history is incomplete');
  return { creation, baseline, entries };
}
function checkLegacyProposalBaseline(document, proposal, { baseline, entries }) {
  const conflict = message => proposalConflict('GLOBAL_BASELINE_CHANGED', message);
  const writtenViews = new Set(proposal.changes.flatMap(c => c.type === 'createView' ? [c.view.id] : ['moveView', 'updateView', 'deleteView'].includes(c.type) ? [c.id] : []));
  const unchanged = snapshot => {
    for (const table of ['objects', 'relations', 'proposals']) {
      if (canonical(snapshot[table]) !== canonical(baseline[table])) conflict('Proposal baseline content changed; create a new proposal');
    }
    for (const id of writtenViews) {
      if (canonical(snapshot.views[id]) !== canonical(baseline.views[id])) conflict(`Proposal view ${id} changed; create a new proposal`);
    }
  };
  // Inspect every intervening commit, not just the final state: moving a target
  // away and back or temporarily changing content must not hide a conflict.
  for (const entry of entries) {
    const receipt = JSON.parse(document.appliedOperations[entry.operationId].request);
    if (entry.type !== 'operation' || !Array.isArray(receipt.input.changes) || !receipt.input.changes.every(c => ['createView', 'moveView', 'updateView', 'deleteView'].includes(c?.type))) {
      conflict('Only independent layout operations may follow a proposal');
    }
    unchanged(entry.after);
  }
  unchanged(document);
}
function checkScopedProposalBaseline(document, proposal, { creation, baseline, entries }) {
  const receipt = JSON.parse(document.appliedOperations[creation.operationId].request);
  if (receipt.type !== 'molecule-candidate' || own(receipt.input, 'scope')) proposalConflict('UNTRUSTED_SCOPE', 'Proposal scope was not created by the trusted molecule workflow');
  let scope;
  try { scope = moleculeCandidateScope(creation.before, receipt.input); }
  catch { proposalConflict('INVALID_SCOPE', 'Recorded molecule candidate scope is invalid'); }
  const recorded = { ...receipt.input, scope, baselineRevision: creation.revision - 1, createdRevision: creation.revision, status: 'pending' };
  if (canonical(recorded) !== canonical(proposal)) proposalConflict('INVALID_SCOPE', 'Proposal differs from its trusted creation receipt');
  const expectedAfter = clone(creation.before);
  expectedAfter.proposals[proposal.id] = recorded;
  if (own(creation.before.proposals, proposal.id) || canonical(expectedAfter) !== canonical(creation.after)) proposalConflict('INVALID_SCOPE', 'Candidate creation does not match its recorded baseline');
  const incident = snapshot => Object.values(snapshot.relations).filter(r => scope.reads.relationSets.includes(r.from) || scope.reads.relationSets.includes(r.to)).sort(byId);
  const baselineRelations = canonical(incident(baseline));
  const unchanged = (snapshot, atRevision) => {
    if (canonical(snapshot.proposals[proposal.id]) !== canonical(proposal)) proposalConflict('PROPOSAL_CHANGED', 'Proposal changed after creation', { atRevision });
    for (const { id, version } of scope.reads.objects) {
      if (canonical(snapshot.objects[id]) !== canonical(baseline.objects[id])) proposalConflict('OBJECT_CHANGED', `Dependency object ${id} changed; create a new proposal`, { objectId: id, expectedVersion: version, actualVersion: snapshot.objects[id]?.version ?? null, atRevision });
    }
    if (canonical(incident(snapshot)) !== baselineRelations) proposalConflict('RELATIONS_CHANGED', 'Relations involving the candidate molecule changed; create a new proposal', { objectId: scope.targetObjectId, atRevision });
    for (const table of ['objects', 'views']) for (const id of scope.creates[table]) {
      if (own(snapshot[table], id)) proposalConflict('IDENTITY_USED', `Candidate ${table} id ${id} is already used`, { table, id, atRevision });
    }
  };
  unchanged(baseline, creation.revision);
  for (const entry of entries) {
    // Relations created then deleted in a single transaction do not appear in
    // its final snapshot. The actual operation/accepted changes are also read.
    const request = JSON.parse(document.appliedOperations[entry.operationId].request).input;
    const changes = entry.type === 'operation' ? request.changes : entry.type === 'accept' ? entry.before.proposals[request.proposalId]?.changes : [];
    if (!Array.isArray(changes)) proposalConflict('HISTORY_INCOMPLETE', 'History changes are unavailable', { atRevision: entry.revision });
    const touched = changes.find(c => c.type === 'createRelation' && scope.reads.relationSets.some(id => c.relation.from === id || c.relation.to === id)
      || c.type === 'deleteRelation' && scope.reads.relations.includes(c.id));
    if (touched) proposalConflict('RELATIONS_CHANGED', 'Relations involving the candidate molecule were edited; create a new proposal', { objectId: scope.targetObjectId, relationId: touched.relation?.id ?? touched.id, atRevision: entry.revision });
    unchanged(entry.after, entry.revision);
  }
  // Tombstones survive create/delete within one commit and undo of creation.
  for (const table of ['objects', 'views']) for (const id of scope.creates[table]) {
    if (own(document.identities[table], id)) proposalConflict('IDENTITY_USED', `Candidate ${table} id ${id} was already used`, { table, id });
  }
}
function checkProposalBaseline(document, proposal) {
  const history = proposalHistory(document, proposal);
  if (own(proposal, 'scope')) checkScopedProposalBaseline(document, proposal, history);
  else checkLegacyProposalBaseline(document, proposal, history);
}
function proposalAcceptance(document, proposal) {
  const result = { proposalId: proposal.id, proposalStatus: proposal.status, baselineRevision: proposal.baselineRevision,
    currentRevision: document.revision, baselineKind: own(proposal, 'scope') ? 'molecule-candidate/1' : 'document', canAccept: false };
  if (proposal.status !== 'pending') return { ...result, state: 'resolved', conflict: { reason: 'ALREADY_RESOLVED', message: 'Proposal is already resolved' } };
  try {
    checkProposalBaseline(document, proposal);
    changeDomain(clone(document), proposal.changes, 'human');
    return { ...result, canAccept: true, state: 'acceptable', conflict: null };
  } catch (error) {
    return { ...result, state: 'stale', conflict: error.conflict ?? { reason: 'CHANGES_INVALID', code: error.code ?? 'VALIDATION', message: error.message } };
  }
}
// Read-only derived state: pending candidates stay rejectable even when stale.
// Acceptance repeats these checks atomically at the latest expectedRevision.
export function getProposalAcceptance(document, proposalId) {
  validateDocument(document);
  return proposalAcceptance(document, get(document, 'proposals', proposalId));
}
export function getProposalAcceptances(document) {
  validateDocument(document);
  return Object.fromEntries(Object.values(document.proposals).map(p => [p.id, proposalAcceptance(document, p)]));
}
export function resolveProposal(document, resolution) {
  const tx = begin(document, resolution, 'resolve'); if (tx.replay) return tx.replay;
  check(['accept', 'reject'].includes(resolution.action), 'action must be accept or reject');
  const p = get(tx.next, 'proposals', resolution.proposalId);
  check(p.status === 'pending', 'Proposal is already resolved', 'CONFLICT');
  if (resolution.action === 'accept') {
    checkProposalBaseline(document, p);
    changeDomain(tx.next, p.changes, resolution.actor);
  }
  if (own(resolution, 'reviewFeedback')) {
    check(string(resolution.reviewFeedback), 'Review feedback must be text');
    p.reviewFeedback = resolution.reviewFeedback.trim();
  }
  p.status = resolution.action === 'accept' ? 'accepted' : 'rejected'; p.resolvedBy = resolution.actor; p.resolvedRevision = document.revision + 1;
  return finish(tx, resolution, resolution.action, `${resolution.action}: ${p.title}`, resolution.action === 'accept');
}
export function saveSchemeLayout(document, request, layout) {
  request = {...request,changes:[]};
  const tx = begin(document, request, 'operation'); if (tx.replay) return tx.replay;
  check(request.expectedLayoutVersion === (document.schemeLayout?.version ?? 0),'Scheme layout changed','CONFLICT');
  tx.next.schemeLayout = {...layout,version:document.revision+1};
  return finish(tx,request,'operation','Edit scheme layout',true,{schemeEdit:true});
}
export function undoOperation(document, request) {
  const tx = begin(document, request, 'undo'); if (tx.replay) return tx.replay;
  const latest = document.history.at(-1);
  check(latest?.reversible, 'Latest history entry cannot be undone', 'CONFLICT');
  const restored = clone(latest.before);
  // Restore content, but never recycle object version numbers or entity identities.
  for (const [id, o] of Object.entries(restored.objects)) {
    if (!own(document.objects, id) || canonical(o) !== canonical(document.objects[id])) {
      o.version = tx.next.identities.objects[id] + 1;
      o.provenance.actor = request.actor; o.provenance.updatedAt = document.revision + 1;
      tx.next.identities.objects[id] = o.version;
    }
  }
  // An undone acceptance stays recorded as resolved; its original baseline cannot be reused.
  if (latest.type === 'accept') restored.proposals = clone(document.proposals);
  Object.assign(tx.next, restored);
  if (!restored.schemeLayout) delete tx.next.schemeLayout;
  else if (latest.schemeEdit) tx.next.schemeLayout.version=document.revision+1;
  return finish(tx, request, 'undo', `undo: ${latest.summary}`, false, { undoOf: latest.operationId });
}
