# מודול HR — אפיון מערכת + תוכנית בנייה מדורגת (Planwise)

מקור אמת לדרישות: `planwise-hr-requirements-yael-confirmed` (Claude project). ניתוח לגסי + פער: בפרויקט. מסמך זה = **אפיון הבנייה** (design + work orders ל‑CC). מאומת מול הקוד ב‑staging (schema/RBAC/sidebar) בתאריך 2026‑10‑14.

> סקופ: שעות/נוכחות + ממשק להנהח"ש. **לא** חישוב שקלים. עיקרון יסוד: כל השעות לפי דיווח עובד, למעט זכאות B (זיכוי אוטומטי).

> **הכרעות Yulian (2026‑10‑14):** (1) `hr` **כן** ב‑`NO_ADMIN_BYPASS` — גייט מפורש (מידע בריאותי). (2) שני תפקידים ב‑v1: **HR Manager + HR Clerk**. (3) **Phase A נמסר ל‑CC** להרצה על staging.

---

## 0. מה אומת בקוד (בסיס לאפיון)

**מודל הרשאות קיים (רוכבים עליו, לא ממציאים):**
- `Module` (name + route + icon + sortOrder) × `RoleModule` עם דגלים: `canRead`, `canWrite`, `canDelete`, `canApprove`, `canExport`.
- FE: `usePermissions().can(module, action)` — actions: `read|write|delete|approve|export`; `isAdmin` = roleId===1 או שם Admin.
- BE: דקורטור `@RequirePermissions({ module, action })` + `roles.guard.ts`.
- **`NO_ADMIN_BYPASS`** (ב‑`roles.guard.ts`): מודולים שאפילו Admin חייב הרשאה מפורשת. כיום: `finance`, `data-import/*`. זה הדפוס לנתונים רגישים.
- מודולים ב‑seed (`apps/api/prisma/seed.ts`): Dashboard, Tasks, Time, Projects, Contracts, People(`/people`), Reports, Templates, Admin. (+`finance` כ‑gate ללא פריט תפריט.)
- דוגמת gate קיים: `finance:read` חוסם עמודות עלות/תקציב (projects.controller, data-import, users-importer `FINANCE_COLUMNS`).

**Sidebar קיים:**
- `NAV_SECTIONS` ב‑`apps/web/src/lib/constants.ts` — קבוצות: **Work / Planning / People / Insights / Setup**.
- סינון ב‑`sidebar.tsx` דרך `NAV_MODULE_MAP[item.href] → can(mod,'read')`; קבוצה שכל פריטיה סוננו — נעלמת.
- דפוס תת‑תפריט קיים: `sub-nav-layout.tsx` (תת‑ניווט שמאלי + Outlet) — נשתמש בו ל‑`/hr/*`.
- `User.dailyStandardHours` כבר קיים (מלא=8.4). `TimeEntry.location` (בית/משרד/אתר — הושלם). `CalendarDay` קיים.

