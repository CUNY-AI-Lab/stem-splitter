import type { Env } from '../env.ts';
import type { AppPrincipal } from '../identity.ts';
import { authorizeStoredCourseWork, jobPermission } from '../classroom/access.ts';
import { normalizeIsolationTarget } from './contract.ts';
import { validateQueryIsolationBudgetPolicy, type QueryIsolationBudgetPolicyV1 } from './budget.ts';
import { audioSepReplicateIdentity } from './options.ts';
import type { QueryIsolationProvider, QueryIsolationSourceType } from './types.ts';
import { createInstrumentIsolation, claimInstrumentIsolation, attachInstrumentIsolationExternalId,
  getInstrumentIsolation, listInstrumentIsolations, failInstrumentIsolation,
  InstrumentIsolationResourceError, type InstrumentIsolationRecordV1 } from './resource.ts';
import { prepareQueryIsolationSpendSource, discardQueryIsolationSpendSource } from './source.ts';
import { ingestQueryIsolationProviderResult } from './terminal.ts';
import { getInstrumentIsolationOutputs } from './ingestion.ts';

export class InstrumentTargetError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 503, readonly code: string, message: string) { super(message); }
}

/** Constructed only by a trusted adapter after model/budget review. Not an env
 * variable or browser option; production adapters currently do not construct it. */
export class InstrumentTargetSession {
  readonly enabled: boolean;
  constructor(private readonly env: Env, private readonly options: {
    enabled: boolean;
    provider: QueryIsolationProvider;
    budget: QueryIsolationBudgetPolicyV1;
    /** Required trusted sponsor decision, not a client flag. The existing ledger
     * remains teacher-beta/course-semester scoped; personal funding needs its
     * own explicitly reviewed policy rather than a made-up course id. */
    authorizeSponsor: (input: { subject: string; jobId: string; budget: QueryIsolationBudgetPolicyV1 }) => Promise<boolean>;
    outputFetch?: typeof fetch;
  }) {
    this.enabled = options.enabled === true;
    if (this.enabled) {
      validateQueryIsolationBudgetPolicy(options.budget);
      if (typeof options.authorizeSponsor !== 'function') throw new Error('Instrument extraction requires a trusted sponsor authorization');
      const reviewed = audioSepReplicateIdentity(env);
      if (['provider', 'model', 'version', 'contractVersion'].some(key =>
        options.provider.identity[key as keyof typeof reviewed] !== reviewed[key as keyof typeof reviewed]))
        throw new Error('Instrument extraction requires the reviewed AudioSep provider');
      const base = new URL(env.PUBLIC_BASE_URL);
      if (base.protocol !== 'https:' || base.username || base.password || !env.WEBHOOK_SECRET)
        throw new Error('Instrument extraction requires configured HTTPS callback delivery');
    }
  }

  private async authorize(jobId: string, actor: AppPrincipal) {
    if (!this.enabled) throw new InstrumentTargetError(404, 'unavailable', 'Instrument extraction is unavailable.');
    if (this.env.AUTH_MODE !== 'cail' || actor.quotaClass === 'guest')
      throw new InstrumentTargetError(403, 'sign_in_required', 'Sign in to request an instrument.');
    const permission = await jobPermission(this.env, actor, jobId);
    if (!permission?.owner)
      throw new InstrumentTargetError(404, 'not_found', 'Recording not found.');
    await authorizeStoredCourseWork(this.env, actor.subject, permission.courseId);
    const job = await this.env.DB.prepare('SELECT source_key,source_hash,source_type,status FROM jobs WHERE id=?')
      .bind(jobId).first<{ source_key: string; source_hash: string; source_type: QueryIsolationSourceType; status: string }>();
    if (!job || job.status !== 'done' || !/^[a-f0-9]{64}$/.test(job.source_hash || '') ||
        !['upload', 'youtube', 'archive'].includes(job.source_type))
      throw new InstrumentTargetError(409, 'source_unavailable', 'A finished recording with a verified source is required.');
    return job;
  }

  private view(record: InstrumentIsolationRecordV1) {
    return { id: record.id, target: record.normalizedTarget, status: record.status,
      needsConfirmation: record.status === 'processing' && !record.externalId,
      outputAvailable: record.status === 'succeeded' && !!record.targetKey,
      failure: record.failure ? { code: record.failure.code } : null,
      model: record.identity.model, version: record.identity.version,
      limitations: ['Requested target, not a detected instrument.',
        'Experimental extraction may contain other instruments and overlap the original splits.'] };
  }

  async list(jobId: string, actor: AppPrincipal) {
    await this.authorize(jobId, actor);
    return { targets: (await listInstrumentIsolations(this.env, jobId)).map(record => this.view(record)), maximumTargets: 2 };
  }

