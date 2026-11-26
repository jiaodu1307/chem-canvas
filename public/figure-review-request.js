export function figureReviewRequest(projectId, figureId, notes) {
  const scope = notes.length === 1 ? '只处理下面这一条批注' : '处理下面列出的 '+notes.length+' 条批注';
  const lines = [
    '请在 Chem Canvas 项目 '+JSON.stringify(projectId)+' 中'+scope+'。图稿 ID 为 '+JSON.stringify(figureId)+'。',
  ];
  for (const note of notes) {
    const args = {projectId, mode:'read'};
    if (note.region) {
      args.reviewNoteId = note.id;
      if (!note.onCurrentArtwork) args.compareWithCurrent = true;
    }
    lines.push(
      '批注 '+JSON.stringify(note.id)+' · r'+note.createdAtRevision+' · '+JSON.stringify(note.text),
      JSON.stringify({name:'canvas_figure', arguments:args})
    );
  }
  lines.push('读取后核对图稿和批注 ID，确认仍待核对。位置属于旧版时，在当前图稿中重新确认目标。按指定批注修改并预览。');
  return lines.join('\n');
}
