import type { Metadata } from 'next';
import Link from 'next/link';
import { type Group, type ProgramState } from '@ftms/core';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { VisitForm } from '../visit-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('visits'))('new') };
}

export default async function NewVisitPage() {
  const user = await requirePermission('visits.manage');
  const t = await getTranslations('visits');
  const token = await accessToken();
  const [program, groups] = await Promise.all([
    apiFetch<ProgramState>('/program', { accessToken: token }),
    apiFetch<Group[]>('/groups', { accessToken: token }),
  ]);

  return (
    <div className="stack-lg">
      <p>
        <Link href="/visits">← {t('back')}</Link>
      </p>
      <h1>{t('new')}</h1>
      {program.ok && program.data.program && groups.ok ? (
        <section className="card">
          <VisitForm
            groups={groups.data.map((g) => ({ id: g.id, name: g.name }))}
            defaults={program.data.program.timing}
            canOverrideTiming={user.permissions.includes('attendance.settings.visit')}
          />
        </section>
      ) : (
        <p className="alert alert-info">{t('programMissing')}</p>
      )}
    </div>
  );
}
