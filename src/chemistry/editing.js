import { _editingToolkit, _editingGraph } from './index.js';
import { drawMolecule } from './drawing.js';
import { applyStereoEdits, STEREO_EDIT_TYPES } from './stereo-editing.js';

const elements = ('* H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' ');
const fail = (message) => { throw Object.assign(new Error(message), { code: 'VALIDATION' }); };
const smilesOptions = JSON.stringify({ canonical: true, isomericSmiles: true });
const readOptions = JSON.stringify({ sanitize: true, removeHs: false });
const key = (a, b) => [a, b].sort().join('|');
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id);
const point = (x, y) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 100000 && Math.abs(y) <= 100000;
function atomCheck(a) {
  if (!validId(a.id) || !Number.isInteger(a.atomicNumber) || a.atomicNumber < 1 || a.atomicNumber > 118 ||
      !Number.isInteger(a.formalCharge ?? 0) || Math.abs(a.formalCharge ?? 0) > 8 ||
      !Number.isInteger(a.isotope ?? 0) || (a.isotope ?? 0) < 0 || (a.isotope ?? 0) > 400 || !point(a.x, a.y)) fail('Invalid atom properties or coordinates.');
}
function records(block, section) {
  const text = block.split(`M  V30 BEGIN ${section}\n`)[1]?.split(`M  V30 END ${section}`)[0] ?? '';
  if (text.includes('-\n')) fail('Extended V3000 records are not supported for local editing.');
  return text.trim().split('\n').filter(Boolean).map((line) => line.replace(/^M  V30 /, '').trim().split(/\s+/));
}
function ensureFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((field) => !fields.includes(field))) fail('Unsupported edit property.');
}

