import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { applyOperation } from '../src/core/index.js';
import { failure } from './store.js';
import { figureFormat } from './figure-document.js';
import { renderPublication } from './publication-render.js';
import { publicationSchema, outsideYieldRange } from './publication-schema.js';
import { withMarkedYields } from '../public/publication-yield.js';

const checkSchema = new Ajv({ ownProperties: true, allErrors:true, verbose:true }).compile(publicationSchema);
const formats = { scope: ['svg', 'pdf', 'tiff'], optimization: ['docx', 'svg', 'pdf', 'tiff'] };
function validate(document, spec) {
  if (!checkSchema(spec)) {
    // One malformed row is often repeated across a full scope. Report each
    // distinct repair once, with the first affected row and legal field names.
    const messages=new Map();
    for (const issue of checkSchema.errors) {
      if (issue.keyword==='anyOf' || issue.keyword==='oneOf') continue;
      const key=[issue.schemaPath,issue.instancePath.replace(/\/\d+(?=\/|$)/g,'/[]'),JSON.stringify(issue.params)].join('|');
      if (messages.has(key)) continue;
      const unknown=issue.params.additionalProperty;
      const valid=unknown && Object.keys(issue.parentSchema?.properties || {});
      const values=issue.params.allowedValues;
      const help=valid?.length ? '可用字段 '+valid.join(', ') : values ? '可选值 '+values.join(', ') : '';
      messages.set(key,[issue.instancePath || '/',issue.message,unknown,help].filter(Boolean).join(' '));
      if (messages.size>=10) break;
    }
    throw failure('VALIDATION','图表字段 '+[...messages.values()].join('\n'));
  }
  const seen = new Set();
  const catalysts = spec.reaction?.catalystIds ?? [];
  const references = new Set([...(spec.reaction?.reactantIds ?? []), ...(spec.reaction?.productIds ?? []), ...catalysts]);
  for (const id of Object.keys(spec.reaction?.catalystRepeats ?? {})) {
    if (!catalysts.includes(id)) throw failure('VALIDATION', '催化剂重复数必须对应反应头中的催化剂。');
  }
  for (const row of spec.experiments) {
    if (seen.has(row.id)) throw failure('VALIDATION', `实验编号重复：${row.id}`);
    seen.add(row.id);
    if (row.include?.includes('scope') && !row.compoundId && !spec.scopeStyle?.reactionOnly) throw failure('VALIDATION', `底物范围条目 ${row.id} 缺少关联分子。`);
    if (row.compoundId) references.add(row.compoundId);
    // Numeric text is common in CSV files. Qualifiers such as "trace" and "<5" retain their source notation.
    if ([row.yield, ...(row.additionalYields || [])].some(result => outsideYieldRange(result?.value))) {
      throw failure('VALIDATION', '实验 ' + row.id + ' 的百分收率超出 0–100。');
    }
    for (const key of Object.keys(row.conditions ?? {})) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw failure('VALIDATION', '条件列名无效。');
    }
  }
  const definedGroups = new Set();
  for (const {group} of spec.scaffoldGroups || []) {
    const populated = spec.experiments.some(row=>row.group===group && row.compoundId && (!row.include || row.include.includes('scope')));
    if (definedGroups.has(group) || !populated) throw failure('VALIDATION','Scaffold group must refer to a unique populated scope group: '+group);
    definedGroups.add(group);
  }
  const versions = {};
  for (const ref of references) {
    if (!Object.hasOwn(document.objects, ref) || document.objects[ref].kind !== 'molecule') throw failure('VALIDATION', `本项目未找到分子：${ref}`);
    versions[ref] = document.objects[ref].version;
  }
  return versions;
}

