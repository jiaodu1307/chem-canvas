import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, validateDocument, applyOperation, createProposal, createMoleculeCandidateProposal,
  resolveProposal, undoOperation, getProposalAcceptance, getProposalAcceptances } from '../../src/core/index.js';

const object = (id, kind = 'molecule') => ({ type: 'createObject', object: { id, kind, title: id, data: { smiles: 'CCO' } } });
const view = (id, objectId) => ({ type: 'createView', view: { id, objectId, x: 20, y: 30, width: 300, height: 210 } });
const relation = (id, from = 'm', to = 'h') => ({ type: 'createRelation', relation: { id, from, to, kind: 'refers_to' } });
const run = (d, changes, operationId = `operation-${d.revision}`) => applyOperation(d, { operationId, expectedRevision: d.revision, actor: 'human', intent: 'Edit research', changes });
const seed = () => run(createDocument({ id: 'doc', title: 'Scoped proposals' }), [object('m'), view('v', 'm'), object('h', 'hypothesis'), object('u', 'note'), object('n'), view('nv', 'n')]);
const input = (d, id = 'p', target = 'm') => ({ id, operationId: `propose-${id}`, expectedRevision: d.revision, actor: 'agent', title: id, rationale: 'Compare a candidate',
  changes: [{ type: 'updateObject', id: target, patch: { data: { smiles: id === 'p' ? 'CCN' : 'CCF' } } }],
  review: { kind: 'molecule-candidate', objectId: target, baseObjectVersion: d.objects[target].version, delta: { summary: id } } });
const propose = (d, id = 'p', target = 'm') => createMoleculeCandidateProposal(d, input(d, id, target));
const resolution = (d, proposalId = 'p', action = 'accept') => ({ operationId: `${action}-${proposalId}-${d.revision}`, expectedRevision: d.revision, actor: 'human', proposalId, action });
const resolve = (d, proposalId = 'p', action = 'accept') => resolveProposal(d, resolution(d, proposalId, action));
const undoRequest = d => ({ operationId: `undo-${d.revision}`, expectedRevision: d.revision, actor: 'human' });
const undo = d => undoOperation(d, undoRequest(d));
const freshInput = (d, id = 'p') => ({ id, operationId: `propose-${id}`, expectedRevision: d.revision, actor: 'agent', title: id, rationale: 'New drawing',
  changes: [object('new-m'), view('new-view', 'new-m')], review: { kind: 'molecule-candidate', objectId: 'new-m', baseObjectVersion: 0, delta: {} } });
const assertAcceptable = (d, id = 'p') => assert.equal(getProposalAcceptance(d, id).canAccept, true, JSON.stringify(getProposalAcceptance(d, id)));
function assertStale(d, reason, id = 'p') {
  const before = structuredClone(d), status = getProposalAcceptance(d, id);
  assert.equal(status.state, 'stale'); assert.equal(status.canAccept, false); assert.equal(status.conflict.reason, reason);
  assert.throws(() => resolve(d, id), e => e.code === 'CONFLICT');
  assert.deepEqual(d, before);
  return status.conflict;
}

test('review feedback belongs to one rejection, survives replay and cannot be supplied by proposing a candidate', () => {
  const baseline = seed(), pending = propose(baseline);
  const request = { ...resolution(pending, 'p', 'reject'), reviewFeedback: '  保留末端氧，\n只调整标签。  ' };
  const rejected = resolveProposal(pending, request);
  assert.deepEqual(rejected.objects, pending.objects);
  assert.equal(rejected.proposals.p.status, 'rejected');
  assert.equal(rejected.proposals.p.reviewFeedback, '保留末端氧，\n只调整标签。');
  assert.deepEqual(resolveProposal(rejected, request), rejected);
  assert.throws(() => resolveProposal(rejected, { ...request, reviewFeedback: '另一条意见' }), { code: 'CONFLICT' });
  for (const reviewFeedback of ['  ', 42, 'a'.repeat(4001)]) {
    assert.throws(() => resolveProposal(pending, { ...request, reviewFeedback }), { code: 'VALIDATION' });
  }
  assert.throws(() => createProposal(baseline, { ...input(baseline), reviewFeedback: '未经评阅' }), { code: 'VALIDATION' });
  assert.equal(pending.proposals.p.reviewFeedback, undefined);
});

