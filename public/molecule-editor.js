import { projectId, scopedFetch as fetch, scopeUrl, workspacePageUrl } from './workspace-context.js';
// Bounded graph sketcher: drafts are typed edits, never synthetic SMILES.
import { bondLength, snappedEndpoint, nearestAtom, extendEndpoint, planRing, ringEdits } from './sketch-geometry.js';
import { modeSwitch } from './ui-mode.js';
import { annotationMetadata, requestSelectionAnnotation, savedSelectionReference, supportsSelectionAnnotations } from './host-selection-annotation.js';
import { emptySelection, normalizeSelection, singleSelection, toggleSelection, unionSelection, rectangleSelection, deletionEdits, selectionContext, localDraftContext, createSelectionPublisher } from './selection-context.js';
const NS = 'http://www.w3.org/2000/svg';
let receiveDocument = null;
// Optional host hook: feed the existing document refresh into the open editor.
// It never replaces its graph, selection, title or baseline.
export function updateMoleculeEditorDocument(document) { receiveDocument?.(document); }
const elements = { C: 6, N: 7, O: 8, S: 16, P: 15, F: 9, Cl: 17, Br: 35, I: 53, H: 1 };
const uid = prefix => `${prefix}_${crypto.randomUUID()}`;
const clone = value => structuredClone(value);
const hasStereo = data => !!data && ((data.atoms || []).some(atom => atom.cip || (atom.stereo && atom.stereo !== 'unspecified')) || (data.bonds || []).some(bond => (bond.stereo && bond.stereo !== 'unspecified') || bond.stereoAtoms?.length) || /\bCFG=[123]\b/.test(data.molblock || ''));
const deltaText = delta => delta ? `原子：新增 ${delta.addedAtoms?.length || 0} / 删除 ${delta.removedAtoms?.length || 0} / 修改 ${delta.changedAtoms?.length || 0}；键：新增 ${delta.addedBonds?.length || 0} / 删除 ${delta.removedBonds?.length || 0} / 修改 ${delta.changedBonds?.length || 0}；移动 ${delta.movedAtoms?.length || 0}。` : '结构校验通过';
const node = (tag, attrs = {}, ...children) => {
  const result = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) result.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in result) result[key] = value;
    else result.setAttribute(key, value);
  }
  result.append(...children); return result;
};
const svgNode = (tag, attrs = {}, text) => { const result = document.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs)) result.setAttribute(key, value); if (text !== undefined) result.textContent = text; return result; };
async function request(path, body) {
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || `请求失败 (${response.status})`); return result;
}
export function openMoleculeEditor({ object = null, revision, position = { x: 100, y: 100 }, onSaved, onImport }) {
  if (document.querySelector('.molecule-editor')) return;
  let baseObject = clone(object), baseRevision = revision;
  let graph = { atoms: clone(object?.data?.atoms || []), bonds: clone(object?.data?.bonds || []) };
  let batches = [], undone = [], selection = emptySelection(), selected = null, tool = 'bond', element = 6, order = 1, pointer = null, busy = false;
  let origin = { x: 450, y: 250 }, scale = 42, ringSize = 6, hoverPlan = null;
  let publication = { state: 'local' }, disposed = false;
  const publisher = createSelectionPublisher({ request, onStatus: next => { publication = next; if (!disposed) renderSelectionStatus(); } });
  let stereoRestricted = hasStereo(object?.data);
  if (stereoRestricted) tool = 'select';
  const dialog = node('dialog', { className: 'molecule-editor', 'aria-label': object ? '编辑分子结构' : '绘制分子' });
  const title = node('input', { value: object?.title || '新分子', maxLength: 240, 'aria-label': '分子标题' });
  const status = node('p', { className: 'editor-status', role: 'status' }, '直接绘制原子与键；保存后 agent 可读取具体变更。');
  const error = node('p', { className: 'editor-error', role: 'alert' });
  const toolbar = node('div', { className: 'editor-toolbar', role: 'toolbar', 'aria-label': '分子绘制工具' });
  const stage = svgNode('svg', { viewBox: '0 0 900 500', class: 'editor-stage', tabindex: '0', role: 'application', 'aria-label': '分子绘制区域：Shift 点选增减原子或键，选取工具拖动空白处框选' });
  const properties = node('div', { className: 'editor-properties' });
  const selectionStatus = node('p', { className: 'editor-selection-status', role: 'status', 'aria-live': 'polite' });
  let declinedReceipt = null;
  const manualReference = node('textarea', { hidden: true, readOnly: true, rows: 2, 'aria-label': '复制到对话的已保存选区引用' });
  const copyReference = node('button', { type: 'button', className: 'editor-copy-reference', hidden: true, onClick: copySelectionReference }, '复制选区引用');
  const menuCopyReference = node('button', { type: 'button', hidden: true, onClick: () => { closeMenus(); copySelectionReference(); } }, '复制选区引用');
  const askButton = node('button', { type: 'button', hidden: !supportsSelectionAnnotations(document), disabled: true,
    onClick: event => {
      if (busy || pointer || publication.state !== 'published') return;
      try {
        const accepted = requestSelectionAnnotation({ page: document, target: workspace, event, snapshot: annotationSnapshot() });
        if (accepted) { status.textContent = '请在宿主中检查批注，并随问题一起发送。'; return; }
      } catch { /* The desktop host can decline or throw when annotations are unavailable. */ }
      declinedReceipt = publication.published;
      renderSelectionStatus();
      if (!copyReference.hidden) copyReference.focus();
      status.textContent = '宿主未打开批注。可复制选区引用，粘贴到对话中提问。';
    } }, '在对话中提问');
  const preview = node('details', { className: 'editor-preview', hidden: true });
  const reference = node('details', { className: 'editor-reference editor-tool-menu', hidden: true });
  const stereoNotice = node('p', { className: 'editor-stereo-notice', hidden: !stereoRestricted }, '立体键仅在参照图完整显示；当前仅支持移动，不支持修改此结构的化学内容。');
  const hint = node('p', { className: 'editor-help' }, 'Shift 点选增减原子 / 键；选取工具拖动空白处框选，Shift 框选追加 · 键工具按标准键长 / 30° 吸附，Alt 自由拖动');
  const undoButton = node('button', { type: 'button', onClick: undo }, '撤销');
  const redoButton = node('button', { type: 'button', onClick: redo }, '重做');
  const validateButton = node('button', { type: 'button', onClick: () => submit(false) }, '校验 / 预览');
  const saveButton = node('button', { type: 'button', className: 'primary', onClick: () => submit(true) }, '保存结构');
  const closeButton = node('button', { type: 'button', onClick: close }, '取消');
  const copyButton = node('button', { type: 'button', onClick: copyDraft }, '导出草稿');
  const reloadButton = node('button', { type: 'button', onClick: reload }, '载入最新');
  const toolButtons = [];
  const toolButton = (label, mode, extra = {}) => {
    const button = node('button', { type: 'button', title: extra.title || label, onClick: () => { cancelGesture(); hoverPlan = null; tool = mode; if (extra.order) { order = extra.order; element = 6; } if (extra.element) element = extra.element; if (extra.size) ringSize = extra.size; closeMenus(); render(); stage.focus(); } }, label);
    toolButtons.push({ button, mode, ...extra }); toolbar.append(button); return button;
  };
  toolButton('↖ 选取 / 移动', 'select');
  for (const [symbol, number] of Object.entries(elements)) toolButton(symbol, 'atom', { element: number, title: `绘制 / 替换为 ${symbol}` });
  toolbar.append(node('span', { className: 'editor-separator' }));
  for (const [label, value] of [['— 单键', 1], ['═ 双键', 2], ['≡ 三键', 3]]) toolButton(label, 'bond', { order: value });
  toolButton('⌫ 擦除', 'erase'); toolButton('⬟ 五元环', 'ring', { size: 5 }); toolButton('⬡ 六元环', 'ring', { size: 6 }); toolButton('⌬ 苯环', 'benzene', { size: 6 });
  const secondary = node('div', { className: 'editor-secondary' }, undoButton, redoButton, node('button', { type: 'button', onClick: () => { fit(); render(); } }, '适应结构'), node('button', { type: 'button', onClick: () => zoom(1.2) }, '＋'), node('button', { type: 'button', onClick: () => zoom(1 / 1.2) }, '−'));
  if (!object && onImport) secondary.append(node('button', { type: 'button', onClick: () => { if (close()) onImport(); } }, '导入 SMILES / MOL…'));
  const details = node('details', { className: 'editor-details' }, node('summary', {}, '快捷键与当前范围'), node('p', {}, '空格：从选中原子继续碳链；C/N/O/S/P/F/H：直接替换选中原子；1/2/3：修改选中键或切换键工具；V 选取；E 擦除；Esc 取消当前拖动。Alt 暂时关闭成键吸附。Ctrl/Cmd+Z 撤销；Ctrl/Cmd+Shift+Z 重做；Delete 删除。环一次拼接可一步撤销，默认选空的一侧，可按住拖动翻转。不自动重排已有结构。尚无楔形键编辑，不能安全编辑时保留草稿并报告校验错误。'));
  const side = node('aside', { className: 'editor-side', 'aria-label': '选区属性与校验' }, properties, preview);
  const workspace = node('div', { className: 'editor-workspace' }, stage, side);
  const selectionBar = node('div', { className: 'editor-selection-bar' }, selectionStatus, askButton, copyReference);
  const baseline = node('p', { className: 'editor-id' });
  details.append(hint, baseline);
  dialog.append(node('div', { className: 'editor-heading' }, node('h2', {}, object ? '编辑结构' : '绘制分子'), title), toolbar, secondary, selectionBar, manualReference, stereoNotice, workspace, status, error, node('div', { className: 'editor-actions' }, closeButton, saveButton));
  dialog.querySelector('.editor-heading').append(modeSwitch());
  const moreElements = node('details', { className: 'editor-more-elements editor-tool-menu' }, node('summary', {}, '元素'));
  const elementItems = node('div', { className: 'editor-menu-items' });
  for (const entry of toolButtons.filter(entry => entry.mode === 'atom')) elementItems.append(entry.button);
  moreElements.append(elementItems); toolbar.insertBefore(moreElements, toolbar.querySelector('.editor-separator'));
  const rings = node('details', { className: 'editor-rings editor-tool-menu' }, node('summary', {}, '环'));
  rings.append(node('div', { className: 'editor-menu-items' }, ...toolButtons.filter(entry => ['ring', 'benzene'].includes(entry.mode)).map(entry => entry.button)));
  toolbar.insertBefore(rings, toolButtons.find(entry => entry.mode === 'erase').button);
  toolbar.querySelector('.editor-separator').remove();
  const viewMenu = node('details', { className: 'editor-view editor-tool-menu' }, node('summary', {}, '视图'));
  viewMenu.append(node('div', { className: 'editor-menu-items' }, ...[...secondary.querySelectorAll('button')].filter(button => ![undoButton, redoButton].includes(button) && !button.textContent.includes('导入'))));
  secondary.append(viewMenu, reference, details);
  const moreActions = node('details', { className: 'editor-more-actions editor-tool-menu' }, node('summary', {}, '更多'));
  const actionItems = node('div', { className: 'editor-menu-items' }, menuCopyReference, validateButton, copyButton, reloadButton);
  const importButton = [...secondary.querySelectorAll('button')].find(button => button.textContent.includes('导入'));
  if (importButton) actionItems.append(importButton);
  moreActions.append(actionItems); dialog.querySelector('.editor-actions').prepend(moreActions);
  validateButton.title = '单独校验并查看预览；保存时也会执行相同校验';
  saveButton.title = '校验结构并保存到共享文档';
  const menus = [moreElements, rings, viewMenu, reference, moreActions];
  function closeMenus(except) { for (const menu of menus) if (menu !== except) menu.open = false; }
  for (const menu of menus) menu.addEventListener('toggle', () => { if (menu.open) closeMenus(menu); });
  dialog.addEventListener('pointerdown', event => { if (!event.target.closest('.editor-tool-menu')) closeMenus(); });
  function updateWorkspace() {
    side.hidden = properties.hidden && preview.hidden;
    workspace.classList.toggle('has-side', !side.hidden);
  }
  document.body.append(dialog);
  function edits() { return batches.flatMap(batch => batch.edits); }
  function transact(changes) {
    if (busy || !changes.length) return;
    hoverPlan = null;
    if (stereoRestricted && changes.some(edit => edit.type !== 'moveAtom')) { error.textContent = '此结构含立体信息，当前只支持移动原子；未修改化学内容。'; return; }
    if (edits().length + changes.length > 500) { error.textContent = '本次最多提交 500 项图编辑，请先保存后继续。'; return; }
    const before = clone(graph), selectionBefore = clone(selection);
    for (const edit of changes) {
      if (edit.type === 'addAtom') graph.atoms.push(clone(edit.atom));
      else if (edit.type === 'updateAtom') Object.assign(graph.atoms.find(atom => atom.id === edit.id), edit.patch);
      else if (edit.type === 'moveAtom') Object.assign(graph.atoms.find(atom => atom.id === edit.id), { x: edit.x, y: edit.y });
      else if (edit.type === 'deleteAtom') { graph.atoms = graph.atoms.filter(atom => atom.id !== edit.id); graph.bonds = graph.bonds.filter(bond => bond.from !== edit.id && bond.to !== edit.id); }
      else if (edit.type === 'addBond') graph.bonds.push(clone(edit.bond));
      else if (edit.type === 'updateBond') Object.assign(graph.bonds.find(bond => bond.id === edit.id), edit.patch);
      else if (edit.type === 'deleteBond') graph.bonds = graph.bonds.filter(bond => bond.id !== edit.id);
    }
    batches.push({ edits: clone(changes), before, after: clone(graph), selectionBefore }); undone = []; setSelection(selection); error.textContent = ''; preview.replaceChildren(); render(); return true;
  }
  function undo() { if (busy || !batches.length) return; cancelGesture(); hoverPlan = null; const batch = batches.pop(); batch.selectionAfter = clone(selection); graph = clone(batch.before); undone.push(batch); setSelection(batch.selectionBefore); error.textContent = ''; preview.replaceChildren(); render(); stage.focus(); }
  function redo() { if (busy || !undone.length) return; cancelGesture(); hoverPlan = null; const batch = undone.pop(); graph = clone(batch.after); batches.push(batch); setSelection(batch.selectionAfter); error.textContent = ''; preview.replaceChildren(); render(); stage.focus(); }
  function fit() {
    if (pointer) cancelGesture();
    if (!graph.atoms.length) { scale = 42; origin = { x: 450, y: 250 }; return; }
    const xs = graph.atoms.map(a => a.x || 0), ys = graph.atoms.map(a => a.y || 0);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const width = stage.clientWidth || 900, height = stage.clientHeight || 500;
    scale = Math.max(8, Math.min(48, Math.max(100, width - 100) / Math.max(3, maxX - minX), Math.max(80, height - 80) / Math.max(3, maxY - minY)));
    origin = { x: 450 - (minX + maxX) * scale / 2, y: 250 + (minY + maxY) * scale / 2 };
  }
  const screen = atom => ({ x: origin.x + (atom.x || 0) * scale, y: origin.y - (atom.y || 0) * scale });
  function point(event) { const matrix = stage.getScreenCTM(); const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()); return { x: (p.x - origin.x) / scale, y: (origin.y - p.y) / scale }; }
  function hitRadius() { return 12 / (Math.abs(stage.getScreenCTM()?.a || 1) * scale); }
  function nearest(p, exclude) { return nearestAtom(graph, p, Math.min(bondLength(graph) * .4, hitRadius()), exclude); }
  function zoom(factor) { if (pointer) return; const next = Math.max(8, Math.min(120, scale * factor)); origin = { x: 450 - (450 - origin.x) * next / scale, y: 250 - (250 - origin.y) * next / scale }; scale = next; render(); }
  function render() {
    preview.hidden = !!pointer || !preview.childElementCount;
    stage.replaceChildren();
    if (!graph.atoms.length) stage.append(svgNode('text', { x: 450, y: 230, class: 'editor-empty', 'text-anchor': 'middle' }, '选元素后点击，或拖出第一根键；也可直接放置环'));
    for (const bond of graph.bonds) {
      const from = graph.atoms.find(atom => atom.id === bond.from), to = graph.atoms.find(atom => atom.id === bond.to); if (!from || !to) continue;
      const a = screen(from), b = screen(to), dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const group = svgNode('g', { 'data-bond': bond.id, class: selection.bondIds.includes(bond.id) ? 'editor-bond selected' : 'editor-bond', 'aria-label': `键 ${bond.id}${selection.bondIds.includes(bond.id) ? '，已选中' : ''}` });
      const count = Math.min(3, Math.max(1, Math.round(bond.order || 1)));
      for (let n = 0; n < count; n++) { const offset = (n - (count - 1) / 2) * 5; group.append(svgNode('line', { x1: a.x - dy / len * offset, y1: a.y + dx / len * offset, x2: b.x - dy / len * offset, y2: b.y + dx / len * offset, class: 'editor-bond-line' })); }
      group.append(svgNode('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'editor-bond-hit' })); stage.append(group);
    }
    for (const atom of graph.atoms) {
      const p = screen(atom), isSelected = selection.atomIds.includes(atom.id);
      const group = svgNode('g', { 'data-atom': atom.id, class: `editor-atom${isSelected ? ' selected' : ''}`, 'aria-label': `原子 ${atom.id}${isSelected ? '，已选中' : ''}` });
      group.append(svgNode('circle', { cx: p.x, cy: p.y, r: 14, class: 'editor-atom-hit' }));
      const symbol = Object.keys(elements).find(key => elements[key] === atom.atomicNumber) || `#${atom.atomicNumber}`;
      const charge = atom.formalCharge ?? atom.charge ?? 0;
      const showLabel = atom.atomicNumber !== 6 || isSelected || charge || atom.isotope || !graph.bonds.some(bond => bond.from === atom.id || bond.to === atom.id);
      if (showLabel) {
        group.append(svgNode('circle', { cx: p.x, cy: p.y, r: symbol.length > 1 ? 11 : 8, class: 'editor-atom-background' }));
        group.append(svgNode('text', { x: p.x, y: p.y + 5, 'text-anchor': 'middle', class: `editor-element element-${atom.atomicNumber}` }, symbol));
      }
      if (charge) group.append(svgNode('text', { x: p.x + 11, y: p.y - 8, class: 'editor-charge' }, `${Math.abs(charge) === 1 ? '' : Math.abs(charge)}${charge > 0 ? '+' : '−'}`));
      if (atom.isotope) group.append(svgNode('text', { x: p.x - 15, y: p.y - 8, class: 'editor-charge' }, atom.isotope));
      stage.append(group);
    }
    for (const entry of toolButtons) { entry.button.disabled = busy || (stereoRestricted && entry.mode !== 'select'); entry.button.setAttribute('aria-pressed', String(tool === entry.mode && (!entry.order || order === entry.order) && (!entry.element || element === entry.element) && (!entry.size || ringSize === entry.size))); }
    undoButton.disabled = busy || !batches.length; redoButton.disabled = busy || !undone.length;
    status.textContent = `${hasDraft() ? '未保存' : baseObject ? '已保存结构' : '新分子'} · ${graph.atoms.length} 个原子 · ${graph.bonds.length} 条键${hasDraft() ? ' · 保存时自动校验' : ''}`;
    baseline.textContent = `${baseObject ? `文档 r${baseRevision} / 对象 v${baseObject.version} / ${baseObject.id}` : '新分子草稿'} · ${edits().length} 项图编辑`;
    moreElements.querySelector('summary').textContent = tool === 'atom' ? `元素 · ${Object.keys(elements).find(key => elements[key] === element)}` : '元素';
    rings.querySelector('summary').textContent = ['ring', 'benzene'].includes(tool) ? (tool === 'benzene' ? '环 · 苯环' : `环 · ${ringSize} 元`) : '环';
    moreElements.dataset.active = String(tool === 'atom'); rings.dataset.active = String(['ring', 'benzene'].includes(tool));
    renderProperties();
    renderSelectionStatus();
    if (hoverPlan) drawRingGuide(hoverPlan);
    if (pointer?.mode === 'marquee') drawMarquee();
  }
  function setSelection(next, publish = true) {
    selection = normalizeSelection(next, graph); selected = singleSelection(selection);
    if (publish) syncSelection();
  }
  function choose(kind, id, additive = false) {
    setSelection(id ? (additive ? toggleSelection(selection, kind, id) : { ...emptySelection(), [kind === 'atom' ? 'atomIds' : 'bondIds']: [id] }) : emptySelection());
    renderProperties();
  }
  function context() { return selectionContext({ object: baseObject, revision: baseRevision, graph, selection, edits: edits(), title: title.value, gesture: pointer?.mode === 'select' && pointer.moved }); }
  function annotationSnapshot() { return { projectId, context: context(), published: publication.published, document: publication.document }; }
  function currentReference() {
    return !busy && !pointer && publication.state === 'published' ? savedSelectionReference(annotationSnapshot()) : null;
  }
  async function copySelectionReference() {
    const reference = currentReference();
    if (!reference) return;
    const receipt = publication.published;
    const text = 'Chem Canvas 已保存选区\n' + JSON.stringify(reference);
    try {
      await navigator.clipboard.writeText(text);
      if (!disposed && publication.published === receipt) status.textContent = '选区引用已复制。请粘贴到对话并输入问题。';
    } catch {
      if (disposed || publication.published !== receipt || !currentReference()) return;
      manualReference.value = text;
      manualReference.hidden = false;
      manualReference.focus();
      manualReference.select();
      status.textContent = '请复制已选中的引用文本，粘贴到对话中。';
    }
  }
  function syncSelection() {
    publication = { state: 'checking' }; renderSelectionStatus(); publisher.publish(context());
  }
  function renderSelectionStatus() {
    const current = context(), count = `选中 ${selection.atomIds.length} 个原子 · ${selection.bondIds.length} 条键`;
    let message = current.saved ? '正在核对共享选区' : '本地草稿，Agent 只能读取已保存内容';
    if (!baseObject && !current.saved) message = '本地草稿，保存后 Agent 才可读取';
    if (publication.state === 'published' && current.saved) message = '选区已共享，Agent 可读取';
    if (publication.state === 'stale') message = '基线已过期，未发布片段；可导出草稿或载入最新';
    if (publication.state === 'error') message = `选区同步失败，共享状态未确认：${publication.message}`;
    if (pointer?.mode === 'marquee') message = '正在框选，松开鼠标后核对并同步；Esc 取消';
    selectionStatus.dataset.state = publication.state === 'stale' || publication.state === 'error' ? publication.state : current.state;
    const hasSelection = selection.atomIds.length || selection.bondIds.length;
    selectionStatus.textContent = `${hasSelection ? count + ' · ' : ''}${message}`;
    selectionStatus.hidden = !hasSelection && !hasDraft() && !['stale', 'error'].includes(publication.state);
    const reference = currentReference();
    const canAttach = reference && supportsSelectionAnnotations(document) && declinedReceipt !== publication.published && annotationMetadata(reference);
    askButton.hidden = !canAttach;
    askButton.disabled = !canAttach;
    copyReference.hidden = !reference || !!canAttach;
    menuCopyReference.hidden = !canAttach;
    if (!reference) {
      manualReference.hidden = true;
      manualReference.value = '';
    }
  }
  function renderProperties() {
    const focusedLabel = properties.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
    const selectionKey = JSON.stringify(selection);
    const expanded = properties.dataset.selectionKey === selectionKey ? [...properties.querySelectorAll('details[open]')].map(item => item.dataset.detail) : [];
    properties.dataset.selectionKey = selectionKey;
    properties.hidden = !selection.atomIds.length && !selection.bondIds.length;
    properties.replaceChildren(node('h3', {}, '选中内容'));
    const atom = selected?.kind === 'atom' && graph.atoms.find(a => a.id === selected.id);
    const bond = selected?.kind === 'bond' && graph.bonds.find(b => b.id === selected.id);
    if (atom) {
      const select = node('select', { 'aria-label': '选中原子的元素', disabled: busy || stereoRestricted });
      for (const [symbol, number] of Object.entries(elements)) select.append(node('option', { value: number, selected: atom.atomicNumber === number }, symbol));
      if (!Object.values(elements).includes(atom.atomicNumber)) select.append(node('option', { value: atom.atomicNumber, selected: true }, `原子序数 ${atom.atomicNumber}`));
      select.addEventListener('change', () => transact([{ type: 'updateAtom', id: atom.id, patch: { atomicNumber: Number(select.value) } }]));
      const charge = node('input', { type: 'number', min: -8, max: 8, step: 1, value: atom.formalCharge ?? atom.charge ?? 0, 'aria-label': '形式电荷', disabled: busy || stereoRestricted });
      charge.addEventListener('change', () => { if (charge.checkValidity() && charge.value !== '') transact([{ type: 'updateAtom', id: atom.id, patch: { formalCharge: Number(charge.value) } }]); });
      properties.append(node('label', {}, '元素', select), node('details', { 'data-detail': 'charge' }, node('summary', {}, `形式电荷${atom.formalCharge || atom.charge ? ` · ${atom.formalCharge ?? atom.charge}` : ''}`), node('label', {}, '形式电荷', charge)));
    } else if (bond) {
      properties.append(node('p', {}, `当前键级：${bond.order}${bond.aromatic ? '（芳香键）' : ''}`));
      for (const n of [1, 2, 3]) properties.append(node('button', { type: 'button', disabled: busy || stereoRestricted, onClick: () => transact([{ type: 'updateBond', id: bond.id, patch: { order: n } }]) }, `${n} 键`));
    } else if (selection.atomIds.length + selection.bondIds.length > 1) {
      properties.append(node('p', {}, `片段：${selection.atomIds.length} 个原子、${selection.bondIds.length} 条键`));
    }
    if (selection.atomIds.length || selection.bondIds.length) properties.append(node('button', { type: 'button', disabled: busy || stereoRestricted, onClick: eraseSelected }, '删除选中内容'));
    properties.append(node('details', { 'data-detail': 'ids' }, node('summary', {}, '选区 ID 与版本'), node('p', { className: 'editor-selection-ids' }, `r${baseRevision} / v${baseObject?.version ?? '未保存'}\n原子：${selection.atomIds.join('\n')}\n键：${selection.bondIds.join('\n')}`)));
    for (const item of properties.querySelectorAll('details')) item.open = expanded.includes(item.dataset.detail);
    updateWorkspace();
    if (focusedLabel) [...properties.querySelectorAll('[aria-label]')].find(control => control.getAttribute('aria-label') === focusedLabel)?.focus();
  }
  function eraseSelected() { if (transact(deletionEdits(selection, graph))) { render(); stage.focus(); } }
  function addAtom(p, number = element) { return { type: 'addAtom', atom: { id: uid('atom'), atomicNumber: number, x: p.x, y: p.y, formalCharge: 0, isotope: 0 } }; }
  function ringPlan(p, atomId, bondId, sidePoint) { return planRing(graph, { size: ringSize, aromatic: tool === 'benzene', point: p, anchorAtomId: atomId, anchorBondId: bondId, sidePoint }); }
  function drawRingGuide(plan) {
    stage.querySelectorAll('.editor-ghost').forEach(n => n.remove());
    const group = svgNode('g', { class: `editor-ghost${plan.collision ? ' invalid' : ''}` });
    for (const e of plan.edges) {
      if (e.id) continue;
      const a = screen(plan.vertices[e.from]), b = screen(plan.vertices[e.to]);
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
      for (let n = 0; n < e.order; n++) { const offset = (n - (e.order - 1) / 2) * 5; group.append(svgNode('line', { x1: a.x - dy / length * offset, y1: a.y + dx / length * offset, x2: b.x - dy / length * offset, y2: b.y + dx / length * offset, class: 'editor-guide' })); }
    }
    stage.append(group);
  }
  function bondTarget(current, p, free, moved) {
    const start = current.original || current.start;
    const direct = moved && nearest(p, current.atomId);
    if (direct) return { point: direct, target: direct };
    const end = moved ? snappedEndpoint(start, p, bondLength(graph), free) : extendEndpoint(graph, graph.atoms.find(a => a.id === current.atomId), bondLength(graph), order);
    const target = nearest(end, current.atomId);
    return { point: target || end, target };
  }
  function extendBond(current, p, free, moved) {
    const destination = bondTarget(current, p, free, moved);
    const changes = [], fromAddition = current.atomId ? null : addAtom(current.start, 6), fromId = current.atomId || fromAddition.atom.id;
    if (fromAddition) changes.push(fromAddition);
    const toAddition = destination.target ? null : addAtom(destination.point, 6), toId = destination.target?.id || toAddition.atom.id;
    if (toAddition) changes.push(toAddition);
    if (Math.hypot(destination.point.x - current.start.x, destination.point.y - current.start.y) < .15) return;
    const existing = graph.bonds.find(b => (b.from === fromId && b.to === toId) || (b.to === fromId && b.from === toId));
    changes.push(existing ? { type: 'updateBond', id: existing.id, patch: { order } } : { type: 'addBond', bond: { id: uid('bond'), from: fromId, to: toId, order } });
    if (transact(changes)) choose('atom', toId); render();
  }
  stage.addEventListener('pointerdown', event => {
    if (busy || pointer || event.button !== 0) return; event.preventDefault(); stage.focus();
    const atomId = event.target.closest('[data-atom]')?.getAttribute('data-atom'), bondId = event.target.closest('[data-bond]')?.getAttribute('data-bond');
    const p = point(event), atom = graph.atoms.find(a => a.id === atomId);
    // Shift always selects, including while drawing: it must never create an edit.
    if (event.shiftKey && (atomId || bondId)) { choose(atomId ? 'atom' : 'bond', atomId || bondId, true); render(); return; }
    if (!atomId && !bondId && (tool === 'select' || event.shiftKey)) {
      pointer = { id: event.pointerId, mode: 'marquee', start: p, end: p, additive: event.shiftKey, selectionBefore: clone(selection), clientX: event.clientX, clientY: event.clientY };
      stage.setPointerCapture(event.pointerId); render(); return;
    }
    if (tool === 'erase') { if (atomId || bondId) { choose(atomId ? 'atom' : 'bond', atomId || bondId); eraseSelected(); } return; }
    if (tool === 'ring' || tool === 'benzene') {
      pointer = { id: event.pointerId, start: p, atomId, bondId, mode: tool };
      hoverPlan = ringPlan(p, atomId, bondId); stage.setPointerCapture(event.pointerId); render(); return;
    }
    if (tool === 'atom') { if (atomId) { choose('atom', atomId); transact([{ type: 'updateAtom', id: atomId, patch: { atomicNumber: element } }]); } else if (!bondId) { const edit = addAtom(p); transact([edit]); choose('atom', edit.atom.id); render(); } return; }
    if (bondId) { choose('bond', bondId); if (tool === 'bond') transact([{ type: 'updateBond', id: bondId, patch: { order } }]); else render(); return; }
    choose('atom', atomId); pointer = { id: event.pointerId, start: atom || p, atomId, original: atom ? { x: atom.x, y: atom.y } : null, clientX: event.clientX, clientY: event.clientY, mode: tool };
    stage.setPointerCapture(event.pointerId); render();
  });
  stage.addEventListener('pointermove', event => {
    if (busy) return;
    const p = point(event);
    if (!pointer) {
      if (tool === 'ring' || tool === 'benzene') {
        hoverPlan = ringPlan(p, event.target.closest('[data-atom]')?.getAttribute('data-atom'), event.target.closest('[data-bond]')?.getAttribute('data-bond')); drawRingGuide(hoverPlan);
      }
      return;
    }
    if (pointer.id !== event.pointerId) return;
    if (pointer.mode === 'ring' || pointer.mode === 'benzene') { hoverPlan = ringPlan(pointer.start, pointer.atomId, pointer.bondId, p); drawRingGuide(hoverPlan); return; }
    if (pointer.mode === 'marquee') {
      pointer.end = p;
      const enclosed = rectangleSelection(graph, pointer.start, p);
      setSelection(pointer.additive ? unionSelection(pointer.selectionBefore, enclosed) : enclosed, false); render(); return;
    }
    if (pointer.mode === 'select' && pointer.atomId) {
      if (Math.hypot(event.clientX - pointer.clientX, event.clientY - pointer.clientY) <= 4 && !pointer.moved) return;
      const started = !pointer.moved; pointer.moved = true;
      const atom = graph.atoms.find(a => a.id === pointer.atomId); atom.x = p.x; atom.y = p.y;
      if (started) syncSelection(); render();
    }
    else if (pointer.mode === 'bond') {
      stage.querySelectorAll('.editor-ghost').forEach(n => n.remove());
      const moved = Math.hypot(event.clientX - pointer.clientX, event.clientY - pointer.clientY) > 4;
      if (!moved && !pointer.atomId) return;
      const dest = bondTarget(pointer, p, event.altKey, moved), a = screen(pointer.original || pointer.start), b = screen(dest.point);
      const ghost = svgNode('g', { class: 'editor-ghost' }, undefined);
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
      for (let n = 0; n < order; n++) { const offset = (n - (order - 1) / 2) * 5; ghost.append(svgNode('line', { x1: a.x - dy / length * offset, y1: a.y + dx / length * offset, x2: b.x - dy / length * offset, y2: b.y + dx / length * offset, class: 'editor-guide' })); }
      ghost.append(svgNode('circle', { cx: b.x, cy: b.y, r: dest.target ? 15 : 5, class: 'editor-snap-target' })); stage.append(ghost);
    }
  });
  function finishPointer(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (event.type === 'pointercancel') { cancelGesture(); return; }
    const current = pointer, p = point(event); pointer = null;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (current.mode === 'marquee') {
      const moved = Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) > 4;
      const enclosed = moved ? rectangleSelection(graph, current.start, p) : emptySelection();
      setSelection(current.additive ? unionSelection(current.selectionBefore, enclosed) : enclosed); render(); return;
    }
    if (current.mode === 'ring' || current.mode === 'benzene') {
      const plan = hoverPlan; hoverPlan = null;
      if (event.type !== 'pointercancel') { try { transact(ringEdits(plan, uid)); } catch (failure) { error.textContent = failure.message; } }
      render(); return;
    }
    const moved = Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) > 4;
    if (current.mode === 'select' && current.atomId) {
      Object.assign(graph.atoms.find(a => a.id === current.atomId), current.original);
      if (moved && event.type !== 'pointercancel') transact([{ type: 'moveAtom', id: current.atomId, x: p.x, y: p.y }]);
      else if (current.moved) syncSelection();
    } else if (current.mode === 'bond' && event.type !== 'pointercancel') {
      if (moved || current.atomId) extendBond(current, p, event.altKey, moved);
      else { const addition = addAtom(p, 6); if (transact([addition])) choose('atom', addition.atom.id); }
    }
    render();
  }
  stage.addEventListener('pointerup', finishPointer); stage.addEventListener('pointercancel', finishPointer);
  function cancelGesture() {
    if (!pointer && !hoverPlan) return;
    const current = pointer; pointer = null; hoverPlan = null;
    if (current?.original && current.mode === 'select') {
      const atom = graph.atoms.find(a => a.id === current.atomId); if (atom) Object.assign(atom, current.original);
    }
    if (current?.mode === 'marquee') setSelection(current.selectionBefore, false);
    if (current && stage.hasPointerCapture(current.id)) stage.releasePointerCapture(current.id);
    if (current?.moved || current?.mode === 'marquee') syncSelection();
    render();
  }
  function drawMarquee() {
    const a = screen(pointer.start), b = screen(pointer.end);
    stage.append(svgNode('rect', { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y), class: 'editor-selection-box' }));
  }
  stage.addEventListener('lostpointercapture', () => { if (pointer) cancelGesture(); });
  window.addEventListener('blur', cancelGesture);
  stage.addEventListener('pointerleave', () => { if (!pointer) { hoverPlan = null; stage.querySelectorAll('.editor-ghost').forEach(n => n.remove()); } });
  stage.addEventListener('wheel', event => { event.preventDefault(); zoom(Math.exp(-event.deltaY * .001)); }, { passive: false });
  dialog.addEventListener('keydown', event => {
    if (busy || event.isComposing) return;
    if (event.key === 'Escape' && menus.some(menu => menu.open)) { event.preventDefault(); event.stopPropagation(); closeMenus(); stage.focus(); return; }
    if (event.key === 'Escape' && (pointer || hoverPlan)) {
      event.preventDefault(); event.stopPropagation(); cancelGesture(); return;
    }
    // Native button Space/Enter and form editing must never also edit the graph.
    if (pointer || event.target !== stage || event.repeat) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    hoverPlan = null;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); eraseSelected(); }
    else if (['1', '2', '3'].includes(event.key) && !stereoRestricted) { tool = 'bond'; order = Number(event.key); element = 6; if (selected?.kind === 'bond') transact([{ type: 'updateBond', id: selected.id, patch: { order } }]); render(); }
    else if (event.code === 'Space' && selected?.kind === 'atom' && !stereoRestricted) {
      event.preventDefault(); const atom = graph.atoms.find(a => a.id === selected.id); if (!atom) return; tool = 'bond'; order = 1;
      extendBond({ atomId: atom.id, start: atom, original: atom }, atom, false, false);
    }
    else if (!event.ctrlKey && !event.metaKey && ['c', 'n', 'o', 's', 'p', 'f', 'h'].includes(event.key.toLowerCase()) && !stereoRestricted) {
      element = elements[event.key.toUpperCase()];
      if (selected?.kind === 'atom') transact([{ type: 'updateAtom', id: selected.id, patch: { atomicNumber: element } }]);
      else tool = 'atom'; render();
    }
    else if (event.key.toLowerCase() === 'v') { tool = 'select'; render(); }
    else if (event.key.toLowerCase() === 'e' && !stereoRestricted) { tool = 'erase'; render(); }
  });
  async function submit(save) {
    if (busy || pointer) return;
    closeMenus();
    if (!graph.atoms.length) { error.textContent = '请先绘制至少一个原子。删除整个分子请使用画布中的删除对象。'; return; }
    if (!title.value.trim()) { error.textContent = '请填写分子标题。'; return; }
    if (!edits().length) { error.textContent = '结构尚未修改。请先绘制或编辑原子、键；无需修改时可直接取消。'; return; }
    busy = true; error.textContent = ''; setBusy();
    const payload = { ...(baseObject ? { objectId: baseObject.id, expectedObjectVersion: baseObject.version } : {}), edits: edits() };
    try {
      const result = await request(save ? '/api/molecules/edit' : '/api/chemistry/edit-preview', save ? { ...payload, operationId: uid('op'), expectedRevision: baseRevision, actor: 'human', title: title.value.trim(), ...position } : payload);
      if (save) { const saved = baseObject ? result.document.objects[baseObject.id] : Object.values(result.document.objects).filter(item => item.kind === 'molecule').at(-1); onSaved?.(result.document, saved?.id); dispose(true); }
      else { preview.replaceChildren(node('summary', {}, '校验预览')); if (result.molecule?.svg) preview.append(node('img', { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.molecule.svg)}`, alt: 'RDKit 校验后的结构预览' })); preview.append(node('details', {}, node('summary', {}, '变更与校验信息'), node('p', {}, deltaText(result.delta)), node('p', { className: 'editor-id' }, result.molecule?.smiles || ''), node('p', {}, (result.molecule?.warnings || []).join('\n')))); preview.hidden = false; preview.open = true; reference.open = false; status.textContent = '校验通过 · 尚未保存'; }
    } catch (failure) { error.textContent = `未保存：${failure.message}。草稿已保留；可从「更多」导出草稿，或载入最新。`; }
    finally { busy = false; setBusy(); }
  }
  function setBusy() { for (const control of dialog.querySelectorAll('button,input,select')) control.disabled = busy; for (const entry of toolButtons) entry.button.disabled = busy || (stereoRestricted && entry.mode !== 'select'); undoButton.disabled = busy || !batches.length; redoButton.disabled = busy || !undone.length; stage.classList.toggle('busy', busy); renderProperties(); renderSelectionStatus(); }
  function copyDraft() { const blob = new Blob([JSON.stringify({ ...localDraftContext({ object: baseObject, revision: baseRevision, title: title.value, graph, selection, edits: edits() }), objectId: baseObject?.id, expectedObjectVersion: baseObject?.version, expectedRevision: baseRevision }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); node('a', { href: url, download: 'molecule-draft.json' }).click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  async function reload() {
    if (busy || (hasDraft() && !window.confirm('载入最新结构将放弃本地绘图草稿。请先导出需要保留的草稿。继续？'))) return;
    cancelGesture(); busy = true; setBusy();
    try { const result = await request('/api/document'); const latest = baseObject ? result.document.objects[baseObject.id] : null; if (baseObject && !latest) throw new Error('对象已删除，请导出草稿后另建分子'); baseObject = clone(latest); baseRevision = result.document.revision; graph = { atoms: clone(latest?.data?.atoms || []), bonds: clone(latest?.data?.bonds || []) }; title.value = latest?.title || '新分子'; batches = []; undone = []; setSelection(emptySelection()); stereoRestricted = hasStereo(latest?.data); if (stereoRestricted) tool = 'select'; renderReference(); preview.replaceChildren(); error.textContent = ''; fit(); render(); } catch (failure) { error.textContent = failure.message; }
    finally { busy = false; setBusy(); stage.focus(); }
  }
  function hasDraft() { return batches.length > 0 || title.value !== (baseObject?.title || '新分子'); }
  function beforeUnload(event) { if (hasDraft() || busy) { event.preventDefault(); event.returnValue = ''; } }
  function dispose(saved = false) { disposed = true; receiveDocument = null; viewportObserver.disconnect(); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('blur', cancelGesture); if (saved) publisher.cancel(); else publisher.publish(null); dialog.close(); dialog.remove(); }
  function close() { if (busy) return false; cancelGesture(); if (hasDraft() && !window.confirm('放弃未保存的分子绘图？')) return false; dispose(); return true; }
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (pointer || hoverPlan) cancelGesture(); else close(); }); window.addEventListener('beforeunload', beforeUnload);
  function renderReference() {
    stereoNotice.hidden = !stereoRestricted; reference.replaceChildren(); reference.hidden = !baseObject;
    if (!baseObject) return;
    const image = node('img', { src: scopeUrl(`/api/depictions/${encodeURIComponent(baseObject.id)}.svg?style=acs1996&version=${baseObject.version}`), alt: '已保存结构的 ACS1996 参照图' });
    image.addEventListener('error', () => { if (baseObject.data.svg) image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(baseObject.data.svg)}`; }, { once: true });
    reference.append(node('summary', {}, '已保存原图'), node('div', { className: 'editor-menu-items' }, image));
    reference.open = stereoRestricted;
  }
  title.addEventListener('input', () => { syncSelection(); render(); });
  receiveDocument = next => {
    if (!next || disposed || next.revision === baseRevision) return;
    if (publication.state !== 'stale') { publisher.publish(context()); publication = { state: 'stale' }; renderSelectionStatus(); }
  };
  // Keep molecular hit targets readable on phones instead of shrinking a fixed
  // 900-unit drawing to 350 CSS pixels. Resizing only changes the view, not edits.
  function resizeViewport() {
    const width = stage.clientWidth, height = stage.clientHeight;
    if (width && height) stage.setAttribute('viewBox', `${450 - width / 2} ${250 - height / 2} ${width} ${height}`);
  }
  const viewportObserver = new ResizeObserver(resizeViewport);
  renderReference(); render(); dialog.showModal(); resizeViewport(); fit(); render(); viewportObserver.observe(stage); stage.focus(); syncSelection();
}
