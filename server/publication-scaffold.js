import { _editingToolkit } from '../src/chemistry/index.js';
import { drawTemplateMolecule } from './publication-orientation.js';
import { failure } from './store.js';

const invalid = message => { throw failure('VALIDATION', message); };
const siteToken = /\[\*:([1-9]\d?)\]/g;
const keepHydrogens = JSON.stringify({removeHs:false, sanitize:true});
const simpleSidechains = new Map(Object.entries({
  '[H]*':'H', 'C*':'Me', 'CC*':'Et', 'CO*':'OMe', 'CCO*':'OEt', 'O*':'OH', 'N*':'NH₂',
  'F*':'F', 'Cl*':'Cl', 'Br*':'Br', 'I*':'I', 'FC(F)(F)*':'CF₃', 'N#C*':'CN',
  'O=C*':'CHO', 'O=C(O)*':'CO₂H', 'O=[N+]([O-])*':'NO₂', 'c1ccc(*)cc1':'Ph',
  'CC(=O)*':'COMe', 'COC(=O)*':'COOMe', 'c1ccc(O*)cc1':'OPh', 'c1ccc(S*)cc1':'SPh',
  'Clc1ccc(O*)cc1':'O(4-ClPh)', 'c1ccc(CO*)cc1':'OCH₂Ph',
}));

// Read the publication template separately from the concrete-molecule store. The
// mapped placeholders serve as RDKit attachment labels, never as product atoms.
function readScaffold(rdkit, smiles, siteLabels = {}, orientation) {
  if (typeof smiles !== 'string' || !smiles || smiles.length > 2000 || /[\s.|]/.test(smiles)) {
    invalid('A scaffold requires one connected SMILES with numbered terminal sites such as [*:1].');
  }
  const tokens = [...smiles.matchAll(siteToken)];
  const labels = tokens.map(match=>'R'+match[1]);
  const stripped = smiles.replace(siteToken,'');
  if (!labels.length || labels.length>8 || new Set(labels).size!==labels.length || stripped.includes('*') || /:\d+\]/.test(stripped)) {
    invalid('Use one to eight distinct numbered placeholders [*:1] through [*:99]. Only these atoms may be mapped.');
  }
  const mol = rdkit.get_mol(smiles, keepHydrogens);
  if (!mol) invalid('RDKit could not read the publication scaffold.');
  try {
    const { atoms, bonds } = JSON.parse(mol.get_json()).molecules[0];
    const dummies = atoms.flatMap((atom,i)=>atom.z===0 ? [i] : []);
    if (atoms.length===dummies.length || dummies.length!==labels.length ||
        dummies.some(idx=>bonds.filter(bond=>bond.atoms.includes(idx)).length!==1)) {
      invalid('Each numbered R site must terminate a bond to the scaffold.');
    }
    const aliases=labels.map(label=>siteLabels[label] ?? label);
    if (Object.keys(siteLabels).some(label=>!labels.includes(label)) || new Set(aliases).size!==aliases.length) {
      invalid('Each displayed R label must name one of the declared scaffold sites and be unique.');
    }
    mol.set_new_coords(false);
    const override=Object.fromEntries(dummies.map((idx,i)=>[idx,aliases[i]]));
    const {svg}=drawTemplateMolecule(rdkit,mol,override,orientation);
    return {mol,svg,sites:labels.sort((a,b)=>Number(a.slice(1))-Number(b.slice(1)))};
  } catch (error) { mol.delete(); throw error; }
}

export async function drawPublicationScaffold(smiles, orientation) {
  const {mol,svg,sites} = readScaffold(await _editingToolkit(),smiles,undefined,orientation);
  mol.delete();
  return {svg,sites};
}

function normalizedProduct(rdkit, smiles) {
  // Normalize ordinary explicit H produced by molzip while retaining isotope
  // labels, formal charges and stereochemistry in the canonical SMILES.
  const mol = rdkit.get_mol(smiles);
  try { return mol?.get_smiles(); } finally { mol?.delete(); }
}

export async function resolveScaffoldGroup(document, definition, experiments) {
  if (experiments.some(row=>row.structureRole==='substrate')) {
    invalid('A substrate depiction cannot be decomposed as the product of a scope entry.');
  }
  const rdkit = await _editingToolkit();
  const {mol:core, svg, sites} = readScaffold(rdkit,definition.smiles,definition.siteLabels,definition);
  let decomposition, rows;
  try {
    decomposition = rdkit.get_rgd(core,JSON.stringify({onlyMatchAtRGroups:true,
      removeAllHydrogenRGroups:false, removeAllHydrogenRGroupsAndLabels:false, timeout:3}));
    if (!decomposition) invalid('RDKit could not initialize R-group decomposition.');
    for (const row of experiments) {
      const data = document.objects[row.compoundId]?.data;
      const product = data && rdkit.get_mol(data.molblock,keepHydrogens);
      try {
        if (!product || decomposition.add(product)<0) invalid('Product '+row.id+' does not match the declared scaffold and attachment sites.');
      } finally { product?.delete(); }
    }
    if (!decomposition.process()) invalid('RDKit could not resolve this group at the declared sites.');
    rows = decomposition.get_rgroups_as_rows();
    if (rows.length!==experiments.length) invalid('Incomplete R-group decomposition.');
    const substitutions = new Map();
    for (const [i,row] of rows.entries()) {
      const entry = experiments[i];
      if (row.Core?.get_smiles()!==core.get_smiles() || sites.some(site=>!row[site]) || Object.keys(row).length!==sites.length+1) {
        invalid('RDKit returned a different scaffold or set of positions for '+entry.id+'.');
      }
      const joined = rdkit.molzip(row);
      try {
        const expected = normalizedProduct(rdkit,document.objects[entry.compoundId].data.smiles);
        if (!expected || !joined || normalizedProduct(rdkit,joined.get_smiles())!==expected) {
          invalid('R-group reconstruction does not match the saved product '+entry.id+' including stereochemistry.');
        }
      } finally { joined?.delete(); }
      const cells = sites.map(site=>{
        const smiles = row[site].get_smiles();
        const fragment = smiles.replace(siteToken,'*');
        return {site:definition.siteLabels?.[site] ?? site,smiles,label:simpleSidechains.get(fragment) ?? smiles};
      });
      substitutions.set(entry.id,cells);
    }
    return {svg,sites,substitutions};
  } finally {
    for (const row of rows || []) for (const handle of Object.values(row)) handle.delete();
    decomposition?.delete(); core.delete();
  }
}
