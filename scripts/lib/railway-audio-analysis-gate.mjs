export const RAILWAY_AUDIO_ANALYSIS_GATE_SCHEMA =
  'stem-splitter.railway-audio-analysis-gate.v1';
export const RAILWAY_AUDIO_ANALYSIS_SERVICE_NAME = 'audio-analysis';
export const RAILWAY_AUDIO_ANALYSIS_DOCKERFILE = 'audio-analysis/Dockerfile';
export const RAILWAY_AUDIO_ANALYSIS_CPU_LIMIT = 1;
export const RAILWAY_AUDIO_ANALYSIS_MEMORY_BYTES = 1_000_000_000;
export const RAILWAY_AUDIO_ANALYSIS_HEALTHCHECK_TIMEOUT_SECONDS = 120;
export const RAILWAY_AUDIO_ANALYSIS_RESTART_RETRIES = 3;

const SHA256 = /^[a-f0-9]{64}$/;

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function value(object, key) {
  return record(object) && Object.hasOwn(object, key) ? object[key] : undefined;
}

function safeToken(candidate) {
  return (
    typeof candidate === 'string' &&
    candidate.length >= 32 &&
    candidate === candidate.trim() &&
    !/\s|[\u0000-\u001f\u007f]/.test(candidate)
  );
}

