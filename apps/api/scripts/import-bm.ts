/**
 * BM data migration — imports a single project from the BM Excel + XML files
 * into Planwise. Default is dry-run; pass --commit to actually write.
 *
 * Usage:
 *   pnpm tsx scripts/import-bm.ts --project="דרך חברון אסדן"
 *   pnpm tsx scripts/import-bm.ts --project="דרך חברון אסדן" --commit
 *
 * Env overrides:
 *   BM_XLSX                 path to the Excel file
 *   BM_XML                  path to the XML file
 *   BM_IMPORTER_USER_ID     existing user id used as createdBy (default 1)
 *   BM_DEFAULT_PROJECT_TYPE name of the ProjectType to use (default first one)
 *   BM_DEFAULT_ROLE         name of the Role for new users (default "Employee")
 *
 * What it does:
 *   - Parses Zones from ALL.XML for the matching <File> entry
 *   - Parses 4 Excel sheets: Projects, Assignments, Employee_Assignments 2,
 *     Timesheet, Users
 *   - Creates: Project, Zones, Users (password=AMEC1234), ServiceTypes (upsert),
 *     ProjectDeliverables (per-project), Tasks, TaskAssignees, TimeEntries
 *   - All writes inside one Prisma transaction. Any error rolls back.
 *
 * Hard rule: if a Project with the same number already exists, the script
 * aborts. Idempotency is by design — re-running on dirty state is unsafe.
 */