export async function editMolecule(dataOrNull, edits, options = {}) {
  if(dataOrNull?.coordinationStereo) fail('Replace the molecule with a stereospecified MOL or SMILES to edit this coordination geometry.');
  if (!Array.isArray(edits) || !edits.length || edits.length > 500) fail('Provide 1–500 graph edits.');
  if (!options || typeof options !== 'object' || (options.idPrefix !== undefined && !validId(options.idPrefix))) fail('Invalid idPrefix.');
  if (edits.some(edit => STEREO_EDIT_TYPES.includes(edit?.type))) return applyStereoEdits(dataOrNull, edits);
  const rdkit = await _editingToolkit();
  const handles = [];
  const read = (block) => { const m = rdkit.get_mol(block, readOptions); if (!m || !m.is_valid()) { m?.delete(); fail('RDKit rejected the edited structure (syntax or valence).'); } handles.push(m); return m; };
  try {
    let atoms = [], bonds = [], sourceSmiles = null;
    const atomExtra = new Map(), bondExtra = new Map(), sourceMaps = new Map(), sourceDirections = new Map();
    if (dataOrNull !== null) {
      if (!dataOrNull || typeof dataOrNull.molblock !== 'string' || dataOrNull.molblock.length > 200000 || !Array.isArray(dataOrNull.atoms) || !Array.isArray(dataOrNull.bonds)) fail('A complete existing molecule or null is required.');
      const source = read(dataOrNull.molblock);
      sourceSmiles = source.get_smiles(smilesOptions);
      if (sourceSmiles !== dataOrNull.smiles) fail('Existing MOL and SMILES disagree.');
      const verified = _editingGraph(JSON.parse(source.get_json()), 'verify');
      if (verified.atoms.length !== dataOrNull.atoms.length || verified.bonds.length !== dataOrNull.bonds.length) fail('Existing graph does not match MOL.');
      atoms = structuredClone(dataOrNull.atoms); bonds = structuredClone(dataOrNull.bonds);
      const v3 = source.get_v3Kmolblock();
      const ar = records(v3, 'ATOM'), br = records(v3, 'BOND');
      atoms.forEach((a, i) => {
        atomCheck(a);
        if (a.index !== i || ['atomicNumber', 'formalCharge', 'isotope', 'radicalElectrons', 'implicitHydrogens', 'stereo', 'aromatic'].some((p) => (a[p] ?? 0) !== (verified.atoms[i][p] ?? 0)) || +ar[i]?.[0] !== i + 1) fail('Existing atom indices/properties do not match MOL.');
        if (Math.abs(verified.atoms[i].z ?? 0) > 0.00001) fail('Local editing supports 2D coordinates only.');
        if (Math.hypot(a.x - verified.atoms[i].x, a.y - verified.atoms[i].y) > 0.001) fail('Existing graph coordinates do not match MOL.');
        atomExtra.set(a.id, ar[i].slice(6).filter((v) => !/^(CHG|MASS)=/.test(v)));
        sourceMaps.set(a.id, ar[i][5]);
      });
      bonds.forEach((b, i) => {
        const v = verified.bonds[i];
        const ends = [atoms[+br[i]?.[2] - 1]?.id, atoms[+br[i]?.[3] - 1]?.id];
        if (b.index !== i || !validId(b.id) || key(b.from,b.to) !== key(...ends) || (b.order !== v.order && !(b.aromatic && v.aromatic && [1,2].includes(b.order) && [1,2].includes(v.order))) || b.stereo !== v.stereo || b.aromatic !== v.aromatic || ![1, 2, 3].includes(b.order)) fail('Existing bond indices/endpoints do not match MOL or unsupported bond order.');
        sourceDirections.set(b.id, ends);
        bondExtra.set(b.id, br[i].slice(4));
      });
    }
    const beforeAtoms = structuredClone(atoms), beforeBonds = structuredClone(bonds);
    const used = new Set([...atoms, ...bonds].map((item) => item.id));
    if (used.size !== atoms.length + bonds.length) fail('Atom and bond IDs must be globally unique.');
    const retired = dataOrNull?.identityLedger?.retiredIds ?? [];
    if (!Array.isArray(retired) || retired.some((id) => !validId(id) || used.has(id))) fail('Invalid retired identity ledger.');
    retired.forEach((id) => used.add(id));
    const chemical = edits.some((e) => e?.type !== 'moveAtom');
    if (chemical && (atoms.some((a) => a.radicalElectrons || (a.stereo && a.stereo !== 'unspecified')) || bonds.some((b) => b.stereo && b.stereo !== 'unspecified') || [...atomExtra.values()].some((values) => values.some((v) => /^(VAL|HCOUNT|CFG)=/.test(v))))) {
      fail('Chemical edits of stereo, radical or explicit-valence structures are not yet supported; coordinate-only edits preserve and verify them.');
    }
    const atom = (id) => atoms.find((a) => a.id === id) ?? fail(`Atom not found: ${id}`);
    const bond = (id) => bonds.find((b) => b.id === id) ?? fail(`Bond not found: ${id}`);
    const reserve = (id) => { if (!validId(id) || used.has(id)) fail('New IDs must be unique and cannot reuse deleted IDs.'); used.add(id); };
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object') fail('Invalid edit.');
      switch (edit.type) {
        case 'addAtom': {
          ensureFields(edit.atom, ['id', 'atomicNumber', 'x', 'y', 'formalCharge', 'isotope']);
          const a = { formalCharge: 0, isotope: 0, ...edit.atom }; atomCheck(a); reserve(a.id); atoms.push(a); break;
        }
        case 'updateAtom': ensureFields(edit.patch, ['atomicNumber', 'formalCharge', 'isotope']); Object.assign(atom(edit.id), edit.patch); atomCheck(atom(edit.id)); break;
        case 'moveAtom': if (!point(edit.x, edit.y)) fail('Invalid atom coordinates.'); Object.assign(atom(edit.id), { x: edit.x, y: edit.y }); break;
        case 'deleteAtom': atom(edit.id); atoms = atoms.filter((a) => a.id !== edit.id); bonds = bonds.filter((b) => b.from !== edit.id && b.to !== edit.id); break;
        case 'addBond': ensureFields(edit.bond, ['id', 'from', 'to', 'order']); reserve(edit.bond.id); atom(edit.bond.from); atom(edit.bond.to); bonds.push({ ...edit.bond }); break;
        case 'updateBond': ensureFields(edit.patch, ['order']); if (edit.patch.order !== undefined && edit.patch.order !== bond(edit.id).order) bond(edit.id).aromatic = false; Object.assign(bond(edit.id), edit.patch); break;
        case 'deleteBond': bond(edit.id); bonds = bonds.filter((b) => b.id !== edit.id); break;
        default: fail(`Unsupported edit type: ${edit.type}`);
      }
    }
    if (!atoms.length || atoms.length > 2000) fail('Final graph must contain 1–2000 atoms; delete an empty molecule separately.');
    const positions = new Map(atoms.map((a, i) => [a.id, i + 1]));
    const pairs = new Set();
    for (const b of bonds) {
      const pair = key(b.from, b.to);
      if (!positions.has(b.from) || !positions.has(b.to) || b.from === b.to || ![1, 2, 3].includes(b.order) || pairs.has(pair)) fail('Invalid bond order, duplicate bond or endpoint.');
      pairs.add(pair);
      const a = atom(b.from), c = atom(b.to);
      if (Math.hypot(a.x - c.x, a.y - c.y) < 0.05) fail('Connected atoms must have distinct coordinates (distance at least 0.05).');
    }
    const atomLines = atoms.map((a, i) => `M  V30 ${i + 1} ${elements[a.atomicNumber]} ${a.x.toFixed(6)} ${a.y.toFixed(6)} 0 ${i + 1}${a.formalCharge ? ` CHG=${a.formalCharge}` : ''}${a.isotope ? ` MASS=${a.isotope}` : ''}${atomExtra.get(a.id)?.length ? ` ${atomExtra.get(a.id).join(' ')}` : ''}`);
    const bondLines = bonds.map((b, i) => {
      // Wedge CFG is relative to the serialized start atom, not graph ID order.
      const [from,to] = sourceDirections.get(b.id) ?? [b.from,b.to];
      return `M  V30 ${i + 1} ${b.order} ${positions.get(from)} ${positions.get(to)}${bondExtra.get(b.id)?.length ? ` ${bondExtra.get(b.id).join(' ')}` : ''}`;
    });
    const taggedBlock = ['','  ChemCanvas        2D','','  0  0  0     0  0            999 V3000','M  V30 BEGIN CTAB',`M  V30 COUNTS ${atoms.length} ${bonds.length} 0 0 0`,'M  V30 BEGIN ATOM',...atomLines,'M  V30 END ATOM','M  V30 BEGIN BOND',...bondLines,'M  V30 END BOND','M  V30 END CTAB','M  END',''].join('\n');
    const tagged = read(taggedBlock);
    const outputBlock = tagged.get_v3Kmolblock();
    const outputAtoms = records(outputBlock, 'ATOM');
    if (outputAtoms.length !== atoms.length || outputAtoms.some((row, i) => +row[0] !== i + 1 || +row[5] !== i + 1)) fail('RDKit reordered atoms; identity correspondence could not be verified.');
    // Aromaticity must come from RDKit's sanitized edited graph, not from the
    // caller's old flags: newly drawn alternating rings have no aromatic flags.
    // Subsequent MOL roundtrips can legitimately choose the other Kekule form.
    const perceived = _editingGraph(JSON.parse(tagged.get_json()), 'perceived');
    const perceivedIds = new Map(perceived.atoms.map((a, i) => [a.id, atoms[i].id]));
    const perceivedAromaticPairs = new Set(perceived.bonds.filter((b) => b.aromatic)
      .map((b) => key(perceivedIds.get(b.from), perceivedIds.get(b.to))));
    let inAtoms = false;
    const cleanBlock = outputBlock.split('\n').map((line) => {
      if (line === 'M  V30 BEGIN ATOM') { inAtoms = true; return line; }
      if (line === 'M  V30 END ATOM') { inAtoms = false; return line; }
      if (!inAtoms) return line;
      const row = line.slice(7).split(/\s+/); row[5] = sourceMaps.get(atoms[+row[0] - 1].id) ?? '0'; return `M  V30 ${row.join(' ')}`;
    }).join('\n');
    const final = read(cleanBlock);
    const molblock = final.get_v3Kmolblock(), smiles = final.get_smiles(smilesOptions);
    const finalRows = records(molblock, 'ATOM');
    if (finalRows.some((row, i) => row[5] !== (sourceMaps.get(atoms[i].id) ?? '0'))) fail('Exchange atom maps were not preserved.');
    if (!chemical && smiles !== sourceSmiles) fail('Coordinate change would alter stereochemistry; original molecule is preserved.');
    const structure = JSON.parse(final.get_json());
    const graph = _editingGraph(structure, 'temporary');
    if (graph.atoms.length !== atoms.length || graph.bonds.length !== bonds.length) fail('RDKit changed graph size; identities cannot be preserved.');
    const indexIds = new Map(graph.atoms.map((a, i) => [a.id, atoms[i].id]));
    graph.atoms.forEach((a, i) => {
      const intended = atoms[i];
      if (a.atomicNumber !== intended.atomicNumber || a.formalCharge !== intended.formalCharge || a.isotope !== intended.isotope || Math.hypot(a.x - intended.x, a.y - intended.y) > 0.00001) fail('Edited atom properties or coordinates were not retained.');
      a.id = intended.id;
    });
    const intendedBonds = new Map(bonds.map((b) => [key(b.from, b.to), b]));
    graph.bonds.forEach((b) => {
      b.from = indexIds.get(b.from); b.to = indexIds.get(b.to);
      const intended = intendedBonds.get(key(b.from, b.to));
      const perceivedAromatic = perceivedAromaticPairs.has(key(b.from, b.to));
      if (!intended || b.aromatic !== perceivedAromatic ||
          (b.order !== intended.order && !(b.aromatic && [1, 2].includes(b.order) && [1, 2].includes(intended.order)))) fail('Edited bond connectivity/order was not retained.');
      b.id = intended.id;
      b.from = intended.from; b.to = intended.to;
      if (b.stereoAtoms) b.stereoAtoms = b.stereoAtoms.map((id) => indexIds.get(id));
    });
    const delta = diff(beforeAtoms, beforeBonds, graph.atoms, graph.bonds);
    const molecule = { smiles, molblock, ...graph, structure, ...drawMolecule(final, rdkit.version()),
      chemistry: { tool: 'RDKit', version: rdkit.version(), adapter: 'rdkit-wasm', atomIdentity: 'verified-local-edit', atomMapping: 'temporary-map-tags-verified',
        options: { canonical: true, isomericSmiles: true, sanitize: true, removeHs: false, coordinates: 'preserved-editor-2d' } },
      warnings: [], lastEdit: delta,
      identityLedger: { retiredIds: [...used].filter((id) => !graph.atoms.some((a) => a.id === id) && !graph.bonds.some((b) => b.id === id)) } };
    return { molecule, delta };
  } catch (error) { if (error?.code === 'VALIDATION') throw error; fail(`Unable to edit molecule: ${error?.message ?? 'RDKit rejected structure'}`); }
  finally { handles.forEach((m) => m.delete()); }
}

