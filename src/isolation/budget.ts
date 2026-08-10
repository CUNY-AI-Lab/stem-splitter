import type { Env } from '../env.ts';

export const QUERY_ISOLATION_BUDGET_POLICY_VERSION =
  'course-semester-provider-starts-v1' as const;
export const QUERY_ISOLATION_COURSE_ID_VAR = 'QUERY_ISOLATION_COURSE_ID' as const;
export const QUERY_ISOLATION_SEMESTER_ID_VAR = 'QUERY_ISOLATION_SEMESTER_ID' as const;
export const QUERY_ISOLATION_MAX_PROVIDER_STARTS_VAR =
  'QUERY_ISOLATION_MAX_PROVIDER_STARTS' as const;

const SAFE_SCOPE_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const MAXIMUM_PROVIDER_STARTS = 1000;

export interface QueryIsolationBudgetPolicyV1 {
  policyVersion: typeof QUERY_ISOLATION_BUDGET_POLICY_VERSION;
  courseId: string;
  semesterId: string;
  maximumProviderStarts: number;
}

export type QueryIsolationBudgetConfigurationStatus =
  | 'unconfigured'
  | 'incomplete'
  | 'invalid'
  | 'configured';

type BudgetEnv = Pick<
  Env,
  | 'QUERY_ISOLATION_COURSE_ID'
  | 'QUERY_ISOLATION_SEMESTER_ID'
  | 'QUERY_ISOLATION_MAX_PROVIDER_STARTS'
>;

function validScopeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SCOPE_ID.test(value);
}

function parseMaximumProviderStarts(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$|^1000$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAXIMUM_PROVIDER_STARTS ? parsed : null;
}

export function validateQueryIsolationBudgetPolicy(
  value: QueryIsolationBudgetPolicyV1
): QueryIsolationBudgetPolicyV1 {
  if (value.policyVersion !== QUERY_ISOLATION_BUDGET_POLICY_VERSION) {
    throw new Error('Unsupported query-isolation budget policy version');
  }
  if (!validScopeId(value.courseId)) {
    throw new Error('Invalid query-isolation course id');
  }
  if (!validScopeId(value.semesterId)) {
    throw new Error('Invalid query-isolation semester id');
  }
  if (
    !Number.isSafeInteger(value.maximumProviderStarts) ||
    value.maximumProviderStarts < 1 ||
    value.maximumProviderStarts > MAXIMUM_PROVIDER_STARTS
  ) {
    throw new Error('Invalid query-isolation provider-start budget');
  }
  return value;
}

export function queryIsolationBudgetConfigurationStatus(
  env: BudgetEnv
): QueryIsolationBudgetConfigurationStatus {
  const values = [
    env.QUERY_ISOLATION_COURSE_ID,
    env.QUERY_ISOLATION_SEMESTER_ID,
    env.QUERY_ISOLATION_MAX_PROVIDER_STARTS,
  ];
  const present = values.filter((value) => value !== undefined && value !== '').length;
  if (present === 0) return 'unconfigured';
  if (present !== values.length) return 'incomplete';
  return validScopeId(values[0]) &&
    validScopeId(values[1]) &&
    parseMaximumProviderStarts(values[2]) !== null
    ? 'configured'
    : 'invalid';
}

export function queryIsolationBudgetPolicy(env: BudgetEnv): QueryIsolationBudgetPolicyV1 {
  if (queryIsolationBudgetConfigurationStatus(env) !== 'configured') {
    throw new Error('Query-isolation course-semester budget is not configured');
  }
  return validateQueryIsolationBudgetPolicy({
    policyVersion: QUERY_ISOLATION_BUDGET_POLICY_VERSION,
    courseId: env.QUERY_ISOLATION_COURSE_ID!,
    semesterId: env.QUERY_ISOLATION_SEMESTER_ID!,
    maximumProviderStarts: parseMaximumProviderStarts(
      env.QUERY_ISOLATION_MAX_PROVIDER_STARTS
    )!,
  });
}