import { PrismaClient, Prisma, TaskStatus, ZoneType, UserType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';

// ─── CLI ────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
if (!args.project) {
  console.error('Usage: pnpm ts-node scripts/import-bm.ts --project="<project name>" [--commit]');
  process.exit(2);
}
const PROJECT_NAME: string = args.project;
const COMMIT = !!args.commit;

const XLSX_PATH = process.env.BM_XLSX || 'C:/Users/yulia/Downloads/BM Data migration.xlsx';
const XML_PATH = process.env.BM_XML || 'C:/Users/yulia/Downloads/ALL.XML';
const IMPORTER_USER_ID = Number(process.env.BM_IMPORTER_USER_ID || 1);
const DEFAULT_PASSWORD = 'AMEC1234';

const prisma = new PrismaClient();

// ─── Types ──────────────────────────────────────────────────────────────
type XmlNode = {
  tag: 'lot' | 'building' | 'level' | 'project';
  id: string;             // e.g. "B0031", "C0098"
  name: string;
  fatherName?: string;    // parent's name (XML <Father> uses NAME, not id)
};

type ZoneRow = {
  xmlId: string;
  name: string;
  zoneType: ZoneType;
  depth: number;
  parentXmlId: string | null;
  childrenXmlIds: string[];
};

type AssignmentRow = {
  rowIndex: number;
  projectName: string;
  service: string | null;
  zone: string | null;
  deliverable: string | null;
  taskCode: string | null;
  assignmentName: string;
  budget: number | null;
};

type TimesheetRow = {
  rowIndex: number;
  projectName: string;
  assignmentName: string;
  bmAssignmentId: number | null;   // bm internal id (no Planwise FK)
  userBmId: number | null;          // bm internal user id → mapped to Planwise userId
  startTimeSec: number | null;
  endTimeSec: number | null;
  date: Date | null;
  description: string | null;
  hours: number;
  location: string | null;
};

type EmpAsnRow = {
  rowIndex: number;
  userBmId: number;
  userName: string | null;
  assignmentName: string;
  bmAssignmentId: number;
  status: string;
  dueDate: Date | null;
  startDate: Date | null;
  endDate: Date | null;
  projectName: string;
};

type UserRow = {
  bmId: number;
  name: string;
  email: string;
  phone: string | null;
  category: string | null;
  workingHours: number | null;
  rate: number | null;
  isArchived: boolean;
};

type ProjectRow = {
  name: string;
  number: string | null;
  contractAmount: number | null;
};

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  log(`BM migration — project: ${PROJECT_NAME}`);
  log(`Mode: ${COMMIT ? 'COMMIT (writes to DB!)' : 'DRY-RUN (no writes)'}`);
  log('');

  // Step 1: load sources
  log('1. Loading sources...');
  const xmlFile = parseXmlForProject(XML_PATH, PROJECT_NAME);
  if (!xmlFile) {
    fatal(`No matching <File> in XML for project ${PROJECT_NAME}`);
  }
  log(`   XML: matched File="${xmlFile.name}" with ${xmlFile.nodes.length} nodes`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);
  log(`   Excel: loaded ${XLSX_PATH}`);

  const projectRow = readProjectsSheet(wb).find((p) => p.name === PROJECT_NAME);
  if (!projectRow) fatal(`Project "${PROJECT_NAME}" not found in Projects sheet`);
  if (!projectRow.number) fatal(`Project "${PROJECT_NAME}" has no Project_Number — refusing to import`);

  const assignments = readAssignmentsSheet(wb).filter((a) => a.projectName === PROJECT_NAME);
  const timesheet = readTimesheetSheet(wb).filter((t) => t.projectName === PROJECT_NAME);
  const empAsn = readEmpAsnSheet(wb).filter((e) => e.projectName === PROJECT_NAME);
  const allUsers = readUsersSheet(wb);
  log(`   Scoped rows: Assignments=${assignments.length} Timesheet=${timesheet.length} EmpAsn=${empAsn.length}`);

  // Step 2: build zone tree from XML
  log('');
  log('2. Building zone tree from XML...');
  const zoneTree = buildZoneTree(xmlFile.nodes);
  log(`   Zone tree: ${zoneTree.length} nodes (max depth ${Math.max(...zoneTree.map((z) => z.depth))})`);
  printZoneTree(zoneTree);

  // Step 3: identify users we need to import
  log('');
  log('3. Identifying users in scope...');
  const userBmIds = new Set<number>();
  for (const e of empAsn) userBmIds.add(e.userBmId);
  for (const t of timesheet) if (t.userBmId) userBmIds.add(t.userBmId);
  const usersInScope = allUsers.filter((u) => userBmIds.has(u.bmId));
  log(`   Users involved: ${usersInScope.length} (bm ids: ${[...userBmIds].sort().join(', ')})`);

  // Step 4: services + deliverables
  log('');
  log('4. Services + deliverables...');
  const services = uniq(assignments.map((a) => normalizeService(a.service)).filter(Boolean) as string[]);
  const deliverables = uniq(assignments.map((a) => a.deliverable).filter((d) => d && d !== 'no match') as string[]);
  log(`   Services: ${services.join(', ')}`);
  log(`   Deliverables (${deliverables.length}): ${deliverables.join(' | ')}`);

  // Step 5: validate zone references
  log('');
  log('5. Validating zone references...');
  const zoneByXmlId = new Map(zoneTree.map((z) => [z.xmlId, z]));
  const zoneByName = mapByName(zoneTree);
  const zoneIssues: string[] = [];
  let noZoneCount = 0;
  for (const a of assignments) {
    if (isNoZone(a.zone)) { noZoneCount++; continue; }
    const resolved = resolveZone(a.zone!, zoneByXmlId, zoneByName);
    if (!resolved) zoneIssues.push(`  row ${a.rowIndex}: Zone "${a.zone}" cannot be resolved for "${a.assignmentName}"`);
  }
  log(`   ${noZoneCount}/${assignments.length} → NO_ZONE (root)`);
  log(`   ${assignments.length - noZoneCount - zoneIssues.length}/${assignments.length} → resolved to specific zone`);
  if (zoneIssues.length > 0) {
    log(`   ${zoneIssues.length} UNRESOLVABLE zones — these rows will be put under NO_ZONE with a warning:`);
    for (const z of zoneIssues) log(z);
  }

  // Step 6: validate timesheet → assignment match (by name fallback)
  log('');
  log('6. Validating timesheet → assignment match (name-based join)...');
  const asnByName = new Map<string, AssignmentRow[]>();
  for (const a of assignments) {
    const list = asnByName.get(a.assignmentName) || [];
    list.push(a);
    asnByName.set(a.assignmentName, list);
  }
  let tsResolved = 0, tsAmbiguous = 0, tsMissing = 0;
  for (const t of timesheet) {
    const candidates = asnByName.get(t.assignmentName) || [];
    if (candidates.length === 1) tsResolved++;
    else if (candidates.length === 0) tsMissing++;
    else tsAmbiguous++;
  }
  log(`   Timesheet: ${tsResolved} resolved, ${tsAmbiguous} ambiguous, ${tsMissing} no match`);
  if (tsAmbiguous > 0 || tsMissing > 0) {
    log(`   WARNING: ${tsAmbiguous + tsMissing} time-entries will be created WITHOUT a task link`);
  }

  // Step 7: pre-flight DB checks
  log('');
  log('7. Pre-flight DB checks...');
  const importer = await prisma.user.findUnique({ where: { id: IMPORTER_USER_ID } });
  if (!importer) fatal(`Importer user id=${IMPORTER_USER_ID} not found (set BM_IMPORTER_USER_ID env)`);
  log(`   Importer user: ${importer.firstName} ${importer.lastName} (id=${importer.id})`);

  const existingProject = await prisma.project.findFirst({
    where: { number: String(projectRow.number) },
  });
  if (existingProject) {
    fatal(`A project with number ${projectRow.number} already exists (id=${existingProject.id}, name="${existingProject.name}"). Aborting to avoid duplicate import.`);
  }

  const projectTypeName = process.env.BM_DEFAULT_PROJECT_TYPE;
  const projectType = projectTypeName
    ? await prisma.projectType.findFirst({ where: { name: projectTypeName } })
    : await prisma.projectType.findFirst({ orderBy: { id: 'asc' } });
  if (!projectType) fatal('No ProjectType found in DB. Seed at least one project type first.');
  log(`   Project type: ${projectType.name} (id=${projectType.id})`);

  const roleName = process.env.BM_DEFAULT_ROLE || 'Employee';
  const role = await prisma.role.findFirst({ where: { name: roleName } });
  if (!role) fatal(`Role "${roleName}" not found. Seed roles first or set BM_DEFAULT_ROLE.`);
  log(`   Default role for new users: ${role.name} (id=${role.id})`);

  // Step 8: write summary
  log('');
  log('═══════════════════════════════════════════════════════════════');
  log('PLAN SUMMARY');
  log('═══════════════════════════════════════════════════════════════');
  log(`  Project              1   "${projectRow.name}" #${projectRow.number}`);
  log(`  Zones                ${zoneTree.length + 1}  (${zoneTree.length} from XML + 1 NO_ZONE root)`);
  log(`  ServiceTypes (upsert) ${services.length}`);
  log(`  ProjectDeliverables  ${deliverables.length}`);
  log(`  Users (upsert)       ${usersInScope.length}`);
  log(`  Tasks                ${assignments.length}`);
  log(`  TaskAssignees        ${empAsn.length}`);
  log(`  TimeEntries          ${timesheet.length}  (total hours: ${timesheet.reduce((s, t) => s + t.hours, 0).toFixed(1)})`);
  log('═══════════════════════════════════════════════════════════════');

  if (!COMMIT) {
    log('');
    log('DRY-RUN complete. Re-run with --commit to actually write.');
    return;
  }

  // ─── Step 9: COMMIT ───────────────────────────────────────────
  log('');
  log('9. COMMITTING to DB...');
  await prisma.$transaction(async (tx) => {
    // 9a. Project
    const project = await tx.project.create({
      data: {
        name: projectRow.name,
        number: String(projectRow.number),
        projectTypeId: projectType.id,
        status: 'active',
        estimatedValue: projectRow.contractAmount
          ? new Prisma.Decimal(projectRow.contractAmount)
          : null,
        createdBy: IMPORTER_USER_ID,
      },
    });
    log(`   Project created: id=${project.id}`);

    // 9b. NO_ZONE root + actual zones
    const noZoneRoot = await tx.zone.create({
      data: {
        projectId: project.id,
        name: 'NO_ZONE',
        zoneType: ZoneType.zone,
        path: 'NO_ZONE',
        depth: 0,
        sortOrder: 0,
      },
    });
    const zoneIdByXmlId = new Map<string, number>();
    const zoneIdByName = new Map<string, number>();
    // Sort by depth so parents are created before children
    const sorted = [...zoneTree].sort((a, b) => a.depth - b.depth);
    for (const z of sorted) {
      const parentId = z.parentXmlId ? zoneIdByXmlId.get(z.parentXmlId) ?? null : null;
      const created = await tx.zone.create({
        data: {
          projectId: project.id,
          parentId,
          name: z.name,
          code: z.xmlId,
          zoneType: z.zoneType,
          path: buildPath(z, zoneTree),
          depth: z.depth + 1, // depth 0 reserved for NO_ZONE
          sortOrder: 0,
        },
      });
      zoneIdByXmlId.set(z.xmlId, created.id);
      zoneIdByName.set(z.name, created.id);
    }
    log(`   Zones created: ${zoneIdByXmlId.size + 1} (incl NO_ZONE root)`);

    // 9c. ServiceTypes (upsert)
    const serviceIdByName = new Map<string, number>();
    for (const s of services) {
      const st = await tx.serviceType.upsert({
        where: { name: s },
        update: {},
        create: { name: s },
      });
      serviceIdByName.set(s, st.id);
    }

    // 9d. ProjectDeliverables (per-project, on the fly)
    const deliverableIdByName = new Map<string, number>();
    for (let i = 0; i < deliverables.length; i++) {
      const d = await tx.projectDeliverable.create({
        data: {
          projectId: project.id,
          name: deliverables[i],
          sortOrder: i,
        },
      });
      deliverableIdByName.set(deliverables[i], d.id);
    }

    // 9e. Users (upsert by email, skip if already present)
    const userIdByBmId = new Map<number, number>();
    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
    for (const u of usersInScope) {
      const [firstName, ...rest] = (u.name || '').split(' ');
      const lastName = rest.join(' ') || '_';
      const existing = await tx.user.findUnique({ where: { email: u.email } });
      let userId: number;
      if (existing) {
        userId = existing.id;
      } else {
        const created = await tx.user.create({
          data: {
            email: u.email || `bm-${u.bmId}@import.local`,
            password: passwordHash,
            firstName: firstName || u.name || 'BM',
            lastName,
            phone: u.phone,
            roleId: role.id,
            userType: UserType.employee,
            employeeCategory: u.category,
            isActive: !u.isArchived,
            salaryHourly: u.rate ? new Prisma.Decimal(u.rate) : null,
            dailyStandardHours: u.workingHours ? new Prisma.Decimal(u.workingHours) : null,
          },
        });
        userId = created.id;
      }
      userIdByBmId.set(u.bmId, userId);
    }
    log(`   Users mapped: ${userIdByBmId.size}`);

    // 9f. Tasks
    const taskIdByAssignmentRow = new Map<number, number>();
    for (const a of assignments) {
      const zoneId = isNoZone(a.zone)
        ? noZoneRoot.id
        : (zoneIdByXmlId.get(normalizeXmlId(a.zone!)) ?? zoneIdByName.get(a.zone!) ?? noZoneRoot.id);
      const deliverableId = a.deliverable && a.deliverable !== 'no match'
        ? deliverableIdByName.get(a.deliverable) ?? null
        : null;
      const serviceTypeId = a.service ? serviceIdByName.get(normalizeService(a.service)!) ?? null : null;

      const task = await tx.task.create({
        data: {
          projectId: project.id,
          zoneId,
          serviceTypeId,
          projectDeliverableId: deliverableId,
          code: a.taskCode || `BM-${a.rowIndex}`,
          name: a.assignmentName,
          budgetAmount: a.budget ? new Prisma.Decimal(a.budget) : null,
          createdBy: IMPORTER_USER_ID,
        },
      });
      taskIdByAssignmentRow.set(a.rowIndex, task.id);
    }
    log(`   Tasks created: ${taskIdByAssignmentRow.size}`);

    // 9g. Task assignees (with status from BM)
    const statusMap: Record<string, TaskStatus> = {
      'Completed': TaskStatus.completed,
      'Working on it': TaskStatus.in_progress,
      'Not Started': TaskStatus.not_started,
      'Stuck': TaskStatus.on_hold,
    };
    const asnRowByName = new Map<string, AssignmentRow>();
    for (const a of assignments) asnRowByName.set(a.assignmentName, a);
    let assigneeCount = 0;
    for (const e of empAsn) {
      const userId = userIdByBmId.get(e.userBmId);
      const asn = asnRowByName.get(e.assignmentName);
      if (!userId || !asn) continue;
      const taskId = taskIdByAssignmentRow.get(asn.rowIndex);
      if (!taskId) continue;
      const status = statusMap[e.status] || TaskStatus.not_started;

      // Upsert: same (taskId, userId) shouldn't double-insert
      await tx.taskAssignee.upsert({
        where: { taskId_userId: { taskId, userId } },
        update: {},
        create: { taskId, userId, startDate: e.startDate, endDate: e.endDate },
      });
      // Reflect status on the task itself (last write wins — fine for migration)
      await tx.task.update({ where: { id: taskId }, data: { status } });
      assigneeCount++;
    }
    log(`   TaskAssignees created: ${assigneeCount}`);

    // 9h. Time entries
    let timeCount = 0;
    for (const t of timesheet) {
      const userId = t.userBmId ? userIdByBmId.get(t.userBmId) : null;
      if (!userId || !t.date) continue;
      const asn = asnRowByName.get(t.assignmentName);
      const taskId = asn ? taskIdByAssignmentRow.get(asn.rowIndex) ?? null : null;
      const minutes = Math.round(t.hours * 60);

      await tx.timeEntry.create({
        data: {
          userId,
          projectId: project.id,
          taskId,
          date: t.date,
          startTime: secondsToHHmm(t.startTimeSec),
          endTime: secondsToHHmm(t.endTimeSec),
          minutes,
          note: t.description,
          location: (t.location || '').slice(0, 20),
        },
      });
      timeCount++;
    }
    log(`   TimeEntries created: ${timeCount}`);
  }, { timeout: 60_000 });

  log('');
  log('✓ COMMIT complete.');
}

