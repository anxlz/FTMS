import { type NextRequest } from 'next/server';
import { redirect } from 'next/navigation';
import { apiDownload } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { safeNext } from '@/lib/safe-next';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const FILTERS = ['format', 'visit', 'from', 'to', 'group', 'student', 'status', 'locale'];

/**
 * Attendance report download (§10.4, §19). The API applies the caller's
 * permissions and filters; this handler only relays the file. On a refusal the
 * visitor returns to the page they came from, with the reason.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const token = await accessToken();
  if (!token) redirect('/login');
  const incoming = request.nextUrl.searchParams;
  const query = new URLSearchParams();
  for (const key of FILTERS) {
    const value = incoming.get(key)?.trim();
    if (value) query.set(key, value);
  }
  const res = await apiDownload(`/attendance/export?${query.toString()}`, token, 60_000);
  if (res?.ok && res.body) {
    return new Response(res.body, {
      status: 200,
      headers: {
        'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
        'content-disposition':
          res.headers.get('content-disposition') ?? 'attachment; filename="ftms-attendance"',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  const body = (await res?.json().catch(() => null)) as { code?: unknown } | null;
  const code =
    typeof body?.code === 'string' && /^[A-Z_]+$/.test(body.code) ? body.code : 'NETWORK';
  const back = safeNext(incoming.get('back')) ?? '/attendance';
  redirect(`${back}${back.includes('?') ? '&' : '?'}exportError=${code}`);
}
