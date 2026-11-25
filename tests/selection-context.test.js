import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySelection, normalizeSelection, singleSelection, toggleSelection, unionSelection, rectangleSelection, deletionEdits, selectionContext, savedSelectionPayload, localDraftContext, createSelectionPublisher } from '../public/selection-context.js';
import { selectedInput, readSelection } from '../server/selection-context.js';

const graph = { atoms: [{ id: 'z', atomicNumber: 6, x: 0, y: 0 }, { id: 'a', atomicNumber: 6, x: 1.5, y: 0 }, { id: 'o', atomicNumber: 8, x: 3, y: 0 }], bonds: [{ id: 'ba', from: 'z', to: 'a', order: 1 }, { id: 'bo', from: 'a', to: 'o', order: 1 }] };
const object = { id: 'mol', kind: 'molecule', title: 'ethanol', version: 4, data: graph };
const document = { revision: 8, objects: { mol: object } };
const input = (overrides = {}) => ({ object, revision: 8, graph, selection: { atomIds: ['z', 'a'], bondIds: ['ba'] }, edits: [], title: object.title, ...overrides });
const clone = value => structuredClone(value);

test('Shift toggles independent stable atom and bond IDs, with no index or endpoint substitution', () => {
  let selected = toggleSelection(emptySelection(), 'atom', 'z');
  assert.deepEqual(singleSelection(selected), { kind: 'atom', id: 'z' });
  selected = toggleSelection(selected, 'bond', 'bo');
  assert.equal(singleSelection(selected), null);
  assert.deepEqual(selected, { atomIds: ['z'], bondIds: ['bo'] });
  selected = toggleSelection(selected, 'atom', 'z');
  assert.deepEqual(selected, { atomIds: [], bondIds: ['bo'] });
  assert.deepEqual(normalizeSelection({ atomIds: ['a', 'z', 'z', '0'], bondIds: ['bo', 'missing'] }, { atoms: [...graph.atoms].reverse(), bonds: [...graph.bonds].reverse() }), { atomIds: ['a', 'z'], bondIds: ['bo'] });
});

test('rectangle works in both directions, encloses full bonds and Shift unions the original selection', () => {
  const left = { x: -.1, y: -.1 }, right = { x: 1.6, y: .1 };
  const expected = { atomIds: ['z', 'a'], bondIds: ['ba'] };
  assert.deepEqual(rectangleSelection(graph, left, right), expected);
  assert.deepEqual(rectangleSelection(graph, right, left), expected);
  assert.deepEqual(rectangleSelection(graph, { x: .5, y: -.2 }, { x: 1, y: .2 }), emptySelection());
  assert.deepEqual(unionSelection({ atomIds: ['a', 'o'], bondIds: ['bo'] }, expected), { atomIds: ['a', 'o', 'z'], bondIds: ['bo', 'ba'] });
});

test('deleting a fragment deduplicates incident bonds and selection snapshots survive undo and redo', () => {
  const before = { atomIds: ['a'], bondIds: ['ba', 'bo'] };
  assert.deepEqual(deletionEdits(before, graph), [{ type: 'deleteAtom', id: 'a' }]);
  const deleted = { atoms: graph.atoms.filter(atom => atom.id !== 'a'), bonds: [] };
  const after = normalizeSelection(before, deleted);
  assert.deepEqual(after, emptySelection());
  assert.deepEqual(normalizeSelection(before, graph), before); // undo restores the original snapshot
  assert.deepEqual(normalizeSelection(after, deleted), emptySelection()); // redo cannot revive absent IDs
  assert.deepEqual(deletionEdits({ atomIds: ['z'], bondIds: ['bo'] }, graph), [{ type: 'deleteBond', id: 'bo' }, { type: 'deleteAtom', id: 'z' }]);
});

test('only untouched saved contexts can yield a selection payload; new draft IDs never leak', () => {
  const saved = selectionContext(input());
  assert.equal(saved.state, 'saved');
  assert.deepEqual(saved.baseline, { revision: 8, objectId: 'mol', objectVersion: 4 });
  assert.deepEqual(savedSelectionPayload(saved).atomIds, ['z', 'a']);
  for (const overrides of [
    { edits: [{ type: 'updateAtom', id: 'z', patch: { atomicNumber: 7 } }] },
    { title: 'unsaved title' }, { gesture: true }, { object: null },
    { graph: { ...graph, atoms: [...graph.atoms, { id: 'draft', atomicNumber: 6, x: 4, y: 0 }] }, selection: { atomIds: ['z', 'draft'], bondIds: [] } }
  ]) {
    const context = selectionContext(input(overrides));
    assert.equal(context.saved, false);
    assert.equal(savedSelectionPayload(context), null);
  }
  const exported = localDraftContext(input({ edits: [{ type: 'moveAtom', id: 'z', x: 0, y: 1 }] }));
  assert.equal(exported.state, 'draft'); assert.equal(exported.saved, false); assert.equal(exported.scope, 'local-export');
  exported.graph.atoms[0].x = 999; assert.equal(graph.atoms[0].x, 0);
  assert.equal(exported.edits[0].type, 'moveAtom');
});