// ─── Helpers: CLI ────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { project?: string; commit?: boolean } {
  const result: any = {};
  for (const a of argv) {
    if (a === '--commit') result.commit = true;
    else if (a.startsWith('--project=')) result.project = a.slice('--project='.length);
  }
  return result;
}

// ─── Helpers: XML ────────────────────────────────────────────────────────
function parseXmlForProject(xmlPath: string, projectName: string): { name: string; nodes: XmlNode[] } | null {
  const xml = fs.readFileSync(xmlPath, 'utf8');
  // crude but reliable: split on <File ...> ... </File>
  const fileRe = /<File\s+name="([^"]+)">([\s\S]*?)<\/File>/g;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(xml)) !== null) {
    const fname = m[1];
    if (fname === projectName || projectName.includes(fname) || fname.includes(projectName.split(' ')[0])) {
      return { name: fname, nodes: parseXmlFileBody(m[2]) };
    }
  }
  return null;
}

function parseXmlFileBody(body: string): XmlNode[] {
  // Match <Lot|Building|Level|Project id="..."> ... </...> (case-insensitive)
  const nodeRe = /<(Lot|Building|Level|Project)\s+id="([^"]+)"\s*>([\s\S]*?)<\/\1\s*>/gi;
  const nodes: XmlNode[] = [];
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(body)) !== null) {
    const tag = m[1].toLowerCase() as XmlNode['tag'];
    const id = m[2];
    const inner = m[3];
    const nameMatch = inner.match(/<name>([^<]*)<\/name>/i);
    const fatherMatch = inner.match(/<Father>([^<]*)<\/Father>/i);
    nodes.push({
      tag,
      id,
      name: (nameMatch?.[1] || '').trim(),
      fatherName: fatherMatch?.[1]?.trim(),
    });
  }
  return nodes;
}

