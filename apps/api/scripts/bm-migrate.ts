/**
 * BM data migration importer — whole-project import from an Excel file
 * plus an XML zone tree.
 *
 *   npx ts-node scripts/bm-migrate.ts --project 260066
 *   npx ts-node scripts/bm-migrate.ts --project 260066 --commit
 *
 * Dry-run by default: parses the Excel + XML, resolves what would happen,
 * and writes a JSON report to scripts/bm-migrate.report.json. Nothing
 * touches the database until you pass --commit.
 *
 * Idempotent re-runs: natural keys are project_number, email,
 * `lot/building/level id from XML`, task code or (zone, code) compound.
 * Re-running a committed import with --commit is a no-op if everything
 * is already present.
 *
 * Rollback: every entity created/linked is recorded in ImportLog with
 * the run's DataImport.id. Use scripts/bm-rollback.ts --import-id <id>
 * to undo a committed run; see that file for the safety story.
 *
 * Decisions locked in by the user (task #32):
 *   • Customers → main_role_type=customer.
 *   • Projects are legacy — every deliverable name becomes a
 *     PROJECT-SCOPED ProjectDeliverable (no fuzzy-match to the catalog).
 *   • Phase → null (column doesn't exist in v3).
 *   • Users with category != Employee → skipped this phase.
 *   • Users with is_archive=1 → imported as isActive=false.
 *   • Users with empty email → skipped.
 *   • Default authorization role for imported users → Employee.
 *   • Departments → upsert from the Department sheet.
 *   • Services / Professions → auto-create when referenced.
 *   • Employee_Assignments missing real start/end → 1900-01-01 sentinel.
 *   • Project Tasks with Zone = "No zone" → project-level (NA bucket).
 *   • Currency → ILS hardcoded.
 *   • XML L↔C prefix translation for level IDs.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const PROJECT_FILTER = (() => {
  const i = args.indexOf('--project');
  return i >= 0 ? args[i + 1] : null;
})();
const EXCEL_PATH =
  args.find((a) => a.endsWith('.xlsx')) ??
  path.resolve(__dirname, '../../../docs/BM Data migration (3).xlsx');
const XML_PATH = path.resolve(__dirname, '../../../docs/migration/ALL (1).XML');
const REPORT_PATH = path.resolve(__dirname, 'bm-migrate.report.json');

// Sentinel date used when the source data has no real start/end (per user).
// 1900-01-01 is unmistakably legacy — reports can filter it out.
const LEGACY_DATE_SENTINEL = new Date('1900-01-01T00:00:00.000Z');

// ─── tiny logger ─────────────────────────────────────────────────────────────
type Lvl = 'info' | 'warn' | 'error' | 'ok';
const COLORS: Record<Lvl, string> = {
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  ok: '\x1b[32m',
};
const RESET = '\x1b[0m';
function log(lvl: Lvl, msg: string) {
  // eslint-disable-next-line no-console
  console.log(`${COLORS[lvl]}[${lvl}]${RESET} ${msg}`);
}

// ─── Excel parsing ───────────────────────────────────────────────────────────
async function loadWorkbook(file: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb;
}

// ExcelJS cells come back in many shapes — strings, numbers, dates, rich
// text arrays, hyperlinks, formula objects. The previous extractor only
// handled `{ text }`, so richText cells (a common Hebrew-typing artifact)
// fell through as objects and rendered as "[object Object]" in the UI —
// see the firstName / lastName complaint on the Users import.
function extractCellValue(v: any): any {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v;
  if (v instanceof Date) return v;
  if (t === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r: any) => r?.text ?? '').join('');
    if ('text' in v) return extractCellValue(v.text);
    if ('result' in v) return extractCellValue(v.result);
    if ('hyperlink' in v) return v.hyperlink;
    if ('value' in v) return extractCellValue(v.value);
  }
  return String(v);
}

function sheetRows(ws: ExcelJS.Worksheet): Record<string, any>[] {
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell((cell, col) => { headers[col - 1] = String(extractCellValue(cell.value) ?? '').trim(); });
  const rows: Record<string, any>[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const obj: Record<string, any> = {};
    let allBlank = true;
    headers.forEach((h, idx) => {
      const raw = extractCellValue(row.getCell(idx + 1).value);
      const str = typeof raw === 'string' ? raw.trim() : raw;
      if (h) {
        obj[h] = str === '' || str === 'NULL' ? null : str;
        if (obj[h] !== null) allBlank = false;
      }
    });
    if (!allBlank) rows.push(obj);
  }
  return rows;
}

// ─── XML zone tree ──────────────────────────────────────────────────────────
interface XmlZoneNode {
  id: string;
  kind: 'lot' | 'building' | 'level';
  name: string;
  father?: string | null;
}
interface XmlProjectZones {
  fileName: string;
  zones: XmlZoneNode[];
}

function parseZonesXml(xmlPath: string): XmlProjectZones[] {
  const text = fs.readFileSync(xmlPath, 'utf-8');
  const files: XmlProjectZones[] = [];
  // Robust enough for this dataset — the XML is tiny and shallow.
  const fileMatches = [...text.matchAll(/<File\s+name="([^"]+)">([\s\S]*?)<\/File>/g)];
  for (const fm of fileMatches) {
    const fileName = fm[1];
    const body = fm[2];
    const zones: XmlZoneNode[] = [];
    const push = (rx: RegExp, kind: XmlZoneNode['kind']) => {
      for (const m of body.matchAll(rx)) {
        const id = m[1];
        const inner = m[2];
        const name = (inner.match(/<name>([^<]*)<\/name>/i)?.[1] ?? '').trim();
        const father = inner.match(/<Father>([^<]*)<\/Father>/i)?.[1]?.trim() ?? null;
        zones.push({ id, kind, name, father });
      }
    };
    push(/<Lot\s+id="([^"]+)">([\s\S]*?)<\/Lot>/gi, 'lot');
    push(/<Building\s+id="([^"]+)">([\s\S]*?)<\/Building>/gi, 'building');
    push(/<Level\s+id="([^"]+)">([\s\S]*?)<\/Level>/gi, 'level');
    files.push({ fileName, zones });
  }
  return files;
}

// Source-of-truth zone-id translation: Excel uses L0xxx for level ids,
// XML uses C0xxx. Tokens like 'NA' / 'B1' / 'GL' pass through unchanged
// (they're synthetic labels — the importer maps them to project-level).
function translateExcelZoneId(id: string): string {
  if (!id) return id;
  if (/^L\d+$/i.test(id)) return 'C' + id.slice(1);
  return id;
}

// ─── Dry-run phantom IDs ────────────────────────────────────────────────────
// Dry-runs don't write rows, but downstream loops (zones-per-project,
// tasks-per-zone) expect to chain real ids. Hand out monotonically
// decreasing negative ints so any code that stores them in a Map works
// without colliding with real DB ids. These NEVER leak to the DB —
// COMMIT=true paths use the real prisma.create return.
let __phantom = 0;
const phantomId = () => --__phantom;

// ─── Audit log ──────────────────────────────────────────────────────────────
interface LogEntry {
  entityType: string;
  entityId: number;
  action: 'created' | 'linked' | 'updated';
  notes?: string;
}
const auditQueue: LogEntry[] = [];
function audit(entityType: string, entityId: number, action: LogEntry['action'], notes?: string) {
  auditQueue.push({ entityType, entityId, action, notes });
}
async function flushAudit(importId: number) {
  // Dry-run never persists — the queue is purely for counting and the
  // pretty-print at the end. importId=0 (no DataImport row) means dry-run.
  if (!COMMIT || importId === 0 || auditQueue.length === 0) {
    auditQueue.length = 0;
    return;
  }
  const data = auditQueue.map((a, i) => ({
    importId, entityType: a.entityType, entityId: a.entityId,
    action: a.action, sortOrder: i, notes: a.notes ?? null,
  }));
  await prisma.importLog.createMany({ data });
  auditQueue.length = 0;
}

// ─── Report accumulator ─────────────────────────────────────────────────────
const report = {
  startedAt: new Date().toISOString(),
  commit: COMMIT,
  excelPath: EXCEL_PATH,
  xmlPath: XML_PATH,
  projectFilter: PROJECT_FILTER,
  importId: null as number | null,
  counts: {} as Record<string, { created: number; linked: number; skipped: number; errors: number }>,
  errors: [] as { context: string; message: string }[],
  warnings: [] as { context: string; message: string }[],
};
function bumpCount(bucket: string, kind: 'created' | 'linked' | 'skipped' | 'errors') {
  report.counts[bucket] ??= { created: 0, linked: 0, skipped: 0, errors: 0 };
  report.counts[bucket][kind]++;
}

// ─── Step helpers ───────────────────────────────────────────────────────────
interface DeptResult {
  byOldId: Map<number, { id: number; name: string }>;
  byName: Map<string, number>;
}
async function upsertDepartments(rows: any[]): Promise<DeptResult> {
  // Two-way map: by oldId (from the Excel department_id column) → real
  // Department row, AND by name → id (for project.departmentId lookup
  // when Excel rows reference by name). Both User.department (string)
  // and Project.departmentId (FK) need it.
  const byOldId = new Map<number, { id: number; name: string }>();
  const byName = new Map<string, number>();
  for (const r of rows) {
    const oldId = Number(r['Department ID']);
    const name = String(r['Department'] ?? '').trim();
    if (!Number.isFinite(oldId) || !name) continue;

    let dept = await prisma.department.findFirst({ where: { name } });
    if (dept) {
      audit('department', dept.id, 'linked', `${name} oldId=${oldId}`);
      bumpCount('departments', 'linked');
    } else if (COMMIT) {
      dept = await prisma.department.create({ data: { name, sortOrder: oldId } });
      audit('department', dept.id, 'created', `${name} oldId=${oldId}`);
      bumpCount('departments', 'created');
    } else {
      const ph = phantomId();
      dept = { id: ph } as any;
      audit('department', ph, 'created', `(dry-run) ${name} oldId=${oldId}`);
      bumpCount('departments', 'created');
    }
    byOldId.set(oldId, { id: dept!.id, name });
    byName.set(name.toLowerCase(), dept!.id);
  }
  return { byOldId, byName };
}

async function resolveServiceTypeId(name: string | null): Promise<number | null> {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const existing = await prisma.serviceType.findFirst({ where: { name: trimmed } });
  if (existing) {
    audit('service', existing.id, 'linked', trimmed);
    return existing.id;
  }
  if (!COMMIT) {
    const ph = phantomId();
    audit('service', ph, 'created', `(dry-run) ${trimmed}`);
    bumpCount('services', 'created');
    return ph;
  }
  const created = await prisma.serviceType.create({
    data: { name: trimmed, sortOrder: 99 },
  });
  audit('service', created.id, 'created', trimmed);
  bumpCount('services', 'created');
  return created.id;
}

/**
 * The Excel's "Service" column maps to what the UI calls "Service" — but
 * the UI reads that from task.phase (not task.serviceType, which it
 * confusingly labels as "Deliverable"). So we upsert a Phase row per
 * unique Service name and stamp Task.phaseId. This is what makes the
 * task drawer's "Service:" line show the value.
 *
 * Caches by lowercased name so the same value isn't queried 60 times.
 */
