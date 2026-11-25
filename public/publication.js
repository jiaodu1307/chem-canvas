import { projectId, scopedFetch, workspacePageUrl } from './workspace-context.js';
import { withMarkedYields } from './publication-yield.js';

const byId = id => document.getElementById(id);
const kinds = { scope: '底物范围图', optimization: '条件优化表' };
const initialSpec = () => ({
  title: 'Substrate scope', titles: { optimization: 'Optimization of reaction conditions' },
  journal: 'orglett', columns: 2, kind: 'scope', conditionColumns: [], experiments: [],
});
let spec = initialSpec(), view = 'scope', revision, savedVersion, operationId;
let documentId = '', molecules = [], staleIds = [], ready = false, dirty = false, busy = false;
let previewSequence = 0, previewTimer, imageUrl, verifiedRevision;
let templateError = '';
const additionalYieldDrafts = new WeakMap();

function notice(text, error = false) {
  byId('notice').textContent = text;
  byId('notice').classList.toggle('error', error);
}
function option(value, title) { return new Option(title, value); }
function warnText(value) {
  return typeof value === 'string' ? value : (value?.message || value?.code || JSON.stringify(value));
}
async function failure(response) {
  let message = response.statusText;
  try {
    const body = await response.json();
    message = body.error?.message || body.message || (typeof body.error === 'string' && body.error) || message;
  } catch {}
  return Object.assign(new Error(message || ('请求失败 ' + response.status)), { status: response.status });
}
async function json(path, body) {
  const response = await scopedFetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response);
  return response.json();
}
function draftSpec() {
  const invalid = document.querySelector('#rows input:invalid, #reaction-labels input:invalid');
  if (templateError || invalid) throw new Error(templateError || invalid.validationMessage);
  const selected = { ...spec, kind: view };
  if (spec.titles?.[view]) {
    const other = view === 'scope' ? 'optimization' : 'scope';
    selected.titles = { [other]: spec.title, ...spec.titles };
    selected.title = spec.titles[view];
  }
  return selected;
}

