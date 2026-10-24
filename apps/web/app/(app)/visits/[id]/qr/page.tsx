import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { type VisitDetail, type VisitQrCodes } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { timeRange } from '@/components/month-calendar';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { dayValue } from '@/lib/calendar';
import { PrintButton } from './print-button';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('qr'))('title') };
}

/**
 * Printable QR codes of a visit (§7): the details code and the stable,
 * signed attendance code. The same printed sheet works for the whole visit;
 * neither code carries personal data or grants attendance by itself.
 */
export default async function VisitQrPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('visits.manage', 'attendance.read');
  const { id } = await params;
  const token = await accessToken();
  const [visitRes, codesRes] = await Promise.all([
    apiFetch<VisitDetail>(`/visits/${encodeURIComponent(id)}`, { accessToken: token }),
    apiFetch<VisitQrCodes>(`/visits/${encodeURIComponent(id)}/qr`, { accessToken: token }),
  ]);
  if (!visitRes.ok || !codesRes.ok) notFound();
  const v = visitRes.data;
  const codes = codesRes.data;
  const t = await getTranslations('qr');
  const format = await getFormatter();

  return (
    <div className="stack-lg">
      <p className="no-print">
        <Link href={`/visits/${v.id}`}>← {t('back')}</Link>
      </p>
      <div className="row-between no-print">
        <h1>{t('title')}</h1>
        <PrintButton />
      </div>
      {v.status === 'CANCELLED' && <p className="alert alert-error">{t('cancelled')}</p>}
      <p className="muted no-print">{t('intro')}</p>

      <div className="qr-sheet">
        <header className="qr-heading">
          <h2>{v.title}</h2>
          <p>
            {format.dateTime(dayValue(v.date), { dateStyle: 'full' })} ·{' '}
            <span dir="ltr">{timeRange(v)}</span>
            {v.locationName ? ` · ${v.locationName}` : ''}
          </p>
        </header>
        <div className="qr-grid">
          <figure className="qr-card qr-attendance">
            {/* eslint-disable-next-line @next/next/no-img-element -- generated data URI */}
            <img src={codes.attendance.svg} alt={t('attendanceAlt', { title: v.title })} />
            <figcaption>
              <strong>{t('attendanceTitle')}</strong>
              <span>{t('attendanceCaption')}</span>
            </figcaption>
          </figure>
          <figure className="qr-card">
            {/* eslint-disable-next-line @next/next/no-img-element -- generated data URI */}
            <img src={codes.details.svg} alt={t('detailsAlt', { title: v.title })} />
            <figcaption>
              <strong>{t('detailsTitle')}</strong>
              <span>{t('detailsCaption')}</span>
              <span className="small" dir="ltr">
                {codes.details.url}
              </span>
            </figcaption>
          </figure>
        </div>
        <p className="small qr-note">{t('note')}</p>
      </div>
    </div>
  );
}
