import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

function croppedAt(note, y) {
  if (!note?.region) return false;
  const region = note.region;
  const cx = 872 / 960;
  const cy = y / 645;
  return region.x <= cx && cx < region.x + region.width &&
    region.y <= cy && cy < region.y + region.height;
}

function canvasCalls(requestText) {
  const lines = requestText.trim().split(/\r?\n/);
  const calls = [];
  for (const line of lines) {
    if (!line.trimStart().startsWith('{')) continue;
    let tool;
    try { tool = JSON.parse(line); } catch { continue; }
    if (tool?.name === 'canvas_figure' && tool.arguments?.reviewNoteId) calls.push(tool.arguments);
  }
  // The legacy clipboard contains a single line of prose with explicitly named calls.
  if (lines.length === 1 && !lines[0].trimStart().startsWith('{')) {
    for (const match of lines[0].matchAll(/请调用 canvas_figure\s+(\{[^{}]*\})/g)) {
      let args;
      try { args = JSON.parse(match[1]); } catch { continue; }
      if (args?.reviewNoteId) calls.push(args);
    }
  }
  return calls;
}

export function scoreHandoff(receipt, svg, sourceDigest) {
  const { projectId, before, after, requestText, targetNoteId, controlNoteId } = receipt;
  const target = before.reviewNotes.find(note => note.id === targetNoteId);
  const control = before.reviewNotes.find(note => note.id === controlNoteId);
  const savedControl = after.reviewNotes.find(note => note.id === controlNoteId);
  const calls = canvasCalls(requestText);
  const addressed = [...new Set(calls.map(call => call.reviewNoteId))];
  const checks = {
    originalFigure: before.sourceSha256 === sourceDigest,
    twoOpenRegions: before.reviewNotes.filter(note => note.resolvedAtRevision === null).length === 2 &&
      target?.resolvedAtRevision === null && control?.resolvedAtRevision === null &&
      targetNoteId !== controlNoteId && croppedAt(target, 282) && !croppedAt(target, 430) &&
      croppedAt(control, 430) && !croppedAt(control, 282),
    targetOnly: !!projectId && addressed.length === 1 && addressed[0] === targetNoteId &&
      calls.every(call => call.mode === 'read' && call.projectId === projectId) &&
      requestText.includes(before.figureId) && !requestText.includes(controlNoteId) && !!control?.text &&
      (control.text === target?.text || !requestText.includes(control.text)),
    savedSameFigure: !!before.documentId && !!before.figureId && after.documentId === before.documentId &&
      after.figureId === before.figureId && after.revision > before.revision &&
      !!after.sourceSha256 && after.sourceSha256 !== before.sourceSha256,
    controlStillOpen: savedControl?.resolvedAtRevision === null && !!control &&
      savedControl.text === control.text && savedControl.createdAtRevision === control.createdAtRevision &&
      savedControl.artworkKey === control.artworkKey &&
      isDeepStrictEqual(savedControl.region, control.region),
    exportMatchesReceipt: createHash('sha256').update(svg).digest('hex') === receipt.exportSha256,
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    addressedNoteIds: addressed,
    targetTextIncluded: !!target?.text && requestText.includes(target.text),
    controlResolvedAtRevision: savedControl?.resolvedAtRevision ?? null,
  };
}