function controls() {
  const locked = !ready || busy;
  byId('settings-inputs').disabled = locked;
  for (const id of ['view-scope', 'view-optimization', 'add-row', 'add-column', 'new-column', 'import', 'import-mol', 'draft-file', 'preview']) byId(id).disabled = locked;
  byId('reload').disabled = busy;
  for (const input of byId('rows').querySelectorAll('input,select,button')) input.disabled = locked || input.dataset.limit === 'true';
  const needsReview = staleIds.length > 0 && verifiedRevision !== revision;
  const invalid = Boolean(templateError || document.querySelector('#rows input:invalid, #reaction-labels input:invalid'));
  byId('save').disabled = locked || invalid || (!dirty && savedVersion && !staleIds.length) || needsReview;
  byId('draft-file').disabled = locked || invalid;
  byId('download').disabled = locked || !savedVersion || dirty || Boolean(staleIds.length);
  byId('format').disabled = locked;
  const word = byId('format').querySelector('[value="docx"]');
  word.disabled = view !== 'optimization';
  if (word.disabled && byId('format').value === 'docx') byId('format').value = 'pdf';
  const reactionOption = byId('format').querySelector('[value="reaction-svg"]');
  reactionOption.disabled = !spec?.reaction;
  if (reactionOption.disabled && byId('format').value === 'reaction-svg') byId('format').value = 'pdf';
  byId('download-note').textContent = staleIds.length ? '引用的分子已更改。请预览并重新保存，再下载当前版本。'
    : dirty || !savedVersion ? '保存当前草稿后即可下载。' : '下载使用已保存的数据和结构。';
  if (ready) byId('context').textContent = '项目 ' + projectId + '  ·  文档 r' + revision +
    (savedVersion ? '  ·  图表 v' + savedVersion : '') + (dirty ? '  ·  有未保存的修改' : '');
}
function clearProof(message) {
  if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = undefined; }
  byId('proof-image').hidden = true;
  byId('proof-image').removeAttribute('src');
  byId('proof-table').replaceChildren();
  byId('proof-table').hidden = true;
  byId('empty-proof').hidden = false;
  byId('empty-proof').textContent = message;
  byId('dimensions').textContent = '';
  byId('warnings').hidden = true;
}
function schedulePreview() {
  clearTimeout(previewTimer);
  ++previewSequence;
  verifiedRevision = undefined;
  clearProof(spec.experiments.length ? '准备预览…' : '添加实验或导入数据后，可以预览成稿。');
  if (ready && spec.experiments.length) previewTimer = setTimeout(renderPreview, 500);
}
function changed() {
  dirty = true;
  operationId = undefined;
  notice('');
  schedulePreview();
  controls();
}
function safeTable(html) {
  const source = new DOMParser().parseFromString(html, 'text/html').querySelector('table');
  if (!source) throw new Error('服务端未返回可显示的表格。');
  const allowed = new Set('TABLE CAPTION THEAD TBODY TFOOT TR TH TD SUP SUB B I EM STRONG SPAN BR'.split(' '));
  function copy(node) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
    if (!allowed.has(node.nodeName)) return document.createTextNode(node.textContent);
    const clean = document.createElement(node.localName);
    for (const child of node.childNodes) clean.append(copy(child));
    return clean;
  }
  return copy(source);
}
async function renderPreview() {
  clearTimeout(previewTimer);
  if (!ready) return;
  const sequence = ++previewSequence;
  try {
    const preview = await json('/api/publication/preview', { spec: draftSpec() });
    if (sequence !== previewSequence) return;
    if (preview.revision !== revision) throw new Error('项目已更新。请重新读取当前项目，再核对图表。');
    clearProof('');
    if (preview.svg) {
      imageUrl = URL.createObjectURL(new Blob([preview.svg], { type: 'image/svg+xml' }));
      const img = byId('proof-image');
      img.alt = kinds[view] + '预览';
      img.src = imageUrl;
      img.hidden = false;
    } else {
      byId('proof-table').replaceChildren(safeTable(preview.tableHtml || ''));
      byId('proof-table').hidden = false;
    }
    byId('empty-proof').hidden = true;
    if (Number.isFinite(preview.widthMm) && Number.isFinite(preview.heightMm)) {
      byId('dimensions').textContent = preview.widthMm.toFixed(1) + ' × ' + preview.heightMm.toFixed(1) + ' mm';
    }
    const warnings = preview.warnings || [];
    byId('warnings').replaceChildren(...warnings.map(item => {
      const li = document.createElement('li'); li.textContent = warnText(item); return li;
    }));
    byId('warnings').hidden = warnings.length === 0;
    verifiedRevision = revision;
  } catch (e) {
    if (sequence !== previewSequence) return;
    clearProof(e.message);
    verifiedRevision = undefined;
  } finally {
    if (sequence === previewSequence) controls();
  }
}

