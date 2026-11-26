import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Resvg} from '@resvg/resvg-js';
import {SaxesParser} from 'saxes';

const root = new URL('../../../', import.meta.url);
const runId = 'hosoya-batch-oxidation-vector-from-data-2026-11-25T01-29-29-227Z-f6676549';
const draftHash = '1fd1ddcbe6956796184bf31613145b79454f0aed7ab7b74f21d31cf5d5047fbe';
const columns = [306, 445, 579, 713, 873];
const series = [
  {id: 'series-5', number: '5', temperature: '60', headerY: 426, rows: [361, 387, 413, 439, 465, 491]},
  {id: 'series-6', number: '6', temperature: '80', headerY: 533, rows: [520, 546]},
];

async function blindDraft() {
  const published = new URL('docs/hosoya-batch-oxidation-svg.svg', root);
  const local = new URL(`public/publication-benchmark-data/diagnostics/${runId}/output.svg`, root);
  const draft = await readFile(published, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return readFile(local, 'utf8');
  });
  const source = draft.replaceAll('\r\n', '\n');
  assert.equal(createHash('sha256').update(source).digest('hex'), draftHash, 'Unexpected blind draft');
  return source;
}

// The source table is editable SVG text in two named series, laid out with translations.
// Key cells by their series and displayed position so text painting order can vary.
function tableCells(source) {
  const cells = new Map();
  const stack = [];
  let cell;
  const parser = new SaxesParser();
  parser.on('opentag', ({name, attributes}) => {
    const parent = stack.at(-1);
    const group = series.some(s => s.id === attributes.id) ? attributes.id : parent?.group;
    let dx = parent?.dx ?? 0, dy = parent?.dy ?? 0;
    if (group && attributes.transform) {
      const translate = /^translate\(\s*([-+\d.eE]+)(?:[\s,]+([-+\d.eE]+))?\s*\)$/.exec(attributes.transform);
      dx += translate ? Number(translate[1]) : NaN;
      dy += translate ? Number(translate[2] ?? 0) : NaN;
    }
    stack.push({group, dx, dy});
    if (group && name === 'text') {
      const x = Number(attributes.x ?? 0) + dx, y = Number(attributes.y ?? 0) + dy;
      cell = {key: [group, x, y].join('/'), value: '', openTagEnd: parser.position};
    }
  });
  const append = text => { if (cell) cell.value += text; };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', tag => {
    if (cell && tag.name === 'text') {
      const entries = cells.get(cell.key) ?? [];
      entries.push({value: cell.value.trim(), openTagEnd: cell.openTagEnd});
      cells.set(cell.key, entries);
      cell = undefined;
    }
    stack.pop();
  });
  parser.write(source).close();
  return cells;
}

function render(source) {
  const image = new Resvg(source, {font: {loadSystemFonts: true}});
  assert.equal(image.width, 1000);
  assert.equal(image.height, 730);
  return image.render().pixels;
}

if (process.argv.length !== 3) throw new Error('Usage: node benchmarks/local-selection/hosoya-conversion/score.mjs exported.svg');
const draft = await blindDraft();
const candidate = await readFile(process.argv[2], 'utf8');
const originalCells = tableCells(draft), candidateCells = tableCells(candidate);
const selectedRow = 'series-6';
const cellAt = (x, y) => originalCells.get([selectedRow, x, y].join('/'))[0];
assert.equal(cellAt(183, 533).value, '80');
assert.equal(cellAt(306, 546).value, '20');
const conversion = cellAt(873, 546);
assert.equal(conversion.value, '100');
const insertAt = conversion.openTagEnd - 1;
assert.equal(draft[insertAt], '>');
const gold = draft.slice(0, insertAt) + ' font-weight="bold"' + draft.slice(insertAt);
let rowsPreserved = 0, temperatureGroupsPreserved = 0;
for (const {id, number, temperature, headerY, rows} of series) {
  const matches = (x, y, value) => {
    const entries = candidateCells.get([id, x, y].join('/'));
    return entries?.length === 1 && entries[0].value === value;
  };
  if (matches(80, headerY, number) && matches(183, headerY, temperature)) temperatureGroupsPreserved++;
  for (const y of rows) {
    if (columns.every(x => matches(x, y, originalCells.get([id, x, y].join('/'))[0].value))) rowsPreserved++;
  }
}
const before = render(draft), expected = render(gold), after = render(candidate);
let selectedChangedPixels = 0, selectedMismatchPixels = 0, outsideChangedPixels = 0, controlChangedPixels = 0;
for (let y = 0; y < 730; y++) {
  for (let x = 0; x < 1000; x++) {
    const offset = (1000 * y + x) * 4;
    const value = after.readUInt32LE(offset);
    const changed = before.readUInt32LE(offset) !== value;
    if (x >= 846 && x < 900 && y >= 527 && y < 550) {
      if (changed) selectedChangedPixels++;
      if (value !== expected.readUInt32LE(offset)) selectedMismatchPixels++;
    } else if (changed) {
      outsideChangedPixels++;
      if (x >= 846 && x < 900 && y >= 472 && y < 495) controlChangedPixels++;
    }
  }
}
const pass = rowsPreserved === 8 && temperatureGroupsPreserved === 2 &&
  selectedChangedPixels > 0 && selectedMismatchPixels === 0 && outsideChangedPixels === 0;
console.log(JSON.stringify({pass, rowsPreserved, columnsPerRow: columns.length, temperatureGroupsPreserved,
  selectedChangedPixels, selectedMismatchPixels, outsideChangedPixels, controlChangedPixels}, null, 2));
if (!pass) process.exitCode = 1;
