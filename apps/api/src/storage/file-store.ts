import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { deriveKey, hmacSha256Hex, safeEqual } from '../common/crypto';
import { AppConfigService } from '../config/app-config.service';
import { type BucketId } from './buckets';
import { assertSafeObjectPath } from './object-path';
import { StorageService } from './storage.service';

/** Signed links to private files live this long (§16.3). */
export const FILE_LINK_SECONDS = 10 * 60;

export interface LocalFile {
  body: Buffer;
  contentType: string;
  /** Set for downloads (Content-Disposition: attachment). */
  download: string | null;
}

interface LocalToken {
  b: BucketId;
  p: string;
  t: string;
  d: string | null;
  e: number;
}

/**
 * Private file storage for features (§16.3). In production it is Supabase
 * Storage (private buckets, signed URLs). Outside production, when Supabase is
 * not configured, files are kept on local disk and served through HMAC-signed,
 * expiring links (`GET /local-files/:token`, proxied by the web app), so
 * development and the test suites exercise the same authorization paths
 * without cloud credentials. Production never uses the local driver.
 */
@Injectable()
export class FileStore {
  private readonly logger = new Logger(FileStore.name);
  private readonly localRoot: string | null;
  private readonly localKey: Buffer;

  constructor(
    private readonly storage: StorageService,
    config: AppConfigService,
  ) {
    this.localRoot =
      !storage.isConfigured && !config.isProduction
        ? path.join(tmpdir(), 'ftms-local-storage', config.get('NODE_ENV'))
        : null;
    this.localKey = deriveKey(config.get('JWT_ACCESS_SECRET'), 'local-file-links');
  }

  get driver(): 'supabase' | 'local' | null {
    if (this.storage.isConfigured) return 'supabase';
    return this.localRoot ? 'local' : null;
  }

  private localPath(bucket: BucketId, objectPath: string): string {
    if (!this.localRoot) throw new Error('Local file storage is not enabled');
    return path.join(this.localRoot, bucket, ...assertSafeObjectPath(objectPath).split('/'));
  }

  async put(
    bucket: BucketId,
    objectPath: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    if (this.driver === 'supabase') {
      await this.storage.upload(bucket, objectPath, body, contentType);
      return;
    }
    const file = this.localPath(bucket, objectPath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, { flag: 'wx' });
  }

  /** A short-lived link; `download` makes browsers save the file under that name. */
  async link(
    bucket: BucketId,
    objectPath: string,
    contentType: string,
    download: string | null,
  ): Promise<string> {
    if (this.driver === 'supabase') {
      return this.storage.createSignedUrl(
        bucket,
        objectPath,
        FILE_LINK_SECONDS,
        download ?? undefined,
      );
    }
    const token: LocalToken = {
      b: bucket,
      p: assertSafeObjectPath(objectPath),
      t: contentType,
      d: download,
      e: Math.floor(Date.now() / 1000) + FILE_LINK_SECONDS,
    };
    const payload = Buffer.from(JSON.stringify(token), 'utf8').toString('base64url');
    return `/files/${payload}.${hmacSha256Hex(this.localKey, payload)}`;
  }

  /** Best effort: a missing object is not an error. */
  async remove(bucket: BucketId, objectPaths: string[]): Promise<void> {
    if (objectPaths.length === 0) return;
    if (this.driver === 'supabase') {
      await this.storage.remove(bucket, objectPaths);
      return;
    }
    if (!this.localRoot) return;
    await Promise.all(objectPaths.map((p) => rm(this.localPath(bucket, p), { force: true })));
  }

  /** Resolves a local link token; null when it is forged, expired or the file is gone. */
  async readLocal(token: string, now = Date.now()): Promise<LocalFile | null> {
    if (this.driver !== 'local') return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature || !safeEqual(signature, hmacSha256Hex(this.localKey, payload))) {
      return null;
    }
    let parsed: LocalToken;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LocalToken;
    } catch {
      return null;
    }
    if (typeof parsed.e !== 'number' || parsed.e * 1000 < now) return null;
    try {
      const body = await readFile(this.localPath(parsed.b, parsed.p));
      return { body, contentType: parsed.t, download: parsed.d };
    } catch (error) {
      this.logger.warn(`Local file unavailable: ${(error as Error).message}`);
      return null;
    }
  }
}