function moleculeOptions(select, values) {
  const chosen = new Set(values);
  const titles = new Set(), duplicates = new Set();
  for (const mol of molecules) { if (titles.has(mol.title)) duplicates.add(mol.title); titles.add(mol.title); }
  const options = molecules.map(mol => option(mol.id, duplicates.has(mol.title) ? mol.title + ' · ' + mol.id : mol.title || mol.id));
  const known = new Set(molecules.map(mol => mol.id));
  for (const value of chosen) if (value && !known.has(value)) options.push(option(value, '未找到 · ' + value));
  for (const opt of options) {
    opt.selected = chosen.has(opt.value);
    opt.title = opt.value;
  }
  if (!select.multiple) options.unshift(option('', '选择结构'));
  select.replaceChildren(...options);
  if (!select.multiple) select.value = values[0] || '';
}
function displayTitles() {
  byId('title').value = spec.titles?.[view] ?? spec.title ?? '';
  byId('caption').value = spec.captions?.[view] ?? spec.caption ?? '';
}
function renderSettings() {
  displayTitles();
  byId('journal').value = spec.journal;
  byId('abbreviations').value = spec.abbreviations ?? 'expanded';
  byId('columns').value = String(spec.columns);
  byId('align-scaffolds').checked = spec.alignScaffolds !== false;
  byId('scope-columns').value = spec.scopeColumns ?? '';
  moleculeOptions(byId('reactants'), spec.reaction?.reactantIds || []);
  moleculeOptions(byId('products'), spec.reaction?.productIds || []);
  moleculeOptions(byId('catalysts'), spec.reaction?.catalystIds || []);
  renderIdentities();
  byId('reaction-conditions').value = spec.reaction?.conditions || '';
  for (const [id,key] of conditionFields) byId(id).value = conditionText(spec.reaction?.[key] ?? []);
  if (!templateError) {
    const settings={};
    for (const key of [...scopeArrayKeys,'scopeYieldMethodInCaption','scopeStyle','abbreviationOverrides']) if (Object.hasOwn(spec,key)) settings[key]=spec[key];
    for (const key of templateKeys) if (spec.reaction?.[key]) settings[key]=spec.reaction[key];
    byId('template-settings').value=Object.keys(settings).length ? JSON.stringify(settings,null,2) : '';
  }
  byId('template-error').textContent = templateError;
  for (const kind of Object.keys(kinds)) byId('view-' + kind).setAttribute('aria-pressed', String(view === kind));
}
function textField(value, label, update, style = '') {
  const input = document.createElement('input');
  input.value = value ?? '';
  input.className = style;
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => { update(input.value); changed(); });
  return input;
}
function put(target, key, value) {
  if (value === '') delete target[key]; else target[key] = value;
}
function conditionNames() {
  return spec.conditionColumns ?? [...new Set(spec.experiments.flatMap(row => Object.keys(row.conditions || {})))];
}
function renderRows() {
  const columns = conditionNames();
  const head = document.createElement('tr');
  for (const title of ['顺序','实验 ID','关联结构','结构角色','结构编号','分组',...columns,'收率','测定方法','附加收率（JSON）','选择性','规模','脚注','来源','用于','操作']) {
    const th = document.createElement('th'); th.scope = 'col'; th.textContent = title; head.append(th);
  }
  byId('head').replaceChildren(head);
  const rows = spec.experiments.map((row, index) => {
    const tr = document.createElement('tr');
    const cell = (...children) => { const td = tr.insertCell(); td.append(...children); return td; };
    const field = (key, label, style) => textField(row[key], label, value => put(row, key, value), style);
    cell(String(index + 1)); cell(field('id', '实验 ID'));
    const select = document.createElement('select'); select.className = 'compound'; select.setAttribute('aria-label', '关联结构');
    moleculeOptions(select, [row.compoundId]);
    select.onchange = () => { put(row, 'compoundId', select.value); changed(); };
    cell(select);
    const role=document.createElement('select'); role.setAttribute('aria-label','结构角色');
    role.append(option('','默认'),option('product','产物'),option('substrate','底物'));
    role.value=row.structureRole ?? '';
    role.onchange=()=>{put(row,'structureRole',role.value);changed();};
    cell(role);cell(field('label', '结构编号', 'compact')); cell(field('group', '分组'));
    for (const key of columns) cell(textField(row.conditions?.[key], key, value => {
      row.conditions ??= Object.create(null); put(row.conditions, key, value);
    }));
    const setYield = (key, value) => {
      row.yield ??= {};
      put(row.yield,key,value);
      if (!Object.keys(row.yield).length) delete row.yield;
    };
    const marker=textField(row.yield?.footnoteMarker,'收率脚注标记',value=>setYield('footnoteMarker',value),'yield-marker');
    marker.placeholder='ᵃ'; marker.title='原文上标脚注字母';
    cell(textField(row.yield?.value, '收率', value => setYield('value', value), 'compact'),marker);
    const method = textField(row.yield?.method, '测定方法', value => setYield('method', value));
    method.setAttribute('list', 'methods'); cell(method);
    const draft=additionalYieldDrafts.get(row);
    const more=textField(draft?.value ?? (row.additionalYields ? JSON.stringify(row.additionalYields) : ''), '附加收率 JSON', value=>{
      try {
        const entries=value.trim() ? JSON.parse(value) : [];
        if (!Array.isArray(entries) || entries.some(e=>!e || Array.isArray(e) || typeof e!=='object' || !Object.hasOwn(e,'value') || !e.context?.trim())) throw Error('每条附加收率需要 value 和 context。');
        if (entries.length) row.additionalYields=entries; else delete row.additionalYields;
        additionalYieldDrafts.delete(row);
        more.setCustomValidity('');
      } catch (error) {
        const message='附加收率 JSON 无效。'+error.message;
        additionalYieldDrafts.set(row,{value,message});
        more.setCustomValidity(message);
      }
    },'notes');
    if (draft) more.setCustomValidity(draft.message);
    more.placeholder='[{"value":40,"context":"4.3 mmol, 72 h"}]';cell(more);
    for (const [key, label] of [['selectivity','选择性'],['scale','规模'],['note','脚注'],['source','来源']]) cell(field(key, label, key === 'note' || key === 'source' ? 'notes' : ''));
    const include = document.createElement('select'); include.setAttribute('aria-label', '图表用途');
    include.append(option('', '自动'), option('scope', '仅底物范围图'), option('optimization', '仅优化表'), option('both', '两者'));
    include.value = row.include?.length === 2 ? 'both' : row.include?.[0] || '';
    include.onchange = () => { if (include.value) row.include = include.value === 'both' ? ['scope','optimization'] : [include.value]; else delete row.include; changed(); };
    cell(include);
    const actions = document.createElement('div'); actions.className = 'row-tools';
    for (const [label, dir] of [['上移',-1],['下移',1],['移除',0]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.setAttribute('aria-label', label + '实验 ' + (row.id || index + 1));
      button.dataset.limit = String(dir !== 0 && (index + dir < 0 || index + dir >= spec.experiments.length));
      button.onclick = () => {
        if (dir === 0 && !confirm('从草稿移除实验 ' + (row.id || index + 1) + '？')) return;
        spec.experiments.splice(index, 1);
        if (dir) spec.experiments.splice(index + dir, 0, row);
        renderRows(); changed();
      };
      actions.append(button);
    }
    cell(actions); return tr;
  });
  byId('rows').replaceChildren(...rows);
  byId('count').textContent = String(rows.length);
  byId('empty-data').hidden = rows.length > 0;
}
function showData(data) {
  templateError='';
  documentId = data.documentId;
  revision = data.revision;
  savedVersion = data.publication?.version;
  staleIds = data.publication?.staleMoleculeIds || [];
  molecules = data.objects.filter(obj => obj.kind === 'molecule');
  spec = data.publication ? structuredClone(data.publication.spec) : initialSpec();
  view = spec.kind;
  dirty = false; ready = true; operationId = undefined;
  renderSettings(); renderRows(); schedulePreview(); controls();
  notice(staleIds.length ? '已保存图表引用的结构有更新。请检查新预览后保存。' : '');
}
async function lock(action) {
  if (busy) return;
  busy = true; controls();
  try { await action(); } catch (e) { notice(e.message, true); }
  finally { busy = false; controls(); }
}
async function reload() {
  if (dirty && !confirm('放弃未保存的图表修改，重新读取这个项目？')) return;
  const data = await json('/api/publication');
  if (documentId && data.documentId !== documentId) throw new Error('项目文档已被替换。请重新打开研究画布确认项目。');
  showData(data);
}
function nextId() {
  const used = new Set(spec.experiments.map(row => row.id));
  let n = spec.experiments.length + 1;
  while (used.has('exp-' + n)) ++n;
  return 'exp-' + n;
}

function csvRows(text) {
  const result = [], row = [];
  let field = '', quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (c === ',') {
      row.push(field); field = ''; closed = false;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(value => value.trim())) result.push(row.splice(0));
      else row.length = 0;
      field = ''; closed = false;
    } else if (c === '"' && !field && !closed) {
      quoted = true;
    } else if (closed || c === '"') {
      throw new Error('CSV 第 ' + (result.length + 1) + ' 行引号格式有误。');
    } else field += c;
  }
  if (quoted) throw new Error('CSV 结尾有未闭合的引号。');
  row.push(field);
  if (row.some(value => value.trim())) result.push(row);
  return result;
}

