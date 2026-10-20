import { apiDownload } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * The downloadable example spreadsheet (§4.1). The browser never calls the API:
 * this handler fetches the file with the session's token and streams it back.
 */
export async function GET(): Promise<Response> {
  const res = await apiDownload('/student-imports/template', await accessToken());
  if (!res?.ok || !res.body) {
    return new Response(null, {
      status: res?.status === 403 ? 403 : res?.status === 401 ? 401 : 502,
    });
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      'content-type':
        res.headers.get('content-type') ??
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition':
        res.headers.get('content-disposition') ??
        'attachment; filename="ftms-students-template.xlsx"',
      'cache-control': 'no-store',
    },
  });
}