test('same-molecule alternatives coexist through unrelated edits/proposals; one choice explicitly invalidates the other', () => {
  let d = seed(), firstRequest = input(d);
  d = createMoleculeCandidateProposal(d, firstRequest);
  const first = structuredClone(d.proposals.p);
  d = propose(d, 'alternative');
  d = run(d, [{ type: 'updateObject', id: 'u', patch: { title: 'Unrelated note' } }, { type: 'moveView', id: 'v', x: 400, y: 500 }]);
  d = createProposal(d, { ...input(d, 'generic', 'n'), changes: [object('other')] });
  d = resolve(d, 'generic', 'reject');
  const before = structuredClone(d), statuses = getProposalAcceptances(d);
  assert.equal(statuses.p.canAccept, true); assert.equal(statuses.alternative.canAccept, true); assert.deepEqual(d, before);
  assert.deepEqual(d.proposals.p, first);
  assert.deepEqual(createMoleculeCandidateProposal(d, firstRequest), d);
  const accept = resolution(d), accepted = resolveProposal(d, accept);
  assert.equal(accepted.objects.m.data.smiles, 'CCN'); assert.equal(accepted.objects.m.version, 2);
  assert.deepEqual(accepted.views, d.views); assert.deepEqual(accepted.objects.u, d.objects.u);
  assert.equal(accepted.proposals.alternative.status, 'pending');
  const conflict = assertStale(accepted, 'OBJECT_CHANGED', 'alternative');
  assert.equal(conflict.objectId, 'm'); assert.equal(conflict.expectedVersion, 1); assert.equal(conflict.actualVersion, 2); assert.equal(conflict.atRevision, accepted.revision);
  assert.equal(getProposalAcceptance(accepted, 'p').state, 'resolved');
  assert.deepEqual(resolveProposal(accepted, accept), accepted);
  const rejected = resolve(accepted, 'alternative', 'reject');
  assert.deepEqual(rejected.objects, accepted.objects); assert.deepEqual(rejected.views, accepted.views);
});

test('choosing the second alternative first works; undo cannot revive or replay either old baseline', () => {
  const d = propose(propose(seed()), 'alternative'), request = resolution(d, 'alternative');
  const accepted = resolveProposal(d, request), undone = undo(accepted);
  assert.equal(accepted.objects.m.data.smiles, 'CCF'); assert.equal(undone.objects.m.data.smiles, 'CCO'); assert.equal(undone.objects.m.version, 3);
  assert.equal(undone.proposals.alternative.status, 'accepted');
  assertStale(undone, 'OBJECT_CHANGED');
  assert.deepEqual(resolveProposal(undone, request), undone);
  assert.throws(() => resolve(undone, 'alternative'), e => e.code === 'CONFLICT');
});

test('accept/reject/undo on other molecules do not invalidate an independent candidate', () => {
  let d = propose(seed());
  d = propose(d, 'other', 'n'); d = resolve(d, 'other'); assertAcceptable(d);
  d = undo(d); assertAcceptable(d);
  d = propose(d, 'reject-me', 'n'); d = resolve(d, 'reject-me', 'reject'); assertAcceptable(d);
  d = run(d, [{ type: 'updateObject', id: 'u', patch: { title: 'Temporary unrelated change' } }]);
  d = undo(d); assertAcceptable(d);
  assert.equal(resolve(d).objects.m.data.smiles, 'CCN');
});

