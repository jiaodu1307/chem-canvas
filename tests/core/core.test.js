import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, validateDocument, applyOperation, createProposal, resolveProposal, undoOperation } from '../../src/core/index.js';

const fresh = () => createDocument({ id: 'doc', title: 'Research' });
const object = (id = 'm', kind = 'molecule') => ({ type: 'createObject', object: { id, kind, title: id, data: { smiles: 'CCO' }, provenance: { source: 'input' } } });
const view = (id = 'v', objectId = 'm') => ({ type: 'createView', view: { id, objectId, x: 0, y: 10, width: 300, height: 210 } });
const op = (d, changes, operationId = `op-${d.revision}`, actor = 'human') => ({ operationId, expectedRevision: d.revision, actor, intent: 'Research edit', changes });
const run = (d, changes, id, actor) => applyOperation(d, op(d, changes, id, actor));
const seed = () => run(fresh(), [object(), view(), object('h', 'hypothesis')]);
const throws = (fn, code = 'VALIDATION') => assert.throws(fn, e => e.code === code && typeof e.message === 'string');
const proposal = d => ({ id: 'p', operationId: 'propose', expectedRevision: d.revision, actor: 'agent', title: 'Try candidate', rationale: 'Test a hypothesis', changes: [object('candidate'), view('candidate-view', 'candidate')] });
const resolve = (d, action = 'accept', id = 'resolve') => ({ proposalId: 'p', action, operationId: id, expectedRevision: d.revision, actor: 'human' });
const undo = d => ({ operationId: `undo-${d.revision}`, expectedRevision: d.revision, actor: 'human' });

test('JSON round trip, pure deterministic operations, core-owned provenance and initial versions', () => {
  const d = fresh(), request = op(d, [object()]);
  const before = JSON.stringify(d), requestBefore = JSON.stringify(request);
  const next = applyOperation(d, request);
  assert.equal(JSON.stringify(d), before); assert.equal(JSON.stringify(request), requestBefore);
  assert.deepEqual(applyOperation(d, request), next);
  assert.equal(next.objects.m.version, 1); assert.equal(next.objects.m.provenance.actor, 'human');
  assert.equal(next.objects.m.provenance.source, 'input'); assert.equal(next.revision, 1);
  assert.equal(validateDocument(JSON.parse(JSON.stringify(next))), true);
  next.objects.m.data.smiles = 'C'; assert.equal(request.changes[0].object.data.smiles, 'CCO');
});

test('failed transaction leaves all source state and idempotency ledger unchanged', () => {
  const d = seed(), before = structuredClone(d);
  throws(() => run(d, [object('new'), { type: 'moveView', id: 'missing', x: 2, y: 3 }]), 'NOT_FOUND');
  assert.deepEqual(d, before);
  const next = run(d, [object('new')]); assert.equal(next.revision, 2);
});

test('stale revisions conflict; identical retries return current state even after later changes', () => {
  const d = fresh(), request = op(d, [object()], 'request');
  const first = applyOperation(d, request), later = run(first, [object('other')]);
  assert.deepEqual(applyOperation(later, request), later);
  throws(() => applyOperation(later, { ...request, operationId: 'fresh-id' }), 'CONFLICT');
  throws(() => applyOperation(later, { ...request, intent: 'changed' }), 'CONFLICT');
  const reordered = { changes: request.changes, intent: request.intent, actor: request.actor, expectedRevision: 0, operationId: 'request' };
  assert.deepEqual(applyOperation(later, reordered), later);
});

test('layout is separate; data replacement preserves object id and increments version', () => {
  const d = seed(); const moved = run(d, [{ type: 'moveView', id: 'v', x: -200.5, y: 900 }]);
  assert.deepEqual(moved.objects, d.objects);
  const updated = run(moved, [{ type: 'updateObject', id: 'm', patch: { title: 'Methane', data: { smiles: 'C' } } }], undefined, 'agent');
  assert.equal(updated.objects.m.id, 'm'); assert.equal(updated.objects.m.version, 2);
  assert.deepEqual(updated.objects.m.data, { smiles: 'C' }); assert.equal(updated.objects.m.provenance.createdBy, 'human');
  assert.equal(updated.objects.m.provenance.actor, 'agent');
  throws(() => run(updated, [{ type: 'updateObject', id: 'm', patch: { id: 'h' } }]));
});

test('relations pin versions and retain historical evidence after content changes', () => {
  const d = run(seed(), [{ type: 'createRelation', relation: { id: 'r', kind: 'supports', from: 'm', to: 'h' } }]);
  const updated = run(d, [{ type: 'updateObject', id: 'm', patch: { data: { smiles: 'C' } } }]);
  assert.equal(updated.relations.r.sourceVersion, 1); assert.equal(updated.objects.m.version, 2);
  throws(() => run(d, [{ type: 'createRelation', relation: { id: 'bad', kind: 'supports', from: 'm', to: 'missing' } }]), 'NOT_FOUND');
  throws(() => run(d, [{ type: 'createRelation', relation: { id: 'bad', kind: 'supports', from: 'm', to: 'h', sourceVersion: 10 } }]));
});

