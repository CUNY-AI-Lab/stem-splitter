import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const LABEL_RELEASE_PLAN = 'tests/corpus/instrument-label-release.json';
export const LABEL_RELEASE_SCHEMA = 'stem-splitter.instrument-label-release-evidence.v1';
const HASH = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const text = value => typeof value === 'string' && value.trim().length > 0;
const array = value => Array.isArray(value) ? value : [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const labelReleasePlanSha256 = plan => digest(JSON.stringify(plan));

export function labelReleaseCases(plan) {
  if (plan?.schema !== 'stem-splitter.instrument-label-release-plan.v1' ||
      !same(plan.stemCounts, [2, 4, 6]) || !same(plan.flows, ['initial', 'resplit']) ||
      array(plan.sources).length !== 3 || new Set(plan.sources.map(s => s.genre)).size !== 3 ||
      new Set(plan.sources.map(s => s.id)).size !== 3 ||
      plan.sources.some(s => !text(s.id) || !text(s.genre) || !text(s.path) || !HASH.test(s.sha256))) {
    throw new Error('The label release matrix requires three distinct genres, 2/4/6, and both flows.');
  }
  return plan.sources.flatMap(source => plan.stemCounts.flatMap(stemCount =>
    plan.flows.map(flow => ({ id: `${source.id}-${stemCount}-${flow}`, source, stemCount, flow }))));
}

/** Only local evidence beneath the supplied root; never fetch a receipt's URL. */
export function verifyLabelAudioArtifact(root, artifact) {
  if (!artifact || !text(artifact.path) || isAbsolute(artifact.path) || !HASH.test(artifact.sha256)) {
    throw new Error('Audio artifact needs a relative path and a SHA-256.');
  }
  const base = realpathSync(root);
  const candidate = resolve(base, artifact.path);
  const rel = relative(base, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Audio artifact is outside the evidence directory.');
  }
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 44 || stat.size > 100 * 1024 * 1024 ||
      realpathSync(candidate) !== candidate || digest(readFileSync(candidate)) !== artifact.sha256) {
    throw new Error('Audio artifact is missing, substituted, oversized, or has a different hash.');
  }
  if (artifact.bytes !== undefined && artifact.bytes !== stat.size) throw new Error('Audio byte count differs.');
  return true;
}

