import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, applyOperation, undoOperation } from '../src/core/index.js';
import { summarizeChanges } from '../server/changes.js';

function sequence() {
  let doc = createDocument({ id: 'activity-test', title: '历史' });
  function apply(changes) {
    doc = applyOperation(doc, { operationId: 'operation-' + doc.revision, actor: 'agent', expectedRevision: doc.revision, intent: '修订画布', changes });
    return receipt();
  }
  function receipt() {
    return summarizeChanges(doc, { sinceRevision: doc.revision - 1, activity: true }).events[0];
  }
  function undo() {
    doc = undoOperation(doc, { operationId: 'undo-' + doc.revision, actor: 'human', expectedRevision: doc.revision });
    return receipt();
  }
  return { apply, undo };
}
const makeObject = (id, kind, title, data) => ({ type: 'createObject', object: { id, kind, title, data } });
const view = (id, objectId) => ({ type: 'createView', view: { id, objectId, x: 10, y: 20, width: 200, height: 140 } });

test('receipts retain historical object names and the exact moved card; undo describes the restored object', () => {
  const { apply, undo } = sequence();
  const created = apply([makeObject('o', 'note', '读数', { text: '' }), view('left', 'o'), view('right', 'o')]);
  assert.deepEqual(created.rows, [{ objectId: 'o', kind: 'note', title: '读数', details: ['新增对象'] }]);
  const moved = apply([{ type: 'moveView', id: 'right', x: 5000, y: 50 }]);
  assert.deepEqual(moved.rows, [{ objectId: 'o', viewId: 'right', title: '读数', kind: 'note', details: ['移动卡片'] }]);
  const renamed = apply([{ type: 'updateObject', id: 'o', patch: { title: '确认值', data: { text: '条件内容' } } }]);
  assert.deepEqual(renamed.rows[0].details, ['标题从「读数」改为「确认值」', '正文']);
  const removed = apply([{ type: 'deleteView', id: 'right' }, { type: 'deleteView', id: 'left' }, { type: 'deleteObject', id: 'o' }]);
  assert.deepEqual(removed.rows[0], { objectId: 'o', title: '确认值', kind: 'note', details: ['删除对象'] });
  assert.deepEqual(undo().rows[0].details, ['新增对象']);
});

test('figure and annotation payloads are omitted, including large or markup-containing values', () => {
  const { apply } = sequence();
  const hidden = '<svg>' + 'private'.repeat(5000) + '</svg>';
  apply([makeObject('f', 'publication', '图稿', { source: '', sourceSha256: '', format: 'chem-canvas.figure/1' })]);
  const receipt = apply([{ type: 'updateObject', id: 'f', patch: { data: { source: hidden, sourceSha256: 'sha', format: 'chem-canvas.figure/1', reviewNotes: [{ id: 'note', text: hidden }] } } }]);
  assert.deepEqual(receipt.rows[0].details, ['SVG 图稿', '批注']);
  assert.ok(JSON.stringify(receipt).length < 200);
});

test('molecular receipts distinguish a coordinate-only edit from a chemical edit', () => {
  const { apply } = sequence();
  const data = { smiles: 'O', atoms: [{ id: 'a', atomicNumber: 8, x: 0, y: 0 }], bonds: [] };
  apply([makeObject('mol', 'molecule', '水', data)]);
  const moved = { ...data, atoms: [{ ...data.atoms[0], x: 4 }] };
  const layout = apply([{ type: 'updateObject', id: 'mol', patch: { data: moved } }]);
  assert.deepEqual(layout.rows[0].details, ['调整原子坐标 × 1']);
  const edited = { ...moved, smiles: 'N', atoms: [{ ...moved.atoms[0], atomicNumber: 7 }] };
  const chemistry = apply([{ type: 'updateObject', id: 'mol', patch: { data: edited } }]);
  assert.deepEqual(chemistry.rows[0].details, ['O → N', '修改原子 × 1']);
});
