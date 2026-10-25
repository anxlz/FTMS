import { type AttendanceStanding, type AuditCategory, type Role } from '@ftms/core';

/** Labels of the Phase 6 reports, in the reader's language (§18.1). */
export interface ReportLabels {
  generated: string;
  filters: string;
  allRecords: string;
  rows: string;
  page: string;
  roles: Record<Role, string>;
  categories: Record<AuditCategory, string>;
  outcomes: Record<'SUCCESS' | 'FAILURE', string>;
  system: string;
  audit: {
    sheet: string;
    columns: {
      time: string;
      actor: string;
      role: string;
      action: string;
      category: string;
      resourceType: string;
      resourceId: string;
      outcome: string;
      reason: string;
      changes: string;
      ip: string;
    };
  };
  activity: {
    sheet: string;
    title: string;
    period: string;
    columns: {
      staff: string;
      role: string;
      status: string;
      total: string;
      decisions: string;
      failures: string;
      lastAction: string;
    };
    statuses: Record<'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED', string>;
    removed: string;
  };
  summary: {
    sheet: string;
    title: string;
    allowed: string;
    noGroup: string;
    columns: {
      student: string;
      seat: string;
      group: string;
      recorded: string;
      present: string;
      late: string;
      absent: string;
      lateMinutes: string;
      remaining: string;
      standing: string;
    };
    standings: Record<AttendanceStanding, string>;
  };
}

export const REPORT_LABELS: Record<'ar' | 'en', ReportLabels> = {
  ar: {
    generated: 'أُنشئ في',
    filters: 'التصفية',
    allRecords: 'الكل',
    rows: 'عدد الصفوف',
    page: 'صفحة',
    roles: {
      SUPER_ADMIN: 'مدير النظام',
      TRAINING_DIRECTOR: 'مدير التدريب',
      FACULTY: 'عضو هيئة التدريس',
      STUDENT: 'طالب',
    },
    categories: {
      SIGN_IN: 'الدخول وأمان الحساب',
      ACCOUNTS: 'الحسابات والصلاحيات',
      STUDENTS: 'سجلات الطلاب',
      REVIEWS: 'المراجعات',
      GROUPS: 'المجموعات',
      IMPORTS: 'استيراد الملفات',
      SETTINGS: 'إعدادات التدريب',
      SCHEDULES: 'الجداول',
      VISITS: 'الزيارات',
      ATTENDANCE: 'الحضور',
      TICKETS: 'التذاكر',
      GROUP_SWAPS: 'تبديل المجموعات',
      EXPORTS: 'التصدير',
    },
    outcomes: { SUCCESS: 'نجح', FAILURE: 'فشل' },
    system: 'النظام',
    audit: {
      sheet: 'سجل النشاط',
      columns: {
        time: 'الوقت',
        actor: 'المنفّذ',
        role: 'الدور',
        action: 'الإجراء',
        category: 'الفئة',
        resourceType: 'نوع السجل',
        resourceId: 'معرّف السجل',
        outcome: 'النتيجة',
        reason: 'السبب',
        changes: 'التغييرات',
        ip: 'عنوان IP',
      },
    },
    activity: {
      sheet: 'نشاط الموظفين',
      title: 'نشاط أعضاء هيئة التدريس',
      period: 'الفترة',
      columns: {
        staff: 'الموظف',
        role: 'الدور',
        status: 'حالة الحساب',
        total: 'الإجراءات',
        decisions: 'القرارات',
        failures: 'المحاولات الفاشلة',
        lastAction: 'آخر إجراء',
      },
      statuses: {
        PENDING_VERIFICATION: 'بانتظار التحقق',
        ACTIVE: 'نشط',
        SUSPENDED: 'موقوف',
      },
      removed: 'غير موجود',
    },
    summary: {
      sheet: 'ملخص الحضور',
      title: 'ملخص حضور الطلاب — التدريب الميداني، كلية الزراعة، جامعة عين شمس',
      allowed: 'الغياب المسموح',
      noGroup: 'بدون مجموعة',
      columns: {
        student: 'الطالب',
        seat: 'رقم الجلوس',
        group: 'المجموعة',
        recorded: 'الزيارات المسجلة',
        present: 'حاضر',
        late: 'متأخر',
        absent: 'غائب',
        lateMinutes: 'دقائق التأخير',
        remaining: 'الغياب المتبقي',
        standing: 'الوضع',
      },
      standings: {
        over: 'تجاوز الحد',
        atLimit: 'بلغ الحد',
        within: 'ضمن الحد',
      },
    },
  },
  en: {
    generated: 'Generated',
    filters: 'Filters',
    allRecords: 'All',
    rows: 'Rows',
    page: 'Page',
    roles: {
      SUPER_ADMIN: 'Super Admin',
      TRAINING_DIRECTOR: 'Training Director',
      FACULTY: 'Faculty member',
      STUDENT: 'Student',
    },
    categories: {
      SIGN_IN: 'Sign-in and account security',
      ACCOUNTS: 'Accounts and permissions',
      STUDENTS: 'Student records',
      REVIEWS: 'Reviews',
      GROUPS: 'Groups',
      IMPORTS: 'Spreadsheet imports',
      SETTINGS: 'Training settings',
      SCHEDULES: 'Schedules',
      VISITS: 'Visits',
      ATTENDANCE: 'Attendance',
      TICKETS: 'Tickets',
      GROUP_SWAPS: 'Group swaps',
      EXPORTS: 'Exports',
    },
    outcomes: { SUCCESS: 'Succeeded', FAILURE: 'Failed' },
    system: 'System',
    audit: {
      sheet: 'Activity log',
      columns: {
        time: 'Time',
        actor: 'Performed by',
        role: 'Role',
        action: 'Action',
        category: 'Category',
        resourceType: 'Record type',
        resourceId: 'Record ID',
        outcome: 'Outcome',
        reason: 'Reason',
        changes: 'Changes',
        ip: 'IP address',
      },
    },
    activity: {
      sheet: 'Staff activity',
      title: 'Faculty activity',
      period: 'Period',
      columns: {
        staff: 'Staff member',
        role: 'Role',
        status: 'Account status',
        total: 'Actions',
        decisions: 'Decisions',
        failures: 'Failed attempts',
        lastAction: 'Last action',
      },
      statuses: {
        PENDING_VERIFICATION: 'Awaiting verification',
        ACTIVE: 'Active',
        SUSPENDED: 'Suspended',
      },
      removed: 'Removed',
    },
    summary: {
      sheet: 'Attendance summary',
      title:
        'Student attendance summary — Field Training, Faculty of Agriculture, Ain Shams University',
      allowed: 'Allowed absences',
      noGroup: 'No group',
      columns: {
        student: 'Student',
        seat: 'Seat number',
        group: 'Group',
        recorded: 'Recorded visits',
        present: 'Present',
        late: 'Late',
        absent: 'Absent',
        lateMinutes: 'Minutes late',
        remaining: 'Absences left',
        standing: 'Standing',
      },
      standings: {
        over: 'Over the limit',
        atLimit: 'At the limit',
        within: 'Within the limit',
      },
    },
  },
};
