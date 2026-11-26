import assert from 'node:assert/strict';
import test from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { previewPublication } from '../server/publication.js';
import { publicationFile } from '../server/publication-files.js';

test('table row emphasis follows the filtered experiment through column bands and footnotes', async () => {
  const document = { id:'test-table', revision:0, objects:{ scope: { kind:'molecule', version:1 } } };
  const conditions = Object.fromEntries(Array.from({length:12}, (_, i) => ['Condition ' + i, 'same']));
  const spec = {
    title:'Conditions', kind:'optimization', journal:'orglett', columns:1,
    experiments:[
      {id:'skip', compoundId:'scope', include:['scope']},
      {id:'selected', conditions, yield:{value:'56%ᵇ'}, note:'Original footnote', bold:true},
      {id:'control', conditions, yield:{value:56}, bold:false},
    ],
  };
  const styled = await previewPublication(document, spec);
  assert.deepEqual(styled.tableRowBold, [true, false]);
  assert.ok(styled.tableColumnBands.length > 1);
  assert.match(styled.tableHtml, /<td><strong>56%ᵇ<\/strong><\/td>/);
  assert.match(styled.tableHtml, /<td>control<\/td>/);
  const {body} = await publicationFile('docx', styled, spec);
  const xml = strFromU8(unzipSync(body)['word/document.xml']);
  const bands = [...xml.matchAll(/<w:tbl>(.*?)<\/w:tbl>/gs)];
  assert.equal(bands.length, styled.tableColumnBands.length);
  assert.match(xml, /56%ᵇ<\/w:t>/);
  assert.match(xml, /\[a\] Original footnote/);
  for (const [, table] of bands) {
    const rows = [...table.matchAll(/<w:tr>(.*?)<\/w:tr>/gs)].map(match => match[1]);
    assert.equal(rows.length, 3);
    assert.match(rows[0], /<w:tblHeader\/>/);
    assert.match(rows[1], /selected \[a\]/);
    assert.doesNotMatch(rows[1], /<w:tblHeader\/>/);
    assert.match(rows[2], />control<\/w:t>/);
    for (const [i, row] of rows.entries()) {
      const runs = [...row.matchAll(/<w:r>(.*?)<\/w:r>/gs)].map(match => match[1]);
      assert.ok(runs.some(run => run.includes('<w:t ')));
      assert.ok(runs.every(run => run.includes('<w:b/>') === (i < 2)));
    }
  }
  delete spec.experiments[1].bold;
  const plain = await previewPublication(document, spec);
  assert.deepEqual(plain.tableRows, styled.tableRows);
  assert.equal(plain.tableRowBold, undefined);
  assert.doesNotMatch(plain.tableHtml, /<strong>/);
  spec.experiments[1].bold = 'true';
  await assert.rejects(previewPublication(document,spec), error => error.code === 'VALIDATION');
});
