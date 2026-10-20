import Image from 'next/image';
import { fetchApiStatus, type ApiStatus } from '@/lib/api-health';

// Health is checked on every request; a cached "online" badge would be a lie.
export const dynamic = 'force-dynamic';

const STATUS_COPY: Record<ApiStatus['state'], { ar: string; en: string; symbol: string }> = {
  up: { ar: 'متصلة', en: 'Online', symbol: '●' },
  down: { ar: 'غير متاحة', en: 'Unreachable', symbol: '▲' },
  not_configured: { ar: 'غير مُهيّأة', en: 'Not configured', symbol: '○' },
};

export default async function HomePage() {
  const status = await fetchApiStatus(process.env.NEXT_PUBLIC_API_URL);
  const copy = STATUS_COPY[status.state];

  return (
    <main className="shell">
      <section className="card" aria-labelledby="title">
        <Image
          className="logo"
          src="/brand/agr-logo.png"
          alt="شعار كلية الزراعة، جامعة عين شمس — Faculty of Agriculture, Ain Shams University"
          width={320}
          height={320}
          priority
        />

        <h1 id="title">نظام إدارة التدريب الميداني</h1>
        <p className="subtitle">كلية الزراعة — جامعة عين شمس</p>

        <div lang="en" dir="ltr" className="english">
          <p className="english-title">Field Training Management System</p>
          <p>Faculty of Agriculture, Ain Shams University</p>
        </div>

        <hr className="rule" />

        <p className="phase">
          النظام قيد الإنشاء — المرحلة 0: البنية الأساسية
          <span lang="en" dir="ltr">
            Under construction — Phase 0: foundation scaffold
          </span>
        </p>

        <div className={`status status-${status.state}`} role="status">
          <span className="status-symbol" aria-hidden="true">
            {copy.symbol}
          </span>
          <span>
            حالة واجهة البرمجة: <strong>{copy.ar}</strong>
            <span lang="en" dir="ltr" className="status-en">
              API status: <strong>{copy.en}</strong>
              {status.state === 'up' && ` · v${status.liveness.version}`}
              {status.state === 'down' && ` · ${status.reason}`}
            </span>
          </span>
        </div>
      </section>
    </main>
  );
}
