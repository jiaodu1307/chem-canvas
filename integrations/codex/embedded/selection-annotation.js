// Adapter for the Codex built-in browser's Annotation API. Ship as a browser ES module.
const id = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const revision = value => Number.isSafeInteger(value) && value >= 0;
const sameIds = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((item, index) => item === right[index]);

export function savedSelectionReference({ context, published, document, projectId } = {}) {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(projectId)
    || ['__proto__', 'prototype', 'constructor'].includes(projectId)) return null;
  if (context?.schemaVersion !== 1 || context.state !== 'saved' || context.saved !== true
    || context.source !== 'human-editor' || context.editCount !== 0
    || !sameIds(context.draftIds?.atomIds, []) || !sameIds(context.draftIds?.bondIds, [])
    || published?.schemaVersion !== 1 || published.state !== 'saved' || published.saved !== true
    || published.source !== 'human-editor' || published.stale === true || published.usable === false) return null;

  const { revision: baseRevision, objectId, objectVersion } = context.baseline ?? {};
  if (!id(document?.id) || !id(objectId) || !revision(baseRevision) || !revision(objectVersion)
    || objectVersion === 0 || document.revision !== baseRevision || published.revision !== baseRevision
    || published.objectVersion !== objectVersion || !sameIds(published.objectIds, [objectId])
    || published.baseline?.revision !== baseRevision || published.baseline.objectId !== objectId
    || published.baseline.objectVersion !== objectVersion) return null;

  const object = Object.hasOwn(document.objects ?? {}, objectId) ? document.objects[objectId] : null;
  if (object?.kind !== 'molecule' || object.version !== objectVersion) return null;
  const { atomIds, bondIds } = context.selection ?? {};
  if (!sameIds(atomIds, published.atomIds) || !sameIds(bondIds, published.bondIds)
    || atomIds.length + bondIds.length === 0) return null;
  const savedAtoms = new Set(object.data?.atoms?.map(atom => atom.id));
  const savedBonds = new Set(object.data?.bonds?.map(bond => bond.id));
  if (!atomIds.every(atom => id(atom) && savedAtoms.has(atom))
    || !bondIds.every(bond => id(bond) && savedBonds.has(bond))) return null;
  return { projectId, documentId: document.id, revision: baseRevision, objectId, objectVersion,
    atomIds: [...atomIds], bondIds: [...bondIds] };
}

export function annotationMetadata(reference) {
  if (!reference) return null;
  const { projectId, documentId, revision, objectId, objectVersion, atomIds, bondIds } = reference;
  // Annotation metadata permits six scalar fields. Encode arrays losslessly.
  const metadata = { projectId, documentId, objectId, versions: `r${revision}/v${objectVersion}`,
    atomIds: JSON.stringify(atomIds), bondIds: JSON.stringify(bondIds) };
  if (metadata.atomIds.length > 256 || metadata.bondIds.length > 256
    || new TextEncoder().encode(JSON.stringify(metadata)).length > 2048) return null;
  return metadata;
}

export function selectionAnnotationMetadata(snapshot) {
  return annotationMetadata(savedSelectionReference(snapshot));
}

export function supportsSelectionAnnotations(page) {
  const view = page?.defaultView;
  return !!view && view === view.top && view.isSecureContext
    && page.location?.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(page.location.hostname)
    && typeof page.oai?.annotation?.request === 'function';
}

export function requestSelectionAnnotation({ page, target, event, snapshot }) {
  if (!supportsSelectionAnnotations(page) || event?.isTrusted !== true || event.type !== 'click'
    || event.currentTarget?.ownerDocument !== page || target?.ownerDocument !== page
    || !target.isConnected || target.getRootNode() !== page) return false;
  const metadata = selectionAnnotationMetadata(snapshot);
  if (!metadata) return false;
  const query = new URLSearchParams(page.location.search);
  const project = query.has('project') ? query.get('project') : 'default';
  if (query.getAll('project').length > 1 || metadata.projectId !== project) return false;
  const receipt = page.oai.annotation.request(target, {
    omitScreenshot: true,
    metadata,
    initialComment: `请使用 projectId=${project} 读取 Chem Canvas 中与此批注版本相符的已保存片段，再根据我的消息进行解释或提出修改。`,
  });
  return receipt?.accepted === true;
}
