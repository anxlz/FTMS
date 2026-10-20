import { Injectable } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ServiceNotConfiguredError } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';
import { ALL_BUCKETS, type BucketId } from './buckets';
import { assertSafeObjectPath } from './object-path';
import { verifyBuckets, type BucketVerification } from './provision';

/** Upper bound for signed URL lifetimes; callers pick shorter values per use case. */
export const MAX_SIGNED_URL_SECONDS = 60 * 60;

/**
 * Server-side access to Supabase Storage using the service role key. Every bucket
 * is private, so nothing here is reachable by a browser without a signed URL that
 * the API chose to issue. Authorization happens in the calling feature service.
 */
@Injectable()
export class StorageService {
  private readonly client: SupabaseClient | null;

  constructor(config: AppConfigService) {
    const url = config.get('SUPABASE_URL');
    const key = config.get('SUPABASE_SERVICE_ROLE_KEY');
    this.client =
      url && key
        ? createClient(url, key, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          })
        : null;
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  private get storage(): SupabaseClient['storage'] {
    if (!this.client) throw new ServiceNotConfiguredError('Supabase Storage');
    return this.client.storage;
  }

  async upload(
    bucket: BucketId,
    path: string,
    body: Buffer | Blob,
    contentType: string,
  ): Promise<string> {
    const { data, error } = await this.storage
      .from(bucket)
      .upload(assertSafeObjectPath(path), body, { contentType, upsert: false });
    if (error) throw new Error(`Upload to "${bucket}" failed: ${error.message}`);
    return data.path;
  }

  /** `download`: file name to save as (sets Content-Disposition: attachment). */
  async createSignedUrl(
    bucket: BucketId,
    path: string,
    expiresInSeconds: number,
    download?: string,
  ): Promise<string> {
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1) {
      throw new RangeError('expiresInSeconds must be a positive integer');
    }
    const ttl = Math.min(expiresInSeconds, MAX_SIGNED_URL_SECONDS);
    const { data, error } = await this.storage
      .from(bucket)
      .createSignedUrl(assertSafeObjectPath(path), ttl, download ? { download } : undefined);
    if (error) throw new Error(`Signing "${bucket}/${path}" failed: ${error.message}`);
    return data.signedUrl;
  }

  async remove(bucket: BucketId, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const { error } = await this.storage.from(bucket).remove(paths.map(assertSafeObjectPath));
    if (error) throw new Error(`Removing objects from "${bucket}" failed: ${error.message}`);
  }

  /** Confirms all FTMS buckets exist and none is public. */
  verifyBuckets(): Promise<BucketVerification> {
    return verifyBuckets(this.storage, ALL_BUCKETS);
  }
}