/** Evidence validation, not an audio classifier. Listening judgments must be independently supplied. */
export function evaluateLabelRelease(plan, evidence, { revision, verifyArtifact } = {}) {
  const cases = labelReleaseCases(plan);
  if (!REVISION.test(revision)) throw new Error('An exact candidate Git revision is required.');
  const globalFailures = [];
  if (evidence && (evidence.schema !== LABEL_RELEASE_SCHEMA || evidence.revision !== revision ||
      evidence.planSha256 !== labelReleasePlanSha256(plan) ||
      !Array.isArray(evidence.runs))) globalFailures.push('invalid-or-stale-evidence');
  const runs = array(evidence?.runs);
  if (runs.some(run => !cases.some(c => c.id === run?.caseId)) ||
      new Set(runs.map(run => run?.caseId)).size !== runs.length ||
      new Set(runs.map(run => run?.jobId)).size !== runs.length) globalFailures.push('unknown-or-duplicate-run');
  const results = cases.map(c => {
    const failures = [...globalFailures], blockers = [];
    const run = runs.find(r => r?.caseId === c.id);
    const fail = (condition, reason) => { if (!condition) failures.push(reason); };
    const block = reason => blockers.push(reason);
    if (!run) block('real-app-run-missing');
    else {
      fail(text(run.jobId) && ['local', 'dev', 'production'].includes(run.surface) && run.mocked === false,
        'real-app-execution-required');
      fail(run.revision === revision, 'run-revision-mismatch');
      fail(run.mode === 'audio-derived' && run.presetFallback === false, 'preset-or-unverified-source-plan');
      fail(HASH.test(run.detectorSha256) && HASH.test(run.separatorSha256), 'unpinned-models');
      fail(HASH.test(run.input?.sha256) && run.analysisInputSha256 === run.input?.sha256,
        'analysis-does-not-match-input-audio');
      if (c.flow === 'initial') fail(run.input?.sha256 === c.source.sha256 && run.parent == null,
        'initial-source-mismatch');
      else {
        const parentCase = cases.find(p => p.id === run.parent?.caseId && p.flow === 'initial' && p.source.id === c.source.id);
        const parent = runs.find(p => p.caseId === parentCase?.id);
        fail(Boolean(parent && array(parent.stems).some(s => s.sha256 === run.input?.sha256)) &&
          run.input?.sha256 !== c.source.sha256 && run.parent?.stemSha256 === run.input?.sha256,
        'resplit-not-bound-to-parent-stem-bytes');
      }
      const stems = array(run.stems);
      fail(stems.length === c.stemCount && new Set(stems.map(s => s?.sha256)).size === c.stemCount,
        'missing-or-duplicated-output-audio');
      fail(stems.every(s => text(s?.label) && HASH.test(s?.sha256)), 'output-label-or-hash-missing');
      if (typeof verifyArtifact !== 'function') block('local-audio-byte-verification-missing');
      else for (const artifact of [run.input, ...stems]) {
        try { if (verifyArtifact(artifact) !== true) throw new Error('not verified'); }
        catch { failures.push('audio-artifact-verification-failed'); }
      }
      const review = run.review;
      if (!review || review.status === 'pending') block('independent-audio-review-missing');
      else {
        fail(review.status === 'reviewed' && ['teacher', 'domain-reviewer'].includes(review.role) &&
          text(review.reviewer) && Number.isFinite(Date.parse(review.reviewedAt)), 'invalid-review');
        fail(review.inputSha256 === run.input?.sha256 && review.completeInputAndOutputsReviewed === true,
          'review-does-not-cover-exact-audio');
        if (review.allSourceContentAccountedFor !== true) block('source-content-not-accounted-for');
        const observed = array(review.inputInstruments);
        fail(observed.length > 0 && observed.every(text) && new Set(observed).size === observed.length,
          'reviewed-instrument-inventory-missing');
        const reviews = array(review.stems);
        fail(reviews.length === stems.length && new Set(reviews.map(s => s.sha256)).size === stems.length,
          'incomplete-output-review');
        for (const stem of stems) {
          const verdict = reviews.find(s => s.sha256 === stem.sha256 && s.label === stem.label);
          if (!verdict) { failures.push('review-label-or-audio-mismatch'); continue; }
          if (verdict.labelAccuracy === 'uncertain' || verdict.audioQuality === 'uncertain') {
            block('uncertain-output-label-or-quality');
          } else fail(verdict.labelAccuracy === 'correct' && verdict.audioQuality === 'usable',
            'incorrect-label-or-unusable-audio');
          fail(array(verdict.heardInstruments).length > 0 && verdict.heardInstruments.every(text),
            'heard-instruments-missing');
        }
      }
    }
    return { caseId: c.id, genre: c.source.genre, stemCount: c.stemCount, flow: c.flow,
      status: failures.length ? 'failed' : blockers.length ? 'blocked' : 'passed',
      reasons: [...new Set([...failures, ...blockers])] };
  });
  // Three genre names alone do not establish three different instrument sets.
  const inventories = plan.sources.map(source => {
    const run = runs.find(r => r.caseId === `${source.id}-6-initial`);
    return array(run?.review?.inputInstruments).map(x => String(x).trim().toLowerCase()).sort();
  });
  const distinctInstrumentation = inventories.every(i => i.length > 0) &&
    new Set(inventories.map(i => JSON.stringify(i))).size === 3;
  if (!distinctInstrumentation) for (const result of results) {
    if (result.status === 'passed') result.status = 'blocked';
    result.reasons.push('distinct-reviewed-instrument-sets-unverified');
  }
  const counts = { passed: 0, failed: 0, blocked: 0, total: cases.length };
  for (const result of results) counts[result.status]++;
  return { schema: 'stem-splitter.instrument-label-release-result.v1', revision, planSha256: labelReleasePlanSha256(plan),
    ready: counts.passed === 18, counts, distinctInstrumentation, cases: results };
}
