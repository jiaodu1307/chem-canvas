import { drawJournalAbbreviations } from './abbreviations.js';
import { drawTosyloxy } from './tosyloxy.js';

// ACS values with a documented screen-legibility refinement for glyphs/gaps.
export const DRAWING_SOURCE = 'https://github.com/rdkit/rdkit/blob/master/Code/GraphMol/MolDraw2D/MolDraw2DUtils.cpp';
export const DRAWING_REVISION = 2;
export const DRAWING_LIMITATIONS = [
  'ACS1996-derived RDKit rendering, not exact ChemDraw compatibility or a journal compliance certification.',
  'BuiltinTelexRegular replaces the ACS Roboto fallback for rounder screen glyphs; label padding is 0.035 instead of 0.066. This is an ACS-derived readability refinement, not exact ACS typography.',
  '14.4 is the target bond length in intrinsic SVG units; flexi-canvas rounding, label clipping and browser scaling affect measured length.',
  'Wedges and hashes use RDKit stereochemical drawing; no independent ChemDraw wedge width or hash-spacing emulation.',
];

export function drawingCapabilities() {
  return { defaultStyle: 'acs1996', styles: ['acs1996', 'rdkit'], revision: DRAWING_REVISION,
    profile: 'ACS1996-derived', source: DRAWING_SOURCE, limitations: [...DRAWING_LIMITATIONS] };
}

export function drawMolecule(mol, version, style = 'acs1996', publicationLabels, rotationDegrees = 0, abbreviations, keepCoordinationWedges = false, kit) {
  if (abbreviations==='journal') return drawTosyloxy(kit,mol,publicationLabels,rotationDegrees,(structure,names) =>
    drawJournalAbbreviations(structure,names,
      (display,labels)=>drawMolecule(display,version,style,labels,rotationDegrees,undefined,keepCoordinationWedges)));
  if (!['acs1996', 'rdkit'].includes(style)) {
    throw Object.assign(new Error('Unknown drawing style; use acs1996 or rdkit.'), { code: 'VALIDATION' });
  }
  let options = { width: 360, height: 240 };
  let parameters = {};
  if (style === 'acs1996') {
    const molecule = JSON.parse(mol.get_json()).molecules[0];
    const coords = molecule.conformers?.[0]?.coords;
    const lengths = (molecule.bonds ?? []).map(({ atoms: [a, b] }) => {
      if (!coords?.[a] || !coords?.[b]) return 0;
      return Math.hypot(...coords[a].map((value, i) => value - coords[b][i]));
    }).filter((length) => Number.isFinite(length) && length > 0);
    // Isolated atoms have no mean bond length; this scale only sets their canvas.
    const meanBondLength = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 1.5;
    parameters = {
      bondLineWidth: 0.6, scaleBondWidth: false,
      scalingFactor: 14.4 / meanBondLength, fixedBondLength: 14.4 / meanBondLength,
      multipleBondOffset: 0.18, highlightBondWidthMultiplier: 32,
      fixedFontSize: 10, additionalAtomLabelPadding: 0.035, fontFile: 'BuiltinTelexRegular',
    };
    // JSON palette updates merge into defaults. Override every element, dummy,
    // fallback and RDKit's special hydrogen entry, rather than only key -1.
    const atomColourPalette = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [i - 1, [0, 0, 0]]));
    atomColourPalette[201] = [0, 0, 0];
    options = { ...parameters, width: -1, height: -1, atomColourPalette,
      backgroundColour: [1, 1, 1], symbolColour: [0, 0, 0], annotationColour: [0, 0, 0],
      legendColour: [0, 0, 0], queryColour: [0, 0, 0],
      wedgeBonds: true, addChiralHs: true, forceCoords: false };
  }
  if (publicationLabels) {
    options.atomLabels = publicationLabels;
    options.variableAtomRadius = 0;
    options.variableBondWidthMultiplier = 0;
  }
  if (rotationDegrees) {
    // MolDraw2D rotates the geometry clockwise, then lays out upright glyphs.
    options.rotate = -rotationDegrees;
  }
  if(keepCoordinationWedges) options.useMolBlockWedging=true;
  const svg = mol.get_svg_with_highlights(JSON.stringify(options));
  if (!svg.includes('<svg')) throw Object.assign(new Error('RDKit could not generate SVG.'), { code: 'CHEMISTRY_ERROR' });
  return { svg, drawing: { style, revision: DRAWING_REVISION, profile: style === 'acs1996' ? 'ACS1996-derived' : 'RDKit default',
    tool: 'RDKit', version, source: style === 'acs1996' ? DRAWING_SOURCE : 'RDKit get_svg_with_highlights',
    canvas: style === 'acs1996' ? 'flexible' : '360x240', parameters,
    ...(style === 'acs1996' ? { targetBondLength: 14.4, palette: 'black-on-white', limitations: [...DRAWING_LIMITATIONS] } : {}) } };
}