test('related endpoint objects and the exact incident relation set are auditable dependencies', () => {
  const d = propose(run(seed(), [relation('r')]));
  assert.deepEqual(d.proposals.p.scope, {
    kind: 'molecule-candidate/1', targetObjectId: 'm',
    reads: { objects: [{ id: 'h', version: 1 }, { id: 'm', version: 1 }], relations: ['r'], relationSets: ['m'] },
    writes: { objects: ['m'], views: [], relations: [] }, creates: { objects: [], views: [] }, externalReferences: 'embedded-values-only',
  });
  const changed = run(d, [{ type: 'updateObject', id: 'h', patch: { title: 'New evidence interpretation' } }]);
  assert.equal(assertStale(changed, 'OBJECT_CHANGED').objectId, 'h');
  assertStale(undo(changed), 'OBJECT_CHANGED');
  assertStale(run(d, [{ type: 'deleteRelation', id: 'r' }]), 'RELATIONS_CHANGED');
  assertStale(run(d, [relation('new-link', 'u', 'm')]), 'RELATIONS_CHANGED');
  const unrelatedRelation = run(d, [relation('elsewhere', 'h', 'u')]);
  assertAcceptable(unrelatedRelation);
  const accepted = resolve(unrelatedRelation);
  assert.deepEqual(accepted.relations, unrelatedRelation.relations);
  assert.equal(accepted.relations.r.sourceVersion, 1); assert.equal(accepted.objects.m.version, 2);
});

test('new, removed, restored, and transient incident relationships always stale a candidate', () => {
  const d = propose(seed());
  const added = run(d, [relation('r')]);
  assertStale(added, 'RELATIONS_CHANGED');
  assertStale(run(added, [{ type: 'deleteRelation', id: 'r' }]), 'RELATIONS_CHANGED');
  assertStale(undo(added), 'RELATIONS_CHANGED');
  const transient = run(d, [relation('temporary'), { type: 'deleteRelation', id: 'temporary' }]);
  assert.deepEqual(transient.relations, d.relations);
  assertStale(transient, 'RELATIONS_CHANGED');
  const generic = createProposal(d, { ...input(d, 'relationship'), changes: [relation('temporary'), { type: 'deleteRelation', id: 'temporary' }] });
  assertAcceptable(generic);
  assertStale(resolve(generic, 'relationship'), 'RELATIONS_CHANGED');
});

test('dependencies are one hop; opaque embedded references are protected but never dereferenced', () => {
  const base = run(seed(), [relation('r'), relation('second-hop', 'h', 'u'), { type: 'updateObject', id: 'm', patch: { data: { smiles: 'CCO', source: { url: 'https://example.invalid/evidence', objectId: 'u', sha256: 'snapshot-hash' } } } }]);
  const d = propose(base);
  assert.deepEqual(d.proposals.p.scope.reads.objects.map(x => x.id), ['h', 'm']);
  assertAcceptable(run(d, [{ type: 'updateObject', id: 'u', patch: { title: 'Outside one-hop dependency' } }]));
  const changedData = structuredClone(d.objects.m.data); changedData.source.sha256 = 'changed';
  assertStale(run(d, [{ type: 'updateObject', id: 'm', patch: { data: changedData } }]), 'OBJECT_CHANGED');
});

test('delete/recreate attempts and undo of target deletion cannot reuse a molecular baseline', () => {
  const d = propose(seed());
  const deleted = run(d, [{ type: 'deleteView', id: 'v' }, { type: 'deleteObject', id: 'm' }]);
  assert.equal(assertStale(deleted, 'OBJECT_CHANGED').actualVersion, null);
  assert.throws(() => run(deleted, [object('m')]), e => e.code === 'CONFLICT');
  const restored = undo(deleted); assert.equal(restored.objects.m.version, 2); assertStale(restored, 'OBJECT_CHANGED');
});

