import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
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
  for(const host of ['generic','cursor','claude-desktop','gemini'])assert.deepEqual(entry(config(host)),local);
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
