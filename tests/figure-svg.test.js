import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Resvg} from '@resvg/resvg-js';
import {parseSmiles} from '../src/chemistry/index.js';
import {renderFigureSvg} from '../server/figure-svg.js';

const wrap=inner=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">'+inner+'</svg>';
const slot=id=>'<svg data-molecule-id="'+id+'" x="2" y="4" width="90" height="76" data-abbreviations="journal"/>';

test('static SVG keeps authored typography, geometry and local marker/gradient references',async()=>{
  const input=wrap('<defs><marker id="arrowhead" refX="2" refY="1" markerWidth="3" markerHeight="2" orient="auto"><path d="M0 0L3 1L0 2Z"/></marker><linearGradient id="shade"><stop offset="50%" stop-color="#ccc"/></linearGradient></defs><path d="M5 30 Q80 10 100 30" marker-end="url(#arrowhead)" style="stroke:black; fill:none"/><rect x="5" y="45" width="20" height="20" fill="url(#shade)"/><text x="0" y="90">A &amp; B <tspan dy="-.2em">2</tspan></text>');
  const result=await renderFigureSvg({},input);
  assert.equal(result.checkedChemistry,false);assert.deepEqual(result.molecules,[]);
  assert.equal(result.visibleArtworkVerified,false);
  assert.equal(result.clippedSlotCount,0);
  assert.equal(result.width,200);assert.equal(result.height,100);
  const raster=s=>new Resvg(s).render().asPng();
  assert.deepEqual(raster(result.svg),raster(input));
  assert.equal(result.sourceSha256,createHash('sha256').update(input).digest('hex'));
});

test('slots render saved chemistry inside the authored boxes and track repeated structures',async()=>{
  const data=await parseSmiles('O=Cc1ccccc1');
  const doc={objects:{a:{kind:'molecule',data:{...data,svg:'render this molecule from the graph'}}}};
  const source=wrap(slot('a')+'<g transform="translate(100,0)">'+slot('a')+'</g>');
  const result=await renderFigureSvg(doc,source);
  assert.equal(result.checkedChemistry,true);
  assert.equal(result.visibleArtworkVerified,false);
  assert.equal(result.clippedSlotCount,0);
  assert.deepEqual(result.molecules,[{id:'a',smiles:data.smiles,structureSha256:createHash('sha256').update(data.smiles).digest('hex'),occurrences:2}]);
  assert.equal((result.svg.match(/data-rdkit-abbreviations="CHO"/g)||[]).length,2);
  assert.equal((result.svg.match(/preserveAspectRatio="xMidYMid meet"/g)||[]).length,2);
  assert.ok(new Resvg(result.svg).render().asPng().length>500);
  doc.objects.a.data.smiles='C';
  await assert.rejects(renderFigureSvg(doc,source),/disagree/);
});

test('reports slots under active clipping groups without changing the submitted artwork',async()=>{
  const molecule=await parseSmiles('CO');
  const doc={objects:{a:{kind:'molecule',data:molecule},b:{kind:'molecule',data:molecule}}};
  const definition='<defs><clipPath id="crop"><rect x="0" y="0" width="50" height="100"/></clipPath></defs>';
  const inner=definition
    +'<g clip-path="url(#crop)"><g clip-path="none">'+slot('a')+'</g></g>'
    +'<g style="clip-path:url(#crop)">'+slot('b')+'</g>'
    +'<g clip-path="url(#crop)" style="clip-path:none">'+slot('b')+'</g>'
    +slot('a')+'<path d="M3 2L8 10L6 3Z"/>';
  const bound=await renderFigureSvg(doc,wrap(inner));
  assert.equal(bound.clippedSlotCount,2);
  assert.equal(bound.visibleArtworkVerified,false);
  assert.deepEqual(bound.molecules.map(({id,occurrences,clippedOccurrences})=>[id,occurrences,clippedOccurrences]),
    [['a',2,1],['b',2,1]]);
  const rootClipped=await renderFigureSvg(doc,wrap(definition+slot('a')).replace('<svg ','<svg clip-path="url(#crop)" '));
  assert.equal(rootClipped.clippedSlotCount,1);
  assert.match(bound.svg,/<g clip-path="url\(#crop\)"><g clip-path="none"><svg/);
  assert.match(bound.svg,/<path d="M3 2L8 10L6 3Z">/);
});