const phaseByName = new Map<string, number>();
async function resolvePhaseId(name: string | null): Promise<number | null> {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  if (phaseByName.has(key)) return phaseByName.get(key)!;

  const existing = await prisma.phase.findFirst({ where: { name: trimmed } });
  if (existing) {
    phaseByName.set(key, existing.id);
    audit('phase', existing.id, 'linked', trimmed);
    return existing.id;
  }
  if (!COMMIT) {
    const ph = phantomId();
    phaseByName.set(key, ph);
    audit('phase', ph, 'created', `(dry-run) ${trimmed}`);
    bumpCount('phases', 'created');
    return ph;
  }
  const created = await prisma.phase.create({
    data: { name: trimmed, sortOrder: 99 },
  });
  phaseByName.set(key, created.id);
  audit('phase', created.id, 'created', trimmed);
  bumpCount('phases', 'created');
  return created.id;
}

/**
 * Mirror the project's leaderId onto a team_leader ProjectPartnerRole
 * so the project page's "Team Leader" section finds it. The Projects
 * service does this dual-write automatically on create/update; we have
 * to replicate it here because the script bypasses the service.
 *
 * Falls back to creating a stub BusinessPartner for the user if one
 * doesn't exist yet — required because ProjectPartnerRole.partyId
 * points at a BP, not at the User.
 */
