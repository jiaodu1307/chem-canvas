// Publication input and the server use the same lossless conversion for new saves.
export const raisedLetter = '[ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖ𐞥ʳˢᵗᵘᵛʷˣʸᶻ]';
const markedPercent = new RegExp('^(\\d+(?:\\.\\d*)?|\\.\\d+)%('+raisedLetter+')$','u');

export function normalizeMarkedYield(result) {
  const match = typeof result?.value === 'string' && markedPercent.exec(result.value.trim());
  if (!match) return result;
  const [,digits,footnoteMarker] = match;
  if (result.footnoteMarker && result.footnoteMarker !== footnoteMarker) {
    throw Object.assign(Error('Conflicting printed yield footnote markers.'),{code:'VALIDATION'});
  }
  const number = Number(digits);
  // Keep authored precision such as 55.00, which cannot be stored in a JS number.
  return {...result, value:String(number) === digits ? number : digits, footnoteMarker};
}

export function withMarkedYields(spec) {
  return {...spec,experiments:spec.experiments.map(row => ({...row,
    ...(row.yield && {yield:normalizeMarkedYield(row.yield)}),
    ...(row.additionalYields && {additionalYields:row.additionalYields.map(normalizeMarkedYield)})
  }))};
}
