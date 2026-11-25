import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startServer } from '../server/index.js';

const execute = promisify(execFile);
const doctor = fileURLToPath(new URL('../scripts/plugin-doctor.js', import.meta.url));

test('doctor verifies the generated launcher, tool profile and explicit project without editing a figure', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chem doctor '));
  const app = await startServer({ port: 0, dataDirectory: directory });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const env = { ...process.env, CHEM_CANVAS_URL: app.url, CHEM_CANVAS_DATA_DIR: directory, CHEM_CANVAS_AUTOSTART: '0' };
  delete env.CHEM_CANVAS_PROJECT_ID;
  delete env.CHEM_CANVAS_TOOL_PROFILE;
  const run = async (...args) => JSON.parse((await execute(process.execPath, [doctor, ...args], { env, cwd: tmpdir() })).stdout);
  const mcp = result => result.checks.find(check => check.name === 'MCP stdio')?.value;

  const basic = await run();
  assert.equal(basic.ok, true);
  assert.equal(mcp(basic), undefined);

  const singleProject = mcp(await run('--mcp', '--profile', 'figure'));
  assert.deepEqual(singleProject.tools, ['canvas_figure']);
  assert.equal(singleProject.projectId, 'default');
  assert.equal(singleProject.revision, 0);

  const created = await fetch(app.url + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Doctor fixture', operationId: 'doctor-test-project' }) });
  assert.equal(created.status, 200);
  const { project } = await created.json();
  const ambiguous = mcp(await run('--mcp', '--profile', 'figure-chemistry'));
  assert.deepEqual(ambiguous.tools, ['canvas_figure', 'canvas_put_molecule', 'chemistry_parse']);
  assert.equal(ambiguous.status, 'PROJECT_REQUIRED');
  assert.deepEqual(ambiguous.projects.sort(), ['default', project.id].sort());

  const selected = mcp(await run('--mcp', '--url', app.url, '--project', project.id, '--profile', 'full'));
  assert.equal(selected.projectId, project.id);
  assert.equal(selected.revision, 0);
  assert.equal(selected.status, 'read');
  assert.ok(selected.tools.includes('canvas_read'));
  assert.equal(new URL(selected.editorUrl).searchParams.get('project'), project.id);
  assert.equal((await (await fetch(app.url + '/api/figure?project=default')).json()).revision, 0);

  await assert.rejects(run('--mcp', '--project', 'missing-project'), error => {
    const result = JSON.parse(error.stdout);
    assert.equal(result.ok, false);
    assert.match(mcp(result), /NOT_FOUND/);
    return true;
  });
});
