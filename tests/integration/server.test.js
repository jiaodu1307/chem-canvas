import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../../server/index.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chem-canvas-test-'));
  let app = await startServer({ port: 0, dataDirectory: directory });
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    get app() { return app; }, directory,
    async restart() { await app.close(); app = null; app = await startServer({ port: 0, dataDirectory: directory }); },
    async request(route, data, headers = {}) {
      const response = await fetch(`${app.url}${route}`, { ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) }), ...(data === undefined ? { headers } : {}) });
      return { status: response.status, body: await response.json() };
    }
  };
}

test('HTTP molecule writes are chemical, atomic, replayable, persistent and share actor history', async t => {
  const f = await fixture(t);
  const input = { operationId: 'molecule-1', expectedRevision: 0, actor: 'human', title: '乙醇', smiles: 'CCO' };
  const created = await f.request('/api/molecules', input);
  assert.equal(created.status, 200);
  assert.equal(created.body.document.revision, 1);
  const molecule = Object.values(created.body.document.objects)[0];
  assert.equal(molecule.data.atoms.length, 3);
  assert.match(molecule.data.svg, /<svg/);
  const picture = await fetch(`${f.app.url}/api/depictions/${molecule.id}.svg?style=acs1996`);
  assert.equal(picture.status, 200);
  assert.match(await picture.text(), /stroke-width:0\.6px/);
  assert.deepEqual((await f.request('/api/document')).body.document, created.body.document, 'redrawing must not mutate identities, chemistry or revision');
  const replay = await f.request('/api/molecules', input);
  assert.equal(replay.body.document.revision, 1);
  assert.equal(replay.body.replayed, true);
  assert.equal((await f.request('/api/molecules', { ...input, smiles: 'CC' })).status, 409);
  assert.equal((await f.request('/api/molecules', { ...input, operationId: 'stale' })).status, 409);
  assert.equal((await f.request('/api/molecules', { ...input, operationId: 'invalid', expectedRevision: 1, smiles: 'invalid!!!' })).status, 400);
  const edited = await f.request('/api/operations', { operationId: 'agent-note', expectedRevision: 1, actor: 'agent', intent: '记录结构检查', changes: [
    { type: 'createObject', object: { id: 'note-1', kind: 'note', title: '结构检查', data: { text: '真实 RDKit 解析得到三个原子；不代表实验结果。' } } },
    { type: 'createView', view: { id: 'view-note', objectId: 'note-1', x: 450, y: 100, width: 280, height: 180 } },
    { type: 'createRelation', relation: { id: 'relation-1', kind: 'refers_to', from: 'note-1', to: molecule.id } }
  ] });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.document.history.at(-1).actor, 'agent');
  await f.restart();
  const restored = await f.request('/api/document');
  assert.equal(restored.body.document.revision, 2);
  assert.equal(restored.body.document.objects[molecule.id].data.smiles, 'CCO');
  assert.equal((await f.request('/api/molecules', input)).body.document.revision, 2);
});

test('proposal acceptance is visible, stale edits reject, selection is revision bound', async t => {
  const f = await fixture(t);
  const proposed = await f.request('/api/proposals', { id: 'p1', operationId: 'proposal', expectedRevision: 0, actor: 'agent', title: '加入候选', rationale: '供用户检查', changes: [
    { type: 'createObject', object: { id: 'candidate', kind: 'molecule', title: '候选乙醇', data: { smiles: 'CCO' } } },
    { type: 'createView', view: { id: 'v1', objectId: 'candidate', x: 20, y: 20, width: 300, height: 210 } }
  ] });
  assert.equal(proposed.status, 200);
  assert.equal(Object.keys(proposed.body.document.objects).length, 0);
  const accepted = await f.request('/api/proposals/p1/resolve', { operationId: 'accept', expectedRevision: 1, actor: 'human', action: 'accept' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.document.objects.candidate.data.smiles, 'CCO');
  assert.equal((await f.request('/api/selection', { objectIds: ['candidate'], revision: 1 })).status, 409);
  assert.equal((await f.request('/api/selection', { objectIds: ['candidate'], revision: 2 })).status, 200);
  assert.deepEqual((await f.request('/api/selection')).body.selection.objectIds, ['candidate']);
  assert.equal((await f.request('/api/undo', { operationId: 'undo', expectedRevision: 2, actor: 'human' })).status, 200);
  assert.equal((await f.request('/api/selection')).body.selection.stale, true);
  assert.deepEqual((await f.request('/api/selection')).body.selection.missingObjectIds, ['candidate']);
});

test('rejects cross-origin writes and preserves corrupted data instead of resetting', async t => {
  const f = await fixture(t);
  const attack = await f.request('/api/molecules', { operationId: 'evil', expectedRevision: 0, actor: 'human', smiles: 'CCO' }, { Origin: 'https://example.com' });
  assert.equal(attack.status, 403);
  await assert.rejects(startServer({ port: 0, dataDirectory: f.directory }), error => error.code === 'LOCKED');
  const other = await mkdtemp(path.join(os.tmpdir(), 'chem-canvas-corrupt-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  const file = path.join(other, 'document.json');
  await writeFile(file, '{not valid');
  await assert.rejects(startServer({ port: 0, dataDirectory: other }), error => error.code === 'STORAGE');
  assert.equal(await readFile(file, 'utf8'), '{not valid');
});

test('MCP stdio host client writes the same document read by the human HTTP UI', async t => {
  const f = await fixture(t);
  const client = new Client({ name: 'integration-agent', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../server/mcp.js', import.meta.url))], env: { ...process.env, CHEM_CANVAS_URL: f.app.url }, stderr: 'pipe' });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
    'canvas_adjust_depiction', 'canvas_apply', 'canvas_changes', 'canvas_edit_molecule',
    'canvas_edit_scheme', 'canvas_figure', 'canvas_import_cdxml', 'canvas_inspect_canvas', 'canvas_inspect_molecule',
    'canvas_inspect_scheme', 'canvas_layout_molecule', 'canvas_list_resources',
    'canvas_propose', 'canvas_publication', 'canvas_put_molecule', 'canvas_read', 'canvas_undo', 'chemistry_parse'
  ]);
  const read = JSON.parse((await client.callTool({ name: 'canvas_read', arguments: {} })).content[0].text);
  assert.equal(read.document.revision, 0);
  const result = await client.callTool({ name: 'canvas_put_molecule', arguments: { operationId: 'mcp-molecule', expectedRevision: 0, smiles: 'C[C@H](O)c1ccccc1', title: '手性结构候选' } });
  assert.notEqual(result.isError, true, result.content[0].text);
  const doc = (await f.request('/api/document')).body.document;
  assert.equal(doc.revision, 1);
  assert.equal(doc.history.at(-1).actor, 'agent');
  assert.match(Object.values(doc.objects)[0].data.smiles, /@/);
  const invalid = await client.callTool({ name: 'chemistry_parse', arguments: { smiles: 'bad!!!' } });
  assert.equal(invalid.isError, true);
  assert.deepEqual((await client.listTools()).tools, tools.tools);
});

