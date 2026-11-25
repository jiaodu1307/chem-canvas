import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../../server/index.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chem-project-test-'));
  let app = await startServer({ port: 0, dataDirectory: directory });
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, get app() { return app; },
    async stop() { await app.close(); app = null; },
    async restart() { await app?.close(); app = null; app = await startServer({ port: 0, dataDirectory: directory }); },
    async request(route, input) {
      const response = await fetch(`${app.url}${route}`, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() };
    },
    async create(operationId, title = '同名项目') {
      const result = await this.request('/api/projects', { operationId, title });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body.project.id;
    },
    async document(project) { return (await this.request(`/api/document?project=${project}`)).body.document; }
  };
}

const molecule = smiles => ({ operationId: 'same-operation', expectedRevision: 0, actor: 'agent', intent: '创建测试结构', changes: [
  { type: 'createObject', object: { id: 'same-object', kind: 'molecule', title: '同名结构', data: { smiles } } },
  { type: 'createView', view: { id: 'same-view', objectId: 'same-object', x: 0, y: 0, width: 300, height: 200 } }
] });

test('projects isolate documents, selections, identical operation receipts, proposals and depiction cache over HTTP', async t => {
  const f = await fixture(t);
  const original = await readFile(path.join(f.directory, 'document.json'));
  const a = await f.create('create-a'), b = await f.create('create-b');
  const [first, second] = await Promise.all([f.request(`/api/operations?project=${a}`, molecule('CCO')), f.request(`/api/operations?project=${b}`, molecule('c1ccccc1'))]);
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.notEqual(first.body.document.id, second.body.document.id);
  assert.equal(first.body.document.revision, 1); assert.equal(second.body.document.revision, 1);
  assert.equal((await f.document(a)).objects['same-object'].data.smiles, 'CCO');
  assert.equal((await f.document(b)).objects['same-object'].data.smiles, 'c1ccccc1');
  assert.equal((await f.request(`/api/operations?project=${a}`, molecule('CCO'))).body.replayed, true);
  assert.equal((await f.request(`/api/operations?project=${b}`, molecule('CCO'))).status, 409);
  const svgA = await (await fetch(`${f.app.url}/api/depictions/same-object.svg?project=${a}`)).text();
  const svgB = await (await fetch(`${f.app.url}/api/depictions/same-object.svg?project=${b}`)).text();
  assert.match(svgA, /<svg/); assert.match(svgB, /<svg/); assert.notEqual(svgA, svgB);
  assert.equal(await (await fetch(`${f.app.url}/api/depictions/same-object.svg?project=${a}`)).text(), svgA);
  assert.equal((await f.request(`/api/selection?project=${a}`, { objectIds: ['same-object'], revision: 1 })).status, 200);
  assert.deepEqual((await f.request(`/api/selection?project=${b}`)).body.selection.objectIds, []);
  assert.deepEqual((await f.request(`/api/selection?project=${a}`)).body.selection.objectIds, ['same-object']);
  const proposal = { id: 'same-proposal', operationId: 'same-proposal-operation', expectedRevision: 1, actor: 'agent', title: '改变标题', rationale: '待确认', changes: [{ type: 'updateObject', id: 'same-object', patch: { title: '已确认候选' } }] };
  for (const id of [a, b]) assert.equal((await f.request(`/api/proposals?project=${id}`, proposal)).status, 200);
  assert.equal((await f.request(`/api/proposals/same-proposal/resolve?project=${a}`, { operationId: 'resolve', expectedRevision: 2, actor: 'human', action: 'accept' })).status, 200);
  assert.equal((await f.document(a)).objects['same-object'].title, '已确认候选');
  assert.equal((await f.document(b)).objects['same-object'].title, '同名结构');
  assert.equal((await f.document(b)).proposals['same-proposal'].status, 'pending');
  assert.equal((await f.request(`/api/undo?project=${a}`, { operationId: 'undo', expectedRevision: 3, actor: 'human' })).status, 200);
  assert.equal((await f.document(b)).revision, 2);
  assert.deepEqual(await readFile(path.join(f.directory, 'document.json')), original);
  assert.equal(f.app.store, f.app.workspaces.get('default').store);
  await f.restart();
  assert.equal((await f.document(a)).revision, 4);
  assert.equal((await f.document(b)).revision, 2);
  assert.equal((await f.request(`/api/operations?project=${b}`, molecule('c1ccccc1'))).body.replayed, true);
  assert.deepEqual((await f.request(`/api/selection?project=${a}`)).body.selection.objectIds, []);
  assert.deepEqual(await readFile(path.join(f.directory, 'document.json')), original);
});

