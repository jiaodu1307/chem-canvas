// Read-only projections of the saved HTTP document. Never resolve proposals,
// refresh selections, or consult browser drafts while constructing a response.
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const validId = id => typeof id === 'string' && /\S/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
export const canvasReadSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    detail: { type: 'string', enum: ['full', 'summary'], default: 'full', description: 'Object content level. Summary omits molecular graphs, MOL, SVG, long data and proposal bodies. Omit all new options for the legacy response.' },
    objectIds: { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true,
      items: { type: 'string', minLength: 1, pattern: '\\S', not: { enum: ['__proto__', 'constructor', 'prototype'] } },
      description: 'Exact current saved object IDs, not view/proposal/atom IDs. Unknown IDs fail the entire read. Includes incident relations and external endpoint references; proposals remain a global summary.' },
    includeSvg: { type: 'boolean' }, includeHistory: { type: 'boolean' },
  },
  allOf: [{ if: { properties: { detail: { const: 'summary' } }, required: ['detail'] },
    then: { properties: { includeSvg: { const: false }, includeHistory: { const: false } } } }],
};

export function validateReadOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !Object.hasOwn(canvasReadSchema.properties, key))) fail('VALIDATION', 'Unknown canvas_read option.');
  if (Object.hasOwn(options, 'detail') && !['full', 'summary'].includes(options.detail)) fail('VALIDATION', 'detail must be full or summary.');
  for (const key of ['includeSvg', 'includeHistory']) if (Object.hasOwn(options, key) && typeof options[key] !== 'boolean') fail('VALIDATION', `${key} must be boolean.`);
  if (Object.hasOwn(options, 'objectIds') && (!Array.isArray(options.objectIds) || options.objectIds.length < 1 || options.objectIds.length > 200
    || !options.objectIds.every(validId) || new Set(options.objectIds).size !== options.objectIds.length)) fail('VALIDATION', 'objectIds must contain 1–200 unique, nonblank object IDs.');
  if (options.detail === 'summary' && (options.includeSvg || options.includeHistory)) fail('VALIDATION', 'Summary cannot include SVG or history. Use detail:full for these fields.');
}

// Keep the legacy contract, including history receipts without before/after.
export function compactDocument(document, { includeSvg = false, includeHistory = false } = {}) {
  const result = structuredClone(document);
  delete result.appliedOperations;
  delete result.identities;
  if (!includeHistory) delete result.history;
  else result.history = result.history.map(({ before, after, ...entry }) => entry);
  if (!includeSvg) {
    for (const object of Object.values(result.objects)) delete object.data.svg;
    for (const proposal of Object.values(result.proposals)) {
      for (const item of proposal.changes) { if (item.object?.data) delete item.object.data.svg; if (item.patch?.data) delete item.patch.data.svg; }
    }
  }
  return result;
}

const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, structuredClone(value[key])]));
const identity = object => pick(object, ['id', 'kind', 'title', 'version']);
function objectSummary(object) {
  return { ...identity(object), data: object.kind === 'molecule'
    ? { atomCount: object.data.atoms.length, bondCount: object.data.bonds.length }
    : { ...(typeof object.data.text === 'string' ? { textPreview: object.data.text.slice(0, 240), textTruncated: object.data.text.length > 240 } : {}) } };
}
function proposalSummary(proposal) {
  return { ...pick(proposal, ['id', 'title', 'status', 'actor', 'operationId', 'baselineRevision', 'createdRevision', 'resolvedRevision', 'resolvedBy', 'reviewFeedback']),
    changeCount: proposal.changes.length,
    ...(proposal.review?.objectId ? { reviewObjectId: proposal.review.objectId, baseObjectVersion: proposal.review.baseObjectVersion } : {}) };
}

