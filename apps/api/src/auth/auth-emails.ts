import { type Role } from '@ftms/core';

/**
 * Account emails, Arabic first then English: the recipient's language is not
 * always known yet (first login), and both versions are short.
 */
export interface EmailContent {
  subject: string;
  text: string;
}

const SYSTEM_AR = 'نظام إدارة التدريب الميداني — كلية الزراعة، جامعة عين شمس';
const SYSTEM_EN = 'Field Training Management System — Faculty of Agriculture, Ain Shams University';

const ROLE_NAMES: Record<Role, { ar: string; en: string }> = {
  SUPER_ADMIN: { ar: 'مدير النظام', en: 'Super Admin' },
  TRAINING_DIRECTOR: { ar: 'مدير التدريب', en: 'Training Director' },
  FACULTY: { ar: 'عضو هيئة التدريس', en: 'Faculty member' },
  STUDENT: { ar: 'طالب', en: 'Student' },
};

export function loginCodeEmail(code: string, minutes: number): EmailContent {
  return {
    subject: `رمز الدخول ${code} | Sign-in code ${code}`,
    text: [
      SYSTEM_AR,
      `رمز الدخول الخاص بك: ${code}`,
      `صالح لمدة ${minutes} دقائق ولمرة واحدة فقط. إذا لم تطلب هذا الرمز فتجاهل هذه الرسالة.`,
      '',
      SYSTEM_EN,
      `Your sign-in code: ${code}`,
      `It is valid for ${minutes} minutes and can be used once. If you did not request it, ignore this email.`,
    ].join('\n'),
  };
}

export function passwordResetEmail(code: string, minutes: number): EmailContent {
  return {
    subject: `رمز إعادة تعيين كلمة المرور ${code} | Password reset code ${code}`,
    text: [
      SYSTEM_AR,
      `رمز إعادة تعيين كلمة المرور: ${code}`,
      `صالح لمدة ${minutes} دقائق ولمرة واحدة فقط. إذا لم تطلب ذلك فتجاهل هذه الرسالة؛ كلمة مرورك لم تتغير.`,
      '',
      SYSTEM_EN,
      `Your password reset code: ${code}`,
      `It is valid for ${minutes} minutes and can be used once. If you did not ask for this, ignore this email; your password has not changed.`,
    ].join('\n'),
  };
}

export function invitationEmail(params: {
  displayName: string;
  role: Role;
  email: string;
  webAppUrl?: string;
}): EmailContent {
  const role = ROLE_NAMES[params.role];
  const link = params.webAppUrl ? `${params.webAppUrl.replace(/\/$/, '')}/login` : null;
  return {
    subject: 'تم إنشاء حسابك | Your account has been created',
    text: [
      SYSTEM_AR,
      `مرحبًا ${params.displayName}،`,
      `تم إنشاء حسابك بصفة: ${role.ar}.`,
      `لتسجيل الدخول لأول مرة، اختر «الدخول برمز البريد» وأدخل بريدك ${params.email}، ثم عيّن كلمة مرور.`,
      ...(link ? [`رابط الدخول: ${link}`] : []),
      '',
      SYSTEM_EN,
      `Hello ${params.displayName},`,
      `An account has been created for you as: ${role.en}.`,
      `To sign in for the first time, choose "Sign in with an email code", enter ${params.email}, then set a password.`,
      ...(link ? [`Sign in: ${link}`] : []),
    ].join('\n'),
  };
}
