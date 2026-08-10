// Pure drift-detection logic for the Replicate version pin, kept free of I/O
// so tests/separation.test.mts can exercise it offline. The network half lives
// in scripts/check-replicate-pin.mjs.

/**
 * Replicate hangs enums off components.schemas via allOf/$ref. Flatten the
 * Input schema into { name: { type, enum, default } }.
 */
export function resolveInputProperties(openapiSchema) {
  const components = openapiSchema?.components?.schemas ?? {};
  const input = components.Input?.properties ?? {};
  const resolved = {};
  for (const [name, raw] of Object.entries(input)) {
    const ref = raw.allOf?.[0]?.$ref ?? raw.$ref;
    const target = ref ? components[ref.split('/').pop()] : undefined;
    resolved[name] = {
      type: raw.type ?? target?.type,
      format: raw.format ?? target?.format,
      enum: raw.enum ?? target?.enum,
      default: raw.default,
    };
  }
  return resolved;
}

/**
 * Compare what the catalogue sends against what a pinned version accepts.
 * Returns human-readable failures; an empty array means the pin is safe.
 */
export function findPinViolations(surface, properties) {
  const failures = [];

  if (!Object.keys(properties).length) {
    return ['the pinned version exposes no Input schema — cannot verify anything'];
  }

  // Catches output_format -> format and the mp3_bitrate removal.
  for (const key of surface.inputKeys) {
    if (!(key in properties)) {
      failures.push(`input "${key}" no longer exists on the pinned version`);
    }
  }

  // Catches a build that dropped htdemucs_ft / htdemucs_6s.
  const modelEnum = properties.model?.enum;
  if (!modelEnum) {
    failures.push('the pinned version no longer declares a `model` enum');
  } else {
    for (const id of surface.modelIds) {
      if (!modelEnum.includes(id)) {
        failures.push(`model "${id}" is no longer accepted (enum: ${modelEnum.join(', ')})`);
      }
    }
  }

  // The two-track split depends on `stem` accepting "vocals".
  if (surface.inputKeys.includes('stem')) {
    const stemEnum = properties.stem?.enum;
    if (!stemEnum) {
      failures.push('`stem` no longer declares an enum — the 2-track split may not isolate');
    } else if (!stemEnum.includes('vocals')) {
      failures.push(`\`stem\` no longer accepts "vocals" (enum: ${stemEnum.join(', ')})`);
    }
  }

  return failures;
}

/** Validate the separate, target-only AudioSep query-isolation contract. */
export function findQueryIsolationPinViolations(surface, openapiSchema) {
  const failures = [];
  const components = openapiSchema?.components?.schemas ?? {};
  const input = resolveInputProperties(openapiSchema);

  if (!Object.keys(input).length) {
    return ['the pinned isolation version exposes no Input schema — cannot verify anything'];
  }
  for (const key of surface.inputKeys) {
    if (!(key in input)) {
      failures.push(`isolation input "${key}" no longer exists on the pinned version`);
    }
  }
  if (input.audio_file && input.audio_file.type !== 'string') {
    failures.push('isolation input "audio_file" is no longer a string');
  }
  if (input.audio_file && input.audio_file.format !== 'uri') {
    failures.push('isolation input "audio_file" is no longer declared as a URI');
  }
  if (input.text && input.text.type !== 'string') {
    failures.push('isolation input "text" is no longer a string');
  }

  const output = components.Output;
  if (!output) {
    failures.push('the pinned isolation version exposes no Output schema');
  } else if (surface.output === 'uri') {
    if (output.type !== 'string') {
      failures.push('the pinned isolation output is no longer one URI string');
    }
    if (output.format !== 'uri') {
      failures.push('the pinned isolation output is no longer declared as a URI');
    }
  }
  return failures;
}

/**
 * Validate the community SAM-Audio schema for an evaluation-only bake-off.
 * This does not approve the SAM License, gated checkpoint, community wrapper,
 * or any application/provider route; those remain separate hard blockers.
 */
export function findSamAudioEvaluationPinViolations(surface, openapiSchema) {
  const failures = [];
  const components = openapiSchema?.components?.schemas ?? {};
  const inputSchema = components.Input;
  const input = resolveInputProperties(openapiSchema);

  if (!Object.keys(input).length) {
    return ['the pinned SAM-Audio evaluation version exposes no Input schema'];
  }
  for (const key of surface.inputKeys) {
    if (!(key in input)) {
      failures.push(`SAM-Audio evaluation input "${key}" no longer exists`);
    }
  }
  for (const key of surface.requiredInputKeys) {
    if (!inputSchema?.required?.includes(key)) {
      failures.push(`SAM-Audio evaluation input "${key}" is no longer required`);
    }
  }
  if (input.audio && (input.audio.type !== 'string' || input.audio.format !== 'uri')) {
    failures.push('SAM-Audio evaluation input "audio" is no longer one URI string');
  }
  for (const key of ['description', 'span_anchors']) {
    if (input[key] && input[key].type !== 'string') {
      failures.push(`SAM-Audio evaluation input "${key}" is no longer a string`);
    }
  }
  for (const key of ['predict_spans', 'output_residual', 'use_span_prompting']) {
    if (input[key] && input[key].type !== 'boolean') {
      failures.push(`SAM-Audio evaluation input "${key}" is no longer boolean`);
    }
  }

  const output = components.Output;
  if (!output) {
    failures.push('the pinned SAM-Audio evaluation version exposes no Output schema');
  } else if (
    surface.output === 'uri-array' &&
    (output.type !== 'array' || output.items?.type !== 'string' || output.items?.format !== 'uri')
  ) {
    failures.push('the pinned SAM-Audio evaluation output is no longer an array of URI strings');
  }
  return failures;
}

/** Validate the separate Replicate yt-dlp pin used by the Railway importer. */
export function findYouTubePinViolations(openapiSchema) {
  const failures = [];
  const components = openapiSchema?.components?.schemas ?? {};
  const inputSchema = components.Input;
  const input = resolveInputProperties(openapiSchema);
  const output = components.Output;

  for (const key of ['url', 'max_duration']) {
    if (!(key in input)) failures.push(`input "${key}" no longer exists on the pinned version`);
  }
  if (input.url && input.url.type !== 'string') {
    failures.push('input "url" is no longer a string');
  }
  if (input.max_duration && input.max_duration.type !== 'integer') {
    failures.push('input "max_duration" is no longer an integer');
  }
  if (!inputSchema?.required?.includes('url')) {
    failures.push('input "url" is no longer required');
  }
  if (!output || output.type !== 'object') {
    failures.push('the pinned version no longer exposes an object Output schema');
    return failures;
  }
  for (const key of ['audio', 'duration', 'title']) {
    if (!(key in (output.properties ?? {}))) {
      failures.push(`output "${key}" no longer exists on the pinned version`);
    } else if (!output.required?.includes(key)) {
      failures.push(`output "${key}" is no longer required`);
    }
  }
  if (output.properties?.audio && output.properties.audio.type !== 'string') {
    failures.push('output "audio" is no longer a string');
  }
  if (output.properties?.duration && output.properties.duration.type !== 'number') {
    failures.push('output "duration" is no longer a number');
  }
  if (output.properties?.title && output.properties.title.type !== 'string') {
    failures.push('output "title" is no longer a string');
  }
  return failures;
}
