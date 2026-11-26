import test from 'node:test';
import assert from 'node:assert/strict';
import {figureReviewRequest} from '../public/figure-review-request.js';

const structure={id:'note-5b',createdAtRevision:2,onCurrentArtwork:true,region:{x:.8,y:.4,width:.1,height:.04},text:'Keep "OTs".\nBreak the divider.'};
const other={...structure,id:'note-5c',createdAtRevision:3,text:'Adjust the next row.'};
const commands=request=>request.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));

test('a single copied rectangle carries one exact note and executable project-scoped read',()=>{
  const request=figureReviewRequest('project-a','figure-a',[structure]);
  assert.ok(request.includes(JSON.stringify(structure.text)));
  assert.ok(request.includes('figure-a') && request.includes('r2'));
  assert.ok(!request.includes(other.id) && !request.includes(other.text));
  assert.deepEqual(commands(request),[{name:'canvas_figure',arguments:{projectId:'project-a',mode:'read',reviewNoteId:structure.id}}]);
});

test('bulk handoff lists each requested note and only old rectangles request a comparison',()=>{
  const request=figureReviewRequest('project-b','figure-b',[structure,{...other,onCurrentArtwork:false}]);
  assert.deepEqual(commands(request).map(call=>call.arguments),[
    {projectId:'project-b',mode:'read',reviewNoteId:structure.id},
    {projectId:'project-b',mode:'read',reviewNoteId:other.id,compareWithCurrent:true},
  ]);
});

test('point and whole-figure notes identify the note in a normal project read',()=>{
  for(const point of [null,{x:.5,y:.3}]){
    const note={id:'cell-2',text:'Bold 98.1',createdAtRevision:4,point};
    const request=figureReviewRequest('table-project','table-figure',[note]);
    assert.ok(request.includes('"cell-2"') && request.includes('"Bold 98.1"'));
    assert.deepEqual(commands(request),[{name:'canvas_figure',arguments:{projectId:'table-project',mode:'read'}}]);
  }
});
