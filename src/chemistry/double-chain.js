import { layoutFailure } from './layout.js';

const fail = message => { throw layoutFailure(message); };
const ringsOf = structure => structure?.molecules?.[0]?.extensions?.find(e => e.atomRings)?.atomRings ?? [];
export function macrocycleOptions(data) {
  return ringsOf(data.structure).filter(ring => ring.length >= 12).map(ring => ring.map(i => data.atoms[i].id));
}

// RDKit supplies ordered perceived rings. Distinct macrocycles require explicit
// disambiguation; cross-links that cannot be drawn independently are rejected.
export function doubleChain(data, structure, options) {
  const atoms = data.atoms, ids = new Map(atoms.map((a,i) => [a.id,i]));
  const adj = atoms.map(() => []);
  for (const {from,to} of data.bonds) {
    const a = ids.get(from), b = ids.get(to);
    adj[a].push(b); adj[b].push(a);
  }
  const {anchorIds, spanScale = 1, chainGap = 3} = options;
  if (!(Number.isFinite(spanScale) && spanScale >= .75 && spanScale <= 1.4 &&
        Number.isFinite(chainGap) && chainGap >= 2 && chainGap <= 5)) fail('spanScale range 0.75–1.4; chainGap range 2–5 bond lengths.');
  if (anchorIds !== undefined && (!Array.isArray(anchorIds) || anchorIds.length !== 2 || new Set(anchorIds).size !== 2 || !anchorIds.every(id => ids.has(id)))) fail('Specify two distinct stable anchor atom IDs.');
  const all = ringsOf(structure);
  const rings = all.filter(r => r.length >= 12 && (!anchorIds || anchorIds.every(id => r.includes(ids.get(id)))));
  if (rings.length !== 1) fail('Select a unique perceived macrocycle (12+ atoms) with two anchor IDs; no unique matching ring.');
  const ring = rings[0], n = ring.length, onRing = new Set(ring);
  if (ring.some((i,k) => adj[i].some(j => onRing.has(j) && ![ring[(k+1)%n],ring[(k+n-1)%n]].includes(j)))) fail('Chorded macrocycle unsupported.');
  const small = new Set(all.filter(r => r.length < 12).flat());
  // Prefer opposed, substituted end groups near heteroatoms and outside fused rings.
  const weight = i => (small.has(i) ? -20 : 0) + (adj[i].length > 2 ? 2 : 0) + adj[i].filter(j => atoms[j].atomicNumber !== 6).length * 3;
  let left = 0, right = Math.floor(n/2), score = -Infinity;
  for (let k=0;k<n;k++) {
    const j=(k+Math.floor(n/2))%n, s=weight(ring[k])+weight(ring[j]);
    if(s>score){score=s;left=k;right=j;}
  }
  if(anchorIds){[left,right]=anchorIds.map(id=>ring.indexOf(ids.get(id)));}
  const walk = step => {
    const path=[];
    for(let k=left;k!==right;k=(k+n+step)%n) path.push(ring[k]);
    return [...path,ring[right]];
  };
  const paths=[walk(1),walk(-1)];
  if(Math.min(...paths.map(p=>p.length-1))<n*.3) fail('Choose anchors on opposing sides of the macrocycle.');
  const unit=1.5, halfGap=unit*chainGap/2, span=(n/2-2)*unit*.86*spanScale;
  const xy=atoms.map(()=>null);
  xy[ring[left]]=[-unit*.65,0]; xy[ring[right]]=[span+unit*.65,0];
  paths.forEach((path,side)=>{
    const sign=side===0?1:-1;
    path.slice(1,-1).forEach((i,k)=>{xy[i]=[span*k/(path.length-3), sign*(halfGap+(k%2-.5)*unit*.48)];});
  });
  // Each off-ring component is either a pendant fragment or one external
  // path closing a small ring. Preserve pendant geometry by rigid rotation.
  const seen=new Set(ring);
  for(let i=0;i<atoms.length;i++){
    if(seen.has(i))continue;
    const part=[i], links=[]; seen.add(i);
    for(const a of part)for(const b of adj[a]){
      if(onRing.has(b)) links.push([b,a]);
      else if(!seen.has(b)){seen.add(b);part.push(b);}
    }
    if(links.length===1){
      const [[root,first]]=links;
      const attached=adj[root].filter(j=>!onRing.has(j));
      const [x,y]=xy[root], k=ring.indexOf(root);
      const [prev,next]=[xy[ring[(k+n-1)%n]],xy[ring[(k+1)%n]]];
      const angle=Math.atan2(2*y-prev[1]-next[1],2*x-prev[0]-next[0])+
        (attached.indexOf(first)-(attached.length-1)/2)*1.1+.035;
      const dx=atoms[first].x-atoms[root].x, dy=atoms[first].y-atoms[root].y;
      const rotation=angle-Math.atan2(dy,dx);
      for(const a of part){
        const u=atoms[a].x-atoms[root].x,v=atoms[a].y-atoms[root].y;
        xy[a]=[x+u*Math.cos(rotation)-v*Math.sin(rotation),y+u*Math.sin(rotation)+v*Math.cos(rotation)];
      }
    }else if(links.length===2 && part.every(a=>adj[a].length===2)){
      const [[a,first],[b,last]]=links;
      const smallRing=all.find(r=>r.length<12 && [a,b,...part].every(v=>r.includes(v)));
      if(!smallRing || a===b || xy[a][1]*xy[b][1]<=0) fail('Unsupported bridge or anchor inside a fused ring. Choose different anchors.');
      const from=xy[a],to=xy[b], sign=Math.sign(from[1]);
      let prev=a,current=first;
      for(let k=1;k<=part.length;k++){
        const t=k/(part.length+1),theta=Math.PI*t;
        xy[current]=[(from[0]+to[0])/2+(from[0]-to[0])*Math.cos(theta)/2,
          from[1]*(1-t)+to[1]*t+sign*unit*Math.max(1,part.length*.5)*Math.sin(theta)];
        if(k===part.length && current!==last) fail('Unsupported fused path.');
        [prev,current]=[current,adj[current].find(v=>v!==prev)];
      }
    }else fail('Unsupported disconnected fragment, branched bridge or multiply attached substituent.');
  }
  return {positions:xy,anchors:[ring[left],ring[right]].map(i=>atoms[i].id),spanScale,chainGap};
}
