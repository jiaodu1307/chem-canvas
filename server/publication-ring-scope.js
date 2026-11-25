import { _editingToolkit } from '../src/chemistry/index.js';
import { headerTemplateSvg, rGroupLabelSchema } from './publication-header-template.js';
import { resolveScaffoldGroup } from './publication-scaffold.js';
import { failure } from './store.js';

const fail = message=>{throw failure('VALIDATION',message);};
export const ringVariationSchema={type:'object',additionalProperties:false,required:['label','anchor','sites'],
  description:'One variably positioned substituent on a six-member aromatic ring. anchor is the atom relative to which ortho/meta/para are reported. All indices are zero-based in input SMILES order.',
  properties:{label:rGroupLabelSchema,anchor:{type:'integer',minimum:0,maximum:255},
    sites:{type:'array',minItems:2,maxItems:5,uniqueItems:true,items:{type:'integer',minimum:0,maximum:255}}}};

// Solve all permitted positions as numbered individual R groups, then present
// the single occupied site using the o/m/p notation of the source figure.
export async function resolveRingScope(document, definition, experiments) {
  const {smiles,ringVariation:{label,sites,anchor}}=definition;
  if (/[\s.*|]/.test(smiles) || /:\d+\]/.test(smiles) || definition.siteLabels) fail('For a variable-position series, use a connected, unmapped base scaffold.');
  const kit=await _editingToolkit();
  const base=kit.get_mol(smiles);
  if (!base) fail('RDKit could not parse the base scaffold.');
  let fixed, relativePositions;
  try {
    base.set_new_coords(false);
    const graph=JSON.parse(base.get_json()).molecules[0];
    const ext=graph.extensions.find(e=>e.name==='rdkitRepresentation');
    const rings=(ext?.atomRings ?? []).filter(r=>r.length===6 && r.includes(anchor) && r.every(i=>ext.aromaticAtoms?.includes(i)) && sites.every(i=>r.includes(i)));
    if (rings.length!==1 || sites.includes(anchor) || sites.some(i=>!(graph.atoms[i]?.impHs>0))) {
      fail('Specify one six-member aromatic ring, a separate reference atom, and hydrogen-bearing candidate sites.');
    }
    const ring=rings[0];
    const pos=ring.indexOf(anchor);
    relativePositions=sites.map(site=>{const d=Math.abs(pos-ring.indexOf(site));return ['','o-','m-','p-'][Math.min(d,6-d)];});
    const n=graph.atoms.length, b=graph.bonds.length;
    const atoms=sites.map((_,i)=>'M  V30 '+(n+i+1)+' R 0 0 0 '+(i+1)+' VAL=1');
    const bonds=sites.map((site,i)=>'M  V30 '+(b+i+1)+' 1 '+(site+1)+' '+(n+i+1));
    const block=base.get_v3Kmolblock().replace(/(M  V30 COUNTS )\d+ \d+/,(_m,p)=>p+(n+sites.length)+' '+(b+sites.length))
      .replace('M  V30 END ATOM',atoms.join('\n')+'\nM  V30 END ATOM')
      .replace('M  V30 END BOND',bonds.join('\n')+'\nM  V30 END BOND');
    const mapped=kit.get_mol(block);
    try {fixed=mapped?.get_smiles();} finally {mapped?.delete();}
    if (!fixed) fail('RDKit could not construct the candidate attachment sites.');
  } finally {base.delete();}
  const {substitutions}=await resolveScaffoldGroup(document,{smiles:fixed},experiments);
  const printedLabel=label.replace(/\d/g,digit=>'⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(digit)]);
  for (const [id,cells] of substitutions) {
    const occupied=cells.filter(c=>c.label!=='H');
    if (occupied.length>1) fail('Experiment '+id+' occupies multiple positions of a single R group.');
    const cell=occupied[0] || cells[0];
    const prefix=occupied.length ? relativePositions[Number(cell.site.slice(1))-1] : '';
    substitutions.set(id,[{...cell,site:printedLabel,label:prefix+cell.label}]);
  }
  return {svg:await headerTemplateSvg({...definition,ringAttachments:[{label,sites}]}),sites:[printedLabel],substitutions};
}