async function ensureTeamLeaderRole(projectId: number, leaderUserId: number | null): Promise<void> {
  if (!COMMIT || !leaderUserId) return;
  const teamLeaderRole = await prisma.projectRoleType.findUnique({
    where: { code: 'team_leader' }, select: { id: true },
  });
  if (!teamLeaderRole) return;
  const user = await prisma.user.findUnique({
    where: { id: leaderUserId },
    select: { businessPartnerId: true, firstName: true, lastName: true, email: true },
  });
  if (!user) return;
  let bpId = user.businessPartnerId;
  // The legacy seed users may not have a linked BP — create one so the
  // role assignment can hold a partyId.
  if (!bpId) {
    const bp = await prisma.businessPartner.create({
      data: {
        partnerType: 'person',
        displayName: `${user.firstName} ${user.lastName}`.trim() || (user.email ?? '(unknown)'),
        firstName: user.firstName ?? undefined,
        lastName: user.lastName ?? undefined,
        email: user.email,
        source: 'import',
        ...(report.importId ? { createdByImport: { connect: { id: report.importId } } } : {}),
      },
    });
    await prisma.user.update({ where: { id: leaderUserId }, data: { businessPartnerId: bp.id } });
    audit('business_partner', bp.id, 'created', `BP stub for leader ${user.email}`);
    bpId = bp.id;
  }
  // End any prior team_leader on this project so the unique constraint
  // (projectId, partyId, roleId, validFrom) doesn't collide.
  await prisma.projectPartnerRole.deleteMany({
    where: { projectId, roleId: teamLeaderRole.id, status: 'active' },
  });
  const link = await prisma.projectPartnerRole.create({
    data: {
      projectId, partyId: bpId, roleId: teamLeaderRole.id,
      isPrimary: true, validFrom: new Date(), status: 'active',
    },
  });
  audit('project_partner_role', link.id, 'created', `team_leader project=${projectId} bp=${bpId}`);
}

// Look up a user by "First Last" string. Tolerant of trailing spaces in
// the source (Excel had "Shiffy " with trailing space).
async function resolveUserByName(fullName: string | null): Promise<number | null> {
  if (!fullName) return null;
  const trimmed = fullName.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  const first = parts.slice(0, -1).join(' ') || parts[0];
  const last = parts.length > 1 ? parts.slice(-1)[0] : '';

  const u =
    await prisma.user.findFirst({ where: { firstName: first, lastName: last } }) ??
    await prisma.user.findFirst({ where: { firstName: { startsWith: first } } });
  return u?.id ?? null;
}

async function upsertCustomer(name: string, email: string | null, extras: {
  taxId?: string | null; phone?: string | null; address?: string | null; website?: string | null; notes?: string | null;
}): Promise<number | null> {
  if (!name) return null;
  const trimmed = name.trim();
  // Dedupe by tax_id first (strongest), then email, then displayName.
  let bp = extras.taxId ? await prisma.businessPartner.findFirst({ where: { taxId: extras.taxId, deletedAt: null } }) : null;
  if (!bp && email) bp = await prisma.businessPartner.findFirst({ where: { email, deletedAt: null } });
  if (!bp) bp = await prisma.businessPartner.findFirst({ where: { displayName: trimmed, partnerType: 'organization', deletedAt: null } });

  const customerRoleType = await prisma.partnerRoleType.findUnique({ where: { code: 'customer' } });

  if (bp) {
    if (customerRoleType && bp.mainRoleTypeId !== customerRoleType.id) {
      if (COMMIT) {
        await prisma.businessPartner.update({ where: { id: bp.id }, data: { mainRoleTypeId: customerRoleType.id } });
      }
    }
    audit('business_partner', bp.id, 'linked', `customer "${trimmed}"`);
    bumpCount('customers', 'linked');
    return bp.id;
  }

  if (!COMMIT) {
    bumpCount('customers', 'created');
    const ph = phantomId();
    audit('business_partner', ph, 'created', `(dry-run) customer "${trimmed}"`);
    return ph;
  }

  const created = await prisma.businessPartner.create({
    data: {
      partnerType: 'organization',
      displayName: trimmed,
      companyName: trimmed,
      email: email || undefined,
      phone: extras.phone || undefined,
      taxId: extras.taxId || undefined,
      address: extras.address || undefined,
      website: extras.website || undefined,
      notes: extras.notes || undefined,
      mainRoleTypeId: customerRoleType?.id ?? null,
      source: 'import',
      createdByImportId: report.importId ?? undefined,
    },
  });
  audit('business_partner', created.id, 'created', `customer "${trimmed}"`);
  bumpCount('customers', 'created');
  return created.id;
}

