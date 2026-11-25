import path from 'node:path';
import { readdir, readFile, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { failure, stableJson } from './store.js';
import { reactionScheme } from './reaction-scheme.js';

const idOK = s => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,130}$/.test(s);
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.mol': 'chemical/x-mdl-molfile', '.smi': 'text/plain; charset=utf-8' };
const allowedAsset = /^(?:input\/input\/page-\d{3}\.png|output\/(?:final-document\.json|layout-check\.json|(?:route-native|viewport|layout-before|layout-after)\.png|structures\/molecule-\d+\.(?:png|svg|json|mol|smi))|evaluations\/(?:score|visual)-[\w-]+\/(?:score\.json|report\.md|evaluation-manifest\.json|visual-manifest\.json|scale-calibration\.json|output\/(?:route-native|viewport)\.png|same-scale\/compound-\d+\.png))$/;

// Only explicit benchmark paths; reject links/junctions at every component, including the root.
async function safePath(root, relative) {
  const pieces = relative.split('/');
  if (pieces.some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p))) throw failure('FORBIDDEN', '评测路径不允许。');
  let file = path.resolve(root);
  for (const piece of [null, ...pieces]) {
    if (piece !== null) file = path.join(file, piece);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw failure('FORBIDDEN', '评测资源不允许链接或目录联接。');
  }
  return file;
}
async function readJSON(root, relative, fallback = undefined) {
  try {
    const file = await safePath(root, relative);
    if ((await lstat(file)).size > 12 * 1024 * 1024) throw failure('TOO_LARGE', '评测元数据过大。');
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
const assetURL = (id, file) => `/api/benchmarks/assets/${encodeURIComponent(id)}/${file.split('/').map(encodeURIComponent).join('/')}`;

export class BenchmarkDashboard {
  constructor({ directory, feedbackDirectory, replayDirectory, batchProjectRoot }) {
    this.directory = path.resolve(directory); this.feedbackDirectory = path.resolve(feedbackDirectory);
    this.replayDirectory = path.resolve(replayDirectory); this.queue = Promise.resolve();
    this.caseDirectory = path.resolve(directory, '../cases');
    const project = path.resolve(directory, '../../..');
    this.batchProjectRoot = batchProjectRoot ?? (this.directory === path.join(project, 'benchmarks', 'anthropic-route', 'runs') ? project : null);
  }
  async currentBatch() {
    if (!this.batchProjectRoot) return null;
    const read = file => readJSON(this.batchProjectRoot, file, null);
    const pointer = await read('integrations/deepseek/evidence/seven-case-current.json');
    if (!idOK(pointer?.batchId)) return null;
    const folder = `.local/${pointer.batchId}`;
    const manifest = await read(`${folder}/batch.json`);
    if (manifest?.batchId !== pointer.batchId || !manifest.pluginDigest || !Array.isArray(manifest.caseIds)) return null;
    const [progress, review] = await Promise.all(['model-progress.json', 'review-progress.json'].map(file => read(`${folder}/${file}`)));
    const states = {};
    for (const source of [manifest, progress]) {
      if (!source || (source.batchId && source.batchId !== manifest.batchId) || (source.pluginDigest && source.pluginDigest !== manifest.pluginDigest)) continue;
      const rows = Array.isArray(source) ? source : [source.cases, source.entries, source.runs].filter(Array.isArray).flat();
      for (const row of rows) {
        if (!manifest.caseIds.includes(row.caseId)) continue;
        states[row.caseId] = { status: String(row.status ?? (row.sealed ? 'sealed' : row.runId ? 'started' : 'pending')), runId: idOK(row.runId) ? row.runId : null };
      }
    }
    const reviews = {};
    if (review?.batchId === manifest.batchId && review.pluginDigest === manifest.pluginDigest && Array.isArray(review.runs)) {
      for (const row of review.runs) {
        if (!manifest.caseIds.includes(row.caseId) || !idOK(row.runId)) continue;
        reviews[row.runId] = { caseId: row.caseId, assessment: row.error ? 'review-blocked' : String(row.completionAssessment ?? 'pending-manual-review') };
      }
    }
    return { batchId: manifest.batchId, pluginDigest: manifest.pluginDigest, caseIds: manifest.caseIds, states, reviews };
  }
  async cases() {
    let entries;try {entries=await readdir(this.caseDirectory,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return {cases:[]};throw e;}
    const cases=[];
    for(const e of entries.filter(e=>e.isDirectory()&&idOK(e.name))) {
      const m=await readJSON(this.caseDirectory,`${e.name}/input-manifest.json`,null);if(!m||m.caseId!==e.name)continue;
      cases.push({id:m.caseId,title:m.title,track:m.track,difficulty:m.difficulty??'文献',focus:m.focus??['文献复现','完整路线'],scope:m.scope??m.figure,sources:m.sources.map(s=>({title:s.title,url:s.articleURL??s.url})),
        sourcePreview:m.physicalPages?.length?`/api/benchmarks/cases/${m.caseId}/assets/input/page-${String(m.physicalPages[0]).padStart(3,'0')}.png`:null,
        promptURL:`/api/benchmarks/cases/${m.caseId}/assets/prompt.txt`,command:`node scripts/benchmark-route.mjs run --case ${m.caseId}`,chemicalReview:'pending'});
    }
    return {cases};
  }
  async caseAsset(id,file) {
    if(!idOK(id)||!(/^(?:prompt\.txt|input\/(?:task\.txt|page-\d{3}\.png|figure-\d+-original\.jpg))$/).test(file))throw failure('FORBIDDEN','该用例资源不可读取。');
    const m=await readJSON(this.caseDirectory,`${id}/input-manifest.json`);
    if(m.caseId!==id||!Object.hasOwn(m.files,file))throw failure('NOT_FOUND','用例输入不存在。');
    const p=await safePath(this.caseDirectory,`${id}/${file}`);if((await lstat(p)).size>64*1024*1024)throw failure('TOO_LARGE','输入资源过大。');
    return {mime:mime[path.extname(file)],content:await readFile(p)};
  }
  async scheme(id) {
    await this.run(id);const payload=await readJSON(this.directory,`${id}/output/final-document.json`);
    const result=await reactionScheme(payload.document??payload);
    return {...result,kind:'render-only-not-agent-run',sourceRunId:id,sourceDocumentSha256:createHash('sha256').update(stableJson(payload)).digest('hex')};
  }
  async sourceText(id) {
    await this.run(id);const file=await safePath(this.directory,`${id}/input/input/task.txt`);
    if((await lstat(file)).size>100000)throw failure('TOO_LARGE','输入文本过大。');return {text:await readFile(file,'utf8')};
  }
  async ids() {
    try { const root = await lstat(this.directory); if (root.isSymbolicLink()) throw failure('FORBIDDEN', '评测根目录不能是链接。');
      return (await readdir(this.directory, { withFileTypes: true })).filter(e => e.isDirectory() && idOK(e.name) && e.name.startsWith('run-')).map(e => e.name).sort().reverse();
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  async run(id) {
    if (!idOK(id) || !id.startsWith('run-')) throw failure('NOT_FOUND', '评测运行不存在。');
    const run = await readJSON(this.directory, `${id}/run.json`, null) ?? await readJSON(this.directory, `${id}/launch.json`, null);
    if (!run || run.runId !== id || run.track?.startsWith('FIXTURE')) throw failure('NOT_FOUND', '评测运行不存在。');
    return run;
  }
  async evaluations(id) {
    let entries;
    try { entries = await readdir(await safePath(this.directory, `${id}/evaluations`), { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const result = [];
    for (const entry of entries.filter(e => e.isDirectory() && /^score-[\w-]+$/.test(e.name)).sort((a, b) => b.name.localeCompare(a.name))) {
      try {
        const score = await readJSON(this.directory, `${id}/evaluations/${entry.name}/score.json`);
        if (score.schema === 'route-score/1') result.push({ id: entry.name, score });
      } catch { /* In-progress or malformed evaluations cannot replace a completed score. */ }
    }
    return result;
  }
  async summarize(run, evaluation, feedback = [], layoutReview = null) {
    const s = evaluation?.score;
    const finalFile = `${run.runId}/output/final-document.json`;
    let hasResult = false;
    if (run.finishedAt && await this.availableAsset(run.runId,'output/final-document.json')) {
      // Large polymer/route documents can exceed the metadata read limit. The
      // scorer already counted editable molecules in this saved document.
      hasResult = s?.editability?.editableCount > 0;
      if (!hasResult) {
        const document = await readJSON(this.directory, finalFile, null).catch(() => null);
        hasResult = Object.values((document?.document ?? document)?.objects ?? {}).some(o => o?.kind === 'molecule');
      }
    }
    const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
    const humanInterventions = count(run.humanInterventions);
    const conversationCount = count(run.conversationCount) ?? (run.continuation?.kind === 'fresh-conversation-assisted-continuation' ? 2 : null);
    const assisted = humanInterventions > 0 || run.executionClassification === 'assisted' || run.outcome === 'assisted-continuation-completed-unscored';
    const executionClassification = assisted ? 'assisted' : run.executionClassification === 'independent' && humanInterventions === 0 && conversationCount === 1 ? 'independent' : 'unknown';
    const adapter = run.agent?.adapter ?? '';
    const modelFamily = adapter === 'official-codex-cli' ? 'Codex' : /^DeepSeek Harness desktop\b/i.test(adapter) ? 'DeepSeek' : null;
    const status = /failed|incomplete|partial|aborted|timeout|interrupted|blocked/i.test(run.outcome ?? '') ? 'failed' : run.finishedAt ? 'completed' : 'running';
    return { id: run.runId, caseId: run.caseId, track: run.track, startedAt: run.startedAt, finishedAt: run.finishedAt ?? null,
      modelFamily, hasResult, humanInterventions, conversationCount, executionClassification, batchId: run.batchId ?? null,
      status, failure: run.failure ?? null,
      promptBaseDigest: run.promptVariant?.basePromptSha256 ?? null, promptGateDigest: run.promptVariant?.gateSha256 ?? null,
      continuationDigest: run.promptVariant?.continuationSha256 ?? null,
      pluginDigest: run.pluginDigest, inputDigest: run.inputDigest, agent: { label: run.agent?.label, actualModel: run.agent?.actualModel ?? null, adapter: run.agent?.adapter },
      promptSupplementDigest: typeof run.promptVariant?.supplementSha256 === 'string' ? run.promptVariant.supplementSha256 : null,
      layoutStatus: layoutReview?.status ?? null,
      evaluationId: evaluation?.id ?? null, scorerVersion: s?.scorerVersion ?? null, evaluatorDigest: s?.evaluator?.digest ?? null,
      referenceRevision: s?.referenceRevision ?? null, referenceDigest: s?.referenceDigest ?? null,
      metrics: s ? { nodes: [s.route.nodesPresent, s.route.nodesExpected], steps: [s.route.stepsPresent, s.route.stepsExpected], edges: [s.route.edgesPresent, s.route.edgesExpected],
        conditions: [s.labels.conditionsFound, s.labels.conditionsExpected], certified: [s.chemistry.certifiedReferenceNodes, s.chemistry.totalReferenceNodes],
        graphAccuracy: s.chemistry.graphAccuracy, stereoAccuracy: s.chemistry.stereoAccuracy, editable: s.editability.editableCount,
        calls: s.efficiency.toolCalls, errors: s.efficiency.errors, seconds: s.efficiency.elapsedAgentSeconds,
        eligible: s.integrity.eligiblePrimaryAttempt, eligibleIndependent: status === 'completed' && executionClassification === 'independent' && hasResult && !!s.integrity.eligiblePrimaryAttempt } : null,
      feedback: { total: feedback.length, open: feedback.filter(f => f.status !== 'resolved').length } };
  }
  async list() {
    const ids = await this.ids(), runs = [], warnings = [];
    for (const id of ids) {
      try { const run = await this.run(id), evaluations = await this.evaluations(id); runs.push(await this.summarize(run, evaluations[0], (await this.feedback(id)).items, await this.layoutReview(id))); }
      catch { warnings.push({ runId: id, message: '运行资料暂不可读，可能仍在写入。' }); }
    }
    let batch = null;
    try { batch = await this.currentBatch(); } catch { warnings.push({ message: '冻结批次进度暂不可读。' }); }
    return { runs, batch, warnings, updatedAt: new Date().toISOString(), feedbackStorage: 'local-server', totalRunDirectories: ids.length };
  }
  async availableAsset(id, file) {
    if (!allowedAsset.test(file) && !/^output\/scheme\.(png|svg|json)$/.test(file)) return null;
    try { await safePath(this.directory, `${id}/${file}`); return assetURL(id, file); } catch { return null; }
  }
  async layoutReview(id) {
    const report = await readJSON(this.directory, `${id}/output/layout-check.json`, null).catch(() => null);
    if (report?.schema !== 'scheme-edit-assessment/1') return null;
    const checkNames = ['chemistryUnchanged', 'positionsChanged', 'savedLayout', 'reopenedLayoutSame'];
    const countNames = ['previewCalls', 'commitCalls', 'inspectCalls'];
    return {
      schema: report.schema,
      status: typeof report.status === 'string' ? report.status.slice(0, 120) : null,
      checks: Object.fromEntries(checkNames.map(key => [key, typeof report.checks?.[key] === 'boolean' ? report.checks[key] : null])),
      ...Object.fromEntries(countNames.map(key => [key, Number.isSafeInteger(report[key]) && report[key] >= 0 ? report[key] : null]))
    };
  }
  async detail(id, evaluationId) {
    const run = await this.run(id), evaluations = await this.evaluations(id);
    const evaluation = evaluationId ? evaluations.find(e => e.id === evaluationId) : evaluations[0];
    if (evaluationId && !evaluation) throw failure('NOT_FOUND', '评分版本不存在。');
    const score = evaluation?.score ?? null, input = await readJSON(this.directory, `${id}/input/input-manifest.json`, null);
    let visualId = score?.artifacts?.sameScale?.match(/^evaluations\/(visual-[\w-]+)\//)?.[1];
    if (!visualId) {
      try { visualId = (await readdir(await safePath(this.directory, `${id}/evaluations`))).filter(n => /^visual-[\w-]+$/.test(n)).sort().at(-1); } catch { /* no capture */ }
    }
    const visualPrefix = visualId ? `evaluations/${visualId}/` : '';
    const scale = visualId ? await readJSON(this.directory, `${id}/${visualPrefix}scale-calibration.json`, null) : null;
    const sourcePages = [];
    for (const page of input?.physicalPages ?? []) {
      if (!Number.isInteger(page) || page < 1 || page > 999) continue;
      const url = await this.availableAsset(id, `input/input/page-${String(page).padStart(3, '0')}.png`); if (url) sourcePages.push({ page, url });
    }
    const compounds = [];
    for (const item of scale?.results ?? []) {
      if (!Number.isInteger(item.number) || item.number < 1 || item.number > 999) continue;
      const file = `${visualPrefix}same-scale/compound-${String(item.number).padStart(2, '0')}.png`;
      compounds.push({ number: item.number, sourcePage: item.sourcePage, status: item.status, url: await this.availableAsset(id, file) });
    }
    const feedback = await this.feedback(id), layoutReview = await this.layoutReview(id);
    return { run: await this.summarize(run, evaluation, feedback.items, layoutReview), score, evaluations: evaluations.map(e => ({ id: e.id, scorerVersion: e.score.scorerVersion, referenceRevision: e.score.referenceRevision })),
      case: input ? { title: input.title, figure: input.figure, physicalPages: input.physicalPages } : { title: run.caseId },
      assets: { sourcePages, compounds, visualId: visualId ?? null, calibrationStatus: scale?.status ?? null,
        nativeScheme: await this.availableAsset(id, 'output/scheme.png'),
        nativeSchemeSVG: await this.availableAsset(id, 'output/scheme.svg'),
        layoutBefore: await this.availableAsset(id, 'output/layout-before.png'),
        layoutAfter: await this.availableAsset(id, 'output/layout-after.png'),
        layoutReport: layoutReview ? await this.availableAsset(id, 'output/layout-check.json') : null,
        sourceText: input?.files?.['input/task.txt'] ? `/api/benchmarks/runs/${id}/source-text` : null,
        pageKind: input?.pageKind ?? 'physical-page',
        route: await this.availableAsset(id, `${visualPrefix}output/route-native.png`),
        document: await this.availableAsset(id, 'output/final-document.json'),
        score: evaluation ? await this.availableAsset(id, `evaluations/${evaluation.id}/score.json`) : null },
      replay: await this.replay(id), layoutReview, feedback: feedback.items,
      execution: { failureCategories: run.failureCategories ?? [], humanInterventions: run.humanInterventions ?? null, elapsedTotalSeconds: run.elapsedTotalSeconds ?? null,
        finalMessage: run.finalMessage ?? null, host: run.host, snapshotUnchanged: run.snapshotUnchanged, inputUnchanged: run.inputUnchanged } };
  }
  async replay(id) {
    try {
      const r = await readJSON(this.replayDirectory, 'verification.json');
      if (path.resolve(r.source) !== path.join(this.directory, id, 'output/final-document.json') || r.unchanged !== true) return null;
      await safePath(this.replayDirectory, 'overview.png');
      return { label: '连线修复回放', kind: 'render-only-not-agent-run', changedRelations: r.changedRelationAnchors?.length ?? 0,
        url: `/api/benchmarks/replays/${id}/overview.png`, detailURL: `/api/benchmarks/replays/${id}/verification.json`,
        note: '同一份已保存输出的新渲染，不是新一轮 agent 评测；不改变上方成绩。' };
    } catch { return null; }
  }
  async asset(id, file, replay = false) {
    await this.run(id);
    if (replay ? !['overview.png', 'first-rows.png', 'verification.json'].includes(file) || !(await this.replay(id)) : !allowedAsset.test(file) && !/^output\/scheme\.(png|svg|json)$/.test(file)) throw failure('FORBIDDEN', '该评测资源不可公开读取。');
    let full;
    try { full = await safePath(replay ? this.replayDirectory : this.directory, replay ? file : `${id}/${file}`); }
    catch (e) { if (e.code === 'ENOENT') throw failure('NOT_FOUND', '评测资源不存在。'); throw e; }
    const stat = await lstat(full);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw failure('TOO_LARGE', '资源类型或大小不支持。');
    return { content: await readFile(full), mime: mime[path.extname(full)], filename: path.basename(full) };
  }
  async feedback(id) {
    if (!idOK(id)) throw failure('VALIDATION', '无效的运行编号。');
    try { const result = await readJSON(this.feedbackDirectory, `${id}.json`); if (result.schema !== 'benchmark-feedback/1' || !Array.isArray(result.items)) throw Error('Invalid feedback'); return result; }
    catch (e) { if (e.code === 'ENOENT') return { schema: 'benchmark-feedback/1', items: [], receipts: {} }; throw e; }
  }
  async withFeedbackLock(action) {
    await mkdir(this.feedbackDirectory, { recursive: true });
    if ((await lstat(this.feedbackDirectory)).isSymbolicLink()) throw failure('FORBIDDEN', '反馈目录不能是链接。');
    const file = path.join(this.feedbackDirectory, 'writer.lock'); let lock;
    try { lock = await open(file, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const contents = await readFile(await safePath(this.feedbackDirectory, 'writer.lock'), 'utf8'), pid = Number(contents);
      if (!Number.isSafeInteger(pid) || pid < 1) throw failure('CONFLICT', '反馈写入锁不可识别，请稍后重试。');
      try { process.kill(pid, 0); throw failure('CONFLICT', '另一个请求正在保存反馈，请稍后重试。'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      if (await readFile(file, 'utf8') !== contents) throw failure('CONFLICT', '反馈写入状态已变化，请重试。');
      await unlink(file); lock = await open(file, 'wx');
    }
    try { await lock.writeFile(String(process.pid)); return await action(); }
    finally { await lock.close(); await unlink(file); }
  }
  saveFeedback(id, input) {
    const job = this.queue.then(() => this.withFeedbackLock(async () => {
      const run = await this.run(id);
      if (!idOK(input.operationId)) throw failure('VALIDATION', '反馈需要有效的操作编号。');
      const state = await this.feedback(id), signature = createHash('sha256').update(stableJson(input)).digest('hex');
      if (Object.hasOwn(state.receipts, input.operationId)) {
        if (state.receipts[input.operationId].signature !== signature) throw failure('CONFLICT', '操作编号已用于不同反馈。');
        return { items: state.items, replayed: true };
      }
      let item;
      if (input.id !== undefined) {
        item = state.items.find(f => f.id === input.id);
        if (!item) throw failure('NOT_FOUND', '反馈不存在。');
        if (input.expectedVersion !== item.version) throw failure('CONFLICT', '反馈已更新，请刷新后重试。');
        if (!['open', 'planned', 'resolved'].includes(input.status)) throw failure('VALIDATION', '反馈状态无效。');
        item.status = input.status; item.version++; item.updatedAt = new Date().toISOString();
        item.history.push({ status: item.status, at: item.updatedAt });
      } else {
        if (typeof input.text !== 'string' || input.text.trim().length < 2 || input.text.length > 4000) throw failure('VALIDATION', '建议需要 2–4000 个字符。');
        if (!['chemistry', 'stereo', 'layout', 'conditions', 'interaction', 'other'].includes(input.category) || !['low', 'medium', 'high'].includes(input.priority)) throw failure('VALIDATION', '反馈类别或优先级无效。');
        const target = input.target;
        if (!target || !['run', 'compound', 'step'].includes(target.kind)) throw failure('VALIDATION', '反馈目标无效。');
        const evaluations = await this.evaluations(id), evaluation = evaluations.find(e => e.id === input.evaluationId);
        if (input.evaluationId && !evaluation) throw failure('CONFLICT', '请选择有效的评分版本。');
        const limit = target.kind === 'compound' ? evaluation?.score.route.nodesExpected : evaluation?.score.route.stepsExpected;
        if (target.kind !== 'run' && (!Number.isInteger(target.number) || target.number < 1 || target.number > (limit ?? 0))) throw failure('VALIDATION', '分子或步骤编号超出当前评测范围。');
        if (!['original', 'replay', 'scheme', 'layout', 'compound', 'metrics'].includes(input.view)) throw failure('VALIDATION', '反馈视图无效。');
        const at = new Date().toISOString();
        item = { id: randomUUID(), runId: id, pluginDigest: run.pluginDigest, evaluationId: input.evaluationId ?? null, view: input.view,
          target: target.kind === 'run' ? { kind: 'run' } : { kind: target.kind, number: target.number }, category: input.category, priority: input.priority,
          text: input.text.trim(), status: 'open', version: 1, createdAt: at, updatedAt: at, history: [{ status: 'open', at }], source: 'local-review' };
        state.items.push(item);
      }
      state.receipts[input.operationId] = { signature, feedbackId: item.id };
      await mkdir(this.feedbackDirectory, { recursive: true });
      if ((await lstat(this.feedbackDirectory)).isSymbolicLink()) throw failure('FORBIDDEN', '反馈目录不能是链接。');
      const file = path.join(this.feedbackDirectory, `${id}.json`), temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx');
        try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, file);
      } catch (e) { await unlink(temporary).catch(() => {}); throw e; }
      return { items: state.items, feedbackId: item.id };
    }));
    this.queue = job.catch(() => {}); return job;
  }
  async exportFeedback() {
    const items = [];
    for (const id of await this.ids()) items.push(...(await this.feedback(id)).items);
    return { schema: 'benchmark-feedback-export/1', exportedAt: new Date().toISOString(), items };
  }
}