function includesView(spec, view) {
  return spec.experiments.some(row => row.include ? row.include.includes(view) : view === 'optimization' || Boolean(row.compoundId) || Boolean(spec.scopeStyle?.reactionOnly));
}
function forView(spec, view, columns) {
  if (!Object.hasOwn(formats, view) || ![1, 2].includes(columns)) throw failure('VALIDATION', '请选择已支持的图表类型和单栏或双栏。');
  if (!includesView(spec, view)) throw failure('EMPTY_PUBLICATION_VIEW', view === 'scope' ? '底物范围图缺少已关联分子的实验。' : '优化表缺少已选入的实验。');
  return { ...spec, title: spec.titles?.[view] ?? spec.title, caption: spec.captions?.[view] ?? spec.caption, kind: view, columns };
}
const savedObject = document => Object.values(document.objects).find(item => item.kind === 'publication' && item.data.format!==figureFormat);
function summary(document) {
  const saved = savedObject(document);
  if (!saved) return null;
  const { spec, moleculeVersions } = saved.data;
  const staleMoleculeIds = Object.keys(moleculeVersions).filter(id => document.objects[id]?.version !== moleculeVersions[id]);
  return { id: saved.id, version: saved.version, spec, moleculeVersions, staleMoleculeIds };
}
export function publicationState(document) {
  const objects = Object.values(document.objects).filter(obj => obj.kind === 'molecule').map(({ id, title, kind, version }) => ({ id, title, kind, version }));
  return { documentId: document.id, revision: document.revision, objects, publication: summary(document) };
}
export function publicationLinks(document, projectId) {
  const state = summary(document);
  if (!state || state.staleMoleculeIds.length) return {};
  const links = {};
  for (const [view, extensions] of Object.entries(formats)) {
    if (!includesView(state.spec, view)) continue;
    links[view] = Object.fromEntries(extensions.map(format => [format, '/api/publication/export?' + new URLSearchParams({ project: projectId, revision: document.revision, kind: view, format })]));
    if (state.spec.reaction) links[view].reactionSvg = links[view].svg + '&part=reaction';
  }
  return links;
}
export async function previewPublication(document, spec) {
  validate(document, spec);
  return { documentId: document.id, revision: document.revision, ...await renderPublication(document, forView(withMarkedYields(spec), spec.kind, spec.columns)) };
}
export async function savePublication(store, input) {
  const { document, replayed } = await store.mutate('publication/save', input, async doc => {
    const moleculeVersions = validate(doc, input.spec);
    const spec = withMarkedYields(input.spec);
    const other = spec.kind === 'scope' ? 'optimization' : 'scope';
    await renderPublication(doc, forView(spec, spec.kind, spec.columns));
    if (includesView(spec, other)) await renderPublication(doc, forView(spec, other, spec.columns));
    const current = savedObject(doc);
    const data = { spec, moleculeVersions };
    const change = current ? { type: 'updateObject', id: current.id, patch: { title: spec.title, data } } : {
      type: 'createObject', object: { kind: 'publication', id: 'publication-' + createHash('sha256').update(input.operationId).digest('hex').slice(0, 24), title: spec.title, data },
    };
    return applyOperation(doc, { operationId: input.operationId, expectedRevision: input.expectedRevision, actor: input.actor ?? 'human', intent: '保存期刊图表', changes: [change] });
  });
  return { documentId: document.id, revision: document.revision, publication: summary(document), replayed: Boolean(replayed) };
}
export async function exportPublication(document, query) {
  if (query.get('revision') !== String(document.revision)) throw failure('CONFLICT', '请重新读取并确认当前版本后导出。');
  const state = summary(document);
  if (!state) throw failure('NOT_FOUND', '请先保存图表。');
  if (state.staleMoleculeIds.length) throw failure('CONFLICT', '所引用结构已变化，请重新预览并保存图表。');
  const view = query.get('kind') ?? state.spec.kind;
  const format = query.get('format');
  if (!Object.hasOwn(formats, view) || !formats[view].includes(format)) throw failure('VALIDATION', '该图表不支持所选格式。');
  const part = query.get('part');
  if (part !== null && (part !== 'reaction' || format !== 'svg' || !state.spec.reaction)) {
    throw failure('VALIDATION', '请为含反应图的稿件选择单独导出反应图 SVG。');
  }
  const spec = forView(state.spec, view, Number(query.get('columns') ?? state.spec.columns));
  const rendering = await renderPublication(document, spec);
  if (part === 'reaction') {
    return {body:Buffer.from(rendering.reactionSvg),contentType:'image/svg+xml',
      filename:`reaction-${spec.journal}-${spec.columns}col-r${document.revision}.svg`};
  }
  const { publicationFile } = await import('./publication-files.js');
  const file = await publicationFile(format, rendering, spec);
  return { ...file, filename: `${view}-${spec.journal}-${spec.columns}col-r${document.revision}.${file.extension}` };
}