async function upsertUser(
  row: any,
  deptByOldId: Map<number, { id: number; name: string }>,
  defaultRoleId: number,
): Promise<number | null> {
  const category = String(row['category'] ?? '').toLowerCase();
  if (category !== 'employee') {
    bumpCount('users', 'skipped'); return null;
  }
  const email = row['email'] ? String(row['email']).trim() : '';
  if (!email || email === 'NULL') {
    bumpCount('users', 'skipped');
    report.warnings.push({ context: 'users', message: `User id=${row['id']} skipped — no email` });
    return null;
  }
  const firstName = (row['first name'] ?? '').toString().trim();
  const lastName = (row['Last name'] ?? '').toString().trim();
  const fallbackName = (row['name'] ?? '').toString().trim();
  const fn = firstName || fallbackName.split(' ').slice(0, -1).join(' ') || fallbackName;
  const ln = lastName || (firstName ? '' : fallbackName.split(' ').slice(-1).join(' '));
  const isArchive = String(row['is_archive'] ?? '0') === '1';

  // Department resolved from the Department sheet (Excel department_id).
  const deptIdRaw0 = row['department_id'];
  const deptIdNum0 = deptIdRaw0 == null ? NaN : Number(deptIdRaw0);
  const deptNameForUpdate = Number.isFinite(deptIdNum0) ? deptByOldId.get(deptIdNum0)?.name ?? null : null;

  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) {
    // Heal in place — earlier runs may have stored "[object Object]" for
    // firstName/lastName due to the broken ExcelJS cell extractor.
    // Idempotent: if the row already matches, this is a no-op patch.
    if (COMMIT) {
      const targetFirst = fn || existing.firstName;
      const targetLast = ln || existing.lastName;
      const needsHeal =
        existing.firstName !== targetFirst ||
        existing.lastName !== targetLast ||
        (!existing.department && deptNameForUpdate);
      if (needsHeal) {
        await prisma.user.update({
          where: { id: existing.id },
          data: {
            firstName: targetFirst,
            lastName: targetLast,
            department: existing.department ?? deptNameForUpdate ?? undefined,
            isActive: !isArchive,
          },
        });
        audit('user', existing.id, 'updated', `healed name/dept for ${email}`);
      } else {
        audit('user', existing.id, 'linked', `email=${email}`);
      }
    }
    bumpCount('users', 'linked');
    return existing.id;
  }
  if (!COMMIT) {
    bumpCount('users', 'created');
    const ph = phantomId();
    audit('user', ph, 'created', `(dry-run) ${email}`);
    return ph;
  }
  const bcrypt = await import('bcrypt');
  // No usable password in v3 (the column existed in v2 but Amit may not
  // ship the hash). Generate a random one — the admin will issue resets.
  const tempHash = await bcrypt.hash('Change' + Date.now(), 10);
  // Department resolution: Excel carries department_id (FK to the
  // Department sheet). Map to the actual Department row we just upserted
  // and write its NAME into User.department (the User model field is a
  // free-text string, not an FK).
  const deptIdRaw = row['department_id'];
  const deptIdNum = deptIdRaw == null ? NaN : Number(deptIdRaw);
  const deptName = Number.isFinite(deptIdNum) ? deptByOldId.get(deptIdNum)?.name ?? null : null;

  const userData: any = {
    email,
    password: tempHash,
    firstName: fn || '(unknown)',
    lastName: ln || '',
    phone: row['phone']?.toString() || undefined,
    isActive: !isArchive,
    userType: 'employee',
  };
  if (deptName) userData.department = deptName;
  userData.roleId = defaultRoleId;
  if (report.importId) userData.createdByImportId = report.importId;
  const created = await prisma.user.create({ data: userData });
  audit('user', created.id, 'created', `email=${email}`);
  bumpCount('users', 'created');
  return created.id;
}

async function upsertProject(
  row: any,
  customerBpId: number | null,
  runnerUserId: number,
  defaultProjectTypeId: number,
  pmUserId: number | null,
): Promise<number | null> {
  const name = String(row['Project_name'] ?? '').trim();
  const number = String(row['Project_Number '] ?? row['Project_Number'] ?? '').trim();
  if (!name) {
    bumpCount('projects', 'skipped'); return null;
  }
  const where = number ? { number } : { name };
  const existing = await prisma.project.findFirst({ where });
  if (existing) {
    audit('project', existing.id, 'linked', `${number || name}`);
    bumpCount('projects', 'linked');
    return existing.id;
  }

  const parseDate = (s: any): Date | null => {
    if (!s) return null;
    if (s instanceof Date) return s;
    const str = String(s).trim();
    const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`);
    const d = new Date(str);
    return Number.isFinite(+d) ? d : null;
  };

  if (!COMMIT) {
    bumpCount('projects', 'created');
    const ph = phantomId();
    audit('project', ph, 'created', `(dry-run) ${number || name}`);
    return ph;
  }
  const statusRaw = String(row['Status (Active / On hold / Done)'] ?? 'active').toLowerCase();
  const status = (
    statusRaw.includes('hold') ? 'on_hold' :
    statusRaw.includes('done') || statusRaw.includes('complet') ? 'completed' :
    statusRaw.includes('cancel') ? 'cancelled' : 'active'
  ) as Prisma.ProjectCreateInput['status'];
  const created = await prisma.project.create({
    data: {
      name,
      number: number || undefined,
      status,
      projectTypeId: defaultProjectTypeId,
      createdBy: runnerUserId,
      // PM from the Excel becomes Project.leaderId (Team Leader in the UI).
      // null if the PM name didn't match any user — the report flags this.
      leaderId: pmUserId ?? undefined,
      startDate: parseDate(row['Start date']) ?? undefined,
      endDate: parseDate(row['End Date']) ?? undefined,
      description: row['DESCRIPTION'] || undefined,
      weeklyMeetingDay: row['Weekly Meeting Day'] || undefined,
      authoringToolVersion: row['Authoring Tool Version'] || undefined,
      budget: row['contract_amount'] ? new Prisma.Decimal(Number(row['contract_amount'])) : undefined,
      servicesPerContract: row['DESCRIPTION'] || undefined,
    },
  });
  audit('project', created.id, 'created', `${number || name}`);
  bumpCount('projects', 'created');

  // Customer linkage via ProjectPartnerRole with role='customer' (per #7).
  if (customerBpId) {
    const customerRole = await prisma.projectRoleType.findUnique({ where: { code: 'customer' } });
    if (customerRole) {
      try {
        const link = await prisma.projectPartnerRole.create({
          data: { projectId: created.id, partyId: customerBpId, roleId: customerRole.id, isPrimary: true },
        });
        audit('project_partner_role', link.id, 'created', `project=${created.id} customer bp=${customerBpId}`);
      } catch (e: any) {
        report.warnings.push({ context: 'project_partner_role', message: `Couldn't link customer: ${e.message}` });
      }
    }
  }
  return created.id;
}

