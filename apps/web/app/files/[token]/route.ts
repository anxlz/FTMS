import { apiDownload } from '@/lib/api';

export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_-]{1,2048}\.[0-9a-f]{64}$/;

/**
 * Files of the API's local storage driver (development and tests only; in
 * production visit files are served by Supabase signed URLs). The signed,
 * expiring token issued by the API after its access check is the authorization,
 * exactly like a Supabase signed URL. The browser never calls the API directly.
 */
export async function GET(_: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!TOKEN.test(token)) return new Response(null, { status: 404 });
  const res = await apiDownload(`/local-files/${token}`, null);
  if (!res?.ok || !res.body) return new Response(null, { status: res?.status === 404 ? 404 : 502 });
  const headers = new Headers({
    'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
    'cache-control': 'private, max-age=600',
    'x-content-type-options': 'nosniff',
  });
  const disposition = res.headers.get('content-disposition');
  if (disposition) headers.set('content-disposition', disposition);
  return new Response(res.body, { status: 200, headers });
}