test('project creation is replayable and persistent without migrating or rewriting legacy document', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/operations', molecule('CC'))).status, 200, 'single-project legacy agent remains compatible');
  const before = await readFile(path.join(f.directory, 'document.json'));
  const input = { title: '新项目', operationId: 'create' };
  const [one, two] = await Promise.all([f.request('/api/projects', input), f.request('/api/projects', input)]);
  assert.equal(one.body.project.id, two.body.project.id);
  assert.equal([one, two].filter(result => result.body.replayed === true).length, 1);
  assert.equal(one.body.project.revision, 0);
  assert.deepEqual(Object.keys((await f.document(one.body.project.id)).objects), []);
  assert.equal((await f.request('/api/projects', { ...input, title: '冲突' })).status, 409);
  assert.equal((await f.request('/api/projects', { ...input, operationId: 'path', directory: '../outside' })).status, 400);
  assert.deepEqual(await readFile(path.join(f.directory, 'document.json')), before);
  await f.restart();
  assert.equal((await f.request('/api/projects', input)).body.project.id, one.body.project.id);
  assert.equal((await f.request('/api/projects')).body.projects.length, 2);
  assert.deepEqual(await readFile(path.join(f.directory, 'document.json')), before);
});

test('task workspace has independent version, isolation, persistence and missing-reference markers', async t => {
  const f = await fixture(t), a = await f.create('a'), b = await f.create('b');
  await f.request(`/api/operations?project=${a}`, molecule('CCO'));
  const file = path.join(f.directory, 'projects', a, 'document.json'), original = await readFile(file);
  const input = { operationId: 'task-create', expectedVersion: 0, action: 'create', title: '解释局部', objectIds: ['same-object'] };
  const created = await f.request(`/api/workspace/tasks?project=${a}`, input);
  assert.equal(created.status, 200); assert.equal(created.body.version, 1);
  const taskId = created.body.currentTaskId;
  assert.equal(created.body.tasks[0].id, taskId);
  assert.equal((await f.request(`/api/workspace/tasks?project=${a}`, input)).body.replayed, true);
  assert.equal((await f.request(`/api/workspace/tasks?project=${a}`, { ...input, title: 'different' })).status, 409);
  assert.equal((await f.request(`/api/workspace/tasks?project=${a}`, { ...input, operationId: 'stale' })).status, 409);
  assert.equal((await f.request(`/api/workspace/tasks?project=${b}`, input)).status, 404, 'object from another project cannot be referenced');
  assert.deepEqual((await f.request(`/api/workspace?project=${b}`)).body, { projectId: b, version: 0, currentTaskId: null, tasks: [] });
  assert.equal((await f.request(`/api/workspace/tasks?project=${b}`, { operationId: 'alien', expectedVersion: 0, action: 'activate', taskId })).status, 404);
  const update = await f.request(`/api/workspace/tasks?project=${a}`, { operationId: 'update', expectedVersion: 1, action: 'update', taskId, title: '修改局部' });
  assert.equal(update.body.tasks[0].title, '修改局部');
  const archived = await f.request(`/api/workspace/tasks?project=${a}`, { operationId: 'archive', expectedVersion: 2, action: 'archive', taskId });
  assert.equal(archived.body.currentTaskId, null); assert.equal(archived.body.tasks[0].status, 'archived');
  const active = await f.request(`/api/workspace/tasks?project=${a}`, { operationId: 'activate', expectedVersion: 3, action: 'activate', taskId });
  assert.equal(active.body.currentTaskId, taskId); assert.equal(active.body.tasks[0].status, 'active');
  assert.deepEqual(await readFile(file), original, 'task metadata never changes chemical envelope bytes');
  await f.restart();
  assert.deepEqual((await f.request(`/api/workspace?project=${a}`)).body, active.body);
  assert.equal((await f.request(`/api/workspace/tasks?project=${a}`, input)).body.version, 4, 'replay returns latest workspace');
  assert.equal((await f.request(`/api/operations?project=${a}`, { operationId: 'delete', expectedRevision: 1, actor: 'human', intent: '删除测试结构', changes: [{ type: 'deleteView', id: 'same-view' }, { type: 'deleteObject', id: 'same-object' }] })).status, 200);
  const missing = (await f.request(`/api/workspace?project=${a}`)).body;
  assert.deepEqual(missing.tasks[0].objectIds, ['same-object']);
  assert.deepEqual(missing.tasks[0].missingObjectIds, ['same-object']);
  assert.equal(missing.version, 4);
});

test('simultaneous task mutations enforce one version and invalid inputs do not advance it', async t => {
  const f = await fixture(t);
  const [one, two] = await Promise.all(['one', 'two'].map(operationId => f.request('/api/workspace/tasks?project=default', { operationId, expectedVersion: 0, action: 'create', title: operationId })));
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  const before = await readFile(path.join(f.directory, 'workspace.json'));
  for (const patch of [{ operationId: '__proto__' }, { objectIds: ['constructor'] }, { objectIds: ['absent'] }, { expectedVersion: -1 }, { title: ' ' }, { action: 'reset' }, { file: '../../outside' }]) {
    const invalid = await f.request('/api/workspace/tasks?project=default', { operationId: 'invalid', expectedVersion: 1, action: 'create', title: '任务', ...patch });
    assert.ok(invalid.status >= 400, JSON.stringify(invalid));
    assert.deepEqual(await readFile(path.join(f.directory, 'workspace.json')), before);
  }
});

