// Confirm the side of each specified ligand at the actual drawn double bond.
// Condensed dummy atoms do not have the original ligand's CIP priority.
function planarRelation(graph, bond) {
  const conformer=graph.conformers?.[0];
  if (conformer?.dim!==2 || bond.stereoAtoms?.length!==2) return null;
  const [a,b]=bond.atoms.map(i=>conformer.coords[i]);
  const dx=b[0]-a[0], dy=b[1]-a[1];
  const sides=bond.stereoAtoms.map((i,side)=>{
    const ligand=conformer.coords[i], origin=side===0?a:b;
    const x=ligand[0]-origin[0], y=ligand[1]-origin[1];
    const sine=(dx*y-dy*x)/(Math.hypot(dx,dy)*Math.hypot(x,y));
    return Number.isFinite(sine) && Math.abs(sine)>0.2 ? Math.sign(sine) : 0;
  });
  if (sides.includes(0)) return null;
  return sides[0]===sides[1]?'cis':'trans';
}

function retainedStereo(bond, index, original, condensed, mapping, hidden) {
  if (!bond.stereo) return true;
  if (bond.atoms.some(hidden)) return false;
  if (!bond.stereoAtoms?.some(hidden)) return true;
  // A group may stand for its original point of attachment (e.g. C in CF3).
  // Require both native neighbors and the same geometry in both sets of 2D coordinates.
  const drawn=condensed.bonds[mapping.bonds.indexOf(index)];
  if (bond.bo!==2 || !['cis','trans'].includes(bond.stereo) || drawn?.stereo!==bond.stereo ||
      drawn.stereoAtoms?.length!==2 || bond.stereoAtoms.length!==2) return false;
  if (!drawn.atoms.every((i,k)=>mapping.atoms[i]===bond.atoms[k]) ||
      !drawn.stereoAtoms.every((i,k)=>mapping.atoms[i]===bond.stereoAtoms[k])) return false;
  return planarRelation(original,bond)===bond.stereo && planarRelation(condensed,drawn)===bond.stereo;
}

// RDKit replaces matched groups with labelled dummy atoms. Always perform this
// operation on a drawing copy; the original indices are still used for edits,
// stereo, R-group decomposition and the saved MOL.
export function drawJournalAbbreviations(mol, labels, render) {
  const display=mol.copy();
  try {
    const original=JSON.parse(mol.get_json()).molecules[0];
    const mapping=JSON.parse(display.condense_abbreviations(0.4,false));
    const {atoms}=mapping;
    if (atoms.length===original.atoms.length) return render(mol,labels);
    const condensed=JSON.parse(display.get_json()).molecules[0];
    const retained=new Set(atoms.filter((id,i)=>condensed.atoms[i].z!==0 || original.atoms[id].z===0));
    const hidden=id=>!retained.has(id);
    // Neutral nitro is commonly encoded as [N+](=O)[O-]. Other hidden
    // formal charges stay explicit, including protonated carbonyl oxygens.
    const nitroCharges=new Set();
    for (const [id,a] of original.atoms.entries()) {
      if (!hidden(id) || a.z!==7 || a.chg!==1) continue;
      const neighbors=original.bonds.filter(b=>b.atoms.includes(id)).map(b=>[b.bo ?? 1,b.atoms.find(j=>j!==id)]);
      const anion=neighbors.find(([order,j])=>order===1 && hidden(j) && original.atoms[j].z===8 && original.atoms[j].chg===-1);
      if (anion && neighbors.some(([order,j])=>order===2 && hidden(j) && original.atoms[j].z===8)) {
        nitroCharges.add(id);nitroCharges.add(anion[1]);
      }
    }
    const protectedAtom=(a,id)=>hidden(id) && (a.isotope || a.nRad || a.stereo || a.z===1 ||
      (a.chg && !nitroCharges.has(id)) || labels?.[id]!=null);
    if (original.atoms.some(protectedAtom) ||
        !original.bonds.every((b,i)=>retainedStereo(b,i,original,condensed,mapping,hidden))) return render(mol,labels);
    const block=mol.get_v3Kmolblock();
    const atomLines=block.slice(block.indexOf('BEGIN ATOM'),block.indexOf('END ATOM'));
    for (const match of atomLines.matchAll(/^M  V30 (\d+) \S+ \S+ \S+ \S+ ([1-9]\d*)\b/gm)) {
      if (hidden(Number(match[1])-1)) return render(mol,labels);
    }

    // The built-in CHO rule also matches formates and formamides. Preserve
    // their expanded heteroatom–formyl linkage rather than showing an aldehyde.
    const bonds=original.bonds;
    for (const [i,id] of atoms.entries()) {
      const a=original.atoms[id];
      if (condensed.atoms[i].z!==0 || (a.z ?? 6)!==6 || a.impHs!==1) continue;
      const linked=bonds.filter(b=>b.atoms.includes(id)).map(b=>[b.bo ?? 1,original.atoms[b.atoms.find(j=>j!==id)].z ?? 6]);
      if (linked.some(([order,z])=>order===2 && z===8) && linked.some(([order,z])=>order===1 && z!==6)) return render(mol,labels);
    }
    const mapped=labels && Object.fromEntries(Object.entries(labels).map(([id,label])=>[atoms.indexOf(Number(id)),label]));
    // A position-variation bond carries a separate list of alternative atom
    // indices in MDL. Check it after condensation, in original atom space.
    if (labels) {
      const siteSets=(molblock,mapping)=>Array.from(molblock.matchAll(/ENDPTS=\(\d+ ([\d ]+)\) ATTACH=ANY/g),
        m=>m[1].trim().split(/\s+/).map(s=>mapping ? mapping[Number(s)-1] : Number(s)-1).sort((a,b)=>a-b));
      if (JSON.stringify(siteSets(block))!==JSON.stringify(siteSets(display.get_v3Kmolblock(),atoms))) return render(mol,labels);
    }
    const result=render(display,mapped);
    const cx=display.get_cxsmiles();
    // The outline paths in a print SVG contain no editable text. Identify the
    // actual native aliases in a non-printing description for inspection.
    const aliases=(cx.match(/(?:\||,)\$([^$]*)\$/)?.[1] || '').split(';').filter(s=>/^[A-Za-z][A-Za-z0-9()+-]*$/.test(s));
    if (aliases.length) result.svg=result.svg.replace(/<svg\b[^>]*>/,m=>m+'<desc data-rdkit-abbreviations="'+aliases.join(',')+'">RDKit: '+aliases.join(', ')+'</desc>');
    return result;
  } finally {display.delete();}
}
