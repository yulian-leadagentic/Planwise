# QA6 · PR-067: הערכת מודל אנשי הקשר (Contacts 3NF)

**תאריך:** 25.11.2026. **בסיס:** `staging` ב-`5c69a34`. **סטטוס:** הערכה בלבד. לא נכתב קוד, ולא בונים לפני אישור של יוליאן.
**מקור:** `qa6-fix-instructions.md`, חבילה 9. תיאור מסך היעד (`planwise-qa-repro-2026-11-23.md`, "PR-067: מסך היעד") לא נמצא ב-repo, ולכן ההערכה מבוססת על התיאור בהוראות.

## מסך היעד
טבלה אחת של אנשי הקשר בפרויקט:
- קיבוץ לפי Master Trade, ובתוכו לפי Sub-Discipline, בסדר קבוע (יזמות, אדריכלות, קונסטרוקציה, מערכות ...).
- עמודות: שם, תפקיד תקני, חברה, מייל, טלפון ונייד, הערות לפרויקט.
- מעבר בין "לפי תחום" ל"לפי חברה", מונים, חיפוש, PDF ו-CSV.

## בשורה אחת
החצי של "איש קשר וחברה" כבר קיים ומנורמל (אדם, ארגון, קשר `worker_of`, ייצוג לפי פרויקט, טלפון ונייד, שדה הערות על השיוך לפרויקט). מה שחסר הוא שני צירי הסיווג: **היררכיה של תחומים** (Master Trade מעל Sub-Discipline, בסדר קבוע) ו-**קטלוג של תפקיד תקני**. בלעדיהם אי אפשר לקבץ ולמיין את הטבלה כמו בעיצוב. ההערכה: 7 עד 10 ימי פיתוח, ועוד סבב אישור של רשימות התחומים והתפקידים.

---

## 1. מה כבר קיים

| מושג במסך | איפה במודל | מצב | פער |
|---|---|---|---|
| **תחום (Discipline)** | טבלה `disciplines` (`code`, `name`, `nameHe`, `sortOrder`, `isActive`) ו-`BusinessPartner.disciplineId` (ערך אחד, nullable) | קיים. קטלוג שטוח שמנוהל ב-Admin (`/admin/config/disciplines`). מידע בלבד, לא משפיע על הרשאות או זכאות. מוצג ב-Team (קיבוץ ופילטר לפי Discipline) ובעמוד Contacts | **שטוח**: אין הורה, ולכן אין Master Trade מעל Sub-Discipline. התחום שמור על איש הקשר, לא על השיוך לפרויקט |
| **Master Trade / Sub-Discipline** | אין | לא קיים | חסר לגמרי: אין טבלה, אין `parentId`, אין סדר קבוע לרמה העליונה |
| **תפקיד תקני** | ארבעה מועמדים, אף אחד לא מתאים (פירוט מתחת לטבלה) | לא קיים כמושג | חסר קטלוג וחסר שדה |
| **חברה (איש קשר ↔ ארגון)** | `PartnerRelationship` מסוג `worker_of` (אדם → ארגון, עם `isPrimary` ו-`validTo`). לפי פרויקט: `ProjectPartnerRole.onBehalfOfPartyId` (אדם מייצג ארגון) ו-`contactPartyId` (ארגון ואיש הקשר שלו) | קיים ומנורמל | אין כלל אחד שקובע "החברה של השורה". `getAttachedContacts` (Contacts › By Project) ממלא חברה רק לשורת ארגון עם `contactParty`, ולאדם שהוא עצמו הצד מחזיר `orgName = null` |
| **מייל, טלפון, נייד** | `BusinessPartner.email`, `phone`, `mobile`, ועוד מיילים ב-`business_partner_emails` | קיים | `GET /projects/:id/team` לא מחזיר `mobile` (ב-select של `party` יש רק `email` ו-`phone`) |
| **הערות לפרויקט** | `ProjectPartnerRole.notes` (TEXT) | העמודה קיימת, ונכתבת דרך `PATCH /project-partner-roles/:id` | לא מוחזרת ב-`getTeam` ואין לה ממשק. היא שמורה לפי **שיוך** (פרויקט × איש קשר × תפקיד), ולא לפי פרויקט × איש קשר. אם לאיש קשר יש שני תפקידים בפרויקט, יש לו שתי הערות |
| **מי בטבלה** | `GET /projects/:id/team`: `customer`, `customerContacts` (שיוכי `customer_contact`), `customerRelated` (קשרי D4 ללקוח, לקריאה בלבד), `projectTeam` (`participant`), `roleAssignments` (כל השאר) | קיים | צריך להחליט אילו מהקבוצות נכנסות (החלטה 5) |
| **קיבוץ, חיפוש, מונים** | Team tab (Phase 5): קיבוץ לפי Discipline, Role או בלי קיבוץ, חיפוש, פילטרים ומונים. Contacts › By Project / By Organization: טבלה מקובצת עם כותרות קבוצה דביקות ומיון | קיים | הקיבוץ הוא ברמה אחת, ואין סדר קבוע |
| **CSV** | דפוס בצד הלקוח: `downloadCsv` ב-`timesheet-report-page.tsx` ו-`exportCsv` ב-`import-history-page.tsx` | קיים כדפוס | אין רכיב משותף. מספיק להעתיק את הדפוס |
| **PDF** | שתי דרכים קיימות: `window.print()` עם print stylesheet (timesheet report), ו-pdfkit עם פונט NotoSansHebrew (`hr-report-pdf.service.ts`) | קיים | pdfkit לא מסדר טקסט מימין לשמאל (מתועד בקובץ: היפוך ידני של שורות עבריות בלבד, ושורות מעורבות נשברות). לטבלה עם שמות, מיילים ומספרים מעורבים, הדפסה מהדפדפן בטוחה יותר |

