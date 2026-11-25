import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {parse} from 'jsonc-parser';
import {startServer} from '../server/index.js';

const script=fileURLToPath(new URL('../scripts/plugin-config.js',import.meta.url));
const cli=(...args)=>execFileSync(process.execPath,[script,...args],{cwd:os.tmpdir(),encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const entry=config=>config.mcpServers['chem-canvas'];

test('host settings select the same executable, checkout, tool profile and bound project',()=>{
  const options=['--profile','figure-chemistry','--url','http://localhost:8732','--project','paper'];
  const local=entry(JSON.parse(cli(...options)));
  assert.equal(local.command,process.execPath);
  assert.equal(local.args[0],fileURLToPath(new URL('../server/plugin.js',import.meta.url)));
  assert.deepEqual(local.env,{CHEM_CANVAS_URL:'http://localhost:8732',CHEM_CANVAS_PROJECT_ID:'paper',CHEM_CANVAS_TOOL_PROFILE:'figure-chemistry'});
  const config=host=>JSON.parse(cli('--host',host,...options));
  for(const host of ['generic','cursor','claude-desktop','gemini','qoder','qoder-cn','kimi'])assert.deepEqual(entry(config(host)),local);
  assert.deepEqual(entry(config('trae')), {...local, command: /\s/.test(process.execPath) ? 'node' : process.execPath});
  const {type, ...qoderCli} = entry(config('qoder-cli'));
  assert.ok(type === undefined || type === 'stdio');
  assert.deepEqual(qoderCli, local);
  assert.deepEqual(entry(config('claude-code')),{type:'stdio',...local});
  assert.deepEqual(config('vscode').servers['chem-canvas'],{type:'stdio',...local});
  assert.deepEqual(entry(config('copilot-cli')),{type:'local',...local,tools:['*']});
  assert.deepEqual(config('zed').context_servers['chem-canvas'],local);
  assert.deepEqual(config('opencode').mcp.servers['chem-canvas'],{type:'local',command:[local.command,...local.args],environment:local.env});
  const toml=cli('--host','codex',...options);
  assert.match(toml,/^\[mcp_servers\.chem-canvas\]/);
  for(const [k,v] of Object.entries({command:local.command,args:local.args,...local.env}))assert.ok(toml.includes(k+' = '+JSON.stringify(v)));
  assert.deepEqual(entry(JSON.parse(cli())).env,{CHEM_CANVAS_URL:'http://127.0.0.1:4317'});
  assert.throws(()=>cli('--host','unconfigured'),/Unknown host/);
  assert.throws(()=>cli('--url','https://example.com'),/loopback/);
  assert.throws(()=>cli('--project','..'),/projectId/);
});

test('regional hosts install usable stdio entries in project and IDE settings', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chem host 测试 '));
  const app = await startServer({port: 0, dataDirectory: path.join(workspace, 'isolated data')});
  t.after(async () => {
    await app.close();
    await rm(workspace, {recursive: true, force: true, maxRetries: 3});
  });
  const cases = [
    ['trae', '.trae/mcp.json', '--install-project'],
    ['qoder-cli', '.qoder/settings.local.json', '--install-project'],
    ['kimi', '.kimi-code/mcp.json', '--install-project'],
    ['qoder', 'qoder-mcp.json', '--install-file'],
    ['qoder-cn', 'qoder-cn-mcp.json', '--install-file'],
  ];
  for (const [host, relative, option] of cases) {
    const filename = path.join(workspace, relative);
    const args = ['--host', host, '--profile', 'figure', '--url', app.url, '--project', 'default'];
    const destination = [option, option === '--install-project' ? workspace : filename];
    cli(...args, ...destination);
    const installed = await readFile(filename, 'utf8');
    const server = entry(JSON.parse(installed));
    assert.deepEqual(server, entry(JSON.parse(cli(...args))), host);
    cli(...args, ...destination);
    assert.equal(await readFile(filename, 'utf8'), installed, host);

    const client = new Client({name: 'regional-host-test', version: '1'});
    try {
      await client.connect(new StdioClientTransport({...server, cwd: workspace}));
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['canvas_figure'], host);
      const reply = await client.callTool({name: 'canvas_figure', arguments: {mode: 'read'}});
      assert.ok(!reply.isError, host);
      const figure = JSON.parse(reply.content[0].text);
      assert.equal(figure.projectId, 'default', host);
      assert.equal(figure.revision, 0, host);
    } finally {
      await client.close();
    }
  }
});

test('user installs select distinct Qoder files and respect KIMI_CODE_HOME', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chem-profile-'));
  t.after(() => rm(directory, {recursive: true, force: true, maxRetries: 3}));
  const env = {...process.env, HOME:directory, USERPROFILE:directory, KIMI_CODE_HOME:path.join(directory, 'kimi-data')};
  for (const [host, file] of [['qoder-cn', '.qoder-cn/mcp.json'], ['qoder', '.qoder/settings.json'], ['kimi', 'kimi-data/mcp.json']]) {
    execFileSync(process.execPath, [script, '--host', host, '--install-user', '--profile', 'figure-chemistry'], {env, stdio:'pipe'});
    const result = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    assert.equal(entry(result).env.CHEM_CANVAS_TOOL_PROFILE, 'figure-chemistry');
  }
});

