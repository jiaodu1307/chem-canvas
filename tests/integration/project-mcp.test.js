import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../../server/index.js';
import { projectEndpoint } from '../../server/project-binding.js';
import { pluginSettings } from '../../server/plugin-runtime.js';
import { buildConfig } from '../../integrations/deepseek/adapter.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chem-project-mcp-'));
  const app = await startServer({ port: 0, dataDirectory: directory });
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await app.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^chem-project-mcp-/);
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  async function connect(projectId, url = app.url) {
    const env = { ...process.env, CHEM_CANVAS_URL: url };
    delete env.CHEM_CANVAS_PROJECT_ID;
    if (projectId !== undefined) env.CHEM_CANVAS_PROJECT_ID = projectId;
    const client = new Client({ name: 'project-mcp-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../../server/mcp.js', import.meta.url))], env }));
    clients.push(client);
    return async (name, args = {}) => {
      const reply = await client.callTool({ name, arguments: args });
      return { failed: reply.isError === true, ...JSON.parse(reply.content[0].text) };
    };
  }
  async function post(route, input) {
    const res = await fetch(app.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    return { status: res.status, ...await res.json() };
  }
  return { app, connect, post };
}

test('MCP requires an explicit project when ambiguous, scopes every operation and returns current task', async t => {
  const { app, connect, post } = await fixture(t);
  const call = await connect();
  const legacy = await call('canvas_read');
  assert.equal(legacy.failed, false);
  assert.equal(legacy.workspace, undefined);
  assert.equal(legacy.projectId, undefined);
  const created = await post('/api/projects', { title: 'Other project', operationId: 'other-project' });
  assert.equal(created.status, 200);
  const other = created.project.id;
  const ambiguous = await call('canvas_read');
  assert.equal(ambiguous.error.code, 'PROJECT_REQUIRED');
  assert.deepEqual(ambiguous.error.projects.map(p => p.id).sort(), ['default', other].sort());
  const apply = (projectId, title) => call('canvas_apply', { projectId, expectedRevision: 0,
    operationId: 'same-operation', intent: 'Fixture', changes: [{ type: 'createObject', object: {
      id: 'shared-id', kind: 'note', title, data: { text: title },
    } }] });
  const first = await apply('default', 'First project');
  const second = await apply(other, 'Second project');
  assert.equal(first.failed, false, JSON.stringify(first));
  assert.equal(second.failed, false, JSON.stringify(second));
  assert.equal(first.projectId, 'default');
  assert.equal(second.projectId, other);
  const task = await post('/api/workspace/tasks?project=' + other, { expectedVersion: 0, operationId: 'create-task',
    action: 'create', title: 'Focus this selection', objectIds: ['shared-id'] });
  assert.equal(task.status, 200);
  const [a, b] = await Promise.all(['default', other].map(projectId => call('canvas_read', { projectId, objectIds: ['shared-id'] })));
  assert.equal(a.document.objects['shared-id'].title, 'First project');
  assert.equal(b.document.objects['shared-id'].title, 'Second project');
  assert.notEqual(a.document.id, b.document.id);
  assert.equal(a.workspace.currentTaskId, null);
  assert.equal(b.workspace.currentTaskId, task.currentTaskId);
  assert.equal(new URL(b.url).searchParams.get('project'), other);
  const denied = await call('canvas_apply', { expectedRevision: 1, operationId: 'ambiguous-write', intent: 'Must fail',
    changes: [{ type: 'updateObject', id: 'shared-id', patch: { title: 'wrong' } }] });
  assert.equal(denied.error.code, 'PROJECT_REQUIRED');
  const oldClient = await post('/api/operations', { actor: 'agent', expectedRevision: 1, operationId: 'old-write', intent: 'Must fail',
    changes: [{ type: 'updateObject', id: 'shared-id', patch: { title: 'wrong' } }] });
  assert.equal(oldClient.status, 409);
  assert.equal(oldClient.error.code, 'PROJECT_REQUIRED');
  const missing = await call('canvas_read', { projectId: 'missing' });
  assert.equal(missing.error.code, 'NOT_FOUND');
  assert.equal((await (await fetch(app.url + '/api/document?project=default')).json()).document.revision, 1);
});

test('MCP connection fixed by environment or URL cannot be redirected by a tool argument', async t => {
  const { app, connect, post } = await fixture(t);
  const { project } = await post('/api/projects', { title: 'Bound', operationId: 'bound-project' });
  const byEnv = await connect(project.id);
  const byUrl = await connect(undefined, app.url + '/?project=' + project.id);
  for (const call of [byEnv, byUrl]) {
    const read = await call('canvas_read');
    assert.equal(read.failed, false);
    assert.equal(read.projectId, project.id);
    assert.equal(read.workspace.projectId, project.id);
    assert.equal((await call('canvas_read', { projectId: 'default' })).error.code, 'PROJECT_MISMATCH');
  }
});

test('project connection settings reject invalid identifiers and conflicting bindings', () => {
  for (const value of ['../other', '__proto__', '', 'a/b', 'x'.repeat(97)]) {
    assert.throws(() => projectEndpoint('http://127.0.0.1:4317', value));
    assert.throws(() => pluginSettings({ CHEM_CANVAS_PROJECT_ID: value }));
  }
  assert.throws(() => projectEndpoint('http://127.0.0.1:4317/?project=a', 'b'), { code: 'PROJECT_MISMATCH' });
  assert.throws(() => projectEndpoint('http://127.0.0.1:4317/?project=a&project=b'));
  assert.equal(pluginSettings({ CHEM_CANVAS_URL: 'http://127.0.0.1:4317/?project=default' }).projectId, 'default');
  assert.throws(() => pluginSettings({ CHEM_CANVAS_URL: 'http://127.0.0.1:4317/?project=a', CHEM_CANVAS_PROJECT_ID: 'b' }), { code: 'PROJECT_MISMATCH' });
  assert.equal(buildConfig({ projectId: 'default' }).env.CHEM_CANVAS_PROJECT_ID, 'default');
  assert.throws(() => buildConfig({ projectId: '../wrong' }));
});