### למה אף מושג קיים לא מתאים כ"תפקיד תקני"
- **`ProjectRoleType`** (Engineer, Architect, External Contact, Supplier ...): הקטלוג של מה הצד עושה בפרויקט. הוא גס (כ-9 שורות), והוא גם קונפיגורציה של זכאות (`allowedPartnerKind`, `requiredPartnerRoleCode`, `requiredProfessionIds`). אם נוסיף לו עשרות תפקידים כמו "מתכנן חשמל" או "יועץ תאורה", כל אחד מהם ייכנס לרשימת "Add person" ולבדיקת הזכאות. לא מומלץ.
- **`Position`** (QA4 JT-1): התואר הארגוני של אדם בחברה שלו (CEO, VP, HR manager). זה לא התפקיד המקצועי שלו מול הפרויקט.
- **`Profession` / Qualifications**: רשימת הכישורים שמשמשת כשער זכאות לתפקידים פנימיים (BIM Manager, Domain lead ...). רלוונטית לעובדים, לא לאנשי קשר חיצוניים (ניתוח `analysis-jobtitle-vs-discipline-model.md`, Q3).
- **`ProjectPartnerRole.titleInProject`**: טקסט חופשי. אי אפשר לקבץ, למיין או לנרמל לפיו. אפשר להשתמש בו כמקור ל-backfill.

---

## 2. מה חסר

**טבלאות ושדות:**
1. **היררכיית תחומים**: Master Trade מעל Sub-Discipline, עם סדר קבוע בכל רמה.
2. **קטלוג תפקיד תקני**: `standard_roles`. כל תפקיד שייך ל-Sub-Discipline אחד (למשל "מתכנן חשמל" תחת "חשמל", תחת "מערכות").
3. **תפקיד תקני לאיש קשר**: `BusinessPartner.standardRoleId` (ראו החלטה 2 לגבי רמת פרויקט).
4. **הערה לפי פרויקט × איש קשר**, אם מחליטים שההערה לא שייכת לשיוך עצמו (החלטה 4).

**API:** endpoint אחד לפרויקט שמחזיר את השורות המוכנות (תחום, תפקיד, חברה, קשר, הערה), כתיבת הערה, וניהול הקטלוגים.

**ממשק:** המסך עצמו, שדה "תפקיד תקני" בכרטיס איש הקשר, ועריכת עץ התחומים ב-Admin.

---

## 3. המודל המוצע (3NF)

```
master trade ──< sub-discipline ──< standard_role ──< business_partner (contact)
  (disciplines, parent_id NULL)   (disciplines, parent_id = master)
```

- **`disciplines.parent_id`** (self-FK, nullable, שתי רמות בלבד, נאכף בשירות). שורה בלי הורה היא Master Trade. שורה עם הורה היא Sub-Discipline. `sort_order` קובע את הסדר בתוך כל רמה, ומכאן הסדר הקבוע (יזמות, אדריכלות, קונסטרוקציה, מערכות ...).
  - חלופה: טבלה נפרדת `trades` ועמודה `disciplines.trade_id`. השמות ברורים יותר, אבל כל Master Trade בלי חלוקה (למשל יזמות) יצטרך Sub-Discipline כפול. **ההמלצה היא `parent_id`**: השורות הקיימות ב-`disciplines` וה-`disciplineId` על אנשי הקשר ממשיכים לעבוד בלי שינוי.
