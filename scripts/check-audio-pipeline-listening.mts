#!/usr/bin/env node

import { resolve } from 'node:path';

import {
  AUDIO_PIPELINE_LISTENING_EVIDENCE_PATH,
  loadAudioPipelineListeningEvidence,
} from './lib/audio-pipeline-listening-evidence.mts';

let evidencePath: string = AUDIO_PIPELINE_LISTENING_EVIDENCE_PATH;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument !== '--review') throw new Error(`Unknown argument: ${argument}`);
  const value = process.argv[++index];
  if (!value) throw new Error('--review requires a path');
  evidencePath = value;
}

const repositoryRoot = process.cwd();
const review = loadAudioPipelineListeningEvidence(repositoryRoot, evidencePath);
process.stdout.write(
  `${JSON.stringify(
    {
      schema: review.schema,
      review: resolve(repositoryRoot, evidencePath),
      releaseId: review.releaseId,
      reviewedAt: review.reviewedAt,
      reviewedBy: review.reviewedBy,
      reviewerRole: review.reviewerRole,
      decision: review.decision,
      baselineArtifactSha256: review.baselineArtifactSha256,
      jobId: review.jobId,
      model: review.model,
      stemHashes: review.stemHashes,
    },
    null,
    2
  )}\n`
);
