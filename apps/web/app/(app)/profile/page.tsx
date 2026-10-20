import type { Metadata } from 'next';
import { type OwnProfileChange, type OwnStudentProfile } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { LanguageSwitcher } from '@/components/language-switcher';
import { PasswordForm } from '@/components/password-form';
import { apiFetch } from '@/lib/api';
import { accessToken, requireUser } from '@/lib/auth/session';
import { CancelChangeButton, PhoneForm, ProfileChangeForm } from './student-profile-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('profile'))('title') };
}

export default async function ProfilePage() {
  const user = await requireUser();
  const t = await getTranslations();
  const format = await getFormatter();
  const faculty = user.facultyProfile;
  const student = user.role === 'STUDENT';
  const token = await accessToken();
  // A student's page shows the authoritative record loaded from faculty data (§4.2 Case A).
  const [record, changes] = student
    ? await Promise.all([
        apiFetch<OwnStudentProfile>('/me/student', { accessToken: token }),
        apiFetch<OwnProfileChange[]>('/me/profile-changes', { accessToken: token }),
      ])
    : [null, null];
  const own = record?.ok ? record.data : null;
  const requests = changes?.ok ? changes.data : [];
  const pending = requests.find((r) => r.status === 'PENDING');

  return (
    <div className="stack-lg">
      <h1>{t('profile.title')}</h1>

      <section className="card" aria-labelledby="profile-account">
        <h2 id="profile-account">{t('profile.account')}</h2>
        <dl className="details">
          <div>
            <dt>{t('profile.fullName')}</dt>
            <dd>{own?.fullName ?? faculty?.fullName ?? user.displayName}</dd>
          </div>
          <div>
            <dt>{t('dashboard.email')}</dt>
            <dd dir="ltr">{user.email}</dd>
          </div>
          {own && (
            <>
              <div>
                <dt>{t('dashboard.seatNumber')}</dt>
                <dd dir="ltr">{own.seatNumber}</dd>
              </div>
              {(['firstName', 'fatherName', 'grandfatherName', 'familyName'] as const).map((key) =>
                own[key] ? (
                  <div key={key}>
                    <dt>{t(`students.fields.${key}`)}</dt>
                    <dd>{own[key]}</dd>
                  </div>
                ) : null,
              )}
              <div>
                <dt>{t('students.fields.group')}</dt>
                <dd>{own.group?.name ?? t('profile.noGroup')}</dd>
              </div>
            </>
          )}
          {faculty?.academicTitle && (
            <div>
              <dt>{t('profile.academicTitle')}</dt>
              <dd>{faculty.academicTitle}</dd>
            </div>
          )}
          {faculty?.department && (
            <div>
              <dt>{t('profile.department')}</dt>
              <dd>{faculty.department}</dd>
            </div>
          )}
          <div>
            <dt>{t('dashboard.role')}</dt>
            <dd>{t(`roles.${user.role}`)}</dd>
          </div>
        </dl>
        {student && <p className="muted small">{t('profile.protectedFieldsNote')}</p>}
      </section>

      {own && (
        <section className="card" aria-labelledby="profile-contact">
          <h2 id="profile-contact">{t('profile.contact')}</h2>
          <PhoneForm phone={own.phone} />
        </section>
      )}

      {own && (
        <section className="card stack" aria-labelledby="profile-change">
          <h2 id="profile-change">{t('profile.change.title')}</h2>
          {pending ? (
            <p className="alert alert-info" role="status">
              {t('profile.change.pendingNotice')}
            </p>
          ) : (
            <>
              <p className="muted small">{t('profile.change.intro')}</p>
              <ProfileChangeForm record={own} />
            </>
          )}
          {requests.length > 0 && (
            <>
              <h3>{t('profile.change.history')}</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t('profile.change.date')}</th>
                      <th scope="col">{t('profile.change.changes')}</th>
                      <th scope="col">{t('profile.change.status')}</th>
                      <th scope="col">{t('profile.change.outcome')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((r) => (
                      <tr key={r.id}>
                        <td>{format.dateTime(new Date(r.createdAt), { dateStyle: 'medium' })}</td>
                        <td>
                          <ul className="changes">
                            {r.changes.map((c) => (
                              <li key={c.field}>
                                {t(`imports.columnNames.${c.field}`)}:{' '}
                                <del>{c.from ?? t('common.none')}</del> →{' '}
                                <ins>{c.to ?? t('common.none')}</ins>
                              </li>
                            ))}
                          </ul>
                        </td>
                        <td>
                          <span className={`status status-${r.status.toLowerCase()}`}>
                            {t(`reviews.statuses.${r.status}`)}
                          </span>
                        </td>
                        <td>
                          {r.status === 'PENDING' ? (
                            <CancelChangeButton id={r.id} />
                          ) : (
                            (r.decisionReason ?? t('common.none'))
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
      )}

      <section className="card" aria-labelledby="profile-preferences">
        <h2 id="profile-preferences">{t('profile.preferences')}</h2>
        <div className="row-between">
          <p className="muted">{t('profile.languageHint')}</p>
          <LanguageSwitcher />
        </div>
      </section>

      <section className="card" aria-labelledby="profile-security">
        <h2 id="profile-security">{t('profile.changePassword')}</h2>
        <PasswordForm requireCurrent successMessage={t('profile.passwordChanged')} />
      </section>
    </div>
  );
}