test('deletion requires removing references first and deleted identities cannot be reused', () => {
  const d = seed(); throws(() => run(d, [{ type: 'deleteObject', id: 'm' }]), 'CONFLICT');
  const removed = run(d, [{ type: 'deleteView', id: 'v' }, { type: 'deleteObject', id: 'm' }]);
  assert.equal(removed.objects.m, undefined);
  throws(() => run(removed, [object()]), 'CONFLICT');
  throws(() => run(d, [object()]), 'CONFLICT');
  const restored = undoOperation(removed, undo(removed));
  assert.equal(restored.objects.m.version, 2); assert.equal(restored.views.v.objectId, 'm');
});

test('proposals are validated without applying domain changes and accepted atomically', () => {
  const d = seed(), input = proposal(d), pending = createProposal(d, input);
  assert.deepEqual(pending.objects, d.objects); assert.equal(pending.revision, d.revision + 1);
  assert.equal(pending.proposals.p.baselineRevision, d.revision);
  assert.deepEqual(createProposal(pending, input), pending);
  const resolution = resolve(pending), accepted = resolveProposal(pending, resolution);
  assert.equal(accepted.proposals.p.status, 'accepted'); assert.equal(accepted.objects.candidate.version, 1);
  assert.equal(accepted.views['candidate-view'].objectId, 'candidate');
  assert.deepEqual(resolveProposal(accepted, resolution), accepted);
  throws(() => resolveProposal(accepted, resolve(accepted, 'reject', 'again')), 'CONFLICT');
  const invalid = proposal(d); invalid.changes.push(view('bad', 'missing'));
  throws(() => createProposal(d, invalid), 'NOT_FOUND'); assert.equal(d.proposals.p, undefined);
});

test('content changes stale acceptance; rejection remains available and preserves domain', () => {
  const pending = createProposal(seed(), proposal(seed()));
  const moved = run(pending, [{ type: 'updateObject', id: 'm', patch: { data: { smiles: 'C' } } }]);
  throws(() => resolveProposal(moved, resolve(moved)), 'CONFLICT');
  assert.equal(moved.proposals.p.status, 'pending');
  const rejected = resolveProposal(moved, resolve(moved, 'reject'));
  assert.deepEqual(rejected.objects, moved.objects); assert.deepEqual(rejected.views, moved.views);
  assert.equal(rejected.proposals.p.status, 'rejected');
});

test('candidate proposals survive source and unrelated view moves, retaining current layout on acceptance and undo', () => {
  const d = run(seed(), [view('hypothesis-view', 'h')]);
  const input = proposal(d);
  input.changes.push({ type: 'createRelation', relation: { id: 'origin', kind: 'derived_from', from: 'candidate', to: 'm' } });
  const pending = createProposal(d, input);
  const moved = run(pending, [{ type: 'moveView', id: 'v', x: 300, y: 400 }, { type: 'moveView', id: 'hypothesis-view', x: 90, y: 80 }]);
  const before = structuredClone(moved), resolution = resolve(moved);
  const accepted = resolveProposal(moved, resolution);
  assert.deepEqual(moved, before); assert.equal(accepted.objects.candidate.version, 1);
  assert.deepEqual(accepted.views.v, moved.views.v); assert.deepEqual(accepted.views['hypothesis-view'], moved.views['hypothesis-view']);
  assert.equal(accepted.relations.origin.targetVersion, 1);
  assert.deepEqual(resolveProposal(accepted, resolution), accepted);
  const restored = undoOperation(accepted, undo(accepted));
  assert.deepEqual(restored.views, moved.views); assert.deepEqual(restored.objects, moved.objects);
});

test('proposal view writes conflict with intervening moves, deletion, creation and moved-back targets', () => {
  const d = seed();
  for (const type of ['moveView', 'deleteView']) {
    const input = proposal(d);
    input.changes.push(type === 'moveView' ? { type, id: 'v', x: 20, y: 30 } : { type, id: 'v' });
    const pending = createProposal(d, input);
    const moved = run(pending, [{ type: 'moveView', id: 'v', x: 50, y: 60 }]);
    const movedBack = run(moved, [{ type: 'moveView', id: 'v', x: 0, y: 10 }]);
    const deleted = run(pending, [{ type: 'deleteView', id: 'v' }]);
    for (const changed of [moved, movedBack, deleted]) {
      const before = structuredClone(changed);
      throws(() => resolveProposal(changed, resolve(changed)), 'CONFLICT');
      assert.deepEqual(changed, before);
    }
  }
  const pending = createProposal(d, proposal(d));
  const collision = run(pending, [view('candidate-view', 'm')]);
  throws(() => resolveProposal(collision, resolve(collision)), 'CONFLICT');
  const removedCollision = run(collision, [{ type: 'deleteView', id: 'candidate-view' }]);
  throws(() => resolveProposal(removedCollision, resolve(removedCollision)), 'CONFLICT');
});

