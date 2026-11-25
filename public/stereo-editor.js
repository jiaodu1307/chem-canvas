import { scopedFetch as fetch, scopeUrl, workspacePageUrl } from './workspace-context.js';
// Only saved stable IDs enter this dialog. Preview and commit share the same guarded API.
const node = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in n) n[k] = v; else n.setAttribute(k, v);
  }
  n.append(...children); return n;
};
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const p = await r.json(); if (!r.ok) throw new Error(`${p.error?.message || '操作失败'}${p.error?.reason ? ` (${p.error.reason})` : ''}`); return p;
}
export async function openStereoEditor({ objectId, onSaved }) {
  if (document.querySelector('.stereo-editor-dialog')) return;
  let info, candidate = null, edits, busy = false, request = null;
  const target = node('select', { 'aria-label': '立体构型目标', onChange: configure });
  const action = node('select', { 'aria-label': '目标构型', onChange: invalidate });
  const before = node('div', { className: 'stereo-picture', 'aria-label': '当前已保存结构' });
  const after = node('img', { alt: '立体构型候选预览', hidden: true });
  const status = node('p', { role: 'status' }), error = node('p', { role: 'alert', className: 'error-text' });
  const preview = node('button', { type: 'button', disabled: true, onClick: previewEdit }, '预览立体构型');
  const save = node('button', { type: 'button', className: 'primary', disabled: true, onClick: commit }, '保存立体构型');
  const reload = node('button', { type: 'button', onClick: load }, '重新读取已保存结构');
  const close = node('button', { type: 'button', onClick: () => { if (!busy) { dialog.close(); dialog.remove(); } } }, '关闭');
  const dialog = node('dialog', { className: 'stereo-editor-dialog', 'aria-label': '立体构型编辑' }, node('h2', {}, '立体构型'),
    node('p', {}, '选择中心或双键，预览后保存。R/S 当前支持普通中性碳和硅；E/Z 支持已有构型的普通非环碳碳双键。'),
    node('label', {}, '编辑目标', target), node('label', {}, '目标构型', action), preview,
    node('div', { className: 'stereo-comparison' }, node('section', {}, node('h3', {}, '当前已保存'), before), node('section', {}, node('h3', {}, '未保存预览'), after)),
    status, error, node('div', { className: 'local-depiction-actions' }, reload, close, save));
  dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); else dialog.remove(); });
  document.body.append(dialog); dialog.showModal(); await load();
  function lock(value) { busy = value; for (const control of [target, action, preview, reload, close]) control.disabled = value || !info; preview.disabled ||= !target.value; }
  function invalidate() { candidate = null; request = null; save.disabled = true; after.hidden = true; status.textContent = '尚未保存；请预览。'; error.textContent = ''; }
  function draw() {
    const root = new DOMParser().parseFromString(info.svg, 'image/svg+xml').documentElement;
    if (root.localName !== 'svg') throw new Error('结构图无效');
    const allowed = new Set(['svg', 'g', 'path', 'rect', 'line', 'polygon', 'polyline', 'circle', 'ellipse', 'text', 'tspan', 'defs', 'clipPath']);
    for (const e of [root, ...root.querySelectorAll('*')]) {
      if (!allowed.has(e.localName)) { e.remove(); continue; }
      for (const a of [...e.attributes]) if (/^on|href/i.test(a.name) || /url\(|javascript:/i.test(a.value)) e.removeAttribute(a.name);
    }
    const picked = [...info.atoms, ...info.bonds].find(v => v.id === target.value);
    const cls = info.atoms.includes(picked) ? 'atom' : 'bond';
    if (picked) for (const e of root.querySelectorAll(`[class~="${cls}-${picked.index}"]`)) e.classList.add('local-picked');
    root.removeAttribute('width'); root.removeAttribute('height');
    before.replaceChildren(document.importNode(root, true));
  }
  function configure() {
    invalidate(); action.replaceChildren();
    const atom = info?.atoms.find(a => a.id === target.value);
    if (atom) {
      if (['R', 'S'].includes(atom.cip)) action.append(node('option', { value: 'invert' }, `反转 ${atom.cip} → ${atom.cip === 'R' ? 'S' : 'R'}`));
      for (const c of ['R', 'S']) action.append(node('option', { value: c }, `设为 ${c}`));
    } else if (target.value) for (const c of ['E', 'Z']) action.append(node('option', { value: c }, `设为 ${c}`));
    preview.disabled = !target.value; action.disabled = !target.value; if (info) draw();
  }
  async function load() {
    if (busy) return; lock(true); save.disabled = true;
    try {
      info = await api(`/api/molecules/${encodeURIComponent(objectId)}/inspect`);
      target.replaceChildren(node('option', { value: '' }, '选择要改变的中心或双键'));
      for (const a of info.atoms.filter(a => [6, 14].includes(a.atomicNumber) && !a.aromatic && a.formalCharge === 0 && [3, 4].includes(a.degree))) {
        target.append(node('option', { value: a.id }, `原子 ${a.index + 1} · ${a.atomicNumber === 6 ? 'C' : 'Si'} · ${a.cip || '未指定，需验证'}`));
      }
      for (const b of info.bonds.filter(b => b.order === 2 && !b.aromatic && ['cis', 'trans'].includes(b.stereo))) {
        target.append(node('option', { value: b.id }, `双键 ${b.index + 1} · ${info.stereochemistry?.bonds?.[b.id] || '已有构型'}`));
      }
      const selected = info.selection;
      if (selected?.usable && selected.objectIds?.[0] === objectId) target.value = [...(selected.atomIds || []), ...(selected.bondIds || [])].find(id => [...target.options].some(o => o.value === id)) || '';
      configure();
    } catch (e) { error.textContent = e.message; } finally { lock(false); }
  }
  async function previewEdit() {
    if (busy || !target.value) return; lock(true); invalidate();
    edits = [{ type: action.value === 'invert' ? 'invertTetrahedral' : ['R', 'S'].includes(action.value) ? 'setTetrahedralStereo' : 'setDoubleBondStereo', id: target.value,
      ...(action.value === 'invert' ? {} : { configuration: action.value }) }];
    try {
      candidate = await api('/api/molecules/edit', { operationId: `stereo_preview_${crypto.randomUUID()}`, actor: 'human', expectedRevision: info.revision, expectedObjectVersion: info.objectVersion, objectId, mode: 'preview', edits });
      after.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(candidate.molecule.svg)}`; after.hidden = false;
      const changes = candidate.delta.stereoChanges || [];
      status.textContent = changes.length ? `未保存预览 · ${changes.map(c => `${c.before.configuration ?? '未指定'} → ${c.after.configuration}`).join('；')} · 移动 ${candidate.delta.movedAtoms.length} 个原子。` : '目标构型与当前相同，无需保存。';
      save.disabled = changes.length === 0;
    } catch (e) { error.textContent = `${e.message}；本次未保存。冲突时请重新读取。`; } finally { lock(false); }
  }
  async function commit() {
    if (busy || !candidate) return; lock(true); save.disabled = true;
    request ||= { operationId: `stereo_${crypto.randomUUID()}`, actor: 'human', expectedRevision: info.revision, expectedObjectVersion: info.objectVersion, objectId, mode: 'commit', edits };
    try { const result = await api('/api/molecules/edit', request); dialog.close(); dialog.remove(); onSaved(result.document, objectId); }
    catch (e) { error.textContent = `${e.message}；预览保留，重试使用相同请求标识。`; save.disabled = false; }
    finally { lock(false); }
  }
}
