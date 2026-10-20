import type { Metadata } from 'next';
import Link from 'next/link';
import { IMPORT_MAX_ROWS, type ListImportsResponse } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { UploadForm } from './import-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('imports'))('title') };
}

/** Spreadsheet import (§4.1): template, upload, and the history of imports. */
export default async function ImportPage() {
  await requirePermission('students.import');
  const t = await getTranslations();
  const format = await getFormatter();
  const history = await apiFetch<ListImportsResponse>('/student-imports', {
    accessToken: await accessToken(),
  });

  return (
    <div className="stack-lg">
      <p>
        <Link href="/students">← {t('students.detail.back')}</Link>
      </p>
      <h1>{t('imports.title')}</h1>

      <section className="card stack" aria-labelledby="upload-title">
        <h2 id="upload-title">{t('imports.uploadTitle')}</h2>
        <ol className="stack small">
          <li>
            {t('imports.step1')}{' '}
            <a href="/students/import/template" download>
              {t('imports.template')}
            </a>
          </li>
          <li>{t('imports.step2', { max: IMPORT_MAX_ROWS })}</li>
          <li>{t('imports.step3')}</li>
        </ol>
        <UploadForm />
      </section>

      <section className="card stack" aria-labelledby="history-title">
        <h2 id="history-title">{t('imports.history')}</h2>
        {!history.ok ? (
          <p className="alert alert-error" role="alert">
            {t('errors.INTERNAL_ERROR')}
          </p>
        ) : history.data.items.length === 0 ? (
          <p className="empty">{t('imports.historyEmpty')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('imports.columns.file')}</th>
                  <th scope="col">{t('imports.columns.by')}</th>
                  <th scope="col">{t('imports.columns.date')}</th>
                  <th scope="col">{t('imports.columns.status')}</th>
                  <th scope="col">{t('imports.columns.rows')}</th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link href={`/students/import/${item.id}`} dir="auto">
                        {item.fileName}
                      </Link>
                    </td>
                    <td>{item.createdBy.name}</td>
                    <td>
                      {format.dateTime(new Date(item.createdAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td>
                      <span className={`status status-${item.status.toLowerCase()}`}>
                        {t(`imports.status.${item.status}`)}
                      </span>
                    </td>
                    <td>
                      {item.result
                        ? t('imports.resultLine', {
                            created: item.result.created,
                            updated: item.result.updated,
                          })
                        : t('imports.summaryLine', {
                            total: item.summary.total,
                            error: item.summary.error,
                          })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
