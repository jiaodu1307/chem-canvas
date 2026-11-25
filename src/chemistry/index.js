import { randomUUID } from 'node:crypto';
import { drawMolecule, drawingCapabilities } from './drawing.js';
import { chooseLayout, chemicalSignature, layoutQuality } from './layout.js';
import { coordinationCenters, coordinationInput } from './coordination.js';
import { stereoEditingCapabilities } from './stereo-editing.js';
export { editMolecule } from './editing.js';
export { applyStereoEdits } from './stereo-editing.js';
export { adjustDepiction, inspectDepiction } from './local-depiction.js';
export { toolkit as _editingToolkit, graphFromJSON as _editingGraph };

const limits = { inputCharacters: 200000, atoms: 2000 };
const limitations = [
  'Whole-structure replacement creates new atom/bond IDs; no cross-version atom mapping is inferred.',
  'SMARTS, query/dummy atoms, reactions, polymers, substance/enhanced stereo groups, SDF records and CXSMILES extensions are not supported.',
  'SVG and coordinates are a generated 2D depiction; original MOL input is retained separately.',
  'No tautomer, protonation or salt normalization is performed. CDK is not installed or used.',
];
let toolkitPromise;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

async function toolkit() {
  if (!toolkitPromise) {
    toolkitPromise = import('@rdkit/rdkit').then(({ default: initialize }) => initialize()).catch((cause) => {
      toolkitPromise = undefined;
      throw failure('CHEMISTRY_UNAVAILABLE', `RDKit WASM could not initialize: ${cause.message}`);
    });
  }
  return toolkitPromise;
}

export async function getCapabilities() {
  const rdkit = await toolkit();
  return {
    available: true, tool: 'RDKit', version: rdkit.version(), adapter: 'rdkit-wasm',
    operations: ['parseSmiles', 'parseMolblock', 'renderMolecule', 'editMolecule', 'layoutMolecule', 'adjustDepiction', 'inspectDepiction', 'generateSvg', 'generate2DCoordinates'],
    localDepiction: {operations:['moveAtom','rotateTerminalBond','relaxHydrogens','doubleChain'],doubleChain:{minimumRingSize:12,spanScale:{min:0.75,default:1,max:1.4},chainGap:{min:2,default:3,max:5},atomicCoordinates:true},coordinates:'absolute molecular 2D units',terminalRotation:'degree-one endpoint only; degrees ±360; lengthScale 0.25–4',maxOperations:100,maxSearchHydrogens:32,maxSearchMoleculeAtoms:256,preservesUnselectedCoordinates:true,
      diagnostics:['vector-glyph/bond overlaps','vector-glyph/glyph overlaps','narrow/opposed wedge angles','geometry'],limitations:['Only existing explicit H atoms can be relaxed by stable ID.','No arbitrary label offsets, hiding atoms, or manual wedge/chemical stereo changes.']},
    layout: { strategies: ['auto', 'rdkit', 'coordgen'], preservesIdentity: true, molImport: 'preserve-valid-2d', checks: ['indexed-graph', 'indexed-CIP', 'InChI', 'MOL-roundtrip'] },
    editing: { identityPreserved: true, maxEdits: 500, bondOrders: [1, 2, 3], stereo: stereoEditingCapabilities(),
      limitations: ['Ordinary chemical changes to stereo/radical/explicit-valence structures remain rejected; dedicated standalone stereo edits are limited to editing.stereo capabilities.', 'Coordinate-only edits must retain isomeric SMILES. Only 2D ordinary atom/bond graphs; no query structures or full ChemDraw parity.'] },
    drawing: drawingCapabilities(),
    formats: { input: ['SMILES', 'MOL V2000', 'MOL V3000'], output: ['isomeric canonical SMILES', 'MOL', 'SVG', 'RDKit JSON'] },
    stereochemistry: true, atomMapping: false, limits: { ...limits }, limitations: [...limitations],
    coordinationStereo:{geometries:['square-planar','octahedral'],input:'Explicit @SPn / @OHn SMILES or 2D octahedral MOL with metal-origin solid and hashed single bonds and four planar sites.',inspection:'coordinationStereo lists the indexed center, opposite ligand pairs and any solid/hashed ligand indices.'},
  };
}

