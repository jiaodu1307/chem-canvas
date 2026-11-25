import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { verifyContract } from './contract.mjs';
import {profileArgs,toolsForProfile} from '../../server/tool-profile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = process.env.CHEM_ACCEPT_RUNTIME || path.resolve(here, '../..');
const { startServer } = await import(pathToFileURL(path.join(runtime, 'server/index.js')));
const fixtureRoot = path.join(here, '.validation');
await mkdir(fixtureRoot, { recursive: true });
const directory = await mkdtemp(path.join(fixtureRoot, 'smoke-'));
let app, client;
try {
  app = await startServer({ port: 0, dataDirectory: directory });
  const { mcpServers } = JSON.parse(await readFile(path.join(process.env.CHEM_ACCEPT_PACKAGE || here, 'plugin/.mcp.json'), 'utf8'));
  const server = mcpServers['chem-canvas'];
  assert.equal(server.args[0], path.join(runtime, 'server/plugin.js'));
  const options=profileArgs(process.argv.slice(2));
  assert.equal(options.args.length,0,'Usage: node integrations/codex/smoke.mjs [--profile full|figure|figure-chemistry]');
  const connectionEnv={...process.env,...server.env,...options.env};
  const profile=connectionEnv.CHEM_CANVAS_TOOL_PROFILE || 'full';
  client = new Client({ name: 'chem-canvas-codex-bundle-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ ...server, env: {
    ...connectionEnv, CHEM_CANVAS_URL: app.url,
    CHEM_CANVAS_DATA_DIR: directory, CHEM_CANVAS_AUTOSTART: '0'
  }, stderr: 'pipe' }));
  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name).sort();
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  if(profile==='full'){
    const schemaDigest=verifyContract(listed.tools);
    const initial = await call('canvas_read');
    assert.equal(initial.url, app.url);
    assert.equal(initial.document.revision, 0);
    const parsed = await call('chemistry_parse', { smiles: 'c1ccccc1' });
    assert.equal(parsed.molecule.atoms.length, 6);
    const request = { operationId: 'codex-bundle-smoke', expectedRevision: 0, smiles: 'CCO', title: 'Isolated plugin smoke' };
    const changed = await call('canvas_put_molecule', request);
    assert.equal(changed.document.revision, 1);
    const http = await (await fetch(`${app.url}/api/document`)).json();
    assert.equal(http.document.id, initial.document.id);
    assert.equal(http.document.history.at(-1).actor, 'agent');
    assert.equal(Object.values(http.document.objects)[0].data.smiles, 'CCO');
    assert.equal((await call('canvas_put_molecule', request)).replayed, true);
    const changes = await call('canvas_changes', { sinceRevision: 0 });
    assert.equal(changes.events.length, 1);
    assert.equal(changes.events[0].objects[0].moleculeDelta.addedAtoms.length, 3);
    await call('canvas_undo', { operationId: 'codex-smoke-undo', expectedRevision: 1 });
    assert.deepEqual((await call('canvas_read')).document.objects, {});
    const changeset = [['s','molecule',{smiles:'CCO'}],['p','molecule',{smiles:'CC=O'}],['rx','reaction',{above:'test label'}]].flatMap(([id,kind,data],index) => [
      {type:'createObject',object:{id,kind,title:id,data}}, {type:'createView',view:{id:`view-${id}`,objectId:id,x:index*330,y:0,width:300,height:210}}]);
    changeset.push(...[['s','rx','reactant'],['rx','p','product']].map(([from,to,kind]) => ({type:'createRelation',relation:{id:kind,from,to,kind,fromViewId:`view-${from}`,toViewId:`view-${to}`}})));
    const saved = await call('canvas_apply',{expectedRevision:2,operationId:'scheme',intent:'isolated reaction',changes:changeset});
    for (const tool of ['canvas_inspect_canvas','canvas_inspect_scheme']) {
      const response = await client.callTool({name:tool,arguments:{includeSvg:true}});
      assert.notEqual(response.isError,true,response.content[0].text);
      const body = JSON.parse(response.content[0].text);
      assert.equal(body.revision,saved.document.revision); assert.match(body.svg,/<svg/);
      const image = response.content.find(part=>part.type==='image'); assert.equal(image.mimeType,'image/png');
      assert.equal(Buffer.from(image.data,'base64').subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      if (tool==='canvas_inspect_scheme') { assert.deepEqual(body.steps[0].reactants,['s']); assert.deepEqual(body.steps[0].products,['p']); assert.match(body.svg,/test label/); }
      else assert.equal(body.relations[0].fromViewId,`view-${saved.document.relations[body.relations[0].relationId].from}`);
    }
    await call('canvas_propose',{operationId:'review',expectedRevision:3,id:'proposal',title:'Compare label',rationale:'review',changes:[{type:'updateObject',id:'rx',patch:{title:'review label'}}]});
    const beforeRestart = await fetch(`${app.url}/api/document`).then(response=>response.json());
    assert.equal(beforeRestart.document.objects.rx.title,'rx'); assert.ok(beforeRestart.document.proposals.proposal);
    if (names.includes('canvas_edit_scheme')) {
      const initial = await call('canvas_inspect_scheme',{includeImage:false});
      const arrow = initial.elements.find(element=>element.kind==='arrow');
      const move = {id:arrow.id,x:arrow.x+11,y:arrow.y+5};
      const input = {expectedRevision:initial.revision,expectedLayoutVersion:initial.layoutVersion,operationId:'edit-scheme',moves:[move],includeImage:false};
      const preview = await call('canvas_edit_scheme',{...input,mode:'preview'}); assert.equal(preview.state,'preview');
      assert.equal((await call('canvas_read')).document.revision,initial.revision);
      const commit = {...input,mode:'commit'}; const edited = await call('canvas_edit_scheme',commit);
      assert.equal(edited.elements.find(element=>element.id===arrow.id).x,move.x); assert.equal((await call('canvas_edit_scheme',commit)).replayed,true);
      const conflict = await client.callTool({name:'canvas_edit_scheme',arguments:{...commit,operationId:'stale',expectedRevision:edited.revision}});
      assert.equal(JSON.parse(conflict.content[0].text).error.code,'CONFLICT');
      await call('canvas_undo',{expectedRevision:edited.revision,operationId:'undo-layout'});
      assert.equal((await call('canvas_inspect_scheme',{includeImage:false})).elements.find(element=>element.id===arrow.id).x,arrow.x);
    }
    const finalDocument = (await fetch(`${app.url}/api/document`).then(response=>response.json())).document;
    await app.close(); app = await startServer({port:0,dataDirectory:directory});
    assert.deepEqual((await fetch(`${app.url}/api/document`).then(response=>response.json())).document,finalDocument);
    console.log(JSON.stringify({ smoke: 'passed', schemaDigest, toolCount: names.length, tools: names,
      checks: ['bundle command stdio handshake','input schemas','shared HTTP document','real chemistry','agent provenance','replay','history','undo','anchored overview and semantic scheme PNG/SVG','proposal isolation','restart persistence',...(names.includes('canvas_edit_scheme')?['incremental editable scheme preview/commit/replay/conflict/undo']:[])],
      existingServicesTouched: false }, null, 2));
  } else {
    assert.deepEqual(names,[...toolsForProfile(profile)].sort());
    const rejected=await client.callTool({name:'canvas_read',arguments:{}});
    assert.equal(rejected.isError,true);
    let state=await call('canvas_figure',{mode:'read'});
    let slot='';
    if(profile==='figure-chemistry'){
      const parsed=await call('chemistry_parse',{smiles:'O=Cc1ccccc1'});
      await call('canvas_put_molecule',{operationId:'smoke-add',expectedRevision:state.revision,title:'benzaldehyde',smiles:parsed.molecule.smiles});
      state=await call('canvas_figure',{mode:'read'});
      slot='<svg data-molecule-id="'+state.molecules[0].id+'" x="4" y="4" width="100" height="60"/>';
    }
    const source='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 80"><text x="115" y="42">Example</text>'+slot+'</svg>';
    const preview=await call('canvas_figure',{mode:'preview',source,includeImage:false});
    assert.equal(preview.molecules.length,slot?1:0);
    await call('canvas_figure',{mode:'save',source,expectedRevision:state.revision,operationId:'smoke-figure'});
    const saved=await call('canvas_figure',{mode:'read'});
    assert.equal(saved.figure.source,source);
    const exported=await call('canvas_figure',{mode:'export',expectedRevision:saved.revision,includeSvg:true,includeImage:false});
    assert.equal(exported.checkedChemistry,Boolean(slot));
    const file=await fetch(exported.downloadUrl);
    assert.equal(file.status,200);assert.equal(await file.text(),exported.svg);
    console.log(JSON.stringify({smoke:'passed',profile,tools:names,revision:saved.revision,verifiedMolecules:exported.molecules.length,excludedToolRejected:true}));
  }
} finally {
  try { await client?.close(); } finally {
    try { await app?.close(); } finally {
      assert.equal(path.dirname(path.resolve(directory)), fixtureRoot);
      assert.ok(path.basename(directory).startsWith('smoke-'));
      await rm(directory, { recursive: true, force: true });
    }
  }
}
