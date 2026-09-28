import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { ProjectPartnerRolesService } from '../project-partner-roles/project-partner-roles.service';
import { extractEligibilityRule } from '../projects/role-eligibility';

/**
 * Phase 4 · Stage 4 follow-up (2026-09-28) — apply a Team Template to a
 * project. Consumes `TeamTemplateMember.projectRoleTypeId` (added in
 * 199465b) and creates the matching `ProjectPartnerRole` rows via the
 * shared M3 eligibility rules.
 *
 * Contract:
 *   - Members without a linked BP (`user.businessPartnerId` NULL) are
 *     skipped with an explicit reason — same policy the Team tab uses.
 *   - Members with `projectRoleTypeId = null` land as `participant`
 *     (Team member, per D9). If the participant role-type is missing
 *     from the catalog the member is skipped with a clear reason.
 *   - Members with a specific `projectRoleTypeId` are pre-checked
 *     against the SAME three-rule eligibility used by the picker AND
 *     the write path in ProjectPartnerRolesService.create()
 *     (allowedPartnerKind / requiredPartnerRoleCode /
 *     requiredProfessionIds). Ineligible → skipped with the reasons
 *     the picker would show ("Must be an Employee", "Needs job title:
 *     BIM Manager"). Eligible → the row goes through the shared
 *     create() path so the audit + U7 team-leader-sync fires.
 *   - Never throws on a partial failure: the endpoint always returns
 *     200 with `applied` + `skipped`, so the FE can surface both.
 */

export interface AppliedRow {
  memberId: number;
  userId: number;
  partyId: number;
  roleName: string;
  projectPartnerRoleId: number;
}

export interface SkippedRow {
  memberId: number;
  userId: number;
  name: string;
  reason: string[];
}

