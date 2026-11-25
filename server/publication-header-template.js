import { _editingToolkit } from '../src/chemistry/index.js';
import { drawTemplateMolecule, orientationProperties } from './publication-orientation.js';
import { drawPublicationScaffold } from './publication-scaffold.js';
import { failure } from './store.js';

const fail = message => { throw failure('VALIDATION', message); };
const numberedR = 'R([1-9][0-9]?|[¹²³⁴⁵⁶⁷⁸⁹][⁰¹²³⁴⁵⁶⁷⁸⁹]?)?';
export const rGroupLabelSchema = {type:'string',pattern:'^'+numberedR+'$'};
export const ringLabelSchema = {type:'string',pattern:'^('+numberedR+'|X|Y|Ar)$'};
export const abbreviationMode = {enum:['expanded','journal'],description:'Print explicit groups or use RDKit journal abbreviations such as CHO, CO2H and OMe. Templates inherit the study setting.'};
export const headerTemplatesSchema = {
  type:'array', minItems:1, maxItems:6, description:'Display templates for this side of the reaction, following its concrete molecule IDs. These do not become reactants in the project graph.',
  items:{type:'object',additionalProperties:false,required:['smiles'],properties:{
    smiles:{type:'string', minLength:1,maxLength:2000,description:'Connected scaffold SMILES, numbered fixed attachments use [*:1].'},
    label:{type:'string',maxLength:120},abbreviations:abbreviationMode,...orientationProperties,
    ringAttachments:{type:'array',minItems:1,maxItems:4,items:{type:'object',additionalProperties:false,required:['label','sites'],properties:{
      label:ringLabelSchema,sites:{type:'array',minItems:2,maxItems:32,uniqueItems:true,items:{type:'integer',minimum:0,maximum:255},
        description:'Candidate atom indices in input SMILES order (zero-based), all on one ring. Render as a single MDL position-variation bond.'}
    }}}
  }}
};

// Select an exposed edge for the floating bond. The endpoints stored in MDL
// specify the chemical alternatives independently of these drawing coordinates.
function floatingBond(ring, sites, coords) {
  const center = [0,1].map(axis=>ring.reduce((sum,i)=>sum+coords[i][axis],0)/ring.length);
  let best;
  for (const [i,a] of ring.entries()) {
    const b=ring[(i+1)%ring.length];
    if (!sites.includes(a) && !sites.includes(b)) continue;
    const ray=[0,1].map(axis=>(coords[a][axis]+coords[b][axis])/2-center[axis]);
    const radius=Math.hypot(...ray);
    if (radius < 0.01) continue;
    const end=ray.map((v,k)=>center[k]+v*(1+1.35/radius));
    const start=ray.map((v,k)=>center[k]+v*0.55);
    const clearance=Math.min(...coords.filter((_,idx)=>!ring.includes(idx)).map(p=>Math.hypot(end[0]-p[0],end[1]-p[1])));
    if (!best || clearance>best.clearance) best={start,end,clearance};
  }
  if (!best) fail('Could not place a position-variation bond for these ring atoms.');
  return best;
}

export async function headerTemplateSvg(template) {
  const {smiles,ringAttachments}=template;
  if (!ringAttachments?.length) return (await drawPublicationScaffold(smiles,template)).svg;
  if (/[\s.|]/.test(smiles) || /:\d+\]/.test(smiles.replace(/\[\*:[1-9]\d?\]/g,''))) {
    fail('Use one connected scaffold SMILES. Only fixed [*:n] attachment atoms may have maps.');
  }
  const rdkit=await _editingToolkit();
  // Apply the same terminal-site rules used for a materialized substrate series.
  if (smiles.includes('*')) await drawPublicationScaffold(smiles);
  const base=rdkit.get_mol(smiles);
  if (!base) fail('RDKit could not parse this reaction template.');
  let display;
  try {
    base.set_new_coords(false);
    const graph=JSON.parse(base.get_json()).molecules[0];
    if (graph.atoms.length>256) fail('Reaction header templates support up to 256 base atoms.');
    const coords=graph.conformers[0].coords.slice();
    const rings=graph.extensions.find(e=>e.name==='rdkitRepresentation')?.atomRings || [];
    let block=base.get_v3Kmolblock(), atoms=graph.atoms.length, bonds=graph.bonds?.length || 0;
    const labels={};
    for (const m of block.matchAll(/^M  V30 (\d+) R [-\d.]+ [-\d.]+ [-\d.]+ ([1-9]\d*)\b/gm)) {
      labels[Number(m[1])-1]='R'+m[2];
    }
    const usedLabels=new Set(Object.values(labels));
    for (const attachment of ringAttachments) {
      const {sites}=attachment, label=attachment.label.normalize('NFKC');
      const matches=rings.filter(r=>sites.every(i=>r.includes(i)));
      if (matches.length!==1) fail('Each variable attachment must identify one distinct RDKit ring.');
      if (sites.some(i=>!(graph.atoms[i]?.impHs>0))) fail('Each possible substitution site must have a replaceable hydrogen in the base template.');
      if (usedLabels.has(label)) fail('Use distinct labels for the fixed and variable sites within a template.');
      usedLabels.add(label);
      const {start,end}=floatingBond(matches[0],sites,coords);
      const line=(i,p)=>'M  V30 '+i+' * '+p.map(v=>v.toFixed(6)).join(' ')+' 0 0\n';
      block=block.replace('M  V30 END ATOM',line(atoms+1,start)+line(atoms+2,end)+'M  V30 END ATOM');
      block=block.replace('M  V30 END BOND','M  V30 '+(++bonds)+' 1 '+(atoms+1)+' '+(atoms+2)+' ENDPTS=('+sites.length+' '+sites.map(i=>i+1).join(' ')+') ATTACH=ANY\nM  V30 END BOND');
      labels[atoms+1]=label;
      coords.push(start,end); atoms+=2;
    }
    block=block.replace(/(M  V30 COUNTS )\d+ \d+/,(_m,prefix)=>prefix+atoms+' '+bonds);
    display=rdkit.get_mol(block,JSON.stringify({removeHs:false,strictParsing:true}));
    const siteSets = (display?.get_v3Kmolblock() || '').matchAll(/ENDPTS=\(\d+ ([\d ]+)\) ATTACH=ANY/g);
    const canonicalSites = sites=>[...sites].sort((a,b)=>a-b).join(',');
    const retained=[...siteSets].map(match=>canonicalSites(match[1].trim().split(/\s+/).map(i=>Number(i)-1)));
    if (retained.length!==ringAttachments.length || ringAttachments.some((attachment,i)=>canonicalSites(attachment.sites)!==retained[i])) {
      fail('RDKit could not retain the position-variation bonds.');
    }
    for (const [i,label] of Object.entries(labels)) labels[i]=label.replace(/^R(\d+)$/,'R<sup>$1</sup>');
    const {svg}=drawTemplateMolecule(rdkit,display,labels,template);
    return svg;
  } finally { display?.delete(); base.delete(); }
}
