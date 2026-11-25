// MDL direction codes are oriented from the first atom of a bond. A six-coordinate
// metal in a 2D CTAB needs both depth cues; the atom name or compound title cannot
// distinguish its isomers. Keep the input drawing and verify its indexed geometry.
const readOptions=JSON.stringify({sanitize:true,removeHs:false});
const fail=message=>{throw Object.assign(new Error(message),{code:'VALIDATION'});};
const metal=z=>(z>=21 && z<=30)||(z>=39 && z<=48)||(z>=72 && z<=80);
const tokenPattern=/\[[^\]]+\]|Br|Cl|[BCNOFPSIbcnops]/g;
const types=/@(OH|SP)\d+/;
// Report the indexed graph independently of a geometry claim. In particular,
// four neighbours alone cannot distinguish square-planar and tetrahedral sites.
export function coordinationCenters(graph, verified) {
  return graph.atoms.flatMap((atom, center) => {
    if (!metal(atom.z)) return [];
    const neighbors = (graph.bonds ?? []).filter(bond => bond.atoms.includes(center))
      .map(bond => bond.atoms.find(index => index !== center));
    if (![4, 6].includes(neighbors.length)) return [];
    const record = {center, atomicNumber: atom.z, neighbors, geometry: null, transPairs: null};
    if (verified?.center === center) {
      record.geometry = verified.geometry;
      record.transPairs = verified.transPairs;
    }
    return [record];
  });
}
function spatialHeader(block) {
  return block.replace(/^(.*\n)([^\n]*)/,(_,title,line)=>title+line.replace('2D','3D'));
}

// Preserve authored bond directions and all other CTAB fields during a 2D
// coordinate edit. The caller re-perceives the stereo on the resulting block.
export function coordinationCoordinates(block,positions) {
  const lines=block.replace(/\r/g,'').split('\n');
  const v3=lines[3].includes('V3000');
  const start=v3?lines.indexOf('M  V30 BEGIN ATOM')+1:4;
  for(const [i,[x,y]] of positions.entries()) {
    const line=lines[start+i];
    if(v3) {
      lines[start+i]=line.replace(/^(M\s+V30\s+\d+\s+\S+)\s+\S+\s+\S+/,(_,head)=>head+' '+x.toFixed(6)+' '+y.toFixed(6));
    } else {
      const pair=[x,y].map(v=>v.toFixed(4).padStart(10));
      if(pair.some(field=>field.length!==10)) fail('Coordinates exceed the V2000 field width.');
      lines[start+i]=pair.join('')+line.slice(20);
    }
  }
  return lines.join('\n');
}

function smilesOrder(mol) {
  const smiles=mol.get_smiles('{"canonical":false}');
  const order=JSON.parse(mol.get_prop('_smilesAtomOutputOrder'));
  const tokens=[...smiles.matchAll(tokenPattern)];
  if(order.length!==tokens.length) fail('Unable to map coordination center to the indexed SMILES.');
  return {smiles,order,tokens,bonds:mol.get_prop('_smilesBondOutputOrder')};
}

function directionalBonds(block) {
  const lines=block.replace(/\r/g,'').split('\n');
  if(lines[3].includes('V3000')) {
    const atomStart=lines.indexOf('M  V30 BEGIN ATOM')+1;
    const atomIds=new Map(lines.slice(atomStart,lines.indexOf('M  V30 END ATOM')).map((line,i)=>[Number(line.split(/\s+/)[2]),i]));
    const start=lines.indexOf('M  V30 BEGIN BOND')+1;
    return lines.slice(start,lines.indexOf('M  V30 END BOND')).flatMap(line=>{
      const match=line.match(/^M\s+V30\s+\d+\s+1\s+(\d+)\s+(\d+)\b.*?\bCFG=([13])\b/);
      return match?[{from:atomIds.get(+match[1]),to:atomIds.get(+match[2]),front:match[3]==='1'}]:[];
    });
  }
  const atomCount=Number(lines[3].slice(0,3)),bondCount=Number(lines[3].slice(3,6));
  return lines.slice(4+atomCount,4+atomCount+bondCount).flatMap(line=>{
    const direction=Number(line.slice(9,12));
    if(Number(line.slice(6,9))!==1 || ![1,6].includes(direction)) return [];
    return [{from:Number(line.slice(0,3))-1,to:Number(line.slice(3,6))-1,front:direction===1}];
  });
}

