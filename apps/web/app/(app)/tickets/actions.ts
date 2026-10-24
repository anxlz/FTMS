'use server';

import {
  TICKET_FILE_MAX_BYTES,
  TICKET_FILE_TYPES,
  TICKET_FILES_PER_POST,
  type GroupSwapView,
  type TicketDetail,
} from '@ftms/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, apiUpload } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { echo, failure, field, type FormState, optional } from '@/lib/forms';

/** Files chosen in a form; an empty file input still submits one empty entry. */
const filesOf = (data: FormData): File[] =>
  data.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);

/**
 * Checked here as well as by the API: the web server forwards the files, so
 * the whole post must stay under the hosting request limit.
 */
function fileProblem(files: File[]): FormState | null {
  const bad = (code: string): FormState => ({
    status: 'error',
    error: code,
    fieldErrors: { files: [code] },
  });
  if (files.length > TICKET_FILES_PER_POST) return bad('TOO_MANY_FILES');
  // The API checks the content itself; a browser may not know the type.
  if (files.some((f) => f.type && !TICKET_FILE_TYPES.includes(f.type))) {
    return bad('FILE_TYPE_NOT_ALLOWED');
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > TICKET_FILE_MAX_BYTES) return bad('FILE_TOO_LARGE');
  return null;
}

const TICKET_FIELDS = ['category', 'subject', 'description'];
const SWAP_FIELDS = [
  'category',
  'targetGroupId',
  'counterpartSeatNumber',
  'counterpartName',
  'note',
];

/**
 * The student's request form (§13.1). A group swap goes to its own workflow
 * (§14); complaints and suggestions are tickets with optional files.
 */
export async function submitRequestAction(_: FormState, data: FormData): Promise<FormState> {
  const token = await accessToken();
  if (field(data, 'category') === 'GROUP_SWAP') {
    const result = await apiFetch<GroupSwapView>('/group-swaps', {
      method: 'POST',
      accessToken: token,
      body: {
        targetGroupId: field(data, 'targetGroupId'),
        counterpartSeatNumber: field(data, 'counterpartSeatNumber'),
        counterpartName: optional(data, 'counterpartName'),
        note: optional(data, 'note'),
      },
    });
    if (!result.ok) return failure(result, echo(data, SWAP_FIELDS));
    revalidatePath('/tickets');
    redirect(`/group-swaps/${result.data.id}?notice=requested`);
  }

  const files = filesOf(data);
  const problem = fileProblem(files);
  if (problem) return { ...problem, values: echo(data, TICKET_FIELDS) };
  const form = new FormData();
  for (const name of TICKET_FIELDS) form.append(name, field(data, name));
  for (const file of files) form.append('files', file, file.name);
  const result = await apiUpload<TicketDetail>('/tickets', form, token);
  if (!result.ok) return failure(result, echo(data, TICKET_FIELDS));
  revalidatePath('/tickets');
  redirect(`/tickets/${result.data.id}?notice=created`);
}

/** A reply on a ticket; staff may mark it as an internal note (§13.4). */
export async function replyAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const files = filesOf(data);
  const problem = fileProblem(files);
  if (problem) return { ...problem, values: echo(data, ['body', 'internal']) };
  const form = new FormData();
  form.append('body', field(data, 'body'));
  if (field(data, 'internal') === 'true') form.append('internal', 'true');
  for (const file of files) form.append('files', file, file.name);
  const result = await apiUpload<TicketDetail>(
    `/tickets/${encodeURIComponent(id)}/messages`,
    form,
    await accessToken(),
  );
  if (!result.ok) return failure(result, echo(data, ['body', 'internal']));
  revalidatePath(`/tickets/${id}`);
  return { status: 'success' };
}

export async function setTicketStatusAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch<TicketDetail>(`/tickets/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    accessToken: await accessToken(),
    body: { status: field(data, 'status'), note: optional(data, 'note') },
  });
  if (!result.ok) return failure(result, echo(data, ['status', 'note']));
  revalidatePath(`/tickets/${id}`);
  return { status: 'success' };
}
