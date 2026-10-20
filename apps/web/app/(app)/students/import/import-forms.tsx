'use client';

import { type ImportSummary } from '@ftms/core';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { CheckboxField, FormError, SubmitButton } from '@/components/form-controls';
import { IDLE } from '@/lib/forms';
import { commitImportAction, discardImportAction, uploadImportAction } from './actions';

export function UploadForm() {
  const t = useTranslations('imports');
  const te = useTranslations('errors');
  const [state, action] = useActionState(uploadImportAction, IDLE);
  const fileErrors = state.fieldErrors?.file;
  const columns = state.fieldErrors?.columns;
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      {columns && columns.length > 0 && (
        <p className="field-errors">
          {t('missingColumns', { columns: columns.map((c) => t(`columnNames.${c}`)).join('، ') })}
        </p>
      )}
      <div className={`field${fileErrors?.length ? ' field-invalid' : ''}`}>
        <label htmlFor="import-file">{t('file')}</label>
        <input
          id="import-file"
          name="file"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          required
          aria-describedby="import-file-hint"
        />
        <p className="field-hint" id="import-file-hint">
          {t('fileHint')}
        </p>
        {fileErrors && (
          <ul className="field-errors">
            {fileErrors.map((code) => (
              <li key={code}>{te.has(code) ? te(code) : te('field')}</li>
            ))}
          </ul>
        )}
      </div>
      <SubmitButton>{t('upload')}</SubmitButton>
    </form>
  );
}

/**
 * The explicit confirmation step (§4.1.3–6): updates to existing students and
 * skipping invalid rows each need their own checkbox.
 */
export function CommitForm({
  id,
  planDigest,
  summary,
}: {
  id: string;
  planDigest: string;
  summary: ImportSummary;
}) {
  const t = useTranslations('imports.preview');
  const [state, action] = useActionState(commitImportAction, IDLE);
  const [discardState, discard] = useActionState(discardImportAction, IDLE);
  const nothing = summary.create === 0 && summary.update === 0;
  return (
    <div className="stack">
      <form action={action} className="stack" noValidate>
        <FormError state={state} />
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="planDigest" value={planDigest} />
        {summary.update > 0 && (
          <CheckboxField
            name="applyUpdates"
            label={t('applyUpdates', { count: summary.update })}
            hint={t('applyUpdatesHint')}
          />
        )}
        {summary.error > 0 && (
          <CheckboxField
            name="skipInvalidRows"
            label={t('skipInvalid', { count: summary.error })}
          />
        )}
        {nothing ? (
          <p className="muted">{t('nothingToImport')}</p>
        ) : (
          <SubmitButton confirm={t('commitConfirm')}>{t('commit')}</SubmitButton>
        )}
      </form>
      <form action={discard}>
        <FormError state={discardState} />
        <input type="hidden" name="id" value={id} />
        <SubmitButton variant="secondary" confirm={t('discardConfirm')}>
          {t('discard')}
        </SubmitButton>
      </form>
    </div>
  );
}