function vectors(coords,center,indices) {
  return indices.map(i=>{
    const dx=coords[i][0]-coords[center][0], dy=coords[i][1]-coords[center][1],length=Math.hypot(dx,dy);
    return {atom:i,x:dx/length,y:dy/length};
  });
}
const dot=(a,b)=>a.x*b.x+a.y*b.y;
function planarAxes(coords,center,indices) {
  const [first,...rest]=vectors(coords,center,indices);
  const opposite=rest.reduce((a,b)=>dot(first,a)<dot(first,b)?a:b);
  const [u,v]=rest.filter(x=>x!==opposite);
  if(!(dot(first,opposite)<-0.78 && dot(u,v)<-0.78 && Math.abs(dot(first,u))<0.8)) return null;
  return [first,opposite,...(first.x*u.y-first.y*u.x>0?[u,v]:[v,u])].map(v=>v.atom);
}

// Ask RDKit to assign the permutation from an idealized local 3D coordination
// frame. Transfer just this center's tag back to the original traversal so that
// no tetrahedral center elsewhere is ever assigned from our temporary geometry.
function canonicalFromFrame(rdkit,mol,center,axes,front,back) {
  const xyz=new Map(axes.map((index,i)=>[index,[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0]][i]]));
  if(front!=null){xyz.set(front,[0,0,1]);xyz.set(back,[0,0,-1]);}
  const probeBlock=spatialHeader(mol.get_v3Kmolblock()).replace(/(M  V30 BEGIN ATOM\n)([\s\S]*?)(M  V30 END ATOM)/,(_,open,body,close)=>
    open+body.trimEnd().split('\n').map((line,index)=>line.replace(/^(M  V30 \d+ \S+) \S+ \S+ \S+/,(_,head)=>head+' '+(xyz.get(index)||[0,0,0]).join(' '))).join('\n')+'\n'+close);
  const probe=rdkit.get_mol(probeBlock,readOptions);
  let tagged;
  try {
    if(!probe) fail('RDKit could not read the local coordination frame.');
    const source=smilesOrder(mol),model=smilesOrder(probe);
    if(String(source.order)!==String(model.order) || source.bonds!==model.bonds) fail('Cannot transfer coordination stereo across different SMILES traversals.');
    const pos=source.order.indexOf(center),token=source.tokens[pos],tag=model.tokens[pos][0].match(types)?.[0];
    if(!tag || !tag.startsWith(front==null?'@SP':'@OH')) fail('RDKit did not recognize the supplied coordination geometry.');
    const changed=token[0].replace(types,'').replace(/^(\[\d*[A-Z][a-z]?)/,'$1'+tag);
    tagged=rdkit.get_mol(source.smiles.slice(0,token.index)+changed+source.smiles.slice(token.index+token[0].length),readOptions);
    if(!tagged || !types.test(tagged.get_smiles())) fail('RDKit could not retain the indexed coordination stereochemistry.');
    return tagged.get_smiles();
  } finally {probe?.delete();tagged?.delete();}
}

function centerInfo(mol,center) {
  const graph=JSON.parse(mol.get_json()).molecules[0];
  return {coords:graph.conformers?.[0]?.coords,neighbors:graph.bonds.filter(b=>b.atoms.includes(center)).map(b=>b.atoms.find(i=>i!==center))};
}
function projection(rdkit,mol,center,front,back) {
  const {coords,neighbors}=centerInfo(mol,center);
  const planar=neighbors.filter(i=>i!==front && i!==back);
  if(!coords || planar.length!==4 || new Set(planar).size!==4) return null;
  const axes=planarAxes(coords,center,planar);
  if(!axes) return null;
  const pairs=[[axes[0],axes[1]],[axes[2],axes[3]]];
  if(front!=null) pairs.push([front,back]);
  return {smiles:canonicalFromFrame(rdkit,mol,center,axes,front,back),center,
    geometry:front==null?'square-planar':'octahedral',transPairs:pairs.map(pair=>pair.sort((a,b)=>a-b)).sort((a,b)=>a[0]-b[0]),
    ...(front==null?{}:{solidLigand:front,hashedLigand:back})};
}