function resolveMolecule(value) {
  if (typeof value !== 'string' || !value) return value;
  if (molecules.some(mol => mol.id === value)) return value;
  const matches = molecules.filter(mol => mol.title === value);
  return matches.length === 1 ? matches[0].id : value;
}
function resolveMoleculeMap(values,field) {
  if (!values || typeof values!=='object' || Array.isArray(values)) throw Error(field+' 须为结构 ID 或唯一结构名称的键值对。');
  const mapped=Object.create(null);
  for (const [name,value] of Object.entries(values)) {
    const id=resolveMolecule(name);
    if (Object.hasOwn(mapped,id)) throw Error('结构名称或 ID 重复：'+name);
    mapped[id]=value;
  }
  return mapped;
}
function importedSpec(input) {
  const body = input?.spec ?? input;
  const experiments = Array.isArray(body) ? body : body?.experiments;
  if (!Array.isArray(experiments)) throw new Error('文件须含 experiments 实验数组。');
  const full = !Array.isArray(body) && ['journal', 'kind', 'columns', 'title'].some(key => Object.hasOwn(body, key));
  const draft = full ? { title: '', journal: 'orglett', columns: 2, kind: 'scope', ...body } : { ...spec };
  if (!['orglett','obc'].includes(draft.journal) || ![1,2].includes(draft.columns) || !Object.hasOwn(kinds, draft.kind)) {
    throw new Error('图表设置不合法，请检查 kind、journal 和 columns。');
  }
  for (const field of ['titles','captions']) {
    if (draft[field] != null && (typeof draft[field] !== 'object' || Array.isArray(draft[field]) || Object.values(draft[field]).some(v => typeof v !== 'string'))) {
      throw new Error(field + ' 必须按图表类型提供文字。');
    }
  }
  if (draft.abbreviationOverrides!=null) draft.abbreviationOverrides=resolveMoleculeMap(draft.abbreviationOverrides,'abbreviationOverrides');
  if (draft.reaction != null) {
    const reaction = { ...draft.reaction };
    for (const key of ['reactantIds','productIds','catalystIds']) {
      if (key==='catalystIds' && reaction[key]==null) continue;
      if (reaction[key] != null && (!Array.isArray(reaction[key]) || reaction[key].some(id => typeof id !== 'string'))) throw new Error('反应物和产物必须使用结构 ID 数组。');
      reaction[key] = (reaction[key] || []).map(resolveMolecule);
    }
    for (const key of ['labels','catalystRepeats']) {
      if (reaction[key]==null) continue;
      reaction[key]=resolveMoleculeMap(reaction[key],key);
    }
    draft.reaction = reaction;
  }
  draft.experiments = experiments.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('第 ' + (i + 1) + ' 条实验不是记录对象。');
    if (r.conditions != null && (!r.conditions || typeof r.conditions !== 'object' || Array.isArray(r.conditions))) throw new Error('实验条件须为列名与数值的键值对。');
    if (r.include != null && (!Array.isArray(r.include) || !r.include.length || r.include.some(k => !Object.hasOwn(kinds, k)))) throw new Error('实验用途须为 scope 或 optimization 数组。');
    return r.compoundId ? { ...r, compoundId: resolveMolecule(r.compoundId) } : { ...r };
  });
  draft.conditionColumns = body.conditionColumns ?? [...new Set(experiments.flatMap(r => Object.keys(r.conditions || {})))];
  if (!Array.isArray(draft.conditionColumns) || draft.conditionColumns.some(key => typeof key !== 'string' || !key.trim())) throw new Error('conditionColumns 须为条件列名数组。');
  return draft;
}

