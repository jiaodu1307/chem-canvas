import {Resvg} from '@resvg/resvg-js';
import {SaxesParser} from 'saxes';
import {measurePrintFonts} from './svg-print-size.js';

const svgNamespace='http://www.w3.org/2000/svg';
const definitions=new Set(['defs','clipPath','mask','marker','pattern','symbol']);

// Give the renderer a way to associate outlined glyphs with the original label.
// Adding an ID preserves inherited fonts, transforms, text anchoring and tspan runs.
function markText(source){
  const parser=new SaxesParser({xmlns:true}),stack=[],labels=new Map(),pieces=[];
  let prefix='svg-text-proof-',offset=0,afterName=0,excluded=0;
  while(source.includes(prefix))prefix+='_';
  parser.on('doctype',()=>{throw Error('Expected static SVG without a document type declaration.');});
  parser.on('opentagstart',()=>{afterName=parser.position-1;});
  parser.on('opentag',tag=>{
    const a=Object.fromEntries(Object.values(tag.attributes).map(attr=>[attr.name,attr.value]));
    const parent=stack.at(-1),name=tag.local;
    if(!parent && (name!=='svg' || tag.uri!==svgNamespace))throw Error('Expected an SVG root in the SVG namespace.');
    // Nested viewports and explicitly clipped text can intentionally hide ink.
    const clipped=parent?.clipped || definitions.has(name) || (parent && name==='svg') ||
      (a['clip-path'] && a['clip-path']!=='none') || (a.mask && a.mask!=='none') ||
      /(?:^|;)\s*(?:clip-path|mask)\s*:\s*url\(/i.test(a.style || '');
    let label=parent?.label;
    if(name==='text' && tag.uri===svgNamespace){
      if(clipped){excluded++;}
      else{
        const id=a.id || prefix+(labels.size+1);
        if(labels.has(id))throw Error('Duplicate text id: '+id);
        if(!a.id){pieces.push(source.slice(offset,afterName),' id="'+id+'"');offset=afterName;}
        label={index:labels.size+1,sourceId:a.id,text:'',hasLength:a.textLength!==undefined,parts:[]};
        labels.set(id,label);
      }
    }
    if(label && name==='tspan' && a.textLength!==undefined)label.hasLength=true;
    stack.push({label,clipped});
  });
  const addText=s=>{const label=stack.at(-1)?.label;if(label)label.text+=s;};
  parser.on('text',addText);parser.on('cdata',addText);
  parser.on('closetag',()=>stack.pop());
  parser.write(source).close();
  pieces.push(source.slice(offset));
  return {source:pieces.join(''),labels,excluded};
}

// getBBox() returns root user coordinates, including ancestor transforms.
// The actual viewport may show more (meet) or less (slice) than the viewBox.
function viewportBounds(a){
  const [x,y,w,h]=a.viewBox.split(/[\s,]+/).map(Number);
  const [align='xMidYMid',mode='meet']=(a.preserveAspectRatio || 'xMidYMid meet').trim().split(/\s+/);
  if(align==='none')return {left:x,top:y,right:x+w,bottom:y+h};
  const width=Number(a.width),height=Number(a.height);
  const scale=(mode==='slice'?Math.max:Math.min)(width/w,height/h);
  const dx=width/scale-w,dy=height/scale-h;
  const left=x-dx*(align.includes('xMid')?.5:align.includes('xMax')?1:0);
  const top=y-dy*(align.includes('YMid')?.5:align.includes('YMax')?1:0);
  return {left,top,right:left+width/scale,bottom:top+height/scale};
}

function outlinedParts(svg,labels){
  const parser=new SaxesParser(),stack=[];
  let viewport;
  parser.on('opentag',tag=>{
    const a=tag.attributes,parent=stack.at(-1);
    if(!parent)viewport={...viewportBounds(a),aspectHeightOverWidth:Number(a.height)/Number(a.width)};
    const label=labels.get(a.id) || parent?.label;
    const skipped=parent?.skipped || definitions.has(tag.name) || a['clip-path'] || a.mask || a.opacity==='0';
    const transform=[parent?.transform,a.transform].filter(Boolean).join(' ');
    if(!skipped && label && tag.name==='path' && a.d && a.fill!=='none' && a['fill-opacity']!=='0'){
      // Resvg's normalized glyph outline is a path with numeric SVG coordinates.
      const path='<path d="'+a.d+'"'+(transform?' transform="'+transform+'"':'')+'/>';
      const p=new Resvg('<svg xmlns="'+svgNamespace+'" width="1" height="1">'+path+'</svg>',{font:{loadSystemFonts:false}});
      const box=p.getBBox();
      if(box)label.parts.push({path,ordinal:label.parts.length+1,left:box.x,top:box.y,right:box.x+box.width,bottom:box.y+box.height});
    }
    stack.push({label,transform,skipped});
  });
  parser.on('closetag',()=>stack.pop());
  parser.write(svg).close();
  return viewport;
}

const round=value=>Math.round(value*100)/100;
function overlappingInk(a,b){
  const x=Math.max(a.left,b.left),y=Math.max(a.top,b.top);
  const dx=Math.min(a.right,b.right)-x,dy=Math.min(a.bottom,b.bottom)-y;
  const w=Math.min(a.right-a.left,b.right-b.left),h=Math.min(a.bottom-a.top,b.bottom-b.top);
  if(dx<=.25*w || dy<=.65*h || dx<=.15*h)return null;
  // Italics, leading spaces and diagonal text can have overlapping bounds but
  // disjoint ink. Compare actual glyph masks over the small intersecting region.
  const scale=Math.min(2,128/dx,128/dy);
  const width=Math.max(1,Math.ceil(dx*scale)),height=Math.max(1,Math.ceil(dy*scale));
  const root='<svg xmlns="'+svgNamespace+'" width="'+width+'" height="'+height+
    '" viewBox="'+[x,y,dx,dy].join(' ')+'" preserveAspectRatio="none">';
  const masks=[a,b].map(part=>new Resvg(root+part.path+'</svg>',{font:{loadSystemFonts:false}}).render().pixels);
  let shared=0,first=0,second=0;
  for(let i=3;i<masks[0].length;i+=4){
    const inkA=masks[0][i]>=128,inkB=masks[1][i]>=128;
    if(inkA)first++;
    if(inkB)second++;
    if(inkA && inkB)shared++;
  }
  if(shared<4 || shared<.12*Math.min(first,second))return null;
  return {runs:[a.ordinal,b.ordinal].sort((i,j)=>i-j),overlapWidth:round(dx),overlapHeight:round(dy)};
}

export function checkSvgText(source,{printWidthMm}={}){
  const marked=markText(source);
  let viewport;
  if(marked.labels.size){
    const normalized=new Resvg(marked.source,{font:{loadSystemFonts:true}}).toString();
    viewport=outlinedParts(normalized,marked.labels);
  }
  const findings=[];
  let measured=0,comparedPairs=0,overlapChecksTruncated=false;
  for(const label of marked.labels.values()){
    if(!label.parts.length)continue;
    measured++;
    const identify={index:label.index,...(label.sourceId?{id:label.sourceId}:{}),text:label.text.trim().slice(0,200)};
    const overflow={};
    for(const side of ['left','top','right','bottom']){
      const sign=['left','top'].includes(side)?-1:1;
      const distance=label.parts.reduce((max,part)=>Math.max(max,sign*(part[side]-viewport[side])),0);
      if(distance>.01)overflow[side]=round(distance);
    }
    if(Object.keys(overflow).length)findings.push({kind:'text-outside-viewport',...identify,overflow});
    if(!label.hasLength || overlapChecksTruncated)continue;
    // Check fragments of one length-adjusted label only. Crossing reaction lines,
    // bonds, arrows and neighboring separate labels do not enter this measurement.
    const parts=label.parts.slice().sort((a,b)=>a.left-b.left);
    for(let i=0;i<parts.length;i++){
      for(let j=i+1;j<parts.length && parts[j].left<parts[i].right;j++){
        if(++comparedPairs>2000){overlapChecksTruncated=true;break;}
        const overlap=overlappingInk(parts[i],parts[j]);
        if(overlap)findings.push({kind:'length-adjusted-runs-overlap',...identify,...overlap});
      }
      if(overlapChecksTruncated)break;
    }
  }
  return {renderer:'@resvg/resvg-js',units:'root SVG user units',textElements:marked.labels.size+marked.excluded,
    measuredTextElements:measured,excludedOrUnpaintedTextElements:marked.labels.size+marked.excluded-measured,
    overlapChecksTruncated,findings,...(printWidthMm===undefined?{}:{printFonts:measurePrintFonts(source,printWidthMm,viewport)})};
}

