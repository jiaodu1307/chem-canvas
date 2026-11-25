import { createHash } from 'node:crypto';
import { applyOperation, createMoleculeCandidateProposal } from '../src/core/index.js';
import { failure } from './store.js';

// Both human UI and MCP use the same validated candidate. Never reparse a
// generated candidate through the whole-molecule replacement endpoint.
export function workflowMode(input) {
  if (input.preview !== undefined && typeof input.preview !== 'boolean') throw failure('VALIDATION', 'preview 必须为布尔值。');
  const mode = input.mode ?? (input.preview ? 'preview' : 'commit');
  if (!['preview', 'propose', 'commit'].includes(mode)) throw failure('VALIDATION', 'mode 必须为 preview、propose 或 commit。');
  if (input.preview !== undefined && input.preview !== (mode === 'preview')) throw failure('VALIDATION', 'mode 与 preview 冲突。');
  if (mode === 'propose' && (input.actor !== 'agent' || typeof input.rationale !== 'string' || !input.rationale.trim() || input.rationale.length > 4000)) throw failure('VALIDATION', 'agent 提议需要简短明确的 rationale（1–4000 字符）。');
  return mode;
}

export const moleculeProposalId = operationId => `molecule-proposal-${createHash('sha256').update(operationId).digest('hex').slice(0, 24)}`;

export function saveCandidate(document, input, { object, molecule, delta, changes, intent }, mode) {
  // Candidate provenance is distinct from the actor who eventually accepts it.
  molecule.lastEdit = { ...delta, operationId: input.operationId, actor: input.actor, baseObjectVersion: object?.version ?? 0, resultObjectVersion: (object?.version ?? 0) + 1 };
  if (mode === 'propose') {
    return createMoleculeCandidateProposal(document, {
      id: moleculeProposalId(input.operationId), operationId: input.operationId,
      expectedRevision: input.expectedRevision, actor: input.actor,
      title: input.proposalTitle || intent, rationale: input.rationale,
      // No caller-supplied molecule/SVG or arbitrary changes enter this path.
      changes, review: { kind: 'molecule-candidate', objectId: object?.id ?? changes[0].object.id,
        baseObjectVersion: object?.version ?? 0, delta },
    });
  }
  return applyOperation(document, { operationId: input.operationId, expectedRevision: input.expectedRevision, actor: input.actor, intent, changes });
}
