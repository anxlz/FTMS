import { type SupabaseClient } from '@supabase/supabase-js';
import { type BucketDefinition } from './buckets';

/** The subset of the Supabase Storage client needed to manage buckets. */
export type BucketAdminClient = Pick<
  SupabaseClient['storage'],
  'listBuckets' | 'createBucket' | 'updateBucket'
>;

export type ProvisionAction = 'created' | 'updated';

export interface ProvisionResult {
  readonly id: string;
  readonly action: ProvisionAction;
}

export interface BucketVerification {
  /** Expected buckets that do not exist. */
  readonly missing: string[];
  /** Expected buckets that exist but are public — a privacy violation. */
  readonly public: string[];
}

async function listBucketIndex(client: Pick<BucketAdminClient, 'listBuckets'>) {
  const { data, error } = await client.listBuckets();
  if (error) throw new Error(`Could not list storage buckets: ${error.message}`);
  return new Map(data.map((bucket) => [bucket.id, bucket]));
}

/**
 * Idempotently ensures every bucket exists, is private, and carries the configured
 * limits. Existing buckets are updated in place (never deleted), so running this
 * repeatedly — or against a bucket someone flipped to public — converges on the
 * definitions in `buckets.ts`.
 */
export async function provisionBuckets(
  client: BucketAdminClient,
  definitions: readonly BucketDefinition[],
): Promise<ProvisionResult[]> {
  const existing = await listBucketIndex(client);
  const results: ProvisionResult[] = [];

  for (const def of definitions) {
    const options = {
      public: false,
      fileSizeLimit: def.fileSizeLimitBytes,
      allowedMimeTypes: [...def.allowedMimeTypes],
    };
    const { error } = existing.has(def.id)
      ? await client.updateBucket(def.id, options)
      : await client.createBucket(def.id, options);
    if (error) throw new Error(`Could not provision bucket "${def.id}": ${error.message}`);
    results.push({ id: def.id, action: existing.has(def.id) ? 'updated' : 'created' });
  }

  return results;
}

/** Read-only check used by the readiness probe. */
export async function verifyBuckets(
  client: Pick<BucketAdminClient, 'listBuckets'>,
  definitions: readonly BucketDefinition[],
): Promise<BucketVerification> {
  const existing = await listBucketIndex(client);
  return {
    missing: definitions.filter((d) => !existing.has(d.id)).map((d) => d.id),
    public: definitions.filter((d) => existing.get(d.id)?.public === true).map((d) => d.id),
  };
}