**File-upload (אומת ע"י CC, 2026‑10‑14):** קיימת תשתית לשימוש חוזר —
- `apps/api/src/modules/files/files.service.ts`: Multer multipart, פענוח UTF‑8 לשמות (עברית עובד), MIME allowlist (כולל PDF/Word/Excel/תמונות), folder allowlist `attachments|avatars|projects|tasks|documents`, disk‑backed (`UPLOAD_DIR`), uuid‑prefixed, מחזיר `{ url, originalName }`. **הוספת תיקיית `hr` = שינוי שורה אחת ב‑`ALLOWED_FOLDERS`.**
- `project-files` + `ProjectFile` (schema ~L1519): union `upload|link|drive`. `TaskAttachment` (schema ~L1484): `{taskId, commentId?, fileName, fileUrl, fileSize, mimeType, uploadedBy}`.
- אין S3/MinIO/Cloudinary — disk מקומי + Google Drive (metadata‑only).
- **החלטה למסמכי HR:** מודל `EmployeeAttachment` חדש בתבנית `TaskAttachment` (עם `userId` במקום `taskId`) + `'hr'` ל‑`ALLOWED_FOLDERS`. בשלב A שומרים זכאות גם בלי קובץ; חיווט ה‑upload בפועל ב‑Phase B.

---

## 1. אובייקטי הרשאה ("מי רואה מה / מי מפיק דוחות")

### 1.1 מודול `hr` חדש + רגישות
נתוני HR כוללים **מידע בריאותי** (מחלה, הריון, פוריות, טיפול בילד) ותנאי העסקה — רגיש לפחות כמו עלויות.
- מוסיפים `Module { name:'HR', route:'/hr', icon:'ClipboardList' }`.
- **`hr` נכנס ל‑`NO_ADMIN_BYPASS`** (הוכרע) → נתוני HR לא נגלים אוטומטית לכל Admin; נדרשת הענקה מפורשת.

### 1.2 מיפוי פעולות → "מי רואה / מי מפיק"
| action | מה מתיר | מחזיק ברירת מחדל |
|---|---|---|
| `hr:read` | צפייה במרחב HR ובנתוני **כל** העובדים | HR Manager, HR Clerk |
| `hr:write` | עריכת שדות עובד, סימון זכאות B, הגדרות (היעדרות/buckets/לוח שנה/יום מקוצר) | HR Manager |
| `hr:approve` | **אישור חודשי** פר‑עובד (נעילה) | HR Manager |
| `hr:export` | **הפקת/ייצוא הדוח המרוכז** להנהח"ש | HR Manager, HR Clerk |
| `hr:delete` | מחיקת רשומת היעדרות/זכאות | HR Manager (אופ') |

> "מי מפיק דוחות" = `hr:export`. "מי מאשר חודש" = `hr:approve`. "מי רואה הכל" = `hr:read`.

### 1.3 Self‑service (עובד רגיל) — ללא `hr`
עובד ללא `hr:*` רואה **רק את עצמו** דרך `/time` הקיים (self‑scope). נוסיף טאב "סיכום חודשי" (תקן/בפועל/משוקלל/סטייה/ניצול מכסות שלו בלבד). endpoint self (`/time/my-monthly-summary`) דורש אימות בלבד, מסנן ל‑`userId` של המבקש — לא דורש `hr:read`. כלל ברזל: `hr:read` = "כל העובדים"; בלעדיו = "רק אני".

### 1.4 תפקידים (v1: HR Manager + HR Clerk — הוכרע)
- **Admin** — קונפיג מערכת; לא מקבל HR אוטומטית (1.1).
- **HR Manager** (יעל) — `hr:read/write/approve/export` + `time:read` (כל העובדים).
- **HR Clerk / רכז/ת שכר** — `hr:read` + `hr:export` (מפיק דוחות, בלי קונפיג/אישור).
- **Employee** — `time:read/write` (עצמו), בלי `hr`.
- **Finance** — `finance:read` — נפרד, ללא שינוי.
- **Team Manager** (עתידי) — צוות בלבד; מחוץ ל‑v1.

### 1.5 נקודות אכיפה
- BE: `@RequirePermissions({module:'hr',action})` על כל ה‑controllers; ייצוא→`export`, אישור→`approve`, קונפיג→`write`. `hr` ל‑`NO_ADMIN_BYPASS`.
- FE: `NAV_MODULE_MAP['/hr']='hr'`; `RoutePermissionGuard` על `/hr/*`; טאבים נחסמים פר‑פעולה (reports→`export`, settings→`write`).
- כל endpoint שמחזיר נתוני עובד‑אחר נבדק ל‑`hr:read`; endpoint self מסנן לעצמו.

---

## 2. תפריט צד

פריט **"HR" (משאבי אנוש)** תחת קבוצת **People** ב‑`NAV_SECTIONS`, מוצג רק עם `can('hr','read')`.
`/hr` פותח layout עם תת‑ניווט (דפוס `sub-nav-layout.tsx`):

| נתיב | תווית | הרשאת טאב | תוכן |
|---|---|---|---|
| `/hr/employees` | תיקי עובדים | `hr:read` (עריכה: `hr:write`) | roster + כרטיס עובד HR |
| `/hr/review` | סקירה ואישור חודשי | `hr:read` (אישור: `hr:approve`) | תקן/בפועל/משוקלל/סטייה + אישור |
| `/hr/reports` | דוח מרוכז (הנהח"ש) | `hr:export` | עמוד‑לעובד + ייצוא + בחירת עובדים |
| `/hr/settings` | הגדרות HR | `hr:write` | לוח שנה/יום מקוצר · סוגי היעדרות · buckets A/B/C |

עובד רגיל: אין פריט HR; "סיכום חודשי" שלו כטאב תחת **Work → Time**.
אייקונים (lucide): HR=`ClipboardList`, employees=`Users`, review=`CalendarCheck`, reports=`FileSpreadsheet`, settings=`Settings2`.

---

## 3. מודל נתונים (Prisma deltas)

> כל שינוי סכימה: **גיבוי DB staging לפני migration**, dry‑run, אישור Yulian. CC לא מריץ backfill אוטומטית. staging בלבד — אין נגיעה ב‑prod.

**3.1 הרחבת `User`** (שדות חסרים בלבד; dailyStandardHours קיים):
- `employmentType EmploymentType?` (enum `{ GLOBAL, HOURLY }` — גלובלית/שעתית).
- `accountingEmployeeNumber String?` — ידני, nullable; null→ממוין אחרון בדוח.
- לבדוק אם קיימים employmentStart/EndDate, department, weeklyRestDays — אם לא, להוסיף; אם כן, לא לשכפל.

**3.2 `HrSettings`** (singleton/לפי ארגון):
- `shortDayHoursHolidayEve Decimal @default(5)` · `shortDayHoursCholHamoed Decimal @default(5)` · `minHoursPerDay Decimal @default(5)`. (ערב חג וחוה"מ ניתנים להגדרה בנפרד.)

**3.3 `CalendarDay` — סוג יום:** `dayType CalendarDayType { REGULAR, HOLIDAY, HOLIDAY_EVE, CHOL_HAMOED, REST }` (למפות שדות קיימים כמו `isHoliday`, לא לשבור).

**3.4 `AbsenceType` (גנרי ומתרחב):** `id, code, nameHe, unit AbsenceUnit { DAY, HOUR }, requiresDocument Boolean, deductsFromSick Boolean @default(false), maxPerYear Int?, halfDay Boolean @default(false), active, sortOrder, isSystem`.
Seed: חג · חופש בערב חג(halfDay) · חופש בחוה"מ(halfDay) · חופשה · מחלה(doc) · מילואים(doc) · טיפול בילד צרכים מיוחדים(doc, deductsFromSick, maxPerYear=18, DAY) · נשות מילואים(doc) · פטירת קרוב דרגה ראשונה(DAY, רצף 7 ימים קלנדריים). **לידה — לא נזרעת.**

**3.5 `AbsenceRecord`:** `id, userId, absenceTypeId, dateFrom, dateTo, amount Decimal, documentFileId?, note, createdById, createdAt`. יום בודד: dateFrom=dateTo. חצי יום: amount=0.5.

**3.6 `SpecialHourBucket` (A/B/C):** `id, code, nameHe, behavior BucketBehavior { A, B, C }, unit AbsenceUnit, requiresDocument, dailyAmount Decimal? (B), maxPerYear Decimal? (C, מעקב), minDailyStandard Decimal? (B: תקן≥8), defaultCreditMode BucketCreditMode @default(REPORTED), active, sortOrder`. `enum BucketCreditMode { REPORTED, AUTO }`.
Seed: הנקה/הורות(B,שעה,1,min8,doc) · נשות מילואים(B,שעה,1,min8,doc) · הריון(C,שעה,max40,doc) · פוריות(C,שעה,max40,doc) · טיפול בילד(C,שעה,max52,doc) · השתלמות/רוחב/ישיבות/תרבות(A).

**3.7 `EmployeeBucketEligibility` (B פר‑עובד):** `id, userId, bucketId, dailyAmount Decimal, startDate (default=יום הסימון), endDate (default=סוף השנה הקלנדרית, editable), creditMode BucketCreditMode? (null→יורש מה‑bucket), documentFileId?, active, createdById, createdAt`. האופציה נפתחת לעובד רק אם יש רשומה פעילה. **שני מצבי זיכוי (הכרעה — הערת יעל 2026‑10‑15):** `REPORTED` (ברירת מחדל — העובד מדווח בעצמו את השעה בכל יום עבודה כרשומת שעה ל‑bucket; אין הפחתת תקן) או `AUTO` (המערכת מפחיתה את התקן של אותו יום בכמות הזכאות, רק בימים שהעובד עבד בפועל). HR בוחר/ת פר‑זכאות. שתי הדרכים נותנות אותה סטייה סופית.

**3.8 `TimeEntry` — דיווח A/C/B‑reported:** `specialHourBucketId String?` (nullable). A = שעת עבודה רגילה ל‑bucket; C = ניצול מדווח עם מסמך; **B במצב `REPORTED`** = השעה מדווחת כאן ע"י העובד (נפתח רק לזכאי בתוך חלון הזכאות). B במצב `AUTO` = לא מדווח כאן (זיכוי אוטומטי במנוע).

**3.9 `MonthlyAttendance`:** `id, userId, year, month, monthlyStandard, actualHours, weightedHours, deviation, sickDays, vacationDays, daysOffice, daysHome, daysSite, status MonthlyStatus { OPEN, APPROVED, LOCKED }, approvedById?, approvedAt?, computedAt`. ייחוד (userId, year, month).

**3.10 `EmployeeAttachment`** (מסמכי עובד, תבנית `TaskAttachment`): `id, userId, fileName, fileUrl, fileSize, mimeType, uploadedBy, createdAt`. + `'hr'` ל‑`ALLOWED_FOLDERS` ב‑`files.service.ts`. (מודל בלבד ב‑A; חיווט upload ב‑B.)

---

## 4. מנוע החישוב (Phase C)
לכל עובד×חודש לפי `CalendarDay`:
1. **תקן היום** (ימי עבודה; HOLIDAY/REST=0): REGULAR=`user.dailyStandardHours`; HOLIDAY_EVE=`shortDayHoursHolidayEve`; CHOL_HAMOED=`shortDayHoursCholHamoed`. זכאות B פעילה: אם `creditMode=AUTO` → הפחת `dailyAmount` מתקן היום **רק אם עבד בפועל** (לא חופש/מחלה/חג). אם `creditMode=REPORTED` → **אין** הפחתת תקן; השעה נספרת כרשומת `TimeEntry` רגילה שהעובד דיווח (נכנסת לשעות בפועל). בשני המצבים ביום חופש/מחלה/חג אין תוספת — יום ההיעדרות ממילא מזוכה כיום מלא, כך שאין זיכוי כפול.
2. **תקן חודשי** = Σ תקני הימים.
3. **שעות בפועל** = Σ `TimeEntry.hours` (כולל ימים קצרים ושעות A/C).
4. **משוקללות** = בפועל + Σ זיכוי ימי היעדרות לפי תקן אותו יום.
5. **סטייה** = משוקלל − תקן חודשי (שלילי=חוסר).
6. ספירות: ימי מחלה, ימי חופש (כולל חצאי ערב חג/חוה"מ), ימי בית/משרד/אתר.
7. מכסות C: ניצול מצטבר מול `maxPerYear` — תצוגה בלבד, ללא חסימה.
כללים: אין ש"נ, אין עיגול, מינ' 5ש'/יום; יום <5ש' לא נספר כיום עבודה (חופש/מחלה אם יש אישור) אך שעותיו בסך.

---

## 5. דוח מרוכז להנהח"ש (Phase D)
עמוד לכל עובד, סדר רץ לפי `accountingEmployeeNumber` עולה, **null→אחרון**. ראש עמוד: שם · תקן חודשי · בפועל · משוקלל · סה"כ ימי מחלה · סה"כ ימי חופש (כולל חצאי). טבלה: תאריך · יום בשבוע · התחלה · סיום · סה"כ שעות · סוג יום. הפקה מרוכזת + בחירת עובד/ים. ייצוא (xlsx + pdf). גייט `hr:export`.

---

## 6. שלבי בנייה
- **Phase A** — תיק עובד + שלד מודול HR + הרשאות + תפריט. (§7 — נמסר ל‑CC.)
- **Phase B** — לוח שנה + יום מקוצר + טבלת היעדרויות גנרית + buckets A/B/C + העלאת מסמך (חיווט `EmployeeAttachment`).
- **Phase C** — מנוע חודשי (§4) + `MonthlyAttendance` + `/hr/review` + אישור + self‑summary תחת /time.
- **Phase D** — דוח מרוכז (§5) + ייצוא + בחירת עובדים.

הרחבות עתידיות (לא v1): Team Manager scope; יתרות חופשה/מחלה מצטברות; feed ישיר ללשכת שכר.

---

## 7. Phase A — Work Order ל‑CC

**מטרה:** תשתית מודול HR + הרשאות + תפריט + תיק עובד עם השדות החדשים וזכאויות B. ללא מנוע חישוב/דוחות (C/D).

**גארדריילים (מחייב):** staging בלבד, לא לגעת ב‑prod (Yulian ידפלוי prod). **גיבוי DB staging לפני migration.** dry‑run למיגרציה, Yulian מאשר לפני apply. CC לא מריץ backfill אוטומטית. בלי סודות ב‑repo. **attribution:** כל סשן משתמש במחרוזת ש‑harness שלו מספק (CC → `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`). לא לקבע מודל ספציפי מהאפיון.

**A1 — Prisma + migration (reversible, migration נפרדת):**
- `enum EmploymentType { GLOBAL HOURLY }`; `User.employmentType EmploymentType?`; `User.accountingEmployeeNumber String?`. לבדוק שדות קיימים לפני הוספה.
- `model HrSettings` (§3.2) + שורת ברירת מחדל (5/5/5) ב‑seed.
- `model SpecialHourBucket` + `enum BucketBehavior`, `enum AbsenceUnit`, `enum BucketCreditMode { REPORTED, AUTO }` + `defaultCreditMode @default(REPORTED)` — **מודל + seed בלבד** (CRUD ב‑B). seed §3.6, ה‑B buckets עם defaultCreditMode=REPORTED.
- `model EmployeeBucketEligibility` (§3.7).
- `model EmployeeAttachment` (§3.10) + `'hr'` ל‑`ALLOWED_FOLDERS` — מודל+allowlist בלבד.

**A2 — RBAC seed:**
- `Module { name:'HR', route:'/hr', icon:'ClipboardList' }`.
- `'hr'` ל‑`NO_ADMIN_BYPASS` ב‑`roles.guard.ts`.
- תפקידים: **HR Manager** (hr:read/write/approve/export + time:read), **HR Clerk** (hr:read+export). לא לדרוס תפקידים קיימים.

**A3 — BE module `hr`:**
- `GET /api/v1/hr/employees`, `GET /:id` — `hr:read`.
- `PATCH /:id` (employmentType, accountingEmployeeNumber, dailyStandardHours, תאריכי העסקה) — `hr:write`.
- `GET/POST/PATCH/DELETE /:id/eligibilities` — `hr:write`. POST defaults: startDate=today, endDate=31/12 השנה (editable). validate: dailyAmount>0, endDate≥startDate, אזהרה אם `minDailyStandard` ו‑dailyStandardHours קטן ממנו.

**A4 — FE:**
- `constants.ts`: פריט `{ label:'HR', href:'/hr', icon:ClipboardList }` בקבוצת People; `NAV_MODULE_MAP['/hr']='hr'` ב‑`sidebar.tsx`.
- `/hr` layout עם `sub-nav-layout`; בונים **`/hr/employees` בלבד**; שאר הטאבים placeholder "בקרוב". `RoutePermissionGuard` על `/hr/*` (hr:read).
- `/hr/employees`: roster (שם, מחלקה, תקן יומי, סוג העסקה, מס' הנהח"ש) + כרטיס עובד: עריכת שדות (hr:write) + ניהול זכאויות B (הוספה עם תאריכי ברירת‑מחדל editable). עיצוב לפי skill `planwise-design` (shadcn/ui + Tailwind, light+dark).

**Definition of Done (Phase A):**
- typecheck + build ירוקים (web + api).
- עובד ללא `hr` — לא רואה פריט HR ולא ניגש ל‑`/hr`.
- Admin ללא הענקת `hr` מפורשת — לא רואה נתוני HR (NO_ADMIN_BYPASS מאומת).
- HR Manager רואה roster, עורך שדות, מסמן זכאות B עם ברירות המחדל (היום→31/12).
- migration רצה על staging לאחר גיבוי; dry‑run הוצג ואושר.
- אין regression ב‑`/time` ובמיקום (בית/משרד/אתר).

**מסירה:** להחזיר קודם schema diff + migration dry‑run לאישור Yulian, ואז לבנות.

---

## 7.1 הכרעות Phase A (Yulian, 2026‑10‑15 — תשובה ל‑5 שאלות CC)
1. **Migration split:** migration סכימה **אחת** ל‑A1 (עמודות + טבלאות, additive). **seed של קטלוגים** (`special_hour_buckets`, `hr_settings`, `HR` module, תפקידים) דרך `seed.ts` עם **upsert אידמפוטנטי** — אותו דפוס שבו Modules/Roles כבר נזרעים — ולא migration שנייה של DML. ("migration נפרדת" באפיון = נפרדת מ‑Phases B/C/D, לא schema מול seed.)
2. **weeklyRestDays על User:** **דחייה ל‑Phase C** (נחוץ רק למנוע החודשי). ב‑A מוסיפים רק שדות שה‑Phase משתמש בהם.
3. **documentFileId על EmployeeBucketEligibility:** nullable פשוט ב‑A1, **ללא FK**. ה‑FK ל‑`employee_attachments` נוחת ב‑Phase B עם חיווט ה‑upload. ✔
4. **isSystem=true** על כל ה‑buckets הזרועים. ✔ (אדמין יכול להוסיף נוספים.)
5. **שני תפקידים מיום ראשון:** HR Manager + HR Clerk — **לזרוע את שניהם עכשיו**. ✔
6. **מצב זיכוי B (הערת יעל 2026‑10‑15):** לא לכפות אוטומטי. להוסיף `BucketCreditMode { REPORTED, AUTO }` — `defaultCreditMode` על ה‑bucket (ברירת מחדל **REPORTED**) + `creditMode` override על הזכאות. ב‑Phase A: רק הוספת ה‑enum + העמודות (schema). ההתנהגות (דיווח עצמי מול אוטומטי) ב‑Phases B/C. ה‑B buckets הזרועים (הנקה/הורות, נשות מילואים) = REPORTED כברירת מחדל.

## 8. סטטוס הכרעות (נסגר 2026‑10‑14)
1. `hr` ב‑`NO_ADMIN_BYPASS` — **כן**. ✅
2. תפקידים v1 — **HR Manager + HR Clerk**. ✅
3. Phase A — **נמסר ל‑CC** (staging). ✅
4. File‑upload — תשתית קיימת (`files.service.ts`); מסמכי HR דרך `EmployeeAttachment` + folder `hr`. חיווט upload ב‑Phase B.

---

## 9. סטטוס בנייה (עדכון שוטף)
- **Phase A — ✅ merged** (A1 schema/migration `20261015000000_hr_phase_a`, A2 RBAC seed, A3 BE `/hr/employees`+eligibilities, A4 FE `/hr` + roster). commits 19e2f21→9a55c7b.
- **Phase B Chunk 1 — ✅ merged, ממתין ל‑deploy+seed על staging:** B1 migration `20261015010000_hr_phase_b` (CalendarDay remap holiday→HOLIDAY/half_day→HOLIDAY_EVE/company_day_off→REST/special→CHOL_HAMOED; absence_types; absence_records; time_entries.special_hour_bucket_id; eligibility doc FK), B2 seed AbsenceType ×9. commits 233853b, 016cc8d.
  - preflight (read‑only): `SELECT type,COUNT(*) FROM calendar_days GROUP BY type;` → HOLIDAY 13, HOLIDAY_EVE 1. seed → `absence_types`=9.
  - **גייט:** גיבוי staging לפני apply (אחריות Yulian — Railway CLI לא מותקן במכשיר, אין הרצת pg_dump מרחוק).
- **Phase B Chunk 2 — ⏳ בהמתנה ל‑GO:** BE CRUD (CalendarDay/AbsenceType/AbsenceRecord/SpecialHourBucket/HrSettings PATCH/EmployeeAttachment upload/TimeEntry bucket) + FE `/hr/settings` + employee drawer (Absences+Documents) + bucket picker בטפסי הזמן.
  - **תזכורת סקופ ל‑Chunk 2:** picker השעות חייב לכסות **A (לכולם) + C (לכולם) + B במצב REPORTED (רק לזכאי בתוך חלון הזכאות)** — לא רק C.

### 9.1 הכרעת gating ל‑picker של buckets (Yulian, 2026‑10‑15) — אפשרות A + חידוד
**הכרעה: A** — קטלוג ה‑buckets הוא תוויות קטגוריה, לא PHI. חובה שעובד רגיל יראה את ה‑picker: שעות A (השתלמות/רוחב/ישיבות/תרבות) ו‑C (הריון/פוריות/טיפול‑בילד, "פתוח לכולם") מדווחות ע"י העובד עצמו — אפשרות C הייתה שוברת את ליבת "שעות שאינן על פרויקט".
**חידוד מחייב (לא להחזיר את כל הקטלוג לכולם):**
- אל תרפה את `GET /hr/buckets` הקיים (הוא קטלוג‑אדמין, נשאר `hr:read`). במקום זה **endpoint caller‑scoped** "ה‑buckets שאני יכול לבחור" לכל משתמש מאומת, שמחזיר: **A + C (active) לכולם**, ו‑**B רק אם לקורא יש זכאות פעילה בתוך החלון** (ובמצב REPORTED). כך non‑eligible לא רואה B בכלל.
- **אכיפת‑אמת בצד שרת (קריטי):** ב‑create/update של `TimeEntry`, אם `specialHourBucketId` הוא bucket מסוג B — **דחה** אלא אם לקורא יש `EmployeeBucketEligibility` פעילה שהחלון שלה מכסה את תאריך הרשומה; דחה גם bucket לא‑active. ה‑picker הוא UX בלבד; השמירה היא השער האמיתי. (לוודא שקיים — אם לא, להוסיף כ‑follow‑up לפני Phase C.)

**אישור improvisations של CC (סבב B2 Chunk 2) — כולם מאושרים:** GET absences תחת `hr:write` (קריאת הערות רפואיות = רמת write); fail‑closed על requiresDocument ב‑PATCH; `assertAttachmentOwnedBy`; הרחבת פטירה ל‑7 ימים רק ב‑CREATE; activity‑log על כל מוטציה (audit מיום ראשון — מצוין ל‑C/D).

---

## 10. Phase C — Work Order (מפורט): מנוע חודשי + משוקלל/סטייה + אישור חודשי

**מטרה:** חישוב חודשי פר‑עובד (תקן/בפועל/משוקלל/סטייה + ספירות), מסך סקירה+אישור ל‑HR, וסיכום‑עצמי לעובד. **ללא** דוח מרוכז/ייצוא (Phase D).

**גארדריילים:** כמו A/B — staging בלבד, גיבוי DB לפני migration, dry‑run לאישור, בלי backfill אוטומטי, attribution של harness ה‑CC.

**C1 — Prisma + migration:** `model MonthlyAttendance` (§3.9) + `enum MonthlyStatus { OPEN, APPROVED, LOCKED }`, unique `(userId, year, month)`. additive.

**C2 — מנוע חישוב (`hr-monthly.service.ts`, deterministic, pure):** `computeMonth(userId, year, month)` לפי §4:
- **תקן יום:** REGULAR=`dailyStandardHours`; HOLIDAY_EVE=`shortDayHoursHolidayEve`; CHOL_HAMOED=`shortDayHoursCholHamoed`; HOLIDAY/REST=0. חסר שורת `CalendarDay` → REGULAR מרומז.
- **B·AUTO:** זכאות פעילה (חלון מכסה את היום) + `creditMode=AUTO` → הפחת `dailyAmount` מתקן היום **רק אם העובד עבד בפועל באותו יום** (לא היעדרות/חג/מנוחה).
- **B·REPORTED:** אין הפחתת תקן; השעה היא `TimeEntry` עם `specialHourBucketId`=B → נספרת ב‑actualHours כרגיל.
- **שעות בפועל** = Σ `TimeEntry.hours` בחודש (A/C/B‑reported, כולל ימים קצרים).
- **משוקללות** = בפועל + Σ זיכוי היעדרויות לפי תקן אותו יום (יום=תקן היום; חצי יום ערב חג/חוה"מ=0.5×; שעתי=שעות הרשומה). טיפוסים `deductsFromSick` עדיין מזוכים כהיעדרות.
- **סטייה** = משוקלל − תקן חודשי. **אין זיכוי כפול:** ביום היעדרות אין תוספת B.
- **ספירות:** ימי מחלה, ימי חופש (כולל חצאים), ימי בית/משרד/אתר (ימי עבודה distinct לפי `location`).
- **יום <5ש' (`minHoursPerDay`)** לא נספר כיום עבודה (→ חופש/מחלה אם מתועד) אך שעותיו בסך בפועל.
- **מכסות C:** ניצול מצטבר שנתי מול `maxPerYear` — תצוגה בלבד.
- Upsert ל‑MonthlyAttendance בסטטוס OPEN; **לא** לדרוס שורה APPROVED/LOCKED ללא recompute מפורש.

**C3 — BE endpoints:**
- `POST /hr/monthly/recompute { userIds?, year, month }` — `hr:write` (כותב שורות OPEN).
- `GET /hr/monthly?year&month` — `hr:read` — טבלת כל העובדים לסקירה.
- `GET /hr/monthly/:userId?year&month` — `hr:read` — פירוט יום‑יום.
- `POST /hr/monthly/:userId/approve { year, month }` — `hr:approve` → APPROVED + approvedBy/At. reopen → `hr:approve`.
- `GET /time/my-monthly-summary?year&month` — **מאומת בלבד (self)**, מסנן ל‑caller — לא דורש `hr:read`.
- אם אכיפת זכאות B על `TimeEntry` לא נוספה ב‑B — להוסיפה כאן (§9.1).

**C4 — FE:**
- `/hr/review`: בורר חודש + טבלת עובדים (שם, מס' הנהח"ש, תקן, בפועל, משוקלל, סטייה, מחלה, חופש, סטטוס) → שורה פותחת פירוט יום‑יום; כפתור **אישור** (hr:approve) + **חישוב מחדש** (hr:write); סטייה שלילית באדום.
- `/time` טאב **"סיכום חודשי"**: תקן/בפועל/משוקלל/סטייה של ה‑caller + ניצול היעדרויות/מכסות C שלו.

**DoD (Phase C):**
- unit tests למנוע: חודש מלא 8.4; חודש עם ערב חג/חוה"מ=5; B·AUTO מפחית רק בימים שעבד; B·REPORTED נספר בבפועל בלי הפחתה; שקלול היעדרויות כולל חצאי ימים; פטירה 7 ימים קלנדריים; יום<5ש' לא יום עבודה אך שעותיו בסך; אין זיכוי כפול ביום היעדרות.
- אישור נועל; recompute לא דורס APPROVED בשקט.
- self‑summary מציג רק את ה‑caller.
- typecheck+build ירוקים; גיבוי staging לפני migration.

---

## 11. גייט תפעולי (2026‑10‑16)
- **גיבוי staging נלקח ✅** (אישור Yulian). הגייט למיגרציות B + C נסגר.
- רצף הרצה ל‑B: deploy (Railway auto) → `prisma migrate deploy` → preflight `SELECT type,COUNT(*) FROM calendar_days GROUP BY type;` (HOLIDAY 13, HOLIDAY_EVE 1) → seed → `absence_types`=9.
- **Phase C — GO.** CC בונה C1→C4 לפי §10; migration C1 (MonthlyAttendance) מכוסה ע"י אותו גיבוי — להציג dry‑run ואז apply.
