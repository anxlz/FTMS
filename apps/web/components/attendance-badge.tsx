import { type AttendanceStatus } from '@ftms/core';
import { getTranslations } from 'next-intl/server';

/** Present / Late (N min) / Absent, with a shape as well as a color. */
export async function AttendanceBadge({
  status,
  minutesLate,
}: {
  status: AttendanceStatus;
  minutesLate: number;
}) {
  const t = await getTranslations('attendance');
  return (
    <span className={`status status-att-${status.toLowerCase()}`}>
      {status === 'LATE' ? t('lateBy', { minutes: minutesLate }) : t(`status.${status}`)}
    </span>
  );
}
