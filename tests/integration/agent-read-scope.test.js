import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../../server/index.js';
import { buildReadResponse } from '../../server/agent-read.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chem-agent-read-'));
  let app, client;
  t.after(async () => {
    await client?.close(); await app?.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('chem-agent-read-'));
    await rm(resolved, { recursive: true, force: true });
  });
  app = await startServer({ port: 0, dataDirectory: directory,
    benchmarkDirectory: path.join(directory, 'unused-runs'), feedbackDirectory: path.join(directory, 'unused-feedback'), replayDirectory: path.join(directory, 'unused-replays') });
  client = new Client({ name: 'agent-read-scope-integration', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../server/mcp.js', import.meta.url))], env: { ...process.env, CHEM_CANVAS_URL: app.url } }));
  const get = async route => (await fetch(app.url + route)).json();
  const post = async (route, input) => {
    const response = await fetch(app.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
  };
  const call = async (name, args) => {
    const reply = await client.callTool({ name, ...(args === undefined ? {} : { arguments: args }) });
    return { reply, value: JSON.parse(reply.content[0].text) };
  };
  const read = async args => {
    const { reply, value } = await call('canvas_read', args);
    assert.notEqual(reply.isError, true, JSON.stringify(value)); return value;
  };
  const mutate = async changes => {
    const { document } = await get('/api/document');
    const result = await post('/api/operations', { actor: 'human', operationId: `human-${document.revision}`, expectedRevision: document.revision, intent: 'Read scope fixture', changes });
    assert.equal(result.status, 200, JSON.stringify(result.error)); return result.document;
  };
  const changes = [];
  for (let i = 0; i < 12; i++) {
    changes.push({ type: 'createObject', object: { id: `mol-${i}`, kind: 'molecule', title: `Saved compound ${i}`, data: { smiles: 'C'.repeat(35) + 'O' } } },
      { type: 'createView', view: { id: `view-${i}`, objectId: `mol-${i}`, x: i * 260, y: 0, width: 240, height: 180 } });
  }
  for (const kind of ['reaction', 'evidence', 'hypothesis', 'plan', 'question', 'task', 'note']) changes.push({ type: 'createObject', object: {
    id: kind, kind, title: `Saved ${kind}`, data: { text: `${kind} context. `.repeat(1000), status: 'unverified', source: { url: 'https://example.invalid/research' } },
  } });
  changes.push({ type: 'createRelation', relation: { id: 'pinned', kind: 'derived_from', from: 'mol-0', to: 'mol-1', fromViewId: 'view-0', toViewId: 'view-1', note: 'Pinned original comparison' } },
    { type: 'createRelation', relation: { id: 'reactant', kind: 'reactant', from: 'mol-0', to: 'reaction' } },
    { type: 'createRelation', relation: { id: 'product', kind: 'product', from: 'reaction', to: 'mol-2' } },
    { type: 'createRelation', relation: { id: 'unrelated', kind: 'supports', from: 'evidence', to: 'hypothesis' } });
  await mutate(changes);
  const persisted = () => readFile(path.join(directory, 'document.json'), 'utf8');
  const stable = async action => {
    const before = await persisted(), selected = await get('/api/selection');
    const result = await action();
    assert.equal(await persisted(), before, 'Read/error must not write data, receipts, revisions or history');
    assert.deepEqual(await get('/api/selection'), selected, 'Read/error must not republish selection');
    return result;
  };
  return { client, get, post, call, read, mutate, stable, persisted };
}

// Independent legacy expectation: do not import the implementation compactor.
function legacyDocument(document, includeSvg = false, includeHistory = false) {
  const expected = structuredClone(document);
  delete expected.identities; delete expected.appliedOperations;
  if (!includeHistory) delete expected.history;
  else expected.history = expected.history.map(({ before, after, ...entry }) => entry);
  if (!includeSvg) {
    for (const o of Object.values(expected.objects)) delete o.data.svg;
    for (const p of Object.values(expected.proposals)) for (const c of p.changes) {
      if (c.object?.data) delete c.object.data.svg;
      if (c.patch?.data) delete c.patch.data.svg;
    }
  }
  return expected;
}

test('stdio MCP preserves the default canvas_read contract and legacy opt-ins', async t => {
  const f = await fixture(t), list = await f.client.listTools();
  assert.equal(list.tools.length, 18);
  const schema = list.tools.find(tool => tool.name === 'canvas_read').inputSchema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.detail.enum, ['full', 'summary']);
  assert.equal(schema.properties.objectIds.uniqueItems, true);
  await f.stable(async () => {
    const { document, proposalAcceptances } = await f.get('/api/document');
    for (const args of [undefined, {}, { includeSvg: true }, { includeHistory: true }, { includeSvg: true, includeHistory: true }]) {
      const result = await f.read(args);
      assert.deepEqual(Object.keys(result), ['document', 'proposalAcceptances', 'selection', 'capabilities', 'url']);
      assert.deepEqual(result.document, legacyDocument(document, args?.includeSvg, args?.includeHistory));
      assert.deepEqual(result.proposalAcceptances, proposalAcceptances);
      assert.deepEqual(result.selection, (await f.get('/api/selection')).selection);
    }
  });
});

test('stdio scoped full read returns exact saved bodies, incident pinned relations and external identity references', async t => {
  const f = await fixture(t);
  await f.mutate([{ type: 'updateObject', id: 'mol-1', patch: { title: 'New endpoint version' } }]);
  await f.stable(async () => {
    const { document } = await f.get('/api/document');
    const scoped = await f.read({ objectIds: ['mol-0', 'reaction', 'evidence'], detail: 'full' });
    assert.deepEqual(Object.keys(scoped.document.objects), ['mol-0', 'reaction', 'evidence']);
    for (const id of Object.keys(scoped.document.objects)) {
      const expected = structuredClone(document.objects[id]); delete expected.data.svg;
      assert.deepEqual(scoped.document.objects[id], expected);
    }
    assert.deepEqual(Object.keys(scoped.document.views), ['view-0']);
    assert.deepEqual(scoped.document.relations, document.relations);
    assert.equal(scoped.document.relations.pinned.targetVersion, 1);
    assert.equal(scoped.references.objects['mol-1'].version, 2);
    assert.equal(scoped.references.objects['mol-1'].data, undefined);
    assert.deepEqual(scoped.references.views['view-1'], document.views['view-1']);
    assert.equal(scoped.readScope.scope, 'objects'); assert.equal(scoped.readScope.completeDocument, false);
    assert.equal(scoped.readScope.objects.omitted, 16);
    const one = await f.read({ objectIds: ['mol-0'], includeSvg: true, includeHistory: true });
    assert.deepEqual(one.document.objects['mol-0'], document.objects['mol-0']);
    assert.deepEqual(Object.keys(one.document.relations), ['pinned', 'reactant']);
    assert.equal(one.readScope.relations.omitted, 2);
    assert.equal(one.readScope.history.scope, 'document');
    assert.ok(one.document.history.every(entry => !entry.before && !entry.after));
    const inspected = await f.call('canvas_inspect_molecule', { objectId: 'mol-0' });
    assert.notEqual(inspected.reply.isError, true);
    const png = inspected.reply.content.find(item => item.type === 'image');
    assert.equal(png.mimeType, 'image/png');
    assert.equal(Buffer.from(png.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(inspected.value.image.revision, document.revision);
  });
});

test('stdio summary shrinks a mixed route and omits full graphs/MOL/SVG, long research data and layout/history', async t => {
  const f = await fixture(t);
  const layout = await f.post('/api/route/scheme/edit', { actor: 'human', expectedRevision: 1, expectedLayoutVersion: 0, operationId: 'save-layout', mode: 'commit', moves: [] });
  assert.equal(layout.status, 200, JSON.stringify(layout.error));
  await f.stable(async () => {
    const full = await f.read(), summary = await f.read({ detail: 'summary' });
    const fullBytes = Buffer.byteLength(JSON.stringify(full)), summaryBytes = Buffer.byteLength(JSON.stringify(summary));
    t.diagnostic(`UTF-8 response bytes: full=${fullBytes}, summary=${summaryBytes}, reduction=${(100 * (1 - summaryBytes / fullBytes)).toFixed(1)}%`);
    assert.ok(summaryBytes < fullBytes * .25);
    for (const [id, object] of Object.entries(summary.document.objects)) {
      assert.equal(object.id, id); assert.equal(object.version, full.document.objects[id].version);
      assert.equal(object.title, full.document.objects[id].title); assert.equal(object.kind, full.document.objects[id].kind);
      assert.equal(object.provenance, undefined);
      if (object.kind === 'molecule') assert.deepEqual(object.data, { atomCount: 36, bondCount: 35 });
      else { assert.equal(object.data.textPreview.length, 240); assert.equal(object.data.textTruncated, true); }
    }
    for (const key of ['history', 'schemeLayout', 'identities', 'appliedOperations']) assert.equal(summary.document[key], undefined);
    assert.equal(summary.readScope.schemeLayoutVersion, full.document.schemeLayout.version);
    assert.equal(summary.readScope.objects.omitted, 0); assert.equal(summary.readScope.completeDocument, false);
    const scoped = await f.read({ detail: 'summary', objectIds: ['mol-0', 'plan'] });
    assert.deepEqual(Object.keys(scoped.document.objects), ['mol-0', 'plan']);
    assert.equal(scoped.document.relations.pinned.note, undefined);
    assert.ok(scoped.readScope.omitted.includes('relation.note'));
  });
});

test('stdio proposal summaries and acceptances remain explicitly global, including stale and resolved candidates', async t => {
  const f = await fixture(t);
  const candidate = async (id, objectId = 'mol-0') => {
    const { document } = await f.get('/api/document'), object = document.objects[objectId];
    const { reply, value } = await f.call('canvas_edit_molecule', { operationId: id, expectedRevision: document.revision,
      objectId, expectedObjectVersion: object.version, mode: 'propose', rationale: 'Compare only; not an executed experiment', includeImage: false,
      edits: [{ type: 'updateAtom', id: object.data.atoms.at(-1).id, patch: { atomicNumber: 7 } }] });
    assert.notEqual(reply.isError, true, JSON.stringify(value)); return value.proposalId;
  };
  const first = await candidate('first'), second = await candidate('second'), outside = await candidate('outside', 'mol-8');
  const newCandidate = await f.call('canvas_edit_molecule', { operationId: 'new-unaccepted-object',
    expectedRevision: (await f.get('/api/document')).document.revision, mode: 'propose', rationale: 'New candidate awaiting human review', includeImage: false,
    edits: [{ type: 'addAtom', atom: { id: 'candidate-only-carbon', atomicNumber: 6, x: 0, y: 0 } }] });
  assert.notEqual(newCandidate.reply.isError, true, JSON.stringify(newCandidate.value));
  const newProposalId = newCandidate.value.proposalId;
  const proposedObjectId = newCandidate.value.document.proposals[newProposalId].changes[0].object.id;
  const before = await f.get('/api/document');
  assert.equal(before.proposalAcceptances[first].canAccept, true);
  const accepted = await f.post(`/api/proposals/${second}/resolve`, { actor: 'human', expectedRevision: before.document.revision, operationId: 'accept-second', action: 'accept' });
  assert.equal(accepted.status, 200);
  await f.stable(async () => {
    const current = await f.get('/api/document');
    for (const args of [{ detail: 'summary' }, { objectIds: ['mol-0'] }, { detail: 'summary', objectIds: ['note'] }]) {
      const result = await f.read(args);
      assert.deepEqual(result.proposalAcceptances, current.proposalAcceptances);
      assert.equal(result.proposalAcceptances[first].state, 'stale');
      assert.equal(result.proposalAcceptances[second].state, 'resolved');
      assert.equal(result.proposalAcceptances[outside].canAccept, true);
      assert.equal(result.document.objects[proposedObjectId], undefined, 'A pending candidate is not a saved object');
      assert.equal(result.readScope.proposals.scope, 'document'); assert.equal(result.readScope.proposals.detail, 'summary');
      assert.equal(result.readScope.proposalAcceptances.recomputedFromProjection, false);
      assert.deepEqual(Object.keys(result.document.proposals), Object.keys(current.document.proposals));
      for (const proposal of Object.values(result.document.proposals)) {
        for (const key of ['changes', 'rationale', 'review', 'scope']) assert.equal(proposal[key], undefined);
        assert.equal(proposal.changeCount, proposal.id === newProposalId ? 2 : 1);
      }
    }
    const blocked = await f.call('canvas_read', { objectIds: ['mol-0', proposedObjectId] });
    assert.equal(blocked.reply.isError, true); assert.equal(blocked.value.error.code, 'NOT_FOUND');
    const legacy = await f.read(), explicit = await f.read({ detail: 'full', includeSvg: true });
    assert.deepEqual(legacy.document, legacyDocument(current.document));
    assert.deepEqual(explicit.document.proposals, current.document.proposals);
    assert.equal(explicit.readScope.proposals.detail, 'full');
  });
});

test('stdio reads preserve usable/stale selection, never share private drafts or refresh old baselines', async t => {
  const f = await fixture(t), { document } = await f.get('/api/document'), object = document.objects['mol-0'];
  const selected = { objectIds: [object.id], atomIds: [object.data.atoms[0].id, object.data.atoms[1].id], bondIds: [object.data.bonds[0].id],
    revision: document.revision, objectVersion: object.version, source: 'human-editor', state: 'saved' };
  assert.equal((await f.post('/api/selection', selected)).status, 200);
  const check = async usable => f.stable(async () => {
    const actual = (await f.get('/api/selection')).selection;
    for (const args of [{ detail: 'summary' }, { objectIds: ['mol-0'] }, { detail: 'summary', objectIds: ['note'] }]) {
      const result = await f.read(args);
      assert.deepEqual(result.selection, actual); assert.equal(result.selection.usable, usable);
      assert.equal(result.selection.stale, !usable);
      assert.equal(result.selection.baseline.revision, selected.revision);
      assert.deepEqual(result.selection.atomIds, selected.atomIds);
      assert.deepEqual(result.readScope.selection.outsideObjectIds, args.objectIds?.[0] === 'note' ? ['mol-0'] : []);
    }
  });
  await check(true);
  await f.stable(async () => {
    const draft = await f.post('/api/selection', { ...selected, graph: { atoms: [{ id: 'private-draft-atom' }] }, edits: [], state: 'draft' });
    assert.equal(draft.status, 400);
    assert.equal(JSON.stringify(await f.read({ detail: 'summary' })).includes('private-draft-atom'), false);
  });
  await f.mutate([{ type: 'updateObject', id: 'note', patch: { title: 'Unrelated edit still stales revision-bound selection' } }]);
  await check(false);
  const stale = await f.read({ objectIds: ['mol-0'] });
  assert.equal(stale.selection.objectStale, false); assert.equal(stale.selection.revisionStale, true);
  await f.mutate([{ type: 'updateObject', id: 'mol-0', patch: { title: 'New molecule version' } }]);
  await check(false);
  assert.equal((await f.read({ detail: 'summary' })).selection.objectStale, true);
  await f.stable(async () => {
    const blocked = await f.call('canvas_edit_molecule', { operationId: 'old-version', expectedRevision: document.revision, objectId: object.id,
      expectedObjectVersion: object.version, edits: [{ type: 'moveAtom', id: selected.atomIds[0], x: 0, y: 0 }], includeImage: false });
    assert.equal(blocked.reply.isError, true); assert.equal(blocked.value.error.code, 'CONFLICT');
  });
});

test('stdio validation and unknown/deleted IDs fail atomically instead of falling back to an empty or full read', async t => {
  const f = await fixture(t);
  await f.mutate([{ type: 'deleteObject', id: 'note' }]);
  await f.stable(async () => {
    for (const args of [{ detail: 'short' }, { detail: null }, { objectIds: [] }, { objectIds: ['mol-0', 'mol-0'] },
      { objectIds: 'mol-0' }, { objectIds: [null] }, { objectIds: [' '] }, { objectIds: ['constructor'] },
      { objectIds: Array.from({ length: 201 }, (_, i) => `id-${i}`) }, { includeSvg: 'true' }, { includeHistory: null },
      { detail: 'summary', includeSvg: true }, { detail: 'summary', includeHistory: true }, { typo: true }]) {
      const result = await f.call('canvas_read', args);
      assert.equal(result.reply.isError, true, JSON.stringify(args)); assert.equal(result.value.error.code, 'VALIDATION');
      assert.equal(result.value.document, undefined);
    }
    for (const id of ['unknown', 'note', 'view-0', 'proposed-only-object']) {
      const result = await f.call('canvas_read', { objectIds: ['mol-0', id], detail: 'summary' });
      assert.equal(result.reply.isError, true); assert.equal(result.value.error.code, 'NOT_FOUND');
      assert.ok(result.value.error.message.includes(id)); assert.equal(result.value.document, undefined);
    }
    // Pure adapter guard supplements the real stdio/HTTP tests: GET observations
    // at different revisions must not synthesize a fresh human selection.
    const legacy = await f.read(), snapshot = structuredClone(legacy);
    assert.throws(() => buildReadResponse({ ...legacy, selection: { ...legacy.selection, currentRevision: legacy.document.revision + 1 } }, { detail: 'summary' }), error => error.code === 'CONFLICT');
    assert.deepEqual(legacy, snapshot);
  });
});
