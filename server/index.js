import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { applyOperation, createProposal, resolveProposal, undoOperation, getProposalAcceptances } from '../src/core/index.js';
import { getCapabilities, parseSmiles, parseMolblock } from '../src/chemistry/index.js';
import * as chemistry from '../src/chemistry/index.js';
import { DocumentStore, failure } from './store.js';
import { summarizeChanges, moleculeDifference } from './changes.js';
import { ProjectWorkspaces } from './project-workspaces.js';
import { StructureResources } from './structure-resources.js';
import { DRAWING_REVISION } from '../src/chemistry/drawing.js';
import { workflowMode, saveCandidate, moleculeProposalId } from './molecule-workflow.js';
import { readSelection, selectedInput } from './selection-context.js';
import { inspectStereochemistry } from '../src/chemistry/stereo-editing.js';
import { canvasOverview, canvasOverviewImage } from './canvas-overview.js';
import { editScheme } from './scheme-editor.js';
import { BenchmarkDashboard } from './benchmark-dashboard.js';
import { reactionScheme, SCHEME_VERSION } from './reaction-scheme.js';
import { readFigure, previewFigure, saveFigure, reviewFigure, renderSavedFigure } from './figure-document.js';
import { exportSchemeCdxml } from './chemdraw-export.js';
import { previewCdxmlImport, commitCdxmlImport } from './chemdraw-import.js';
import { publicationState, publicationLinks, previewPublication, savePublication, exportPublication } from './publication.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDirectory = path.join(root, 'public');
const MAX_BODY = 8 * 1024 * 1024;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.cdxml': 'chemical/x-cdxml; charset=utf-8' };

const acceptanceCache = new WeakMap();
function json(response, status, value) {
  if (value.document) {
    let proposalAcceptances = acceptanceCache.get(value.document);
    if (!proposalAcceptances) { proposalAcceptances = getProposalAcceptances(value.document); acceptanceCache.set(value.document, proposalAcceptances); }
    value = { ...value, proposalAcceptances };
  }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function readBytes(request) {
  const parts = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw failure('TOO_LARGE', '请求超过 8 MB。');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
async function body(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw failure('MEDIA_TYPE', '请求需要 application/json。');
  const bytes = await readBytes(request);
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected object');
    return parsed;
  } catch { throw failure('VALIDATION', '请求必须为 JSON 对象。'); }
}

function checkOrigin(request) {
  const host = request.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw failure('FORBIDDEN', '仅允许本机地址。');
  if (request.headers.origin) {
    let origin;
    try { origin = new URL(request.headers.origin); } catch { throw failure('FORBIDDEN', '不允许该来源。'); }
    if (origin.protocol !== 'http:' || origin.host !== host) throw failure('FORBIDDEN', '仅允许同源界面调用本地 API。');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') throw failure('FORBIDDEN', '不允许跨站访问本地数据。');
}

function chemistryPrefix(operationId, objectId = '') {
  return `m-${createHash('sha256').update(`${operationId}:${objectId}`).digest('hex').slice(0, 20)}`;
}

async function parseInput(input, prefix) {
  if (typeof input.molblock === 'string' && input.molblock.trim()) return parseMolblock(input.molblock, { idPrefix: prefix });
  if (typeof input.smiles === 'string' && input.smiles.trim()) return parseSmiles(input.smiles, { idPrefix: prefix });
  throw failure('VALIDATION', '请提供 SMILES 或 MOL 结构。');
}

async function normalizeChanges(document, changes, operationId) {
  if (!Array.isArray(changes) || changes.length > 250) throw failure('VALIDATION', 'changes 必须为不超过 250 项的操作数组。');
  const result = [];
  for (const change of changes) {
    const next = structuredClone(change);
    if (next.object?.kind === 'publication' || (next.type === 'updateObject' && document.objects[next.id]?.kind === 'publication')) {
      throw failure('VALIDATION', '期刊图表请通过专用接口预览或保存。');
    }
    if (next.type === 'createObject' && next.object?.kind === 'molecule') {
      next.object.data = await parseInput(next.object.data ?? {}, chemistryPrefix(operationId, next.object.id));
    } else if (next.type === 'updateObject' && document.objects[next.id]?.kind === 'molecule' && next.patch?.data) {
      next.patch.data = await parseInput(next.patch.data, chemistryPrefix(operationId, next.id));
    }
    result.push(next);
  }
  return result;
}

function editingBase(document, input) {
  if (typeof chemistry.editMolecule !== 'function') throw failure('CHEMISTRY_UNAVAILABLE', '结构编辑能力尚未就绪。');
  if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > 500) throw failure('VALIDATION', '需要 1 至 500 项原子/键编辑。');
  if (!input.objectId) return null;
  const object = document.objects[input.objectId];
  if (object?.kind !== 'molecule') throw failure('NOT_FOUND', '要编辑的分子不存在。');
  if (input.expectedObjectVersion !== object.version) throw failure('CONFLICT', '分子已被修改，请保留草稿并重新检查当前结构。');
  return object;
}

function depictionBase(document, input) {
  if (input.expectedRevision !== document.revision) throw failure('CONFLICT', '文档已变化，请重新读取后调整。');
  const object = document.objects[input.objectId];
  if (object?.kind !== 'molecule') throw failure('NOT_FOUND', '要调整的分子不存在。');
  if (input.expectedObjectVersion !== object.version) throw failure('CONFLICT', '分子已变化，请保留意图并重新读取。');
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 100) throw failure('VALIDATION', '需要 1 至 100 项局部显示操作。');
  return object;
}

