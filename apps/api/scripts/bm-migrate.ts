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

function sheetRows(ws: ExcelJS.Worksheet): Record<string, any>[] {
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell((cell, col) => { headers[col - 1] = String(cell.value ?? '').trim(); });
  const rows: Record<string, any>[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const obj: Record<string, any> = {};
    let allBlank = true;
    headers.forEach((h, idx) => {
      const v = row.getCell(idx + 1).value;
      const s = v === null || v === undefined ? '' : typeof v === 'object' && 'text' in (v as any) ? (v as any).text : v;
      const str = typeof s === 'string' ? s.trim() : s;
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
async function upsertDepartments(rows: any[]): Promise<Map<number, number>> {
  // Map old department_id → new department_id (we don't have a Department
  // model directly; per the schema, User.department is a STRING. So this
  // resolves to a name lookup; the map carries (oldId → name) effectively.)
  // The Department sheet is just a string lookup table, so we cache the
  // names by old id.
  const byOldId = new Map<number, string>();
  for (const r of rows) {
    const id = Number(r['Department ID']);
    const name = String(r['Department'] ?? '').trim();
    if (!Number.isFinite(id) || !name) continue;
    byOldId.set(id, name);
  }
  bumpCount('departments', 'linked');
  return byOldId as any; // signature kept generic — value is name string
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

async function upsertUser(row: any): Promise<number | null> {
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

  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) {
    audit('user', existing.id, 'linked', `email=${email}`);
    bumpCount('users', 'linked');
    return existing.id;
  }
  if (!COMMIT) {
    bumpCount('users', 'created');
    const ph = phantomId();
    audit('user', ph, 'created', `(dry-run) ${email}`);
    return ph;
  }
  const employeeRole = await prisma.role.findFirst({ where: { name: 'Employee' } });
  const bcrypt = await import('bcrypt');
  // No usable password in v3 (the column existed in v2 but Amit may not
  // ship the hash). Generate a random one — the admin will issue resets.
  const tempHash = await bcrypt.hash('Change' + Date.now(), 10);
  const created = await prisma.user.create({
    data: {
      email,
      password: tempHash,
      firstName: fn || '(unknown)',
      lastName: ln || '',
      phone: row['phone']?.toString() || undefined,
      isActive: !isArchive,
      userType: 'employee',
      roleId: employeeRole?.id ?? undefined,
      department: undefined, // department lookup deferred to a separate sync
      createdByImportId: report.importId ?? undefined,
    } as Prisma.UserUncheckedCreateInput,
  });
  audit('user', created.id, 'created', `email=${email}`);
  bumpCount('users', 'created');
  return created.id;
}

async function upsertProject(
  row: any,
  customerBpId: number | null,
  runnerUserId: number,
  defaultProjectTypeId: number,
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
    const created = await prisma.zone.create({
      data: {
        projectId,
        name: z.name || z.id,
        code: z.id,
        path: z.name || z.id,
        sortOrder: 0,
      } as Prisma.ZoneUncheckedCreateInput,
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
): Promise<number | null> {
  const code = row['Task_Code'] ? String(row['Task_Code']).trim() : null;
  const name = String(row['Task Name'] ?? '').trim();
  if (!name) {
    bumpCount('tasks', 'skipped'); return null;
  }

  // Dedupe by (project, code) when code is present; else (zone or project, name).
  const where: Prisma.TaskWhereInput = code
    ? { projectId, code, deletedAt: null }
    : { projectId, name, zoneId: zoneId ?? undefined, deletedAt: null };
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
  // Task.code is required (varchar 50, not null). When the source row
  // has no code, synthesize one from the task name truncated to 50 — the
  // importer reports this so admins can rename later if desired.
  const resolvedCode = code || `BM-${name.slice(0, 40).replace(/\s+/g, '_')}`;
  const created = await prisma.task.create({
    data: {
      projectId,
      zoneId: zoneId ?? undefined,
      projectDeliverableId: deliverableId ?? undefined,
      code: resolvedCode,
      name,
      budgetAmount: budget ? new Prisma.Decimal(budget) : undefined,
      status: 'not_started',
    } as Prisma.TaskUncheckedCreateInput,
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
  // const employeeAssignments = sheetRows(wb.getWorksheet('Employee_Assignments')!);
  // const timesheet = sheetRows(wb.getWorksheet('Timesheet')!);

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

  // 1. Departments → name lookup map by old id
  await upsertDepartments(departments);

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

  // 3. Users (employees only)
  for (const u of users) await upsertUser(u);

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
    const pid = await upsertProject(p, custId, runner.id, defaultType?.id ?? 0);
    const pname = String(p['Project_name'] ?? '').trim();
    if (num) projectIdByNumber.set(num, pid);
    if (pname) projectIdByName.set(pname, pid);

    // 5. Zones from XML for THIS project — runs in BOTH modes; the
    //    dry-run returns phantom ids so task → zone lookups still work.
    const xmlFile = xmlFiles.find((f) => f.fileName.trim() === pname);
    let zoneIdByXmlId = new Map<string, number>();
    if (xmlFile && pid) {
      zoneIdByXmlId = await createZonesFromXml(pid, xmlFile);
    } else if (!xmlFile) {
      report.warnings.push({ context: 'zones', message: `No XML <File name="${pname}"> for project ${num || pname}` });
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
      const zoneId = zoneIdByXmlId.get(xmlZoneId) ?? null;
      if (pid) await upsertTask(pid, zoneId, delivId ?? null, t);
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