@Injectable()
export class TeamTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ppr: ProjectPartnerRolesService,
  ) {}

  async apply(templateId: number, projectId: number, actorUserId: number | undefined) {
    // Load the template + members with everything we need to run the
    // per-member eligibility gate in-memory — one round trip per join
    // instead of a query per member.
    const template = await this.prisma.teamTemplate.findUnique({
      where: { id: templateId },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                businessPartnerId: true,
              },
            },
            projectRoleType: true,
          },
        },
      },
    });
    if (!template) {
      throw new NotFoundException(`Team template ${templateId} not found`);
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Cache the participant fallback role (D9) once so we don't hit the
    // catalog per skipped-role member. Also pre-load every distinct
    // projectRoleType id that's referenced — the include above already
    // resolves them, but we need the professions catalog for the
    // "Needs job title: …" reason phrasing to match M3's picker.
    const participantRole = await this.prisma.projectRoleType.findUnique({
      where: { code: 'participant' },
    });

    // Pre-load party rows for every member with a BP link. Cheap: at
    // most one row per template member.
    const partyIds = template.members
      .map((m) => m.user?.businessPartnerId)
      .filter((v): v is number => v != null);
    const parties = partyIds.length
      ? await this.prisma.businessPartner.findMany({
          where: { id: { in: partyIds }, deletedAt: null },
          include: {
            roles: { include: { roleType: true } },
            professions: { include: { profession: true } },
          },
        })
      : [];
    const partyById = new Map<number, (typeof parties)[number]>();
    for (const p of parties) partyById.set(p.id, p);

    // Human-readable role-code → label map, matching M3 picker so the
    // "Must be an employee" reason reads the same everywhere.
    // TA-2: labels are lowercase and combined with `article()` so the
    // grammar is correct ("Must be a customer", not "Must be an
    // Customer"). Helper duplicated in the controller + client picker —
    // one string not worth a shared package.
    const roleCodeToLabel: Record<string, string> = {
      employee: 'employee',
      customer: 'customer',
      supplier: 'supplier',
      partner: 'partner',
    };
    const humaniseRoleCode = (c: string) =>
      roleCodeToLabel[c] ?? c.replace(/_/g, ' ').toLowerCase();
    const article = (word: string): 'a' | 'an' => {
      const first = word.trim().charAt(0).toLowerCase();
      return 'aeiou'.includes(first) ? 'an' : 'a';
    };

    // Collect every profession id referenced by any member's target
    // role so we can name them in reasons. Same lookup the M3 picker
    // does (project-role-types.controller#eligibleParties).
    const allRequiredProfIds = new Set<number>();
    for (const m of template.members) {
      const rt = m.projectRoleType;
      if (!rt) continue;
      const ids = Array.isArray(rt.requiredProfessionIds)
        ? (rt.requiredProfessionIds as number[])
        : [];
      for (const id of ids) allRequiredProfIds.add(id);
    }
    const profNameById = new Map<number, string>();
    if (allRequiredProfIds.size > 0) {
      const rows = await this.prisma.profession.findMany({
        where: { id: { in: Array.from(allRequiredProfIds) } },
        select: { id: true, name: true },
      });
      for (const r of rows) profNameById.set(r.id, r.name);
    }

    const applied: AppliedRow[] = [];
    const skipped: SkippedRow[] = [];

    for (const member of template.members) {
      const displayName =
        `${member.user?.firstName ?? ''} ${member.user?.lastName ?? ''}`.trim()
        || member.user?.email
        || `User #${member.userId}`;

      // Missing BP link — same failure the participant upsert (the
      // Team tab add flow) surfaces. Skip with a specific reason so
      // the admin knows to fix the User → BP link.
      if (!member.user?.businessPartnerId) {
        skipped.push({
          memberId: member.id,
          userId: member.userId,
          name: displayName,
          reason: ['User has no linked BusinessPartner. Open the person in People, save once to auto-create the BP link, then re-apply.'],
        });
        continue;
      }

      const partyId = member.user.businessPartnerId;
      const party = partyById.get(partyId);
      if (!party) {
        // BP row was soft-deleted between the include above and now.
        // Rare, but surface it as data — never as a silent drop.
        skipped.push({
          memberId: member.id,
          userId: member.userId,
          name: displayName,
          reason: [`Linked BusinessPartner #${partyId} is missing or deleted.`],
        });
        continue;
      }

      // Route by whether the member has a target role or falls back to
      // participant (D9 default).
      const targetRole = member.projectRoleType;
      const roleToUse = targetRole ?? participantRole;
      if (!roleToUse) {
        skipped.push({
          memberId: member.id,
          userId: member.userId,
          name: displayName,
          reason: [
            'No target role: the template member has no Project Role and the catalog is missing the `participant` fallback (seed is broken).',
          ],
        });
        continue;
      }

      // Run the same three-rule eligibility check the M3 picker does
      // in project-role-types.controller#eligibleParties. Reuse the
      // extractor so the wording drifts nowhere — one source of truth
      // for eligibility across picker + write path + this apply flow.
      const rule = extractEligibilityRule(roleToUse);
      const reasons: string[] = [];
      if (
        rule.allowedPartnerKind
        && rule.allowedPartnerKind !== 'any'
        && rule.allowedPartnerKind !== party.partnerType
      ) {
        reasons.push(
          rule.allowedPartnerKind === 'organization'
            ? `Must be ${article('organization')} organization`
            : `Must be ${article('person contact')} person contact`,
        );
      }
      if (rule.requiredPartnerRoleCode) {
        const holds = party.roles.some(
          (r) => r.roleType.code === rule.requiredPartnerRoleCode,
        );
        if (!holds) {
          const name = humaniseRoleCode(rule.requiredPartnerRoleCode);
          reasons.push(`Must be ${article(name)} ${name}`);
        }
      }
      if (rule.requiredProfessionIds.length > 0) {
        const partyProfIds = new Set(
          party.professions.map((p) => p.professionId),
        );
        const hit = rule.requiredProfessionIds.some((id) =>
          partyProfIds.has(id),
        );
        if (!hit) {
          const label = rule.requiredProfessionIds
            .map((id) => profNameById.get(id))
            .filter((n): n is string => !!n)
            .join(' or ');
          reasons.push(
            label ? `Needs job title: ${label}` : 'Needs a required job title',
          );
        }
      }

      if (reasons.length > 0) {
        skipped.push({
          memberId: member.id,
          userId: member.userId,
          name: displayName,
          reason: reasons,
        });
        continue;
      }

      // Eligible — route through the shared create() path so the
      // audit log entry, per-project ProjectPartnerRole @@unique, U7
      // leader sync, and BP-role auto-tag all fire the same way as
      // when an admin clicks "Add" on the Team tab. Any late duplicate
      // (already assigned to the same role at this validFrom) raises
      // ConflictException — catch it and report the member as skipped
      // rather than aborting the whole batch.
      try {
        const created = await this.ppr.create(
          {
            projectId,
            partyId,
            roleId: roleToUse.id,
            // Template members never carry the "primary" flag today —
            // primary is a per-project decision. Same default the
            // participant upsert uses.
            isPrimary: false,
          },
          actorUserId,
        );
        applied.push({
          memberId: member.id,
          userId: member.userId,
          partyId,
          roleName: roleToUse.name,
          projectPartnerRoleId: created.id,
        });
      } catch (err: any) {
        // Surface the exception message so admins can see why (e.g.
        // "already assigned" duplicates). Never abort the batch.
        skipped.push({
          memberId: member.id,
          userId: member.userId,
          name: displayName,
          reason: [String(err?.message ?? err ?? 'Failed to create assignment')],
        });
      }
    }

    return {
      templateId: template.id,
      templateName: template.name,
      projectId: project.id,
      applied,
      skipped,
    };
  }
}