test('server adapter rejects draft/index payloads, requires both baselines and exposes staleness after undo', () => {
  const payload = savedSelectionPayload(selectionContext(input()));
  const selected = selectedInput(payload, document);
  assert.equal(readSelection(selected, document).usable, true);
  assert.equal(selected.source, 'human-editor'); assert.equal(selected.saved, true);
  const rejects = [
    { state: 'draft' }, { saved: false }, { graph }, { edits: [] }, { atomIds: ['0'] }, { bondIds: ['unknown'] },
    { objectVersion: undefined }, { objectVersion: 3 }, { revision: 7 }
  ];
  for (const patch of rejects) assert.throws(() => selectedInput({ ...payload, ...patch }, document), error => ['VALIDATION', 'CONFLICT'].includes(error.code));
  const undone = { revision: 10, objects: { mol: { ...object, version: 6 } } };
  const stale = readSelection(selected, undone);
  assert.equal(stale.stale, true); assert.equal(stale.usable, false); assert.equal(stale.objectStale, true);
  assert.equal(stale.currentObjectVersion, 6); assert.equal(stale.baseline.objectVersion, 4);
  assert.equal(readSelection(selected, { ...document, revision: 9 }).revisionStale, true);
  const missing = readSelection(selected, { revision: 9, objects: {} });
  assert.deepEqual(missing.missingObjectIds, ['mol']); assert.deepEqual(missing.missingAtomIds, ['z', 'a']);
});

function publisherFixture(current = clone(document)) {
  const posts = [], statuses = [];
  const publisher = createSelectionPublisher({ request: async (path, payload) => {
    if (path === '/api/document') return { document: current };
    const selection = selectedInput(payload, current); posts.push(clone(payload)); return { selection };
  }, onStatus: status => statuses.push(status) });
  return { current, posts, statuses, publisher };
}

test('dirty then undo clears agent selection before republishing the original saved IDs', async () => {
  const f = publisherFixture();
  await f.publisher.publish(selectionContext(input()));
  assert.deepEqual(f.posts.at(-1).atomIds, ['z', 'a']);
  await f.publisher.publish(selectionContext(input({ edits: [{ type: 'deleteAtom', id: 'a' }] })));
  assert.deepEqual(f.posts.at(-1).objectIds, []);
  await f.publisher.publish(selectionContext(input()));
  assert.deepEqual(f.posts.at(-1).atomIds, ['z', 'a']);
  assert.equal(f.statuses.at(-1).state, 'published');
});

test('stale object/revision and deleted objects clear selection without rebasing any fragment', async () => {
  for (const current of [{ ...clone(document), revision: 9 }, { revision: 8, objects: { mol: { ...object, version: 5 } } }, { revision: 9, objects: {} }]) {
    const f = publisherFixture(current);
    await f.publisher.publish(selectionContext(input()));
    assert.equal(f.posts.length, 1); assert.deepEqual(f.posts[0].atomIds, []); assert.deepEqual(f.posts[0].objectIds, []);
    assert.equal(f.statuses.at(-1).state, 'stale');
  }
});

test('an obsolete preflight and queued saved selections are discarded when a draft arrives', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), begun = new Promise(resolve => { started = resolve; });
  const posts = [];
  const publisher = createSelectionPublisher({ request: async (path, payload) => {
    if (path === '/api/document') { started(); await gate; return { document }; }
    posts.push(payload); return { selection: payload };
  } });
  publisher.publish(selectionContext(input())); await begun;
  publisher.publish(selectionContext(input({ selection: { atomIds: ['o'], bondIds: [] } })));
  const last = publisher.publish(selectionContext(input({ edits: [{ type: 'moveAtom', id: 'a', x: 2, y: 0 }] })));
  release(); await last;
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].objectIds, []);
});

test('in-flight publication is followed by a clear; failures are visible and are never silently rebased', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), begun = new Promise(resolve => { started = resolve; });
  const posts = [], statuses = [];
  const publisher = createSelectionPublisher({ request: async (path, payload) => {
    if (path === '/api/document') return { document };
    posts.push(payload);
    if (payload.atomIds.length) { started(); await gate; }
    return { selection: payload };
  }, onStatus: status => statuses.push(status) });
  publisher.publish(selectionContext(input())); await begun;
  const last = publisher.publish(null); release(); await last;
  assert.equal(posts.length, 2); assert.deepEqual(posts.at(-1).objectIds, []);
  assert.equal(statuses.some(status => status.state === 'published'), false);
  assert.equal(statuses.at(-1).state, 'cleared');
  const failures = [];
  const broken = createSelectionPublisher({ request: async () => { throw new Error('offline'); }, onStatus: status => failures.push(status) });
  await broken.publish(selectionContext(input()));
  assert.deepEqual(failures.at(-1), { state: 'error', message: 'offline' });
});
