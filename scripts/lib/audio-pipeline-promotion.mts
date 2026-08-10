import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION } from '../../src/analysis/source-scope.ts';
import { PINNED_ROLE_CLASSIFIER_VERSION } from '../../src/analysis/types.ts';
import { AUDIOSEP_REVIEWED_REPLICATE_VERSION } from '../../src/isolation/options.ts';
import { getSeparationOptions } from '../../src/separation/options.ts';
import { SAM_AUDIO_REPLICATE_VERSION } from './query-isolation-bakeoff.mts';
import { loadRailwayRollbackBaselineEvidence } from './railway-baseline-evidence.mts';

export const AUDIO_PIPELINE_PROMOTION_SCHEMA =
  'stem-splitter.audio-pipeline-promotion.v2' as const;
export const AUDIO_PIPELINE_PROMOTION_MANIFEST_PATH =
  'tests/corpus/audio-pipeline-promotion.json' as const;

const SAFE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SAFE_TOKEN = /^[a-z0-9]+(?:[+._@/-][a-z0-9]+)*$/;
const SHA1 = /^[a-f0-9]{40}$/;
const FLOATING_VERSION = /(?:^|[+._@/-])(latest|main|master|head|current|nightly)(?:$|[+._@/-])/i;

export const AUDIO_PIPELINE_ROLLOUT_STAGES = [
  'off',
  'shadow',
  'teacher-beta',
  'student-canary',
  'default',
] as const;

export const AUDIO_PIPELINE_CHANGE_AXES = [
  'role-classifier',
  'instrument-classifier',
  'vocabulary',
  'thresholds',
  'windowing',
  'prompt-policy',
  'separator-version',
  'schema',
  'default-routing',
] as const;

export const AUDIO_PIPELINE_ACTIONS = ['provision-audio-analysis'] as const;

export const AUDIO_PIPELINE_COMPONENT_ORDER = [
  { id: 'audio-analysis', order: 1, dependsOn: [] },
  { id: 'instrument-discovery', order: 2, dependsOn: ['audio-analysis'] },
  { id: 'audiosep', order: 3, dependsOn: ['instrument-discovery'] },
  { id: 'sam-audio', order: 4, dependsOn: ['audiosep'] },
  { id: 'banquet-query-bandit', order: 5, dependsOn: ['sam-audio'] },
] as const;

type RolloutStage = (typeof AUDIO_PIPELINE_ROLLOUT_STAGES)[number];
type ChangeAxis = (typeof AUDIO_PIPELINE_CHANGE_AXES)[number];
type ComponentId = (typeof AUDIO_PIPELINE_COMPONENT_ORDER)[number]['id'];

export interface AudioPipelineCoreContract {
  id: string;
  stems: string[];
}

export interface AudioPipelineComponent {
  id: ComponentId;
  order: number;
  disposition:
    | 'implemented-off'
    | 'selection-blocked'
    | 'contract-only'
    | 'evaluation-only-license-blocked'
    | 'research-only'
    | 'shadow'
    | 'teacher-beta'
    | 'accepted';
  dependsOn: ComponentId[];
  artifactVersion: string | null;
  provisioned: boolean;
  runtimeEnabled: boolean;
  externalExecution: boolean;
  accepted: boolean;
  blockers: string[];
}

