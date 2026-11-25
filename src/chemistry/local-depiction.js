import { _editingToolkit, _editingGraph, _validateLayoutGraph } from './index.js';
import { drawMolecule } from './drawing.js';
import { chemicalSignature, layoutQuality, layoutFailure } from './layout.js';
import { depictionQuality } from './depiction-quality.js';
import { doubleChain } from './double-chain.js';
import {coordinationCoordinates,coordinationInput} from './coordination.js';
const readOptions=JSON.stringify({removeHs:false,sanitize:true});
const fail=message=>{throw layoutFailure(message);};
function sourceMol(rdkit,data) {
  if(typeof data?.molblock!=='string'||data.molblock.length>200000)fail('A complete molecule is required.');
  const mol=rdkit.get_mol(data.molblock,readOptions);
  try{_validateLayoutGraph(data,mol,rdkit);if(mol.has_coords()!==2 && !data.coordinationStereo)fail('Local depiction requires existing 2D coordinates.');return mol;}catch(e){mol?.delete();throw e;}
}
function fields(op,allowed){if(!op||typeof op!=='object'||Array.isArray(op)||Object.keys(op).some(k=>!allowed.includes(k)))fail('Unsupported local depiction operation/property.');}
function remapGraph(mol,data) {
  const structure=JSON.parse(mol.get_json()),graph=_editingGraph(structure,'local');
  const map=new Map(graph.atoms.map((a,i)=>[a.id,data.atoms[i].id]));
  graph.atoms.forEach((a,i)=>{a.id=data.atoms[i].id;});
  graph.bonds.forEach((b,i)=>{b.id=data.bonds[i].id;b.from=data.bonds[i].from;b.to=data.bonds[i].to;if(b.aromatic)b.order=data.bonds[i].order;if(b.stereoAtoms)b.stereoAtoms=b.stereoAtoms.map(id=>map.get(id));});
  return {...graph,structure};
}
function quality(mol,graph,rendered) {
  const geometry=layoutQuality(mol),display=depictionQuality(rendered.svg,graph.atoms,graph.bonds);
  return {geometry,display,score:display.score+geometry.score*2};
}
export async function inspectDepiction(data) {
  const rdkit=await _editingToolkit(),source=sourceMol(rdkit,data);
  try {return quality(source,data,drawMolecule(source,rdkit.version(),data.drawing?.style??'acs1996',undefined,0,undefined,Boolean(data.coordinationStereo)));}finally{source.delete();}
}