import { macrocycleOptions } from '../src/chemistry/double-chain.js';
async function inspectMolecule(document, objectId, selection) {
  const object = document.objects[objectId];
  if (object?.kind !== 'molecule') throw failure('NOT_FOUND', '分子不存在。');
  const { atoms, bonds } = object.data;
  const neighbors = new Map(atoms.map(atom => [atom.id, []]));
  for (const bond of bonds) {
    neighbors.get(bond.from).push({ atomId: bond.to, bondId: bond.id, order: bond.order });
    neighbors.get(bond.to).push({ atomId: bond.from, bondId: bond.id, order: bond.order });
  }
  const rendered = await chemistry.renderMolecule(object.data);
  const diagnostics = typeof chemistry.inspectDepiction === 'function' ? await chemistry.inspectDepiction(object.data) : null;
  return { documentId: document.id, revision: document.revision, objectId, objectVersion: object.version, title: object.title,
    smiles: object.data.smiles, coordinateSystem: 'MOL 2D Cartesian coordinates; not SVG pixels or physical 3D distances',
    atoms: atoms.map(atom => ({ ...atom, neighbors: neighbors.get(atom.id), degree: neighbors.get(atom.id).length,
      terminalHydrogen: atom.atomicNumber === 1 && neighbors.get(atom.id).length === 1 && neighbors.get(atom.id)[0].order === 1 })),
    bonds: bonds.map(bond => ({ ...bond, terminalAtomIds: [bond.from, bond.to].filter(id => neighbors.get(id).length === 1) })),
    stereochemistry: await inspectStereochemistry(object.data), diagnostics, diagnosticsFor: 'current RDKit rendering; geometric estimates require visual inspection',
    macrocycles: macrocycleOptions(object.data), lastAdjustmentReport: object.data.depictionAdjustment ?? null, selection: readSelection(selection, document), svg: rendered.svg };
}

async function adjustDepiction(document, input) {
  const object = depictionBase(document, input);
  if (typeof chemistry.adjustDepiction !== 'function') throw failure('CHEMISTRY_UNAVAILABLE', '局部排版能力尚未就绪。');
  const { molecule } = await chemistry.adjustDepiction(object.data, { operations: input.operations });
  const delta = moleculeDifference(object.data, molecule);
  const targets = new Set(input.operations.flatMap(operation => operation.type === 'doubleChain' ? object.data.atoms.map(a=>a.id) : operation.type === 'relaxHydrogens' ? operation.atomIds : [operation.atomId]));
  if (molecule.smiles !== object.data.smiles || ['addedAtoms', 'removedAtoms', 'changedAtoms', 'addedBonds', 'removedBonds', 'changedBonds'].some(key => delta[key].length) || delta.movedAtoms.some(atom => !targets.has(atom.id))) {
    throw failure('VALIDATION', '局部排版改变了化学结构、身份或非目标坐标，已拒绝保存。');
  }
  return { object, molecule, delta };
}