test('independent view creation/deletion is safe but relation changes and incomplete history still conflict', () => {
  const pending = createProposal(seed(), proposal(seed()));
  const layout = run(pending, [view('extra', 'h'), { type: 'deleteView', id: 'v' }]);
  const accepted = resolveProposal(layout, resolve(layout));
  assert.equal(accepted.views.v, undefined); assert.deepEqual(accepted.views.extra, layout.views.extra);
  const relation = run(pending, [{ type: 'createRelation', relation: { id: 'r', kind: 'supports', from: 'm', to: 'h' } }]);
  throws(() => resolveProposal(relation, resolve(relation)), 'CONFLICT');
  const removed = run(relation, [{ type: 'deleteRelation', id: 'r' }]);
  throws(() => resolveProposal(removed, resolve(removed)), 'CONFLICT');
  const gap = structuredClone(layout); gap.revision++;
  throws(() => resolveProposal(gap, resolve(gap)), 'CONFLICT');
});

test('undo appends history, keeps receipts and monotonically versions restored content', () => {
  const d = seed(); const update = op(d, [{ type: 'updateObject', id: 'm', patch: { data: { smiles: 'C' } } }]);
  const changed = applyOperation(d, update), request = undo(changed), restored = undoOperation(changed, request);
  assert.equal(restored.objects.m.data.smiles, 'CCO'); assert.equal(restored.objects.m.version, 3);
  assert.equal(restored.history.length, changed.history.length + 1);
  assert.equal(restored.history.at(-1).undoOf, update.operationId);
  assert.deepEqual(restored.history.slice(0, -1), changed.history);
  assert.deepEqual(applyOperation(restored, update), restored); assert.deepEqual(undoOperation(restored, request), restored);
  throws(() => undoOperation(restored, undo(restored)), 'CONFLICT');
  const moved = run(restored, [{ type: 'moveView', id: 'v', x: 10, y: 10 }]);
  assert.equal(undoOperation(moved, undo(moved)).objects.m.version, 3);
});

test('undo acceptance removes accepted edits without erasing the accepted proposal or permitting reuse', () => {
  const pending = createProposal(seed(), proposal(seed()));
  throws(() => undoOperation(pending, undo(pending)), 'CONFLICT');
  const accepted = resolveProposal(pending, resolve(pending));
  const restored = undoOperation(accepted, undo(accepted));
  assert.equal(restored.objects.candidate, undefined); assert.equal(restored.proposals.p.status, 'accepted');
  assert.equal(restored.history.at(-1).type, 'undo');
  throws(() => run(restored, [object('candidate')]), 'CONFLICT');
});

test('import validation covers geometry, references, provenance, proposals, history and receipts', () => {
  const good = createProposal(seed(), proposal(seed()));
  const corruptions = [
    d => { d.views.v.x = Infinity; }, d => { d.views.v.width = 0; },
    d => { d.views.v.objectId = 'absent'; }, d => { d.objects.m.id = 'wrong'; },
    d => { d.objects.m.version = 0; }, d => { d.objects.m.provenance.actor = 'system'; },
    d => { d.proposals.p.baselineRevision = 99; }, d => { d.proposals.p.changes = [{ type: 'bad' }]; },
    d => { d.history[0].before.objects.m = d.objects.m; },
    d => { d.history[0].actor = 'other'; }, d => { d.appliedOperations = {}; },
    d => { d.identities.objects.m = 99; }, d => { d.history[0].after.views.v.x = NaN; },
    d => { d.history[0].before = null; }, d => { d.appliedOperations['op-0'].request = 'null'; },
    d => { d.views.v.objectId = { toString: '' }; }, d => { d.proposals.p.changes = [{ type: 'deleteObject' }]; },
    d => { d.history[0].reversible = false; },
  ];
  for (const corrupt of corruptions) { const d = structuredClone(good); corrupt(d); throws(() => validateDocument(d)); }
});

test('non-JSON values, unsafe ids and malformed operations fail without leaking partial writes', () => {
  const d = fresh();
  throws(() => createDocument(null)); throws(() => validateDocument(null)); throws(() => applyOperation(d, null));
  for (const value of [undefined, NaN, Infinity, new Date(), 1n, () => {}, new Map()]) {
    const c = object(); c.object.data.value = value; throws(() => run(d, [c]));
  }
  const cycle = {}; cycle.self = cycle; const c = object(); c.object.data = cycle; throws(() => run(d, [c]));
  throws(() => run(d, [object('__proto__')])); throws(() => run(d, []));
  throws(() => run(d, [{ type: 'unknown' }]));
  throws(() => run(d, [object(), { type: 'createView', view: { id: 'v', objectId: 'm', x: 1, y: 2, width: -1, height: 5 } }]));
  assert.equal(d.revision, 0);
});