export async function adjustDepiction(data,options={}) {
  fields(options,['operations']);
  if(!Array.isArray(options.operations)||!options.operations.length||options.operations.length>100)fail('Provide 1–100 local depiction operations.');
  const searchTargets=options.operations.filter(o=>o?.type==='relaxHydrogens').reduce((n,o)=>n+(Array.isArray(o.atomIds)?o.atomIds.length:0),0);
  if(searchTargets>32 || (searchTargets && data?.atoms?.length>256))fail('Hydrogen candidate search supports at most 32 selected H atoms in molecules of at most 256 atoms per transaction.');
  const rdkit=await _editingToolkit(),source=sourceMol(rdkit,data);
  let current;
  try {
    const signature=chemicalSignature(source),smiles=source.get_smiles();
    const sourceMaps=source.get_v3Kmolblock().split('M  V30 BEGIN ATOM\n')[1].split('M  V30 END ATOM')[0].trim().split('\n').map(line=>line.slice(7).trim().split(/\s+/)[5]);
    const structure=JSON.parse(source.get_json());
    const coords=data.atoms.map(a=>[a.x,a.y]);
    const idIndex=new Map(data.atoms.map((a,i)=>[a.id,i]));
    const index=id=>{if(!idIndex.has(id))fail(`Unknown atom ID: ${id}`);return idIndex.get(id);};
    const neighbours=i=>data.bonds.filter(b=>b.from===data.atoms[i].id||b.to===data.atoms[i].id);
    const parent=(i,bond)=>index(bond.from===data.atoms[i].id?bond.to:bond.from);
    const touched=new Set(),steps=[];
    // Reconstruct from chemical stereo tags, never reuse stale 2D wedge CFG.
    const candidate=positions=>{
      let mol,rt,rebuilt;
      try {
        if(data.coordinationStereo) {
          const molblock=coordinationCoordinates(data.molblock,positions);
          mol=rdkit.get_mol(molblock,readOptions);
          if(!mol || chemicalSignature(mol)!==signature || !layoutQuality(mol).valid ||
              JSON.stringify(coordinationInput(rdkit,mol,molblock)?.info)!==JSON.stringify(data.coordinationStereo)) {
            fail('Coordinate change would alter the metal projection or stereochemistry.');
          }
          const graph=remapGraph(mol,data);
          const rendered=drawMolecule(mol,rdkit.version(),data.drawing?.style??'acs1996',undefined,0,undefined,true);
          return {mol,molblock,...graph,...rendered,quality:quality(mol,graph,rendered)};
        }
        const j=structuredClone(structure);j.molecules[0].conformers=[{dim:2,coords:'LOCAL_COORDS'}];
        // This WASM reader requires JSON floating-point tokens for coordinates;
        // JSON.stringify(0) produces an integer and rejects ordinary CCO at (0,0).
        const coordinateJSON='['+positions.map(p=>'['+p.map(v=>v.toExponential(16)).join(',')+']').join(',')+']';
        rebuilt=rdkit.get_mol(JSON.stringify(j).replace('"LOCAL_COORDS"',coordinateJSON),JSON.stringify({removeHs:false,sanitize:true,assignStereo:false}));
        // The JSON reader has stereo tags but no SMILES bond directions. Let
        // MOL regenerate wedges and recover alkene stereo from the new 2D
        // geometry before assignStereochemistry can clear JSON E/Z tags.
        if(!rebuilt)fail('RDKit rejected coordinate reconstruction.');
        let inAtoms=false;
        const reconstructedBlock=rebuilt.get_v3Kmolblock().split('\n').map(line=>{
          if(line==='M  V30 BEGIN ATOM'){inAtoms=true;return line;}
          if(line==='M  V30 END ATOM'){inAtoms=false;return line;}
          if(!inAtoms)return line;
          const row=line.slice(7).trim().split(/\s+/);row[5]=sourceMaps[+row[0]-1];return 'M  V30 '+row.join(' ');
        }).join('\n');
        mol=rdkit.get_mol(reconstructedBlock,readOptions);
        if(!mol||chemicalSignature(mol)!==signature||mol.get_smiles()!==smiles)fail('Coordinate reconstruction changed indexed chemistry/stereo or exchange atom maps; this structure is unsupported.');
        if(!layoutQuality(mol).valid)fail('Coordinates produce zero-length bonds or invalid 2D geometry.');
        const molblock=mol.get_v3Kmolblock();
        rt=rdkit.get_mol(molblock,readOptions);
        if(!rt||chemicalSignature(rt)!==signature||rt.get_smiles()!==smiles)fail('New wedge representation failed MOL stereo roundtrip.');
        const graph=remapGraph(mol,data),rendered=drawMolecule(mol,rdkit.version(),data.drawing?.style??'acs1996');
        return {mol,molblock,...graph,...rendered,quality:quality(mol,graph,rendered)};
      }catch(e){mol?.delete();throw e;}finally{rt?.delete();rebuilt?.delete();}
    };
    const macro = options.operations.some(op => op?.type === 'doubleChain');
    if (macro && options.operations.length !== 1) fail('Use doubleChain as a standalone whole-molecule operation.');
    if (!macro) current=candidate(coords);
    const before=current?.quality ?? quality(source,data,drawMolecule(source,rdkit.version(),data.drawing?.style??'acs1996'));
    const lengths=data.bonds.filter(b=>data.atoms[index(b.from)].atomicNumber!==1&&data.atoms[index(b.to)].atomicNumber!==1).map(b=>{
      const a=coords[index(b.from)],c=coords[index(b.to)];return Math.hypot(a[0]-c[0],a[1]-c[1]);
    }).sort((a,b)=>a-b);
    const unit=lengths[Math.floor(lengths.length/2)]??1.5;
    const validPoint=p=>p.every(v=>Number.isFinite(v)&&Math.abs(v)<=100000);
    const adopt=(next,positions)=>{current.mol.delete();current=next;positions.forEach((p,i)=>{coords[i]=p;});};
    for(const op of options.operations) {
      if(op?.type==='doubleChain') {
        fields(op,['type','anchorIds','spanScale','chainGap']);
        const {positions,...resolved}=doubleChain(data,structure,op);
        current=candidate(positions);
        positions.forEach((_,i)=>touched.add(i));
        const {crossings,closeAtoms,atomBondClashes}=current.quality.geometry;
        if(crossings||closeAtoms||atomBondClashes) fail('Double-chain geometry has overlapping atoms or bonds. Adjust the spacing or anchors.');
        steps.push({type:op.type,...resolved,status:'applied'});
      } else if(op?.type==='moveAtom') {
        fields(op,['type','atomId','x','y']);const i=index(op.atomId);
        if(!validPoint([op.x,op.y]))fail('Invalid absolute molecular coordinates.');
        const positions=coords.map(p=>[...p]);positions[i]=[op.x,op.y];
        adopt(candidate(positions),positions);touched.add(i);steps.push({type:op.type,atomId:op.atomId,status:'applied'});
      } else if(op?.type==='rotateTerminalBond') {
        fields(op,['type','bondId','atomId','angleDegrees','lengthScale']);const i=index(op.atomId);
        const bond=data.bonds.find(b=>b.id===op.bondId),scale=op.lengthScale??1;
        if(!bond||neighbours(i).length!==1||![bond.from,bond.to].includes(op.atomId))fail('rotateTerminalBond requires a degree-one endpoint of the specified bond.');
        if(!Number.isFinite(op.angleDegrees)||Math.abs(op.angleDegrees)>360||!Number.isFinite(scale)||scale<.25||scale>4)fail('Angle must be within ±360 degrees and lengthScale within 0.25–4.');
        const p=coords[parent(i,bond)],v=[coords[i][0]-p[0],coords[i][1]-p[1]],t=op.angleDegrees*Math.PI/180;
        const positions=coords.map(p=>[...p]);positions[i]=[p[0]+scale*(v[0]*Math.cos(t)-v[1]*Math.sin(t)),p[1]+scale*(v[0]*Math.sin(t)+v[1]*Math.cos(t))];
        if(!validPoint(positions[i]))fail('Rotated position is outside supported bounds.');
        adopt(candidate(positions),positions);touched.add(i);steps.push({type:op.type,bondId:op.bondId,atomId:op.atomId,status:'applied'});
      } else if(op?.type==='relaxHydrogens') {
        fields(op,['type','atomIds']);
        if(!Array.isArray(op.atomIds)||!op.atomIds.length||op.atomIds.length>32||new Set(op.atomIds).size!==op.atomIds.length)fail('Select 1–32 unique explicit H atom IDs.');
        for(const id of op.atomIds) {
          const i=index(id),edges=neighbours(i);
          if(data.atoms[i].atomicNumber!==1||edges.length!==1||edges[0].order!==1)fail('relaxHydrogens supports only selected explicit terminal single-bonded H atoms.');
        }
        for(const id of op.atomIds) {
          const i=index(id),p=coords[parent(i,neighbours(i)[0])],old=[...coords[i]];
          const initialScore=current.quality.score;let best=null,bestPositions=null,bestObjective=initialScore,rejected=0;
          for(const radius of [.75,1,1.2])for(let deg=0;deg<360;deg+=15) {
            const t=deg*Math.PI/180,positions=coords.map(p=>[...p]);positions[i]=[p[0]+unit*radius*Math.cos(t),p[1]+unit*radius*Math.sin(t)];
            let next;
            try {
              next=candidate(positions);
              const displacement=Math.hypot(positions[i][0]-old[0],positions[i][1]-old[1])/unit;
              const objective=next.quality.score+displacement*.2;
              if(objective<bestObjective-.05){best?.mol.delete();best=next;next=null;bestPositions=positions;bestObjective=objective;}
            }catch(e){if(e.code!=='VALIDATION')throw e;rejected++;}finally{next?.mol.delete();}
          }
          if(best){adopt(best,bestPositions);touched.add(i);}
          steps.push({type:op.type,atomId:id,status:best?'improved':'unchanged',beforeScore:initialScore,afterScore:current.quality.score,rejectedCandidates:rejected});
        }
      } else fail(`Unsupported depiction operation: ${op?.type}`);
    }
    // Enforce locality independent of RDKit coordinate serialization precision.
    for(let i=0;i<data.atoms.length;i++) {
      const distance=Math.hypot(current.atoms[i].x-data.atoms[i].x,current.atoms[i].y-data.atoms[i].y);
      // V3000 writer retains six decimal places. Validate that quantization,
      // then retain the original graph values exactly for all untouched atoms.
      if(!touched.has(i)&&distance>1e-6)fail('RDKit moved an unselected atom; operation rejected.');
      if(!touched.has(i)||distance<=1e-6) {
        current.atoms[i]={...data.atoms[i]};
        const conf=current.structure.molecules[0].conformers[0];
        conf.coords[i]=conf.dim===3?[data.atoms[i].x,data.atoms[i].y,data.atoms[i].z??0]:[data.atoms[i].x,data.atoms[i].y];
      }
    }
    const movedAtoms=current.atoms.filter((a,i)=>Math.hypot(a.x-data.atoms[i].x,a.y-data.atoms[i].y)>1e-7).map(a=>({id:a.id,before:{x:data.atoms[a.index].x,y:data.atoms[a.index].y},after:{x:a.x,y:a.y}}));
    const delta={addedAtoms:[],removedAtoms:[],changedAtoms:[],addedBonds:[],removedBonds:[],changedBonds:[],movedAtoms,identityPreserved:true,summary:`Local depiction: moved ${movedAtoms.length} selected atoms; chemistry unchanged.`};
    const after=current.quality,warnings=[];
    if(after.display.labelBondClashes.length||after.display.labelLabelClashes.length||after.display.wedgeCrowding.length||after.geometry.crossings||after.geometry.atomBondClashes||after.geometry.closeAtoms)warnings.push('Residual depiction crowding remains; inspect the reported stable atom/bond IDs.');
    const depictionAdjustment={operations:structuredClone(options.operations),steps,before,after,warnings,verification:['indexed-graph','indexed-CIP','complete-InChI','isomeric-SMILES','MOL-roundtrip','unselected-coordinates-unchanged'],representation:'chemical atom coordinates; labels follow their atoms; wedge CFG regenerated from stereo'};
    const molecule=movedAtoms.length?{...data,atoms:current.atoms,bonds:current.bonds,structure:current.structure,molblock:current.molblock,svg:current.svg,drawing:current.drawing,
      chemistry:{...data.chemistry,options:{...data.chemistry?.options,coordinates:'verified-local-depiction-2d'}}}: {...data};
    return {molecule:{...molecule,depictionAdjustment,lastEdit:delta},delta};
  }catch(e){if(e?.code)throw e;throw layoutFailure(`Unable to adjust local depiction: ${e?.message??String(e)}`);}finally{current?.mol.delete();source.delete();}
}
