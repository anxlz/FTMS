'use client';

import { type AccountStatus, type Role, STAFF_ROLES } from '@ftms/core';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Field, FormError, FormSuccess, SubmitButton } from '@/components/form-controls';
import { IDLE } from '@/lib/forms';
import { permissionMessageKey } from '@/lib/permission-label';
import { setGrantsAction, setRoleAction, setStatusAction } from '../actions';

export function StatusForm({ id, status }: { id: string; status: AccountStatus }) {
  const t = useTranslations();
  const [state, action] = useActionState(setStatusAction, IDLE);
  const suspend = status !== 'SUSPENDED';
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('common.saved')}</FormSuccess>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={suspend ? 'SUSPENDED' : 'ACTIVE'} />
      {suspend && <p className="muted small">{t('admin.detail.suspendHint')}</p>}
      <Field
        label={t('admin.fields.reason')}
        name="reason"
        required
        minLength={3}
        defaultValue={state.values?.reason}
        errors={state.fieldErrors?.reason}
      />
      <SubmitButton variant={suspend ? 'danger' : 'primary'}>
        {suspend ? t('admin.detail.suspend') : t('admin.detail.reactivate')}
      </SubmitButton>
    </form>
  );
}

export function RoleForm({ id, role }: { id: string; role: Role }) {
  const t = useTranslations();
  const [state, action] = useActionState(setRoleAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('common.saved')}</FormSuccess>
      <input type="hidden" name="id" value={id} />
      <div className="field">
        <label htmlFor="role-select">{t('admin.fields.role')}</label>
        <select id="role-select" name="role" defaultValue={state.values?.role ?? role}>
          {STAFF_ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`roles.${r}`)}
            </option>
          ))}
        </select>
      </div>
      <Field
        label={t('admin.fields.reason')}
        name="reason"
        required
        minLength={3}
        defaultValue={state.values?.reason}
        errors={state.fieldErrors?.reason}
      />
      <SubmitButton>{t('admin.detail.changeRole')}</SubmitButton>
    </form>
  );
}

interface GrantRow {
  key: string;
  grantable: boolean;
  effective: boolean;
  grant: 'inherit' | 'ALLOW' | 'DENY';
}

export function GrantsForm({ id, rows }: { id: string; rows: GrantRow[] }) {
  const t = useTranslations();
  const [state, action] = useActionState(setGrantsAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('common.saved')}</FormSuccess>
      <input type="hidden" name="id" value={id} />
      <div className="table-wrap">
        <table>
          <tbody>
            {rows.map((row) => {
              const label = t.has(permissionMessageKey(row.key))
                ? t(permissionMessageKey(row.key))
                : row.key;
              return (
                <tr key={row.key}>
                  <th scope="row">
                    {label}
                    {row.effective && (
                      <span className="badge badge-ok">{t('admin.detail.effective')}</span>
                    )}
                  </th>
                  <td>
                    {row.grantable ? (
                      <select
                        name={`grant:${row.key}`}
                        defaultValue={state.values?.[`grant:${row.key}`] ?? row.grant}
                        aria-label={label}
                      >
                        <option value="inherit">{t('admin.detail.inherit')}</option>
                        <option value="ALLOW">{t('admin.detail.allow')}</option>
                        <option value="DENY">{t('admin.detail.deny')}</option>
                      </select>
                    ) : (
                      <span className="muted small">{t('admin.detail.notGrantable')}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Field
        label={t('admin.fields.reason')}
        name="reason"
        required
        minLength={3}
        defaultValue={state.values?.reason}
        errors={state.fieldErrors?.reason}
      />
      <SubmitButton>{t('admin.detail.saveGrants')}</SubmitButton>
    </form>
  );
}
