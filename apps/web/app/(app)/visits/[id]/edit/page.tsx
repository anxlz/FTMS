import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { type Group, type ProgramState, type VisitDetail } from '@ftms/core';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { VisitForm } from '../../visit-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('visits'))('edit') };
}

export default async function EditVisitPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission('visits.manage');
  const { id } = await params;
  const t = await getTranslations('visits');
  const token = await accessToken();
  const [visit, program, groups] = await Promise.all([
    apiFetch<VisitDetail>(`/visits/${encodeURIComponent(id)}`, { accessToken: token }),
    apiFetch<ProgramState>('/program', { accessToken: token }),
    apiFetch<Group[]>('/groups', { accessToken: token }),
  ]);
  if (!visit.ok) notFound();
  const v = visit.data;

  return (
    <div className="stack-lg">
      <p>
        <Link href={`/visits/${v.id}`}>← {v.title}</Link>
      </p>
      <h1>{t('edit')}</h1>
      {v.status === 'CANCELLED' ? (
        <p className="alert alert-info">{t('editCancelled')}</p>
      ) : (
        <section className="card">
          <VisitForm
            visit={v}
            groups={groups.ok ? groups.data.map((g) => ({ id: g.id, name: g.name })) : []}
            defaults={program.ok && program.data.program ? program.data.program.timing : v.timing}
            canOverrideTiming={user.permissions.includes('attendance.settings.visit')}
          />
        </section>
      )}
    </div>
  );
}
