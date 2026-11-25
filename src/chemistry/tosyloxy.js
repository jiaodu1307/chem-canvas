// Only the neutral covalent O-tosyl ester. Ring H counts and degrees exclude
// substituted tosyl variants. The first atom is the external point of attachment.
const pattern = '[#6]-[O;D2;+0]-[S;D4;+0](=[O;D1;+0])(=[O;D1;+0])-[c;D3]1[cH;D2][cH;D2][c;D3]([CH3;D1])[cH;D2][cH;D2]1';

function sameStereo(source, display, atomMap) {
  const before = JSON.parse(source.get_stereo_tags());
  const after = JSON.parse(display.get_stereo_tags());
  return ['CIP_atoms','CIP_bonds'].every(key => {
    const mapped = before[key].map(row => [...row.slice(0,-1).map(i => atomMap.get(i)),row.at(-1)]);
    return JSON.stringify(mapped) === JSON.stringify(after[key]);
  });
}

// JS MinimalLib exposes the default abbreviation catalogue only. Render the
// exact matched groups on a disposable RDKit drawing copy. Retain the O atom,
// its coordinates and its external bond, including its chiral neighbor.
export function drawTosyloxy(kit, mol, labels, rotationDegrees, render) {
  if (!kit) return render(mol, labels);
  const smiles = mol.get_smiles();
  if (!smiles.includes('S') || /@(SP|TB|OH|AL)/.test(smiles)) return render(mol, labels);
  const q = kit.get_qmol(pattern);
  let drawn;
  try {
    const matches = JSON.parse(mol.get_substruct_matches(q));
    if (!matches.length) return render(mol, labels);
    const original = JSON.parse(mol.get_json());
    const graph = original.molecules[0];
    // These CTAB features cannot be represented faithfully by filtering RDKit
    // JSON atom indices. Keep the original drawing in those cases.
    const ctab = mol.get_v3Kmolblock();
    if (/BEGIN (?:SGROUP|COLLECTION)|\bENDPTS=|^M  V30 \d+ \S+ \S+ \S+ \S+ [1-9]\d*\b/m.test(ctab) ||
        graph.atoms.some(a => a.z === 0) || graph.bonds.some(b => (b.bo ?? 1) > 3)) return render(mol, labels);

    const coords = graph.conformers?.[0]?.coords;
    if (!coords || graph.conformers[0].dim !== 2) return render(mol, labels);
    const oxygens = new Map(), hidden = new Set();
    const angle = rotationDegrees * Math.PI / 180;
    for (const {atoms:[attachment, oxygen, ...group]} of matches) {
      if ([oxygen, ...group].some(i => {
        const a = graph.atoms[i];
        return labels?.[i] != null || a.isotope || a.chg || a.nRad || a.stereo;
      })) continue;
      // MolDraw2D chooses east for nearly vertical terminal bonds and
      // otherwise places the text on the side opposite the attachment.
      const dx = coords[oxygen][0] - coords[attachment][0];
      const dy = coords[oxygen][1] - coords[attachment][1];
      const x = dx * Math.cos(angle) - dy * Math.sin(angle);
      const y = dx * Math.sin(angle) + dy * Math.cos(angle);
      const west = x < -0.0001 && Math.abs(y/x) <= Math.tan(70*Math.PI/180);
      oxygens.set(oxygen, west ? 'TsO' : 'OTs');
      group.forEach(i => hidden.add(i));
    }
    if (!oxygens.size || graph.bonds.some(b => b.stereoAtoms?.some(i => hidden.has(i)))) return render(mol, labels);

    const atomMap = new Map(), newLabels = {};
    const atoms = [], bonds = [];
    for (const [i, atom] of graph.atoms.entries()) {
      if (hidden.has(i)) continue;
      atomMap.set(i, atoms.length);
      if (oxygens.has(i)) newLabels[atoms.length] = oxygens.get(i);
      else if (labels?.[i] != null) newLabels[atoms.length] = labels[i];
      atoms.push(oxygens.has(i) ? {...atom, impHs:1} : atom);
    }
    for (const bond of graph.bonds) {
      if (bond.atoms.some(j => hidden.has(j))) continue;
      bonds.push({...bond, atoms:bond.atoms.map(j => atomMap.get(j)),
        ...(bond.stereoAtoms && {stereoAtoms:bond.stereoAtoms.map(j => atomMap.get(j))})});
    }
    // CommonChem requires doubles for coordinates, including zero and whole numbers.
    const conformers = graph.conformers?.map(c => ({...c, coords:c.coords.filter((_,i) => atomMap.has(i))
      .map(point => point.map(value => JSON.rawJSON(value.toExponential())))}));
    try {
      drawn = kit.get_mol(JSON.stringify({...original, molecules:[{atoms,bonds,conformers}]}));
    } catch { return render(mol, labels); }
    if (!drawn || !drawn.is_valid() || !sameStereo(mol, drawn, atomMap)) return render(mol, labels);
    const result = render(drawn, newLabels);
    const aliases = [...oxygens.values()].join(',');
    result.svg = result.svg.replace(/<svg\b[^>]*>/, tag => tag +
      '<desc data-chem-canvas-abbreviations="' + aliases + '">Tosyloxy ester labels</desc>');
    return result;
  } finally { drawn?.delete(); q.delete(); }
}