function validateInput(input, format, options) {
  if (typeof input !== 'string' || !input.trim() || input.length > limits.inputCharacters || input.includes('\0')) {
    throw failure('VALIDATION', `${format} must be a nonempty string of at most ${limits.inputCharacters} characters.`);
  }
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      (options.idPrefix !== undefined && (typeof options.idPrefix !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(options.idPrefix)))) {
    throw failure('VALIDATION', 'idPrefix must contain 1–100 letters, digits, underscores or hyphens.');
  }
  // The donor -> acceptor arrow belongs to a molecule; other > separators denote reactions.
  if (format === 'SMILES' && /\s|\||>|\{|\}/.test(input.trim().replaceAll('->', ''))) {
    throw failure('VALIDATION', 'Provide one plain SMILES without names, whitespace, CXSMILES extensions or reaction notation. For authored 2D coordinates, use molblock (MOL V2000 or V3000).');
  }
  if (format === 'MOL' && (!/V(?:2000|3000)/.test(input) || !/^M  END\s*$/m.test(input) ||
      input.split(/^M  END\s*$/m).slice(1).join('').trim())) {
    throw failure('VALIDATION', 'Provide a single complete MOL V2000/V3000 block without SDF properties or records.');
  }
}

function graphFromJSON(json, prefix) {
  const molecule = json.molecules?.[0];
  if (!molecule || json.molecules.length !== 1 || !molecule.atoms?.length) {
    throw failure('VALIDATION', 'Input does not contain a nonempty molecule.');
  }
  if (molecule.atoms.length > limits.atoms) throw failure('VALIDATION', `Maximum molecule size is ${limits.atoms} atoms.`);
  const extensions = molecule.extensions ?? [];
  if (extensions.some((entry) => /quer|substance|polymer/i.test(entry.name)) || molecule.substanceGroups?.length || molecule.stereoGroups?.length) {
    throw failure('VALIDATION', 'Query structures, substance groups and enhanced stereo groups are not supported by this adapter.');
  }
  const representation = extensions.find((entry) => entry.name === 'rdkitRepresentation') ?? {};
  const aromaticAtoms = new Set(representation.aromaticAtoms ?? []);
  const aromaticBonds = new Set(representation.aromaticBonds ?? []);
  const cip = new Map(representation.cipCodes ?? []);
  const coords = molecule.conformers?.[0]?.coords;
  const atoms = molecule.atoms.map((value, index) => {
    const atom = { ...json.defaults?.atom, ...value };
    if (!atom.z) throw failure('VALIDATION', 'Dummy atoms and variable groups are not supported.');
    return {
      id: `${prefix}-a${index}`, index, atomicNumber: atom.z, formalCharge: atom.chg ?? 0,
      isotope: atom.isotope ?? 0, implicitHydrogens: atom.impHs ?? 0,
      radicalElectrons: atom.nRad ?? 0, stereo: atom.stereo ?? 'unspecified',
      aromatic: aromaticAtoms.has(index), ...(cip.has(index) ? { cip: cip.get(index) } : {}),
      ...(coords?.[index] ? { x: coords[index][0], y: coords[index][1], z: coords[index][2] ?? 0 } : {}),
    };
  });
  const bonds = (molecule.bonds ?? []).map((value, index) => {
    const bond = { ...json.defaults?.bond, ...value };
    return {
      id: `${prefix}-b${index}`, index, from: atoms[bond.atoms[0]].id, to: atoms[bond.atoms[1]].id,
      order: bond.bo, aromatic: aromaticBonds.has(index), stereo: bond.stereo ?? 'unspecified',
      ...(bond.stereoAtoms ? { stereoAtoms: bond.stereoAtoms.map((i) => atoms[i].id) } : {}),
    };
  });
  return { atoms, bonds };
}