export function buildReadResponse({ document, proposalAcceptances, selection, capabilities, url }, options = {}) {
  validateReadOptions(options);
  const extended = Object.hasOwn(options, 'detail') || Object.hasOwn(options, 'objectIds');
  if (!extended) return { document: compactDocument(document, options), proposalAcceptances, selection, capabilities, url };
  // Separate HTTP GETs are not a transaction. Reject inconsistent observations
  // rather than rebase the human selection or assert a usable cross-revision read.
  if (selection.currentRevision !== document.revision) fail('CONFLICT', 'Document changed during canvas_read. Reread; the saved selection was not refreshed.');
  const detail = options.detail ?? 'full', scoped = Object.hasOwn(options, 'objectIds');
  const ids = options.objectIds ?? Object.keys(document.objects);
  const missing = ids.filter(id => !Object.hasOwn(document.objects, id));
  if (missing.length) fail('NOT_FOUND', `Unknown current objectIds: ${JSON.stringify(missing)}`);
  const wanted = new Set(ids), summary = detail === 'summary';
  const relations = Object.values(document.relations).filter(r => !scoped || wanted.has(r.from) || wanted.has(r.to));
  const externalIds = [...new Set(relations.flatMap(r => [r.from, r.to]).filter(id => !wanted.has(id)))];
  const views = Object.values(document.views).filter(v => wanted.has(v.objectId));
  const externalViewIds = [...new Set(relations.flatMap(r => [r.fromViewId, r.toViewId]).filter(id => id && !wanted.has(document.views[id].objectId)))];
  const proposalBodies = !summary && !scoped;
  const result = pick(document, ['schemaVersion', 'id', 'title', 'revision']);
  result.objects = Object.fromEntries(ids.map(id => {
    const object = summary ? objectSummary(document.objects[id]) : structuredClone(document.objects[id]);
    if (!options.includeSvg) delete object.data.svg;
    return [id, object];
  }));
  result.views = Object.fromEntries(views.map(v => [v.id, structuredClone(v)]));
  result.relations = Object.fromEntries(relations.map(r => [r.id, summary
    ? pick(r, ['id', 'kind', 'from', 'to', 'sourceVersion', 'targetVersion', 'fromViewId', 'toViewId']) : structuredClone(r)]));
  result.proposals = Object.fromEntries(Object.values(document.proposals).map(p => {
    if (!proposalBodies) return [p.id, proposalSummary(p)];
    const copy = structuredClone(p);
    if (!options.includeSvg) for (const change of copy.changes) {
      if (change.object?.data) delete change.object.data.svg;
      if (change.patch?.data) delete change.patch.data.svg;
    }
    return [p.id, copy];
  }));
  if (!summary && !scoped && document.schemeLayout) result.schemeLayout = structuredClone(document.schemeLayout);
  if (options.includeHistory) result.history = document.history.map(({ before, after, ...entry }) => structuredClone(entry));
  const counts = (total, included) => ({ total, included, omitted: total - included });
  return { document: result, proposalAcceptances, selection, capabilities, url,
    readScope: {
      detail, scope: scoped ? 'objects' : 'document', objectIds: ids, completeDocument: false,
      objects: counts(Object.keys(document.objects).length, ids.length),
      views: counts(Object.keys(document.views).length, views.length),
      relations: { ...counts(Object.keys(document.relations).length, relations.length), scope: scoped ? 'incident' : 'document' },
      proposals: { scope: 'document', detail: proposalBodies ? 'full' : 'summary', count: Object.keys(document.proposals).length },
      proposalAcceptances: { scope: 'document', revision: document.revision, source: 'server', recomputedFromProjection: false },
      selection: { scope: 'document', outsideObjectIds: selection.objectIds.filter(id => !wanted.has(id)), refreshed: false },
      history: { scope: 'document', detail: options.includeHistory ? 'entries-without-snapshots' : 'omitted', count: document.history.length },
      schemeLayoutVersion: document.schemeLayout?.version ?? 0,
      omitted: ['appliedOperations', 'identities', ...(options.includeHistory ? ['history.before', 'history.after'] : ['history']),
        ...(!options.includeSvg || summary ? ['svg'] : []),
        ...(summary ? ['object.data (except counts/textPreview)', 'object.provenance', 'relation.note'] : []),
        ...(!proposalBodies ? ['proposal.changes', 'proposal.rationale', 'proposal.review', 'proposal.scope'] : []),
        ...(summary || scoped ? ['schemeLayout'] : [])],
      guidance: 'This is a saved-state projection, not a complete persisted document or edit authorization. Read full object data before editing; data patches replace prior data. Full proposal bodies require canvas_read without objectIds and detail:full. Inspect tools return native PNGs.',
    },
    references: {
      objects: Object.fromEntries(externalIds.map(id => [id, identity(document.objects[id])])),
      views: Object.fromEntries(externalViewIds.map(id => [id, structuredClone(document.views[id])])),
      meaning: 'External incident-relation endpoints only; object bodies are not included. Pinned sourceVersion/targetVersion are unchanged, not rebased to current versions.',
    },
  };
}