async function workbookRequest(file, query) {
  const response = await scopedFetch('/api/publication/import?' + query, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  });
  if (!response.ok) throw await failure(response);
  return response.json();
}
async function chooseWorksheet(file) {
  const { worksheets, worksheet } = await workbookRequest(file, 'listOnly=1');
  if (!Array.isArray(worksheets) || !worksheets.length) throw new Error('未找到可导入的工作表。');
  if (worksheets.length === 1) return worksheets[0];
  const select = byId('sheet-choice'), dialog = byId('sheet-dialog');
  select.replaceChildren(...worksheets.map(name => option(name, name)));
  select.value = worksheets.includes(worksheet) ? worksheet : worksheets[0];
  byId('sheet-filename').textContent = file.name;
  dialog.returnValue = 'cancel';
  const result = new Promise(resolve => dialog.addEventListener('close', () => {
    resolve(dialog.returnValue === 'import' ? select.value : null);
  }, { once: true }));
  dialog.showModal(); select.focus();
  return result;
}
async function importFile(file) {
  if (!file) return;
  const ext = file.name.split('.').at(-1).toLowerCase();
  let result;
  if (ext === 'xlsx') {
    const sheet = await chooseWorksheet(file);
    if (sheet === null) return;
    result = await workbookRequest(file, new URLSearchParams({ sheetName: sheet }));
  } else if (ext === 'csv') {
    result = await json('/api/publication/import', { rows: csvRows(await file.text()) });
  } else if (ext === 'json') {
    try { result = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); }
    catch { throw new Error('无法解析 JSON 文件。'); }
  } else throw new Error('请选择 CSV、XLSX 或 JSON 文件。');
  const draft = importedSpec(result);
  if (spec.experiments.length && !confirm('使用 ' + file.name + ' 替换草稿中的 ' + spec.experiments.length + ' 条实验？')) return;
  spec = draft;
  templateError='';
  view = draft.kind;
  renderSettings(); renderRows(); changed();
  notice('已导入 ' + spec.experiments.length + ' 条实验。请确认结构和测定方法，再保存。');
}
async function importMolecules(files) {
  if (!files.length) return;
  const before = await json('/api/publication');
  if (before.documentId !== documentId || before.revision !== revision) throw new Error('当前项目版本已变化。请先核对并重新读取，再导入结构。');
  const messages = [];
  let failures = false;
  for (const [index, file] of files.entries()) {
    try {
      const title = file.name.replace(/\.mol$/i, '');
      const input = { operationId: crypto.randomUUID(), actor: 'human', expectedRevision: revision, title, molblock: await file.text() };
      let result;
      try { result = await json('/api/molecules', input); }
      catch (e) {
        if (e.status && e.status < 500) throw e;
        result = await json('/api/molecules', input);
      }
      const doc = result.document;
      if (doc?.id !== documentId || doc.revision !== revision + 1) throw new Error('项目版本已变化，请重新读取并核对导入结果。');
      revision = doc.revision;
      operationId = undefined;
      molecules = Object.values(doc.objects).filter(obj => obj.kind === 'molecule').map(({id, title, version}) => ({id, title, version}));
      messages.push(file.name + ' 已加入');
    } catch (e) {
      failures = true;
      messages.push(file.name + ' · ' + e.message);
      if (!e.status || e.status === 409 || e.status >= 500) {
        for (const remaining of files.slice(index + 1)) messages.push(remaining.name + ' 已跳过');
        break;
      }
    }
  }
  renderSettings(); renderRows(); schedulePreview(); controls();
  notice(messages.join(' ｜ '), failures);
}
async function save() {
  if (staleIds.length && verifiedRevision !== revision) throw new Error('请先检查更新后的分子预览。');
  const submitted = withMarkedYields(draftSpec());
  const result = await json('/api/publication/save', {
    spec: submitted, operationId: operationId ??= crypto.randomUUID(), expectedRevision: revision,
  });
  if (result.documentId !== documentId || !result.publication || (result.replayed && JSON.stringify(result.publication.spec) !== JSON.stringify(submitted))) {
    throw new Error('已保存版本随后发生了变化。当前草稿仍保留，可下载草稿后重新读取。');
  }
  revision = result.revision;
  savedVersion = result.publication.version;
  spec = structuredClone(result.publication.spec);
  view = spec.kind;
  staleIds = result.publication.staleMoleculeIds || [];
  dirty = false; operationId = undefined;
  renderSettings(); renderRows(); schedulePreview();
  notice('已保存图表 v' + savedVersion + '。');
}
async function download() {
  if (dirty || !savedVersion || staleIds.length) throw new Error('请先确认并保存当前图稿。');
  const reactionOnly = byId('format').value === 'reaction-svg';
  const format = reactionOnly ? 'svg' : byId('format').value;
  const params = new URLSearchParams({ format, kind: view, columns: String(spec.columns), revision: String(revision) });
  if (reactionOnly) params.set('part','reaction');
  const response = await scopedFetch('/api/publication/export?' + params);
  if (!response.ok) throw await failure(response);
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  const title = spec.titles?.[view] || spec.title || view;
  a.href = url;
  a.download = title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 96) + (reactionOnly ? '-reaction' : '') + '-v' + savedVersion + '.' + format;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  notice('已下载 ' + kinds[view] + '（' + format.toUpperCase() + '，v' + savedVersion + '）。');
}

