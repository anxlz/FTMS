/**
 * The launcher's logic, kept free of the DOM so it can be tested (Phase 8).
 * The launcher is the only page bundled with the app: it checks that the FTMS
 * web app is reachable, then replaces itself with it. Nothing is stored here —
 * no credentials, no attendance, no offline queue.
 */

/** The web app's signed-out landing screen: Log In, or Continue as Guest. */
export const START_PATH = '/start';

export const MESSAGES = {
  ar: {
    title: 'التدريب الميداني',
    connecting: 'جارٍ الاتصال…',
    offline: 'لا يوجد اتصال بالإنترنت. تحتاج الخدمة إلى الاتصال لتسجيل الدخول وتسجيل الحضور.',
    unreachable: 'تعذّر الوصول إلى الخدمة الآن. تحقق من اتصالك ثم حاول مرة أخرى.',
    notConfigured: 'هذا الإصدار من التطبيق غير مُعدّ بعنوان الخدمة.',
    retry: 'إعادة المحاولة',
  },
  en: {
    title: 'Field Training',
    connecting: 'Connecting…',
    offline:
      'No internet connection. The service needs a connection to sign in and record attendance.',
    unreachable: 'The service cannot be reached right now. Check your connection, then try again.',
    notConfigured: 'This build of the app has no service address configured.',
    retry: 'Try again',
  },
};

/** Arabic unless the phone prefers English (the web app defaults to Arabic too). */
export function languageFor(preferred) {
  const first = (Array.isArray(preferred) ? preferred : [preferred]).find(Boolean) ?? '';
  return String(first).toLowerCase().startsWith('en') ? 'en' : 'ar';
}

/**
 * The web app's address from the bundled config, or null when the build was
 * not configured (or configured only with the compile-check placeholder).
 */
export function webUrlFrom(config) {
  if (!config || typeof config !== 'object' || config.placeholder) return null;
  try {
    const url = new URL(String(config.webUrl));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Whether the web app answers: any HTTP response counts (an opaque `no-cors`
 * response included); a network failure or timeout does not.
 */
export async function reachable(origin, fetchImpl, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(`${origin}/login`, {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