// A stereospecified SMILES has no authored 2D coordinates. Emit a CTAB which
// survives a fresh read, and accept only a projection that reproduces the
// original canonical isomeric SMILES (also distinguishes octahedral enantiomers).
function fromTagged(rdkit,mol,center,tag) {
  const canonical=mol.get_smiles();
  if(!mol.set_new_coords(false)) fail('RDKit could not depict this coordination center.');
  const block=mol.get_v3Kmolblock();
  if(tag.startsWith('@SP')) {
    const info=projection(rdkit,mol,center,null,null);
    if(info?.smiles===canonical) {
      const spatial=spatialHeader(block),rt=rdkit.get_mol(spatial,readOptions);
      try { if(rt?.get_smiles()===canonical) return {block:spatial,info}; } finally {rt?.delete();}
    }
  } else {
    const {neighbors}=centerInfo(mol,center);
    const singles=[...block.matchAll(/^M  V30 \d+ 1 (\d+) (\d+)(?: .*?)?$/gm)]
      .filter(m=>+m[1]===center+1 || +m[2]===center+1).map(m=>(+m[1]===center+1?+m[2]:+m[1])-1);
    if(neighbors.length===6) for (const front of singles) for(const back of singles) {
      if(front===back) continue;
      const info=projection(rdkit,mol,center,front,back);
      if(info?.smiles!==canonical) continue;
      // Write the narrow end at the center; donor/acceptor order of dative bonds is untouched.
      const marked=block.replace(/^(M  V30 \d+ 1) (\d+) (\d+)(.*?)$/gm,(line,head,a,b,tail)=>{
        if(+a!==center+1 && +b!==center+1) return line;
        const other=(+a===center+1?+b:+a)-1;
        if(other!==front && other!==back) return line;
        return head+' '+(center+1)+' '+(other+1)+tail.replace(/ CFG=\d+/g,'')+' CFG='+(other===front?1:3);
      });
      return {block:marked,info};
    }
  }
  fail('No faithful 2D projection for this tagged center. Supply an authored 2D MOL with metal-origin solid/hashed bonds and four in-plane ligands for an octahedral complex.');
}

export function coordinationInput(rdkit,mol,rawBlock) {
  const canonical=mol.get_smiles();
  const graph=JSON.parse(mol.get_json()).molecules[0];
  if(!graph.atoms.some(a=>metal(a.z))) return null;
  if(types.test(canonical)) {
    const order=smilesOrder(mol),sites=order.tokens.flatMap((token,i)=>types.test(token[0])?[{center:order.order[i],tag:token[0].match(types)[0]}]:[]);
    if(sites.length!==1) fail('Supply one stereospecified coordination center per molecule.');
    const {center,tag}=sites[0];
    // The generated square-planar CTAB is 3D planar, a standard exchange case.
    if(rawBlock && tag.startsWith('@SP') && mol.has_coords()===3) {
      const info=projection(rdkit,mol,center,null,null);
      if(info?.smiles===canonical && graph.conformers[0].coords.every(p=>Math.abs(p[2]||0)<1e-7))return {block:rawBlock,info};
    }
    return fromTagged(rdkit,mol,center,tag);
  }
  if(!rawBlock) return null;
  const cues=directionalBonds(rawBlock).filter(b=>metal(graph.atoms[b.from]?.z));
  const centers=[...new Set(cues.map(c=>c.from))].filter(i=>centerInfo(mol,i).neighbors.length===6);
  if(!centers.length) return null;
  const at=cues.filter(b=>b.from===centers[0]),up=at.filter(b=>b.front),down=at.filter(b=>!b.front);
  if(centers.length!==1 || up.length!==1 || down.length!==1) fail('An octahedral 2D MOL requires one solid and one hashed single bond from the metal, and four in-plane ligands.');
  const info=projection(rdkit,mol,centers[0],up[0].to,down[0].to);
  if(!info) fail('The four in-plane metal bonds must define two unambiguous opposite pairs.');
  return {block:rawBlock,info};
}
