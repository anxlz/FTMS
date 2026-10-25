import { type NextRequest } from 'next/server';
import { redirect } from 'next/navigation';
import { apiDownload } from '@/lib/api';
import { AUDIT_FILTER_KEYS } from '@/lib/audit';
import { accessToken } from '@/lib/auth/session';
import { safeNext } from '@/lib/safe-next';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Each report: its API path and the parameters passed through (nothing else). */
const REPORTS: Record<string, { path: string; keys: readonly string[] }> = {
  audit: { path: '/audit-logs/export', keys: ['format', 'locale', ...AUDIT_FILTER_KEYS] },
  'attendance-summary': {
    path: '/reports/attendance-summary/export',
    keys: ['format', 'locale', 'group', 'q', 'standing'],
  },
  'faculty-activity': {
    path: '/reports/faculty-activity/export',
    keys: ['format', 'locale', 'from', 'to'],
  },
};

/**
 * Report downloads (§15, §19). The API checks the caller's permissions and
 * records the export; this handler only relays the file. On a refusal the
 * visitor returns to the page they came from, with the reason.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const token = await accessToken();
  if (!token) redirect('/login');
  const incoming = request.nextUrl.searchParams;
  const back = safeNext(incoming.get('back')) ?? '/reports';
  const report = REPORTS[incoming.get('report') ?? ''];
  if (!report) redirect(`${back}${back.includes('?') ? '&' : '?'}exportError=VALIDATION_FAILED`);
  const query = new URLSearchParams();
  for (const key of report.keys) {
    const value = incoming.get(key)?.trim();
    if (value) query.set(key, value);
  }
  const res = await apiDownload(`${report.path}?${query.toString()}`, token, 60_000);
  if (res?.ok && res.body) {
    return new Response(res.body, {
      status: 200,
      headers: {
        'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
        'content-disposition':
          res.headers.get('content-disposition') ?? 'attachment; filename="ftms-report"',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  const body = (await res?.json().catch(() => null)) as { code?: unknown } | null;
  const code =
    typeof body?.code === 'string' && /^[A-Z_]+$/.test(body.code) ? body.code : 'NETWORK';
  redirect(`${back}${back.includes('?') ? '&' : '?'}exportError=${code}`);
}
