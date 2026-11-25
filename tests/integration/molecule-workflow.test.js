import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../../server/index.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chem-review-'));
  const app = await startServer({ port: 0, dataDirectory: directory });
  const client = new Client({ name: 'candidate-workflow-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../server/mcp.js', import.meta.url))], env: { ...process.env, CHEM_CANVAS_URL: app.url } }));
  t.after(async () => { await client.close(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  const call = async (name, args) => {
    const reply = await client.callTool({ name, arguments: args });
    return { ...JSON.parse(reply.content[0].text), errorFlag: reply.isError, imageCount: reply.content.filter(x => x.type === 'image').length };
  };
  const read = async () => (await fetch(app.url + '/api/document').then(r => r.json())).document;
  const post = async (route, input) => {
    const r = await fetch(app.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    return { status: r.status, ...await r.json() };
  };
  const saved = await call('canvas_put_molecule', { operationId: 'seed', expectedRevision: 0, smiles: 'CCO', title: 'Original ethanol' });
  assert.ok(!saved.errorFlag);
  const document = await read(), object = Object.values(document.objects)[0];
  return { call, read, post, client, document, object };
}

test('MCP candidate preview/propose preserves IDs; human review accepts exact chemistry after independent layout, undo and retry remain faithful', async t => {
  const f = await fixture(t), { object, document } = f;
  const oxygen = object.data.atoms.find(a => a.atomicNumber === 8);
  const input = { operationId: 'edit-candidate', expectedRevision: document.revision, objectId: object.id, expectedObjectVersion: object.version, edits: [{ type: 'updateAtom', id: oxygen.id, patch: { atomicNumber: 7 } }] };
  const preview = await f.call('canvas_edit_molecule', { ...input, mode: 'preview' });
  assert.ok(!preview.errorFlag, JSON.stringify(preview));
  assert.equal(preview.imageCount, 1); assert.equal(preview.image.state, 'preview');
  assert.equal(preview.molecule.smiles, 'CCN'); assert.equal(preview.delta.changedAtoms.length > 0, true);
  assert.deepEqual(await f.read(), document);
  const proposedInput = { ...input, mode: 'propose', rationale: 'Compare a terminal amine candidate; no biological claim.', proposalTitle: 'Replace terminal O with N' };
  const proposed = await f.call('canvas_edit_molecule', proposedInput);
  assert.ok(!proposed.errorFlag, JSON.stringify(proposed));
  assert.equal(proposed.image.state, 'proposal'); assert.equal(proposed.image.proposalStatus, 'pending');
  assert.equal(proposed.imageCount, 1);
  let d = await f.read(); const p = d.proposals[proposed.proposalId];
  assert.deepEqual(d.objects, document.objects); assert.deepEqual(d.views, document.views);
  assert.equal(p.changes[0].patch.data.smiles, 'CCN');
  assert.deepEqual(p.changes[0].patch.data.atoms.map(a => a.id), object.data.atoms.map(a => a.id));
  assert.equal(p.review.baseObjectVersion, object.version);
  assert.equal((await f.call('canvas_edit_molecule', proposedInput)).replayed, true);
  const view = Object.values(d.views)[0];
  await f.post('/api/operations', { operationId: 'move-card', expectedRevision: d.revision, actor: 'human', intent: 'Keep my layout', changes: [{ type: 'moveView', id: view.id, x: 400, y: 320 }] });
  d = await f.read();
  const accepted = await f.post(`/api/proposals/${p.id}/resolve`, { operationId: 'accept', expectedRevision: d.revision, actor: 'human', action: 'accept' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.document.objects[object.id].data.smiles, 'CCN');
  assert.deepEqual(accepted.document.objects[object.id].data.atoms, p.changes[0].patch.data.atoms);
  assert.equal(accepted.document.views[view.id].x, 400);
  assert.equal(accepted.document.history.at(-1).actor, 'human');
  const undone = await f.call('canvas_undo', { operationId: 'undo', expectedRevision: accepted.document.revision });
  assert.deepEqual(undone.document.objects[object.id].data.atoms, object.data.atoms);
  const replay = await f.call('canvas_edit_molecule', proposedInput);
  assert.equal(replay.replayed, true); assert.equal(replay.image.state, 'proposal'); assert.equal(replay.image.proposalStatus, 'accepted');
  assert.equal((await f.read()).objects[object.id].data.smiles, 'CCO');
});

test('depiction candidates are separate from saved layout; stale content cannot be accepted and rejection preserves human work', async t => {
  const f = await fixture(t), { object, document } = f;
  const oxygen = object.data.atoms.find(a => a.atomicNumber === 8);
  const input = { operationId: 'local-review', expectedRevision: document.revision, objectId: object.id, expectedObjectVersion: object.version, mode: 'propose', rationale: 'Move only terminal oxygen for comparison.', operations: [{ type: 'moveAtom', atomId: oxygen.id, x: oxygen.x + .15, y: oxygen.y + .1 }] };
  const proposed = await f.call('canvas_adjust_depiction', input);
  assert.ok(!proposed.errorFlag, JSON.stringify(proposed)); assert.equal(proposed.image.state, 'proposal');
  let d = await f.read(); assert.deepEqual(d.objects, document.objects);
  const p = d.proposals[proposed.proposalId];
  assert.equal(p.review.delta.movedAtoms.length, 1);
  for (const atom of object.data.atoms.filter(a => a.id !== oxygen.id)) assert.deepEqual(p.changes[0].patch.data.atoms.find(a => a.id === atom.id), atom);
  const committed = await f.call('canvas_edit_molecule', { operationId: 'concurrent-edit', expectedRevision: d.revision, objectId: object.id, expectedObjectVersion: object.version, edits: [{ type: 'updateAtom', id: oxygen.id, patch: { atomicNumber: 7 } }] });
  assert.ok(!committed.errorFlag); d = await f.read();
  const conflict = await f.post(`/api/proposals/${p.id}/resolve`, { operationId: 'stale-accept', expectedRevision: d.revision, actor: 'human', action: 'accept' });
  assert.equal(conflict.status, 409); assert.deepEqual(await f.read(), d);
  const rejected = await f.post(`/api/proposals/${p.id}/resolve`, { operationId: 'reject', expectedRevision: d.revision, actor: 'human', action: 'reject' });
  assert.equal(rejected.status, 200); assert.deepEqual(rejected.document.objects, d.objects);
  assert.equal((await f.call('canvas_adjust_depiction', input)).image.proposalStatus, 'rejected');
  const before = await f.read();
  const invalid = await f.call('canvas_adjust_depiction', { ...input, operationId: 'invalid-mode', expectedRevision: before.revision, expectedObjectVersion: before.objects[object.id].version, preview: true });
  assert.equal(invalid.error.code, 'VALIDATION'); assert.deepEqual(await f.read(), before);
});

test('new graph candidates stay outside objects until acceptance; invalid batch and missing rationale never create proposals', async t => {
  const f = await fixture(t); let d = await f.read();
  const input = { operationId: 'new-drawing', expectedRevision: d.revision, mode: 'propose', rationale: 'New single-carbon sketch', edits: [{ type: 'addAtom', atom: { id: 'new-carbon', atomicNumber: 6, x: 0, y: 0 } }] };
  const proposed = await f.call('canvas_edit_molecule', input); assert.ok(!proposed.errorFlag, JSON.stringify(proposed));
  assert.equal(proposed.imageCount, 1); assert.equal(proposed.image.objectVersion, 0);
  assert.deepEqual((await f.read()).objects, d.objects);
  d = await f.read();
  const accepted = await f.post(`/api/proposals/${proposed.proposalId}/resolve`, { operationId: 'accept-new', expectedRevision: d.revision, actor: 'human', action: 'accept' });
  assert.equal(accepted.status, 200); assert.equal(Object.keys(accepted.document.objects).length, 2);
  d = await f.read();
  const bad = await f.call('canvas_edit_molecule', { ...input, operationId: 'bad-candidate', expectedRevision: d.revision, edits: [...input.edits, { type: 'deleteAtom', id: 'missing' }] });
  assert.equal(bad.error.code, 'VALIDATION'); assert.deepEqual(await f.read(), d);
  const noReason = await f.call('canvas_edit_molecule', { ...input, operationId: 'no-reason', expectedRevision: d.revision, rationale: '' });
  assert.ok(noReason.errorFlag); assert.deepEqual(await f.read(), d);
});
