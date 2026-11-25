import { z } from 'zod';
import { DEFAULT_HR_REQUEST_ROUTES, hrRequestRoutesSchema } from './schemas/hrRequests';
import { DEFAULT_TICKET_DEPARTMENT_FIELDS, ticketDepartmentFieldsSchema } from './schemas/tickets';
import { DEFAULT_REPORT_TYPES, reportTypesSchema } from './schemas/hrReports';
import { DEFAULT_ORGANIZATION_TYPES } from './schemas/crm';
import { DEFAULT_FACILITY_SIZES, DEFAULT_LOSS_REASONS } from './schemas/sales';
import { SALES_LIST_KEYS } from './schemas/salesRequests';
import { DEFAULT_QUOTE_REJECTION_REASONS } from './schemas/salesPricing';
import {
  DEFAULT_APPRAISAL_POLICY,
  DEFAULT_DISCIPLINE_POLICY,
  appraisalPolicySchema,
  disciplinePolicySchema,
} from './schemas/performance';
import { DEFAULT_GOSI_RATES, DEFAULT_PAYROLL_POLICY, gosiRatesSchema, payrollPolicySchema } from './schemas/payroll';
import { DEFAULT_TRAINING_POLICY, trainingPolicySchema } from './schemas/training';
import {
  attendanceRulesSchema,
  correctionPolicySchema,
  DEFAULT_LEAVE_POLICIES,
  leavePoliciesSchema,
  locationPolicySchema,
  overtimePolicySchema,
} from './schemas/attendance';

/**
 * Settings registry: everything the specs want configurable lives here with a default and a schema
 * (golden rule 10). Values are stored in the `settings` collection and edited from the admin screen.
 */
export interface SettingDefinition<T = unknown> {
  key: string;
  labelAr: string;
  descriptionAr?: string;
  group: 'auth' | 'tickets' | 'hr' | 'notifications' | 'general' | 'system' | 'crm' | 'sales';
  schema: z.ZodType<T>;
  default: T;
  /**
   * The default is a proposal awaiting the owner's or the HR team's confirmation (DECISIONS §21): screens show
   * «مؤقت حتى اعتماد الموارد البشرية» until an admin confirms the setting (stored flag) or stores a value.
   */
  provisional?: boolean;
}

function def<T>(d: SettingDefinition<T>): SettingDefinition<T> {
  return d;
}

