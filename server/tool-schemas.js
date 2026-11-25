const str = { type: 'string' }, num = { type: 'number' }, positive = { type: 'number', exclusiveMinimum: 0 };
export const objectSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const variant = (type, properties, required = Object.keys(properties)) => objectSchema({ type: { const: type }, ...properties }, ['type', ...required]);
const data = { type: 'object', additionalProperties: true };
const kinds = ['molecule', 'question', 'hypothesis', 'evidence', 'plan', 'note', 'reaction', 'task'];
const relationKinds = ['relates_to', 'supports', 'contradicts', 'derived_from', 'tests', 'refers_to', 'reactant', 'product', 'reagent', 'catalyst', 'solvent'];
export const changeSchema = { description: 'Atomic ordered changes. Create objects/views before references; remove relations before their anchored views or objects. data replaces the complete prior data. updateView changes geometry only. Use explicit view anchors for repeated compounds.', oneOf: [
  variant('createObject', { object: objectSchema({ id: str, kind: { enum: kinds }, title: str, data, provenance: data }, ['id', 'kind', 'title', 'data']) }),
  variant('updateObject', { id: str, patch: { ...objectSchema({ title: str, data }), minProperties: 1 } }),
  variant('createView', { view: objectSchema({ id: str, objectId: str, x: num, y: num, width: positive, height: positive }, ['id', 'objectId', 'x', 'y', 'width', 'height']) }),
  variant('moveView', { id: str, x: num, y: num }),
  variant('updateView', { id: str, patch: { ...objectSchema({ x: num, y: num, width: positive, height: positive }), minProperties: 1 } }),
  variant('createRelation', { relation: objectSchema({ id: str, kind: { enum: relationKinds }, from: str, to: str, fromViewId: str, toViewId: str, note: str, sourceVersion: { type: 'integer', minimum: 1 }, targetVersion: { type: 'integer', minimum: 1 } }, ['id', 'kind', 'from', 'to']) }),
  ...['deleteRelation', 'deleteView', 'deleteObject'].map(type => variant(type, { id: str })),
] };
const atomProperties = { atomicNumber: { type: 'integer', minimum: 1, maximum: 118 }, formalCharge: { type: 'integer', minimum: -8, maximum: 8 }, isotope: { type: 'integer', minimum: 0, maximum: 400 } };
const coord = { type: 'number', minimum: -100000, maximum: 100000 }, order = { enum: [1, 2, 3] };
export const moleculeEditSchema = { type: 'array', minItems: 1, maxItems: 500, description: 'Stereo operations must be a standalone batch of at most 100. Ordinary operations cannot be mixed with stereo operations.', items: { oneOf: [
  variant('addAtom', { atom: objectSchema({ id: str, ...atomProperties, x: coord, y: coord }, ['id', 'atomicNumber', 'x', 'y']) }),
  variant('updateAtom', { id: str, patch: { ...objectSchema(atomProperties), minProperties: 1 } }),
  variant('moveAtom', { id: str, x: coord, y: coord }),
  variant('addBond', { bond: objectSchema({ id: str, from: str, to: str, order }, ['id', 'from', 'to', 'order']) }),
  variant('updateBond', { id: str, patch: objectSchema({ order }, ['order']) }),
  ...['deleteAtom', 'deleteBond', 'invertTetrahedral'].map(type => variant(type, { id: str })),
  variant('setTetrahedralStereo', { id: str, configuration: { enum: ['R', 'S'] } }),
  variant('setDoubleBondStereo', { id: str, configuration: { enum: ['E', 'Z'] } }),
] } };