export async function startServer({ port = Number(process.env.CHEM_CANVAS_PORT || 4317), dataDirectory = process.env.CHEM_CANVAS_DATA_DIR || path.join(root, '.local', 'workspace'),
  benchmarkDirectory = path.join(root, 'benchmarks', 'anthropic-route', 'runs'),
  feedbackDirectory = process.env.CHEM_CANVAS_BENCHMARK_FEEDBACK_DIR || path.join(root, '.local', 'benchmark-feedback'),
  replayDirectory = path.join(root, '.local', 'iteration-qa', 'route-overview') } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw failure('VALIDATION', '端口无效。');
  const store = await new DocumentStore(dataDirectory).start();
  const workspaces = await new ProjectWorkspaces(store).start();
  const benchmarks = new BenchmarkDashboard({ directory: benchmarkDirectory, feedbackDirectory, replayDirectory });
  const server = http.createServer(async (request, response) => {
    try {
      checkOrigin(request);
      const url = new URL(request.url, 'http://127.0.0.1');
      const project = workspaces.fromSearchParams(url.searchParams);
      const { store, resources, depictions } = project;
      const selection = project.selection;
      if(request.method==='GET' && url.pathname==='/api/figure'){
        if(url.searchParams.get('sinceRevision')===String(store.document.revision)){
          response.writeHead(204,{'Cache-Control':'no-store'});return response.end();
        }
        return json(response,200,readFigure(store.document));
      }
      if(request.method==='POST' && url.pathname==='/api/figure/preview'){
        const input=await body(request);
        return json(response,200,await previewFigure(store.document,input.source,input.checkText));
      }
      if(request.method==='POST' && url.pathname==='/api/figure/save')return json(response,200,await saveFigure(store,await body(request)));
      if(request.method==='POST' && url.pathname==='/api/figure/review')return json(response,200,await reviewFigure(store,await body(request)));
      if(request.method==='GET' && ['/api/figure/render','/api/figure/export'].includes(url.pathname)){
        const figure=await renderSavedFigure(store.document,url.searchParams.get('revision'));
        if(url.pathname.endsWith('/render'))return json(response,200,figure);
        response.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8','Content-Disposition':'attachment; filename="figure.svg"',
          'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox"});
        return response.end(figure.svg);
      }
      if (url.pathname === '/api/publication/workbooks' && request.method === 'GET') {
        return json(response, 200, await new StructureResources(store.directory, 'xlsx').list());
      }
      if (url.pathname === '/api/publication/import' && request.method === 'POST') {
        const { importPublicationXlsx, publicationRows } = await import('./publication-files.js');
        const mimeType = (request.headers['content-type'] ?? '').split(';')[0].toLowerCase();
        const sheetOptions = { sheetName:url.searchParams.get('sheetName') ?? undefined, listOnly:url.searchParams.get('listOnly') === '1' };
        if (mimeType === 'application/json') {
          const input = await body(request);
          if (!Object.hasOwn(input, 'resourceId')) return json(response, 200, await publicationRows(input.rows));
          if (typeof input.resourceSha256 !== 'string' || input.rows !== undefined) throw failure('VALIDATION', '请提供所列工作簿的文件名与 SHA-256。');
          const workbook = await new StructureResources(store.directory, 'xlsx').read(input.resourceId, {expectedSha256:input.resourceSha256});
          const result = await importPublicationXlsx(workbook.bytes, sheetOptions);
          const molecules = Object.values(store.document.objects).filter(object => object.kind === 'molecule');
          for (const row of result.experiments ?? []) {
            if (row.source) row.source = workbook.source.resourceId + ' · ' + row.source;
            if (!row.compoundId || molecules.some(m => m.id === row.compoundId)) continue;
            const matches = molecules.filter(m => m.title === row.compoundId);
            if (matches.length === 1) row.compoundId = matches[0].id;
          }
          return json(response, 200, { ...result, source:workbook.source, revision:store.document.revision });
        }
        if (mimeType !== 'application/octet-stream' && mimeType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') throw failure('MEDIA_TYPE', '请选择 Excel 工作簿或 CSV 数据。');
        return json(response, 200, await importPublicationXlsx(await readBytes(request), sheetOptions));
      }
      const input = request.method === 'POST' ? await body(request) : undefined;
      if (input && !url.searchParams.has('project') && input.actor === 'agent' && workspaces.projects.size > 1) throw failure('PROJECT_REQUIRED', '存在多个项目；Agent 必须明确绑定 project，不能向默认项目写入。');
      if (request.method === 'GET' && url.pathname === '/api/projects') return json(response, 200, workspaces.list());
      if (request.method === 'GET' && url.pathname === '/api/publication') {
        const doc = store.document;
        return json(response, 200, { ...publicationState(doc), downloads: publicationLinks(doc, project.id) });
      }
      if (request.method === 'POST' && url.pathname === '/api/publication/preview') return json(response, 200, await previewPublication(store.document, input.spec));
      if (request.method === 'POST' && url.pathname === '/api/publication/save') {
        const result = await savePublication(store, input);
        return json(response, 200, result);
      }
      if (request.method === 'GET' && url.pathname === '/api/publication/export') {
        const doc = store.document;
        const file = await exportPublication(doc, url.searchParams);
        response.writeHead(200, { 'Content-Type': file.contentType, 'Content-Disposition': `attachment; filename="${file.filename}"`,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Chem-Canvas-Revision': String(doc.revision) });
        return response.end(file.body);
      }
      if (request.method === 'POST' && url.pathname === '/api/projects') return json(response, 200, await workspaces.create(input));
      if (request.method === 'GET' && url.pathname === '/api/workspace') return json(response, 200, workspaces.workspace(project));
      if (request.method === 'POST' && url.pathname === '/api/workspace/tasks') return json(response, 200, await workspaces.updateTask(project, input));
      if (request.method === 'GET' && url.pathname === '/api/benchmarks') return json(response, 200, await benchmarks.list());
      if (request.method === 'GET' && url.pathname === '/api/benchmarks/cases') return json(response, 200, await benchmarks.cases());
      const caseAsset=url.pathname.match(/^\/api\/benchmarks\/cases\/([^/]+)\/assets\/(.+)$/);
      if(request.method==='GET'&&caseAsset){const asset=await benchmarks.caseAsset(decodeURIComponent(caseAsset[1]),decodeURIComponent(caseAsset[2]));response.writeHead(200,{'Content-Type':asset.mime,'X-Content-Type-Options':'nosniff'});return response.end(asset.content);}
      const schemeRun=url.pathname.match(/^\/api\/benchmarks\/runs\/([^/]+)\/(scheme(?:\.svg)?|source-text)$/);
      if(request.method==='GET'&&schemeRun){
        const id=decodeURIComponent(schemeRun[1]);
        if(schemeRun[2]==='source-text')return json(response,200,await benchmarks.sourceText(id));
        const result=await benchmarks.scheme(id);
        if(schemeRun[2]==='scheme.svg'){response.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; img-src data:; sandbox"});return response.end(result.svg);}
        return json(response,200,result);
      }
      if (request.method === 'GET' && url.pathname === '/api/benchmarks/feedback/export') {
        response.setHeader('Content-Disposition', 'attachment; filename="chem-canvas-feedback.json"');
        return json(response, 200, await benchmarks.exportFeedback());
      }
      const benchmarkRun = url.pathname.match(/^\/api\/benchmarks\/runs\/([^/]+)$/);
      if (request.method === 'GET' && benchmarkRun) return json(response, 200, await benchmarks.detail(decodeURIComponent(benchmarkRun[1]), url.searchParams.get('evaluation') || undefined));
      const benchmarkAsset = url.pathname.match(/^\/api\/benchmarks\/(assets|replays)\/([^/]+)\/(.+)$/);
      if (request.method === 'GET' && benchmarkAsset) {
        const asset = await benchmarks.asset(decodeURIComponent(benchmarkAsset[2]), decodeURIComponent(benchmarkAsset[3]), benchmarkAsset[1] === 'replays');
        response.writeHead(200, { 'Content-Type': asset.mime, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
        return response.end(asset.content);
      }
      if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { service: 'chem-canvas', version: '0.1.0', pid: process.pid, projectRoot: root, dataDirectory: workspaces.defaultStore.directory });
      if (request.method === 'GET' && url.pathname === '/api/structure-resources') return json(response, 200, await resources.list());
      if (request.method === 'GET' && url.pathname === '/api/document') return json(response, 200, { document: store.document });
      if (request.method === 'GET' && url.pathname === '/api/route/scheme') {
        const document=store.document, last=document.history?.at(-1);
        return json(response,200,{...await reactionScheme(document),canUndoDoubleChain:last?.summary==='大环双链展开' && last.reversible===true});
      }
      if (request.method === 'GET' && ['/api/route/scheme.cdxml', '/api/route/scheme/export'].includes(url.pathname)) {
        if (url.pathname.endsWith('/export') && url.searchParams.get('format') !== 'cdxml') throw failure('VALIDATION', '目前仅支持 CDXML 路线导出。');
        const value = url.searchParams.get('revision');
        if (!value || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw failure('VALIDATION', '导出需要明确的文档 revision。');
        const document = store.document;
        if (Number(value) !== document.revision) throw failure('CONFLICT', '文档已变化，请重新读取并确认布局后导出。');
        const result = await exportSchemeCdxml(document, await reactionScheme(document));
        const filename = `reaction-scheme-r${result.revision}.cdxml`;
        if (url.pathname.endsWith('/export')) return json(response, 200, { ...result, filename, format: 'cdxml' });
        response.writeHead(200, { 'Content-Type': 'chemical/x-cdxml; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Chem-Canvas-Revision': String(result.revision) });
        return response.end(result.cdxml);
      }
      if (request.method === 'GET' && url.pathname === '/api/route/scheme.png') {
        const doc=store.document;
        if(Number(url.searchParams.get('revision'))!==doc.revision)throw failure('CONFLICT','Refresh before exporting.');
        const image=canvasOverviewImage(await reactionScheme(doc));
        response.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});return response.end(Buffer.from(image.content.data,'base64'));
      }
      if (request.method === 'POST' && url.pathname === '/api/route/scheme') return json(response, 200, await reactionScheme(store.document, input));
      const inspectMatch = url.pathname.match(/^\/api\/molecules\/([^/]+)\/inspect$/);
      if (request.method === 'GET' && inspectMatch) return json(response, 200, await inspectMolecule(store.document, decodeURIComponent(inspectMatch[1]), selection));
      if (request.method === 'GET' && url.pathname === '/api/changes') return json(response, 200, summarizeChanges(store.document, { sinceRevision: Number(url.searchParams.get('sinceRevision') ?? 0), limit: Number(url.searchParams.get('limit') ?? 50), activity: url.searchParams.get('detail') === 'activity' }));
      const depictionMatch = url.pathname.match(/^\/api\/depictions\/([^/]+)\.svg$/);
      if (request.method === 'GET' && depictionMatch) {
        const object = store.document.objects[decodeURIComponent(depictionMatch[1])];
        if (object?.kind !== 'molecule') throw failure('NOT_FOUND', '分子不存在。');
        const style = url.searchParams.get('style') || 'acs1996';
        if (style !== 'acs1996') throw failure('VALIDATION', '当前仅提供 ACS1996 绘图配置。');
        if (typeof chemistry.renderMolecule !== 'function') throw failure('CHEMISTRY_UNAVAILABLE', '绘图配置正在更新。');
        const key = `${object.id}:${object.version}:${style}:${DRAWING_REVISION}`;
        let svg = depictions.get(key);
        if (!svg) {
          ({ svg } = await chemistry.renderMolecule(object.data, { style }));
          if (depictions.size >= 100) depictions.delete(depictions.keys().next().value);
          depictions.set(key, svg);
        }
        response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        return response.end(svg);
      }
      if (request.method === 'GET' && url.pathname === '/api/selection') return json(response, 200, { selection: readSelection(selection, store.document) });
      if (request.method === 'GET' && url.pathname === '/api/capabilities') return json(response, 200, { chemistry: await getCapabilities(), agent: { mode: 'external-tools', protocol: 'mcp-stdio', autonomousModel: false }, editing: { figure:{tool:'canvas_figure',view:'/figure.html',modes:['read','preview','save','export'],format:'svg',chemistry:'bound-molecules-only'}, publication: { tool: 'canvas_publication', view: '/publication.html', kinds: ['scope','optimization'], journals: ['orglett','obc'] }, selection: { schemaVersion: 1, savedOnly: true, fragmentRequiresObjectVersion: true, usableFlag: true, draftTransport: false }, reactionScheme: { tool: 'canvas_inspect_scheme', route: '/api/route/scheme', view: '/scheme.html', readOnly: false, version: SCHEME_VERSION, arrowDirections:['right','down','left','up'], labelOnlyEndpoints:{objectKind:'note',printedField:'data.label or title'}, captionField:'reaction.data.schemeCaption', catalyticCycle:{field:'reaction.data.schemeCycle',sharesClosingState:true,sideBranches:['reactant','product'],arrowStyles:['straight','curved']}, editTool:'canvas_edit_scheme', editRoute:'/api/route/scheme/edit', exports:{cdxml:{profile:'chem-canvas-cdxml-v1',requiresSavedLayout:true,route:'/api/route/scheme/export?format=cdxml',downloadRoute:'/api/route/scheme.cdxml'}}, imports:{cdxml:{route:'/api/chemdraw/import',tool:'canvas_import_cdxml',maxBytes:524288,modes:['preview','commit'],additive:true}}, modes:['preview','commit'], conditions: ['text','above','below','yield'], sharedBondScale: true }, canvasOverview: { tool: 'canvas_inspect_canvas', route: '/api/canvas/inspect', readOnly: true, supportsViewIds: true, supportsRegion: true }, viewLayout: { operations: ['createView', 'moveView', 'updateView', 'deleteView'], relationAnchors: ['fromViewId', 'toViewId'], fallback: 'nearest-view-pair' }, candidateWorkflow: { modes: ['preview', 'propose', 'commit'], tools: ['canvas_edit_molecule', 'canvas_adjust_depiction'], identityPreserved: true, reviewInCanvas: true, previewWritesDocument: false, proposalChangesMolecule: false, acceptanceField: 'proposalAcceptances', moleculeCandidateBaseline: 'affected objects and incident relations' }, structureResources: { listTool: 'canvas_list_resources', importTool: 'canvas_put_molecule', directory: 'imports under document data directory', format: 'mol', requiresSha256: true }, smiles: true, molblock: true, freehandAtoms: typeof chemistry.editMolecule === 'function', atomSelection: true, layout2D: typeof chemistry.layoutMolecule === 'function', localDepiction: { available: typeof chemistry.adjustDepiction === 'function', inspectTool: 'canvas_inspect_molecule', adjustTool: 'canvas_adjust_depiction', preview: true, operations: ['moveAtom', 'rotateTerminalBond', 'relaxHydrogens', 'doubleChain'], coordinateSystem: 'MOL 2D Cartesian; not SVG pixels', targets: 'explicit stable atom/bond IDs; relax only degree-1 explicit H', preservesUntargetedCoordinates: true, chemicalChange: false } }, presentation: { modes: ['simple', 'full'], modeStorage: 'browser-local', modeChangesDocument: false, redraw: { route: '/api/depictions/{objectId}.svg', readOnly: true }, layout: { route: '/api/molecules/layout', tool: 'canvas_layout_molecule', persistsCoordinates: true, requiresObjectVersion: true } } });
      if (request.method === 'GET' && url.pathname === '/api/export') {
        response.setHeader('Content-Disposition', 'attachment; filename="research.chem-canvas.json"');
        return json(response, 200, { document: store.document });
      }
      if (request.method === 'POST') {
        if (url.pathname === '/api/chemdraw/import') {
          if (!['preview', 'commit'].includes(input.mode) || Object.keys(input).some(key => !['mode','cdxml','expectedRevision','operationId','actor'].includes(key))) throw failure('VALIDATION', 'CDXML 导入需要 preview 或 commit 模式及有效请求字段。');
          const { mode, ...request } = input;
          const document = store.document;
          const result = mode === 'preview' ? await previewCdxmlImport(document, request) : await commitCdxmlImport(store, request);
          return json(response, 200, { ...result, documentId: document.id, currentRevision: store.document.revision, state: mode === 'preview' ? 'preview' : 'committed' });
        }
        if(url.pathname==='/api/route/scheme/edit')return json(response,200,await editScheme(store,input));
        const feedbackMatch = url.pathname.match(/^\/api\/benchmarks\/runs\/([^/]+)\/feedback$/);
        if (feedbackMatch) return json(response, 200, await benchmarks.saveFeedback(decodeURIComponent(feedbackMatch[1]), input));
        if (url.pathname === '/api/canvas/inspect') return json(response, 200, await canvasOverview(store.document, input));
        if (url.pathname === '/api/selection') {
          project.selection = selectedInput(input, store.document);
          return json(response, 200, { selection: project.selection });
        }
        if (url.pathname === '/api/chemistry/edit-preview') {
          const object = editingBase(store.document, input);
          return json(response, 200, await chemistry.editMolecule(object?.data ?? null, input.edits, { idPrefix: 'preview' }));
        }
        if (url.pathname === '/api/molecules/layout') {
          return json(response, 200, await store.mutate(url.pathname, input, async doc => {
            if (typeof chemistry.layoutMolecule !== 'function') throw failure('CHEMISTRY_UNAVAILABLE', '二维整理能力尚未就绪。');
            const object = doc.objects[input.objectId];
            if (object?.kind !== 'molecule') throw failure('NOT_FOUND', '要整理的分子不存在。');
            if (input.expectedObjectVersion !== object.version) throw failure('CONFLICT', '分子已被修改，请重新读取后整理。');
            const { molecule } = await chemistry.layoutMolecule(object.data);
            const delta = moleculeDifference(object.data, molecule);
            if (molecule.smiles !== object.data.smiles || delta.addedAtoms.length || delta.removedAtoms.length || delta.changedAtoms.length || delta.addedBonds.length || delta.removedBonds.length || delta.changedBonds.length) {
              throw failure('VALIDATION', '二维整理改变了化学结构或身份，已拒绝保存。');
            }
            molecule.lastEdit = { ...delta, operationId: input.operationId, actor: input.actor, baseObjectVersion: object.version, resultObjectVersion: object.version + 1 };
            return applyOperation(doc, { operationId: input.operationId, expectedRevision: input.expectedRevision, actor: input.actor,
              intent: '整理分子二维坐标（保持结构与身份）', changes: [{ type: 'updateObject', id: object.id, patch: { data: molecule } }] });
          }));
        }
        if (url.pathname === '/api/molecules/depiction') {
          const mode = workflowMode(input);
          if (mode === 'preview') {
            const document = store.document;
            const { object, molecule, delta } = await adjustDepiction(document, input);
            return json(response, 200, { preview: true, documentId: document.id, revision: document.revision, objectId: object.id, objectVersion: object.version, molecule, delta });
          }
          const result = await store.mutate(url.pathname, input, async document => {
            const { object, molecule, delta } = await adjustDepiction(document, input);
            return saveCandidate(document, input, { object, molecule, delta,
              intent: input.operations[0].type === 'doubleChain' ? '大环双链展开' : '局部调整分子显示（保留化学与非目标坐标）', changes: [{ type: 'updateObject', id: object.id, patch: { data: molecule } }] }, mode);
          });
          return json(response, 200, { ...result, ...(mode === 'propose' ? { proposalId: moleculeProposalId(input.operationId) } : {}) });
        }
        if (url.pathname === '/api/molecules/edit') {
          const mode = workflowMode(input);
          if (mode === 'preview') {
            const document = store.document;
            if (input.expectedRevision !== document.revision) throw failure('CONFLICT', '文档已变化，请重新读取后预览。');
            const object = editingBase(document, input);
            const { molecule, delta } = await chemistry.editMolecule(object?.data ?? null, input.edits, { idPrefix: chemistryPrefix(input.operationId) });
            return json(response, 200, { preview: true, documentId: document.id, revision: document.revision, objectId: object?.id ?? chemistryPrefix(input.operationId), objectVersion: object?.version ?? 0, molecule, delta });
          }
          const result = await store.mutate(url.pathname, input, async doc => {
            const object = editingBase(doc, input);
            const { molecule, delta } = await chemistry.editMolecule(object?.data ?? null, input.edits, { idPrefix: chemistryPrefix(input.operationId) });
            const objectId = object?.id || chemistryPrefix(input.operationId);
            molecule.lastEdit = { ...delta, operationId: input.operationId, actor: input.actor, baseObjectVersion: object?.version ?? 0, resultObjectVersion: (object?.version ?? 0) + 1 };
            const changes = object
              ? [{ type: 'updateObject', id: objectId, patch: { ...(typeof input.title === 'string' ? { title: input.title } : {}), data: molecule } }]
              : [
                { type: 'createObject', object: { id: objectId, kind: 'molecule', title: input.title || '绘制的分子', data: molecule } },
                { type: 'createView', view: { id: `view-${objectId}`, objectId, x: input.x ?? 100, y: input.y ?? 100, width: 300, height: 210 } }
              ];
            return saveCandidate(doc, input, { object, molecule, delta, changes, intent: `${object ? '编辑' : '绘制'}分子：${delta.summary || '原子与键变化'}` }, mode);
          });
          return json(response, 200, { ...result, ...(mode === 'propose' ? { proposalId: moleculeProposalId(input.operationId) } : {}) });
        }
        if (url.pathname === '/api/chemistry/parse') return json(response, 200, { molecule: await parseInput(input, chemistryPrefix('preview', input.smiles || input.molblock)) });
        if (url.pathname === '/api/operations') return json(response, 200, await store.mutate(url.pathname, input, async doc => applyOperation(doc, { ...input, changes: await normalizeChanges(doc, input.changes, input.operationId) })));
        if (url.pathname === '/api/undo') return json(response, 200, await store.mutate(url.pathname, input, doc => undoOperation(doc, input)));
        if (url.pathname === '/api/proposals') return json(response, 200, await store.mutate(url.pathname, input, async doc => createProposal(doc, { ...input, changes: await normalizeChanges(doc, input.changes, input.operationId) })));
        const proposalMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/resolve$/);
        if (proposalMatch) return json(response, 200, await store.mutate(url.pathname, input, doc => resolveProposal(doc, { ...input, proposalId: decodeURIComponent(proposalMatch[1]) })));
        if (url.pathname === '/api/molecules') {
          const result = await store.mutate(url.pathname, input, async doc => {
            const objectId = input.objectId || chemistryPrefix(input.operationId);
            if (input.objectId && doc.objects[input.objectId]?.kind !== 'molecule') throw failure('NOT_FOUND', '要修改的分子不存在。');
            let molecule;
            if (input.resourceId !== undefined) {
              if (input.smiles !== undefined || input.molblock !== undefined) throw failure('VALIDATION', '资源引用不能同时提供 SMILES/MOL。');
              if (typeof input.resourceSha256 !== 'string') throw failure('VALIDATION', '请先列出资源并提供 resourceSha256。');
              const resource = await resources.read(input.resourceId, { expectedSha256: input.resourceSha256 });
              molecule = await parseInput(resource, chemistryPrefix(input.operationId, objectId));
              molecule.sourceResource = resource.source;
            } else {
              if (input.resourceSha256 !== undefined) throw failure('VALIDATION', 'resourceSha256 需要 resourceId。');
              molecule = await parseInput(input, chemistryPrefix(input.operationId, objectId));
            }
            const changes = input.objectId
              ? [{ type: 'updateObject', id: objectId, patch: { ...(typeof input.title === 'string' ? { title: input.title } : {}), data: molecule } }]
              : [
                { type: 'createObject', object: { id: objectId, kind: 'molecule', title: input.title || '新分子', data: molecule } },
                { type: 'createView', view: { id: `view-${objectId}`, objectId, x: input.x ?? 100, y: input.y ?? 100, width: 300, height: 210 } }
              ];
            return applyOperation(doc, { operationId: input.operationId, expectedRevision: input.expectedRevision, actor: input.actor, intent: input.objectId ? '更新分子结构' : '加入分子', changes });
          });
          return json(response, 200, result);
        }
        throw failure('NOT_FOUND', '接口不存在。');
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw failure('NOT_FOUND', '接口不存在。');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw failure('VALIDATION', '路径无效。'); }
      if (pathname === '/') pathname = '/index.html';
      const hostSelectionModule = pathname === '/host-selection-annotation.js';
      const file = hostSelectionModule
        ? path.join(root, 'integrations', 'codex', 'embedded', 'selection-annotation.js')
        : path.resolve(publicDirectory, `.${pathname}`);
      if (!hostSelectionModule && !file.startsWith(publicDirectory + path.sep)) throw failure('FORBIDDEN', '路径不允许。');
      const extension = path.extname(file);
      const benchmarkAttachment = file.startsWith(path.join(publicDirectory, 'publication-benchmark-data') + path.sep)
        ? { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.txt': 'text/plain; charset=utf-8' }[extension] : undefined;
      const contentType = mime[extension] ?? benchmarkAttachment ?? (extension === '.png' ? 'image/png' : undefined);
      if (!contentType) throw failure('NOT_FOUND', '文件不存在。');
      const content = await readFile(file).catch(error => { if (error.code === 'ENOENT') throw failure('NOT_FOUND', '界面文件尚未就绪。'); throw error; });
      response.writeHead(200, {
        'Content-Type': contentType, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const status = ({ CONFLICT: 409, PROJECT_REQUIRED: 409, NOT_FOUND: 404, FORBIDDEN: 403, MEDIA_TYPE: 415, TOO_LARGE: 413, VALIDATION: 400, EMPTY_PUBLICATION_VIEW: 422, UNSUPPORTED_CHEMISTRY: 422, UNSUPPORTED_CDXML: 422 })[error.code] || 500;
      if (!response.headersSent) json(response, status, { error: { code: error.code || 'INTERNAL', message: status === 500 && error.code !== 'STORAGE' ? '操作失败，请检查本地服务日志。' : error.message,
        ...(error.reason ? { reason: error.reason } : {}), ...(error.conflict ? { conflict: error.conflict } : {}) } });
      else response.end();
      if (status === 500) console.error(error);
    }
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { await workspaces.close(); throw error; }
  const actualPort = server.address().port;
  return {
    url: `http://127.0.0.1:${actualPort}`, store, workspaces,
    async close() { await new Promise(resolve => server.close(resolve)); await workspaces.close(); }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = await startServer();
  console.log(`Chem Canvas: ${app.url}`);
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
