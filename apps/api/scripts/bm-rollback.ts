/**
 * BM data migration rollback — undo a committed import run from
 * scripts/bm-migrate.ts.
 *
 *   npx ts-node scripts/bm-rollback.ts --import-id 12
 *   npx ts-node scripts/bm-rollback.ts --import-id 12 --force   # skip confirm
 *
 * Reads ImportLog rows for the given import, walks them DESC by
 * sortOrder (so children disappear before parents), and deletes each
 * entity by its entity_id. Wrapped in a single transaction — if any
 * delete fails, the whole rollback aborts and nothing is touched.
 *
 * Safety:
 *   • Refuses to roll back an import that already has rolledBackAt set.
 *   • Refuses if DataImport.expiresAt has passed (default 30 days).
 *   • Prompts for confirmation unless --force is passed.
 *   • Catalog entries logged with action='linked' are SKIPPED — those
 *     rows pre-existed or are shared with other data.
 *
 * After success: DataImport.status = 'rolled_back' and rolledBackAt is
 * stamped; the audit rows themselves stay so the trail survives. The
 * audit rows are removed automatically with the DataImport (cascade)
 * if anyone later deletes the import.
 */
import * as readline from 'readline';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const IMPORT_ID = (() => {
  const i = args.indexOf('--import-id');
  return i >= 0 ? Number(args[i + 1]) : NaN;
})();

const COLORS: Record<string, string> = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', ok: '\x1b[32m' };
function log(lvl: 'info' | 'warn' | 'error' | 'ok', msg: string) {
  // eslint-disable-next-line no-console
  console.log(`${COLORS[lvl]}[${lvl}]\x1b[0m ${msg}`);
}

async function confirm(question: string): Promise<boolean> {
  if (FORCE) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

// Delete dispatch table — maps the snake-case entity_type the importer
// writes to the prisma model that owns it. Returning false skips the row.
async function deleteOne(tx: Prisma.TransactionClient, type: string, id: number): Promise<boolean> {
  try {
    switch (type) {
      case 'time_entry':           await tx.timeEntry.delete({ where: { id } }); return true;
      case 'task_assignee':        await tx.taskAssignee.delete({ where: { id } }); return true;
      case 'project_partner_role': await tx.projectPartnerRole.delete({ where: { id } }); return true;
      case 'task':                 await tx.task.delete({ where: { id } }); return true;
      case 'project_deliverable':  await tx.projectDeliverable.delete({ where: { id } }); return true;
      case 'zone':                 await tx.zone.delete({ where: { id } }); return true;
      case 'project':              await tx.project.delete({ where: { id } }); return true;
      case 'user':                 await tx.user.delete({ where: { id } }); return true;
      case 'business_partner':     await tx.businessPartner.delete({ where: { id } }); return true;
      // Catalog rows — shared, never deleted on rollback.
      case 'phase':
      case 'service':
      case 'profession':
      case 'department':           return false;
      default:
        log('warn', `Unknown entity_type=${type} — skipping`);
        return false;
    }
  } catch (err: any) {
    // P2025 = "record to delete does not exist" — already gone, treat as success.
    if (err?.code === 'P2025') return true;
    throw err;
  }
}

async function main() {
  if (!Number.isFinite(IMPORT_ID)) {
    log('error', 'Pass --import-id <id> (the DataImport.id from the migrate run).');
    process.exit(2);
  }

  const di = await prisma.dataImport.findUnique({ where: { id: IMPORT_ID } });
  if (!di) { log('error', `DataImport ${IMPORT_ID} not found.`); process.exit(2); }
  if (di.rolledBackAt) {
    log('error', `Import ${IMPORT_ID} was already rolled back at ${di.rolledBackAt.toISOString()}.`);
    process.exit(2);
  }
  if (di.expiresAt && di.expiresAt < new Date()) {
    log('error', `Import ${IMPORT_ID} expired at ${di.expiresAt.toISOString()} — rollback disabled.`);
    process.exit(2);
  }

  // Stats for the confirmation prompt.
  const totalRows = await prisma.importLog.count({ where: { importId: IMPORT_ID } });
  const createdRows = await prisma.importLog.count({ where: { importId: IMPORT_ID, action: 'created' } });
  const byType = await prisma.importLog.groupBy({
    by: ['entityType', 'action'],
    where: { importId: IMPORT_ID },
    _count: { _all: true },
  });

  log('info', `Import id=${IMPORT_ID} target=${di.target} status=${di.status}`);
  log('info', `Started ${di.startedAt.toISOString()}; ${totalRows} audit rows (${createdRows} 'created').`);
  log('info', 'Breakdown:');
  for (const r of byType) {
    log('info', `  ${r.entityType.padEnd(24)} ${r.action.padEnd(10)} ${r._count._all}`);
  }

  const ok = await confirm(`Delete all ${createdRows} entities created by this import?`);
  if (!ok) { log('warn', 'Aborted.'); process.exit(0); }

  // Walk DESC by sort_order. The whole rollback runs inside ONE
  // transaction — partial deletes can't leave the DB in a half-state.
  const logs = await prisma.importLog.findMany({
    where: { importId: IMPORT_ID },
    orderBy: { sortOrder: 'desc' },
  });

  let deleted = 0, skipped = 0;
  await prisma.$transaction(async (tx) => {
    for (const r of logs) {
      if (r.action !== 'created') { skipped++; continue; }
      const ok = await deleteOne(tx, r.entityType, r.entityId);
      if (ok) deleted++; else skipped++;
    }
    await tx.dataImport.update({
      where: { id: IMPORT_ID },
      data: { status: 'rolled_back', rolledBackAt: new Date() },
    });
  }, { timeout: 5 * 60 * 1000 });

  log('ok', `Rolled back: deleted=${deleted} skipped=${skipped} of ${totalRows} audit rows.`);
}

main()
  .catch((err) => { log('error', err.stack ?? String(err)); process.exit(1); })
  .finally(() => prisma.$disconnect());
