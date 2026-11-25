import { _editingToolkit } from '../src/chemistry/index.js';

const profile = 'chem-canvas-cdxml-v1';
const symbols = new Set('H B C N O F Si P S Cl Br I'.split(' '));
const check = (condition, message, code = 'VALIDATION') => {
  if (!condition) throw Object.assign(new Error(message), { code });
};
const escape = value => {
  const text = String(value);
  check(!/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(text), 'Text contains an invalid XML character.');
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
};
const number = value => {
  check(Number.isFinite(value) && Math.abs(value) < 32768, 'Coordinate exceeds the CDXML profile.');
  return Number(value.toFixed(4));
};
const point = (left, top) => `${number(left)} ${number(top)}`;
const same = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value,index) => value === right[index]);

function readStructure(object, toolkit) {
  const requireChem = (condition, message) => check(condition, `${object.id}: ${message}`, 'UNSUPPORTED_CHEMISTRY');
  const {molblock,smiles} = object.data;
  requireChem(typeof molblock === 'string' && molblock.length < 200001, 'missing or oversized MOL.');
  const lines = molblock.trimEnd().split(/\r?\n/);
  requireChem(/V2000$/.test(lines[3]) && !/3D/.test(lines[1]), 'requires 2D V2000.');
  const atomCount = Number(lines[3].slice(0,3)), bondCount = Number(lines[3].slice(3,6));
  const properties = lines.slice(4+atomCount+bondCount);
  requireChem(properties.at(-1) === 'M  END' && properties.slice(0,-1).every(line => /^M  (CHG|ISO)\s/.test(line)), 'extra MOL property, alias, query or group.');
  const mol = toolkit.get_mol(molblock, JSON.stringify({sanitize:true,removeHs:false,strictParsing:true}));
  try {
    requireChem(mol?.is_valid() && mol.get_smiles() === smiles && !smiles.includes('.'), 'structure mismatch or disconnected fragment.');
    const graph = JSON.parse(mol.get_json()).molecules[0];
    requireChem(graph.atoms.length === atomCount && graph.bonds.length === bondCount && !graph.stereoGroups?.length && !graph.substanceGroups?.length && graph.extensions.every(ext => ext.name === 'rdkitRepresentation'), 'unprofiled graph.');
    const atoms = graph.atoms.map((atom,index) => {
      const line = lines[4+index], symbol = line.slice(31,34).trim();
      requireChem(symbols.has(symbol) && !atom.nRad && !line.slice(34).trim().split(/\s+/).some(field => Number(field)!==0), 'unsupported element, radical, valence, atom map or atom encoding.');
      requireChem(!atom.stereo || ['cw','ccw'].includes(atom.stereo) && symbol === 'C', 'only tetrahedral carbon is supported.');
      const x = Number(line.slice(0,10)), y = Number(line.slice(10,20));
      requireChem(Number.isFinite(x) && Number.isFinite(y) && Number(line.slice(20,30)) === 0, 'invalid 2D coordinates.');
      return {x,y,element:atom.z ?? 6,charge:atom.chg ?? 0,isotope:atom.isotope ?? 0,hydrogens:atom.impHs ?? 0,stereo:atom.stereo};
    });
    const wedged = new Set();
    const bonds = graph.bonds.map((bond,index) => {
      const line = lines[4+atomCount+index];
      const [begin,end,order,stereo] = [0,3,6,9].map(start => Number(line.slice(start,start+3)));
      requireChem(atoms[begin-1] && atoms[end-1] && [1,2,3].includes(order) && [0,1,6].includes(stereo) && !bond.stereo && !line.slice(12).trim().split(/\s+/).some(field => Number(field)!==0), 'unsupported bond order, E/Z, unknown stereo or bond metadata.');
      if (stereo) {
        requireChem(order === 1 && atoms[begin-1].stereo && !wedged.has(begin-1), 'ambiguous wedge origin.');
        wedged.add(begin-1);
      }
      return {begin:begin-1,end:end-1,order,stereo};
    });
    requireChem(atoms.every((atom,index) => !atom.stereo || wedged.has(index)), 'assigned center lacks its own directional bond.');
    const lengths = bonds.map(({begin,end}) => Math.hypot(atoms[begin].x-atoms[end].x,atoms[begin].y-atoms[end].y));
    requireChem(lengths.every(length => length > 0.0001), 'collapsed bond.');
    return {atoms,bonds,scale:lengths.length ? 12/(lengths.reduce((sum,len) => sum+len,0)/lengths.length) : 1};
  } finally { mol?.delete(); }
}

