import {createHash} from 'node:crypto';
import {applyOperation,validateDocument} from '../src/core/index.js';
import {parseMolblock} from '../src/chemistry/index.js';
import {reactionScheme} from './reaction-scheme.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const need=(condition,message,code='UNSUPPORTED_CDXML')=>{if(!condition) throw Object.assign(new Error(message),{code});};
const allowed={CDXML:'id CreationProgram BondLength LabelFont CaptionFont BoundingBox Name',fonttable:'',font:'id charset name',page:'id BoundingBox',fragment:'id BoundingBox',n:'id p Element NumHydrogens Charge Isotope NodeType',b:'id B E Order Display',arrow:'id Tail3D Head3D ArrowheadHead ArrowheadType BoundingBox',t:'id p Justification BoundingBox',s:'font size',graphic:'id BoundingBox GraphicType SymbolType',scheme:'id',step:'id ReactionStepReactants ReactionStepProducts ReactionStepArrows ReactionStepPlusses ReactionStepObjectsAboveArrow ReactionStepObjectsBelowArrow'};
const children={CDXML:['fonttable','page'],fonttable:['font'],page:['fragment','t','arrow','graphic','scheme'],fragment:['n','b'],t:['s'],scheme:['step']};
const decimal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const coordinates=(text,count)=>{
  const parts=(text??'').trim().split(/\s+/);need(parts.length===count&&parts.every(part=>decimal.test(part)&&Math.abs(Number(part))<=32768),'Invalid or excessive CDXML coordinates.');return parts.map(Number);
};
const idsOf=(node,attr)=>{const words=(node.a[attr]??'').trim().split(/\s+/).filter(Boolean);need(words.length<=256,'Too many references in one attribute.');return words;};
const xmlChars=/^[\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]*$/u;
function decode(text){
  let previous=0, output='';
  for(let index=text.indexOf('&');index>=0;index=text.indexOf('&',previous)){
    const end=text.indexOf(';',index+1);need(end>index&&end-index<=13,'Invalid XML entity.');
    const key=text.slice(index+1,end), entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
    let value;
    if(Object.hasOwn(entities,key))value=entities[key];
    else {need(/^#(?:\d+|x[0-9a-f]+)$/i.test(key),'Named entity is not permitted.');const code=key[1]==='x'?parseInt(key.slice(2),16):Number(key.slice(1));need(Number.isInteger(code)&&code<=0x10ffff,'Invalid character reference.');value=String.fromCodePoint(code);need(xmlChars.test(value),'Invalid XML character.');}
    output+=text.slice(previous,index)+value;previous=end+1;
  }
  return output+text.slice(previous);
}
function parseXml(source){
  const text=source.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');need(xmlChars.test(text),'Invalid XML character.');
  let cursor=0,root,count=0,referenceCount=0,doctype=false;const stack=[],ids=new Map(),fonts=new Set();
  const name=/[A-Za-z][A-Za-z0-9_-]*/y,space=()=>{const start=cursor;while(/[ \t\n]/.test(text[cursor]??'!'))cursor++;return cursor>start;};
  const token=()=>{name.lastIndex=cursor;const match=name.exec(text);need(match,'Expected XML name.');cursor=name.lastIndex;return match[0];};
  if(text.startsWith('<?xml')){const end=text.indexOf('?>');need(end>0&&end<150&&/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"utf-8"|'utf-8'))?\s*\?>$/i.test(text.slice(0,end+2)),'Unsupported XML declaration.');cursor=end+2;}
  while(cursor<text.length){
    if(text[cursor]!=='<'){
      const stop=text.indexOf('<',cursor),end=stop<0?text.length:stop,raw=text.slice(cursor,end);need(!raw.includes(']]>'),'Invalid XML text.');
      if(stack.at(-1)?.tag==='s')stack.at(-1).text+=decode(raw);else need(!raw.trim(),'Unexpected text outside a style span.');cursor=end;continue;
    }
    cursor++;
    if(!root&&!doctype&&text.startsWith('!DOCTYPE',cursor)){
      const header=/^!DOCTYPE\s+CDXML\s+(?:SYSTEM\s+|PUBLIC\s+(?:"[\w /:.+-]{1,100}"|'[\w /:.+-]{1,100}')\s+)(["'])(https?:\/\/(?:www\.cambridgesoft\.com\/xml\/cdxml\.dtd|static\.chemistry\.revvitycloud\.com\/cdxml\/cdxml\.dtd))\1\s*>/i.exec(text.slice(cursor,cursor+400));need(header,'Untrusted DOCTYPE or internal subset.');cursor+=header[0].length;doctype=true;continue;
    }
    if(text[cursor]==='/'){cursor++;const tag=token();space();need(text[cursor++]==='>'&&stack.pop()?.tag===tag,'Unbalanced XML tags.');continue;}
    need(text[cursor]!=='!'&&text[cursor]!=='?','DTD, declarations, comments and processing instructions are not accepted.');
    const tag=token(),parent=stack.at(-1);need(Object.hasOwn(allowed,tag)&&(!parent?tag==='CDXML'&&!root:children[parent.tag]?.includes(tag)),`Unsupported or misplaced <${tag}>.`);
    need(++count<=6000&&stack.length<12,'XML tree exceeds limits.');const node={tag,a:Object.create(null),children:[],text:''};if(parent)parent.children.push(node);else root=node;
    let closed=false;
    while(cursor<text.length){const spaced=space();if(text.startsWith('/>',cursor)){cursor+=2;closed=true;break;}if(text[cursor]==='>'){cursor++;stack.push(node);closed=true;break;}
      need(spaced,'Missing attribute separator.');const attr=token();need(allowed[tag].split(' ').includes(attr)&&!Object.hasOwn(node.a,attr),`Unknown or duplicate ${tag}.${attr}.`);
      space();need(text[cursor++]==='=','Expected XML attribute value.');space();const quote=text[cursor++];need(quote==='"'||quote==="'",'Unquoted attribute.');const end=text.indexOf(quote,cursor);need(end>=cursor&&end-cursor<=8192,'Invalid attribute length.');const val=text.slice(cursor,end);need(!val.includes('<'),'Invalid XML attribute.');node.a[attr]=decode(val);cursor=end+1;
    }
    need(closed,'Unclosed XML tag.');const id=node.a.id;
    if(id!==undefined){need(/^[1-9]\d{0,9}$/.test(id),'Invalid object ID.');const table=tag==='font'?fonts:ids;need(!table.has(id),'Duplicate object ID.');if(tag==='font')fonts.add(id);else ids.set(id,node);}
    if(['n','fragment','arrow','t','graphic','step'].includes(tag))need(id,'Missing object ID.');
    for(const attr of Object.keys(node.a))if(attr.startsWith('ReactionStep')||['B','E'].includes(attr))referenceCount+=idsOf(node,attr).length;
    need(referenceCount<=12000,'Too many references.');
  }
  need(root&&!stack.length,'Incomplete XML.');
  for(const font of [root.a.LabelFont,root.a.CaptionFont,...[...ids.values()].filter(node=>node.tag==='t').flatMap(node=>node.children.map(span=>span.a.font))]) if(font!==undefined)need(fonts.has(font),'Dangling font reference.');
  return {root,ids};
}

const elementNames={1:'H',5:'B',6:'C',7:'N',8:'O',9:'F',14:'Si',15:'P',16:'S',17:'Cl',35:'Br',53:'I'};
const pad=value=>String(value).padStart(3);
function boundedInt(value,min,max){need(/^-?\d+$/.test(value)&&Number(value)>=min&&Number(value)<=max,'Unsupported integer property.');return Number(value);}
async function molecule(fragment,objectId,idMap){
  const nodes=fragment.children.filter(node=>node.tag==='n'), bonds=fragment.children.filter(node=>node.tag==='b');need(nodes.length>0&&nodes.length<=256&&bonds.length<=384,'Molecule exceeds import profile.');
  const points=nodes.map(node=>coordinates(node.a.p,2)), index=new Map(nodes.map((node,idx)=>[node.a.id,idx])),properties=[],wedges=[];
  const xMin=Math.min(...points.map(pair=>pair[0])),xMax=Math.max(...points.map(pair=>pair[0])),yMin=Math.min(...points.map(pair=>pair[1]));
  const pairs=new Set(), lengths=[];
  const bondLines=bonds.map(bond=>{let begin=index.get(bond.a.B),end=index.get(bond.a.E);need(begin!==undefined&&end!==undefined&&begin!==end,'Dangling, wrong-type or cross-fragment bond.');const key=[begin,end].sort().join(':');need(!pairs.has(key),'Duplicate bond.');pairs.add(key);const length=Math.hypot(points[begin][0]-points[end][0],points[begin][1]-points[end][1]);need(length>0.001,'Collapsed bond.');lengths.push(length);
    const order=boundedInt(bond.a.Order??'1',1,3),display=bond.a.Display??'Solid';need(['Solid','WedgeBegin','WedgeEnd','WedgedHashBegin','WedgedHashEnd'].includes(display),'Unsupported bond display or stereo.');
    if(display.endsWith('End'))[begin,end]=[end,begin];const stereo=display==='Solid'?0:display.startsWith('WedgedHash')?6:1;if(stereo){need(order===1,'Unsupported wedge order.');wedges.push(begin);}
    return `${pad(begin+1)}${pad(end+1)}${pad(order)}${pad(stereo)}`;
  });
  const scale=lengths.length?1.5/(lengths.reduce((sum,len)=>sum+len,0)/lengths.length):1;
  const quantized=points.map(([x,y])=>[Number(((x-xMin)*scale).toFixed(4)),Number(((yMin-y)*scale).toFixed(4))]);
  need(new Set(quantized.map(pair=>pair.join(':'))).size===nodes.length,'Overlapping atoms or coordinate precision loss.');
  for(const center of wedges){
    const vectors=bonds.filter(bond=>[bond.a.B,bond.a.E].includes(nodes[center].a.id)).map(bond=>{
      const other=index.get(bond.a.B===nodes[center].a.id?bond.a.E:bond.a.B);
      return quantized[other].map((value,axis)=>value-quantized[center][axis]);
    });
    need(vectors.length===3||vectors.length===4,'Unsupported wedge coordination.');
    need(vectors.every(([x,y],idx)=>vectors.slice(idx+1).every(([u,v])=>x*u+y*v<=0||Math.abs(x*v-y*u)>0.001*Math.hypot(x,y)*Math.hypot(u,v))),'Overlapping ligand rays at wedge center.');
    need(vectors.some(([x,y])=>vectors.some(([u,v])=>Math.abs(x*v-y*u)>0.001*Math.hypot(x,y)*Math.hypot(u,v))),'Collinear wedge center.');
  }
  const atomLines=nodes.map((node,idx)=>{const symbol=elementNames[node.a.Element??6];need(typeof symbol==='string'&&(!node.a.NodeType||node.a.NodeType==='Element'),'Unsupported atom or superatom.');
    for(const [attr,tag,min,max] of [['Charge','CHG',-8,8],['Isotope','ISO',0,300]])if(node.a[attr]!==undefined){const num=boundedInt(node.a[attr],min,max);if(num)properties.push(`M  ${tag}  1 ${pad(idx+1)} ${pad(num)}`);}
    const nums=[(points[idx][0]-xMin)*scale,(yMin-points[idx][1])*scale,0].map(num=>num.toFixed(4));need(nums.every(num=>num.length<=10),'Molecule coordinates out of range.');return `${nums.map(num=>num.padStart(10)).join('')} ${symbol.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`;
  });
  const block=['','  Canvas            2D','',`${pad(nodes.length)}${pad(bonds.length)}  0  0  0  0  0  0  0  0999 V2000`,...atomLines,...bondLines,...properties,'M  END',''].join('\n');
  const data=await parseMolblock(block);need(!data.smiles.includes('.')&&!data.atoms.some(atom=>atom.radicalElectrons),'Disconnected or radical molecule.');
  need(data.atoms.length===nodes.length&&data.bonds.length===bonds.length,'Molecule size changed during parsing.');
  const atomIndices=new Map(data.atoms.map((atom,idx)=>[atom.id,idx]));
  for(const [idx,bond] of data.bonds.entries()){
    const source=bonds[idx],expected=[index.get(source.a.B),index.get(source.a.E)].sort().join(':');
    need([atomIndices.get(bond.from),atomIndices.get(bond.to)].sort().join(':')===expected,'Bond endpoints changed during parsing.');
    need(bond.order===Number(source.a.Order??1)||bond.aromatic&&[1,2].includes(Number(source.a.Order??1))&&[1,2].includes(bond.order),'Bond order changed during parsing.');
  }
  need(data.atoms.every((atom,idx)=>atom.stereo==='unspecified'||wedges.includes(idx)),'Inferred stereocenter lacks a source wedge.');
  need(!data.bonds.some(bond=>bond.stereo!=='unspecified'),'E/Z or geometrically ambiguous alkene is outside the profile.');
  need(new Set(wedges).size===wedges.length,'Multiple wedges on one atom are not supported.');
  for(const idx of wedges)need(data.atoms[idx].atomicNumber===6&&['cw','ccw'].includes(data.atoms[idx].stereo),'Wedge does not encode an assigned carbon center.');
  for(const [idx,node] of nodes.entries())need(data.atoms[idx].atomicNumber===Number(node.a.Element??6)&&data.atoms[idx].isotope===Number(node.a.Isotope??0)&&data.atoms[idx].formalCharge===Number(node.a.Charge??0),'Chemical parser changed an element, isotope or charge.');
  const old=new Map();for(const [idx,node] of nodes.entries()){const atom=data.atoms[idx];if(node.a.NumHydrogens!==undefined)need(atom.implicitHydrogens===boundedInt(node.a.NumHydrogens,0,8),'Hydrogen count changed during parsing.');const id=`${objectId}-a${idx}`;old.set(atom.id,id);atom.id=id;idMap[node.a.id]=id;}
  for(const [idx,bond] of data.bonds.entries()){bond.id=`${objectId}-b${idx}`;bond.from=old.get(bond.from);bond.to=old.get(bond.to);if(bond.stereoAtoms)bond.stereoAtoms=bond.stereoAtoms.map(key=>old.get(key));if(bonds[idx].a.id)idMap[bonds[idx].a.id]=bond.id;}
  return {data,xMin,xMax,yMin};
}

function requestInfo(input){
  need(typeof input?.cdxml==='string'&&Buffer.byteLength(input.cdxml)>0&&Buffer.byteLength(input.cdxml)<=512*1024,'CDXML must be 1–524288 bytes.','VALIDATION');
  const {expectedRevision,operationId,actor='human'}=input;
  need(Number.isSafeInteger(expectedRevision)&&expectedRevision>=0&&typeof operationId==='string'&&/^[\w.:-]{1,160}$/.test(operationId)&&!['constructor','__proto__','prototype'].includes(operationId)&&['human','agent'].includes(actor),'Invalid revision, actor or operationId.','VALIDATION');
  return {expectedRevision,operationId,actor,sourceSha256:hash(input.cdxml)};
}
async function plan(document,source,request){
  need(request.expectedRevision===document.revision,'Revision changed.','CONFLICT');
  const {root,ids}=parseXml(source),pages=root.children.filter(node=>node.tag==='page');need(pages.length===1,'Requires exactly one page.');
  const page=pages[0],all=tag=>page.children.filter(node=>node.tag===tag),fragments=all('fragment'),schemes=all('scheme');need(fragments.length>0&&fragments.length<=100&&schemes.length<=1,'Unsupported empty, large or multiple scheme.');
  const steps=schemes[0]?.children??[],ownFormat=root.a.CreationProgram==='Chem Canvas';need(steps.length<=80&&(!schemes.length||steps.length>0),'Invalid scheme steps.');
  const warnings=[{code:'STYLE_SUBSET',message:'Imported chemistry and editable positions, not exact fonts, page/print settings or original metadata.'}],idMap={},changes=[],positions={},labels=new Map(),used=new Set(),models=new Map(),stepData=new Map();
  const prefix='cdx-'+hash(document.id+'\0'+request.operationId+'\0'+request.sourceSha256).slice(0,32),objectKey=node=>`${prefix}-${node.a.id}`;
  const textOf=node=>{need(node.children.length===1,'Requires a single plain text style span.');return node.children[0].text;};
  const references=(node,attr,tag,min,max)=>{const keys=idsOf(node,attr);need(keys.length>=min&&keys.length<=max,`Unsupported number of ${attr} references.`);return keys.map(key=>{const target=ids.get(key);need(target?.tag===tag,`Dangling or wrong-type reference ${attr}:${key}.`);used.add(target);return target;});};
  const adjacentLabel=new Map();for(const [idx,node] of page.children.entries())if(node.tag==='fragment'&&page.children[idx+1]?.tag==='t')adjacentLabel.set(page.children[idx+1],node);
  for(const step of steps){
    const reactants=references(step,'ReactionStepReactants','fragment',1,100),products=references(step,'ReactionStepProducts','fragment',1,100),[arrow]=references(step,'ReactionStepArrows','arrow',1,1),[above]=references(step,'ReactionStepObjectsAboveArrow','t',0,1),[below]=references(step,'ReactionStepObjectsBelowArrow','t',0,1),pluses=references(step,'ReactionStepPlusses','graphic',0,100);
    const tails=coordinates(arrow.a.Tail3D,3),heads=coordinates(arrow.a.Head3D,3);need(heads[0]>tails[0]&&Math.abs(heads[1]-tails[1])<0.0001&&heads[2]===0&&tails[2]===0&&arrow.a.ArrowheadHead==='Full'&&(!arrow.a.ArrowheadType||arrow.a.ArrowheadType==='Solid'),'Only horizontal forward arrows are supported.');
    for(const plus of pluses)need(plus.a.GraphicType==='Symbol'&&plus.a.SymbolType==='Plus','Unsupported graphic.');
    const stepId=objectKey(step);stepData.set(stepId,{step,reactants,products,arrow,above,below,pluses,tails,heads});idMap[step.a.id]=stepId;
  }
  for(const caption of all('t'))if(!used.has(caption)){const fragment=adjacentLabel.get(caption);need(ownFormat&&fragment,'Unbound free text cannot be attached without guessing.');labels.set(fragment,caption);used.add(caption);}
  need([...all('arrow'),...all('graphic'),...(steps.length?fragments:[])].every(node=>used.has(node)),'Unbound arrow, symbol or fragment in scheme.');
  const maxBottom=Object.values(document.views).reduce((bottom,v)=>Math.max(bottom,v.y+v.height),0);let viewCount=0;
  function addObject(id,kind,title,data,sourceId){
    const viewId=`v-${id}`;changes.push({type:'createObject',object:{id,kind,title,data,provenance:{source:'CDXML',sourceSha256:request.sourceSha256,sourceId}}},{type:'createView',view:{id:viewId,objectId:id,x:40+(viewCount%4)*300,y:maxBottom+60+Math.floor(viewCount/4)*250,width:260,height:210}});viewCount++;
  }
  for(const node of fragments){const id=objectKey(node),model=await molecule(node,id,idMap);models.set(id,model);idMap[node.a.id]=id;const label=labels.get(node),title=label?textOf(label):`Compound ${node.a.id}`;if(label)idMap[label.a.id]=id;addObject(id,'molecule',title,{...model.data,label:title},node.a.id);}
  let edgeCount=0;
  for(const [id,entry] of stepData){const {step,reactants,products,above,below}=entry,lines=below?textOf(below).split('\n'):[];const title=ownFormat&&lines.length?lines.pop():`Step ${step.a.id}`;
    addObject(id,'reaction',title,{above:above?textOf(above):'',below:lines.join('\n'),label:ownFormat?title:''},step.a.id);
    for(const [kind,nodes] of [['reactant',reactants],['product',products]])for(const node of nodes){const mol=objectKey(node),from=kind==='reactant'?mol:id,to=kind==='product'?mol:id;changes.push({type:'createRelation',relation:{id:`${prefix}-edge${edgeCount++}`,kind,from,to,fromViewId:`v-${from}`,toViewId:`v-${to}`}});}
  }
  const counts={molecules:fragments.length,reactions:steps.length,relations:edgeCount,views:viewCount};
  const next=applyOperation(document,{...request,intent:'Import CDXML',changes});let svg;
  if(steps.length){
    warnings.push({code:'TEXT_ROLES',message:'Condition and yield text retained as displayed; no inferred structured yields or reagent identities.'},{code:'INSTANCE_IDENTITY',message:'Each distinct fragment ID is a separate molecule; repeated drawings are not merged by appearance.'});
    if(labels.size)warnings.push({code:'LABEL_ATTACHMENT',message:'Chem Canvas fragment captions are attached in writer order and follow their molecule; independent caption placement is not retained.'});
    const old=await reactionScheme(document),oldElements=new Map(old.elements.map(item=>[item.id,item]));need(!old.warnings.some(w=>w.code==='TOPOLOGY_CHANGED'),'Existing Scheme has unsaved topology changes; save it first.');
    const width=document.schemeLayout?.rowWidth??1200;const automatic=await reactionScheme(next,{rowWidth:width});
    for(const item of old.elements)positions[item.id]={x:item.x,y:item.y};
    const starts=[...old.starts];let prev;
    for(const step of automatic.steps){const entry=stepData.get(step.reactionId);if(!entry){prev=undefined;continue;}positions[step.arrowId]={x:0,y:0};if(!prev||prev.products.length!==1||entry.reactants.length!==1||prev.products[0]!==entry.reactants[0])starts.push(step.reactionId);prev=entry;}
    next.schemeLayout={version:next.revision,rowWidth:width,positions,starts};const merged=await reactionScheme(next);
    const extras=merged.elements.filter(item=>stepData.has(item.reactionId));const byDisplay=new Map(),plusIndexes=new Map();
    for(const step of merged.steps){const entry=stepData.get(step.reactionId);if(!entry)continue;
      for(const [role,nodes] of [['reactant',entry.reactants],['product',entry.products]]){const keys=step[role+'Displays'];need(keys.length===nodes.length,'Cannot represent shared display topology.');keys.forEach((key,idx)=>{need(!byDisplay.has(key)||byDisplay.get(key)===nodes[idx],'Different fragments collapsed to one display.');byDisplay.set(key,nodes[idx]);});}
    }
    const shiftY=old.elements.length?Math.max(...old.elements.map(item=>item.y+item.height))+64:0;
    const pending=[];for(const item of extras){const entry=stepData.get(item.reactionId);let x,y,sourceNode;
      if(item.kind==='molecule'){sourceNode=byDisplay.get(item.id);need(sourceNode,'Missing display source.');const model=models.get(item.objectId);x=model.xMin+model.xMax-item.width/2;y=model.yMin*2-8;}
      else if(item.kind==='arrow'){sourceNode=entry.arrow;x=entry.tails[0]*2;y=entry.tails[1]*2-item.height/2;if(Math.abs((entry.heads[0]-entry.tails[0])*2-item.width)>0.1)warnings.push({code:'ARROW_WIDTH',message:`Arrow ${sourceNode.a.id}: tail preserved; length determined by Canvas conditions.`});}
      else if(item.kind==='conditions'){sourceNode=entry[item.slot];if(sourceNode){const [left,top]=coordinates(sourceNode.a.p,2);x=left*2-(sourceNode.a.Justification==='Center'?item.width/2:0);y=top*2-15;}else {x=entry.tails[0]*2;y=entry.tails[1]*2+13;}}
      else if(item.kind==='plus'){const idx=plusIndexes.get(entry)??0;sourceNode=entry.pluses[idx];plusIndexes.set(entry,idx+1);if(sourceNode){const box=coordinates(sourceNode.a.BoundingBox,4);x=box[0]+box[2]-item.width/2;y=box[1]+box[3]-item.height/2;}else {warnings.push({code:'GENERATED_PLUS',message:'Generated a separator absent from the source step.'});x=item.x;y=item.y;}}
      else need(false,'Unsupported display element.');if(sourceNode&&item.kind!=='molecule'){need(!Object.hasOwn(idMap,sourceNode.a.id),'Multiple steps reuse a non-molecular graphic.');idMap[sourceNode.a.id]=item.id;}
      pending.push({id:item.id,x,y});
    }
    for(const entry of stepData.values())need((plusIndexes.get(entry)??0)>=entry.pluses.length,'Extra plus cannot be represented.');
    const dx=Math.max(0,-Math.min(...pending.map(p=>p.x))),dy=shiftY+Math.max(0,-Math.min(...pending.map(p=>p.y)));
    for(const p of pending)positions[p.id]={x:p.x+dx,y:p.y+dy};
    need(merged.elements.length===Object.keys(positions).length&&[...oldElements].every(([key,oldItem])=>merged.elements.some(item=>item.id===key&&item.x===oldItem.x&&item.y===oldItem.y)),'Merge would change an existing display; import rejected.');
    next.schemeLayout.starts=merged.starts;const final=await reactionScheme(next);svg=(await reactionScheme(next,{reactionIds:[...stepData.keys()]})).svg;
    need(!final.warnings.some(w=>w.code==='TOPOLOGY_CHANGED'),'Incomplete layout.');
    const importedDisplays=new Set(extras.map(item=>item.id));for(const warning of final.warnings)if(warning.code==='OVERLAP'&&warning.ids.some(id=>importedDisplays.has(id)))warnings.push({...warning,message:'Imported Scheme has overlapping display boxes. Review the preview before saving.'});
    if(old.elements.length||dx||dy)warnings.push({code:'PAGE_TRANSLATED',message:`Imported Scheme translated by (${dx}, ${dy}) Canvas units; existing displays unchanged.`});
    if(!document.schemeLayout&&old.elements.length)warnings.push({code:'FROZEN_EXISTING_DRAFT',message:'Existing automatic Scheme frozen at its current positions.'});
    next.history.at(-1).schemeEdit=true;next.history.at(-1).after.schemeLayout=structuredClone(next.schemeLayout);
  }else {need(fragments.length===1,'Multiple unbound fragments without steps are not supported.');svg=[...models.values()][0].data.svg;}
  const report={sourceSha256:request.sourceSha256,counts,idMap,warnings};next.history.at(-1).cdxmlImport=structuredClone(report);validateDocument(next);
  return {next,report,preview:{svg,kind:steps.length?'scheme':'molecule'}};
}
export async function previewCdxmlImport(document,input){const request=requestInfo(input),{report,preview}=await plan(document,input.cdxml,request);return {...report,revision:document.revision,preview};}
export async function commitCdxmlImport(store,input){const request=requestInfo(input);const result=await store.mutate('cdxml-import-v1',request,async current=>(await plan(current,input.cdxml,request)).next);
  const history=result.document.history.find(h=>h.operationId===request.operationId);return {...history.cdxmlImport,revision:history.revision,replayed:Boolean(result.replayed)};}