for (const a of document.querySelectorAll('a[data-workspace]')) a.href = workspacePageUrl(a.getAttribute('href'));
for (const [id, plural, single] of [['title','titles','title'],['caption','captions','caption']]) {
  byId(id).oninput = event => {
    spec[plural] ??= {};
    spec[plural][view] = event.target.value;
    if (view === spec.kind && !spec[single]) spec[single] = event.target.value;
    changed();
  };
}
byId('journal').onchange = e => { spec.journal = e.target.value; changed(); };
byId('abbreviations').onchange = e => { spec.abbreviations = e.target.value; changed(); };
byId('columns').onchange = e => { spec.columns = Number(e.target.value); changed(); };
byId('align-scaffolds').onchange = e => { spec.alignScaffolds = e.target.checked; changed(); };
byId('scope-columns').onchange = e => { put(spec,'scopeColumns',e.target.value ? Number(e.target.value) : '');changed(); };
for (const kind of Object.keys(kinds)) byId('view-' + kind).onclick = () => {
  if (view === kind) return;
  view = kind; operationId = undefined; renderSettings(); schedulePreview(); controls();
};
const templateKeys=['reactantTemplates','productTemplates'];
const scopeArrayKeys=['scaffoldGroups','scopeBands'];
const conditionFields=[['conditions-above','conditionsAbove'],['conditions-below','conditionsBelow']];
function reactionDraft() { return spec.reaction ??= {reactantIds:[],productIds:[]}; }
function finishReaction() {
  const rx=spec.reaction;
  if (rx && !rx.reactantIds.length && !rx.productIds.length &&
    !Object.keys(rx).some(key=>key!=='reactantIds' && key!=='productIds')) delete spec.reaction;
  changed();
}
function conditionText(entries) {
  return entries.flatMap(entry=>{
    const color = typeof entry==='object' && entry.color;
    return (typeof entry==='string' ? entry : entry.text).split('\n').map(line=>{
      if (color) return '['+color+'] '+line;
      return /^(?:\\|\[(?:black|blue|red|green)\])/.test(line) ? '\\'+line : line;
    });
  }).join('\n');
}
for (const [id,key] of conditionFields) {
  byId(id).oninput = e=>{
    const lines=e.target.value.split('\n').filter(line=>line.trim()).map(line=>{
      if (line.startsWith('\\')) return line.slice(1);
      const m=line.match(/^\[(black|blue|red|green)\]\s*(.+)$/);
      return m ? {text:m[2],color:m[1]} : line;
    });
    put(reactionDraft(),key,lines.length ? lines : '');finishReaction();
  };
}
byId('reaction-conditions').oninput=e=>{put(reactionDraft(),'conditions',e.target.value);finishReaction();};
function renderIdentities() {
  const rx=spec.reaction ?? {};
  const ids=new Set([...(rx.reactantIds ?? []),...(rx.productIds ?? []),...(rx.catalystIds ?? [])]);
  const list=byId('reaction-labels');list.replaceChildren();
  for (const id of ids) {
    const row=document.createElement('div');row.className='reaction-identity';
    const name=molecules.find(m=>m.id===id)?.title || id;
    function field(key,title) {
      const label=document.createElement('label'), input=document.createElement('input');
      label.append(document.createTextNode(title),input);
      input.value=rx[key]?.[id] ?? '';
      if (key==='catalystRepeats') { input.type='number';input.min='2';input.max='99';input.placeholder='1'; }
      else input.maxLength=120;
      input.oninput=()=>{
        if (input.validity.valid) {
          const values=Object.assign(Object.create(null),rx[key]);
          put(values,id,input.value && (key==='catalystRepeats' ? Number(input.value) : input.value));
          put(rx,key,Object.keys(values).length ? values : '');
        }
        changed();
      };
      row.append(label);
    }
    field('labels',name+' · 图下编号或名称');
    if (rx.catalystIds?.includes(id)) field('catalystRepeats','重复数');
    list.append(row);
  }
}
for (const [id,key] of [['reactants','reactantIds'],['products','productIds'],['catalysts','catalystIds']]) {
  byId(id).onchange=e=>{
    const rx=reactionDraft(), ids=[...e.target.selectedOptions].map(opt=>opt.value);
    const previous=rx[key] ?? [];
    const next=[...previous.filter(v=>ids.includes(v)),...ids.filter(v=>!previous.includes(v))];
    if (key==='catalystIds' && !next.length) delete rx[key]; else rx[key]=next;
    for (const removed of previous.filter(v=>!ids.includes(v))) {
      if (key==='catalystIds' && rx.catalystRepeats) delete rx.catalystRepeats[removed];
      if (![...rx.reactantIds,...rx.productIds,...(rx.catalystIds ?? [])].includes(removed) && rx.labels) delete rx.labels[removed];
    }
    for (const field of ['catalystRepeats','labels']) if(rx[field] && !Object.keys(rx[field]).length) delete rx[field];
    renderIdentities();finishReaction();
  };
}
byId('template-settings').oninput=e=>{
  try {
    const parsed=e.target.value.trim() ? JSON.parse(e.target.value) : {};
    if (!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw Error('应填写 JSON 对象。');
    for(const [key,value] of Object.entries(parsed)) {
      if (key==='scopeStyle') {
        if (!value || typeof value!=='object' || Array.isArray(value)) throw Error('scopeStyle 应为排版设置对象。');
      } else if (key==='abbreviationOverrides') {
        parsed[key]=resolveMoleculeMap(value,key);
        if (Object.values(value).some(v=>!['journal','expanded'].includes(v))) throw Error('缩写选项应为 journal 或 expanded。');
      } else if (key==='scopeYieldMethodInCaption') {
        if(typeof value!=='boolean') throw Error('scopeYieldMethodInCaption 应为 true 或 false。');
      } else if (![...scopeArrayKeys,...templateKeys].includes(key) || !Array.isArray(value)) throw Error('请按字段说明填写数组：'+key);
    }
    for (const key of scopeArrayKeys) put(spec,key,parsed[key]?.length ? parsed[key] : '');
    put(spec,'scopeYieldMethodInCaption',parsed.scopeYieldMethodInCaption ?? '');
    put(spec,'scopeStyle',parsed.scopeStyle ?? '');
    put(spec,'abbreviationOverrides',parsed.abbreviationOverrides ?? '');
    for (const key of templateKeys) {
      if (parsed[key]?.length) reactionDraft()[key]=parsed[key];
      else if(spec.reaction) delete spec.reaction[key];
    }
    templateError='';
  } catch (error) { templateError='图示设置 JSON 无效。'+error.message; }
  byId('template-error').textContent=templateError;
  finishReaction();
};
byId('reload').onclick = () => lock(reload);
byId('save').onclick = () => lock(save);
byId('download').onclick = () => lock(download);
byId('draft-file').onclick = () => {
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob([JSON.stringify(draftSpec(), null, 2)], { type: 'application/json' }));
  a.href = url; a.download = 'publication-draft.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};
byId('preview').onclick = renderPreview;
byId('add-row').onclick = () => {
  spec.experiments.push({ id: nextId() });
  renderRows(); changed();
  byId('rows').lastElementChild.querySelector('select').focus();
};
byId('add-column').onclick = () => {
  const name = byId('new-column').value.trim(), columns = conditionNames();
  if (!name || columns.includes(name) || ['__proto__','constructor','prototype'].includes(name)) {
    notice('请使用唯一且有效的条件列名。', true); return;
  }
  spec.conditionColumns = [...columns, name];
  byId('new-column').value = ''; renderRows(); changed();
};
byId('new-column').onkeydown = e => { if (e.key === 'Enter') byId('add-column').click(); };
byId('import').onclick = () => { byId('file').value = ''; byId('file').click(); };
byId('file').onchange = () => lock(() => importFile(byId('file').files[0]));
byId('import-mol').onclick = () => { byId('mol-files').value = ''; byId('mol-files').click(); };
byId('mol-files').onchange = () => lock(() => importMolecules([...byId('mol-files').files]));
window.addEventListener('beforeunload', event => {
  if (dirty || busy) { event.preventDefault(); event.returnValue = ''; }
});
await lock(reload);