function diff(oldAtoms, oldBonds, atoms, bonds) {
  const result = { addedAtoms: [], removedAtoms: [], changedAtoms: [], addedBonds: [], removedBonds: [], changedBonds: [], movedAtoms: [], summary: '', identityPreserved: true };
  for (const [kind, before, after, fields] of [
    ['Atoms', oldAtoms, atoms, ['atomicNumber', 'formalCharge', 'isotope', 'implicitHydrogens', 'radicalElectrons', 'stereo', 'aromatic', 'cip']],
    ['Bonds', oldBonds, bonds, ['from', 'to', 'order', 'aromatic', 'stereo', 'stereoAtoms']],
  ]) {
    const old = new Map(before.map((v) => [v.id, v])), current = new Map(after.map((v) => [v.id, v]));
    result[`added${kind}`] = after.filter((v) => !old.has(v.id));
    result[`removed${kind}`] = before.filter((v) => !current.has(v.id));
    for (const v of after) {
      const previous = old.get(v.id); if (!previous) continue;
      if (fields.some((field) => !(kind === 'Bonds' && field === 'order' && previous.aromatic && v.aromatic) && JSON.stringify(previous[field]) !== JSON.stringify(v[field]))) result[`changed${kind}`].push({ id: v.id, before: previous, after: v });
      if (kind === 'Atoms' && Math.hypot(previous.x - v.x, previous.y - v.y) > 0.00001) result.movedAtoms.push({ id: v.id, before: { x: previous.x, y: previous.y }, after: { x: v.x, y: v.y } });
    }
  }
  result.summary = `Atoms +${result.addedAtoms.length}/-${result.removedAtoms.length}/changed ${result.changedAtoms.length}; bonds +${result.addedBonds.length}/-${result.removedBonds.length}/changed ${result.changedBonds.length}; moved ${result.movedAtoms.length}.`;
  return result;
}