function buildZoneTree(nodes: XmlNode[]): ZoneRow[] {
  // Resolve parents by Father=name within file scope
  const byName = new Map<string, XmlNode>();
  for (const n of nodes) byName.set(n.name, n);

  const rows: ZoneRow[] = nodes.map((n) => {
    const parent = n.fatherName ? byName.get(n.fatherName) : undefined;
    return {
      xmlId: n.id,
      name: n.name,
      zoneType: mapZoneType(n.tag),
      depth: 0, // fill below
      parentXmlId: parent?.id ?? null,
      childrenXmlIds: [],
    };
  });

  // Compute depth + children
  const byXml = new Map(rows.map((r) => [r.xmlId, r]));
  for (const r of rows) {
    if (r.parentXmlId) byXml.get(r.parentXmlId)!.childrenXmlIds.push(r.xmlId);
  }
  const computeDepth = (r: ZoneRow, seen = new Set<string>()): number => {
    if (!r.parentXmlId || seen.has(r.xmlId)) return 0;
    seen.add(r.xmlId);
    const parent = byXml.get(r.parentXmlId);
    if (!parent) return 0;
    return 1 + computeDepth(parent, seen);
  };
  for (const r of rows) r.depth = computeDepth(r);
  return rows;
}

function mapZoneType(tag: XmlNode['tag']): ZoneType {
  if (tag === 'lot') return ZoneType.site;
  if (tag === 'building') return ZoneType.building;
  if (tag === 'level') return ZoneType.level;
  return ZoneType.zone;
}

