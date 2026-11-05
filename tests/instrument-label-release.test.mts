import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { LABEL_RELEASE_SCHEMA, evaluateLabelRelease, labelReleaseCases,
  labelReleasePlanSha256, verifyLabelAudioArtifact } from '../scripts/lib/instrument-label-release.mjs';

const plan = JSON.parse(readFileSync(new URL('./corpus/instrument-label-release.json', import.meta.url), 'utf8'));
const revision = '1'.repeat(40);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

// Contract fixtures only. These invented judgments are never real audio evidence.
function syntheticEvidence(): any {
  const runs = labelReleaseCases(plan).map((c: any) => {
    const inputSha = c.flow === 'initial' ? c.source.sha256 : hash(`${c.source.id}-6-initial:0`);
    const stems = Array.from({ length: c.stemCount }, (_, i) => ({ label: `Synthetic source ${i + 1}`,
      path: `${c.id}-${i}.wav`, sha256: hash(`${c.id}:${i}`) }));
    return { caseId: c.id, jobId: `synthetic-job-${c.id}`, surface: 'local', mocked: false, revision,
      mode: 'audio-derived', presetFallback: false, detectorSha256: hash('detector'), separatorSha256: hash('separator'),
      input: { path: `${c.id}-input.wav`, sha256: inputSha }, analysisInputSha256: inputSha,
      parent: c.flow === 'initial' ? null : { caseId: `${c.source.id}-6-initial`, stemSha256: inputSha }, stems,
      review: { status: 'reviewed', role: 'domain-reviewer', reviewer: 'Synthetic test reviewer',
        reviewedAt: '2026-11-05T00:00:00.000Z', inputSha256: inputSha, completeInputAndOutputsReviewed: true,
        allSourceContentAccountedFor: true, inputInstruments: [`Synthetic ${c.source.id} instrument`, 'Synthetic shared instrument'],
        stems: stems.map(s => ({ sha256: s.sha256, label: s.label, labelAccuracy: 'correct', audioQuality: 'usable',
          heardInstruments: ['Synthetic instrument'] })) } };
  });
  return { schema: LABEL_RELEASE_SCHEMA, revision, planSha256: labelReleasePlanSha256(plan), runs };
}
const evaluate = (evidence?: any, options: any = {}) => evaluateLabelRelease(plan, evidence,
  { revision, verifyArtifact: () => true, ...options });

test('release matrix covers each count and each flow in three genres, with no missing case counted as a pass', () => {
  const result = evaluate();
  assert.equal(result.ready, false);
  assert.deepEqual(result.counts, { passed: 0, failed: 0, blocked: 18, total: 18 });
  for (const count of [2, 4, 6]) assert.equal(result.cases.filter((c: any) => c.stemCount === count).length, 6);
  assert.equal(new Set(result.cases.map((c: any) => c.genre)).size, 3);
});

test('complete synthetic contract evidence is accepted only with byte verification; this is not a model-quality test', () => {
  assert.equal(evaluate(syntheticEvidence()).ready, true);
  const missingVerifier = evaluate(syntheticEvidence(), { verifyArtifact: undefined });
  assert.equal(missingVerifier.ready, false);
  assert.equal(missingVerifier.counts.blocked, 18);
});

test('changing six to four, removing a genre, or removing resplits cannot shrink the release denominator', () => {
  for (const altered of [{ ...plan, stemCounts: [2, 4] }, { ...plan, flows: ['initial'] },
    { ...plan, sources: plan.sources.slice(0, 2) }]) assert.throws(() => labelReleaseCases(altered));
});