test('same-value updates, temporary changes back, and update undo all invalidate old molecule versions', () => {
  const d = propose(seed());
  const changed = run(d, [{ type: 'updateObject', id: 'm', patch: { title: 'Temporary title' } }]);
  const changedBack = run(changed, [{ type: 'updateObject', id: 'm', patch: { title: d.objects.m.title } }]);
  assertStale(changedBack, 'OBJECT_CHANGED'); assertStale(undo(changed), 'OBJECT_CHANGED');
  assertStale(run(d, [{ type: 'updateObject', id: 'm', patch: { data: d.objects.m.data } }]), 'OBJECT_CHANGED');
});

test('target and unrelated card moves/create/delete/undo preserve candidate and latest layout', () => {
  let d = propose(seed());
  d = run(d, [{ type: 'moveView', id: 'v', x: 300, y: 400 }, { type: 'moveView', id: 'nv', x: 100, y: 100 }]);
  d = undo(d); assertAcceptable(d);
  d = run(d, [{ type: 'deleteView', id: 'v' }, view('replacement-view', 'm'), { type: 'moveView', id: 'nv', x: 800, y: 900 }]);
  const accepted = resolve(d); assert.deepEqual(accepted.views, d.views);
  const undone = undo(accepted); assert.deepEqual(undone.views, d.views);
  assert.equal(undone.views.v, undefined); assert.equal(undone.views.nv.x, 800);
});

test('new drawings coexist; object/view identity consumption conflicts even after deletion in the same commit', () => {
  const base = seed(), request = freshInput(base), d = createMoleculeCandidateProposal(base, request);
  assert.equal(d.proposals.p.scope.reads.objects.length, 0);
  const unrelated = propose(run(d, [{ type: 'updateObject', id: 'm', patch: { title: 'Changed existing molecule' } }] ), 'existing');
  assertAcceptable(unrelated);
  const accepted = resolve(unrelated); assert.equal(accepted.objects['new-m'].version, 1); assert.equal(accepted.views['new-view'].objectId, 'new-m');
  const undone = undo(accepted); assert.equal(undone.objects['new-m'], undefined); assert.equal(undone.proposals.p.status, 'accepted');
  assert.deepEqual(createMoleculeCandidateProposal(undone, request), undone);
  const objectCollision = run(d, [object('new-m'), { type: 'deleteObject', id: 'new-m' }]);
  assertStale(objectCollision, 'IDENTITY_USED');
  const viewCollision = run(d, [view('new-view', 'm'), { type: 'deleteView', id: 'new-view' }]);
  assertStale(viewCollision, 'IDENTITY_USED');
  const occupying = run(d, [object('new-m')]); assertStale(occupying, 'IDENTITY_USED'); assertStale(undo(occupying), 'IDENTITY_USED');
});

test('complete history, continuity, and the recorded proposal remain required after unrelated commits', () => {
  const d = propose(seed()), next = run(d, [{ type: 'updateObject', id: 'u', patch: { title: 'Unrelated' } }]);
  const missingCreation = structuredClone(next);
  missingCreation.history = missingCreation.history.filter(h => h.operationId !== d.proposals.p.operationId);
  delete missingCreation.appliedOperations[d.proposals.p.operationId];
  assertStale(missingCreation, 'HISTORY_UNAVAILABLE');
  const missingEntry = structuredClone(next); const removed = missingEntry.history.pop(); delete missingEntry.appliedOperations[removed.operationId];
  assertStale(missingEntry, 'HISTORY_INCOMPLETE');
  const gap = structuredClone(d); gap.revision++; assertStale(gap, 'HISTORY_INCOMPLETE');
  const discontinuous = structuredClone(next); discontinuous.history.at(-1).before.objects.u.title = 'unrecorded';
  assertStale(discontinuous, 'HISTORY_INCOMPLETE');
  const unrecorded = structuredClone(next); unrecorded.objects.u.title = 'not in history'; assertStale(unrecorded, 'HISTORY_INCOMPLETE');
  const tampered = structuredClone(d); tampered.proposals.p.changes[0].patch.data.smiles = 'C'; assertStale(tampered, 'PROPOSAL_CHANGED');
});