async function createZonesFromXml(
  projectId: number,
  xmlFile: XmlProjectZones,
): Promise<Map<string, number>> {
  // Two-pass: first create every zone parent-less so we have ids; then
  // resolve parent links via the XML 'father' name within the file.
  const idMap = new Map<string, number>(); // XML id → DB Zone.id
  const nameToId = new Map<string, number>(); // name within this file → DB id (for parent lookup)

  for (const z of xmlFile.zones) {
    if (!COMMIT) {
      bumpCount('zones', 'created');
      const ph = phantomId();
      audit('zone', ph, 'created', `(dry-run) ${z.id} ${z.kind}`);
      idMap.set(z.id, ph);
      if (z.name) nameToId.set(z.name, ph);
      continue;
    }
    // Idempotent: dedupe by (projectId, code) so a re-run doesn't
    // double the tree. Falls back to (projectId, name) when code is
    // missing.
    const existing = await prisma.zone.findFirst({
      where: { projectId, code: z.id, deletedAt: null },
    });
    if (existing) {
      idMap.set(z.id, existing.id);
      if (z.name) nameToId.set(z.name, existing.id);
      audit('zone', existing.id, 'linked', `${z.id} ${z.kind}`);
      bumpCount('zones', 'linked');
      continue;
    }
    const created = await prisma.zone.create({
      data: {
        project: { connect: { id: projectId } },
        name: z.name || z.id,
        code: z.id,
        path: z.name || z.id,
        sortOrder: 0,
      },
    });
    idMap.set(z.id, created.id);
    if (z.name) nameToId.set(z.name, created.id);
    audit('zone', created.id, 'created', `${z.id} ${z.kind}`);
    bumpCount('zones', 'created');
  }

  // Second pass: link parents.
  if (COMMIT) {
    for (const z of xmlFile.zones) {
      if (!z.father) continue;
      const childId = idMap.get(z.id);
      const parentId = nameToId.get(z.father);
      if (childId && parentId && childId !== parentId) {
        await prisma.zone.update({ where: { id: childId }, data: { parentId } });
      }
    }
  }
  return idMap;
}

async function upsertProjectDeliverable(
  projectId: number,
  name: string,
): Promise<number | null> {
  if (!name || name === 'no match') return null;
  const existing = await prisma.projectDeliverable.findFirst({
    where: { projectId, name },
  });
  if (existing) {
    audit('project_deliverable', existing.id, 'linked', `${name}`);
    bumpCount('project_deliverables', 'linked');
    return existing.id;
  }
  if (!COMMIT) {
    bumpCount('project_deliverables', 'created');
    const ph = phantomId();
    audit('project_deliverable', ph, 'created', `(dry-run) ${name}`);
    return ph;
  }
  const created = await prisma.projectDeliverable.create({
    data: { projectId, name, sortOrder: 0 },
  });
  audit('project_deliverable', created.id, 'created', `${name}`);
  bumpCount('project_deliverables', 'created');
  return created.id;
}

async function upsertTask(
  projectId: number,
  zoneId: number | null,
  deliverableId: number | null,
  row: any,
  runnerUserId: number,
  serviceTypeId: number | null,
  phaseId: number | null,
): Promise<number | null> {
  const code = row['Task_Code'] ? String(row['Task_Code']).trim() : null;
  const name = String(row['Task Name'] ?? '').trim();
  if (!name) {
    bumpCount('tasks', 'skipped'); return null;
  }

  // Dedupe by (project, code, zone EXACT, name) — must match all four,
  // including zoneId=null for project-level tasks. Without an exact zone
  // match the same code reused across zones collapsed to a single task
  // (e.g. TSK-1016 in B4 + GL + TYP merged to one row).
  const where: Prisma.TaskWhereInput = code
    ? { projectId, code, name, zoneId: zoneId ?? null, deletedAt: null }
    : { projectId, name, zoneId: zoneId ?? null, deletedAt: null };
  const existing = await prisma.task.findFirst({ where });
  if (existing) {
    audit('task', existing.id, 'linked', `${code ?? ''} ${name}`);
    bumpCount('tasks', 'linked');
    return existing.id;
  }

  if (!COMMIT) {
    bumpCount('tasks', 'created');
    const ph = phantomId();
    audit('task', ph, 'created', `(dry-run) ${code ?? ''} ${name}`);
    return ph;
  }
  const budget = row['Amount'] ? Number(row['Amount']) : undefined;
  // Hours derivation: when the source row carries a budget AMOUNT but no
  // hours (the BM dataset never has hours), the user's rule is hours =
  // amount / 400 (their internal rate). Skip rows with no amount.
  const hours = budget ? Math.round((budget / 400) * 100) / 100 : undefined;
  // Task.code is required (varchar 50, not null). When the source row
  // has no code, synthesize one from the task name truncated to 50 — the
  // importer reports this so admins can rename later if desired.
  const resolvedCode = code || `BM-${name.slice(0, 40).replace(/\s+/g, '_')}`;
  const created = await prisma.task.create({
    data: {
      project: { connect: { id: projectId } },
      creator: { connect: { id: runnerUserId } },
      ...(zoneId ? { zone: { connect: { id: zoneId } } } : {}),
      ...(deliverableId ? { projectDeliverable: { connect: { id: deliverableId } } } : {}),
      ...(serviceTypeId ? { serviceType: { connect: { id: serviceTypeId } } } : {}),
      // task.phaseId is what the UI surfaces under the "Service" label —
      // see task-drawer.tsx ("{task.phase.name}" rendered as "Service").
      ...(phaseId ? { phase: { connect: { id: phaseId } } } : {}),
      code: resolvedCode,
      name,
      ...(budget ? { budgetAmount: new Prisma.Decimal(budget) } : {}),
      ...(hours ? { budgetHours: new Prisma.Decimal(hours) } : {}),
      status: 'not_started',
    },
  });
  audit('task', created.id, 'created', `${code ?? ''} ${name}`);
  bumpCount('tasks', 'created');
  return created.id;
}

