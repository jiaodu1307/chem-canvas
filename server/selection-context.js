// Pure adapters for server/index.js. No store access and no draft transport.
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export function selectedInput(input, document) {
  if (input.state !== undefined && input.state !== 'saved') fail('VALIDATION', '选区接口仅接收已保存结构，不能接收草稿。');
  if (input.edits !== undefined || input.graph !== undefined || input.saved === false) fail('VALIDATION', '草稿需显式共享上下文，不能作为已保存选区发布。');
  if (input.source !== undefined && !['human-editor', 'human-canvas'].includes(input.source)) fail('VALIDATION', '未知选区来源。');
  if (!Array.isArray(input.objectIds) || input.objectIds.some(id => typeof id !== 'string' || !Object.hasOwn(document.objects, id))) fail('VALIDATION', '选区包含不存在的对象。');
  if (input.revision !== document.revision) fail('CONFLICT', '选择所属文档版本已变化。');
  const objectIds = [...new Set(input.objectIds)], atomIds = input.atomIds ?? [], bondIds = input.bondIds ?? [];
  if (![atomIds, bondIds].every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string'))) fail('VALIDATION', '原子和键选区必须为稳定 ID 数组。');
  const object = objectIds.length === 1 ? document.objects[objectIds[0]] : null;
  if (atomIds.length || bondIds.length) {
    if (object?.kind !== 'molecule') fail('VALIDATION', '原子和键选区必须属于同一个分子。');
    if (!Number.isSafeInteger(input.objectVersion)) fail('VALIDATION', '片段选区需要明确的对象版本。');
    if (atomIds.some(id => !object.data.atoms.some(atom => atom.id === id)) || bondIds.some(id => !object.data.bonds.some(bond => bond.id === id))) fail('VALIDATION', '原子或键不属于已保存结构。');
  }
  if (input.objectVersion !== undefined && object?.version !== input.objectVersion) fail('CONFLICT', '分子版本已变化。');
  return { schemaVersion: 1, state: 'saved', saved: true, source: input.source ?? 'human-canvas', objectIds,
    revision: input.revision, ...(object ? { objectVersion: object.version } : {}), atomIds: [...new Set(atomIds)], bondIds: [...new Set(bondIds)],
    baseline: { revision: input.revision, objectId: object?.id ?? null, objectVersion: object?.version ?? null } };
}
export function readSelection(selection, document) {
  const object = selection.objectIds.length === 1 ? document.objects[selection.objectIds[0]] : null;
  const missingObjectIds = selection.objectIds.filter(id => !Object.hasOwn(document.objects, id));
  const missingAtomIds = (selection.atomIds || []).filter(id => !object?.data?.atoms?.some(atom => atom.id === id));
  const missingBondIds = (selection.bondIds || []).filter(id => !object?.data?.bonds?.some(bond => bond.id === id));
  const revisionStale = selection.revision !== document.revision;
  const objectStale = missingObjectIds.length > 0 || (selection.objectVersion !== undefined && object?.version !== selection.objectVersion);
  const stale = objectStale || revisionStale || missingAtomIds.length > 0 || missingBondIds.length > 0;
  return { ...selection, schemaVersion: 1, state: 'saved', saved: true, source: selection.source ?? 'human-canvas',
    baseline: selection.baseline ?? { revision: selection.revision, objectId: object?.id ?? selection.objectIds[0] ?? null, objectVersion: selection.objectVersion ?? null },
    currentRevision: document.revision, currentObjectVersion: object?.version ?? null, stale, revisionStale, objectStale,
    usable: !stale && selection.objectIds.length > 0, missingObjectIds, missingAtomIds, missingBondIds };
}