test('preset fallback, fake app runs, stale revisions and duplicate jobs cannot satisfy the gate', () => {
  for (const mutate of [
    (e: any) => { e.runs[0].presetFallback = true; },
    (e: any) => { e.runs[0].mode = 'demucs-renamed'; },
    (e: any) => { e.runs[0].mocked = true; },
    (e: any) => { e.runs[0].surface = 'upstream-only'; },
    (e: any) => { e.revision = '2'.repeat(40); },
    (e: any) => { e.planSha256 = hash('different-matrix'); },
    (e: any) => { e.runs[0].jobId = e.runs[1].jobId; },
  ]) {
    const e = syntheticEvidence(); mutate(e);
    const result = evaluate(e); assert.equal(result.ready, false); assert.ok(result.counts.failed > 0);
  }
});

test('resplitting must analyze the selected stem bytes again, not the original file or inherited parent labels', () => {
  const e = syntheticEvidence();
  const resplit = e.runs.find((r: any) => r.caseId === 'orchestral-4-resplit');
  resplit.analysisInputSha256 = plan.sources[0].sha256;
  assert.ok(evaluate(e).cases.find((c: any) => c.caseId === resplit.caseId).reasons.includes('analysis-does-not-match-input-audio'));
  resplit.analysisInputSha256 = resplit.input.sha256;
  resplit.input.sha256 = plan.sources[0].sha256;
  assert.ok(evaluate(e).cases.find((c: any) => c.caseId === resplit.caseId).reasons.includes('resplit-not-bound-to-parent-stem-bytes'));
});

test('incorrect labels, silent audio, duplicated stems and substituted output bytes fail', () => {
  for (const mutate of [
    (e: any) => { e.runs[0].review.stems[0].labelAccuracy = 'incorrect'; },
    (e: any) => { e.runs[0].review.stems[0].audioQuality = 'silent'; },
    (e: any) => { e.runs[0].stems[1] = e.runs[0].stems[0]; },
    (e: any) => { e.runs[0].stems[0].label = 'Invented piano'; },
  ]) {
    const e = syntheticEvidence(); mutate(e); assert.equal(evaluate(e).cases[0].status, 'failed');
  }
  assert.equal(evaluate(syntheticEvidence(), { verifyArtifact: () => { throw new Error('changed bytes'); } }).counts.failed, 18);
});

test('uncertainty and genre-only labels stay blocked rather than being treated as successful recognition', () => {
  const e = syntheticEvidence(); e.runs[0].review.stems[0].labelAccuracy = 'uncertain';
  assert.equal(evaluate(e).cases[0].status, 'blocked');
  for (const r of e.runs) r.review.inputInstruments = ['same', 'instrument', 'set'];
  assert.equal(evaluate(e).counts.blocked, 18);
});

test('missing review or a review for different audio cannot establish label accuracy', () => {
  const e = syntheticEvidence(); e.runs[0].review = null;
  assert.equal(evaluate(e).cases[0].status, 'blocked');
  const other = syntheticEvidence(); other.runs[0].review.stems[0].sha256 = hash('wrong-audio');
  assert.equal(evaluate(other).cases[0].status, 'failed');
});

test('artifact verifier rejects missing files, changed bytes, symlinks and traversal', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'stem-label-artifacts-'));
  try {
    const bytes = Buffer.alloc(64, 7); writeFileSync(resolve(root, 'output.wav'), bytes);
    const artifact = { path: 'output.wav', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    assert.equal(verifyLabelAudioArtifact(root, artifact), true);
    for (const changed of [{ ...artifact, sha256: hash('wrong') }, { ...artifact, bytes: 99 },
      { ...artifact, path: 'missing.wav' }, { ...artifact, path: '../output.wav' }]) {
      assert.throws(() => verifyLabelAudioArtifact(root, changed));
    }
    symlinkSync(resolve(root, 'output.wav'), resolve(root, 'link.wav'));
    assert.throws(() => verifyLabelAudioArtifact(root, { ...artifact, path: 'link.wav' }));
    writeFileSync(resolve(root, 'output.wav'), Buffer.alloc(64, 8));
    assert.throws(() => verifyLabelAudioArtifact(root, artifact));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
