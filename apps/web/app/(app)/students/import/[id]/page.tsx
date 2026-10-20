import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { IMPORT_ROW_ACTIONS, type ImportPreview, type ImportRowAction } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { CommitForm } from '../import-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('imports'))('title') };
}

/** Rows shown per view; the counts above always cover the whole file. */
const SHOWN = 300;

/**
 * Import preview (§4.1.3–4): what committing would do to every row, re-planned
 * against the live data on each visit. Errors and changes come first.
 */
export default async function ImportPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission('students.import');
  const { id } = await params;
  const result = await apiFetch<ImportPreview>(`/student-imports/${encodeURIComponent(id)}`, {
    accessToken: await accessToken(),
  });
  if (!result.ok) notFound();
  const p = result.data;
  const t = await getTranslations();
  const format = await getFormatter();
  const raw = (await searchParams).show;
  const counts: Record<ImportRowAction, number> = {
    ERROR: p.summary.error,
    UPDATE: p.summary.update,
    CREATE: p.summary.create,
    UNCHANGED: p.summary.unchanged,
  };
  const firstNonEmpty = (['ERROR', 'UPDATE', 'CREATE', 'UNCHANGED'] as const).find(
    (a) => counts[a] > 0,
  );
  const show: ImportRowAction | 'all' =
    typeof raw === 'string' && (IMPORT_ROW_ACTIONS as readonly string[]).includes(raw)
      ? (raw as ImportRowAction)
      : raw === 'all'
        ? 'all'
        : (firstNonEmpty ?? 'all');
  const rows = show === 'all' ? p.rows : p.rows.filter((r) => r.action === show);
  const open = p.status === 'PREVIEW';

  return (
    <div className="stack-lg">
      <p>
        <Link href="/students/import">← {t('imports.preview.back')}</Link>
      </p>
      <div className="row-between">
        <h1 dir="auto">{p.fileName}</h1>
        <span className={`status status-${p.status.toLowerCase()}`}>
          {t(`imports.status.${p.status}`)}
        </span>
      </div>
      <p className="muted small">
        {t('imports.preview.uploadedBy', {
          name: p.createdBy.name,
          date: format.dateTime(new Date(p.createdAt), { dateStyle: 'medium', timeStyle: 'short' }),
        })}
        {open &&
          ` · ${t('imports.preview.expires', { date: format.dateTime(new Date(p.expiresAt), { dateStyle: 'medium', timeStyle: 'short' }) })}`}
      </p>

      <section className="card stack" aria-labelledby="summary-title">
        <h2 id="summary-title">
          {open ? t('imports.preview.summaryTitle') : t('imports.preview.resultTitle')}
        </h2>
        <ul className="stat-grid">
          {(['total', 'create', 'update', 'unchanged', 'error'] as const).map((key) => (
            <li key={key} className="stat">
              <span className="stat-value">{p.summary[key]}</span>
              <span className="stat-label">{t(`imports.summary.${key}`)}</span>
            </li>
          ))}
        </ul>
        {p.result && (
          <p className="alert alert-success" role="status">
            {t('imports.preview.committed', {
              created: p.result.created,
              updated: p.result.updated,
              skippedUpdates: p.result.skippedUpdates,
              skippedInvalid: p.result.skippedInvalid,
            })}
          </p>
        )}
        {p.ignoredColumns.length > 0 && (
          <p className="muted small">
            {t('imports.preview.ignored', { columns: p.ignoredColumns.join('، ') })}
          </p>
        )}
        {open && p.ownedByMe && (
          <CommitForm id={p.id} planDigest={p.planDigest} summary={p.summary} />
        )}
        {open && !p.ownedByMe && <p className="muted">{t('imports.preview.notOwner')}</p>}
      </section>

      <section className="card stack" aria-labelledby="rows-title">
        <h2 id="rows-title">{t('imports.preview.rowsTitle')}</h2>
        <nav className="tabs" aria-label={t('imports.preview.rowsTitle')}>
          {(['ERROR', 'UPDATE', 'CREATE', 'UNCHANGED', 'all'] as const).map((key) => (
            <Link
              key={key}
              href={`/students/import/${p.id}?show=${key}`}
              className={`tab${show === key ? ' tab-active' : ''}`}
              aria-current={show === key ? 'page' : undefined}
            >
              {t(`imports.filter.${key}`)} ({key === 'all' ? p.summary.total : counts[key]})
            </Link>
          ))}
        </nav>
        {rows.length === 0 ? (
          <p className="empty">{t('imports.preview.noRows')}</p>
        ) : (
          <>
            {rows.length > SHOWN && (
              <p className="muted small">
                {t('imports.preview.showing', { shown: SHOWN, total: rows.length })}
              </p>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('imports.preview.row')}</th>
                    <th scope="col">{t('imports.preview.result')}</th>
                    <th scope="col">{t('students.columns.seatNumber')}</th>
                    <th scope="col">{t('students.columns.name')}</th>
                    <th scope="col">{t('imports.preview.details')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, SHOWN).map((r) => (
                    <tr key={r.rowNumber}>
                      <td>{r.rowNumber}</td>
                      <td>
                        <span className={`status status-${r.action.toLowerCase()}`}>
                          {t(`imports.action.${r.action}`)}
                        </span>
                      </td>
                      <td dir="ltr">{r.seatNumber ?? t('common.none')}</td>
                      <td>{r.fullName ?? t('common.none')}</td>
                      <td>
                        {r.errors.length > 0 && (
                          <ul className="cell-errors">
                            {r.errors.map((code) => (
                              <li key={code}>{t(`importErrors.${code}`)}</li>
                            ))}
                          </ul>
                        )}
                        {r.changes.length > 0 && (
                          <ul className="changes">
                            {r.changes.map((c) => (
                              <li key={c.field}>
                                {t(`imports.columnNames.${c.field}`)}:{' '}
                                <del>{c.from ?? t('common.none')}</del> →{' '}
                                <ins>{c.to ?? t('common.none')}</ins>
                              </li>
                            ))}
                          </ul>
                        )}
                        {r.action === 'CREATE' && (r.group || r.universityEmail) && (
                          <span className="muted small">
                            {[r.group, r.universityEmail].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
