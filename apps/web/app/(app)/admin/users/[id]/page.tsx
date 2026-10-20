import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  canReceiveGrants,
  isStaffRole,
  PERMISSION_KEYS,
  PERMISSIONS,
  type UserDetail,
} from '@ftms/core';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { permissionMessageKey } from '@/lib/permission-label';
import { accessToken, requireUser } from '@/lib/auth/session';
import { GrantsForm, RoleForm, StatusForm } from './user-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('admin'))('title') };
}

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  if (!me.permissions.includes('users.read')) notFound();
  const { id } = await params;
  const result = await apiFetch<UserDetail>(`/admin/users/${encodeURIComponent(id)}`, {
    accessToken: await accessToken(),
  });
  if (!result.ok) notFound();
  const user = result.data;
  const t = await getTranslations();

  const self = user.id === me.id;
  const canManageStatus =
    !self &&
    (me.permissions.includes('users.manage') ||
      (user.role === 'FACULTY' && me.permissions.includes('faculty.manage')));
  const canChangeRole = !self && me.permissions.includes('users.manage') && isStaffRole(user.role);
  const canGrant = me.permissions.includes('permissions.manage') && canReceiveGrants(user.role);
  const grants = Object.fromEntries(user.grants.map((g) => [g.permission, g.effect]));

  return (
    <div className="stack-lg">
      <p>
        <Link href="/admin/users">← {t('admin.detail.back')}</Link>
      </p>
      <h1>{user.displayName}</h1>

      <section className="card">
        <dl className="details">
          <div>
            <dt>{t('admin.columns.email')}</dt>
            <dd dir="ltr">{user.email}</dd>
          </div>
          {user.seatNumber && (
            <div>
              <dt>{t('admin.columns.seatNumber')}</dt>
              <dd dir="ltr">{user.seatNumber}</dd>
            </div>
          )}
          <div>
            <dt>{t('admin.columns.role')}</dt>
            <dd>{t(`roles.${user.role}`)}</dd>
          </div>
          <div>
            <dt>{t('admin.columns.status')}</dt>
            <dd>
              <span className={`status status-${user.status.toLowerCase()}`}>
                {t(`statuses.${user.status}`)}
              </span>
            </dd>
          </div>
          <div>
            <dt>{t('admin.columns.password')}</dt>
            <dd>{user.hasPassword ? t('admin.passwordSet') : t('admin.passwordNotSet')}</dd>
          </div>
        </dl>
        {self && <p className="muted small">{t('admin.detail.self')}</p>}
      </section>

      {canManageStatus && (
        <section className="card" aria-labelledby="status-title">
          <h2 id="status-title">{t('admin.detail.statusTitle')}</h2>
          <StatusForm id={user.id} status={user.status} />
        </section>
      )}

      {canChangeRole && (
        <section className="card" aria-labelledby="role-title">
          <h2 id="role-title">{t('admin.detail.roleTitle')}</h2>
          <RoleForm id={user.id} role={user.role} />
        </section>
      )}
      {!isStaffRole(user.role) && me.permissions.includes('users.manage') && (
        <p className="muted small">{t('admin.detail.studentRoleFixed')}</p>
      )}

      <section className="card" aria-labelledby="perms-title">
        <h2 id="perms-title">{t('admin.detail.permissionsTitle')}</h2>
        {canGrant ? (
          <>
            <p className="muted small">{t('admin.detail.permissionsHint')}</p>
            <GrantsForm
              id={user.id}
              rows={PERMISSION_KEYS.map((key) => ({
                key,
                grantable: PERMISSIONS[key].grantable,
                effective: user.effectivePermissions.includes(key),
                grant: grants[key] ?? 'inherit',
              }))}
            />
          </>
        ) : (
          <>
            {!canReceiveGrants(user.role) && (
              <p className="muted small">{t('admin.detail.noGrantsForRole')}</p>
            )}
            <ul className="chips">
              {user.effectivePermissions.map((key) => (
                <li key={key} className="chip">
                  {t.has(permissionMessageKey(key)) ? t(permissionMessageKey(key)) : key}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
