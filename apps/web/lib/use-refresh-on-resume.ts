import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Re-reads the page's server data when it becomes visible again after a while
 * in the background (Android app switched away, phone locked): the check-in
 * window may have opened or closed meanwhile. Typed form values are kept.
 */
export function useRefreshOnResume(enabled: boolean, afterMs = 30_000): void {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    let hiddenAt = 0;
    const onChange = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt !== 0 && Date.now() - hiddenAt >= afterMs) router.refresh();
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, [enabled, afterMs, router]);
}