test('project routing rejects unknown and ambiguous ids, protects unbound legacy agents and keeps health installation-scoped', async t => {
  const f = await fixture(t), a = await f.create('a');
  for (const id of ['', '..', '../outside', '__proto__', 'constructor']) assert.equal((await f.request(`/api/document?project=${encodeURIComponent(id)}`)).status, 400);
  assert.equal((await f.request('/api/document?project=default&project=default')).status, 400);
  const absent = 'project-00000000-0000-0000-0000-000000000000';
  assert.equal((await f.request(`/api/document?project=${absent}`)).status, 404);
  assert.equal((await f.request(`/api/operations?project=${absent}`, molecule('CCO'))).status, 404);
  const denied = await f.request('/api/operations', molecule('CCO'));
  assert.equal(denied.status, 409); assert.equal(denied.body.error.code, 'PROJECT_REQUIRED');
  assert.equal((await f.request('/api/operations', { ...molecule('CCO'), actor: 'human' })).status, 200);
  assert.equal((await f.request('/api/operations?project=default', { ...molecule('CCO'), operationId: 'agent-bound', expectedRevision: 1, changes: [{ type: 'updateObject', id: 'same-object', patch: { title: '明确项目' } }] })).status, 200);
  assert.equal((await f.document(a)).revision, 0);
  assert.deepEqual((await f.request(`/api/health?project=${a}`)).body, (await f.request('/api/health')).body);
  const adapter = await fetch(`${f.app.url}/host-selection-annotation.js?project=${a}`);
  assert.equal(adapter.status, 200);
  assert.equal(await adapter.text(), await readFile(new URL('../../integrations/codex/embedded/selection-annotation.js', import.meta.url), 'utf8'));
  assert.equal((await fetch(`${f.app.url}/integrations/codex/embedded/selection-annotation.js`)).status, 404);
});

test('structure resource directories are project-scoped even with identical resource names', async t => {
  const f = await fixture(t), a = await f.create('a'), b = await f.create('b');
  for (const [id, smiles] of [[a, 'CCO'], [b, 'CCN']]) {
    await f.request(`/api/operations?project=${id}`, molecule(smiles));
    const document = await f.document(id), imports = path.join(f.directory, 'projects', id, 'imports');
    await mkdir(imports);
    await writeFile(path.join(imports, 'same.mol'), document.objects['same-object'].data.molblock);
  }
  const resourceA = (await f.request(`/api/structure-resources?project=${a}`)).body.resources[0];
  const resourceB = (await f.request(`/api/structure-resources?project=${b}`)).body.resources[0];
  assert.equal(resourceA.resourceId, resourceB.resourceId); assert.notEqual(resourceA.sha256, resourceB.sha256);
  assert.deepEqual((await f.request('/api/structure-resources')).body.resources, []);
  const imported = await f.request(`/api/molecules?project=${b}`, { operationId: 'import', expectedRevision: 1, actor: 'agent', resourceId: resourceA.resourceId, resourceSha256: resourceA.sha256 });
  assert.equal(imported.status, 409);
  assert.equal((await f.document(b)).revision, 1);
});

test('startup fails closed on damaged metadata, missing project documents and junction escapes', async t => {
  const f = await fixture(t), a = await f.create('a');
  const catalogFile = path.join(f.directory, 'projects.json'), catalog = await readFile(catalogFile);
  const projectFile = path.join(f.directory, 'projects', a, 'document.json'), document = await readFile(projectFile);
  await f.stop();
  await writeFile(catalogFile, '{broken');
  await assert.rejects(f.restart(), error => error.code === 'STORAGE');
  assert.equal(await readFile(catalogFile, 'utf8'), '{broken');
  await writeFile(catalogFile, 'null');
  await assert.rejects(f.restart(), error => error.code === 'STORAGE');
  assert.equal(await readFile(catalogFile, 'utf8'), 'null');
  await writeFile(catalogFile, catalog);
  await rm(projectFile);
  await assert.rejects(f.restart(), error => error.code === 'ENOENT');
  await assert.rejects(access(projectFile), error => error.code === 'ENOENT');
  await writeFile(projectFile, document);
  const workspaceFile = path.join(f.directory, 'projects', a, 'workspace.json');
  await writeFile(workspaceFile, '{broken');
  await assert.rejects(f.restart(), error => error.code === 'STORAGE');
  assert.equal(await readFile(workspaceFile, 'utf8'), '{broken');
  await rm(workspaceFile);
  await f.restart();
  assert.equal((await f.document(a)).revision, 0, 'startup failure released all previously opened locks');
  await f.stop();

  const escape = await mkdtemp(path.join(os.tmpdir(), 'chem-project-escape-'));
  t.after(() => rm(escape, { recursive: true, force: true }));
  const fakeId = 'project-00000000-0000-0000-0000-000000000000';
  await symlink(escape, path.join(f.directory, 'projects', fakeId), process.platform === 'win32' ? 'junction' : 'dir');
  const modified = JSON.parse(catalog); modified.projects.push({ id: fakeId, title: 'escape' });
  await writeFile(catalogFile, JSON.stringify(modified));
  await assert.rejects(f.restart(), error => error.code === 'STORAGE');
  await assert.rejects(access(path.join(escape, 'document.json')), error => error.code === 'ENOENT');
});
