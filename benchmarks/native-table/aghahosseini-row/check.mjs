import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';
import { DocumentStore } from '../../../server/store.js';
import { exportPublication, previewPublication, publicationState, savePublication } from '../../../server/publication.js';

function wordTable(docx) {
  const xml = strFromU8(unzipSync(docx)['word/document.xml']);
  const rows = [];
  let row, cell, run, readingText;
  const parser = new SaxesParser();
  parser.on('opentag', tag => {
    if (tag.name === 'w:tr') row = [];
    if (tag.name === 'w:tc') cell = [];
    if (tag.name === 'w:r' && cell) run = { text: '', bold: false };
    if (tag.name === 'w:b' && run) run.bold = !['0', 'false', 'off'].includes(tag.attributes['w:val']);
    if (tag.name === 'w:t' && run) readingText = true;
  });
  parser.on('text', text => { if (readingText) run.text += text; });
  parser.on('closetag', tag => {
    if (tag.name === 'w:t') readingText = false;
    if (tag.name === 'w:r' && run) {
      if (run.text) cell.push(run);
      run = undefined;
    }
    if (tag.name === 'w:tc') { row.push(cell); cell = undefined; }
    if (tag.name === 'w:tr') { rows.push(row); row = undefined; }
  });
  parser.write(xml).close();
  return rows;
}

const input = JSON.parse(await readFile(new URL('study.json', import.meta.url)));
const expected = structuredClone(input);
expected.experiments.find(row => row.id === '5').bold = true;
const candidate = process.argv[2] ? JSON.parse(await readFile(process.argv[2])) : expected;
assert.deepEqual(candidate, expected, 'Only the bold field on entry 5 may change');
const directory = await mkdtemp(path.join(tmpdir(), 'aghahosseini-row-'));
const store = new DocumentStore(directory);
try {
  await store.start();
  async function saveAndExport(spec, operationId) {
    const preview = await previewPublication(store.document, spec);
    const saved = await savePublication(store, { spec, operationId, expectedRevision: preview.revision });
    const read = publicationState(store.document);
    assert.equal(read.revision, saved.revision);
    assert.deepEqual(read.publication.spec, spec);
    const exportAtRevision = format => exportPublication(store.document, new URLSearchParams({
      format, revision: String(read.revision),
    }));
    const svg = (await exportAtRevision('svg')).body.toString();
    assert.equal(svg, preview.svg);
    const docx = await exportAtRevision('docx');
    return { preview, svg, word: wordTable(docx.body), revision: read.revision };
  }
  const before = await saveAndExport(input, 'initial');
  const after = await saveAndExport(candidate, 'emphasize-entry-5');
  const example = await readFile(new URL('example.docx', import.meta.url));
  assert.deepEqual(wordTable(example), after.word, 'The downloadable example differs from the scored Word table');
  const expectedRows = input.experiments.map(row => [
    row.id, ...input.conditionColumns.map(name => row.conditions[name]),
    typeof row.yield.value === 'number' ? row.yield.value + '%' : row.yield.value,
  ]);
  for (const [isEdited, version] of [[false, before], [true, after]]) {
    assert.deepEqual(version.preview.tableRows, expectedRows);
    assert.equal(version.word.length, 12);
    const text = version.word.map(row => row.map(cell => cell.map(run => run.text).join('')));
    assert.deepEqual(text, [version.preview.tableHeaders, ...expectedRows]);
    for (const [index, row] of version.word.entries()) {
      const bold = index === 0 || (isEdited && index === 5);
      for (const cell of row) assert.ok(cell.length && cell.every(run => run.bold === bold));
    }
    const htmlBody = version.preview.tableHtml.split('<tbody>')[1].split('</tbody>')[0];
    const expectedHtml = expectedRows.map((row, i) => '<tr>' + row.map(value =>
      isEdited && i === 4 ? '<td><strong>' + value + '</strong></td>' : '<td>' + value + '</td>'
    ).join('') + '</tr>').join('');
    assert.equal(htmlBody, expectedHtml);
  }
  // Compare the complete SVG, allowing exactly six additional bold text runs on the target line.
  const target = after.svg.match(/<text [^>]*y="([^"]+)"[^>]*font-weight="bold">5<\/text>/);
  assert.ok(target, 'Missing bold entry 5 in the exported SVG');
  const emphasized = [];
  const normalized = after.svg.replace(/<text [^>]*>[^<]*<\/text>/g, text => {
    if (!text.includes(' y="' + target[1] + '"') || !text.includes(' font-weight="bold"')) return text;
    emphasized.push(text.slice(text.indexOf('>') + 1, text.lastIndexOf('<')));
    return text.replace(' font-weight="bold"', '');
  });
  assert.deepEqual(emphasized, expectedRows[4]);
  assert.equal(normalized, before.svg);
  console.log(JSON.stringify({
    pass: true, revisions: [before.revision, after.revision], dataCellsChecked: expectedRows.flat().length,
    targetBoldCells: 6, otherBoldDataCells: 0, formatsChecked: ['SVG', 'HTML preview', 'editable DOCX'],
  }, null, 2));
} finally {
  await store.close();
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith('aghahosseini-row-'));
  await rm(directory, { recursive: true, force: true });
}