export interface AudioPipelinePromotionManifest {
  $schema: typeof AUDIO_PIPELINE_PROMOTION_SCHEMA;
  releaseId: string;
  baseCommit: string;
  candidateCommit: string;
  rolloutStage: RolloutStage;
  change: {
    axis: ChangeAxis;
    roleClassifier: boolean;
    instrumentClassifier: boolean;
    vocabulary: boolean;
    thresholds: boolean;
    windowing: boolean;
    promptPolicy: boolean;
    separatorVersion: boolean;
    schemaMigration: boolean;
    defaultRouting: boolean;
    additiveSchemaOnly: boolean;
  };
  flags: {
    SERVER_AUTO_ENABLED: boolean;
    SERVER_AUTO_MODE: 'off' | 'shadow' | 'authoritative';
    INSTRUMENT_DISCOVERY_ENABLED: boolean;
    QUERY_ISOLATION_ENABLED: boolean;
    QUERY_ISOLATION_MODE: 'off' | 'shadow';
  };
  coreContracts: AudioPipelineCoreContract[];
  components: AudioPipelineComponent[];
  evidence: {
    cleanCommitPhase0: boolean;
    coreContractRegression: boolean;
    genreCorpus: boolean;
    browserParity: boolean;
    nativeAmd64Image: boolean;
    manualListening: boolean;
    railwayBaseline: boolean;
    railwayResourceAcceptance: boolean;
    railwayShadow: boolean;
    teacherBeta: boolean;
    studentCanary: boolean;
    audienceGuard: boolean;
  };
  rollback: {
    flag: 'SERVER_AUTO_ENABLED' | 'INSTRUMENT_DISCOVERY_ENABLED' | 'QUERY_ISOLATION_ENABLED';
    offValue: false;
    localFallbackTested: boolean;
    railwayRollbackTested: boolean;
    schemaRollbackRequired: boolean;
  };
  blockers: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${context} does not match the promotion schema`);
  }
}

function safeString(value: unknown, pattern: RegExp, context: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${context} must be boolean`);
  return value;
}

