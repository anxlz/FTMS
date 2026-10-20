import { type EmailContent } from '../auth/auth-emails';

const SYSTEM_AR = 'نظام إدارة التدريب الميداني — كلية الزراعة، جامعة عين شمس';
const SYSTEM_EN = 'Field Training Management System — Faculty of Agriculture, Ain Shams University';

const link = (webAppUrl: string | undefined, path: string) =>
  webAppUrl ? `${webAppUrl.replace(/\/$/, '')}${path}` : null;

/**
 * Outcome emails for review flows. They never name the reviewer (§13.3: students
 * do not see who decided); reasons are included when the reviewer gave one.
 */
export function accountVerifiedEmail(webAppUrl?: string): EmailContent {
  const url = link(webAppUrl, '/dashboard');
  return {
    subject: 'تم التحقق من حسابك | Your account has been verified',
    text: [
      SYSTEM_AR,
      'تم التحقق من حسابك وربطه بسجلك الطلابي. يمكنك الآن استخدام النظام.',
      ...(url ? [url] : []),
      '',
      SYSTEM_EN,
      'Your account has been verified and linked to your student record. You can now use the system.',
      ...(url ? [url] : []),
    ].join('\n'),
  };
}

export function accountNotVerifiedEmail(reason: string, webAppUrl?: string): EmailContent {
  const url = link(webAppUrl, '/verification');
  return {
    subject: 'تعذّر التحقق من حسابك | Your account could not be verified',
    text: [
      SYSTEM_AR,
      'تعذّر التحقق من البيانات التي أرسلتها.',
      `السبب: ${reason}`,
      'يمكنك تصحيح بياناتك وإرسالها مرة أخرى من صفحة التحقق.',
      ...(url ? [url] : []),
      '',
      SYSTEM_EN,
      'The details you submitted could not be verified.',
      `Reason: ${reason}`,
      'You can correct your details and submit them again from the verification page.',
      ...(url ? [url] : []),
    ].join('\n'),
  };
}

export function profileChangeDecidedEmail(
  approved: boolean,
  reason: string | null,
  webAppUrl?: string,
): EmailContent {
  const url = link(webAppUrl, '/profile');
  return {
    subject: approved
      ? 'تمت الموافقة على طلب تعديل بياناتك | Your profile change was approved'
      : 'رُفض طلب تعديل بياناتك | Your profile change was not approved',
    text: [
      SYSTEM_AR,
      approved
        ? 'تمت الموافقة على طلب تعديل بياناتك، وتم تحديث سجلك.'
        : 'لم تتم الموافقة على طلب تعديل بياناتك، ولم يتغير سجلك.',
      ...(reason ? [`${approved ? 'ملاحظة' : 'السبب'}: ${reason}`] : []),
      ...(url ? [url] : []),
      '',
      SYSTEM_EN,
      approved
        ? 'Your profile change request was approved and your record has been updated.'
        : 'Your profile change request was not approved; your record is unchanged.',
      ...(reason ? [`${approved ? 'Note' : 'Reason'}: ${reason}`] : []),
      ...(url ? [url] : []),
    ].join('\n'),
  };
}
