import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, applyOperation, undoOperation } from '../../src/core/index.js';
import { relationGeometry } from '../../public/relation-geometry.js';
const apply = (d, changes) => applyOperation(d, { operationId: `op${d.revision}`, expectedRevision: d.revision, actor: 'agent', intent: 'route regression', changes });
function fixture() {
  return apply(createDocument({ id: 'route', title: 'route' }), [
    ...['shared', 'step'].map(id => ({ type: 'createObject', object: { id, kind: 'note', title: id, data: {} } })),
    ...[['shared-top', 'shared', 0, 0], ['shared-bottom', 'shared', 0, 900], ['step-bottom', 'step', 400, 900]].map(([id, objectId, x, y]) => ({ type: 'createView', view: { id, objectId, x, y, width: 200, height: 160 } })),
  ]);
}
test('legacy repeated compounds connect to the nearest pair and explicit view anchors override it', () => {
  const d = fixture(), r = { id: 'edge', kind: 'reactant', from: 'shared', to: 'step' };
  assert.equal(relationGeometry(d, r).fromViewId, 'shared-bottom');
  assert.equal(relationGeometry(d, { ...r, fromViewId: 'shared-top' }).fromViewId, 'shared-top');
  assert.equal(relationGeometry(d, { ...r, fromViewId: 'missing' }), null);
  const g = relationGeometry(d, r); assert.equal(g.start.y, g.end.y);
});
test('anchors validate ownership, prevent dangling references, survive resizing and undo', () => {
  const d = fixture();
  const relation = { id: 'edge', kind: 'reactant', from: 'shared', to: 'step', fromViewId: 'shared-bottom', toViewId: 'step-bottom' };
  assert.throws(() => apply(d, [{ type: 'createRelation', relation: { ...relation, fromViewId: 'step-bottom' } }]), /anchor/);
  let current = apply(d, [{ type: 'createRelation', relation }]);
  assert.throws(() => apply(current, [{ type: 'deleteView', id: 'shared-bottom' }]), /anchored/);
  current = apply(current, [{ type: 'updateView', id: 'shared-bottom', patch: { width: 260, x: -40 } }]);
  assert.equal(current.views['shared-bottom'].width, 260);
  assert.equal(current.relations.edge.fromViewId, 'shared-bottom');
  assert.throws(() => apply(current, [{ type: 'updateView', id: 'shared-bottom', patch: { width: 0 } }]), /geometry/);
  assert.throws(() => apply(current, [{ type: 'updateView', id: 'shared-bottom', patch: { objectId: 'step' } }]), /field/);
  const undone = undoOperation(current, { operationId: 'undo-size', expectedRevision: current.revision, actor: 'human' });
  assert.equal(undone.views['shared-bottom'].width, 200);
  const deleted = apply(undone, [{ type: 'deleteRelation', id: 'edge' }, { type: 'deleteView', id: 'shared-bottom' }]);
  assert.equal(deleted.views['shared-bottom'], undefined);
});
