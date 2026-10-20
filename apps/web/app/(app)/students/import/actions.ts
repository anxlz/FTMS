'use server';

import { IMPORT_MAX_FILE_BYTES, type ImportPreview } from '@ftms/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, apiUpload } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { failure, field, type FormState } from '@/lib/forms';

/** Uploads the spreadsheet; the API validates it and returns a preview (nothing is written). */
export async function uploadImportAction(_: FormState, data: FormData): Promise<FormState> {
  const file = data.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { status: 'error', error: 'FILE_INVALID', fieldErrors: { file: ['FILE_REQUIRED'] } };
  }
  if (file.size > IMPORT_MAX_FILE_BYTES) {
    return { status: 'error', error: 'FILE_TOO_LARGE', fieldErrors: { file: ['FILE_TOO_LARGE'] } };
  }
  const form = new FormData();
  form.append('file', file, file.name);
  const result = await apiUpload<ImportPreview>('/student-imports', form, await accessToken());
  if (!result.ok) return failure(result);
  redirect(`/students/import/${result.data.id}`);
}

export async function commitImportAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch<ImportPreview>(
    `/student-imports/${encodeURIComponent(id)}/commit`,
    {
      method: 'POST',
      accessToken: await accessToken(),
      timeoutMs: 120_000,
      body: {
        planDigest: field(data, 'planDigest'),
        applyUpdates: field(data, 'applyUpdates') === 'true',
        skipInvalidRows: field(data, 'skipInvalidRows') === 'true',
      },
    },
  );
  revalidatePath(`/students/import/${id}`);
  if (!result.ok) return failure(result);
  return { status: 'success' };
}

export async function discardImportAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch<void>(`/student-imports/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    accessToken: await accessToken(),
  });
  if (!result.ok) return failure(result);
  redirect('/students/import');
}