export async function exportSchemeCdxml(document, scheme) {
  check(document?.id && document.id === scheme?.documentId && Number.isInteger(document.revision) && document.revision === scheme.revision, 'Scheme belongs to another document or revision.', 'CONFLICT');
  const saved = document.schemeLayout;
  check(saved && scheme.layoutSource === 'saved-layout' && scheme.representation === 'reaction-scheme', 'Save the full Scheme layout before exporting.');
  check(saved.version === scheme.layoutVersion, 'Scheme layout version changed.', 'CONFLICT');
  const {elements,steps} = scheme;
  check(steps?.length && elements?.length && Object.keys(saved.positions).length === elements.length, 'Incomplete or changed layout; save again.');
  check(!scheme.cycle && elements.every(item=>['molecule','plus','arrow','conditions'].includes(item.kind) && (item.kind!=='arrow' || !item.direction || item.direction==='right')),
    'This CDXML profile supports horizontal forward arrows and molecular endpoints. Use SVG to preserve this scheme geometry or text-only elements.', 'UNSUPPORTED_CDXML');
  const stepIds = new Set(steps.map(step => step.reactionId));
  const reactions = Object.values(document.objects).filter(obj => obj.kind === 'reaction');
  check(stepIds.size === steps.length && steps.length === reactions.length && reactions.every(obj => stepIds.has(obj.id)), 'Requires all saved reactions.');
  let counter = 10;
  const allocate = () => { check(counter < 65536,'Too many CDXML objects.'); return counter++; };
  const displays = new Map(), groups = new Map(), structures = new Map(), parts = [];
  const warnings = [...(scheme.warnings ?? []), {code:'PRESENTATION_SUBSET',message:'Editable single-page exchange; fonts and label metrics may differ. Research history and non-Scheme objects are not exported.'}];
  const toolkit = await _editingToolkit();
  function caption(id,left,top,value,size=7) {
    parts.push(`<t id="${id}" p="${point(left,top)}" Justification="Center"><s font="3" size="${size}">${escape(value)}</s></t>`);
  }
  for (const item of elements) {
    const position = saved.positions[item.id];
    check(!displays.has(item.id) && Object.hasOwn(saved.positions,item.id) && position.x===item.x && position.y===item.y && [item.x,item.y,item.width,item.height].every(Number.isFinite) && item.width>0 && item.height>0 && stepIds.has(item.reactionId), 'Invalid or unsaved Scheme element.');
    const id = allocate(), left = item.x/2, top = item.y/2, width = item.width/2, height = item.height/2;
    displays.set(item.id,{id,item});
    if (!groups.has(item.reactionId)) groups.set(item.reactionId,{plus:[]});
    const group = groups.get(item.reactionId);
    if (item.kind === 'molecule') {
      const object = document.objects[item.objectId];
      check(object?.kind === 'molecule', 'Molecule display has no structure.');
      if (!structures.has(object.id)) structures.set(object.id,readStructure(object,toolkit));
      const {atoms,bonds,scale} = structures.get(object.id), atomIds = atoms.map(allocate);
      const xs = atoms.map(atom=>atom.x), ys = atoms.map(atom=>atom.y);
      const centerX=(Math.max(...xs)+Math.min(...xs))/2, maxY=Math.max(...ys);
      const label=String(object.data.label || object.title || object.id).replace(/^(?:compound|化合物)\s*/i,'');
      parts.push(`<fragment id="${id}">`);
      for (const [index,atom] of atoms.entries()) {
        const position=point(left+width/2+(atom.x-centerX)*scale,top+4+(maxY-atom.y)*scale);
        parts.push(`<n id="${atomIds[index]}" p="${position}" Element="${atom.element}" NumHydrogens="${atom.hydrogens}"${atom.charge?` Charge="${atom.charge}"`:''}${atom.isotope?` Isotope="${atom.isotope}"`:''}/>`);
      }
      for (const bond of bonds) parts.push(`<b id="${allocate()}" B="${atomIds[bond.begin]}" E="${atomIds[bond.end]}" Order="${bond.order}"${bond.stereo?` Display="${bond.stereo===1?'WedgeBegin':'WedgedHashBegin'}"`:''}/>`);
      parts.push('</fragment>'); caption(allocate(),left+width/2,top+height-6,label);
    } else if (item.kind === 'arrow') {
      check(!group.arrow,'Multiple arrows per step are unsupported.'); group.arrow=id;
      parts.push(`<arrow id="${id}" Tail3D="${point(left,top+height/2)} 0" Head3D="${point(left+width,top+height/2)} 0" ArrowheadHead="Full" ArrowheadType="Solid"/>`);
    } else if (item.kind === 'conditions') {
      check(['above','below'].includes(item.slot) && !group[item.slot] && Array.isArray(item.lines),'Unsupported condition block.');
      group[item.slot]=id; caption(id,left+width/2,top+7.5,item.lines.join('\n'));
    } else if (item.kind === 'plus') {
      group.plus.push(id);
      const midX=left+width/2,midY=top+height/2;
      parts.push(`<graphic id="${id}" GraphicType="Symbol" SymbolType="Plus" BoundingBox="${point(midX-3,midY-3)} ${point(midX+3,midY+3)}"/>`);
    } else check(false,'Unsupported Scheme element.');
  }
  parts.push(`<scheme id="${allocate()}">`);
  for (const step of steps) {
    const group=groups.get(step.reactionId), relations=Object.values(document.relations);
    check(group?.arrow && group.arrow===displays.get(step.arrowId)?.id,'Missing step arrow.');
    const attrs={ReactionStepArrows:group.arrow};
    for (const role of ['reactant','product']) {
      const inputs=role==='reactant', keys=step[role+'Displays'];
      const objects=relations.filter(edge=>edge.kind===role && (inputs?edge.to:edge.from)===step.reactionId).map(edge=>inputs?edge.from:edge.to);
      check(objects.length && same(step[role+'s'],objects) && Array.isArray(keys) && same(keys.map(key=>displays.get(key)?.item.objectId),objects),'Step role or display mismatch.');
      attrs[inputs?'ReactionStepReactants':'ReactionStepProducts']=keys.map(key=>displays.get(key).id).join(' ');
    }
    if(group.plus.length)attrs.ReactionStepPlusses=group.plus.join(' ');
    if(group.above)attrs.ReactionStepObjectsAboveArrow=group.above;
    if(group.below)attrs.ReactionStepObjectsBelowArrow=group.below;
    parts.push(`<step id="${allocate()}" ${Object.entries(attrs).map(([name,value])=>`${name}="${value}"`).join(' ')}/>`);
  }
  if (Object.values(document.relations).some(edge=>['reagent','catalyst','solvent'].includes(edge.kind) && stepIds.has(edge.to))) warnings.push({code:'AGENT_ROLES_AS_TEXT',message:'Reagents, catalysts and solvents are exported as displayed condition text, not structured roles.'});
  const cdxml=`<?xml version="1.0" encoding="UTF-8"?>\n<CDXML CreationProgram="Chem Canvas" BondLength="12" LabelFont="3" CaptionFont="3"><fonttable><font id="3" charset="iso-10646" name="Arial"/></fonttable><page id="1" BoundingBox="0 0 ${point(scheme.width/2,scheme.height/2)}">\n${parts.join('\n')}\n</scheme></page></CDXML>\n`;
  return {cdxml,warnings,profile,revision:document.revision,layoutVersion:saved.version};
}