test('bound coordination reports distinguish indexed trans pairs from unspecified four-coordinate geometry',async()=>{
  const tagged=await parseSmiles('Cl[Pd@SP1](Br)(I)F');
  const plain=await parseSmiles('Cl[Pd](Br)(I)F');
  const doc={objects:{tagged:{kind:'molecule',data:tagged},plain:{kind:'molecule',data:plain}}};
  const result=await renderFigureSvg(doc,wrap(slot('tagged')+slot('plain')));
  const centers=result.molecules.map(entry=>entry.coordinationCenters[0]);
  assert.deepEqual(centers.map(center=>[center.atomicNumber,center.neighbors.length,center.geometry]),
    [[46,4,'square-planar'],[46,4,null]]);
  assert.deepEqual(centers[0].transPairs,tagged.coordinationStereo.transPairs);
  assert.equal(centers[1].transPairs,null);
  assert.equal(result.visibleArtworkVerified,false);
});

test('later opaque white rectangles report positive-area slot intersections in shared coordinates',async()=>{
  const data=await parseSmiles('CO');
  const doc={objects:{a:{kind:'molecule',data}}};
  const rect=(attrs='')=>'<rect width="10" height="10" '+attrs+'/>';
  const before=rect('x="120" y="12" fill="white"');
  const placed='<g transform="translate(90 5) scale(.5)">'+slot('a')+'</g>';
  const skippedSlots='<g transform="rotate(30)">'+slot('a')+'</g><svg width="20" height="20">'+slot('a')+'</svg>';
  const ignored=[
    rect('x="136" y="10" fill="#fff"'), // edge only
    rect('x="120" y="10" fill="#eee"'),
    rect('x="120" y="10" fill="#fff" rx="3"'),
    rect('x="120" y="10" fill="white" style="fill:none"'),
    '<g opacity=".5">'+rect('x="120" y="10" fill="#fff"')+'</g>',
    '<g fill-opacity=".5">'+rect('x="120" y="10" fill="#fff"')+'</g>',
    '<defs>'+rect('x="120" y="10" fill="#fff"')+'</defs>',
    '<g transform="skewX(2)">'+rect('x="120" y="10" fill="#fff"')+'</g>',
  ].join('');
  const hit='<g fill="white" fill-opacity=".4">'+rect('x="15" y="10" style="fill-opacity:1" transform="matrix(-1 0 0 1 150 0)"')+'</g>';
  const result=await renderFigureSvg(doc,wrap(before+skippedSlots+placed+ignored+hit+placed));
  const {slotCount,assessedSlots,affectedSlots,rectangleCount,pairCount,examples}=result.slotOverlays;
  assert.deepEqual([slotCount,assessedSlots,affectedSlots,rectangleCount,pairCount],[4,2,1,1,1]);
  assert.equal(examples[0].slot,3);
  assert.deepEqual(examples[0].intersection,{x:125,y:10,width:10,height:10});
  assert.equal(result.visibleArtworkVerified,false);
  assert.equal(result.molecules[0].occurrences,4);
});

test('invalid shapes, attributes, external content and malformed molecule slots fail before export',async()=>{
  const cases=[
    '<image href="sample.png"/>','<script/>','<foreignObject/>','<a href="sample.svg"/>',
    '<path d="M0 0" onload="example"/>','<svg><circle style="fill:url(elsewhere)"/></svg>',
    '<path marker-end="url(#missing)"/>','<defs><marker id="m"><path marker-end="url(#m)"/></marker></defs>',
    '<g id="m"/><g id="m"/>','<circle data-molecule-id="x"/>',slot('unknown'),slot('__proto__'),
    '<svg data-molecule-id="a" x="0" y="0" width="0" height="20"/>',
    '<svg data-molecule-id="a" x="0" y="0" width="30" height="20"><path/></svg>',
  ];
  for(const body of cases) await assert.rejects(renderFigureSvg({objects:{}},wrap(body)),{code:'VALIDATION'});
  await assert.rejects(renderFigureSvg({},'<svg width="20000" height="20000"/>'),/megapixels/);
  await assert.rejects(renderFigureSvg({},'<!DOCTYPE svg><svg viewBox="0 0 2 2"/>'),/document types/);
});