export const SETTING_DEFINITIONS = {
  // ---- CRM / Sales [SAL §3, §4.1, DECISIONS §20]
  'crm.leadRegistrationHours': def({
    key: 'crm.leadRegistrationHours',
    labelAr: 'مهلة تسجيل العميل المحتمل المحال من خدمة العملاء (ساعات)',
    descriptionAr:
      'ساعات زمنية من وقت الإحالة؛ عند تجاوزها يُنبَّه الموظف المسؤول ومدير المبيعات مرة واحدة [SAL §3]',
    group: 'crm',
    schema: z
      .number()
      .int()
      .min(1)
      .max(24 * 14),
    default: 24, // DECISIONS §20 Q13
  }),
  'crm.organizationTypes': def({
    key: 'crm.organizationTypes',
    labelAr: 'أنواع الجهات',
    descriptionAr: 'القائمة الأولية من SAL §4.1؛ تُضاف قيم خدمة العملاء لاحقًا (DECISIONS §20 Q8)',
    group: 'crm',
    schema: z.array(z.string().trim().min(1).max(80)).max(50),
    default: DEFAULT_ORGANIZATION_TYPES,
  }),
  'sales.facilitySizes': def({
    key: 'sales.facilitySizes',
    labelAr: 'أحجام المنشآت (مؤقتة حتى اعتماد المالك)',
    group: 'sales',
    schema: z.array(z.string().trim().min(1).max(80)).max(50),
    default: DEFAULT_FACILITY_SIZES, // provisional (DECISIONS §20 Q7)
  }),
  'sales.lossReasons': def({
    key: 'sales.lossReasons',
    labelAr: 'أسباب خسارة الفرصة (مؤقتة حتى اعتماد المالك)',
    group: 'sales',
    schema: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
    default: DEFAULT_LOSS_REASONS, // provisional (DECISIONS §20 Q7)
  }),
  'sales.lists': def({
    key: 'sales.lists',
    labelAr:
      'قوائم طلبات المبيعات (أنواع الحاويات وأحجامها وألوانها، أنواع العقود، أنواع النفايات والخدمة، مواد الإتلاف، تصنيفات السكراب وأنواع مهامه، مصادر المناقصات، أنواع الاجتماعات)',
    descriptionAr:
      'تبدأ فارغة قابلة للتعديل حتى يرسلها المالك (DECISIONS §20 Q7)؛ النماذج تقبل نصًا حرًا عندما تكون القائمة فارغة',
    group: 'sales',
    schema: z.record(z.enum(SALES_LIST_KEYS), z.array(z.string().trim().min(1).max(120)).max(100)),
    default: Object.fromEntries(SALES_LIST_KEYS.map((k) => [k, [] as string[]])) as Record<
      (typeof SALES_LIST_KEYS)[number],
      string[]
    >,
  }),
  'sales.scrapTransferRoles': def({
    key: 'sales.scrapTransferRoles',
    labelAr: 'الأدوار المخوّلة بتسجيل «حالة تحويل المبلغ» في السكراب',
    descriptionAr:
      'إلى أن يجيب المالك عن Q16 (DECISIONS §20): التحويل حالة مع إثبات إلزامي ويُشعَر القسم المالي [OPS §2.2]',
    group: 'sales',
    schema: z.array(z.string()).min(1),
    default: ['sales_manager', 'finance_manager', 'finance_staff'],
  }),
  'sales.discountLimitBp': def({
    key: 'sales.discountLimitBp',
    labelAr: 'حدود الخصم (نقاط أساس من سعر القائمة): موظف المبيعات ومدير المبيعات',
    descriptionAr:
      'Q1 لم يُجَب بعد: الحدّان فارغان → كل خصم يحتاج اعتماد المدير التنفيذي ويظهر «حدود الخصم غير محددة» (DECISIONS §20 change 7). 1000 = 10%',
    group: 'sales',
    schema: z.object({
      rep: z.number().int().min(0).max(10_000).nullable(),
      manager: z.number().int().min(0).max(10_000).nullable(),
    }),
    default: { rep: null, manager: null },
  }),
  'sales.quoteApprovalMode': def({
    key: 'sales.quoteApprovalMode',
    labelAr: 'اعتماد عرض السعر: فوق حد الخصم فقط أو دائمًا',
    group: 'sales',
    schema: z.enum(['above_limit', 'always']),
    default: 'above_limit', // DECISIONS §20 Q2
  }),
  'sales.priceEditorRoles': def({
    key: 'sales.priceEditorRoles',
    labelAr: 'الأدوار المخوّلة بتعديل قائمة الأسعار وأسعار السوق',
    group: 'sales',
    schema: z.array(z.string()).min(1),
    default: ['sales_manager'], // DECISIONS §20 Q6 default
  }),
  'sales.quoteValidityDays': def({
    key: 'sales.quoteValidityDays',
    labelAr: 'مدة صلاحية عرض السعر الافتراضية (أيام)',
    group: 'sales',
    schema: z.number().int().min(1).max(365),
    default: 30,
  }),
  'sales.quoteRejectionReasons': def({
    key: 'sales.quoteRejectionReasons',
    labelAr: 'أسباب رفض عرض السعر (مؤقتة حتى اعتماد المالك)',
    group: 'sales',
    schema: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
    default: DEFAULT_QUOTE_REJECTION_REASONS, // provisional (Q7)
  }),
  'sales.contractAlertDaysBefore': def({
    key: 'sales.contractAlertDaysBefore',
    labelAr: 'التنبيه قبل انتهاء العقود السنوية (أيام)',
    descriptionAr: 'ثلاثة أشهر بنص SAL §6.3؛ شهادة التعاون تُتاح من هذا الموعد',
    group: 'sales',
    schema: z.number().int().min(1).max(365),
    default: 90,
  }),
  'sales.kpiTargets': def({
    key: 'sales.kpiTargets',
    labelAr: 'مستهدفات مؤشرات المبيعات الثابتة',
    descriptionAr:
      'نسبة تحويل العروض 40% ومتوسط مدة التحصيل 45 يومًا أو أقل بنص SAL §11؛ الإيرادات والكمية من المستهدفات الشهرية',
    group: 'sales',
    schema: z.object({
      quoteConversionBp: z.number().int().min(0).max(10_000),
      collectionDays: z.number().int().min(1).max(365),
    }),
    default: { quoteConversionBp: 4000, collectionDays: 45 },
  }),
  'sales.followUpReminderHours': def({
    key: 'sales.followUpReminderHours',
    labelAr: 'التنبيه قبل موعد متابعة العميل (ساعات)',
    descriptionAr: 'إشعار «قرب موعد متابعة العميل» للموظف المسؤول [SAL §10.2, §14]',
    group: 'sales',
    schema: z
      .number()
      .int()
      .min(0)
      .max(24 * 7),
    default: 24,
  }),
  'auth.sessionIdleMinutes': def({
    key: 'auth.sessionIdleMinutes',
    labelAr: 'مهلة الخمول للجلسة (دقائق)',
    group: 'auth',
    schema: z
      .number()
      .int()
      .min(5)
      .max(24 * 60),
    default: 30, // DECISIONS §2
  }),
  'auth.sessionMaxHours': def({
    key: 'auth.sessionMaxHours',
    labelAr: 'الحد الأقصى لعمر الجلسة (ساعات)',
    group: 'auth',
    schema: z
      .number()
      .int()
      .min(1)
      .max(24 * 7),
    default: 12, // DECISIONS §2
  }),
  'auth.mfaRequiredRoles': def({
    key: 'auth.mfaRequiredRoles',
    labelAr: 'الأدوار التي يُلزم فيها التحقق الثنائي',
    group: 'auth',
    schema: z.array(z.string()),
    default: ['system_admin', 'hr_officer', 'hr_manager', 'finance_staff', 'finance_manager'], // DECISIONS §2
  }),
  'auth.maxFailedLogins': def({
    key: 'auth.maxFailedLogins',
    labelAr: 'عدد محاولات الدخول الفاشلة قبل القفل المؤقت',
    group: 'auth',
    schema: z.number().int().min(3).max(20),
    default: 5,
  }),
  'auth.lockoutMinutes': def({
    key: 'auth.lockoutMinutes',
    labelAr: 'مدة القفل المؤقت (دقائق)',
    group: 'auth',
    schema: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    default: 15,
  }),
  'auth.passwordMinLength': def({
    key: 'auth.passwordMinLength',
    labelAr: 'الحد الأدنى لطول كلمة المرور',
    group: 'auth',
    schema: z.number().int().min(8).max(64),
    default: 10,
  }),
  'auth.mfaMaxFailuresPerUser': def({
    key: 'auth.mfaMaxFailuresPerUser',
    labelAr: 'عدد رموز التحقق الخاطئة قبل قفل المصادقة للمستخدم',
    group: 'auth',
    schema: z.number().int().min(3).max(50),
    default: 10, // slice 5 review follow-up 1
  }),
  'auth.mfaFailureWindowMinutes': def({
    key: 'auth.mfaFailureWindowMinutes',
    labelAr: 'نافذة احتساب رموز التحقق الخاطئة (دقائق)',
    group: 'auth',
    schema: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    default: 30,
  }),
  'auth.mfaLockMinutes': def({
    key: 'auth.mfaLockMinutes',
    labelAr: 'مدة قفل المصادقة الثنائية للمستخدم (دقائق)',
    group: 'auth',
    schema: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    default: 30,
  }),
  'auth.temporaryPasswordHours': def({
    key: 'auth.temporaryPasswordHours',
    labelAr: 'صلاحية كلمة المرور المؤقتة (ساعات)',
    descriptionAr: 'بعدها يُرفض الدخول بكلمة المرور المؤقتة ويلزم إعادة تعيينها من مدير النظام',
    group: 'auth',
    schema: z
      .number()
      .int()
      .min(1)
      .max(24 * 30),
    default: 72, // security review A8
  }),
  'tasks.unassignedReminderBusinessDays': def({
    key: 'tasks.unassignedReminderBusinessDays',
    labelAr: 'تذكير مدير القسم بالمهام غير المسندة بعد (أيام عمل)',
    group: 'notifications',
    schema: z.number().int().min(1),
    default: 1, // EP §16: the manager distributes department work
  }),
  'news.staffAuthoringDepartments': def({
    key: 'news.staffAuthoringDepartments',
    labelAr: 'موظفو القسم يكتبون أخبار قسمهم ويرسلونها لاعتماد المدير (لكل قسم؛ الافتراضي مفعّل)',
    group: 'general',
    schema: z.record(z.string(), z.boolean()),
    default: {}, // slice 5 review change: missing department = on [EP §12.2, §12.3.3]
  }),
  'news.directPublishRoles': def({
    key: 'news.directPublishRoles',
    labelAr: 'الأدوار التي تنشر مباشرة دون اعتماد (مع قسم من أقسام النشر المباشر)',
    group: 'general',
    schema: z.array(z.string()),
    default: ['hr_officer', 'hr_manager', 'executive'], // go-live review E4
  }),
  'news.directPublishDepartments': def({
    key: 'news.directPublishDepartments',
    labelAr: 'أقسام تنشر أخبارها وتعاميمها مباشرة دون اعتماد',
    group: 'general',
    schema: z.array(z.string()),
    default: ['hr', 'executive'], // DECISIONS §10
  }),
  'tickets.hiddenTargets': def({
    key: 'tickets.hiddenTargets',
    labelAr: 'أقسام لا تظهر كوجهة للتذاكر حتى تُبنى وحداتها (المالية والمشتريات)',
    group: 'tickets',
    schema: z.array(z.string()),
    default: ['finance', 'procurement'], // DECISIONS §8: same record as FIN §3 / PRC §2 once those modules exist
  }),
  'tickets.managersOnlyTargets': def({
    key: 'tickets.managersOnlyTargets',
    labelAr: 'أقسام تظهر كوجهة لمديري الأقسام فقط',
    group: 'tickets',
    schema: z.array(z.string()),
    default: ['finance', 'procurement'], // EP §9.1 note
  }),
  'tickets.departmentFields': def({
    key: 'tickets.departmentFields',
    labelAr: 'حقول التذاكر الخاصة بكل قسم (نوع، تسميات الأولوية…)',
    group: 'tickets',
    schema: ticketDepartmentFieldsSchema,
    default: DEFAULT_TICKET_DEPARTMENT_FIELDS, // IT §7.1
  }),
  'tickets.staffQueueDepartments': def({
    key: 'tickets.staffQueueDepartments',
    labelAr: 'موظفو القسم يرون قائمة تذاكر قسمهم ويستلمون غير المسند منها (لكل قسم؛ الافتراضي مفعّل)',
    group: 'tickets',
    schema: z.record(z.string(), z.boolean()),
    default: {}, // slice 4 review change 1: missing department = enabled
  }),
  'tickets.remindAfterBusinessDays': def({
    key: 'tickets.remindAfterBusinessDays',
    labelAr: 'تذكير مقدّم الطلب بعد الحل (أيام عمل)',
    group: 'tickets',
    schema: z.number().int().min(1),
    default: 3, // DECISIONS §8
  }),
  'tickets.autoCloseAfterBusinessDays': def({
    key: 'tickets.autoCloseAfterBusinessDays',
    labelAr: 'الإغلاق التلقائي بعد الحل (أيام عمل)',
    group: 'tickets',
    schema: z.number().int().min(1),
    default: 5, // DECISIONS §8
  }),
  'tickets.reopenWithinDays': def({
    key: 'tickets.reopenWithinDays',
    labelAr: 'السماح بإعادة الفتح خلال (أيام)',
    group: 'tickets',
    schema: z.number().int().min(1),
    default: 10, // DECISIONS §8
  }),
  'outbox.retentionDays': def({
    key: 'outbox.retentionDays',
    labelAr: 'الاحتفاظ بالأحداث المُسلَّمة في صندوق الأحداث (أيام)',
    descriptionAr:
      'تُحذف الأحداث المُسلَّمة الأقدم من هذه المدة يوميًا. الأحداث الفاشلة أو غير المعالَجة لا تُحذف.',
    group: 'system',
    schema: z.number().int().min(7).max(3650),
    default: 90, // go-live review G8
  }),
  'outbox.replayWindowDays': def({
    key: 'outbox.replayWindowDays',
    labelAr: 'إعادة تشغيل الأحداث غير المعالَجة لمشترك جديد خلال (أيام)',
    descriptionAr:
      'حدث لم يكن له مشترك ويزيد عمره عن هذه المدة يُعلَّم "منتهيًا" بدل إعادة تشغيله، ويمكن للمسؤول إعادته يدويًا.',
    group: 'system',
    schema: z.number().int().min(1).max(3650),
    default: 30, // go-live review G8
  }),
  'hr.advanceLimitHalalas': def({
    key: 'hr.advanceLimitHalalas',
    labelAr: 'الحد الأقصى للسلفة (هللة). فارغ = غير محدد بعد، يُعلَّم الطلب للموارد البشرية',
    group: 'hr',
    schema: z.number().int().positive().nullable(),
    default: null, // DECISIONS §5: not decided
  }),
  'hr.requestAutoCloseBusinessDays': def({
    key: 'hr.requestAutoCloseBusinessDays',
    labelAr: 'إغلاق وأرشفة الطلب المعتمد أو المرفوض تلقائياً بعد (أيام عمل)',
    group: 'hr',
    schema: z.number().int().min(0).max(60),
    default: 5, // H1: same cadence as the tickets' auto-close (DECISIONS §8); HR may close earlier by hand
  }),
  // ---- Attendance and leave [HR §3.4, §3.5.1; HR_PLAN §8; DECISIONS §21 Q1–Q7, Q16–Q17]
  'hr.attendance.defaultShiftCode': def({
    key: 'hr.attendance.defaultShiftCode',
    labelAr: 'جدول الدوام الافتراضي لمن لا إسناد له (رمز الوردية)',
    descriptionAr:
      'الدوام الأساسي 08:00–16:00 الأحد–الخميس ورمضان 10:00–16:00 (المادتان 98 و101) — مؤقت حتى اعتماد الموارد البشرية (Q1)',
    group: 'hr',
    schema: z.string().trim().min(2).max(30).nullable(),
    default: 'standard',
    provisional: true,
  }),
  'hr.attendance.geofenceDefaultRadiusM': def({
    key: 'hr.attendance.geofenceDefaultRadiusM',
    labelAr: 'نصف قطر النطاق الجغرافي الافتراضي للموقع (متر) عندما لا يحدَّد على الموقع',
    group: 'hr',
    schema: z.number().int().min(20).max(5000),
    default: 150, // Q2
    provisional: true,
  }),
  'hr.attendance.locationPolicy': def({
    key: 'hr.attendance.locationPolicy',
    labelAr: 'سياسة الموقع الجغرافي عند التسجيل: إلزامية الموقع، حد الدقة، والتعامل مع تعذر تحديده',
    descriptionAr: 'Q3: الموقع إلزامي، الدقة حتى ضِعف نصف القطر، وعند التعذر يُرفض التسجيل ويُطلب استثناء',
    group: 'hr',
    schema: locationPolicySchema,
    default: { requireLocation: true, maxAccuracyFactor: 2, onUnavailable: 'refuse' as const },
  }),
  'hr.attendance.exceptionMaxDays': def({
    key: 'hr.attendance.exceptionMaxDays',
    labelAr: 'الحد الأقصى لمدة طلب الاستثناء من النطاق الجغرافي (أيام)',
    group: 'hr',
    schema: z.number().int().min(1).max(90),
    default: 5, // Q3
  }),
  'hr.attendance.rules': def({
    key: 'hr.attendance.rules',
    labelAr: 'قواعد التأخير والغياب والانصراف المبكر والتنبيه بنسيان التسجيل (دقائق)',
    descriptionAr:
      'Q4: سماح 10 دقائق، الغياب = لا تسجيل حضور حتى نهاية الدوام، نسيان الانصراف يُعلَّم وتنتظر ساعاته طلب تعديل. latenessCounting: from_start = كامل التأخير من بداية الدوام (20 دقيقة مع سماح 15 تُحسب 20) أو beyond_grace = ما بعد السماح فقط (5) — مؤقت حتى اعتماد الموارد البشرية',
    group: 'hr',
    schema: attendanceRulesSchema,
    default: {
      graceMinutes: 10,
      earlyLeaveGraceMinutes: 10,
      absentWhenNoCheckIn: true,
      missingCheckoutPolicy: 'wait_correction' as const,
      missedCheckInAlertMinutes: 30,
      missedCheckOutAlertMinutes: 60,
      latenessCounting: 'from_start' as const,
    },
    provisional: true,
  }),
  'hr.overtime': def({
    key: 'hr.overtime',
    labelAr: 'سياسة العمل الإضافي: الموافقة المسبقة، النسبة، التقريب، الحد، وطريقة التعويض',
    descriptionAr:
      'Q5 + DECISIONS §21: 150% من أجر الساعة الأساسي (المادة 107)، تقريب 15 دقيقة، التعويض صرف / إجازة / اختيار الموظف (1.5 ساعة إجازة لكل ساعة، خلال 60 يوماً، حتى 30 يوماً سنوياً)',
    group: 'hr',
    schema: overtimePolicySchema,
    default: {
      requiresPreApproval: true,
      rateBp: 15_000,
      roundingMinutes: 15,
      monthlyCapMinutes: null,
      compensation: 'pay' as const,
      leaveHoursPerOvertimeHour: 1.5,
      leaveUseWithinDays: 60,
      leaveMaxDaysPerYear: 30,
    },
  }),
  'hr.attendance.correction': def({
    key: 'hr.attendance.correction',
    labelAr: 'طلبات تعديل البصمة: المهلة بالأيام والحد الشهري قبل التعليم للموارد البشرية',
    group: 'hr',
    schema: correctionPolicySchema,
    default: { deadlineDays: 7, perMonth: 3 }, // Q6
  }),
  'hr.leave.policies': def({
    key: 'hr.leave.policies',
    labelAr: 'سياسات الإجازات لكل نوع: الاستحقاق، الاستحقاق الشهري، الترحيل، نسبة الأجر، المرفقات، وتجاوز الرصيد',
    descriptionAr:
      'Q7 + تعديلات 2025 (DECISIONS §21): أرقام نظام العمل بمواده؛ إجازات الجمعية الخاصة (اضطرارية) مؤقتة حتى اعتماد الموارد البشرية',
    group: 'hr',
    schema: leavePoliciesSchema,
    default: DEFAULT_LEAVE_POLICIES,
    provisional: true,
  }),
  // ---- Payroll, performance, training [HR §3.6–3.8; HR_PLAN §8; DECISIONS §21 Q8, Q11, Q12, Q18]
  'hr.payroll.policy': def({
    key: 'hr.payroll.policy',
    labelAr: 'سياسة الرواتب: البدلات، أجر التأمينات (العمولات والحدين)، صيغة يوم الغياب، خصم التأخير، سقف قسط السلفة، حد الاستقطاع، يوم القطع ويوم الصرف، إظهار القسيمة',
    descriptionAr:
      'قرارات المالك 2026-11-24: يوم الغياب = (الأساسي + البدلات) ÷ 30؛ أجر التأمينات = الأساسي + السكن + العمولات الشهرية (مفعّل) بين 1,500 و45,000 ر.س؛ ساعة العمل الإضافي = الأجر الفعلي ÷ 30 ÷ ساعات اليوم + 50% × الأساسي ÷ 30 ÷ ساعات اليوم (المادة 107)؛ قسط السلفة فوق 10% من الأجر يحتاج إقرار الموظف وإلا يُقسَّم؛ الاستقطاعات ≤ 50% (المادة 92)؛ القطع 25 والصرف 27 — قائمة البدلات ومواعيد القطع والصرف مؤقتة حتى اعتماد الموارد البشرية',
    group: 'hr',
    schema: payrollPolicySchema,
    default: DEFAULT_PAYROLL_POLICY,
    provisional: true,
  }),
  'hr.payroll.gosiRates': def({
    key: 'hr.payroll.gosiRates',
    labelAr: 'نسب التأمينات الاجتماعية بتاريخ فعالية حسب المجموعة (سعودي قبل 3 يوليو 2024 / بعده / غير سعودي)',
    descriptionAr: 'DECISIONS §21 Q8: حصة الموظف وصاحب العمل بنقاط الأساس؛ المجموعة من الجنسية وتاريخ الانضمام للتأمينات على الملف',
    group: 'hr',
    schema: gosiRatesSchema,
    default: DEFAULT_GOSI_RATES,
  }),
  'hr.appraisal': def({
    key: 'hr.appraisal',
    labelAr: 'تقييم الأداء: الحد الأدنى للخدمة، مدة خطة التحسين، مواعيد الدورات نصف السنوية والسنوية',
    descriptionAr: 'Q11 (مقترح): خدمة 90 يوماً، خطة تحسين 90 يوماً، النصف الأول يناير–يونيو يُفتح 1 يوليو ويُسلَّم 31 يوليو، السنوي يُفتح 1 يناير ويُسلَّم 31 يناير — مؤقت حتى اعتماد الموارد البشرية',
    group: 'hr',
    schema: appraisalPolicySchema,
    default: DEFAULT_APPRAISAL_POLICY,
    provisional: true,
  }),
  'hr.discipline': def({
    key: 'hr.discipline',
    labelAr: 'الإجراءات الإدارية: سلّم الإنذارات، مهلة التظلم والبت فيه ومهلة الاعتراض أمام المحكمة، استثناء نهاية الأسبوع من مهل الموظف، مهلتا الاكتشاف والتحقيق، حدود الغرامة، من يُصدر ومن يعتمد',
    descriptionAr:
      'قرارات المالك 2026-11-24 و2026-11-25 (نظام العمل): التظلم خلال 30 يوماً من تاريخ الإبلاغ عدا العطل الرسمية ونهاية الأسبوع (الاستثناء الأخير إعداد مفعّل، ويخص مهل الموظف وحدها) ويثبت الجزاء بانتهائها دون تظلم؛ البت في التظلم كتابياً خلال 15 يوماً تقويمياً (مهمة بموعد نهائي تُحال لمدير الموارد البشرية عند تجاوزه)؛ بعد رفض التظلم أو انتهاء مهلة البت دون قرار — الأسبق — يبقى الجزاء موقوفاً 30 يوماً (مهلة الاعتراض أمام المحكمة العمالية) ثم يصير نهائياً، وتسجيل «اعتراض أمام المحكمة» يوقفه حتى تسجيل الحكم؛ كل جزاء بتحقيق له تاريخ انتهاء ومحضر (نص أو مرفق)، والاستجواب الشفهي للإنذار أو غرامة ≤ أجر يوم فقط؛ لا جزاء لمخالفة مضى على اكتشافها 30 يوماً ولا يُوقَّع بعد 30 يوماً من انتهاء التحقيق (المادة 71)؛ غرامة المخالفة الواحدة ≤ أجر 5 أيام ومجموع غرامات الشهر ≤ أجر 5 أيام والزائد يُرحَّل (المادة 70)؛ جزاء واحد لكل مخالفة — السلّم من المواد 66–73 مؤقت حتى مطابقته مع لائحة تنظيم العمل المعتمدة',
    group: 'hr',
    schema: disciplinePolicySchema,
    default: DEFAULT_DISCIPLINE_POLICY,
    provisional: true,
  }),
  'hr.training': def({
    key: 'hr.training',
    labelAr: 'التدريب: من يرفع الاحتياجات، من يعتمد الخطة السنوية، التذكير قبل الدورة',
    descriptionAr: 'Q12 (مقترح): مديرو الأقسام يرفعون الاحتياجات ومدير الموارد البشرية يعتمد الخطة',
    group: 'hr',
    schema: trainingPolicySchema,
    default: DEFAULT_TRAINING_POLICY,
  }),
  'hr.probationAlertDaysBefore': def({
    key: 'hr.probationAlertDaysBefore',
    labelAr: 'تنبيه انتهاء فترة التجربة قبل (أيام)',
    group: 'hr',
    schema: z.array(z.number().int().min(0)),
    default: [30, 7], // slice 1 review: time for HR to decide on an extension
  }),
  'hr.secondmentReportFirstReminderDays': def({
    key: 'hr.secondmentReportFirstReminderDays',
    labelAr: 'تذكير برفع تقرير الانتداب بعد انتهائه بـ (أيام)',
    group: 'hr',
    schema: z.number().int().min(0),
    default: 1, // slice 2 review: the day after the end date
  }),
  'hr.secondmentReportSecondReminderBusinessDays': def({
    key: 'hr.secondmentReportSecondReminderBusinessDays',
    labelAr: 'التذكير الثاني بعد الأول بـ (أيام عمل)',
    group: 'hr',
    schema: z.number().int().min(1),
    default: 3, // slice 2 review
  }),
  'hr.reportTypes': def({
    key: 'hr.reportTypes',
    labelAr: 'أنواع تقارير الموظفين إلى المدير المباشر',
    group: 'hr',
    schema: reportTypesSchema,
    default: [...DEFAULT_REPORT_TYPES] as { code: string; labelAr: string }[], // EP §14.1
  }),
  'hr.requestRoutes': def({
    key: 'hr.requestRoutes',
    labelAr: 'مسارات طلبات الموظفين: عبر المدير المباشر؟ ومن يعتمد نهائيًا',
    group: 'hr',
    schema: hrRequestRoutesSchema,
    default: DEFAULT_HR_REQUEST_ROUTES, // DECISIONS §5
  }),
  'hr.requestStageSlaBusinessDays': def({
    key: 'hr.requestStageSlaBusinessDays',
    labelAr: 'مهلة كل مرحلة في طلبات الموظفين (أيام عمل)',
    group: 'hr',
    schema: z.number().int().min(1),
    default: 2, // DECISIONS §5
  }),
  'notifications.emailEnabled': def({
    key: 'notifications.emailEnabled',
    labelAr: 'تفعيل قناة البريد الإلكتروني للإشعارات',
    group: 'notifications',
    schema: z.boolean(),
    default: false, // DECISIONS §9: off until the sending domain is verified
  }),
  'notifications.taskReminderDaysBefore': def({
    key: 'notifications.taskReminderDaysBefore',
    labelAr: 'تذكير بالمهمة قبل الاستحقاق بـ (أيام)',
    group: 'notifications',
    schema: z.number().int().min(0),
    default: 1,
  }),
  'documents.expiryAlertOffsetsDays': def({
    key: 'documents.expiryAlertOffsetsDays',
    labelAr: 'تنبيهات انتهاء الوثائق قبل (أيام)',
    group: 'general',
    schema: z.array(z.number().int().min(0)),
    default: [90, 30, 7],
  }),
  'general.organizationNameAr': def({
    key: 'general.organizationNameAr',
    labelAr: 'اسم الجهة',
    group: 'general',
    schema: z.string().min(1),
    default: 'جمعية عيني لإعادة التدوير التعاونية',
  }),
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFINITIONS)[K]['default'];
export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];