// ─── Main orchestration ─────────────────────────────────────────────────────
async function main() {
  log('info', `Mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY-RUN (no writes)'}`);
  log('info', `Excel: ${EXCEL_PATH}`);
  log('info', `XML:   ${XML_PATH}`);
  if (PROJECT_FILTER) log('info', `Scope: project number ${PROJECT_FILTER}`);

  if (!fs.existsSync(EXCEL_PATH)) { log('error', `Excel not found: ${EXCEL_PATH}`); process.exit(2); }
  if (!fs.existsSync(XML_PATH)) { log('error', `XML not found: ${XML_PATH}`); process.exit(2); }

  const wb = await loadWorkbook(EXCEL_PATH);
  const xmlFiles = parseZonesXml(XML_PATH);

  const projects = sheetRows(wb.getWorksheet('Projects')!);
  const customers = sheetRows(wb.getWorksheet('Customers')!);
  const users = sheetRows(wb.getWorksheet('Users')!);
  const tasks = sheetRows(wb.getWorksheet('Project Tasks')!);
  const departments = sheetRows(wb.getWorksheet('Department')!);
  const employeeAssignments = sheetRows(wb.getWorksheet('Employee_Assignments')!);
  const timesheet = sheetRows(wb.getWorksheet('Timesheet')!);

  // Cross-sheet id maps:
  //  • userOldIdToNew — Excel Users.id → real User.id, used by Timesheet
  //    and Employee_Assignments to resolve who.
  //  • assignmentIdToTaskId — the legacy `assignment_id` carried on Project
  //    Tasks AND referenced by Employee_Assignments / Timesheet. Tracks
  //    "this task came from THAT row of the old system" so the other two
  //    sheets can resolve the now-real Task.id.
  const userOldIdToNew = new Map<number, number>();
  const assignmentIdToTaskId = new Map<number, number>();

  // Create DataImport row immediately so subsequent audit logs FK to it.
  // In dry-run we still create the row but set status='parsed' and skip
  // commit work later; the row itself is harmless to keep.
  // Use the seed admin as the runner since this is a script (no JWT here).
  const runner = await prisma.user.findFirst({ where: { email: 'admin@amec.com' } });
  if (!runner) { log('error', 'admin@amec.com not found — required as the import runner'); process.exit(2); }

  if (COMMIT) {
    const di = await prisma.dataImport.create({
      data: {
        userId: runner.id,
        target: 'projects',
        filename: path.basename(EXCEL_PATH),
        fileHash: 'na-' + Date.now(),
        mode: 'insert',
        rowCount: projects.length + tasks.length,
        status: 'parsed',
      },
    });
    report.importId = di.id;
    log('info', `DataImport id=${di.id}`);
  }

  // 1. Departments — actually upsert into the Department model. Returns
  //    both an oldId→{id,name} map (for user.department) and a name→id
  //    lookup (for future project.departmentId).
  const deptMap = await upsertDepartments(departments);

  // 2. Customers — sheet first, even if some referenced by Projects are missing
  const customerIdByName = new Map<string, number | null>();
  for (const c of customers) {
    const id = await upsertCustomer(
      String(c['שם הלקוח '] ?? c['שם הלקוח'] ?? '').trim(),
      c['email'] || null,
      {
        taxId: c['tax_id'] || null,
        phone: c[' phone'] || c['phone'] || null,
        address: c['address'] || null,
        website: c[' website'] || c['website'] || null,
        notes: c[' notes'] || c['notes'] || null,
      },
    );
    customerIdByName.set(String(c['שם הלקוח '] ?? c['שם הלקוח'] ?? '').trim(), id);
  }

  // 3. Users (employees only). Pre-resolve the default role at the top
  //    so we can fail fast with a clear message — the schema requires
  //    roleId on every User. Tries "Employee" first, falls back to any
  //    non-admin role, then to any role at all.
  const defaultRole =
    await prisma.role.findFirst({ where: { name: { in: ['Employee', 'employee'] } } })
    ?? await prisma.role.findFirst({ where: { NOT: { name: { in: ['Admin', 'admin'] } } }, orderBy: { id: 'asc' } })
    ?? await prisma.role.findFirst({ orderBy: { id: 'asc' } });
  if (!defaultRole) {
    log('error', 'No Role rows in DB — seed roles before importing users');
    process.exit(2);
  }
  log('info', `Default authorization role: "${defaultRole.name}" (id=${defaultRole.id})`);

  for (const u of users) {
    const oldId = Number(u['id']);
    const newId = await upsertUser(u, deptMap.byOldId, defaultRole.id);
    if (Number.isFinite(oldId) && newId) userOldIdToNew.set(oldId, newId);
  }

  // 4. Project header(s) — filtered if --project provided
  // Resolve a default ProjectType for new projects (required column).
  const defaultType = await prisma.projectType.findFirst({ where: { name: 'Mixed' } })
    ?? await prisma.projectType.findFirst();
  if (!defaultType && COMMIT) {
    log('error', 'No ProjectType rows — seed Mixed/Buildings/etc. first');
    process.exit(2);
  }
  const projectIdByNumber = new Map<string, number | null>();
  const projectIdByName = new Map<string, number | null>();
  for (const p of projects) {
    const num = String(p['Project_Number '] ?? p['Project_Number'] ?? '').trim();
    if (PROJECT_FILTER && num !== PROJECT_FILTER) continue;
    const custName = String(p['Customer'] ?? '').trim();
    let custId = customerIdByName.get(custName) ?? null;
    if (!custId && custName) {
      // referenced but missing from Customers sheet — auto-create a stub
      custId = await upsertCustomer(custName, null, {});
      customerIdByName.set(custName, custId);
    }
    // PM lookup so Project.leaderId gets set (= "Team Leader" in the UI).
    const pmName = String(p['PM / Project Manager (user)'] ?? '').trim() || null;
    const pmUserId = await resolveUserByName(pmName);
    if (pmName && !pmUserId) {
      report.warnings.push({ context: 'project_pm', message: `PM "${pmName}" not found in Users` });
    }
    const pid = await upsertProject(p, custId, runner.id, defaultType?.id ?? 0, pmUserId);
    const pname = String(p['Project_name'] ?? '').trim();
    if (num) projectIdByNumber.set(num, pid);
    if (pname) projectIdByName.set(pname, pid);

    // 4b. Team Leader visibility — mirror leaderId onto a team_leader
    //     ProjectPartnerRole so the Team Leader header on the project
    //     page actually renders. Dual-write matches what the projects
    //     service does (see syncTeamLeaderRole) — we replicate it here
    //     because the script bypasses the service.
    if (pid) await ensureTeamLeaderRole(pid, pmUserId);

    // 5. Zones from XML for THIS project — runs in BOTH modes; the
    //    dry-run returns phantom ids so task → zone lookups still work.
    //    Match in priority order: exact name → project number →
    //    substring → token overlap (XML uses shortened labels like
    //    "1616" for "מבנה 1616", "260014" for "המאירי", and
    //    "נשר חדיף" for "נשר תמל 3201 חדיף"; the last needs a token
    //    matcher because the shortened form isn't a substring).
    const tokens = (s: string) => s.split(/\s+/).filter(Boolean);
    const xmlFile =
      xmlFiles.find((f) => f.fileName.trim() === pname) ??
      (num ? xmlFiles.find((f) => f.fileName.trim() === num) : undefined) ??
      xmlFiles.find((f) => {
        const fn = f.fileName.trim();
        if (!fn || !pname) return false;
        return pname.includes(fn) || fn.includes(pname);
      }) ??
      xmlFiles.find((f) => {
        const fn = f.fileName.trim();
        if (!fn || !pname) return false;
        // Every token of the shorter side must appear in the longer
        // side. Catches "נשר חדיף" ⊂ tokens of "נשר תמל 3201 חדיף".
        const a = tokens(fn), b = tokens(pname);
        if (a.length === 0 || b.length === 0) return false;
        const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
        return shorter.every((t) => longer.includes(t));
      });
    let zoneIdByXmlId = new Map<string, number>();
    if (xmlFile && pid) {
      zoneIdByXmlId = await createZonesFromXml(pid, xmlFile);
    } else if (!xmlFile) {
      report.warnings.push({ context: 'zones', message: `No XML <File name="${pname}"> for project ${num || pname}` });
    }

    // 5b. Synthetic "No Zone" zone for tasks where Excel says Zone=NA.
    //     Before this, those tasks went in with zoneId=null which is
    //     project-level — but the planning grid renders them in a
    //     synthetic "Project Root" row, NOT under a real zone the user
    //     can collapse/expand. Per the user's call, they want them all
    //     under a visible "No Zone" zone instead.
    let noZoneId: number | null = null;
    if (pid && COMMIT) {
      const existingNoZone = await prisma.zone.findFirst({
        where: { projectId: pid, code: 'NA', deletedAt: null },
      });
      if (existingNoZone) {
        noZoneId = existingNoZone.id;
        audit('zone', existingNoZone.id, 'linked', 'No Zone bucket');
      } else {
        const nz = await prisma.zone.create({
          data: {
            project: { connect: { id: pid } },
            name: 'No Zone', code: 'NA', path: 'No Zone', sortOrder: 999,
          },
        });
        noZoneId = nz.id;
        audit('zone', nz.id, 'created', 'No Zone bucket');
        bumpCount('zones', 'created');
      }
    } else if (pid && !COMMIT) {
      noZoneId = phantomId();
      audit('zone', noZoneId, 'created', '(dry-run) No Zone bucket');
      bumpCount('zones', 'created');
    }

    // 6. Project Tasks for THIS project
    const projTasks = tasks.filter((t) => String(t['Project_name'] ?? '').trim() === pname);
    const deliverableIdByName = new Map<string, number | null>();
    for (const t of projTasks) {
      const delivName = String(t['Deliverable'] ?? '').trim();
      let delivId = deliverableIdByName.get(delivName);
      if (delivId === undefined && pid) {
        delivId = await upsertProjectDeliverable(pid, delivName);
        deliverableIdByName.set(delivName, delivId);
      }
      const zoneRaw = String(t['Zone'] ?? '').trim();
      const xmlZoneId = translateExcelZoneId(zoneRaw);
      // NA / unknown → synthetic No-Zone bucket so they're visible in
      // the planning grid as a real zone row, not the project-root void.
      const zoneId = zoneIdByXmlId.get(xmlZoneId) ?? noZoneId;
      // Each task carries a Service in the Excel. Resolve both:
      //   • Phase  — task.phaseId drives the drawer's "Service" line and
      //              the Execution Board service filter priority #3.
      //   • ServiceType — task.serviceTypeId is the legacy fallback
      //              (priority #4 in getTaskServiceName) and shows up
      //              under "Deliverable" in the drawer header.
      const svcRaw = String(t['Service'] ?? '').trim() || null;
      const serviceTypeId = await resolveServiceTypeId(svcRaw);
      const phaseId = await resolvePhaseId(svcRaw);
      const taskId = pid ? await upsertTask(pid, zoneId, delivId ?? null, t, runner.id, serviceTypeId, phaseId) : null;
      // Track the assignment_id → task linkage so Employee_Assignments
      // and Timesheet sheets can resolve their task references.
      const assId = Number(t['assignment_id of employee']);
      if (taskId && Number.isFinite(assId)) assignmentIdToTaskId.set(assId, taskId);
    }
  }

  // 7. Employee_Assignments → TaskAssignee rows + Task.status/endDate.
  //    The Excel carries one row per (employee, assignment) pair, with
  //    status + due_date + (sometimes) start/end. We resolve via the
  //    maps built earlier: Employees ID → User and assignment_id → Task.
  //    Rows whose assignment_id isn't in the in-scope task set are
  //    skipped (e.g. when --project narrowed to a single project).
  //
  //    For each EA row we ALSO:
  //      • map the EA status → Task.status (see mapEaStatus)
  //      • copy due_date → Task.endDate (so the task drawer's Due Date
  //        header shows it) AND TaskAssignee.endDate (for per-person
  //        tracking when multiple people share a task)
  //      • copy start/end onto TaskAssignee
  const mapEaStatus = (s: any): string => {
    const x = String(s ?? '').toLowerCase().trim();
    if (x === 'in progress' || x === 'working on it') return 'in_progress';
    if (x === 'done' || x === 'completed') return 'completed';
    if (x === 'on hold' || x === 'stuck') return 'on_hold';
    if (x === 'cancelled' || x === 'canceled') return 'cancelled';
    return 'not_started';
  };
  const toDate = (v: any): Date | null => {
    if (v == null || v === 'NULL') return null;
    if (v instanceof Date) return v;
    const d = new Date(String(v));
    return Number.isFinite(+d) ? d : null;
  };
  for (const ea of employeeAssignments) {
    const oldUserId = Number(ea['Employees ID'] ?? ea['id']);
    const oldAssId = Number(ea['assignment_id']);
    const newUserId = userOldIdToNew.get(oldUserId);
    const newTaskId = assignmentIdToTaskId.get(oldAssId);
    if (!newUserId || !newTaskId) { bumpCount('task_assignees', 'skipped'); continue; }
    const eaStatus = mapEaStatus(ea['status']);
    const eaDueDate = toDate(ea['due_date']);
    const eaStart = toDate(ea['start_date']);
    const eaEnd = toDate(ea['end_date']);

    if (!COMMIT) {
      bumpCount('task_assignees', 'created');
      audit('task_assignee', phantomId(), 'created', `(dry-run) user=${oldUserId} task=${oldAssId} status=${eaStatus} due=${eaDueDate?.toISOString().slice(0,10)}`);
      continue;
    }
    try {
      // Mirror status + due date onto the Task itself so they show up on
      // the planning grid and the task drawer header. When multiple EA
      // rows target the same Task, the last one processed wins (matches
      // the legacy system's "current owner overrides" behavior).
      await prisma.task.update({
        where: { id: newTaskId },
        data: {
          status: eaStatus as any,
          ...(eaDueDate ? { endDate: eaDueDate } : {}),
        },
      });

      const existing = await prisma.taskAssignee.findFirst({ where: { taskId: newTaskId, userId: newUserId, deletedAt: null } });
      if (existing) {
        // Heal in place — set assignee dates if they weren't there before.
        if (eaDueDate || eaStart || eaEnd) {
          await prisma.taskAssignee.update({
            where: { id: existing.id },
            data: {
              startDate: eaStart ?? existing.startDate ?? undefined,
              endDate: eaEnd ?? eaDueDate ?? existing.endDate ?? undefined,
            },
          });
        }
        audit('task_assignee', existing.id, 'linked', `user=${oldUserId} task=${oldAssId} status=${eaStatus}`);
        bumpCount('task_assignees', 'linked');
        continue;
      }
      const a = await prisma.taskAssignee.create({
        data: {
          task: { connect: { id: newTaskId } },
          user: { connect: { id: newUserId } },
          ...(eaStart ? { startDate: eaStart } : {}),
          ...(eaEnd || eaDueDate ? { endDate: eaEnd ?? eaDueDate } : {}),
        },
      });
      audit('task_assignee', a.id, 'created', `user=${oldUserId} task=${oldAssId} status=${eaStatus} due=${eaDueDate?.toISOString().slice(0,10)}`);
      bumpCount('task_assignees', 'created');
    } catch (err: any) {
      bumpCount('task_assignees', 'errors');
      report.errors.push({ context: 'task_assignee', message: err.message });
    }
  }

  // 8. Timesheet → TimeEntry rows. Excel stores start/end as
  //    seconds-since-midnight; convert to HH:MM. Resolves user via
  //    Timesheet_user_id and task via assignment_id.
  for (const ts of timesheet) {
    const oldUserId = Number(ts['Timesheet_user_id'] ?? ts['user_id']);
    const oldAssId = Number(ts['assignment_id'] ?? ts['Timesheet_assignment_id']);
    const newUserId = userOldIdToNew.get(oldUserId);
    const newTaskId = assignmentIdToTaskId.get(oldAssId);
    const dateRaw = ts['Timesheet_date'];
    // Skip rows whose task isn't in scope (--project narrowed the run);
    // otherwise the importer would create unattached TimeEntry rows that
    // can't be linked back to a project.
    if (!newUserId || !newTaskId || !dateRaw) { bumpCount('time_entries', 'skipped'); continue; }
    const date = dateRaw instanceof Date ? dateRaw : new Date(String(dateRaw));
    if (!Number.isFinite(+date)) { bumpCount('time_entries', 'skipped'); continue; }
    const startSec = Number(ts['Timesheet_start_time']);
    const endSec = Number(ts['Timesheet_end_time']);
    const toHHMM = (s: number) => {
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };
    const startTime = Number.isFinite(startSec) ? toHHMM(startSec) : null;
    const endTime = Number.isFinite(endSec) ? toHHMM(endSec) : null;
    const minutes = Number.isFinite(startSec) && Number.isFinite(endSec)
      ? Math.round((endSec - startSec) / 60)
      : Math.round(Number(ts['Timesheet_hours']) * 60);
    const note = ts['Timesheet_description'] && String(ts['Timesheet_description']).toUpperCase() !== 'NULL'
      ? String(ts['Timesheet_description']) : undefined;
    const location = String(ts['location'] ?? '').toLowerCase() === 'home' ? 'home' : 'office';
    if (!COMMIT) {
      bumpCount('time_entries', 'created');
      audit('time_entry', phantomId(), 'created', `(dry-run) user=${oldUserId} task=${oldAssId} ${date.toISOString().slice(0, 10)}`);
      continue;
    }
    try {
      const e = await prisma.timeEntry.create({
        data: {
          user: { connect: { id: newUserId } },
          ...(newTaskId ? { task: { connect: { id: newTaskId } } } : {}),
          date,
          startTime: startTime ?? undefined,
          endTime: endTime ?? undefined,
          minutes,
          note,
          location,
          isBillable: true,
        },
      });
      audit('time_entry', e.id, 'created', `user=${oldUserId} task=${oldAssId} ${date.toISOString().slice(0, 10)}`);
      bumpCount('time_entries', 'created');
    } catch (err: any) {
      bumpCount('time_entries', 'errors');
      report.errors.push({ context: 'time_entry', message: err.message });
    }
  }

  await flushAudit(report.importId ?? 0);

  // Finalize DataImport status
  if (COMMIT && report.importId) {
    const totals = Object.values(report.counts).reduce(
      (a, b) => ({ c: a.c + b.created, u: a.u + b.linked, s: a.s + b.skipped, e: a.e + b.errors }),
      { c: 0, u: 0, s: 0, e: 0 },
    );
    await prisma.dataImport.update({
      where: { id: report.importId },
      data: {
        status: totals.e > 0 ? 'partial' : 'committed',
        createdCount: totals.c,
        updatedCount: totals.u,
        skippedCount: totals.s,
        errorCount: totals.e,
        finishedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    });
  }

  // Write the report
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
  log('ok', `Report: ${REPORT_PATH}`);

  // Pretty-print
  for (const [bucket, c] of Object.entries(report.counts)) {
    log('info', `${bucket.padEnd(28)} created=${c.created} linked=${c.linked} skipped=${c.skipped} errors=${c.errors}`);
  }
  for (const w of report.warnings) log('warn', `${w.context}: ${w.message}`);
  for (const e of report.errors) log('error', `${e.context}: ${e.message}`);

  if (!COMMIT) {
    log('warn', 'Dry-run only — re-run with --commit to write to the DB.');
    log('warn', `(Sentinel ${LEGACY_DATE_SENTINEL.toISOString().slice(0, 10)} reserved for Employee_Assignments without real dates.)`);
  } else if (report.importId) {
    log('ok', `Committed. To roll back: npx ts-node scripts/bm-rollback.ts --import-id ${report.importId}`);
  }
}

main()
  .catch((err) => { log('error', err.stack ?? String(err)); process.exit(1); })
  .finally(() => prisma.$disconnect());