test('TRAE CLI TOML launches the selected profile and project using only command and args', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trae-cli-'));
  const app = await startServer({port:0, dataDirectory:directory});
  t.after(async () => { await app.close(); await rm(directory, {recursive:true, force:true, maxRetries:3}); });
  const lines = cli('--host', 'trae-cli', '--profile', 'figure', '--url', app.url, '--project', 'default').split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '[mcp_servers.chem-canvas]');
  const command = JSON.parse(lines[1].slice('command = '.length));
  const args = JSON.parse(lines[2].slice('args = '.length));
  const client = new Client({name:'trae-cli-format', version:'1'});
  try {
    await client.connect(new StdioClientTransport({command, args, cwd:directory}));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['canvas_figure']);
    const result = await client.callTool({name:'canvas_figure', arguments:{mode:'read', includeImage:false}});
    assert.ok(!result.isError);
    assert.equal(JSON.parse(result.content[0].text).projectId, 'default');
  } finally { await client.close(); }
});

test('merging an IDE JSONC file preserves comments and other servers across conflicts and replacement', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chem settings '));
  t.after(() => rm(directory, {recursive: true, force: true, maxRetries: 3}));
  const filename = path.join(directory, 'settings.json');
  const original = [
    '{', '  // Keep the IDE preferences', '  "theme": "light",', '  "mcpServers": {',
    '    // Keep the spectroscopy tool', '    "spectra": { "command": "spectra" },', '  },', '}', '',
  ].join('\r\n');
  await writeFile(filename, original);
  const install = ['--host', 'qoder-cn', '--install-file', filename];
  cli(...install, '--profile', 'figure');
  const first = await readFile(filename, 'utf8');
  assert.match(first, /Keep the IDE preferences/);
  assert.match(first, /Keep the spectroscopy tool/);
  assert.deepEqual(parse(first).mcpServers.spectra, {command: 'spectra'});
  assert.equal(parse(first).theme, 'light');
  assert.equal(entry(parse(first)).env.CHEM_CANVAS_TOOL_PROFILE, 'figure');
  cli(...install, '--profile', 'figure');
  assert.equal(await readFile(filename, 'utf8'), first);
  assert.throws(() => cli(...install, '--profile', 'figure-chemistry'), /--replace/);
  assert.equal(await readFile(filename, 'utf8'), first);

  cli(...install, '--profile', 'figure-chemistry', '--replace');
  const replacement = await readFile(filename, 'utf8');
  const expected = parse(first);
  expected.mcpServers['chem-canvas'].env.CHEM_CANVAS_TOOL_PROFILE = 'figure-chemistry';
  assert.deepEqual(parse(replacement), expected);
  assert.match(replacement, /Keep the IDE preferences/);
  assert.match(replacement, /Keep the spectroscopy tool/);
  cli(...install, '--profile', 'figure-chemistry');
  assert.equal(await readFile(filename, 'utf8'), replacement);
});

test('an empty IDE settings file can be installed and invalid existing JSON is left intact', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chem blank file-'));
  t.after(() => rm(directory, {recursive: true, force: true, maxRetries: 3}));
  const file = path.join(directory, 'mcp.json');
  const install = ['--host', 'qoder-cn', '--install-file', file];
  for (const source of ['', '// Local MCP settings\r\n']) {
    await writeFile(file, source);
    cli(...install);
    const saved = await readFile(file, 'utf8');
    assert.ok(saved.startsWith(source));
    assert.ok(entry(parse(saved)).command);
  }
  const malformed = '{"mcpServers":';
  await writeFile(file, malformed);
  assert.throws(() => cli(...install, '--replace'), /valid JSON/);
  assert.equal(await readFile(file, 'utf8'), malformed);
});

test('a generated stdio config works from an unrelated directory and shares only the specified project',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'chem config 空格-'));
  const app=await startServer({port:0,dataDirectory:path.join(directory,'data')});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true,maxRetries:3});});
  const local=entry(JSON.parse(cli('--host','claude-code','--profile','figure','--url',app.url,'--project','default')));
  const client=new Client({name:'host-format-check',version:'1'});
  try {
    await client.connect(new StdioClientTransport({...local,cwd:directory}));
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['canvas_figure']);
    const call=async args=>{
      const reply=await client.callTool({name:'canvas_figure',arguments:args});
      assert.ok(!reply.isError,reply.content[0].text);
      return JSON.parse(reply.content[0].text);
    };
    const saved=await call({mode:'read'});
    const source='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 70"><text x="8" y="20">Sample</text></svg>';
    await call({mode:'save',source,operationId:'host-test',expectedRevision:saved.revision});
    const reopened=await call({mode:'read'});
    assert.equal(reopened.figure.source,source);
    const exported=await call({mode:'export',expectedRevision:reopened.revision});
    assert.equal((await fetch(exported.downloadUrl)).status,200);
    const denied=await client.callTool({name:'canvas_figure',arguments:{mode:'read',projectId:'other'}});
    assert.equal(denied.isError,true);
  } finally {
    await client.close();
  }
});