async function parse(input, format, options) {
  validateInput(input, format, options);
  const rdkit = await toolkit();
  let mol;
  let roundtrip;
  try {
    mol = rdkit.get_mol(format === 'SMILES' ? input.trim() : input, JSON.stringify({ sanitize: true, removeHs: false, strictParsing: true }));
    if (!mol || !mol.is_valid()) throw failure('VALIDATION', `Invalid ${format}: RDKit could not parse and sanitize the structure.`);
    const prefix = `${options.idPrefix ?? 'mol'}-${randomUUID()}`;
    graphFromJSON(JSON.parse(mol.get_json()), prefix);
    const smilesOptions = JSON.stringify({ canonical: true, isomericSmiles: true });
    const originalSmiles=mol.get_smiles(smilesOptions);
    const coord=coordinationInput(rdkit,mol,format==='MOL'?input:null);
    const smiles=coord?.info.smiles ?? originalSmiles;
    const selected=coord ? {
      mol:rdkit.get_mol(coord.block,JSON.stringify({removeHs:false})),
      layout:{strategy:'preserve-coordination',method:format==='MOL'?'preserved':'rdkit',warnings:[],
        verification:['indexed-ligands','opposite-pairs','RDKit-isomeric-SMILES','CTAB-roundtrip']},
    } : chooseLayout(rdkit,mol,{preserve:format==='MOL'});
    mol.delete(); mol = selected.mol;
    if(!mol) throw failure('VALIDATION','Coordination CTAB could not be re-read.');
    if(coord) selected.layout.quality=layoutQuality(mol);
    const molblock = coord?.block ?? mol.get_molblock();
    roundtrip = rdkit.get_mol(molblock, JSON.stringify({ sanitize: true, removeHs: false, strictParsing: true }));
    if (!roundtrip || (coord ? JSON.stringify(coordinationInput(rdkit,roundtrip,molblock)?.info)!==JSON.stringify(coord.info) : roundtrip.get_smiles(smilesOptions) !== smiles)) {
      throw failure('VALIDATION', 'MOL export would change the structure or stereochemistry; this input is not supported.');
    }
    const structure = JSON.parse(mol.get_json());
    const graph = graphFromJSON(structure, prefix);
    const rendered = drawMolecule(mol, rdkit.version(),'acs1996',undefined,0,undefined,Boolean(coord));
    return {
      ...(format === 'SMILES' ? { inputSmiles: input } : { inputMolblock: input }),
      smiles, molblock, ...rendered, ...graph, structure, layout: selected.layout,
      ...(coord?{coordinationStereo:coord.info}:{}),
      chemistry: { tool: 'RDKit', version: rdkit.version(), adapter: 'rdkit-wasm',
        options: { canonical: true, isomericSmiles: true, sanitize: true, removeHs: false, coordinates: selected.layout.method === 'preserved' ? 'preserved-input-2d' : 'generated-2d' },
        atomIdentity: 'new-per-parse', atomMapping: null },
      warnings: [limitations[0], ...selected.layout.warnings],
    };
  } catch (error) {
    if (error?.code) throw error;
    throw failure('VALIDATION', `Unable to process ${format} with RDKit: ${typeof error === 'string' ? error : error?.message ?? 'unsupported structure'}`);
  } finally {
    roundtrip?.delete();
    mol?.delete();
  }
}

export async function parseSmiles(smiles, options = {}) { return parse(smiles, 'SMILES', options); }
export async function parseMolblock(molblock, options = {}) { return parse(molblock, 'MOL', options); }

export function _validateLayoutGraph(data, source, rdkit) {
    const coord=source && rdkit && data.coordinationStereo && coordinationInput(rdkit,source,data.molblock);
    if (!source || (coord?.info.smiles ?? source.get_smiles()) !== data.smiles ||
        (data.coordinationStereo && JSON.stringify(coord?.info)!==JSON.stringify(data.coordinationStereo))) throw failure('VALIDATION', 'Existing MOL and SMILES disagree.');
    const before = graphFromJSON(JSON.parse(source.get_json()), 'verify');
    const ids = new Set();
    for (const kind of ['atoms','bonds']) {
      if (!Array.isArray(data[kind]) || data[kind].length !== before[kind].length) throw failure('VALIDATION', 'Existing graph size does not match MOL.');
      before[kind].forEach((item,i)=>{
        const actual=data[kind][i];
        if(typeof actual.id!=='string'||ids.has(actual.id)||actual.index!==i) throw failure('VALIDATION','Invalid identity correspondence.');
        ids.add(actual.id);
        const mapped={...item,id:actual.id};
        if(kind==='bonds') {
          mapped.from=data.atoms[before.atoms.findIndex(a=>a.id===item.from)].id;
          mapped.to=data.atoms[before.atoms.findIndex(a=>a.id===item.to)].id;
          if ([mapped.from,mapped.to].sort().join('|') !== [actual.from,actual.to].sort().join('|')) throw failure('VALIDATION','Existing bond endpoints disagree with MOL.');
          // MOL wedge serialization can reverse a bond's endpoint order.
          mapped.from=actual.from; mapped.to=actual.to;
          if(mapped.aromatic && actual.aromatic) mapped.order=actual.order;
          if(item.stereoAtoms) mapped.stereoAtoms=item.stereoAtoms.map(id=>data.atoms[before.atoms.findIndex(a=>a.id===id)].id);
        }
        for(const key of Object.keys(mapped)) {
          if(['x','y','z'].includes(key)) { if(!Number.isFinite(actual[key])||Math.abs(actual[key]-mapped[key])>0.001) throw failure('VALIDATION','Existing coordinates disagree with MOL.'); }
          else if(JSON.stringify(actual[key])!==JSON.stringify(mapped[key])) throw failure('VALIDATION',`Existing graph property ${key} disagrees with MOL.`);
        }
      });
    }
}

