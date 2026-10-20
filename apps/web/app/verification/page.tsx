import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { type OwnVerification } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth-card';
import { apiFetch } from '@/lib/api';
import { logoutAction } from '@/lib/auth/actions';
import { accessToken, currentUser, homeFor } from '@/lib/auth/session';
import { VerificationForm } from './verification-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('verification'))('title') };
}

/**
 * §4.2 Case B: a student account whose details did not match an imported record.
 * It reaches nothing else until a reviewer verifies it (the API enforces this).
 * The student sees the outcome and any reason — never who reviewed it.
 */
export default async function VerificationPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.status !== 'PENDING_VERIFICATION' || user.passwordSetupRequired) {
    redirect(homeFor(user));
  }
  const result = await apiFetch<OwnVerification>('/me/verification', {
    accessToken: await accessToken(),
  });
  const t = await getTranslations();
  const format = await getFormatter();
  const verification = result.ok ? result.data : null;
  const request = verification?.request ?? null;
  const canSubmit = verification?.state === 'NONE' || verification?.state === 'REJECTED';

  return (
    <AuthCard title={t('verification.title')} intro={t('verification.intro')}>
      <p className="muted" dir="ltr">
        {user.email}
      </p>
      {!verification && (
        <p className="alert alert-error" role="alert">
          {t('errors.INTERNAL_ERROR')}
        </p>
      )}
      {verification?.state === 'PENDING' && (
        <p className="alert alert-info" role="status">
          {t('verification.statePending')}
        </p>
      )}
      {verification?.state === 'REJECTED' && (
        <div className="alert alert-error" role="status">
          <p>{t('verification.stateRejected')}</p>
          {request?.decisionReason && (
            <p>
              <strong>{t('verification.reason')}:</strong> {request.decisionReason}
            </p>
          )}
        </div>
      )}
      {verification?.state === 'NONE' && (
        <p className="alert alert-info" role="status">
          {t('verification.stateNone')}
        </p>
      )}

      {request && (
        <section className="stack" aria-labelledby="submitted-title">
          <h2 id="submitted-title">{t('verification.submittedTitle')}</h2>
          <dl className="details">
            <div>
              <dt>{t('students.fields.fullName')}</dt>
              <dd>{request.submitted.fullName}</dd>
            </div>
            <div>
              <dt>{t('students.fields.seatNumber')}</dt>
              <dd dir="ltr">{request.submitted.seatNumber}</dd>
            </div>
            <div>
              <dt>{t('verification.sentOn')}</dt>
              <dd>{format.dateTime(new Date(request.createdAt), { dateStyle: 'medium' })}</dd>
            </div>
          </dl>
        </section>
      )}

      {canSubmit && (
        <section className="stack" aria-labelledby="resubmit-title">
          <h2 id="resubmit-title">
            {verification?.state === 'REJECTED'
              ? t('verification.resubmitTitle')
              : t('verification.submitTitle')}
          </h2>
          <p className="muted small">{t('verification.submitHint')}</p>
          <VerificationForm
            initial={
              request
                ? {
                    seatNumber: request.submitted.seatNumber,
                    firstName: request.submitted.firstName,
                    fatherName: request.submitted.fatherName,
                    grandfatherName: request.submitted.grandfatherName,
                    familyName: request.submitted.familyName,
                  }
                : {}
            }
          />
        </section>
      )}

      <form action={logoutAction}>
        <button type="submit" className="btn btn-link">
          {t('common.signOut')}
        </button>
      </form>
    </AuthCard>
  );
}
