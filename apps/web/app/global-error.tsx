'use client';

/**
 * Last resort when even the root layout fails: no translations are available
 * here, so the message is given in both languages (Arabic first, §18.1).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ar" dir="rtl">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          maxWidth: '36rem',
          margin: '10vh auto',
          padding: '0 1rem',
          lineHeight: 1.6,
        }}
      >
        <main role="alert">
          <h1>تعذّر عرض الصفحة</h1>
          <p>حدث خطأ غير متوقع. حاول مرة أخرى بعد قليل.</p>
          <p lang="en" dir="ltr">
            Something went wrong while showing this page. Please try again shortly.
          </p>
          {error.digest && (
            <p dir="ltr">
              <small>Ref: {error.digest}</small>
            </p>
          )}
          <button type="button" onClick={() => reset()}>
            حاول مرة أخرى · Try again
          </button>
        </main>
      </body>
    </html>
  );
}