- **`standard_roles`** (`id`, `code`, `name`, `name_he`, `discipline_id` FK ל-Sub-Discipline, `sort_order`, `is_active`). אותו מבנה כמו `positions`, ועם דף Admin באותו דפוס.
- **`business_partners.standard_role_id`** (nullable, FK, `ON DELETE SET NULL`).
- **תלות טרנזיטיבית:** אם לאיש קשר יש גם `standard_role_id` וגם `discipline_id`, התחום נקבע פעמיים (איש קשר → תפקיד → תחום), וזו הפרה של 3NF. הכלל המוצע: כשיש תפקיד תקני, התחום **נגזר ממנו** ב-API, ו-`discipline_id` נשאר רק לאנשי קשר בלי תפקיד (ולתאימות עם Team ו-Contacts שקוראים אותו היום). המסך מציג תמיד את התחום הנגזר.
- **חברה:** נגזרת, לא נשמרת שוב. הסדר: `onBehalfOfPartyId` של השיוך בפרויקט, אחר כך `worker_of` פעיל עם `isPrimary`, אחר כך `worker_of` פעיל יחיד. אם יש כמה ואין primary, השורה תסומן "כמה חברות". לשורת ארגון עם `contactParty`, הארגון הוא החברה.
- **הערה לפרויקט:** ההמלצה היא טבלה קטנה `project_contact_notes` (`project_id`, `party_id`, `note`, `updated_by`, `updated_at`, ייחודי על הזוג). ההערה תלויה בפרויקט ובאיש הקשר, לא בתפקיד, ולכן `ProjectPartnerRole.notes` משכפל אותה כשיש לאדם כמה תפקידים. החלופה הזולה: לשמור על השיוך הראשון הפעיל בלי טבלה חדשה (החלטה 4).

---

## 4. מיגרציה ו-backfill

**מיגרציות (כולן additive והפיכות, בדפוס ה-SQL הידני הקיים):**
1. `disciplines.parent_id` (nullable, FK לעצמה, אינדקס).
2. טבלת `standard_roles` ו-`business_partners.standard_role_id`.
3. (לפי החלטה 4) טבלת `project_contact_notes`.

**Backfills** (`POST /admin/backfills/...`, dry-run כברירת מחדל, הרצה אמיתית רק אחרי אישור, כמו ב-`abac635`):
1. **`pr067-trade-tree`**: יוצר את ה-Master Trades לפי הרשימה שיוליאן מאשר, ומשייך כל שורה קיימת ב-`disciplines` להורה. ה-dry-run מציג כל תחום קיים, את ההורה המוצע ואת מספר אנשי הקשר שלו. תחום שאין לו מיפוי ברור נשאר בלי הורה, ומופיע ברשימה להחלטה ידנית.
2. **`pr067-standard-roles`**: יוצר את הקטלוג לפי רשימה מאושרת, ומשייך תפקיד לאנשי קשר לפי סדר מקורות: (א) התאמה מדויקת של `titleInProject`, (ב) Qualification ראשי, (ג) `ProjectRoleType` של השיוכים שלו כשהוא חד משמעי (Architect → אדריכל). כל שורה ב-dry-run מציגה את המקור. מי שלא הותאם נשאר ריק, ומופיע ברשימה.
3. **`pr067-contact-discipline`**: לאנשי קשר בלי תחום ובלי תפקיד, מציע את התחום של הארגון שלהם (`worker_of`), אם לארגון יש תחום. גם כאן dry-run.
4. (לפי החלטה 4) העתקת `ProjectPartnerRole.notes` שאינם ריקים ל-`project_contact_notes`. סביר שאין כאלה, כי אין ממשק שכותב אותם.

**סיכון:** בלי רשימות מאושרות של Master Trade, Sub-Discipline ותפקידים תקניים אין מה לזרוע. זה צוואר הבקבוק, לא הקוד.

---

## 5. API

