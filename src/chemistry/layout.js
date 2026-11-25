// Coordinates are presentation; compare indexed chemistry and stereo before accepting.
export const layoutFailure = (message) => Object.assign(new Error(message), { code: 'VALIDATION' });
export function chemicalSignature(mol) {
  const j = JSON.parse(mol.get_json()), m = j.molecules[0];
  const rep = m.extensions?.find(e => e.name === 'rdkitRepresentation') ?? {};
  const aromatic = new Set(rep.aromaticBonds ?? []);
  return JSON.stringify({
    atoms: m.atoms.map(a => ({ ...j.defaults.atom, ...a })),
    bonds: m.bonds.map((b, i) => ({ ...j.defaults.bond, ...b, atoms:[...b.atoms].sort((a,b)=>a-b), ...(aromatic.has(i) ? { bo: 'aromatic' } : {}) })),
    aromaticAtoms: rep.aromaticAtoms ?? [], aromaticBonds: rep.aromaticBonds ?? [],
    stereo: JSON.parse(mol.get_stereo_tags()), inchi: mol.get_inchi(),
  });
}

export function layoutQuality(mol) {
  const m = JSON.parse(mol.get_json()).molecules[0], p = m.conformers?.[0]?.coords;
  if (!p || p.length !== m.atoms.length || p.some(a => a.some(v => !Number.isFinite(v)) || Math.abs(a[2] ?? 0) > 1e-5)) return { valid: false };
  const edges = m.bonds.map(b => b.atoms), lengths = edges.map(([a,b]) => Math.hypot(p[a][0]-p[b][0],p[a][1]-p[b][1]));
  if (lengths.some(l => l < 1e-5)) return { valid: false };
  const unit = [...lengths].sort((a,b)=>a-b)[Math.floor(lengths.length/2)] ?? 1;
  const pairs = new Set(edges.map(([a,b])=>[a,b].sort((a,b)=>a-b).join(':')));
  let closeAtoms = 0, crossings = 0, atomBondClashes = 0;
  const cross = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  for (let i=0;i<p.length;i++) for (let k=i+1;k<p.length;k++) if (!pairs.has(`${i}:${k}`) && Math.hypot(p[i][0]-p[k][0],p[i][1]-p[k][1]) < unit*0.45) closeAtoms++;
  for (let i=0;i<edges.length;i++) {
    const [a,b]=edges[i];
    for (let k=i+1;k<edges.length;k++) {
      const [c,d]=edges[k]; if ([a,b].includes(c)||[a,b].includes(d)) continue;
      if (cross(p[a],p[b],p[c])*cross(p[a],p[b],p[d]) < -1e-8 && cross(p[c],p[d],p[a])*cross(p[c],p[d],p[b]) < -1e-8) crossings++;
    }
    for (let k=0;k<p.length;k++) {
      if (k===a||k===b) continue;
      const dx=p[b][0]-p[a][0],dy=p[b][1]-p[a][1];
      const t=((p[k][0]-p[a][0])*dx+(p[k][1]-p[a][1])*dy)/(dx*dx+dy*dy);
      if(t>0.05&&t<0.95&&Math.hypot(p[k][0]-p[a][0]-t*dx,p[k][1]-p[a][1]-t*dy)<unit*0.2) atomBondClashes++;
    }
  }
  const distortion = lengths.reduce((s,l)=>s+Math.abs(l/unit-1),0)/Math.max(1,lengths.length);
  return { valid:true, closeAtoms, crossings, atomBondClashes, distortion, score:closeAtoms*100+atomBondClashes*30+crossings*10+distortion };
}

// Return an owned copy. Always keep existing 2D geometry on score ties.
export function chooseLayout(rdkit, source, { strategy='auto', preserve=false }={}) {
  if (!['auto','rdkit','coordgen'].includes(strategy)) throw layoutFailure('Unknown layout strategy; use auto, rdkit or coordgen.');
  const signature = chemicalSignature(source), candidates=[], failures=[];
  const tryCandidate = (method) => {
    let m, rt;
    try {
      m=source.copy();
      if(method!=='preserved' && !m.set_new_coords(method==='coordgen')) throw Error('Coordinate generation failed.');
      const quality=layoutQuality(m);
      if(!quality.valid) throw Error('No usable finite 2D geometry.');
      if(chemicalSignature(m)!==signature) throw Error('Indexed graph or stereo changed during layout.');
      rt=rdkit.get_mol(m.get_molblock(),JSON.stringify({removeHs:false,sanitize:true}));
      if(!rt || chemicalSignature(rt)!==signature) throw Error('MOL roundtrip changed indexed chemistry or stereochemistry.');
      candidates.push({method,quality,mol:m}); m=null;
    } catch(e) { failures.push({method,message:e.message ?? String(e)}); }
    finally {m?.delete();rt?.delete();}
  };
  if(source.has_coords()===2 && (preserve || strategy==='auto')) tryCandidate('preserved');
  if(!preserve || !candidates.length) for(const method of strategy==='auto'?['rdkit','coordgen']:[strategy]) tryCandidate(method);
  if(!candidates.length) throw layoutFailure(`No faithful 2D layout candidate: ${JSON.stringify(failures)}`);
  // Ignore small floating point/bond distortion improvements: preserve a human
  // layout unless a candidate is meaningfully better. Stable sort keeps ties.
  const best=Math.min(...candidates.map(c=>c.quality.score));
  const chosen=candidates.find(c=>c.quality.score<=best+0.05);
  const report={strategy,method:chosen.method,quality:chosen.quality,candidates:candidates.map(({method,quality})=>({method,quality})),failures,
    warnings:chosen.quality.crossings||chosen.quality.closeAtoms||chosen.quality.atomBondClashes ? ['Geometry still contains crossings or crowded atoms; review the depiction.'] : [],
    verification:['indexed-graph','indexed-CIP','InChI','MOL-roundtrip'],
    limitations:['Geometry scores do not measure text glyph overlap or guarantee conventional textbook orientation.','CoordGen request uses the installed WASM build; identical candidates do not prove backend availability.']};
  candidates.filter(c=>c!==chosen).forEach(c=>c.mol.delete());
  return {mol:chosen.mol,layout:report};
}
