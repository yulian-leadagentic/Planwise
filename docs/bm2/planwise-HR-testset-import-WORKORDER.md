# HR test data import — יוני + ספטמבר 2026 (קבוצת בדיקה של 8) — work order ל‑CC

**מקור:** Yulian — לבדוק את דוחות ה‑HR מול המערכת הישנה. נתונים חולצו מ‑dump המערכת הקיימת (`amec_srs`). staging · גיבוי לפני · dryRun קודם · idempotent · דיווח hash+files+DoD.

## למה CC (ולא דרך ה‑API)
`POST /time-entries` הוא `@OwnData()` → יוצר ל‑user הנוכחי בלבד; **אין נתיב אדמין ל‑userId אחר**. לכן טעינת **שעות עבודה** חייבת endpoint import צד‑שרת. (היעדרויות יש `POST /hr/employees/:id/absences`, ולוח `POST /calendar` — אבל נאחד הכל ב‑import אחד.)

## הנתונים
`docs/bm2/hr-testset-2026.json` (committed). מבנה:
- `months`: `2026-06` (22 ימי סטנדרט, בלי חגים) · `2026-09` (17.5, 7 חגים: ר"ה/יו"כ/סוכות).
- `employees[]`: `email` (מיפוי ל‑Planwise user **לפי email**), `worked[month][] = {date, minutes}` (מאוחד ליום), `absences[month][] = {date, bucket}`.
- `dailyStandardHours: 8.4` (בסיס יומי להשוואה למערכת הישנה).

## Import endpoint (admin, dryRun)
`POST /admin/backfills/import-hr-testset?dryRun=true` (admin:write). קורא את ה‑JSON מהריפו (או מ‑body). לכל עובד (email→userId; דלג+דווח אם לא נמצא):
1. **CalendarDay** — לכל חג ב‑`months[*].holidays`: ליצור/upsert `CalendarDay{date,name,type}` (type: HOLIDAY / HOLIDAY_EVE / CHOL_HAMOED) דרך CalendarService. סופ"ש (שישי/שבת) אוטומטי במנוע. (אם כבר קיים לוח 2026 ב‑staging — upsert, לא כפילות.)
2. **TimeEntry (שעות עבודה)** — לכל `worked` entry: `prisma.timeEntry.create({ userId, date, minutes, taskId:null })` (bucketId=null = שעות פרויקט/עבודה). idempotent: דלג אם כבר יש entry ל‑(userId,date) מהייבוא.
3. **AbsenceRecord (היעדרויות)** — לכל `absences` entry: `hr.createAbsence(userId, {date, bucket→typeId/bucketId})`. מיפוי bucket code → ה‑AbsenceType/Bucket הזרוע:
   `vacation`→חופשה · `sick`→מחלה · `holiday_eve_leave`→חופש ערב חג · `chol_hamoed_leave`→חופש חוה"מ · `reserve_duty`→מילואים · `holiday_full`→חג · `day_off`→יום חופש.
4. **dailyStandardHours** — לוודא שכל 8 ה‑users על 8.4 (ברירת מחדל; אם שונה — לעדכן, או להשאיר ולדווח).
- dryRun: קורא+מדווח (לכל עובד: worked/absences/calendar שייווצרו, ו‑users שלא נמצאו) בלי כתיבה.

## DoD
- dryRun מדווח נכון (צפוי: 8 עובדים, ~71 worked‑days ספט + ~160 יוני, ~84 היעדרויות ספט + מעט ביוני, 7 חגים ספט).
- ריצה אמיתית יוצרת את הרשומות; ריצה חוזרת = no‑op.
- אחרי הטעינה: להריץ `POST /hr/monthly/recompute` ל‑2026‑06 ו‑2026‑09, ולפתוח את דוח ה‑HR לקבוצה.

## בדיקה/השוואה (Yulian + אנליסט)
להשוות את דוח ה‑HR של Planwise לספט'/יוני מול הדוח של המערכת הישנה: סטנדרט (17.5 / 22 ימים), שעות בפועל, זיכויי היעדרות. יוני = baseline נקי (actual≈standard); ספטמבר = מבחן חגים+היעדרויות.
