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

export function signupCodeEmail(code: string, minutes: number): EmailContent {
  return {
    subject: `رمز تأكيد البريد ${code} | Email confirmation code ${code}`,
    text: [
      SYSTEM_AR,
      `رمز تأكيد بريدك الجامعي لإنشاء الحساب: ${code}`,
      `صالح لمدة ${minutes} دقائق ولمرة واحدة فقط. إذا لم تطلب إنشاء حساب فتجاهل هذه الرسالة.`,
      '',
      SYSTEM_EN,
      `Your code to confirm your university email and create your account: ${code}`,
      `It is valid for ${minutes} minutes and can be used once. If you did not try to sign up, ignore this email.`,
    ].join('\n'),
  };
}

/** Sent instead of a signup code when the address already has an account (anti-enumeration). */
export function accountExistsEmail(webAppUrl?: string): EmailContent {
  const link = webAppUrl ? `${webAppUrl.replace(/\/$/, '')}/login` : null;
  return {
    subject: 'لديك حساب بالفعل | You already have an account',
    text: [
      SYSTEM_AR,
      'طُلب إنشاء حساب جديد بهذا البريد، لكن لديك حساب بالفعل.',
      'سجّل الدخول بكلمة المرور، أو استخدم «نسيت كلمة المرور» لتعيين كلمة جديدة. إذا لم تطلب ذلك فتجاهل هذه الرسالة.',
      ...(link ? [`رابط الدخول: ${link}`] : []),
      '',
      SYSTEM_EN,
      'Someone asked to create a new account with this email, but you already have one.',
      'Sign in with your password, or use "Forgot password" to set a new one. If this was not you, ignore this email.',
      ...(link ? [`Sign in: ${link}`] : []),
    ].join('\n'),
  };
}

/** Security notice when a biometric device is enabled or revoked (§4.5, §12). */
export function biometricChangeEmail(params: {
  enabled: boolean;
  deviceName: string;
  webAppUrl?: string;
}): EmailContent {
  const link = params.webAppUrl ? `${params.webAppUrl.replace(/\/$/, '')}/profile` : null;
  return params.enabled
    ? {
        subject: 'تفعيل الدخول بالبصمة على جهاز جديد | Biometric sign-in enabled on a device',
        text: [
          SYSTEM_AR,
          `فُعِّل الدخول بالبصمة لحسابك على الجهاز «${params.deviceName}».`,
          'إذا لم تقم بذلك فألغِ هذا الجهاز من صفحة الملف الشخصي وغيّر كلمة المرور فورًا.',
          ...(link ? [`إدارة الأجهزة: ${link}`] : []),
          '',
          SYSTEM_EN,
          `Biometric sign-in was enabled for your account on "${params.deviceName}".`,
          'If this was not you, revoke the device on your profile page and change your password now.',
          ...(link ? [`Manage devices: ${link}`] : []),
        ].join('\n'),
      }
    : {
        subject: 'إلغاء الدخول بالبصمة على جهاز | Biometric sign-in revoked on a device',
        text: [
          SYSTEM_AR,
          `أُلغي الدخول بالبصمة لحسابك على الجهاز «${params.deviceName}». لم يعد بالإمكان استخدامه للدخول.`,
          'يبقى الدخول بكلمة المرور أو برمز البريد متاحًا دائمًا.',
          '',
          SYSTEM_EN,
          `Biometric sign-in on "${params.deviceName}" was revoked for your account. It can no longer be used to sign in.`,
          'Signing in with your password or an email code always remains available.',
        ].join('\n'),
      };
}