function buildPath(z: ZoneRow, all: ZoneRow[]): string {
  const chain: string[] = [z.name];
  let cur: ZoneRow | undefined = z;
  while (cur?.parentXmlId) {
    cur = all.find((x) => x.xmlId === cur!.parentXmlId);
    if (cur) chain.unshift(cur.name);
  }
  return chain.join('/');
}

function printZoneTree(zones: ZoneRow[]) {
  const roots = zones.filter((z) => !z.parentXmlId);
  const childrenOf = (parentXmlId: string) => zones.filter((z) => z.parentXmlId === parentXmlId);
  const recur = (z: ZoneRow, indent: string) => {
    log(`${indent}- ${z.name} [${z.zoneType}] (${z.xmlId})`);
    for (const c of childrenOf(z.xmlId)) recur(c, indent + '  ');
  };
  for (const r of roots) recur(r, '   ');
}

function mapByName(zones: ZoneRow[]): Map<string, ZoneRow[]> {
  const m = new Map<string, ZoneRow[]>();
  for (const z of zones) {
    const list = m.get(z.name) || [];
    list.push(z);
    m.set(z.name, list);
  }
  return m;
}

function isNoZone(raw: string | null): boolean {
  // The migration spec says: Zone="NA" (literal string) → NO_ZONE.
  // Also treat null/empty as NO_ZONE.
  if (!raw) return true;
  const t = raw.trim().toUpperCase();
  return t === 'NA' || t === 'N/A' || t === 'NONE';
}

