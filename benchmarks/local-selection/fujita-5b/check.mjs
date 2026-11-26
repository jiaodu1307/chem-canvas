import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';
import { SaxesParser } from 'saxes';
import { scoreHandoff } from './handoff-score.mjs';

const sourceDigest = '4eedd1c4250d8f41a4b490f2b9eaa4e99a3dcf83e8a446228c0bdb036f64406b';
const runId = 'fujita-dioxytosylation-vector-from-data-2026-11-25T01-29-30-891Z-a4f3ce3c';
const root = new URL('../../../', import.meta.url);

async function readBlindDraft() {
  const locations = [
    'docs/fujita-dioxytosylation-svg.svg',
    `public/publication-benchmark-data/diagnostics/${runId}/output.svg`,
  ];
  for (const location of locations) {
    try {
      const source = (await readFile(new URL(location, root), 'utf8')).replaceAll('\r\n', '\n');
      assert.equal(createHash('sha256').update(source).digest('hex'), sourceDigest, 'Unexpected blind draft');
      return source;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('Missing Fujita blind draft. Run from a checkout with the published gallery assets.');
}

function divider(y, x1 = 30, x2 = 930) {
  return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#c8d0d3"/>`;
}

function openGap(source, y) {
  const rule = divider(y);
  assert.equal(source.split(rule).length, 2, 'Expected one matching rule in the blind draft');
  return source.replace(rule, divider(y, 30, 852) + divider(y, 900, 930));
}

function editableLabels(source) {
  const labels = [];
  let current = null;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', tag => {
    if (tag.local === 'text') current = '';
  });
  function append(text) {
    if (current !== null) current += text;
  }
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', tag => {
    if (tag.local === 'text') {
      labels.push(current);
      current = null;
    }
  });
  parser.write(source).close();
  return labels.sort();
}

function render(source) {
  const svg = new Resvg(source, { font: { loadSystemFonts: true } });
  assert.equal(svg.width, 960, 'Expected the original figure width');
  assert.equal(svg.height, 645, 'Expected the original figure height');
  return svg.render().pixels;
}

function check({ labels, input, target }, candidate) {
  const candidateLabels = editableLabels(candidate);
  const result = render(candidate);
  let selectedMismatch = 0;
  let otherChanged = 0;
  let control5cChanged = 0;
  let targetChanged = 0;
  for (let y = 0; y < 645; y++) {
    for (let x = 0; x < 960; x++) {
      const offset = (y * 960 + x) * 4;
      const actual = result.readUInt32LE(offset);
      const before = input.readUInt32LE(offset);
      const expected = target.readUInt32LE(offset);
      if (x >= 850 && x < 902 && y >= 272 && y < 295) {
        if (actual !== expected) selectedMismatch++;
        if (expected !== before) targetChanged++;
      } else if (actual !== before) {
        otherChanged++;
        if (x >= 850 && x < 902 && y >= 420 && y < 443) control5cChanged++;
      }
    }
  }
  assert.ok(targetChanged > 0, 'Expected a visible gap in the target');
  const labelsPreserved = labels.length === candidateLabels.length &&
    labels.every((label, index) => label === candidateLabels[index]);
  return {
    pass: selectedMismatch === 0 && otherChanged === 0 && labelsPreserved,
    selectedMismatchPixels: selectedMismatch,
    outsideSelectionChangedPixels: otherChanged,
    control5cChangedPixels: control5cChanged,
    targetChangedPixels: targetChanged,
    editableLabelsPreserved: labelsPreserved,
    inputEditableLabels: labels.length,
    candidateEditableLabels: candidateLabels.length,
  };
}

const args = process.argv.slice(2);
const withHandoff = args.length === 3 && args[0] === '--handoff';
if (args.length !== 1 && !withHandoff) {
  console.error('Usage: node benchmarks/local-selection/fujita-5b/check.mjs --self-test | exported.svg | --handoff receipt.json exported.svg');
  process.exitCode = 2;
} else {
  const source = await readBlindDraft();
  const gold = openGap(source, 282);
  const reference = { labels: editableLabels(source), input: render(source), target: render(gold) };
  if (args[0] === '--self-test') {
    const pathGap = source.replace(divider(282), '<path d="M30 282H852 M900 282H930" fill="none" stroke="#c8d0d3"/>');
    const controls = {
      unchanged: check(reference, source),
      targetOnly: check(reference, gold),
      equivalentPath: check(reference, pathGap),
      bothRows: check(reference, openGap(gold, 430)),
      deletedLabel: check(reference, gold.replace('>OTs</text>', '></text>')),
    };
    assert.equal(controls.unchanged.pass, false);
    assert.ok(controls.unchanged.selectedMismatchPixels > 0);
    assert.equal(controls.targetOnly.pass, true);
    assert.equal(controls.equivalentPath.pass, true);
    assert.equal(controls.bothRows.pass, false);
    assert.ok(controls.bothRows.control5cChangedPixels > 0);
    assert.equal(controls.deletedLabel.editableLabelsPreserved, false);
    assert.equal(controls.deletedLabel.pass, false);
    const receipt = JSON.parse(await readFile(new URL('./handoff-single.json', import.meta.url), 'utf8'));
    const exported = await readFile(new URL('./example-export.svg', import.meta.url));
    const scope = text => scoreHandoff({ ...receipt, requestText: text }, exported, sourceDigest).checks.targetOnly;
    const toolLine = receipt.requestText.split('\n').find(line => line.startsWith('{"name":'));
    const args = JSON.parse(toolLine).arguments;
    const requestControls = {
      recorded: scope(receipt.requestText),
      wrongTool: scope(receipt.requestText.replace(toolLine, JSON.stringify({ name: 'canvas_read', arguments: args }))),
      idInProseOnly: scope(receipt.requestText.replace(toolLine, '')),
      legacyCall: scope(receipt.before.figureId + '。请调用 canvas_figure ' + JSON.stringify(args)),
      legacyUnnamedArgs: scope(receipt.before.figureId + '。' + JSON.stringify(args)),
    };
    assert.deepEqual(requestControls, {
      recorded: true, wrongTool: false, idInProseOnly: false, legacyCall: true, legacyUnnamedArgs: false,
    });
    console.log(JSON.stringify({ mode: 'scorer-self-test', controls, requestControls }, null, 2));
  } else {
    const candidate = await readFile(args.at(-1), 'utf8');
    const result = check(reference, candidate);
    if (withHandoff) {
      const receipt = JSON.parse(await readFile(args[1], 'utf8'));
      const handoff = scoreHandoff(receipt, candidate, sourceDigest);
      const pass = handoff.pass && result.pass;
      console.log(JSON.stringify({ mode: 'score-handoff', pass, handoff, artwork: result }, null, 2));
      if (!pass) process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ mode: 'score-export', sourceSha256: sourceDigest, ...result }, null, 2));
      if (!result.pass) process.exitCode = 1;
    }
  }
}
