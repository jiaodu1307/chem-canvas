import { Resvg } from '@resvg/resvg-js';
import { createHash } from 'node:crypto';

// Only pass engine-generated SVG, never untrusted uploaded markup.
export function depictionImage(svg, binding) {
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: 1000 }, background: 'white', font: { loadSystemFonts: false } }).render();
  const png = rendered.asPng();
  return { metadata: { ...binding, mimeType: 'image/png', width: rendered.width, height: rendered.height,
    sha256: createHash('sha256').update(png).digest('hex'), renderer: 'resvg', depictionOnly: true },
  content: { type: 'image', mimeType: 'image/png', data: png.toString('base64') } };
}