  async request(jobId: string, target: string, actor: AppPrincipal) {
    const job = await this.authorize(jobId, actor);
    if (!await this.options.authorizeSponsor({ subject: actor.subject, jobId, budget: this.options.budget }))
      throw new InstrumentTargetError(403, 'sponsor_required', 'This recording has no approved instrument-extraction funding scope.');
    let normalizedTarget: string;
    try { normalizedTarget = normalizeIsolationTarget(target); }
    catch { throw new InstrumentTargetError(400, 'invalid_target', 'Enter a short instrument or sound name.'); }
    const { record: created } = await createInstrumentIsolation(this.env, {
      jobId, requestedBy: actor.subject, sourceHash: job.source_hash, sourceType: job.source_type,
      normalizedTarget, analysisVocabularyVersion: null, identity: this.options.provider.identity, rolloutStage: 'teacher_beta',
    });
    if (created.status !== 'queued') return this.view(created);
    let claimed: InstrumentIsolationRecordV1;
    try { claimed = await claimInstrumentIsolation(this.env, created.id, { budget: this.options.budget }); }
    catch (error) {
      const current = await getInstrumentIsolation(this.env, created.id);
      if (current && current.status !== 'queued') return this.view(current);
      if (error instanceof InstrumentIsolationResourceError && error.code === 'budget_exhausted')
        throw new InstrumentTargetError(409, 'budget_exhausted', 'The instrument-extraction allowance is used up.');
      throw new InstrumentTargetError(409, 'busy', 'Another extraction is active. Refresh its status first.');
    }
    let source: Awaited<ReturnType<typeof prepareQueryIsolationSpendSource>> | undefined;
    try {
      source = await prepareQueryIsolationSpendSource(this.env, {
        isolationId: claimed.id, sourceKey: job.source_key, expectedSourceHash: job.source_hash,
      });
      await this.authorize(jobId, actor);
      if (!await this.options.authorizeSponsor({ subject: actor.subject, jobId, budget: this.options.budget }))
        throw new Error('Extraction sponsor changed');
      const current = await getInstrumentIsolation(this.env, claimed.id);
      if (!current || current.status !== 'processing' || !current.deadlineAt || Date.parse(current.deadlineAt) <= Date.now())
        throw new Error('Extraction authority changed');
    } catch {
      if (source) await discardQueryIsolationSpendSource(this.env, source.snapshotKey).catch(() => undefined);
      await failInstrumentIsolation(this.env, claimed.id, { code: 'provider_failed', retryable: false });
      throw new InstrumentTargetError(409, 'source_changed', 'The verified source is no longer available. No provider request was sent.');
    }
    const webhook = new URL('/api/webhooks/separation', this.env.PUBLIC_BASE_URL);
    webhook.searchParams.set('isolation', claimed.id);
    webhook.searchParams.set('token', this.env.WEBHOOK_SECRET);
    // Once start() is called, failure is uncertain. Never requeue, spend again,
    // discard the source snapshot, or report a confirmed rejection from a lost response.
    try {
      const started = await this.options.provider.start({ schemaVersion: '1', isolationId: claimed.id,
        sourceUrl: source.sourceUrl, sourceHash: claimed.sourceHash, sourceType: claimed.sourceType,
        normalizedTarget: claimed.normalizedTarget, analysisVocabularyVersion: null, webhookUrl: webhook.href });
      const identity = this.options.provider.identity;
      if (['provider', 'model', 'version', 'contractVersion'].some(key =>
        started.identity[key as keyof typeof identity] !== identity[key as keyof typeof identity])) throw new Error('Provider identity changed');
      await attachInstrumentIsolationExternalId(this.env, claimed.id, started.externalId);
    } catch { /* Stored processing-without-id is deliberately not retryable. */ }
    return this.view((await getInstrumentIsolation(this.env, claimed.id))!);
  }

  /** Trusted webhook entry: only reconcile an already recorded provider id.
   * Callback bodies never choose URLs, targets, provider ids, or another start. */
  async reconcile(id: string) {
    if (!this.enabled) throw new InstrumentTargetError(404, 'unavailable', 'Instrument extraction is unavailable.');
    const record = await getInstrumentIsolation(this.env, id);
    if (!record) throw new InstrumentTargetError(404, 'not_found', 'Extraction not found.');
    if (record.status !== 'processing' || !record.externalId) return this.view(record);
    try {
      const result = await this.options.provider.fetchStatus(record.externalId);
      const settled = await ingestQueryIsolationProviderResult(this.env, id, record.externalId, result,
        { fetchImpl: this.options.outputFetch });
      return this.view(settled.record);
    } catch {
      throw new InstrumentTargetError(503, 'status_unavailable', 'Status could not be confirmed. Refresh later; no new extraction was started.');
    }
  }

  async refresh(jobId: string, id: string, actor: AppPrincipal) {
    await this.authorize(jobId, actor);
    const record = await getInstrumentIsolation(this.env, id);
    if (!record || record.jobId !== jobId) throw new InstrumentTargetError(404, 'not_found', 'Extraction not found.');
    return this.reconcile(id);
  }

  async audio(jobId: string, id: string, actor: AppPrincipal) {
    await this.authorize(jobId, actor);
    const record = await getInstrumentIsolation(this.env, id);
    if (!record || record.jobId !== jobId || record.status !== 'succeeded')
      throw new InstrumentTargetError(404, 'not_found', 'Audio not found.');
    const output = (await getInstrumentIsolationOutputs(this.env, id)).find(row => row.kind === 'target');
    if (!output || Date.parse(output.retainedUntil) <= Date.now())
      throw new InstrumentTargetError(404, 'not_found', 'Audio has expired.');
    const object = await this.env.AUDIO.get(output.storageKey);
    if (!object) throw new InstrumentTargetError(404, 'not_found', 'Audio not found.');
    return new Response(object.body, { headers: { 'Content-Type': 'audio/wav',
      'Content-Length': String(output.bytes), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
}
