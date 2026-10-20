import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LanguageSwitcher } from '@/components/language-switcher';
import { PasswordForm } from '@/components/password-form';
import { requireUser } from '@/lib/auth/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('profile'))('title') };
}

export default async function ProfilePage() {
  const user = await requireUser();
  const t = await getTranslations();
  const faculty = user.facultyProfile;
  return (
    <div className="stack-lg">
      <h1>{t('profile.title')}</h1>

      <section className="card" aria-labelledby="profile-account">
        <h2 id="profile-account">{t('profile.account')}</h2>
        <dl className="details">
          <div>
            <dt>{t('profile.fullName')}</dt>
            <dd>{user.studentProfile?.fullName ?? faculty?.fullName ?? user.displayName}</dd>
          </div>
          <div>
            <dt>{t('dashboard.email')}</dt>
            <dd dir="ltr">{user.email}</dd>
          </div>
          {user.studentProfile && (
            <div>
              <dt>{t('dashboard.seatNumber')}</dt>
              <dd dir="ltr">{user.studentProfile.seatNumber}</dd>
            </div>
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
        {user.role === 'STUDENT' && (
          <p className="muted small">{t('profile.protectedFieldsNote')}</p>
        )}
      </section>

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
