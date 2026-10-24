import { type AttendanceSource, type AttendanceStatus } from '@ftms/core';

/** Column and value labels of exported reports, in the reader's language (§18.1). */
export interface ExportLabels {
  sheet: string;
  title: string;
  generated: string;
  filters: string;
  allRecords: string;
  rows: string;
  page: string;
  columns: {
    date: string;
    time: string;
    visit: string;
    group: string;
    student: string;
    seat: string;
    status: string;
    checkIn: string;
    minutesLate: string;
    source: string;
    biometric: string;
    note: string;
  };
  status: Record<AttendanceStatus, string>;
  source: Record<AttendanceSource, string>;
  yes: string;
  no: string;
}

export const EXPORT_LABELS: Record<'ar' | 'en', ExportLabels> = {
  ar: {
    sheet: 'الحضور',
    title: 'تقرير الحضور — التدريب الميداني، كلية الزراعة، جامعة عين شمس',
    generated: 'أُنشئ في',
    filters: 'التصفية',
    allRecords: 'كل السجلات',
    rows: 'عدد السجلات',
    page: 'صفحة',
    columns: {
      date: 'التاريخ',
      time: 'الموعد',
      visit: 'الزيارة',
      group: 'المجموعة',
      student: 'اسم الطالب',
      seat: 'رقم الجلوس',
      status: 'الحالة',
      checkIn: 'وقت التسجيل',
      minutesLate: 'دقائق التأخير',
      source: 'المصدر',
      biometric: 'تأكيد بالبصمة',
      note: 'ملاحظة',
    },
    status: { PRESENT: 'حاضر', LATE: 'متأخر', ABSENT: 'غائب' },
    source: { QR: 'رمز QR', MANUAL: 'تصحيح يدوي', AUTOMATIC: 'تلقائي' },
    yes: 'نعم',
    no: 'لا',
  },
  en: {
    sheet: 'Attendance',
    title: 'Attendance report — Field Training, Faculty of Agriculture, Ain Shams University',
    generated: 'Generated',
    filters: 'Filters',
    allRecords: 'All records',
    rows: 'Records',
    page: 'Page',
    columns: {
      date: 'Date',
      time: 'Scheduled time',
      visit: 'Visit',
      group: 'Group',
      student: 'Student name',
      seat: 'Seat number',
      status: 'Status',
      checkIn: 'Check-in time',
      minutesLate: 'Minutes late',
      source: 'Source',
      biometric: 'Biometric',
      note: 'Note',
    },
    status: { PRESENT: 'Present', LATE: 'Late', ABSENT: 'Absent' },
    source: { QR: 'QR code', MANUAL: 'Manual correction', AUTOMATIC: 'Automatic' },
    yes: 'Yes',
    no: 'No',
  },
};
