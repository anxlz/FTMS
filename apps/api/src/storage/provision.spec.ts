import { ALL_BUCKETS, STORAGE_BUCKETS, type BucketDefinition } from './buckets';
import { provisionBuckets, verifyBuckets, type BucketAdminClient } from './provision';

type Stored = { id: string; public: boolean; fileSizeLimit?: unknown; allowedMimeTypes?: unknown };

/** In-memory stand-in for the Supabase Storage bucket API, mirroring its result shape. */
function fakeStorage(initial: Stored[] = [], failOn?: string) {
  const buckets = new Map(initial.map((b) => [b.id, { ...b }]));
  const calls: string[] = [];
  const err = (message: string) => ({ data: null, error: { message } });

  const client = {
    listBuckets: () => {
      calls.push('list');
      return Promise.resolve({
        data: [...buckets.values()].map((b) => ({ ...b, name: b.id })),
        error: null,
      });
    },
    createBucket: (id: string, options: Omit<Stored, 'id'>) => {
      calls.push(`create:${id}`);
      if (id === failOn) return Promise.resolve(err('quota exceeded'));
      buckets.set(id, { id, ...options });
      return Promise.resolve({ data: { name: id }, error: null });
    },
    updateBucket: (id: string, options: Omit<Stored, 'id'>) => {
      calls.push(`update:${id}`);
      buckets.set(id, { id, ...options });
      return Promise.resolve({ data: { message: 'ok' }, error: null });
    },
  } as unknown as BucketAdminClient;

  return { client, buckets, calls };
}

describe('bucket definitions', () => {
  it('defines four uniquely named buckets with sane limits', () => {
    const ids = ALL_BUCKETS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'visit-media',
      'visit-documents',
      'student-imports',
      'ticket-attachments',
    ]);
    for (const bucket of ALL_BUCKETS) {
      expect(bucket.fileSizeLimitBytes).toBeGreaterThan(0);
      expect(bucket.allowedMimeTypes.length).toBeGreaterThan(0);
    }
  });
});

describe('provisionBuckets', () => {
  it('creates every missing bucket as private with its limits', async () => {
    const { client, buckets } = fakeStorage();
    const results = await provisionBuckets(client, ALL_BUCKETS);

    expect(results.map((r) => r.action)).toEqual(['created', 'created', 'created', 'created']);
    const media = buckets.get(STORAGE_BUCKETS.visitMedia.id);
    expect(media).toEqual({
      id: 'visit-media',
      public: false,
      fileSizeLimit: STORAGE_BUCKETS.visitMedia.fileSizeLimitBytes,
      allowedMimeTypes: [...STORAGE_BUCKETS.visitMedia.allowedMimeTypes],
    });
  });

  it('is idempotent: a second run updates instead of re-creating', async () => {
    const { client, calls } = fakeStorage();
    await provisionBuckets(client, ALL_BUCKETS);
    calls.length = 0;
    const second = await provisionBuckets(client, ALL_BUCKETS);

    expect(second.every((r) => r.action === 'updated')).toBe(true);
    expect(calls.filter((c) => c.startsWith('create:'))).toEqual([]);
  });

  it('forces an existing public bucket back to private', async () => {
    const { client, buckets } = fakeStorage([{ id: 'visit-media', public: true }]);
    await provisionBuckets(client, ALL_BUCKETS);
    expect(buckets.get('visit-media')?.public).toBe(false);
  });

  it('surfaces provider errors with the bucket name', async () => {
    const { client } = fakeStorage([], 'student-imports');
    await expect(provisionBuckets(client, ALL_BUCKETS)).rejects.toThrow(
      'Could not provision bucket "student-imports": quota exceeded',
    );
  });
});

describe('verifyBuckets', () => {
  const defs: BucketDefinition[] = [STORAGE_BUCKETS.visitMedia, STORAGE_BUCKETS.visitDocuments];

  it('reports missing and public buckets', async () => {
    const { client } = fakeStorage([{ id: 'visit-media', public: true }]);
    await expect(verifyBuckets(client, defs)).resolves.toEqual({
      missing: ['visit-documents'],
      public: ['visit-media'],
    });
  });

  it('passes when all buckets exist and are private', async () => {
    const { client } = fakeStorage([
      { id: 'visit-media', public: false },
      { id: 'visit-documents', public: false },
    ]);
    await expect(verifyBuckets(client, defs)).resolves.toEqual({ missing: [], public: [] });
  });
});
