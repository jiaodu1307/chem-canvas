import { _editingToolkit, _editingGraph, _validateLayoutGraph } from './index.js';
import { drawMolecule } from './drawing.js';
import { chemicalSignature, layoutQuality } from './layout.js';

export const STEREO_EDIT_TYPES = Object.freeze(['invertTetrahedral', 'setTetrahedralStereo', 'setDoubleBondStereo']);
const readOptions = JSON.stringify({ sanitize: true, removeHs: false, strictParsing: true });
const fail = (message, reason = 'UNSUPPORTED_STEREO') => {
  throw Object.assign(new Error(message), { code: 'VALIDATION', reason });
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pair = (a, b) => [a, b].sort().join('|');
const assigned = a => ['cw', 'ccw'].includes(a.stereo) && ['R', 'S'].includes(a.cip);
const invert = tag => tag === 'cw' ? 'ccw' : 'cw';

export function stereoEditingCapabilities() {
  return {
    operations: [...STEREO_EDIT_TYPES], maxEdits: 100, identityPreserved: true,
    tetrahedral: { elements: [6, 14], configurations: ['R', 'S'],
      invertRequiresAssignedCenter: true, canAssignUnspecifiedCenter: true, preservesCoordinates: 'within V3000 rounding (0.000001 molecular units)' },
    doubleBond: { supported: true, configurations: ['E', 'Z'], requiresAssignedStereo: true,
      scope: 'ordinary acyclic neutral C=C with single-bonded substituents',
      coordinates: 'reflect smaller connected side about the double-bond axis; report every moved atom' },
    checks: ['fresh-CIP-labels', 'non-target-stereo', 'indexed-graph', 'exchange-atom-maps', 'MOL-roundtrip', 'SMILES-roundtrip', 'JSON-roundtrip'],
    limitations: [
      'Only neutral tetrahedral carbon/silicon with four single-bonded ligands (including one implicit H) and verified uppercase R/S.',
      'No mixed stereo/ordinary graph edit batches; no radical, pseudoasymmetric, enhanced, non-tetrahedral or 3D structures.',
      'A change that alters any non-target center or its CIP descriptor is rejected.',
      'E/Z assignment requires an already assigned ordinary non-ring C=C; unspecified, cyclic and cumulated double bonds are rejected.',
      'E/Z reflection is rejected if it increases geometric crossings, atom overlaps or atom/bond clashes.',
    ],
  };
}

function atomRows(block) {
  const section = block.split('M  V30 BEGIN ATOM\n')[1]?.split('M  V30 END ATOM')[0];
  if (!section || section.includes('-\n')) fail('Extended V3000 atom records are not supported.');
  return section.trim().split('\n').map(line => line.slice(7).trim().split(/\s+/));
}

function remap(mol, data) {
  const structure = JSON.parse(mol.get_json()), graph = _editingGraph(structure, 'stereo');
  if (graph.atoms.length !== data.atoms.length || graph.bonds.length !== data.bonds.length) fail('Stereo reconstruction changed graph size.');
  const ids = new Map(graph.atoms.map((a, i) => [a.id, data.atoms[i].id]));
  graph.atoms.forEach((a, i) => { a.id = data.atoms[i].id; });
  graph.bonds.forEach((b, i) => {
    const old = data.bonds[i];
    if (pair(ids.get(b.from), ids.get(b.to)) !== pair(old.from, old.to)) fail('Stereo reconstruction changed indexed bond endpoints.');
    b.id = old.id; b.from = old.from; b.to = old.to;
    if (b.stereoAtoms) b.stereoAtoms = b.stereoAtoms.map(id => ids.get(id));
    // Aromatic Kekule alternatives are the same chemical bond.
    if (b.aromatic && old.aromatic && [1, 2].includes(b.order) && [1, 2].includes(old.order)) b.order = old.order;
  });
  return { ...graph, structure };
}

function preserve(before, after, target = -1, coordinateTolerance = 1e-6, targetBond = -1, positions = null) {
  for (const [i, atom] of before.atoms.entries()) {
    const next = after.atoms[i];
    for (const field of ['id', 'index', 'atomicNumber', 'formalCharge', 'isotope', 'implicitHydrogens', 'radicalElectrons', 'aromatic']) {
      if (!equal(atom[field], next[field])) fail(`Stereo edit changed protected atom property ${field}.`);
    }
    for (const [j, field] of ['x', 'y', 'z'].entries()) {
      const expected = positions && j < 2 ? positions[i][j] : atom[field];
      if (!Number.isFinite(next[field]) || Math.abs(expected - next[field]) > coordinateTolerance) fail('Stereo edit changed protected coordinates.');
    }
    if (i !== target && (!equal(atom.stereo, next.stereo) || !equal(atom.cip, next.cip))) fail(`Stereo edit would change non-target center ${atom.id}.`, 'NON_TARGET_STEREO_CHANGE');
  }
  for (const [i, bond] of before.bonds.entries()) {
    for (const field of ['id', 'index', 'from', 'to', 'order', 'aromatic', 'stereo', 'stereoAtoms']) {
      if (i === targetBond && field === 'stereo') continue;
      if (!equal(bond[field], after.bonds[i][field])) fail(`Stereo edit would change non-target bond ${bond.id} (${field}).`, 'NON_TARGET_STEREO_CHANGE');
    }
  }
}

function bondConfigurations(mol, data) {
  const tags = JSON.parse(mol.get_stereo_tags()).CIP_bonds ?? [];
  return new Map(tags.filter(t => ['(E)', '(Z)'].includes(t[2]))
    .map(([a, b, label]) => [pair(data.atoms[a].id, data.atoms[b].id), label.slice(1, -1)]));
}

export async function inspectStereochemistry(data) {
  const rdkit = await _editingToolkit();
  const mol = rdkit.get_mol(data.molblock, readOptions);
  try {
    _validateLayoutGraph(data, mol,rdkit);
    const configs = bondConfigurations(mol, data);
    return { ...(data.coordinationStereo?{coordination:data.coordinationStereo}:{}),atoms: Object.fromEntries(data.atoms.filter(a => a.cip).map(a => [a.id, a.cip])),
      bonds: Object.fromEntries(data.bonds.filter(b => configs.has(pair(b.from, b.to))).map(b => [b.id, configs.get(pair(b.from, b.to))])) };
  } finally { mol?.delete(); }
}

function reflectedSide(graph, bond) {
  const ends = [bond.from, bond.to];
  for (const id of ends) {
    const a = graph.atoms.find(a => a.id === id), edges = graph.bonds.filter(b => [b.from, b.to].includes(id));
    if (a.atomicNumber !== 6 || a.formalCharge !== 0 || a.aromatic ||
        !((edges.length === 2 && a.implicitHydrogens === 1) || (edges.length === 3 && a.implicitHydrogens === 0)) ||
        edges.some(b => b.id !== bond.id && (b.order !== 1 || b.aromatic))) fail('E/Z requires an ordinary neutral C=C with single-bonded substituents.', 'NOT_SUPPORTED_DOUBLE_BOND');
  }
  const component = start => {
    const found = new Set([start]), pending = [start];
    while (pending.length) {
      const id = pending.pop();
      for (const b of graph.bonds) if (b.id !== bond.id && [b.from, b.to].includes(id)) {
        const next = b.from === id ? b.to : b.from;
        if (!found.has(next)) { found.add(next); pending.push(next); }
      }
    }
    return found;
  };
  const left = component(bond.from);
  if (left.has(bond.to)) fail('E/Z editing of ring double bonds is not supported.', 'CYCLIC_DOUBLE_BOND');
  const right = component(bond.to), moving = left.size <= right.size ? left : right;
  const a = graph.atoms.find(a => a.id === bond.from), b = graph.atoms.find(a => a.id === bond.to);
  const vx = b.x - a.x, vy = b.y - a.y, length2 = vx * vx + vy * vy;
  if (length2 < 0.0025) fail('Double-bond axis is too short for a reliable reflection.');
  const positions = graph.atoms.map(atom => {
    if (!moving.has(atom.id) || ends.includes(atom.id)) return [atom.x, atom.y];
    const x = atom.x - a.x, y = atom.y - a.y, dot = (x * vx + y * vy) / length2;
    return [a.x + 2 * dot * vx - x, a.y + 2 * dot * vy - y];
  });
  if (positions.some(p => p.some(v => !Number.isFinite(v) || Math.abs(v) > 100000))) fail('E/Z reflection exceeds supported coordinate bounds.');
  return positions;
}

// JSON coordinates need floating-point tokens in this installed WASM reader.
function inputJSON(structure) {
  const j = structuredClone(structure), m = j.molecules[0];
  for (const ext of m.extensions ?? []) { delete ext.cipCodes; delete ext.cipRanks; }
  const coords = m.conformers[0].coords;
  m.conformers[0].coords = '__STEREO_COORDS__';
  return JSON.stringify(j).replace('"__STEREO_COORDS__"', '[' + coords.map(p => '[' + p.map(v => v.toExponential(16)).join(',') + ']').join(',') + ']');
}

function checkCIP(rdkit, mol) {
  // Reparse MOL so cached JSON CIP values cannot determine the result. Also
  // require agreement with the accurate CIPLabeler exposed by this WASM build.
  const accurate = rdkit.get_mol(mol.get_v3Kmolblock(), JSON.stringify({ sanitize: true, removeHs: false, assignCIPLabels: true }));
  try {
    if (!accurate) fail('RDKit could not recompute CIP labels.');
    const basic = _editingGraph(JSON.parse(mol.get_json()), 'check');
    const checked = _editingGraph(JSON.parse(accurate.get_json()), 'check');
    if (!equal(basic.atoms.map(a => a.cip), checked.atoms.map(a => a.cip))) fail('RDKit legacy and accurate CIP labels disagree; this stereochemistry is unsupported.', 'CIP_UNSUPPORTED');
    if (checked.atoms.some(a => a.cip !== undefined && !['R', 'S'].includes(a.cip))) fail('Pseudoasymmetric/lowercase CIP descriptors are not supported.', 'CIP_UNSUPPORTED');
  } finally { accurate?.delete(); }
}

function verifyRoundtrips(rdkit, mol, sourceMaps) {
  const signature = chemicalSignature(mol), smiles = mol.get_smiles();
  for (const input of [mol.get_v3Kmolblock(), smiles]) {
    const rt = rdkit.get_mol(input, readOptions);
    try {
      if (!rt || rt.get_smiles() !== smiles) fail('Stereo edit failed canonical isomeric SMILES roundtrip.');
      if (input !== smiles && (chemicalSignature(rt) !== signature || !equal(atomRows(rt.get_v3Kmolblock()).map(a => a[5]), sourceMaps))) fail('Stereo edit failed indexed MOL roundtrip.');
    } finally { rt?.delete(); }
  }
  // JSON omits atom maps. Verify its indexed graph/stereo without claiming that
  // JSON alone preserves those exchange labels (MOL and SMILES above do).
  let jsonMol, rt;
  try {
    jsonMol = rdkit.get_mol(inputJSON(JSON.parse(mol.get_json())), JSON.stringify({ sanitize: true, removeHs: false, assignStereo: false }));
    if (!jsonMol) fail('Stereo edit failed JSON reconstruction.');
    rt = rdkit.get_mol(restoreMaps(jsonMol.get_v3Kmolblock(), sourceMaps), readOptions);
    if (!rt || chemicalSignature(rt) !== signature || rt.get_smiles() !== smiles) fail('Stereo edit failed indexed JSON roundtrip.');
  } finally { jsonMol?.delete(); rt?.delete(); }
}

function restoreMaps(block, maps) {
  const rows = atomRows(block);
  if (rows.length !== maps.length || rows.some((row, i) => +row[0] !== i + 1)) fail('RDKit reordered atom records; identity cannot be verified.');
  let inAtoms = false;
  return block.split('\n').map(line => {
    if (line === 'M  V30 BEGIN ATOM') { inAtoms = true; return line; }
    if (line === 'M  V30 END ATOM') { inAtoms = false; return line; }
    if (!inAtoms) return line;
    const row = line.slice(7).trim().split(/\s+/); row[5] = maps[+row[0] - 1];
    return 'M  V30 ' + row.join(' ');
  }).join('\n');
}

// Pure chemistry transaction. The caller owns revisions, persistence and undo.
export async function applyStereoEdits(data, edits) {
  if(data?.coordinationStereo) fail('Replace the stereospecified coordination MOL or SMILES to change its geometry.','UNSUPPORTED_COORDINATION_EDIT');
  if (!Array.isArray(edits) || !edits.length || edits.length > 100) fail('Provide 1–100 stereo edits.', 'INVALID_STEREO_EDIT');
  for (const edit of edits) {
    const allowed = edit?.type === 'invertTetrahedral' ? ['type', 'id'] : ['type', 'id', 'configuration'];
    if (!edit || typeof edit !== 'object' || Array.isArray(edit) || !STEREO_EDIT_TYPES.includes(edit.type) || Object.keys(edit).some(k => !allowed.includes(k)) || typeof edit.id !== 'string' ||
        (edit.type === 'setTetrahedralStereo' && !['R', 'S'].includes(edit.configuration)) ||
        (edit.type === 'setDoubleBondStereo' && !['E', 'Z'].includes(edit.configuration))) fail('Use invertTetrahedral {id}, setTetrahedralStereo {id,configuration:"R"|"S"}, or setDoubleBondStereo {id,configuration:"E"|"Z"}; standalone stereo batches only.', 'INVALID_STEREO_EDIT');
  }
  if (!data || typeof data.molblock !== 'string' || data.molblock.length > 200000) fail('A complete existing molecule is required.', 'INVALID_STEREO_SOURCE');
  const rdkit = await _editingToolkit();
  let source, current;
  try {
    source = rdkit.get_mol(data.molblock, readOptions);
    _validateLayoutGraph(data, source);
    if ([...data.atoms, ...data.bonds].some(item => !/^[A-Za-z0-9_.:-]{1,200}$/.test(item.id) || ['__proto__', 'prototype', 'constructor'].includes(item.id))) fail('Invalid stable atom/bond ID.', 'INVALID_STEREO_SOURCE');
    if (source.has_coords() !== 2 || data.atoms.some(a => !Number.isFinite(a.z) || Math.abs(a.z) > 1e-5 || [a.x, a.y].some(v => !Number.isFinite(v) || Math.abs(v) > 100000))) fail('Stereo editing requires finite 2D coordinates within ±100000 molecular units.');
    if (data.atoms.some(a => a.radicalElectrons || !['unspecified', 'cw', 'ccw'].includes(a.stereo)) || data.bonds.some(b => ![1, 2, 3].includes(b.order) || !['unspecified', 'cis', 'trans'].includes(b.stereo))) fail('Radical/non-tetrahedral/exotic bond structures are not supported.');
    const rows = atomRows(source.get_v3Kmolblock()), sourceMaps = rows.map(row => row[5]);
    if (rows.some(row => row.slice(6).some(v => /^(VAL|HCOUNT)=/.test(v) && !(row[1] === 'Si' && v === 'VAL=4')))) fail('Explicit valence/HCOUNT atom constraints are not supported (except ordinary tetravalent Si).');
    if (/\bCFG=2\b/.test(source.get_v3Kmolblock())) fail('Explicit unknown/wavy stereo is not supported.');
    checkCIP(rdkit, source);
    let graph = remap(source, data);
    preserve(data, graph, -1, 0.001);
    // parseSmiles retains full-precision graph coordinates whereas its V2000
    // export rounds to four places. Keep the validated graph coordinates when
    // generating the new V3000 representation (six places).
    graph.atoms.forEach((a, i) => { a.x = data.atoms[i].x; a.y = data.atoms[i].y; a.z = data.atoms[i].z; });
    graph.structure.molecules[0].conformers = [{ dim: 2, coords: graph.atoms.map(a => [a.x, a.y]) }];
    const steps = [];
    for (const edit of edits) {
      if (edit.type === 'setDoubleBondStereo') {
        const i = graph.bonds.findIndex(b => b.id === edit.id), bond = graph.bonds[i];
        if (!bond) fail(`Unknown stable bond ID: ${edit.id}`, 'BOND_NOT_FOUND');
        if (bond.order !== 2 || bond.aromatic) fail('Target is not an ordinary double bond.', 'NOT_SUPPORTED_DOUBLE_BOND');
        const previous = bondConfigurations(current ?? source, graph).get(pair(bond.from, bond.to));
        if (!['cis', 'trans'].includes(bond.stereo) || !previous) fail('E/Z editing requires an already assigned E/Z double bond.', 'UNASSIGNED_DOUBLE_BOND');
        const positions = reflectedSide(graph, bond);
        if (previous === edit.configuration) { steps.push({ ...edit, before: previous, after: previous, changed: false }); continue; }
        let rebuilt, candidate;
        try {
          const j = structuredClone(graph.structure);
          j.molecules[0].bonds[i].stereo = bond.stereo === 'cis' ? 'trans' : 'cis';
          j.molecules[0].conformers = [{ dim: 2, coords: positions }];
          rebuilt = rdkit.get_mol(inputJSON(j), JSON.stringify({ sanitize: true, removeHs: false, assignStereo: false }));
          if (!rebuilt) fail('RDKit rejected E/Z reconstruction.');
          candidate = rdkit.get_mol(restoreMaps(rebuilt.get_v3Kmolblock(), sourceMaps), readOptions);
          if (!candidate) fail('RDKit rejected the regenerated E/Z MOL.');
          const next = remap(candidate, data);
          if (bondConfigurations(candidate, next).get(pair(bond.from, bond.to)) !== edit.configuration) fail('RDKit did not verify the requested absolute E/Z configuration.');
          checkCIP(rdkit, candidate);
          preserve(graph, next, -1, 1e-6, i, positions);
          const beforeQuality = layoutQuality(current ?? source), afterQuality = layoutQuality(candidate);
          if (!afterQuality.valid || ['crossings', 'closeAtoms', 'atomBondClashes'].some(k => afterQuality[k] > beforeQuality[k])) fail('E/Z reflection increases geometric clashes; this layout is unsupported.', 'STEREO_LAYOUT_CLASH');
          current?.delete(); current = candidate; candidate = null; graph = next;
          steps.push({ ...edit, before: previous, after: edit.configuration, changed: true });
        } finally { rebuilt?.delete(); candidate?.delete(); }
        continue;
      }
      const i = graph.atoms.findIndex(a => a.id === edit.id);
      if (i < 0) fail(`Unknown stable atom ID: ${edit.id}`, 'ATOM_NOT_FOUND');
      const a = graph.atoms[i], edges = graph.bonds.filter(b => [b.from, b.to].includes(a.id));
      if (![6, 14].includes(a.atomicNumber) || a.formalCharge !== 0 || a.aromatic || edges.some(b => b.order !== 1 || b.aromatic) ||
          !((edges.length === 4 && a.implicitHydrogens === 0) || (edges.length === 3 && a.implicitHydrogens === 1))) fail('Target must be a neutral tetrahedral carbon/silicon with four single-bonded ligands (including at most one implicit H).', 'NOT_SUPPORTED_TETRAHEDRAL_CENTER');
      if (edit.type === 'invertTetrahedral' && !assigned(a)) fail('Inversion requires an already assigned R/S tetrahedral center.', 'UNASSIGNED_STEREO_CENTER');
      const desired = edit.type === 'invertTetrahedral' ? (a.cip === 'R' ? 'S' : 'R') : edit.configuration;
      if (a.cip === desired) { steps.push({ ...edit, before: a.cip, after: desired, changed: false }); continue; }
      let accepted, acceptedGraph;
      const tags = assigned(a) ? [invert(a.stereo)] : ['cw', 'ccw'];
      for (const tag of tags) {
        let rebuilt, candidate;
        try {
          const j = structuredClone(graph.structure); j.molecules[0].atoms[i].stereo = tag;
          // Manipulate the chemical chiral tag. RDKit generates CFG/wedges from
          // it and the retained coordinates; no hand-edited display wedge.
          rebuilt = rdkit.get_mol(inputJSON(j), JSON.stringify({ sanitize: true, removeHs: false, assignStereo: false }));
          if (!rebuilt) fail('RDKit rejected chemical stereo reconstruction.');
          candidate = rdkit.get_mol(restoreMaps(rebuilt.get_v3Kmolblock(), sourceMaps), readOptions);
          if (!candidate) fail('RDKit rejected the regenerated stereo MOL.');
          const next = remap(candidate, data);
          if (next.atoms[i].cip !== desired || next.atoms[i].stereo !== tag) continue;
          checkCIP(rdkit, candidate);
          preserve(graph, next, i);
          if (!equal(atomRows(candidate.get_v3Kmolblock()).map(row => row[5]), sourceMaps)) fail('Exchange atom maps changed.');
          accepted = candidate; acceptedGraph = next; candidate = null; break;
        } finally { rebuilt?.delete(); candidate?.delete(); }
      }
      if (!accepted) fail('RDKit did not validate the requested R/S center; it may be non-stereogenic, symmetric or unsupported.', 'NOT_STEREOGENIC_OR_UNSUPPORTED');
      current?.delete(); current = accepted; graph = acceptedGraph;
      steps.push({ ...edit, before: a.cip ?? null, after: desired, changed: true });
    }
    const final = current ?? source;
    verifyRoundtrips(rdkit, final, sourceMaps);
    const stereoChanges = graph.atoms.filter((a, i) => a.stereo !== data.atoms[i].stereo || a.cip !== data.atoms[i].cip).map(a => ({
      kind: 'tetrahedral', atomId: a.id,
      before: { configuration: data.atoms[a.index].cip ?? null, tag: data.atoms[a.index].stereo },
      after: { configuration: a.cip ?? null, tag: a.stereo },
    }));
    const changedAtoms = stereoChanges.map(c => ({ id: c.atomId, before: structuredClone(data.atoms.find(a => a.id === c.atomId)), after: structuredClone(graph.atoms.find(a => a.id === c.atomId)) }));
    const beforeBonds = bondConfigurations(source, data), afterBonds = bondConfigurations(final, graph);
    const changedBonds = graph.bonds.filter((b, i) => b.stereo !== data.bonds[i].stereo).map(b => {
      stereoChanges.push({ kind: 'doubleBond', bondId: b.id,
        before: { configuration: beforeBonds.get(pair(b.from, b.to)), tag: data.bonds[b.index].stereo },
        after: { configuration: afterBonds.get(pair(b.from, b.to)), tag: b.stereo } });
      return { id: b.id, before: structuredClone(data.bonds[b.index]), after: structuredClone(b) };
    });
    const movedAtoms = graph.atoms.filter((a, i) => Math.hypot(a.x - data.atoms[i].x, a.y - data.atoms[i].y) > 1e-6)
      .map(a => ({ id: a.id, before: { x: data.atoms[a.index].x, y: data.atoms[a.index].y }, after: { x: a.x, y: a.y } }));
    const delta = { addedAtoms: [], removedAtoms: [], changedAtoms,
      addedBonds: [], removedBonds: [], changedBonds, movedAtoms, stereoChanges, identityPreserved: true,
      summary: `Stereo configuration changed at ${changedAtoms.length} atom(s) and ${changedBonds.length} double bond(s); moved ${movedAtoms.length} atom(s); connectivity and non-target stereo preserved.` };
    if (!current) return { molecule: { ...structuredClone(data), lastEdit: delta,
      stereoEdit: { operations: structuredClone(edits), steps, verification: stereoEditingCapabilities().checks } }, delta };
    const molecule = { ...structuredClone(data), ...graph, smiles: final.get_smiles(), molblock: final.get_v3Kmolblock(),
      ...drawMolecule(final, rdkit.version(), data.drawing?.style ?? 'acs1996'), lastEdit: delta,
      stereoEdit: { operations: structuredClone(edits), steps, verification: stereoEditingCapabilities().checks },
      chemistry: { ...data.chemistry, atomIdentity: 'verified-stereo-edit', options: { ...data.chemistry?.options, coordinates: movedAtoms.length ? 'verified-EZ-reflection-2d' : 'preserved-stereo-edit-2d' } } };
    // These describe an earlier input or layout score, not the edited structure.
    delete molecule.inputSmiles; delete molecule.inputMolblock; delete molecule.layout; delete molecule.depictionAdjustment;
    return { molecule, delta };
  } catch (error) {
    if (error?.code) throw error;
    fail(`Unable to apply stereo edit: ${error?.message ?? 'RDKit rejected structure'}`);
  } finally { current?.delete(); source?.delete(); }
}