function safeStringList(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${context} must be a string array`);
  }
  const result = value.map((item) => safeString(item, SAFE_TOKEN, context));
  if (new Set(result).size !== result.length) throw new Error(`${context} must be unique`);
  return result;
}

function exactVersion(value: unknown, context: string): string | null {
  if (value === null) return null;
  const version = safeString(value, SAFE_TOKEN, context);
  if (version.length > 200 || FLOATING_VERSION.test(version)) {
    throw new Error(`${context} must be an exact non-floating version`);
  }
  return version;
}

function parseChange(value: unknown): AudioPipelinePromotionManifest['change'] {
  if (!isRecord(value)) throw new Error('change must be an object');
  exactKeys(
    value,
    [
      'axis',
      'roleClassifier',
      'instrumentClassifier',
      'vocabulary',
      'thresholds',
      'windowing',
      'promptPolicy',
      'separatorVersion',
      'schemaMigration',
      'defaultRouting',
      'additiveSchemaOnly',
    ],
    'change'
  );
  if (!AUDIO_PIPELINE_CHANGE_AXES.includes(value.axis as ChangeAxis)) {
    throw new Error('change axis is invalid');
  }
  const change = {
    axis: value.axis as ChangeAxis,
    roleClassifier: boolean(value.roleClassifier, 'roleClassifier'),
    instrumentClassifier: boolean(value.instrumentClassifier, 'instrumentClassifier'),
    vocabulary: boolean(value.vocabulary, 'vocabulary'),
    thresholds: boolean(value.thresholds, 'thresholds'),
    windowing: boolean(value.windowing, 'windowing'),
    promptPolicy: boolean(value.promptPolicy, 'promptPolicy'),
    separatorVersion: boolean(value.separatorVersion, 'separatorVersion'),
    schemaMigration: boolean(value.schemaMigration, 'schemaMigration'),
    defaultRouting: boolean(value.defaultRouting, 'defaultRouting'),
    additiveSchemaOnly: boolean(value.additiveSchemaOnly, 'additiveSchemaOnly'),
  };
  const axisFlags: Record<ChangeAxis, keyof typeof change> = {
    'role-classifier': 'roleClassifier',
    'instrument-classifier': 'instrumentClassifier',
    vocabulary: 'vocabulary',
    thresholds: 'thresholds',
    windowing: 'windowing',
    'prompt-policy': 'promptPolicy',
    'separator-version': 'separatorVersion',
    schema: 'schemaMigration',
    'default-routing': 'defaultRouting',
  };
  const changed = Object.values(axisFlags).filter((key) => change[key] === true);
  if (changed.length !== 1 || change[axisFlags[change.axis]] !== true) {
    throw new Error('a promotion must change exactly one declared axis');
  }
  if (change.schemaMigration !== change.additiveSchemaOnly) {
    throw new Error('schema changes must be explicitly additive and isolated');
  }
  return change;
}

function parseFlags(value: unknown): AudioPipelinePromotionManifest['flags'] {
  if (!isRecord(value)) throw new Error('flags must be an object');
  exactKeys(
    value,
    [
      'SERVER_AUTO_ENABLED',
      'SERVER_AUTO_MODE',
      'INSTRUMENT_DISCOVERY_ENABLED',
      'QUERY_ISOLATION_ENABLED',
      'QUERY_ISOLATION_MODE',
    ],
    'flags'
  );
  if (!['off', 'shadow', 'authoritative'].includes(String(value.SERVER_AUTO_MODE))) {
    throw new Error('SERVER_AUTO_MODE is invalid');
  }
  if (!['off', 'shadow'].includes(String(value.QUERY_ISOLATION_MODE))) {
    throw new Error('QUERY_ISOLATION_MODE is invalid');
  }
  return {
    SERVER_AUTO_ENABLED: boolean(value.SERVER_AUTO_ENABLED, 'SERVER_AUTO_ENABLED'),
    SERVER_AUTO_MODE: value.SERVER_AUTO_MODE as AudioPipelinePromotionManifest['flags']['SERVER_AUTO_MODE'],
    INSTRUMENT_DISCOVERY_ENABLED: boolean(
      value.INSTRUMENT_DISCOVERY_ENABLED,
      'INSTRUMENT_DISCOVERY_ENABLED'
    ),
    QUERY_ISOLATION_ENABLED: boolean(value.QUERY_ISOLATION_ENABLED, 'QUERY_ISOLATION_ENABLED'),
    QUERY_ISOLATION_MODE:
      value.QUERY_ISOLATION_MODE as AudioPipelinePromotionManifest['flags']['QUERY_ISOLATION_MODE'],
  };
}

function parseCoreContracts(value: unknown): AudioPipelineCoreContract[] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error('coreContracts must contain the frozen 2/4/6 contracts');
  }
  const contracts = value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`coreContracts[${index}] must be an object`);
    exactKeys(candidate, ['id', 'stems'], `coreContracts[${index}]`);
    const id = safeString(candidate.id, SAFE_TOKEN, `coreContracts[${index}].id`);
    const stems = safeStringList(candidate.stems, `coreContracts[${index}].stems`);
    if (stems.length < 2 || stems.length > 6) throw new Error('core stem count is invalid');
    return { id, stems };
  });
  if (new Set(contracts.map((contract) => contract.id)).size !== contracts.length) {
    throw new Error('core contract ids must be unique');
  }
  return contracts;
}

function parseComponents(value: unknown): AudioPipelineComponent[] {
  if (!Array.isArray(value) || value.length !== AUDIO_PIPELINE_COMPONENT_ORDER.length) {
    throw new Error('components must preserve the complete dependency order');
  }
  const parsed = value.map((candidate, index): AudioPipelineComponent => {
    if (!isRecord(candidate)) throw new Error(`components[${index}] must be an object`);
    exactKeys(
      candidate,
      [
        'id',
        'order',
        'disposition',
        'dependsOn',
        'artifactVersion',
        'provisioned',
        'runtimeEnabled',
        'externalExecution',
        'accepted',
        'blockers',
      ],
      `components[${index}]`
    );
    const expected = AUDIO_PIPELINE_COMPONENT_ORDER[index];
    if (candidate.id !== expected.id || candidate.order !== expected.order) {
      throw new Error('component dependency order drifted');
    }
    if (JSON.stringify(candidate.dependsOn) !== JSON.stringify(expected.dependsOn)) {
      throw new Error(`${expected.id} dependencies drifted`);
    }
    const dispositions = [
      'implemented-off',
      'selection-blocked',
      'contract-only',
      'evaluation-only-license-blocked',
      'research-only',
      'shadow',
      'teacher-beta',
      'accepted',
    ] as const;
    if (!dispositions.includes(candidate.disposition as (typeof dispositions)[number])) {
      throw new Error(`${expected.id} disposition is invalid`);
    }
    return {
      id: expected.id,
      order: expected.order,
      disposition: candidate.disposition as AudioPipelineComponent['disposition'],
      dependsOn: [...expected.dependsOn],
      artifactVersion: exactVersion(candidate.artifactVersion, `${expected.id} artifactVersion`),
      provisioned: boolean(candidate.provisioned, `${expected.id} provisioned`),
      runtimeEnabled: boolean(candidate.runtimeEnabled, `${expected.id} runtimeEnabled`),
      externalExecution: boolean(candidate.externalExecution, `${expected.id} externalExecution`),
      accepted: boolean(candidate.accepted, `${expected.id} accepted`),
      blockers: safeStringList(candidate.blockers, `${expected.id} blockers`),
    };
  });

  const byId = new Map(parsed.map((component) => [component.id, component]));
  for (const component of parsed) {
    const dependenciesAccepted = component.dependsOn.every(
      (dependency) => byId.get(dependency)?.accepted === true
    );
    if (component.order > 1 && (component.provisioned || component.runtimeEnabled) && !dependenciesAccepted) {
      throw new Error(`${component.id} cannot run before its dependencies are accepted`);
    }
    if (component.runtimeEnabled && !component.provisioned) {
      throw new Error(`${component.id} cannot be enabled before provisioning`);
    }
    if (component.externalExecution && !component.runtimeEnabled) {
      throw new Error(`${component.id} cannot execute before enablement`);
    }
    if (component.accepted && component.blockers.length > 0) {
      throw new Error(`${component.id} cannot be accepted with blockers`);
    }
    if (
      component.accepted &&
      (!component.provisioned || !component.runtimeEnabled || !component.externalExecution)
    ) {
      throw new Error(`${component.id} must execute successfully before acceptance`);
    }
    if (component.accepted !== (component.disposition === 'accepted')) {
      throw new Error(`${component.id} accepted state and disposition must match`);
    }
    if (!component.accepted && component.blockers.length === 0) {
      throw new Error(`${component.id} must state its remaining blockers`);
    }
    if (
      ['selection-blocked', 'evaluation-only-license-blocked', 'research-only'].includes(
        component.disposition
      ) &&
      (component.provisioned || component.runtimeEnabled || component.externalExecution || component.accepted)
    ) {
      throw new Error(`${component.id} blocked disposition cannot be promoted`);
    }
    if (component.disposition === 'contract-only' && component.externalExecution) {
      throw new Error(`${component.id} contract-only disposition cannot execute`);
    }
  }
  return parsed;
}

function parseEvidence(value: unknown): AudioPipelinePromotionManifest['evidence'] {
  if (!isRecord(value)) throw new Error('evidence must be an object');
  const keys = [
    'cleanCommitPhase0',
    'coreContractRegression',
    'genreCorpus',
    'browserParity',
    'nativeAmd64Image',
    'manualListening',
    'railwayBaseline',
    'railwayResourceAcceptance',
    'railwayShadow',
    'teacherBeta',
    'studentCanary',
    'audienceGuard',
  ] as const;
  exactKeys(value, keys, 'evidence');
  return Object.fromEntries(keys.map((key) => [key, boolean(value[key], key)])) as unknown as
    AudioPipelinePromotionManifest['evidence'];
}

function parseRollback(value: unknown): AudioPipelinePromotionManifest['rollback'] {
  if (!isRecord(value)) throw new Error('rollback must be an object');
  exactKeys(
    value,
    [
      'flag',
      'offValue',
      'localFallbackTested',
      'railwayRollbackTested',
      'schemaRollbackRequired',
    ],
    'rollback'
  );
  const flags = [
    'SERVER_AUTO_ENABLED',
    'INSTRUMENT_DISCOVERY_ENABLED',
    'QUERY_ISOLATION_ENABLED',
  ] as const;
  if (!flags.includes(value.flag as (typeof flags)[number])) throw new Error('rollback flag is invalid');
  if (value.offValue !== false) throw new Error('rollback must use a false kill-switch value');
  return {
    flag: value.flag as AudioPipelinePromotionManifest['rollback']['flag'],
    offValue: false,
    localFallbackTested: boolean(value.localFallbackTested, 'localFallbackTested'),
    railwayRollbackTested: boolean(value.railwayRollbackTested, 'railwayRollbackTested'),
    schemaRollbackRequired: boolean(value.schemaRollbackRequired, 'schemaRollbackRequired'),
  };
}

function currentCoreContracts(): AudioPipelineCoreContract[] {
  return getSeparationOptions('replicate').models.map(({ id, stems }) => ({ id, stems }));
}

export function validateAudioPipelinePromotionManifest(
  value: unknown
): AudioPipelinePromotionManifest {
  if (!isRecord(value)) throw new Error('promotion manifest must be an object');
  exactKeys(
    value,
    [
      '$schema',
      'releaseId',
      'baseCommit',
      'candidateCommit',
      'rolloutStage',
      'change',
      'flags',
      'coreContracts',
      'components',
      'evidence',
      'rollback',
      'blockers',
    ],
    'promotion manifest'
  );
  if (value.$schema !== AUDIO_PIPELINE_PROMOTION_SCHEMA) {
    throw new Error('promotion schema version drifted');
  }
  if (!AUDIO_PIPELINE_ROLLOUT_STAGES.includes(value.rolloutStage as RolloutStage)) {
    throw new Error('rollout stage is invalid');
  }
  const manifest: AudioPipelinePromotionManifest = {
    $schema: AUDIO_PIPELINE_PROMOTION_SCHEMA,
    releaseId: safeString(value.releaseId, SAFE_ID, 'releaseId'),
    baseCommit: safeString(value.baseCommit, SHA1, 'baseCommit'),
    candidateCommit: safeString(value.candidateCommit, SHA1, 'candidateCommit'),
    rolloutStage: value.rolloutStage as RolloutStage,
    change: parseChange(value.change),
    flags: parseFlags(value.flags),
    coreContracts: parseCoreContracts(value.coreContracts),
    components: parseComponents(value.components),
    evidence: parseEvidence(value.evidence),
    rollback: parseRollback(value.rollback),
    blockers: safeStringList(value.blockers, 'blockers'),
  };
  if (manifest.baseCommit === manifest.candidateCommit) {
    throw new Error('base and candidate commits must differ');
  }
  if (JSON.stringify(manifest.coreContracts) !== JSON.stringify(currentCoreContracts())) {
    throw new Error('promotion core contracts drifted from the executable catalogue');
  }
  const audioAnalysis = manifest.components[0];
  const expectedAnalysisVersion =
    `${PINNED_ROLE_CLASSIFIER_VERSION}+${AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION}`;
  if (audioAnalysis.artifactVersion !== expectedAnalysisVersion) {
    throw new Error('audio-analysis version does not match compiled pins');
  }
  if (manifest.components[2].artifactVersion !== AUDIOSEP_REVIEWED_REPLICATE_VERSION) {
    throw new Error('AudioSep version does not match the reviewed adapter pin');
  }
  if (manifest.components[3].artifactVersion !== SAM_AUDIO_REPLICATE_VERSION) {
    throw new Error('SAM-Audio version does not match the evaluation pin');
  }
  if (manifest.rolloutStage === 'off') {
    if (
      manifest.flags.SERVER_AUTO_ENABLED ||
      manifest.flags.SERVER_AUTO_MODE !== 'off' ||
      manifest.flags.INSTRUMENT_DISCOVERY_ENABLED ||
      manifest.flags.QUERY_ISOLATION_ENABLED ||
      manifest.flags.QUERY_ISOLATION_MODE !== 'off'
    ) {
      throw new Error('off rollout must keep every processing feature disabled');
    }
  }
  if (manifest.flags.SERVER_AUTO_ENABLED !== manifest.components[0].runtimeEnabled) {
    throw new Error('server Auto flag must match the audio-analysis runtime state');
  }
  if (
    manifest.flags.INSTRUMENT_DISCOVERY_ENABLED !== manifest.components[1].runtimeEnabled ||
    manifest.flags.QUERY_ISOLATION_ENABLED !== manifest.components[2].runtimeEnabled
  ) {
    throw new Error('feature flags must match their component runtime state');
  }
  if (!manifest.flags.SERVER_AUTO_ENABLED && manifest.flags.SERVER_AUTO_MODE !== 'off') {
    throw new Error('server Auto mode cannot bypass its master switch');
  }
  if (!manifest.flags.QUERY_ISOLATION_ENABLED && manifest.flags.QUERY_ISOLATION_MODE !== 'off') {
    throw new Error('query isolation mode cannot bypass its master switch');
  }
  if (manifest.change.defaultRouting && manifest.rolloutStage !== 'default') {
    throw new Error('default routing may change only in a default-stage release');
  }
  if (manifest.rollback.schemaRollbackRequired) {
    throw new Error('processing rollback must not require a schema rollback');
  }
  if (!manifest.rollback.localFallbackTested) {
    throw new Error('every candidate must prove its local kill-switch fallback');
  }
  const currentStageIndex = AUDIO_PIPELINE_ROLLOUT_STAGES.indexOf(manifest.rolloutStage);
  const nextStage =
    AUDIO_PIPELINE_ROLLOUT_STAGES[currentStageIndex + 1] ?? manifest.rolloutStage;
  const declaredBlockers = [...manifest.blockers].sort();
  const computedBlockers = promotionBlockers(manifest, nextStage);
  if (JSON.stringify(declaredBlockers) !== JSON.stringify(computedBlockers)) {
    throw new Error(`blockers do not match the ${nextStage} promotion gate`);
  }
  return manifest;
}

export function promotionBlockers(
  manifest: AudioPipelinePromotionManifest,
  requestedStage: RolloutStage
): string[] {
  const blockers = new Set<string>();
  const requestedIndex = AUDIO_PIPELINE_ROLLOUT_STAGES.indexOf(requestedStage);
  const currentIndex = AUDIO_PIPELINE_ROLLOUT_STAGES.indexOf(manifest.rolloutStage);
  if (requestedIndex > currentIndex + 1) blockers.add('rollout-stage-skip');
  if (requestedIndex >= 1) {
    if (!manifest.components[0].provisioned) blockers.add('audio-analysis-service-absent');
    if (!manifest.evidence.cleanCommitPhase0) blockers.add('clean-commit-phase0-missing');
    if (!manifest.evidence.coreContractRegression) blockers.add('core-contract-regression-missing');
    if (!manifest.evidence.genreCorpus) blockers.add('genre-corpus-missing');
    if (!manifest.evidence.browserParity) blockers.add('browser-parity-missing');
    if (!manifest.evidence.nativeAmd64Image) blockers.add('native-amd64-image-missing');
    if (!manifest.evidence.manualListening) blockers.add('manual-listening-missing');
    if (!manifest.evidence.railwayBaseline) blockers.add('railway-baseline-missing');
    if (!manifest.evidence.railwayResourceAcceptance) {
      blockers.add('railway-resource-acceptance-missing');
    }
    if (!manifest.rollback.railwayRollbackTested) blockers.add('railway-rollback-missing');
  }
  if (requestedIndex >= 2) {
    if (!manifest.evidence.railwayShadow) blockers.add('railway-shadow-missing');
    if (!manifest.evidence.audienceGuard) blockers.add('audience-guard-missing');
  }
  if (requestedIndex >= 3 && !manifest.evidence.teacherBeta) blockers.add('teacher-beta-missing');
  if (requestedIndex >= 4 && !manifest.evidence.studentCanary) blockers.add('student-canary-missing');
  return [...blockers].sort();
}

export function provisionAudioAnalysisBlockers(
  manifest: AudioPipelinePromotionManifest
): string[] {
  const blockers = new Set<string>();
  if (manifest.rolloutStage !== 'off') blockers.add('rollout-must-remain-off');
  if (manifest.components[0].provisioned) blockers.add('audio-analysis-already-provisioned');
  if (!manifest.evidence.cleanCommitPhase0) blockers.add('clean-commit-phase0-missing');
  if (!manifest.evidence.coreContractRegression) blockers.add('core-contract-regression-missing');
  if (!manifest.evidence.genreCorpus) blockers.add('genre-corpus-missing');
  if (!manifest.evidence.browserParity) blockers.add('browser-parity-missing');
  if (!manifest.evidence.nativeAmd64Image) blockers.add('native-amd64-image-missing');
  if (!manifest.evidence.manualListening) blockers.add('manual-listening-missing');
  if (!manifest.evidence.railwayBaseline) blockers.add('railway-baseline-missing');
  return [...blockers].sort();
}

export function loadAudioPipelinePromotionManifest(
  repositoryRoot: string,
  manifestPath: string = AUDIO_PIPELINE_PROMOTION_MANIFEST_PATH
): AudioPipelinePromotionManifest {
  const value = JSON.parse(readFileSync(resolve(repositoryRoot, manifestPath), 'utf8')) as unknown;
  const manifest = validateAudioPipelinePromotionManifest(value);
  if (manifest.evidence.railwayBaseline) {
    loadRailwayRollbackBaselineEvidence(repositoryRoot);
  }
  return manifest;
}
