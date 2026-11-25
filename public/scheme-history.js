// Entries retain immutable scheme responses; only small position maps are copied.
export function createSchemeHistory(limit = 100) {
  let past = [], future = [];
  return {
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    clear() { past = []; future = []; },
    record(before) { past.push(before); if (past.length > limit) past.shift(); future = []; },
    undo(current) { if (!past.length) return null; future.push(current); return past.pop(); },
    redo(current) { if (!future.length) return null; past.push(current); return future.pop(); }
  };
}

export function translateSelection(points, dx, dy) {
  if (!points.length) return [];
  // Clamp the group once, so members keep their relative positions at the edges.
  dx = Math.max(Math.round(dx), -Math.min(...points.map(point => point.x)));
  dy = Math.max(Math.round(dy), -Math.min(...points.map(point => point.y)));
  return points.map(({id, x, y}) => ({id, x: x + dx, y: y + dy}));
}
