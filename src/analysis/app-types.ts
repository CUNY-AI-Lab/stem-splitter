import type {
  AudioSourceType,
  AutoRoutingDecisionV1,
  AutoRoutingResolutionV1,
} from './types.ts';

/** App provenance can expand independently of the verified analyzer image. */
export type AppAudioSourceType = AudioSourceType | 'vimeo' | 'audius';

export type AppAutoRoutingDecisionV1 = Omit<AutoRoutingDecisionV1, 'sourceType'> & {
  sourceType: AppAudioSourceType;
};

export type AppAutoRoutingResolutionV1 = Omit<AutoRoutingResolutionV1, 'decision'> & {
  decision: AppAutoRoutingDecisionV1;
};
