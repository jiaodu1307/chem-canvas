import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startServer} from '../server/index.js';
import {startMcpHttp} from '../scripts/plugin-http.js';

// Node's fetch can replace Host. Use a real HTTP request for header-boundary checks.
function status(url,method,headers={}){
  return new Promise((resolve,reject)=>{
    const req=http.request(url,{method,headers},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
}

test('Streamable HTTP serves a pinned project to a real client and enforces local header and path boundaries',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'chem-http-'));
  const app=await startServer({port:0,dataDirectory:directory});
  let bridge,client;
  t.after(async()=>{
    await client?.close();await bridge?.close();await app.close();
    await rm(directory,{recursive:true,force:true,maxRetries:3});
  });
  const base={canvasUrl:app.url,port:0,profile:'figure'};
  await assert.rejects(startMcpHttp(base),/projectId/);
  await assert.rejects(startMcpHttp({...base,projectId:'missing'}),/项目不存在/);
  bridge=await startMcpHttp({...base,projectId:'default'});
  const endpoint=new URL(bridge.url);
  assert.equal(endpoint.hostname,'127.0.0.1');
  assert.equal(await status(endpoint,'GET',{Host:'example.org'}),403);
  assert.equal(await status(endpoint,'POST',{Origin:'https://example.org'}),403);
  assert.equal(await status(endpoint,'POST',{'Sec-Fetch-Site':'cross-site'}),403);
  assert.equal(await status(endpoint,'GET',{Origin:endpoint.origin}),405);
  assert.equal(await status(endpoint,'DELETE'),405);
  assert.equal(await status(bridge.url+'?project=other','POST'),404);
  assert.equal(await status(new URL('/api/document',endpoint),'GET'),404);
  client=new Client({name:'chem-canvas-http-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['canvas_figure']);
  const call=async args=>{
    const reply=await client.callTool({name:'canvas_figure',arguments:args});
    assert.ok(!reply.isError,reply.content[0].text);return JSON.parse(reply.content[0].text);
  };
  const state=await call({mode:'read'});
  const source='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><text x="8" y="20">Sample</text></svg>';
  await call({mode:'save',source,expectedRevision:state.revision,operationId:'http-figure'});
  const saved=await call({mode:'read'});assert.equal(saved.figure.source,source);
  const drawing=await call({mode:'export',expectedRevision:saved.revision,includeSvg:true});
  assert.match(drawing.svg,/Sample/);
  const different=await client.callTool({name:'canvas_figure',arguments:{mode:'read',projectId:'other'}});
  assert.equal(different.isError,true);
  assert.equal(JSON.parse(different.content[0].text).error.code,'PROJECT_MISMATCH');
});