function exactHttpsOrigin(candidate) {
  if (typeof candidate !== 'string') return null;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function privateAnalysisOrigin(candidate, expectedHostname) {
  if (typeof candidate !== 'string') return false;
  try {
    const url = new URL(candidate);
    return Boolean(
      url.protocol === 'http:' &&
        url.hostname.endsWith('.railway.internal') &&
        (!expectedHostname || url.hostname === expectedHostname) &&
        url.port === '8080' &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash
    );
  } catch {
    return false;
  }
}

function absentOr(valueToCheck, expected) {
  return valueToCheck === undefined || valueToCheck === expected;
}

function validateSafeAppOffVariables(appVariables, { requireAnalysis = false } = {}) {
  const failures = [];
  if (!record(appVariables)) return ['app variable readback is invalid'];
  if (!SHA256.test(String(value(appVariables, 'REPLICATE_YT_MODEL_VERSION') ?? ''))) {
    failures.push('REPLICATE_YT_MODEL_VERSION is not one exact 64-hex pin');
  }

  const offPosture = [
    ['SERVER_AUTO_ENABLED', 'false'],
    ['SERVER_AUTO_MODE', 'off'],
    ['INSTRUMENT_DISCOVERY_ENABLED', 'false'],
    ['QUERY_ISOLATION_ENABLED', 'false'],
    ['QUERY_ISOLATION_MODE', 'off'],
  ];
  for (const [name, expected] of offPosture) {
    const current = value(appVariables, name);
    if (requireAnalysis ? current !== expected : !absentOr(current, expected)) {
      failures.push(`${name} is not explicitly safe for this gate`);
    }
  }
  if (value(appVariables, 'REPLICATE_AUDIOSEP_VERSION') !== undefined) {
    failures.push('REPLICATE_AUDIOSEP_VERSION must remain absent during Phase 1');
  }
  for (const name of [
    'QUERY_ISOLATION_COURSE_ID',
    'QUERY_ISOLATION_SEMESTER_ID',
    'QUERY_ISOLATION_MAX_PROVIDER_STARTS',
  ]) {
    if (value(appVariables, name) !== undefined) {
      failures.push(`${name} must remain absent during Phase 1`);
    }
  }
  if (!requireAnalysis) {
    for (const name of [
      'AUDIO_ANALYSIS_URL',
      'AUDIO_ANALYSIS_TOKEN',
      'AUDIO_ANALYSIS_TIMEOUT_MS',
    ]) {
      if (value(appVariables, name) !== undefined) {
        failures.push(`${name} must remain absent before the analysis service exists`);
      }
    }
  }
  return failures;
}

function validateCanonicalApp(app, appServiceId, appVariables) {
  const failures = [];
  if (!app || app.id !== appServiceId || app.name !== 'stem-splitter') {
    return ['the explicit canonical app service is missing'];
  }
  if (app.status !== 'SUCCESS' || app.latestDeployment?.status !== 'SUCCESS') {
    failures.push('the canonical app does not have one active successful deployment');
  }
  const configuredOrigin = exactHttpsOrigin(value(appVariables, 'PUBLIC_BASE_URL'));
  const deployedOrigin = exactHttpsOrigin(app.url);
  if (!configuredOrigin || !deployedOrigin || configuredOrigin !== deployedOrigin) {
    failures.push('the canonical app public origin does not match Railway readback');
  }
  return failures;
}

export function findRailwayAudioAnalysisPreProvisionViolations({
  services,
  appServiceId,
  appVariables,
}) {
  const failures = [];
  if (!Array.isArray(services)) return ['Railway service inventory is invalid'];
  const app = services.find((service) => record(service) && service.id === appServiceId);
  failures.push(...validateCanonicalApp(app, appServiceId, appVariables));
  const analyzers = services.filter(
    (service) => record(service) && service.name === RAILWAY_AUDIO_ANALYSIS_SERVICE_NAME
  );
  if (analyzers.length) {
    failures.push('audio-analysis already exists; use the deployed-off gate instead');
  }
  failures.push(...validateSafeAppOffVariables(appVariables));
  return failures;
}

export function findRailwayAudioAnalysisDeployedOffViolations({
  services,
  deployments,
  limits,
  appServiceId,
  appVariables,
  analysisVariables,
}) {
  const failures = [];
  if (!Array.isArray(services)) return ['Railway service inventory is invalid'];
  const app = services.find((service) => record(service) && service.id === appServiceId);
  const analyzers = services.filter(
    (service) => record(service) && service.name === RAILWAY_AUDIO_ANALYSIS_SERVICE_NAME
  );
  failures.push(...validateCanonicalApp(app, appServiceId, appVariables));
  if (analyzers.length !== 1) {
    failures.push('exactly one audio-analysis service must exist');
    return failures;
  }
  const analysis = analyzers[0];
  if (analysis.status !== 'SUCCESS' || analysis.latestDeployment?.status !== 'SUCCESS') {
    failures.push('audio-analysis is not at terminal SUCCESS');
  }
  if (analysis.url !== null && analysis.url !== undefined && analysis.url !== '') {
    failures.push('audio-analysis must not expose a public domain');
  }
  if (!Array.isArray(analysis.volumes) || analysis.volumes.length !== 0) {
    failures.push('audio-analysis must not attach a persistent volume');
  }
  if (
    analysis.replicas?.configured !== 1 ||
    analysis.replicas?.running !== 1 ||
    analysis.replicas?.crashed !== 0
  ) {
    failures.push('audio-analysis must have exactly one healthy running replica');
  }
  const appRegions = Array.isArray(app?.regions) ? app.regions : [];
  const analysisRegions = Array.isArray(analysis.regions) ? analysis.regions : [];
  if (
    appRegions.length !== 1 ||
    analysisRegions.length !== 1 ||
    appRegions[0]?.name !== analysisRegions[0]?.name ||
    analysisRegions[0]?.configured !== 1
  ) {
    failures.push('audio-analysis must use the canonical app region with one replica');
  }

  const deployment = Array.isArray(deployments)
    ? deployments.find((candidate) => candidate?.id === analysis.deploymentId)
    : null;
  if (!deployment || deployment.status !== 'SUCCESS') {
    failures.push('the active audio-analysis deployment readback is missing');
  } else {
    const manifest = deployment.meta?.serviceManifest;
    const build = manifest?.build;
    const deploy = manifest?.deploy;
    const dockerfile = String(build?.dockerfilePath ?? '').replace(/^\/+/, '');
    if (
      build?.builder !== 'DOCKERFILE' ||
      build?.buildEnvironment !== 'V3' ||
      dockerfile !== RAILWAY_AUDIO_ANALYSIS_DOCKERFILE
    ) {
      failures.push('audio-analysis is not built from the reviewed Dockerfile');
    }
    if (deployment.meta?.rootDirectory !== null && deployment.meta?.rootDirectory !== undefined) {
      failures.push('audio-analysis must keep the repository root as build context');
    }
    if (
      deploy?.healthcheckPath !== '/readyz' ||
      deploy?.healthcheckTimeout !== RAILWAY_AUDIO_ANALYSIS_HEALTHCHECK_TIMEOUT_SECONDS
    ) {
      failures.push('audio-analysis readiness healthcheck configuration drifted');
    }
    if (
      deploy?.restartPolicyType !== 'ON_FAILURE' ||
      deploy?.restartPolicyMaxRetries !== RAILWAY_AUDIO_ANALYSIS_RESTART_RETRIES
    ) {
      failures.push('audio-analysis restart policy drifted');
    }
    if (deploy?.sleepApplication !== false) {
      failures.push('audio-analysis must stay warmed during Phase 1 measurement');
    }
    if (
      deploy?.startCommand !== null ||
      deploy?.preDeployCommand !== null ||
      deploy?.cronSchedule !== null
    ) {
      failures.push('audio-analysis must use its image command without predeploy or cron overrides');
    }
    const regions = Object.values(deploy?.multiRegionConfig ?? {});
    const deploymentRegion = Object.keys(deploy?.multiRegionConfig ?? {})[0];
    if (
      regions.length !== 1 ||
      regions[0]?.numReplicas !== 1 ||
      deploymentRegion !== analysisRegions[0]?.name
    ) {
      failures.push('audio-analysis must deploy one replica in one region');
    }
    if (Array.isArray(deployment.meta?.volumeMounts) && deployment.meta.volumeMounts.length) {
      failures.push('audio-analysis deployment unexpectedly mounts a volume');
    }
  }

  if (
    limits?.containers?.cpu !== RAILWAY_AUDIO_ANALYSIS_CPU_LIMIT ||
    limits?.containers?.memoryBytes !== RAILWAY_AUDIO_ANALYSIS_MEMORY_BYTES
  ) {
    failures.push('audio-analysis resource overrides are not exactly 1 vCPU and 1 GB');
  }

  failures.push(...validateSafeAppOffVariables(appVariables, { requireAnalysis: true }));
  if (!record(analysisVariables)) {
    failures.push('audio-analysis variable readback is invalid');
    return failures;
  }
  const exactAnalysisVariables = {
    PORT: '8080',
    AUDIO_ANALYSIS_MAX_CONCURRENCY: '1',
    AUDIO_ANALYSIS_MAX_SOURCE_BYTES: '104857600',
    AUDIO_ANALYSIS_MAX_SOURCE_SECONDS: '900',
    AUDIO_ANALYSIS_FETCH_TIMEOUT_MS: '10000',
    AUDIO_ANALYSIS_DECODER_TIMEOUT_MS: '10000',
  };
  for (const [name, expected] of Object.entries(exactAnalysisVariables)) {
    if (value(analysisVariables, name) !== expected) {
      failures.push(`${name} does not match the reviewed Phase 1 value`);
    }
  }
  for (const name of [
    'AUDIO_ANALYSIS_ALLOW_HTTP',
    'AUDIO_ANALYSIS_EXPECTED_FFMPEG_VERSION',
    'INSTRUMENT_DISCOVERY_URL',
    'INSTRUMENT_DISCOVERY_TOKEN',
    'INSTRUMENT_DISCOVERY_TIMEOUT_MS',
  ]) {
    if (value(analysisVariables, name) !== undefined) {
      failures.push(`${name} must remain absent during Phase 1`);
    }
  }

  const appOrigin = exactHttpsOrigin(value(appVariables, 'PUBLIC_BASE_URL'));
  if (!appOrigin || value(analysisVariables, 'AUDIO_ANALYSIS_SOURCE_ORIGINS') !== appOrigin) {
    failures.push('audio-analysis source origins do not exactly match the canonical app');
  }
  const analysisToken = value(analysisVariables, 'AUDIO_ANALYSIS_TOKEN');
  const appToken = value(appVariables, 'AUDIO_ANALYSIS_TOKEN');
  if (!safeToken(analysisToken) || !safeToken(appToken) || analysisToken !== appToken) {
    failures.push('the private analysis token is missing, invalid, or not shared exactly');
  }
  const privateHostname = value(analysisVariables, 'RAILWAY_PRIVATE_DOMAIN');
  if (
    typeof privateHostname !== 'string' ||
    !privateAnalysisOrigin(value(appVariables, 'AUDIO_ANALYSIS_URL'), privateHostname)
  ) {
    failures.push('the app analysis URL is not the exact private Railway origin');
  }
  if (value(appVariables, 'AUDIO_ANALYSIS_TIMEOUT_MS') !== '25000') {
    failures.push('AUDIO_ANALYSIS_TIMEOUT_MS does not match the Phase 1 outer budget');
  }
  return failures;
}

export function assertNoRailwayAudioAnalysisViolations(failures) {
  if (!Array.isArray(failures) || failures.some((failure) => typeof failure !== 'string')) {
    throw new Error('Railway analysis gate produced invalid diagnostics');
  }
  if (failures.length) {
    throw new Error(`Railway audio-analysis gate failed:\n- ${failures.join('\n- ')}`);
  }
}