// Explicit coordinate transaction: caller owns version checks, persistence and undo.
export async function layoutMolecule(data, options = {}) {
  validateInput(data?.molblock, 'MOL', {});
  if(data.coordinationStereo) throw failure('VALIDATION','Replace the authored coordination depiction with a stereospecified MOL or SMILES to change its layout.');
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => k !== 'strategy')) throw failure('VALIDATION', 'Only layout strategy is supported.');
  const rdkit = await toolkit();
  let source, selected;
  try {
    source = rdkit.get_mol(data.molblock, JSON.stringify({ removeHs: false, sanitize: true }));
    _validateLayoutGraph(data,source);
    selected=chooseLayout(rdkit,source,options);
    if(chemicalSignature(selected.mol)!==chemicalSignature(source)) throw failure('VALIDATION','Layout changed structure.');
    const structure=JSON.parse(selected.mol.get_json());
    const graph=graphFromJSON(structure,'layout');
    const idMap=new Map(graph.atoms.map((a,i)=>[a.id,data.atoms[i].id]));
    graph.atoms.forEach((a,i)=>{a.id=data.atoms[i].id;});
    graph.bonds.forEach((b,i)=>{b.id=data.bonds[i].id;b.from=data.bonds[i].from;b.to=data.bonds[i].to;if(b.aromatic)b.order=data.bonds[i].order;if(b.stereoAtoms)b.stereoAtoms=b.stereoAtoms.map(id=>idMap.get(id));});
    const movedAtoms=graph.atoms.filter((a,i)=>Math.hypot(a.x-data.atoms[i].x,a.y-data.atoms[i].y)>1e-5).map(a=>({id:a.id,before:{x:data.atoms[a.index].x,y:data.atoms[a.index].y},after:{x:a.x,y:a.y}}));
    const delta={addedAtoms:[],removedAtoms:[],changedAtoms:[],addedBonds:[],removedBonds:[],changedBonds:[],movedAtoms,identityPreserved:true,summary:`Layout ${selected.layout.method}; moved ${movedAtoms.length} atoms; chemistry unchanged.`};
    // An unchanged winner must not silently re-wedge/redraw implicit H labels.
    if(selected.layout.method==='preserved') return {molecule:{...data,layout:selected.layout,lastEdit:delta},delta};
    const molecule={...data,...graph,structure,molblock:selected.mol.get_molblock(),...drawMolecule(selected.mol,rdkit.version(),data.drawing?.style ?? 'acs1996'),layout:selected.layout,lastEdit:delta,
      chemistry:{...data.chemistry,options:{...data.chemistry?.options,coordinates:'verified-layout-2d'}},warnings:[...(data.warnings ?? []),...selected.layout.warnings]};
    return {molecule,delta};
  } finally {source?.delete();selected?.mol.delete();}
}

// Presentation-only: reuse coordinates and identities; never call the parsing
// adapter, which intentionally allocates a new namespace for replacements.
export async function renderMolecule(data, { style = 'acs1996', abbreviations, includeCoordination = false } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('VALIDATION', 'Molecule data is required.');
  validateInput(data.molblock, 'MOL', {});
  const rdkit = await toolkit();
  let mol;
  try {
    mol = rdkit.get_mol(data.molblock, JSON.stringify({ sanitize: true, removeHs: false }));
    if (!mol || !mol.is_valid()) throw failure('VALIDATION', 'Invalid molecule MOL block.');
    const graph = JSON.parse(mol.get_json());
    graphFromJSON(graph, 'render-validation');
    const coord=data.coordinationStereo && coordinationInput(rdkit,mol,data.molblock);
    if(data.coordinationStereo && JSON.stringify(coord?.info)!==JSON.stringify(data.coordinationStereo)) throw failure('VALIDATION','Saved coordination geometry disagrees with the indexed CTAB.');
    if (typeof data.smiles !== 'string' || (coord?.info.smiles ?? mol.get_smiles(JSON.stringify({ canonical: true, isomericSmiles: true }))) !== data.smiles) {
      throw failure('VALIDATION', 'MOL block and canonical SMILES disagree; refusing to redraw inconsistent structure.');
    }
    return { ...data, ...drawMolecule(mol, rdkit.version(), style, undefined, 0, abbreviations,Boolean(coord),rdkit),
      ...(includeCoordination ? {coordinationCenters: coordinationCenters(graph.molecules[0], coord?.info)} : {}) };
  } catch (error) {
    if (error?.code) throw error;
    throw failure('VALIDATION', `Unable to render molecule: ${error?.message ?? 'unsupported structure'}`);
  } finally { mol?.delete(); }
}
