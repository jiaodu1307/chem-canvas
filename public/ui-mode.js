// Presentation preference only: never rebuild a document, editor or selection.
let mode = 'simple';
try { if (localStorage.getItem('chem-canvas-ui-mode') === 'full') mode = 'full'; } catch {}
export function setMode(next) {
  mode = next === 'full' ? 'full' : 'simple';
  document.body.dataset.uiMode = mode;
  try { localStorage.setItem('chem-canvas-ui-mode', mode); } catch {}
  for (const button of document.querySelectorAll('button[data-ui-mode]')) button.setAttribute('aria-pressed', String(button.dataset.uiMode === mode));
  window.dispatchEvent(new CustomEvent('chem-ui-mode-change', { detail: { mode } }));
}
export function modeSwitch() {
  const group = document.createElement('div'); group.className = 'mode-switch'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', '界面模式');
  for (const [value, label] of [['simple', '简单'], ['full', '全功能']]) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.uiMode = value; button.textContent = label;
    button.setAttribute('aria-pressed', String(mode === value)); button.addEventListener('click', () => setMode(value)); group.append(button);
  }
  return group;
}
setMode(mode);
