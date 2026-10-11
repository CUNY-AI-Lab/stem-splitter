import type { AppAutoRoutingDecisionV1 } from './app-types.ts';

/**
 * Student job responses retain the honest core-routing reason but not candidate
 * instrument labels or the private classifier pin. Full metadata stays in the
 * persisted decision and is available only through a teacher-authenticated API.
 */
export function redactInstrumentDiscovery(
  route: AppAutoRoutingDecisionV1
): AppAutoRoutingDecisionV1 {
  const { vocabularyClassifier: _vocabulary, ...analysis } = route.analysis;
  return {
    ...route,
    analysis: {
      ...analysis,
      detectedInstruments: [],
    },
  };
}
