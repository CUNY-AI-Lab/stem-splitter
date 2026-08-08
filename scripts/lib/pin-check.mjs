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