| Endpoint | מה | הערות |
|---|---|---|
| `GET /projects/:id/contacts?groupBy=discipline\|company&search=` | שורות מוכנות לטבלה: `partyId`, `name`, `standardRole{id,name}`, `subDiscipline{id,name,sortOrder}`, `masterTrade{id,name,sortOrder}`, `company{id,name}` או "כמה חברות", `email`, `phone`, `mobile`, `note`, `roles[]` (שמות `ProjectRoleType` לתצוגה) ומונים לכל קבוצה | `assertProjectAccess` כמו `getTeam`. ממיין לפי `sortOrder` של שתי הרמות. endpoint חדש ולא הרחבה של `getTeam`, שמשמש היום את כל טאב Team |
| `PUT /projects/:id/contacts/:partyId/note` | כתיבת הערה (`{ note }`) | `assertProjectManage`, כמו כתיבת שיוכים ב-round 4. רישום ב-Activity Log |
| `GET/POST/PATCH/DELETE /admin/config/disciplines` | קיים. להוסיף `parentId` ולאכוף שתי רמות | מחיקת Master Trade עם ילדים: חסום |
| `GET/POST/PATCH/DELETE /admin/config/standard-roles` | קטלוג חדש | אותו דפוס כמו positions |
| `PATCH /business-partners/:id` | להוסיף `standardRoleId` | אותו דפוס כמו `disciplineId` |
| ייצוא | **מומלץ בצד הלקוח**: CSV מהשורות שכבר נטענו (עם BOM ל-Excel בעברית), ו-PDF דרך `window.print()` עם print stylesheet | אם צריך PDF בצד השרת: `GET /projects/:id/contacts/export.pdf` עם pdfkit, אבל קיימת בעיית RTL בשורות מעורבות (ראו טבלה 1) |

---

## 6. הערכת גודל

| חלק | ימים |
|---|---|
| מיגרציות (`parent_id`, `standard_roles`, `standard_role_id`, ואולי `project_contact_notes`) ו-Prisma | 0.5 עד 1 |
| Admin: עץ תחומים (עריכת הורה וסדר) ודף קטלוג תפקידים תקניים | 1 עד 1.5 |
| שדה תפקיד תקני בכרטיס איש הקשר (מסונן לפי תחום) ותצוגת התחום הנגזר | 0.5 עד 1 |
| `GET /projects/:id/contacts`, כתיבת הערה, וגזירת החברה, עם specs | 1 עד 1.5 |
| המסך: קיבוץ בשתי רמות, מעבר לפי חברה, מונים, חיפוש, עריכת הערה, CSV, הדפסה ל-PDF, light ו-dark | 2 עד 3 |
| שלושה backfills עם dry-run, וסבב תיקונים אחרי הסקירה של יוליאן | 1 עד 1.5 |
| אימות מול staging | 0.5 |
| **סה"כ** | **7 עד 10 ימי פיתוח** (גודל M עד L), בלי זמן ההמתנה לאישור הרשימות |

אפשר לחלק לשני שלבים: (א) מודל, Admin ו-backfills, (ב) המסך. שלב (ב) לא שווה הרבה בלי (א), כי בלי היררכיה הקיבוץ יהיה ברמה אחת.

---

## 7. החלטות פתוחות ליוליאן

1. **הרשימות עצמן:** הרשימה המלאה של Master Trades בסדר הקבוע, ה-Sub-Disciplines תחת כל אחד, ורשימת התפקידים התקניים. בלי זה אי אפשר לזרוע. אפשר לייצא את התחומים הקיימים מ-staging כבסיס.
2. **תפקיד תקני: לאיש קשר או לשיוך בפרויקט?** ההמלצה: לאיש קשר (כך מוגדר "Contacts 3NF"), כי לרוב האנשים יש אותו תפקיד בכל הפרויקטים. אם צריך חריגה לפי פרויקט, אפשר להוסיף בהמשך `ProjectPartnerRole.standardRoleId` שגובר על הערך של איש הקשר.
3. **תחום לארגון:** האם ארגון (משרד יועצים) מקבל תחום משלו, ואנשי הקשר שלו יורשים אותו כשאין להם תחום? (משפיע על backfill 3.)
4. **הערה לפרויקט:** טבלה חדשה לפי פרויקט × איש קשר (מומלץ, 3NF), או `ProjectPartnerRole.notes` על השיוך הראשון (זול, בלי מיגרציה, אבל הערה כפולה כשיש כמה תפקידים)?
5. **מי בטבלה:** רק גורמים חיצוניים (לקוח, אנשי הקשר שלו, יועצים וספקים), או גם צוות AMEC? והאם להכניס את `customerRelated` (יועצים וספקים של הלקוח שאינם משויכים לפרויקט)?
6. **איפה המסך:** תצוגה חדשה בטאב Team של הפרויקט (מומלץ, שם כבר יש הקשר של פרויקט והרשאות), או החלפה של Contacts › By Project?
7. **PDF:** הדפסה מהדפדפן (מומלץ, עברית תקינה, בלי קוד שרת), או קובץ שנוצר בשרת (נשלח במייל או נשמר, אבל עם בעיית RTL)?
8. **איש קשר עם כמה חברות פעילות ובלי primary:** להציג "כמה חברות", או לחייב לבחור חברה לפי פרויקט (`onBehalfOfPartyId`)?
