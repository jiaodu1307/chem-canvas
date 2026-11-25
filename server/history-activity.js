import { stableJson } from './store.js';

const short = (value, limit = 72) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
};
const fieldNames = {
  text: '正文', label: '标签', conditions: '反应条件', schemeCaption: '反应图注',
  yield: '产率', schemeCycle: '催化循环', source: '来源', svg: 'SVG 图稿',
  versions: '绑定分子版本', moleculeVersions: '绑定分子版本', molecules: '绑定分子', spec: '图表数据', reviewNotes: '批注'
};

function objectDetails(change, old, current) {
  if (change.action === 'added') return ['新增对象'];
  if (change.action === 'removed') return ['删除对象'];
  const labels = [];
  if (old.title !== current.title) labels.push(`标题从「${short(old.title)}」改为「${short(current.title)}」`);
  if (change.moleculeDelta) {
    const delta = change.moleculeDelta;
    if (delta.beforeSmiles !== delta.afterSmiles) labels.push(`${short(delta.beforeSmiles) || '∅'} → ${short(delta.afterSmiles) || '∅'}`);
    for (const [key, label] of [['addedAtoms', '新增原子'], ['removedAtoms', '删除原子'], ['changedAtoms', '修改原子'], ['addedBonds', '新增化学键'], ['removedBonds', '删除化学键'], ['changedBonds', '修改化学键'], ['movedAtoms', '调整原子坐标'], ['stereoChanges', '立体标记变化']]) {
      if (delta[key].length) labels.push(`${label} × ${delta[key].length}`);
    }
    if (delta.depictionAdjustment) labels.push('局部绘图设置');
  } else {
    const fields = new Set();
    for (const key of new Set([...Object.keys(old.data), ...Object.keys(current.data)])) {
      const a = old.data[key], b = current.data[key];
      if (key === 'sourceSha256' || a === b || (a && b && typeof a === 'object' && typeof b === 'object' && stableJson(a) === stableJson(b))) continue;
      fields.add(key === 'source' && current.kind === 'publication' ? 'SVG 图稿' : fieldNames[key] || '其他数据');
    }
    labels.push(...fields);
  }
  return labels.length ? labels : ['更新对象'];
}

// Receipts for people contain labels and stable targets only. SVG source, full
// molecules, note bodies and before/after snapshots stay out of the response.
export function historyActivity(entry, event) {
  const before = entry.before?.objects || {}, after = entry.after?.objects || {};
  const rows = [];
  for (const change of event.objects) {
    rows.push({ objectId: change.objectId, title: short(change.title) || '未命名对象', kind: change.kind,
      details: objectDetails(change, before[change.objectId], after[change.objectId]) });
  }
  for (const [action, views] of Object.entries(event.views)) {
    for (const item of views) {
      const view = item.after || item, object = after[view.objectId] || before[view.objectId];
      // The object row already describes creating/removing its first/final card.
      if (action !== 'changed' && (!before[view.objectId] || !after[view.objectId])) continue;
      const details = [];
      if (action === 'changed') {
        if (view.x !== item.before.x || view.y !== item.before.y) details.push('移动卡片');
        if (view.width !== item.before.width || view.height !== item.before.height) details.push('调整卡片尺寸');
      } else details.push(action === 'added' ? '新增卡片' : '移除卡片');
      rows.push({ objectId: view.objectId, viewId: view.id, title: short(object?.title) || '未命名对象', kind: object?.kind, details });
    }
  }
  const notes = [];
  for (const [action, relations] of Object.entries(event.relations)) {
    for (const item of relations) {
      const rel = item.after || item;
      const name = id => short((after[id] || before[id])?.title, 40) || '未命名对象';
      notes.push(`${{ added: '新增', changed: '更新', removed: '移除' }[action]}关系 · ${name(rel.from)} → ${name(rel.to)}`);
    }
  }
  if (event.schemeLayout) notes.push('更新合成路线版式');
  if (entry.type === 'proposal') notes.push('提交审阅候选');
  if (entry.type === 'reject') notes.push('已拒绝候选');
  return { revision: event.revision, rows, notes };
}
