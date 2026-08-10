import { resolve } from 'node:path';

import {
  AUDIO_PIPELINE_PROMOTION_MANIFEST_PATH,
  AUDIO_PIPELINE_ROLLOUT_STAGES,
  loadAudioPipelinePromotionManifest,
  promotionBlockers,
} from './lib/audio-pipeline-promotion.mts';

let manifestPath: string = AUDIO_PIPELINE_PROMOTION_MANIFEST_PATH;
let requiredStage: (typeof AUDIO_PIPELINE_ROLLOUT_STAGES)[number] | null = null;

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === '--manifest') {
    const value = process.argv[++index];
    if (!value) throw new Error('--manifest requires a path');
    manifestPath = value;
  } else if (argument === '--require-stage') {
    const value = process.argv[++index];
    if (!AUDIO_PIPELINE_ROLLOUT_STAGES.includes(value as any)) {
      throw new Error('--require-stage must name a known rollout stage');
    }
    requiredStage = value as (typeof AUDIO_PIPELINE_ROLLOUT_STAGES)[number];
  } else {
    throw new Error(`Unknown argument: ${argument}`);
  }
}

const repositoryRoot = process.cwd();
const manifest = loadAudioPipelinePromotionManifest(repositoryRoot, manifestPath);
const currentIndex = AUDIO_PIPELINE_ROLLOUT_STAGES.indexOf(manifest.rolloutStage);
const nextStage = AUDIO_PIPELINE_ROLLOUT_STAGES[currentIndex + 1] ?? manifest.rolloutStage;
const requestedStage = requiredStage ?? nextStage;
const blockers = promotionBlockers(manifest, requestedStage);

const summary = {
  schema: manifest.$schema,
  manifest: resolve(repositoryRoot, manifestPath),
  releaseId: manifest.releaseId,
  candidateCommit: manifest.candidateCommit,
  changeAxis: manifest.change.axis,
  currentStage: manifest.rolloutStage,
  requestedStage,
  promotable: blockers.length === 0,
  blockers,
  componentOrder: manifest.components.map((component) => ({
    order: component.order,
    id: component.id,
    disposition: component.disposition,
  })),
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (requiredStage && blockers.length > 0) process.exitCode = 1;
