import { drawMolecule } from '../src/chemistry/drawing.js';
import { failure } from './store.js';

export const orientationProperties = {
  rotationDegrees: {type:'number',minimum:-180,maximum:180,description:'Positive counterclockwise, with labels upright.'},
  mirrorY: {type:'boolean',description:'Reflect display y coordinates before rotation. Requires a template without stereocentres or potentially stereogenic double bonds.'},
};

function canReflect(mol, block) {
  const tags=JSON.parse(mol.get_stereo_tags());
  if (tags.CIP_atoms.length || tags.CIP_bonds.length || /\bCFG=|BEGIN COLLECTION/.test(block)) return false;
  const graph=JSON.parse(mol.get_json()).molecules[0];
  const aromatic=new Set(graph.extensions.find(e=>e.name==='rdkitRepresentation')?.aromaticBonds);
  const bonds=graph.bonds ?? [];
  const degree=Array(graph.atoms.length).fill(0);
  for (const {atoms:[a,b]} of bonds) {degree[a]++;degree[b]++;}
  // Stereo tags do not include every unspecified alkene. Conservatively retain
  // the original orientation when both ends have other non-H neighbours.
  return !bonds.some(({atoms:[a,b],bo},i)=>bo===2 && !aromatic.has(i) && degree[a]>1 && degree[b]>1);
}

export function drawTemplateMolecule(kit, mol, labels, {rotationDegrees,mirrorY,abbreviations} = {}) {
  if (!mirrorY) return drawMolecule(mol,kit.version(),'acs1996',labels,rotationDegrees,abbreviations,false,kit);
  const block=mol.get_v3Kmolblock();
  if (!canReflect(mol,block)) throw failure('VALIDATION','Cannot mirror a template containing an actual or potential stereocentre or stereogenic double bond.');
  const reflected=block.replace(/M  V30 BEGIN ATOM[\s\S]*?M  V30 END ATOM/,section=>
    section.replace(/^(M  V30 \d+ \S+ \S+ )([-+.\deE]+)/gm,(_line,prefix,y)=>prefix+String(-Number(y))));
  const display=kit.get_mol(reflected,JSON.stringify({removeHs:false,strictParsing:true}));
  try {
    const endpoints=text=>text.match(/ENDPTS=\([^)]*\) ATTACH=ANY/g)?.join('\n');
    if (!display || display.get_smiles()!==mol.get_smiles() || endpoints(display.get_v3Kmolblock())!==endpoints(block)) {
      throw failure('VALIDATION','RDKit could not verify the reflected template.');
    }
    return drawMolecule(display,kit.version(),'acs1996',labels,rotationDegrees,abbreviations,false,kit);
  } finally {display?.delete();}
}