function normalizeXmlId(raw: string): string {
  // Excel uses "L0098" but XML uses "C0098" for Level nodes. Normalize.
  return raw.replace(/^L(\d+)$/, 'C$1');
}

function resolveZone(
  raw: string,
  byXmlId: Map<string, ZoneRow>,
  byName: Map<string, ZoneRow[]>,
): ZoneRow | null {
  const norm = normalizeXmlId(raw);
  if (byXmlId.has(norm)) return byXmlId.get(norm)!;
  const matches = byName.get(raw);
  if (matches && matches.length === 1) return matches[0];
  return null;
}

// ─── Helpers: Excel ─────────────────────────────────────────────────────
function readProjectsSheet(wb: ExcelJS.Workbook): ProjectRow[] {
  const ws = wb.getWorksheet('Projects');
  if (!ws) return [];
  const headers = readHeaderRow(ws);
  const out: ProjectRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const name = String(getCell(row, headers, 'Project_name') ?? '').trim();
    if (!name) return;
    const numRaw = getCell(row, headers, 'Project_Number ') ?? getCell(row, headers, 'Project_Number');
    const amount = getCell(row, headers, 'contract_amount');
    out.push({
      name,
      number: numRaw != null ? String(Math.trunc(Number(numRaw))) : null,
      contractAmount: amount != null ? Number(amount) : null,
    });
  });
  return out;
}

function readAssignmentsSheet(wb: ExcelJS.Workbook): AssignmentRow[] {
  const ws = wb.getWorksheet('Assignments');
  if (!ws) return [];
  const headers = readHeaderRow(ws);
  const out: AssignmentRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const projectName = String(getCell(row, headers, 'Project_name') ?? '').trim();
    if (!projectName) return;
    out.push({
      rowIndex: rowNum,
      projectName,
      service: nullableStr(getCell(row, headers, 'Service')),
      zone: nullableStr(getCell(row, headers, 'Zone')),
      deliverable: nullableStr(getCell(row, headers, 'Deliverable')),
      taskCode: nullableStr(getCell(row, headers, 'Task code')),
      assignmentName: String(getCell(row, headers, 'Assignment_name') ?? '').trim(),
      budget: numOrNull(getCell(row, headers, 'Assignment_budget')),
    });
  });
  return out;
}