test('generic review metadata is never authority; scopes and their origin receipts are kernel-owned', () => {
  const base = seed(), request = input(base), legacy = createProposal(base, request);
  assert.equal(legacy.proposals.p.scope, undefined);
  const unrelated = run(legacy, [{ type: 'updateObject', id: 'u', patch: { title: 'Unrelated' } }]);
  assertStale(unrelated, 'GLOBAL_BASELINE_CHANGED');
  const trusted = createMoleculeCandidateProposal(base, request);
  assert.throws(() => createProposal(base, { ...request, scope: trusted.proposals.p.scope }), /kernel-owned/);
  assert.throws(() => createMoleculeCandidateProposal(base, { ...request, scope: trusted.proposals.p.scope }), /kernel-owned/);
  assert.throws(() => createProposal(trusted, request), e => e.code === 'CONFLICT');
  const forged = structuredClone(legacy);
  forged.proposals.p.scope = trusted.proposals.p.scope; forged.history.at(-1).after.proposals.p.scope = trusted.proposals.p.scope;
  assertStale(forged, 'UNTRUSTED_SCOPE');
  const narrowed = structuredClone(trusted);
  narrowed.proposals.p.scope.reads.objects = []; narrowed.history.at(-1).after.proposals.p.scope.reads.objects = [];
  assertStale(narrowed, 'INVALID_SCOPE');
  const alteredCreation = structuredClone(trusted);
  alteredCreation.history.at(-1).after.objects.m.title = 'Unrecorded creation mutation';
  alteredCreation.objects.m.title = 'Unrecorded creation mutation';
  assertStale(alteredCreation, 'INVALID_SCOPE');
});

test('trusted entry rejects unsupported scopes and mismatched target claims without writes', () => {
  const base = seed(), request = input(base), before = structuredClone(base);
  for (const bad of [
    { ...request, changes: [...request.changes, relation('r')] },
    { ...request, changes: [object('one'), object('two')] },
    { ...request, changes: [{ type: 'updateObject', id: 'u', patch: { data: {} } }] },
    { ...request, review: { ...request.review, baseObjectVersion: 20 } },
    { ...request, review: { ...request.review, objectId: 'n' } },
    { ...request, changes: [{ type: 'updateObject', id: 'm', patch: { title: 'Missing molecule data' } }] },
  ]) assert.throws(() => createMoleculeCandidateProposal(base, bad), e => e.code === 'VALIDATION');
  assert.deepEqual(base, before);
});

test('acceptance still requires current document revision; retries retain full-content idempotency and JSON persistence', () => {
  const d = propose(seed()), request = resolution(d), later = run(d, [{ type: 'moveView', id: 'v', x: 1, y: 2 }]);
  assertAcceptable(later);
  assert.throws(() => resolveProposal(later, request), e => e.code === 'CONFLICT');
  const persisted = JSON.parse(JSON.stringify(later)); assert.equal(validateDocument(persisted), true); assertAcceptable(persisted);
  const valid = resolution(persisted), accepted = resolveProposal(persisted, valid), undoInput = undoRequest(accepted), undone = undoOperation(accepted, undoInput);
  assert.deepEqual(resolveProposal(undone, valid), undone); assert.deepEqual(undoOperation(undone, undoInput), undone);
  assert.throws(() => resolveProposal(undone, { ...valid, actor: 'agent' }), e => e.code === 'CONFLICT');
  const rejected = resolve(d, 'p', 'reject'), rejection = resolution(d, 'p', 'reject');
  assert.deepEqual(resolveProposal(rejected, rejection), rejected);
  assert.throws(() => getProposalAcceptance(d, 'missing'), e => e.code === 'NOT_FOUND');
});
