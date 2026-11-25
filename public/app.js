import { createWorkspaceUI } from './workspace-ui.js';
import { projectId, scopedFetch as fetch, scopeUrl, workspacePageUrl, projectLocked } from './workspace-context.js';
import { openMoleculeEditor, updateMoleculeEditorDocument } from './molecule-editor.js';
import { openLocalDepiction } from './local-depiction.js';
import { openStereoEditor } from './stereo-editor.js';
import { relationGeometry } from './relation-geometry.js';
import { modeSwitch, setMode } from './ui-mode.js';
import { showHistoryEntries } from './history-activity.js';

const $ = (selector, parent = document) => parent.querySelector(selector);
const names = { molecule: '分子', question: '问题', hypothesis: '假设', evidence: '证据', plan: '方案', note: '笔记', reaction: '反应', task: '任务' };
const relationNames = { relates_to: '关联', supports: '支持', contradicts: '反对', derived_from: '来源于', tests: '检验', refers_to: '引用' };
let doc, selected = null, tab = 'inspector', dirty = false, draftVersion = null, gesture = null, busy = false, polling = false, createKind = 'molecule';
let camera = { x: 55, y: 55, scale: 1 }, toastTimer;
let lastStructureTap = { id: null, at: 0 };
let canLayout = false, canAdjustDepiction = false, canEditStereo = false;
let proposalAcceptances = {}, acceptanceRevision = -1;
let sharedSelection = null, selectionRequest = 0;
let workspace;
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(child => child != null).map(child => typeof child === 'string' ? document.createTextNode(child) : child));
  return node;
};
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const values = collection => Object.values(collection || {});
const conflictText = conflict => ({ OBJECT_CHANGED: '目标分子或相关对象已经变化', RELATIONS_CHANGED: '相关反应关系已经变化', IDENTITY_USED: '候选使用的对象标识已被占用', GLOBAL_BASELINE_CHANGED: '此提议依赖的文档内容已经变化', CHANGES_INVALID: '候选不能应用到当前内容', HISTORY_UNAVAILABLE: '无法核验候选的历史基线', HISTORY_INCOMPLETE: '历史基线不完整', PROPOSAL_CHANGED: '提议内容已经变化', UNTRUSTED_SCOPE: '候选依赖无法核验', INVALID_SCOPE: '候选依赖无效' })[conflict?.reason] || '候选已不适用于当前文档';
function savedMoleculeImage(object, className, alt) {
  const image = el('img', { class: className, src: scopeUrl(`/api/depictions/${encodeURIComponent(object.id)}.svg?style=acs1996&version=${encodeURIComponent(object.version)}`), alt, draggable: false });
  image.addEventListener('error', () => {
    if (object.data?.svg) image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(object.data.svg)}`;
    image.title = 'ACS1996 绘图暂不可用，显示已保存的结构图';
  }, { once: true });
  return image;
}
const notify = (message, error = false) => {
  clearTimeout(toastTimer); const node = $('#toast'); node.textContent = message; node.className = error ? 'error' : ''; node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, error ? 9000 : 4000);
};
async function api(path, body) {
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (payload.document && payload.proposalAcceptances && payload.document.revision >= acceptanceRevision) {
    proposalAcceptances = payload.proposalAcceptances; acceptanceRevision = payload.document.revision;
  }
  if (!response.ok) { const error = new Error(payload.error?.message || `请求失败 (${response.status})`); error.code = payload.error?.code; throw error; }
  return payload;
}
const base = () => ({ operationId: id('op'), expectedRevision: doc.revision, actor: 'human' });
async function mutate(path, body, message) {
  if (busy) throw new Error('正在保存上一项操作，请稍候');
  busy = true;
  try { const result = await api(path, body); updateDocument(result.document); if (message) notify(message); return result.document; }
  catch (error) { if (error.code === 'CONFLICT') { await refresh(); error.message = `操作冲突：${error.message}。本次操作未保存；已有草稿仍保留，请检查最新内容。`; } throw error; }
  finally { busy = false; }
}
const operation = (changes, intent) => mutate('/api/operations', { ...base(), intent, changes }, '已保存');
function updateDocument(next) {
  if (!next || (doc && next.revision < doc.revision)) return;
  doc = next;
  updateMoleculeEditorDocument(doc);
  if (acceptanceRevision !== doc.revision) api('/api/document').then(result => updateDocument(result.document)).catch(() => {});
  $('#document-title').textContent = doc.title || '研究画布'; $('#revision').textContent = `r${doc.revision}`;
  workspace?.render();
  $('#proposal-count').textContent = values(doc.proposals).filter(p => p.status === 'pending').length;
  const reviewButton = $('#review-open');
  if (reviewButton) {
    const count = Number($('#proposal-count').textContent);
    reviewButton.textContent = count ? `审阅修改 · ${count}` : '审阅修改';
    reviewButton.classList.toggle('has-pending', count > 0);
    reviewButton.title = count ? `${count} 项真实候选等待审阅` : '暂无待审阅修改';
  }
  const reviewPanel = $('#molecule-review-content');
  if (reviewPanel) { reviewPanel.replaceChildren(); renderProposals(reviewPanel, reviewPanel.dataset.objectId || null); }
  const historyPanel = $('#history-dialog-content');
  if (historyPanel) { historyPanel.replaceChildren(); renderHistory(historyPanel); }
  if (!gesture) renderCanvas();
  if (!dirty) renderSide();
  else updateDraftNotice();
  updateCollaborationStatus();
}
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const request = selectionRequest;
    const [result, selectionResult] = await Promise.all([api('/api/document'), api('/api/selection').catch(() => null), workspace.refresh()]);
    if (request === selectionRequest && selectionResult?.selection) {
      const saved = selectionResult.selection;
      sharedSelection = { objectId: saved.objectIds?.[0], revision: saved.revision, atoms: saved.atomIds?.length || 0, bonds: saved.bondIds?.length || 0 };
    }
    $('#connection').textContent = '● 本地服务已连接'; $('#connection').classList.remove('offline');
    if (!doc || result.document.revision > doc.revision) updateDocument(result.document);
    updateCollaborationStatus();
  } catch (error) { $('#connection').textContent = '● 连接中断'; $('#connection').classList.add('offline'); if (!doc) $('#agent-detail').textContent = `无法连接本地服务：${error.message}`; }
  finally { polling = false; }
}
function transform() {
  $('#world').style.transform = `translate(${camera.x}px,${camera.y}px) scale(${camera.scale})`;
  $('#zoom-level').textContent = `${Math.round(camera.scale * 100)}%`;
  $('#viewport').style.backgroundPosition = `${camera.x}px ${camera.y}px`;
  $('#viewport').style.backgroundSize = `${22 * camera.scale}px ${22 * camera.scale}px`;
}
function zoom(factor, x = $('#viewport').clientWidth / 2, y = $('#viewport').clientHeight / 2) {
  const next = Math.max(.25, Math.min(2.5, camera.scale * factor)), ratio = next / camera.scale;
  camera.x = x - (x - camera.x) * ratio; camera.y = y - (y - camera.y) * ratio; camera.scale = next; transform();
}
function fit() {
  const views = visibleViews(); if (!views.length) { camera = { x: 55, y: 55, scale: 1 }; transform(); return; }
  const left = Math.min(...views.map(v => v.x)), top = Math.min(...views.map(v => v.y));
  const width = Math.max(...views.map(v => v.x + (v.width || 300))) - left;
  const height = Math.max(...views.map(v => v.y + (v.height || 210))) - top;
  const viewport = $('#viewport'); camera.scale = Math.max(.25, Math.min(1.15, (viewport.clientWidth - 80) / width, (viewport.clientHeight - 80) / height));
  camera.x = (viewport.clientWidth - width * camera.scale) / 2 - left * camera.scale;
  camera.y = (viewport.clientHeight - height * camera.scale) / 2 - top * camera.scale; transform();
}
function visibleViews() {
  const ids = workspace?.visibleIds() || new Set();
  return values(doc?.views).filter(view => ids.has(view.objectId));
}
function renderCanvas() {
  if (!doc) return;
  const views = visibleViews();
  const cards = $('#cards'); cards.replaceChildren(); $('#empty-state').hidden = views.length > 0;
  $('#object-count').textContent = `${views.length} 项`;
  document.body.classList.toggle('hidden-selection', !!selected && !workspace.visibleIds().has(selected));
  workspace.render();
  for (const view of views) {
    const object = doc.objects[view.objectId]; if (!object) continue;
    const card = el('article', { class: `card${selected === object.id ? ' selected' : ''}`, tabIndex: 0, 'aria-label': `${names[object.kind] || object.kind}：${object.title}`, 'data-view': view.id, 'data-kind': object.kind });
    Object.assign(card.style, { left: `${view.x}px`, top: `${view.y}px`, width: `${view.width || 300}px`, height: `${view.height || 210}px` });
    card.append(el('div', { class: 'card-header' }, el('span', { class: `kind-chip kind-${object.kind}` }, names[object.kind] || object.kind), el('span', { class: 'card-version' }, `v${object.version}`)), el('h3', {}, object.title || '未命名对象'));
    if (object.kind === 'molecule') card.append(savedMoleculeImage(object, 'molecule-image', `${object.title}的二维分子结构`));
    else card.append(el('p', { class: 'card-text' }, object.data?.text || '暂无内容'));
    card.append(el('div', { class: 'card-footer' }, object.kind === 'molecule' ? object.data?.smiles || '结构尚不可用' : `${object.provenance?.actor === 'agent' ? 'Agent' : '研究者'} · ${names[object.kind] || object.kind}`));
    card.addEventListener('pointerdown', event => {
      if (object.kind === 'molecule' && event.button === 0) {
        const now = performance.now(), doubleTap = lastStructureTap.id === object.id && now - lastStructureTap.at < 350;
        lastStructureTap = { id: object.id, at: now };
        if (doubleTap) { event.stopPropagation(); lastStructureTap.id = null; beginSketch(object); return; }
      }
      startDrag(event, view, card);
    });
    if (object.kind === 'molecule') card.addEventListener('dblclick', () => beginSketch(object));
    card.addEventListener('keydown', event => { if (event.key === 'Enter') select(object.id); }); cards.append(card);
  }
  renderRelations();
}
function renderRelations() {
  const svg = $('#relations'); svg.replaceChildren(); const ns = 'http://www.w3.org/2000/svg';
  const svgNode = (tag, attrs) => { const node = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; };
  const defs = svgNode('defs', {}), marker = svgNode('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
  marker.append(svgNode('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#a3a3a3' })); defs.append(marker); svg.append(defs);
  for (const relation of values(doc.relations)) {
    const geometry = relationGeometry({ ...doc, views: visibleViews() }, relation); if (!geometry) continue;
    const { start, end } = geometry;
    svg.append(svgNode('path', { d: geometry.path, class: 'relation-line', 'marker-end': 'url(#arrow)', 'data-relation': relation.id, 'data-from-view': geometry.fromViewId, 'data-to-view': geometry.toViewId }));
    const label = svgNode('text', { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 8, 'text-anchor': 'middle', class: 'relation-label' }); label.textContent = relationNames[relation.kind] || relation.kind; svg.append(label);
  }
}
function canLeaveDraft() { return !dirty || window.confirm('此对象有未提交草稿。放弃草稿并切换？'); }
function select(objectId) {
  if (selected !== objectId && !canLeaveDraft()) return false;
  if (selected !== objectId) dirty = false;
  selected = objectId; tab = 'inspector'; renderCanvas(); if (!dirty) renderSide();
  const revision = doc.revision, request = ++selectionRequest;
  sharedSelection = { checking: true }; updateCollaborationStatus();
  api('/api/selection', { objectIds: [objectId], revision }).then(() => {
    if (request !== selectionRequest) return;
    sharedSelection = { objectId, revision }; updateCollaborationStatus();
  }).catch(() => { if (request === selectionRequest) { sharedSelection = { error: true }; updateCollaborationStatus(); } });
  return true;
}
function setTab(next) {
  // Browsing review/history never replaces an inspector with an unsaved draft.
  if (next === 'proposals') return openReview();
  if (next === 'history') return openHistory();
  tab = next; if (!dirty) renderSide();
}
function pendingForSelection() {
  return values(doc?.proposals).filter(p => p.status === 'pending' && (p.review?.objectId === selected || (p.changes || p.operation?.changes || []).some(c => c.id === selected || c.object?.id === selected)));
}
async function copyObjectReference() {
  const object = doc?.objects[selected];
  if (dirty || !object) return;
  const reference = { projectId, documentId: doc.id, revision: doc.revision, objectId: object.id, objectVersion: object.version, title: object.title };
  const read = { projectId, objectIds: [object.id], detail: 'full' };
  const text = ['Chem Canvas · 已保存的整张卡片', JSON.stringify(reference), `请用 canvas_read(${JSON.stringify(read)}) 读取该对象并核对文档 ID。回复时注明读到的标题和对象版本，若版本已变请指出。`].join('\n');
  const stillSelected = () => !dirty && doc.id === reference.documentId && selected === object.id && doc.objects[selected]?.version === object.version;
  const manual = $('#object-reference-text');
  try {
    await navigator.clipboard.writeText(text);
    if (!stillSelected()) return;
    manual.hidden = true;
    manual.value = '';
    notify(`已复制「${object.title}」的对象引用，可粘贴到对话中。`);
  } catch {
    if (!stillSelected()) return;
    manual.value = text;
    manual.dataset.objectId = object.id;
    manual.dataset.version = String(object.version);
    manual.hidden = false;
    manual.focus();
    manual.select();
    notify('请复制已选中的对象引用，粘贴到对话中。');
  }
}
function updateCollaborationStatus() {
  const status = $('#collaboration-status'); if (!status) return;
  const object = doc?.objects[selected];
  status.parentElement.hidden = !!doc && !object && !dirty;
  const label = $('#selection-label');
  label.textContent = object?.title || (object ? '未命名对象' : dirty ? '当前对象已删除' : '');
  label.title = label.textContent;
  label.hidden = !label.textContent;
  const copy = $('#copy-object-reference'), manual = $('#object-reference-text');
  copy.hidden = dirty || !object;
  if (!manual.hidden && (copy.hidden || manual.dataset.objectId !== selected || manual.dataset.version !== String(object.version))) {
    manual.hidden = true;
    manual.value = '';
  }
  status.textContent = dirty ? '本地未保存草稿 · Agent 不可读取草稿' : !doc ? '正在载入已保存内容…' : '已保存内容可供 Agent 读取';
  status.dataset.state = dirty ? 'draft' : 'saved';
  const selectionStatus = $('#selection-share-status');
  selectionStatus.textContent = !object ? '' : sharedSelection?.error ? '选择同步失败，请重新选择' : sharedSelection?.objectId === selected && sharedSelection.revision === doc.revision ? (sharedSelection.atoms || sharedSelection.bonds ? `已共享局部选择：${sharedSelection.atoms || 0} 个原子、${sharedSelection.bonds || 0} 条键` : '已共享对象选择') : sharedSelection?.objectId === selected ? '内容已更新，请重新选择以共享范围' : sharedSelection?.checking ? '正在同步对象选择…' : '请重新选择以共享范围';
  const entry = $('#selection-review'); if (entry) { const pending = pendingForSelection(); entry.hidden = !pending.length; entry.textContent = `审阅此对象的修改 · ${pending.length}`; }
}
function updateDraftNotice() {
  updateCollaborationStatus();
  const node = $('#draft-notice'); if (!node) return;
  const object = doc.objects[selected]; node.textContent = !object ? '对象已被外部删除。草稿仍保留，请复制后另建对象。' : object.version !== draftVersion ? '对象已被外部修改。草稿仍保留；请先复制草稿，再载入最新版本。' : '未保存草稿仅在当前页面，Agent 仍只能读取已保存内容。';
}
function field(label, control) { return el('label', {}, label, control); }
function renderSide() {
  updateCollaborationStatus();
  document.body.classList.toggle('has-selection', !!doc?.objects[selected]);
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  const panel = $('#side-content'); panel.replaceChildren(); if (!doc) { panel.append(el('p', { class: 'side-empty' }, '正在连接本地研究文档…')); return; }
  if (tab === 'history') return renderHistory(panel);
  if (tab === 'proposals') return renderProposals(panel);
  const object = doc.objects[selected];
  if (!object) { panel.append(el('div', { class: 'side-empty' }, el('span', { class: 'large-icon' }, '⌖'), el('h2', {}, '选择画布上的对象'), el('p', {}, '在这里查看和编辑结构、文字及关系。保存后，Agent 可读取相同的已保存内容。'))); return; }
  draftVersion = object.version;
  panel.append(el('div', { class: 'inspector-top' }, el('strong', {}, `当前${names[object.kind] || '对象'}`), el('span', { class: 'object-meta' }, `对象 v${object.version}`)));
  panel.append(el('button', { id: 'selection-review', class: 'selection-review', hidden: !pendingForSelection().length, onClick: () => openReview(selected) }, `审阅此对象的修改 · ${pendingForSelection().length}`));
  const form = el('form'), title = el('input', { value: object.title || '', required: true, maxLength: 240 }); form.append(field('标题', title));
  let content, format;
  if (object.kind === 'molecule') {
    form.append(el('button', { type: 'button', class: 'primary edit-structure-button', onClick: () => beginSketch(object) }, '✎ 编辑结构'));
    const structureActions = el('div', { class: 'structure-actions' });
    structureActions.append(el('button', { type: 'button', onClick: async () => {
      try { const response = await fetch(`/api/depictions/${encodeURIComponent(object.id)}.svg?style=acs1996&version=${object.version}`); if (!response.ok) throw new Error('结构图导出失败'); const url = URL.createObjectURL(await response.blob()); el('a', { href: url, download: 'molecule.svg' }).click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (error) { notify(error.message, true); }
    } }, '导出 SVG'));
    if (canLayout) structureActions.append(el('button', { type: 'button', title: '重新整理已保存结构的二维坐标；保留分子身份，可在历史中撤销', onClick: async () => {
      if (dirty) { notify('请先保存或载入最新，保留当前文字草稿后再整理结构。', true); return; }
      try { await mutate('/api/molecules/layout', { ...base(), objectId: object.id, expectedObjectVersion: object.version }, '二维坐标已整理并保存'); } catch (error) { notify(error.message, true); }
    } }, '整理二维结构'));
    if (canAdjustDepiction) structureActions.append(el('button', { type: 'button', onClick: () => {
      if (dirty) { notify('请先保存文字草稿，再打开局部排版。', true); return; }
      openLocalDepiction({ objectId: object.id, onSaved: (next, objectId) => { updateDocument(next); select(objectId); notify('分子排版已保存，可在历史中撤销'); } });
    } }, '局部排版…' + (object.data.structure?.molecules?.[0]?.extensions?.some(e=>e.atomRings?.some(r=>r.length>=12))?' / 双链展开':'')));
    if (canEditStereo) structureActions.append(el('button', { type: 'button', onClick: () => {
      if (dirty) { notify('请先保存文字草稿，再编辑立体构型。', true); return; }
      openStereoEditor({ objectId: object.id, onSaved: (next, objectId) => { updateDocument(next); select(objectId); notify('立体构型已保存，可在历史中撤销'); } });
    } }, '立体构型…'));
    form.append(el('details', { class: 'structure-tools' }, el('summary', {}, '排版、立体与导出'), structureActions));
    const structureImport = el('details', { class: 'structure-import-details' }, el('summary', {}, 'SMILES / MOL 导入与替换'));
    format = el('select', {}, el('option', { value: 'smiles' }, 'SMILES'), el('option', { value: 'molblock' }, 'MOL block'));
    content = el('textarea', { class: 'code-input', rows: 5, value: object.data?.smiles || '' });
    format.addEventListener('change', () => { if (dirty && !window.confirm('切换格式将载入已保存结构，替换当前结构草稿。继续？')) { format.value = format.value === 'smiles' ? 'molblock' : 'smiles'; return; } content.value = object.data?.[format.value] || ''; dirty = true; updateDraftNotice(); });
    structureImport.append(field('结构输入', format), field('结构内容', content), el('p', { class: 'field-hint' }, '可粘贴结构替换当前分子；直接改原子或键请使用“编辑结构”。'));
    const validationDetails = el('details', { class: 'validation-details' }, el('summary', {}, '结构校验详情'), el('p', { class: 'field-hint' }, '以下信息对应已保存结构。保存新结构时会重新解析；不能保证保留原子身份。'));
    for (const warning of object.data?.warnings || []) validationDetails.append(el('p', { class: 'field-hint' }, String(warning)));
    if (object.data?.chemistry) validationDetails.append(el('p', { class: 'field-hint' }, `解析工具：${object.data.chemistry.tool || '—'} ${object.data.chemistry.version || ''}`));
    structureImport.append(validationDetails); form.append(structureImport);
    if (object.data?.lastEdit) {
      const edit = object.data.lastEdit;
      const summary = `原子 +${edit.addedAtoms?.length || 0} / −${edit.removedAtoms?.length || 0} / 修改 ${edit.changedAtoms?.length || 0}；键 +${edit.addedBonds?.length || 0} / −${edit.removedBonds?.length || 0} / 修改 ${edit.changedBonds?.length || 0}；移动 ${edit.movedAtoms?.length || 0}`;
      form.append(el('div', { class: 'recent-structure-edit' }, el('strong', {}, '最近结构修改'), el('p', {}, summary), el('small', {}, `${edit.actor === 'agent' ? 'Agent' : '研究者'} · agent 可读取这次变更`), el('details', {}, el('summary', {}, '查看原子 / 键变更标识'), el('pre', {}, JSON.stringify(edit, null, 2)))));
    }
  } else { content = el('textarea', { rows: 7, value: object.data?.text || '' }); form.append(field('内容', content)); }
  const notice = el('p', { id: 'draft-notice', class: 'draft-message' }), errorNode = el('p', { class: 'error-text', role: 'alert' });
  form.append(notice, errorNode, el('div', { class: 'save-row' }, el('button', { class: 'primary', type: 'submit' }, '保存修改'), el('button', { type: 'button', onClick: () => { if (canLeaveDraft()) { dirty = false; renderSide(); } } }, '载入最新')));
  form.addEventListener('input', () => { dirty = true; updateDraftNotice(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); errorNode.textContent = ''; const controls = [...form.querySelectorAll('input,textarea,select,button')]; controls.forEach(node => { node.disabled = true; });
    try {
      if (!doc.objects[object.id] || doc.objects[object.id].version !== draftVersion) throw new Error('此对象已有外部修改。请复制草稿后点击“载入最新”，再合并内容。');
      dirty = true;
      if (object.kind === 'molecule' && content.value === (object.data?.[format.value] || '')) await operation([{ type: 'updateObject', id: object.id, patch: { title: title.value.trim() } }], '编辑分子标题');
      else if (object.kind === 'molecule') await mutate('/api/molecules', { ...base(), objectId: object.id, title: title.value.trim(), [format.value]: content.value }, '结构已校验并保存');
      else await operation([{ type: 'updateObject', id: object.id, patch: { title: title.value.trim(), data: { ...object.data, text: content.value } } }], '编辑研究对象');
      dirty = false; renderSide();
    } catch (error) { errorNode.textContent = error.message; updateDraftNotice(); } finally { controls.forEach(node => { node.disabled = false; }); }
  });
  panel.append(form);
  const relationDetails = el('details', {}, el('summary', { class: 'side-section-title' }, `关系 · ${values(doc.relations).filter(r => r.from === object.id || r.to === object.id).length}`));
  renderObjectRelations(relationDetails, object); panel.append(relationDetails);
  const details = el('details', {}, el('summary', { class: 'side-section-title' }, '来源与对象标识'), el('p', { class: 'object-meta' }, `ID: ${object.id}`), el('p', { class: 'object-meta' }, `来源：${JSON.stringify(object.provenance || {})}`)); panel.append(details);
  panel.append(el('button', { class: 'danger', onClick: () => deleteObject(object) }, '删除对象…'));
}
function renderObjectRelations(panel, object) {
  for (const relation of values(doc.relations).filter(r => r.from === object.id || r.to === object.id)) {
    const from = doc.objects[relation.from]?.title || relation.from, to = doc.objects[relation.to]?.title || relation.to;
    panel.append(el('div', { class: 'relation-item' }, el('span', { class: 'relation-copy' }, `${from} → ${relationNames[relation.kind] || relation.kind} → ${to}${relation.note ? ` · ${relation.note}` : ''}`), el('button', { title: '删除关系', onClick: async () => { try { await operation([{ type: 'deleteRelation', id: relation.id }], '删除显式关系'); if (dirty) notify('关系已删除；对象草稿仍保留'); } catch (error) { notify(error.message, true); } } }, '×')));
  }
  const others = values(doc.objects).filter(o => o.id !== object.id); if (!others.length) { panel.append(el('p', { class: 'field-hint' }, '添加另一个对象后，可以建立有方向的研究关系。')); return; }
  const kind = el('select', {}, ...Object.entries(relationNames).map(([key, label]) => el('option', { value: key }, label)));
  const target = el('select', {}, ...others.map(o => el('option', { value: o.id }, o.title || names[o.kind])));
  const note = el('input', { placeholder: '关系依据（可选）' });
  const form = el('form', { class: 'relation-form' }, field('当前对象 → 关系', kind), field('目标对象', target), note, el('button', { type: 'submit' }, '建立关系'));
  form.addEventListener('input', () => { dirty = true; updateDraftNotice(); });
  form.addEventListener('submit', async event => { event.preventDefault(); try { await operation([{ type: 'createRelation', relation: { id: id('rel'), kind: kind.value, from: object.id, to: target.value, sourceVersion: doc.objects[object.id].version, targetVersion: doc.objects[target.value].version, note: note.value } }], '建立显式研究关系'); if (dirty) notify('关系已建立；对象草稿仍保留'); } catch (error) { notify(error.message, true); } }); panel.append(form);
}
async function deleteObject(object) {
  if (!window.confirm(`删除“${object.title}”及其所有展示和关联关系？此操作将记录到历史。`)) return;
  const changes = [...values(doc.relations).filter(r => r.from === object.id || r.to === object.id).map(r => ({ type: 'deleteRelation', id: r.id })), ...values(doc.views).filter(v => v.objectId === object.id).map(v => ({ type: 'deleteView', id: v.id })), { type: 'deleteObject', id: object.id }];
  try { await operation(changes, '删除对象及其展示与关系'); dirty = false; selected = null; renderSide(); } catch (error) { notify(error.message, true); }
}
function proposalMoleculePreview(label, title, data, savedObject = null) {
  const figure = el('figure', { class: 'proposal-molecule' }, el('figcaption', {}, el('span', { class: 'preview-label' }, label), el('strong', {}, title || '未命名分子')));
  if (typeof data?.svg === 'string' && data.svg) {
    const image = savedObject ? savedMoleculeImage(savedObject, '', `${label}：${title || '分子'}的二维结构`) : el('img', { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.svg)}`, alt: `${label}：${title || '分子'}的二维结构`, draggable: false });
    if (!savedObject) image.addEventListener('error', () => { image.replaceWith(el('p', { class: 'field-hint' }, '结构图片无法显示，请展开 SMILES 核对。')); });
    figure.append(image);
  } else figure.append(el('p', { class: 'field-hint' }, '暂无结构图片'));
  figure.append(el('details', {}, el('summary', {}, '查看 SMILES'), el('code', { class: 'preview-smiles' }, data?.smiles || '未提供 SMILES')));
  return figure;
}
function renderProposals(panel, objectId = null) {
  const proposals = values(doc.proposals).reverse().filter(p => !objectId || p.review?.objectId === objectId || (p.changes || p.operation?.changes || []).some(c => c.id === objectId || c.object?.id === objectId));
  const pending = proposals.filter(p => p.status === 'pending');
  panel.append(el('p', { class: 'field-hint review-count' }, `${objectId ? '此对象' : '全部'}待审阅 ${pending.length} 项 · 接受后保存，拒绝保留当前结构。`));
  if (objectId) panel.append(el('button', { class: 'quiet', onClick: () => { delete panel.dataset.objectId; panel.replaceChildren(); renderProposals(panel); } }, '查看全部修改'));
  if (!pending.length) panel.append(el('div', { class: 'side-empty' }, '暂无待审阅修改。Agent 提交候选后会出现在这里。'));
  const resolved = el('details', { class: 'resolved-proposals' }, el('summary', {}, `已处理记录 · ${proposals.length - pending.length}`));
  for (const proposal of proposals) {
    const review = proposal.review;
    const acceptance = acceptanceRevision === doc.revision ? proposalAcceptances[proposal.id] : null;
    const targetChanged = !acceptance?.canAccept;
    const state = proposal.status === 'pending' ? (acceptance?.conflict ? '已过期 · 需重新提出' : acceptance?.canAccept ? '待审阅 · 可接受' : '正在核验') : ({ accepted: '已接受', rejected: proposal.reviewFeedback ? '已退回' : '已拒绝' })[proposal.status] || proposal.status;
    const box = el('section', { class: 'proposal', 'data-proposal-id': proposal.id }, el('span', { class: `kind-chip${acceptance?.conflict ? ' stale-candidate' : ''}` }, state), el('h3', {}, proposal.title || '未命名提议'), el('p', {}, proposal.rationale || '未提供理由'));
    if (proposal.reviewFeedback) box.append(el('p', { class: 'proposal-feedback' }, el('strong', {}, '修改意见'), '\n', proposal.reviewFeedback));
    if (proposal.status === 'pending' && targetChanged) box.append(el('p', { class: 'error-text' }, acceptance?.conflict ? `${conflictText(acceptance.conflict)}。请让 Agent 基于当前已保存内容重新提出；也可拒绝此候选。` : '正在检查候选基线…'));
    if (review?.kind === 'molecule-candidate') {
      const delta = review.delta;
      const pieces = [['addedAtoms', '新增原子'], ['removedAtoms', '删除原子'], ['changedAtoms', '修改原子'], ['addedBonds', '新增键'], ['removedBonds', '删除键'], ['changedBonds', '修改键'], ['movedAtoms', '调整位置']].filter(([key]) => delta[key]?.length).map(([key, label]) => `${label} ${delta[key].length} 处`);
      box.append(el('p', { class: 'candidate-delta' }, pieces.join(' · ') || '结构无原子、键或位置变化'));
      for (const change of delta.stereoChanges || []) box.append(el('p', { class: 'candidate-delta' }, `立体构型 ${change.before.configuration ?? change.before.tag ?? '未指定'} → ${change.after.configuration ?? change.after.tag ?? '未指定'}`));
      if (proposal.status === 'pending' && !targetChanged) box.append(el('p', { class: 'field-hint' }, '候选尚未应用，请比较结构后决定。'));
    }
    const changes = proposal.changes || proposal.operation?.changes || [];
    for (const change of changes) {
      if (change.type === 'createObject' && change.object?.kind === 'molecule' && change.object.data?.svg) {
        box.append(proposalMoleculePreview('提议新增', change.object.title, change.object.data));
      } else if (change.type === 'updateObject' && change.patch?.data?.svg) {
        const current = doc.objects[change.id] || changes.find(item => item.type === 'createObject' && item.object?.id === change.id)?.object;
        if (current?.kind !== 'molecule') continue;
        const comparison = el('div', { class: 'proposal-comparison' });
        if (proposal.status === 'pending' && doc.objects[change.id]) comparison.append(proposalMoleculePreview('当前已保存', current.title, current.data, current));
        comparison.append(proposalMoleculePreview('提议结构', change.patch.title ?? current.title, change.patch.data));
        box.append(comparison);
      }
    }
    const summary = el('ul', { class: 'proposal-summary' });
    const changeNames = { createObject: '新增对象', updateObject: '更新对象', createView: '新增展示', moveView: '移动展示', updateView: '调整展示', createRelation: '建立关系', deleteRelation: '删除关系', deleteObject: '删除对象', deleteView: '删除展示' };
    for (const change of changes) summary.append(el('li', {}, `${changeNames[change.type] || change.type}：${change.object?.title || change.patch?.title || doc.objects[change.id]?.title || change.id || change.relation?.kind || change.view?.objectId || ''}`));
    box.append(el('details', {}, el('summary', {}, `变更详情 · ${changes.length} 项`), summary, review ? el('p', {}, `基于分子版本 ${review.baseObjectVersion ?? '新建'}；稳定身份与完整结构见下方记录。`) : null, el('pre', {}, JSON.stringify(changes, null, 2))));
    if (proposal.status === 'pending') {
      for (const [action, label] of [['accept', '接受提议'], ['reject', '拒绝']]) {
        const button = el('button', { class: action === 'accept' ? 'primary' : '', disabled: action === 'accept' && targetChanged, onClick: async () => {
          button.disabled = true;
          try { await resolveReview(proposal.id, action); }
          catch (error) { notify(error.message, true); button.disabled = false; }
        } }, label);
        box.append(button);
      }
      box.append(el('button', { class: 'return-proposal', onClick: () => openReviewFeedback(proposal) }, '退回并说明'));
    }
    if (proposal.status === 'pending') panel.append(box); else resolved.append(box);
  }
  if (proposals.length > pending.length) panel.append(resolved);
}
function resolveReview(proposalId, action, reviewFeedback) {
  const body = { ...base(), action };
  if (reviewFeedback) body.reviewFeedback = reviewFeedback;
  const message = action === 'accept' ? '提议已接受' : reviewFeedback ? '已退回，修改意见已保存' : '提议已拒绝';
  return mutate(`/api/proposals/${encodeURIComponent(proposalId)}/resolve`, body, message);
}
function openReviewFeedback(proposal) {
  if ($('#proposal-feedback-dialog')) return;
  const input = el('textarea', { rows: 4, required: true, maxLength: 4000, autofocus: true });
  const status = el('p', { class: 'error-text', role: 'status' });
  const submit = el('button', { type: 'submit', class: 'primary' }, '保存意见并退回');
  const cancel = el('button', { type: 'button', onClick: () => dialog.close() }, '取消');
  const form = el('form', {}, el('h2', {}, '退回提议'), el('p', {}, proposal.title || '未命名提议'),
    el('label', {}, '希望 Agent 怎么改？', input),
    el('p', { class: 'field-hint' }, '意见会保存在这条提议上。Agent 下次读取画布时可以看到。'),
    status, el('div', { class: 'dialog-actions' }, cancel, submit));
  // The review card can be replaced by a live update while the reviewer types.
  const dialog = el('dialog', { id: 'proposal-feedback-dialog', 'aria-label': '退回提议' }, form);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const feedback = input.value.trim();
    if (!feedback) { status.textContent = '请填写修改意见。'; input.focus(); return; }
    if (doc.proposals[proposal.id]?.status !== 'pending') { status.textContent = '这条提议已处理，修改意见未提交。'; submit.disabled = true; return; }
    submit.disabled = true;
    try { await resolveReview(proposal.id, 'reject', feedback); dialog.close(); }
    catch (error) { status.textContent = error.message; submit.disabled = false; }
  });
  document.body.append(dialog);
  dialog.showModal();
}
function openReview(objectId = null) {
  if (!doc || $('#molecule-review-dialog')) return;
  // This modal does not rebuild the inspector or discard its unsaved text.
  const content = el('div', { id: 'molecule-review-content' });
  if (objectId) content.dataset.objectId = objectId;
  const dialog = el('dialog', { id: 'molecule-review-dialog', class: 'molecule-review-dialog', 'aria-label': '审阅 agent 修改' },
    el('div', { class: 'review-heading' }, el('h2', {}, '审阅修改'), el('button', { type: 'button', onClick: () => { dialog.close(); dialog.remove(); } }, '关闭')),
    el('p', { class: 'field-hint' }, '先看结构与变化，再决定是否应用。你在对象面板中的未保存草稿会保留。'), content);
  dialog.addEventListener('cancel', () => dialog.remove());
  document.body.append(dialog); renderProposals(content, objectId); dialog.showModal();
}
function openHistory() {
  if (!doc || $('#history-dialog')) return;
  const content = el('div', { id: 'history-dialog-content' });
  const dialog = el('dialog', { id: 'history-dialog', class: 'molecule-review-dialog', 'aria-label': '修改历史' }, el('div', { class: 'review-heading' }, el('h2', {}, '修改历史'), el('button', { onClick: () => { dialog.close(); dialog.remove(); } }, '关闭')), content);
  dialog.addEventListener('cancel', () => dialog.remove()); document.body.append(dialog); renderHistory(content); dialog.showModal();
}
async function openCanvasOverview() {
  if ($('#canvas-overview-dialog')) return;
  const status = el('p', { role: 'status' }, '正在生成路线总览…');
  const picture = el('img', { alt: '已保存画布的路线总览', hidden: true });
  const download = el('a', { hidden: true, download: 'chem-canvas-overview.svg' }, '导出路线 SVG');
  const dialog = el('dialog', { id: 'canvas-overview-dialog', class: 'canvas-overview-dialog', 'aria-label': '路线总览' },
    el('div', { class: 'review-heading' }, el('h2', {}, '路线总览'), el('button', { onClick: () => { dialog.close(); dialog.remove(); } }, '关闭')), status, download, picture);
  dialog.addEventListener('cancel', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
  try {
    const result = await api('/api/canvas/inspect', { maxDimension: 2000 });
    picture.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`; picture.hidden = false;
    download.href = picture.src; download.hidden = false;
    status.textContent = `已保存版本 r${result.revision} · ${result.views.length} 张卡片、${result.relations.length} 条关系。与 agent 共用的路线总览；使用当前卡片位置及分子绘图。${result.warnings.length ? `发现 ${result.warnings.length} 项排版提示，请检查重叠、截断或过小的卡片。` : ''}`;
  } catch (error) { status.textContent = error.message; }
}
function renderHistory(panel) {
  panel.append(el('div', { class: 'history-toolbar' }, `文档修订 r${doc.revision}`, el('button', { disabled: !doc.history?.at(-1)?.reversible, title: '仅最新一项可撤销的操作可撤销', onClick: async () => { try { await mutate('/api/undo', base(), '已撤销上一步'); } catch (error) { notify(error.message, true); } } }, '撤销上一步')));
  if (!doc.history?.length) panel.append(el('p', { class: 'side-empty' }, '还没有修改记录。'));
  showHistoryEntries(panel, { entries: [...(doc.history || [])].reverse(), api, el, renderTarget: renderHistoryTarget });
}
function renderHistoryTarget(row) {
  const object = doc.objects[row.objectId];
  const target = el('div', { class: 'history-target' }, el('span', {},
    el('b', {}, row.title), ' · ' + row.details.join('、')));
  const currentView = () => row.viewId ? doc.views[row.viewId] : values(doc.views).find(view => view.objectId === row.objectId);
  if (object?.kind === 'publication') {
    const figure = object.data.format === 'chem-canvas.figure/1';
    target.append(el('a', { href: workspacePageUrl(figure ? '/figure.html' : '/publication.html'), target: '_blank', rel: 'noopener' }, figure ? '打开图稿' : '打开图表'));
  } else if (currentView()) {
    const hidden = !workspace.visibleIds().has(row.objectId);
    const label = hidden ? '在整个项目中定位' : '在画布定位';
    target.append(el('button', { type: 'button', 'aria-label': `${label}：${row.title}`, onClick: () => {
      const view = currentView();
      if (!view) { notify('当前画布已无法显示这张卡片。', true); return; }
      const viewport = $('#viewport'), dialog = $('#history-dialog');
      dialog.close(); dialog.remove();
      if (!workspace.visibleIds().has(row.objectId)) {
        workspace.showProjectCards();
        setMode('full');
      }
      camera.scale = Math.max(.25, Math.min(camera.scale, (viewport.clientWidth - 24) / view.width, (viewport.clientHeight - 24) / view.height));
      camera.x = viewport.clientWidth / 2 - (view.x + view.width / 2) * camera.scale;
      camera.y = viewport.clientHeight / 2 - (view.y + view.height / 2) * camera.scale;
      transform();
      const card = $(`[data-view="${CSS.escape(view.id)}"]`, $('#cards'));
      if (card) { card.classList.add('history-located'); card.focus({ preventScroll: true }); }
    } }, label));
  } else {
    target.append(el('small', {}, object ? '当前画布无此卡片' : '对象已删除'));
  }
  return target;
}
function newPosition() { return { x: Math.round((80 - camera.x) / camera.scale + Math.random() * 60), y: Math.round((80 - camera.y) / camera.scale + Math.random() * 60) }; }
function beginSketch(object = null) {
  if (!doc) { notify('本地服务尚未连接', true); return; }
  if (!canLeaveDraft()) return;
  dirty = false;
  if (tab === 'inspector') renderSide();
  openMoleculeEditor({ object: object ? doc.objects[object.id] : null, revision: doc.revision, position: newPosition(), onSaved: async (next, objectId) => { updateDocument(next); if (objectId) { await workspace.includeSaved(objectId); select(objectId); } }, onImport: () => openCreate('molecule', true) });
}
function openCreate(kind, importStructure = false) {
  if (kind === 'molecule' && !importStructure) return beginSketch();
  if (!doc) { notify('本地服务尚未连接', true); return; }
  createKind = kind; $('#create-form').reset(); $('#create-heading').textContent = `添加${names[kind]}`; $('#molecule-fields').hidden = kind !== 'molecule'; $('#text-field').hidden = kind === 'molecule'; $('#new-structure').required = kind === 'molecule'; $('#create-error').textContent = ''; $('#create-dialog').showModal(); $('#new-title').focus();
}
$('#create-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!canLeaveDraft()) return; const button = $('button[type=submit]', event.currentTarget); button.disabled = true; $('#create-error').textContent = '';
  const objectId = id('obj'), position = newPosition(), title = $('#new-title').value.trim();
  try {
    let savedDocument;
    if (createKind === 'molecule') savedDocument = await mutate('/api/molecules', { ...base(), title, [$('#new-format').value]: $('#new-structure').value, ...position }, '分子已解析并添加');
    else await operation([{ type: 'createObject', object: { id: objectId, kind: createKind, title, data: { text: $('#new-text').value } } }, { type: 'createView', view: { id: id('view'), objectId, ...position, width: 300, height: 210 } }], `添加${names[createKind]}`);
    dirty = false; $('#create-dialog').close(); const created = createKind === 'molecule' ? values(savedDocument.objects).filter(o => o.kind === 'molecule').at(-1)?.id : objectId; if (created) { await workspace.includeSaved(created); select(created); }
  } catch (error) { $('#create-error').textContent = error.message; } finally { button.disabled = false; }
});
function startDrag(event, view, card) {
  if (event.button !== 0 || busy) return; event.stopPropagation();
  if (!select(view.objectId)) return;
  const currentCard = [...$('#cards').children].find(node => node.dataset.view === view.id) || card;
  gesture = { kind: 'card', pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: view.x, y: view.y, viewId: view.id, revision: doc.revision, moved: false, card: currentCard };
  currentCard.classList.add('dragging'); $('#viewport').setPointerCapture(event.pointerId);
}
$('#viewport').addEventListener('pointerdown', event => { if (event.button !== 0 || event.target.closest('button') || event.target.closest('#empty-state')) return; gesture = { kind: 'pan', pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: camera.x, y: camera.y }; $('#viewport').setPointerCapture(event.pointerId); });
$('#viewport').addEventListener('pointermove', event => {
  if (!gesture || event.pointerId !== gesture.pointer) return;
  const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
  if (gesture.kind === 'pan') { camera.x = gesture.x + dx; camera.y = gesture.y + dy; transform(); }
  else { if (Math.hypot(dx, dy) > 3) gesture.moved = true; gesture.nextX = gesture.x + dx / camera.scale; gesture.nextY = gesture.y + dy / camera.scale; gesture.card.style.left = `${gesture.nextX}px`; gesture.card.style.top = `${gesture.nextY}px`; }
});
async function endGesture(event) {
  if (!gesture || event.pointerId !== gesture.pointer) return;
  const ended = gesture; gesture = null;
  if ($('#viewport').hasPointerCapture(event.pointerId)) $('#viewport').releasePointerCapture(event.pointerId);
  if (ended.kind === 'card' && ended.moved && event.type !== 'pointercancel') {
    try { await mutate('/api/operations', { operationId: id('op'), actor: 'human', expectedRevision: ended.revision, intent: '移动画布展示', changes: [{ type: 'moveView', id: ended.viewId, x: Math.round(ended.nextX), y: Math.round(ended.nextY) }] }); }
    catch (error) { notify(error.message, true); }
  }
  if (doc) renderCanvas();
}
$('#viewport').addEventListener('pointerup', endGesture); $('#viewport').addEventListener('pointercancel', endGesture);
$('#viewport').addEventListener('wheel', event => { event.preventDefault(); if (gesture) return; const rect = $('#viewport').getBoundingClientRect(); zoom(Math.exp(-event.deltaY * .001), event.clientX - rect.left, event.clientY - rect.top); }, { passive: false });
for (const button of document.querySelectorAll('[data-create]')) button.addEventListener('click', () => openCreate(button.dataset.create));
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => setTab(button.dataset.tab));
$('#history-open').addEventListener('click', openHistory);
$('#copy-object-reference').addEventListener('click', copyObjectReference);
for (const selector of ['#close-dialog', '#cancel-dialog']) $(selector).addEventListener('click', () => $('#create-dialog').close());
$('#zoom-in').addEventListener('click', () => zoom(1.2)); $('#zoom-out').addEventListener('click', () => zoom(1 / 1.2)); $('#fit').addEventListener('click', fit); $('#fit-top').addEventListener('click', fit);
$('#export').addEventListener('click', async () => { try { const response = await fetch('/api/export'); if (!response.ok) throw new Error('导出失败'); const blob = await response.blob(), url = URL.createObjectURL(blob), link = el('a', { href: url, download: `chem-canvas-r${doc?.revision || 0}.json` }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (error) { notify(error.message, true); } });
$('#example').addEventListener('click', async event => {
  if (!doc || !canLeaveDraft()) return; const button = event.currentTarget; button.disabled = true;
  try {
    const { molecule } = await api('/api/chemistry/parse', { smiles: 'CC(=O)c1ccccc1' });
    const molId = id('obj'), questionId = id('obj'), noteId = id('obj');
    const objects = [{ id: molId, kind: 'molecule', title: '苯乙酮 · 教学示例', data: molecule }, { id: questionId, kind: 'question', title: '结构变化会怎样影响选择性？', data: { text: '虚构教学问题：比较不同取代位置时，需要哪些对照与证据？此处没有实际实验数据。' } }, { id: noteId, kind: 'note', title: '示例说明 · 全部为虚构内容', data: { text: '这是一次人工触发的示例导入，不是 agent 自主研究记录。你可以移动对象、修改结构或建立关系。' } }];
    const changes = objects.flatMap((object, index) => [{ type: 'createObject', object }, { type: 'createView', view: { id: id('view'), objectId: object.id, x: index === 1 ? 380 : 0, y: index === 2 ? 290 : 0, width: 300, height: 210 } }]);
    changes.push({ type: 'createRelation', relation: { id: id('rel'), from: questionId, to: molId, kind: 'refers_to', note: '虚构教学关联' } });
    await operation(changes, '人工导入明确标注的虚构教学示例'); dirty = false; await workspace.includeSaved(molId); select(molId); fit();
  } catch (error) { notify(error.message, true); } finally { button.disabled = false; }
});
window.addEventListener('beforeunload', event => { if (dirty || busy || document.querySelector('dialog[open]')) { event.preventDefault(); event.returnValue = ''; } });
// Keep less frequent object kinds in a compact menu, leaving structure creation prominent.
const rail = $('.toolrail'), addMenu = el('details', { class: 'add-menu' }, el('summary', {}, el('span', {}, '＋'), '添加'));
$('.canvas-heading>div').append(el('span', { class: 'depiction-style', title: '默认结构绘图风格；不改变分子身份或内容' }, 'ACS1996'));
const menuItems = el('div', { class: 'add-menu-items' });
for (const button of [...rail.querySelectorAll('[data-create]')].filter(node => node.dataset.create !== 'molecule')) { menuItems.append(button); button.addEventListener('click', () => { addMenu.open = false; }); }
addMenu.append(menuItems); $('.rail-divider').after(addMenu);
document.addEventListener('click', event => { if (!addMenu.contains(event.target)) addMenu.open = false; });
if (new URLSearchParams(location.search).get('embed') === '1') document.body.classList.add('embed');
$('.top-actions').prepend(modeSwitch());
$('.top-actions').append(el('button', { id: 'review-open', onClick: () => openReview() }, '审阅修改'));
$('.top-actions').append(el('button', { id: 'canvas-overview-open', onClick: openCanvasOverview }, '路线总览'));
if (!projectLocked) $('.top-actions').append(el('a', { href: workspacePageUrl('/benchmark.html'), class: 'benchmark-link' }, '评测看板 ↗'));
$('.top-actions').append(el('a', { href: workspacePageUrl('/figure.html'), class: 'benchmark-link' }, '期刊绘图 ↗'));
$('.top-actions').append(el('a', { href: workspacePageUrl('/scheme.html'), class: 'benchmark-link' }, '合成路线 ↗'));
const researchEntry = el('button', { class: 'research-entry quiet', onClick: () => setMode('full') }, '研究对象与关系 →');
const inspectorToggle = el('button', { class: 'inspector-toggle quiet', 'aria-expanded': 'true', onClick: () => {
  const collapsed = document.body.classList.toggle('inspector-collapsed'); inspectorToggle.textContent = collapsed ? '展开对象面板' : '收起对象面板'; inspectorToggle.setAttribute('aria-expanded', String(!collapsed));
} }, '收起对象面板');
$('.canvas-heading').append(inspectorToggle);
$('.canvas-heading').append(el('button', { class: 'primary quick-draw', onClick: () => beginSketch() }, '＋ 绘制分子'));
$('.canvas-heading').append(el('button', { class: 'quick-import', onClick: () => openCreate('molecule', true) }, '导入结构'));
const more = el('details', { class: 'workspace-more' }, el('summary', {}, '更多'));
const moreItems = el('div', { class: 'workspace-more-items' });
for (const node of document.querySelectorAll('#history-open, #export, #canvas-overview-open, .top-actions .benchmark-link')) moreItems.append(node);
moreItems.prepend(researchEntry);
more.append(moreItems); $('.top-actions').append(more);
more.addEventListener('click', event => { if (event.target.closest('button,a')) more.open = false; });
document.addEventListener('click', event => { if (!more.contains(event.target)) more.open = false; });
$('#empty-state h2').textContent = '开始当前任务';
$('#empty-state p:not(.eyebrow)').textContent = '绘制或导入分子，也可从已有结构开始。';
$('#empty-state>div:last-of-type').append(el('button', { onClick: () => openCreate('molecule', true) }, '导入结构'));
workspace = createWorkspaceUI({ api, getDocument: () => doc, notify, canRefreshScope: () => !dirty && !busy && !gesture && !document.querySelector('dialog[open]'), canNavigate: () => {
  if (dirty || busy || gesture || document.querySelector('dialog[open]')) { notify('请先保存或取消当前编辑，再切换项目或任务。', true); return false; }
  return true;
}, onScopeChange: (clearSelection = true) => {
  if (clearSelection && !dirty) { selected = null; sharedSelection = null; ++selectionRequest; if (doc) api('/api/selection', { objectIds: [], revision: doc.revision }).catch(() => {}); renderSide(); }
  if (doc) renderCanvas();
} });
window.addEventListener('chem-ui-mode-change', () => { if (doc) renderCanvas(); });
transform(); refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 2000);
api('/api/capabilities').then(result => { canLayout = result.editing?.layout2D === true; canAdjustDepiction = result.editing?.localDepiction?.available === true; canEditStereo = !!result.chemistry?.editing?.stereo?.operations?.length; if (!dirty) renderSide(); }).catch(() => {});