function readTimesheetSheet(wb: ExcelJS.Workbook): TimesheetRow[] {
  const ws = wb.getWorksheet('Timesheet');
  if (!ws) return [];
  const headers = readHeaderRow(ws);
  const out: TimesheetRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const projectName = String(getCell(row, headers, 'Project_name') ?? '').trim();
    if (!projectName) return;
    const dateRaw = getCell(row, headers, 'Timesheet_date');
    out.push({
      rowIndex: rowNum,
      projectName,
      assignmentName: String(getCell(row, headers, 'Assignment_name') ?? '').trim(),
      bmAssignmentId: numOrNull(getCell(row, headers, 'assignment_id')),
      userBmId: numOrNull(getCell(row, headers, 'Timesheet_user_id') ?? getCell(row, headers, 'user_id')),
      startTimeSec: numOrNull(getCell(row, headers, 'Timesheet_start_time')),
      endTimeSec: numOrNull(getCell(row, headers, 'Timesheet_end_time')),
      date: dateRaw instanceof Date ? dateRaw : (dateRaw ? new Date(String(dateRaw)) : null),
      description: nullableStr(getCell(row, headers, 'Timesheet_description')),
      hours: Number(getCell(row, headers, 'Timesheet_hours') ?? 0),
      location: nullableStr(getCell(row, headers, 'location')),
    });
  });
  return out;
}

function readEmpAsnSheet(wb: ExcelJS.Workbook): EmpAsnRow[] {
  const ws = wb.getWorksheet('Employee_Assignments 2');
  if (!ws) return [];
  const headers = readHeaderRow(ws);
  const out: EmpAsnRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const projectName = String(getCell(row, headers, 'Project_name') ?? '').trim();
    if (!projectName) return;
    out.push({
      rowIndex: rowNum,
      userBmId: Number(getCell(row, headers, 'id')),
      userName: nullableStr(getCell(row, headers, 'name')),
      assignmentName: String(getCell(row, headers, 'Assignment_name') ?? '').trim(),
      bmAssignmentId: Number(getCell(row, headers, 'assignment_id')),
      status: String(getCell(row, headers, 'status') ?? '').trim(),
      dueDate: dateOrNull(getCell(row, headers, 'due_date')),
      startDate: dateOrNull(getCell(row, headers, 'start_date')),
      endDate: dateOrNull(getCell(row, headers, 'end_date')),
      projectName,
    });
  });
  return out;
}

function readUsersSheet(wb: ExcelJS.Workbook): UserRow[] {
  const ws = wb.getWorksheet('Users');
  if (!ws) return [];
  const headers = readHeaderRow(ws);
  const out: UserRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const idRaw = getCell(row, headers, 'id');
    if (!idRaw) return;
    const email = String(getCell(row, headers, 'email') ?? '').trim().toLowerCase();
    if (!email) return;
    out.push({
      bmId: Number(idRaw),
      name: String(getCell(row, headers, 'name') ?? '').trim(),
      email,
      phone: nullableStr(getCell(row, headers, 'phone')),
      category: nullableStr(getCell(row, headers, 'category')),
      workingHours: numOrNull(getCell(row, headers, 'working_hours')),
      rate: numOrNull(getCell(row, headers, 'rate')),
      isArchived: Number(getCell(row, headers, 'is_archive') ?? 0) === 1,
    });
  });
  return out;
}

function readHeaderRow(ws: ExcelJS.Worksheet): Map<string, number> {
  const headers = new Map<string, number>();
  const row = ws.getRow(1);
  row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const v = String(cell.value ?? '').trim();
    if (v) headers.set(v, colNumber);
  });
  return headers;
}

function getCell(row: ExcelJS.Row, headers: Map<string, number>, name: string): ExcelJS.CellValue | null {
  const col = headers.get(name);
  if (!col) return null;
  const v = row.getCell(col).value;
  // exceljs sometimes wraps rich text — flatten to string
  if (v && typeof v === 'object' && 'text' in v) return (v as any).text;
  if (v && typeof v === 'object' && 'result' in v) return (v as any).result;
  return v;
}

// ─── Misc ────────────────────────────────────────────────────────────────
function nullableStr(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function numOrNull(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dateOrNull(v: any): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(String(v));
  return Number.isFinite(+d) ? d : null;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function normalizeService(s: string | null): string | null {
  if (!s) return null;
  // "תאום" → "תיאום" (yod added)
  return s.replace('תאום מערכות', 'תיאום מערכות');
}

function secondsToHHmm(sec: number | null): string | null {
  if (sec == null) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function fatal(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

// ─── Entry ──────────────────────────────────────────────────────────────
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
