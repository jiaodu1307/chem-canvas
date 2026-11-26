import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {startServer} from '../../server/index.js';
import {createMcpServer} from '../../server/mcp.js';

test('figure print proof uses the requested physical width without changing the drawing',async t=>{
  const app=await startServer({port:0,dataDirectory:await mkdtemp(path.join(os.tmpdir(),'figure-print-'))});
  const client=new Client({name:'print-proof',version:'1'});
  t.after(async()=>{await client.close();await app.close();});
  const [left,right]=InMemoryTransport.createLinkedPair();
  await createMcpServer(app.url,{projectId:'default'}).connect(right);await client.connect(left);
  const call=args=>client.callTool({name:'canvas_figure',arguments:args});
  const source='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 100" font-size="17"><text x="20" y="40">98.1</text><svg width="20" height="20"><text y="12">X</text></svg></svg>';
  const preview=async options=>{
    const reply=await call({mode:'preview',source,includeImage:false,includeSvg:true,...options});
    assert.ok(!reply.isError,reply.content[0].text);return JSON.parse(reply.content[0].text);
  };
  const plain=await preview({});
  assert.equal(plain.textPreflight,undefined);
  assert.equal((await preview({checkText:true})).textPreflight.printFonts,undefined);
  for(const [width,pt] of [[85,4.1],[170,8.19]]){
    const result=await preview({printWidthMm:width});
    assert.equal(result.svg,plain.svg);
    assert.equal(result.revision,0);
    const fonts=result.textPreflight.printFonts;
    assert.deepEqual([fonts.printWidthMm,fonts.measuredRuns,fonts.unassessedRuns],[width,1,1]);
    assert.deepEqual(fonts.runs.map(run=>run.pointSize),[pt,null]);
  }
  const modeError=await call({mode:'save',source,printWidthMm:85,expectedRevision:0,operationId:'wrong-mode'});
  assert.equal(JSON.parse(modeError.content[0].text).error.code,'VALIDATION');
  for(const printWidthMm of [null,0,-10,'85']){
    const response=await fetch(app.url+'/api/figure/preview?project=default',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,printWidthMm})});
    assert.equal(response.status,400);
  }
  const state=await (await fetch(app.url+'/api/figure?project=default')).json();
  assert.equal(state.revision,0);assert.equal(state.figure,null);
});
