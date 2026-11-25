// Conservative bounds of RDKit's vector glyph outlines, not guessed atom radii.
// No SVG is modified. Curved label control points bound the actual Bezier glyph.
export function depictionQuality(svg, atoms, bonds) {
  const labels=new Map(), strokes=[], wedgeBonds=new Set(), counts=new Map();
  for(const match of svg.matchAll(/<path\b([^>]+)>/g)) {
    const attrs=match[1], cls=attrs.match(/class=['"]([^'"]*)/)?.[1] ?? '';
    const d=attrs.match(/\bd=['"]([^'"]*)/)?.[1] ?? '';
    const bi=cls.match(/\bbond-(\d+)/), ai=cls.match(/\batom-(\d+)/);
    const values=(d.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    const points=[];for(let i=0;i+1<values.length;i+=2)points.push([values[i],values[i+1]]);
    if(!points.length)continue;
    if(!bi && ai) {
      const i=+ai[1], box=labels.get(i) ?? {minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
      for(const [x,y] of points) {box.minX=Math.min(box.minX,x);box.maxX=Math.max(box.maxX,x);box.minY=Math.min(box.minY,y);box.maxY=Math.max(box.maxY,y);}
      labels.set(i,box);
    } else if(bi) {
      const index=+bi[1];counts.set(index,(counts.get(index)??0)+1);
      if(!/fill:none/.test(attrs))wedgeBonds.add(index);
      const commands=d.match(/[MLZmlz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/g) ?? [];
      // RDKit straight/wedge/hash bonds use M/L; unknown curved paths are noted.
      if(/[QqCcAaSsTtHhVv]/.test(d))continue;
      let cursor=null,start=null,mode='M';
      for(let k=0;k<commands.length;) {
        if(/^[MLZmlz]$/.test(commands[k])) {mode=commands[k++].toUpperCase();if(mode==='Z'&&cursor&&start)strokes.push({index,a:cursor,b:start});continue;}
        const p=[+commands[k++],+commands[k++]];
        if(mode==='L'&&cursor)strokes.push({index,a:cursor,b:p});else start=p;
        cursor=p; mode='L';
      }
    }
  }
  // Hashes have short transverse strokes spread along a bond. Counting paths
  // alone misclassifies a coloured triple bond (six long half-bond paths).
  for(const [i,n]of counts)if(n>=3) {
    const segments=strokes.filter(s=>s.index===i);
    const centers=segments.map(s=>[(s.a[0]+s.b[0])/2,(s.a[1]+s.b[1])/2]);
    if(!centers.length)continue;
    const span=Math.hypot(Math.max(...centers.map(p=>p[0]))-Math.min(...centers.map(p=>p[0])),Math.max(...centers.map(p=>p[1]))-Math.min(...centers.map(p=>p[1])));
    const mean=segments.reduce((sum,s)=>sum+Math.hypot(s.a[0]-s.b[0],s.a[1]-s.b[1]),0)/segments.length;
    if(mean<span*.8)wedgeBonds.add(i);
  }
  const hit=(a,b,r)=>{
    let lo=0,hi=1;
    for(const [p,q]of [[a[0]-b[0],a[0]-r.minX],[b[0]-a[0],r.maxX-a[0]],[a[1]-b[1],a[1]-r.minY],[b[1]-a[1],r.maxY-a[1]]]) {
      if(Math.abs(p)<1e-12) {if(q<0)return false;}else {const t=q/p;if(p<0)lo=Math.max(lo,t);else hi=Math.min(hi,t);if(lo>hi)return false;}
    } return true;
  };
  const labelBondClashes=[],labelLabelClashes=[];
  for(const [i,box]of labels) {
    const seen=new Set(),atomId=atoms[i]?.id ?? null;
    // 0.35 intrinsic SVG units: stroke width plus a small clearance.
    const expanded={minX:box.minX-.35,maxX:box.maxX+.35,minY:box.minY-.35,maxY:box.maxY+.35};
    for(const s of strokes) {
      const b=bonds[s.index];if(!b||seen.has(s.index)||b.from===atomId||b.to===atomId)continue;
      if(hit(s.a,s.b,expanded)) {seen.add(s.index);labelBondClashes.push({atomId,rendererAtomIndex:i,bondId:b.id,box});}
    }
    for(const [j,other]of labels)if(j>i&&box.minX<other.maxX&&box.maxX>other.minX&&box.minY<other.maxY&&box.maxY>other.minY)labelLabelClashes.push({atomIds:[atomId,atoms[j]?.id??null],rendererAtomIndices:[i,j]});
  }
  const byId=new Map(atoms.map(a=>[a.id,a])),wedgeCrowding=[];
  for(let i=0;i<bonds.length;i++)for(let j=i+1;j<bonds.length;j++) {
    if(!wedgeBonds.has(i)&&!wedgeBonds.has(j))continue;
    const b=bonds[i],c=bonds[j],common=[b.from,b.to].find(id=>id===c.from||id===c.to);if(!common)continue;
    const p=byId.get(common),a=byId.get(b.from===common?b.to:b.from),d=byId.get(c.from===common?c.to:c.from);
    const u=[a.x-p.x,a.y-p.y],v=[d.x-p.x,d.y-p.y];
    const angle=Math.acos(Math.max(-1,Math.min(1,(u[0]*v[0]+u[1]*v[1])/(Math.hypot(...u)*Math.hypot(...v)))))*180/Math.PI;
    if(angle<30||(wedgeBonds.has(i)&&wedgeBonds.has(j)&&angle>155))wedgeCrowding.push({atomId:common,bondIds:[b.id,c.id],angleDegrees:angle,kind:angle<30?'narrow-angle':'opposed-wedges'});
  }
  return {labelBondClashes,labelLabelClashes,wedgeCrowding,
    score:labelBondClashes.length*100+labelLabelClashes.length*100+wedgeCrowding.length*15,
    limitations:['Glyph control-point bounds are conservative; this is a collision diagnostic, not a publication-quality guarantee.','Renderer-added implicit H labels have no stable atom ID; materializing or moving them is not supported.']};
}
