/**
 * OidcUserResolverService — turns the (validated) ID-token claims from
 * an SSO callback into a Planwise User row we can log in.
 *
 * Three branches, in order:
 *   1. UserIdentity(provider, subject) exists → return its User.
 *      This is the hot path on every non-first login.
 *   2. Fresh subject + email is VERIFIED and its domain is in the
 *      config's allow-list:
 *        a. If a User with that email already exists → link them
 *           (create UserIdentity), return.
 *        b. Otherwise JIT-create a User with the config's defaultRole,
 *           password=null, allowPasswordLogin=true, then link.
 *   3. Anything else (unverified email, domain not allow-listed,
 *      missing subject) → throw ForbiddenException with a helpful
 *      message. The callback controller turns this into a 403 the
 *      user actually sees.
 *
 * We NEVER auto-link on an unverified email. That would let anyone
 * with an @acme.com Google account grab a Planwise account tied to
 * an Entra @acme.com person of the same address.
 */

import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

export interface ResolveInput {
  provider: 'microsoft' | 'google';
  /** Stable subject — Entra `oid`, Google `sub`. NEVER the email. */
  subject: string;
  /** Email as presented by the IdP; may be missing. */
  email: string | null;
  /** True when the IdP asserts the email is verified. */
  emailVerified: boolean;
  /** Preferred display name from the id_token. */
  name: string | null;
  /** CSV of allowed domains from the OrgAuthConfig row. */
  allowedDomainsCsv: string;
  /** Role to assign on JIT-create. */
  defaultRoleId: number;
}

export interface ResolvedUser {
  /** The Planwise User row, with the same shape AuthService.login expects. */
  user: any;
  /** True on JIT-create, false on match/link. Used by the audit line. */
  wasCreated: boolean;
  /** True when this login just linked an existing User to a new identity. */
  wasLinked: boolean;
}

@Injectable()
export class OidcUserResolverService {
  private readonly log = new Logger(OidcUserResolverService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveUser(input: ResolveInput): Promise<ResolvedUser> {
    if (!input.subject) {
      throw new ForbiddenException(
        'SSO callback missing a stable subject (oid/sub). Cannot link to a user.',
      );
    }

    // 1) Existing identity — hot path.
    const existingIdentity = await this.prisma.userIdentity.findFirst({
      where: { provider: input.provider, subject: input.subject },
      include: { user: this.userInclude() },
    });
    if (existingIdentity?.user) {
      // If the user has been deactivated since the last login, refuse.
      if (!existingIdentity.user.isActive) {
        throw new ForbiddenException('This account has been deactivated. Contact your administrator.');
      }
      return { user: existingIdentity.user, wasCreated: false, wasLinked: false };
    }

    // 2/3) Fresh subject — everything else needs a verified email in
    // an allow-listed domain.
    if (!input.email) {
      throw new ForbiddenException(
        'SSO did not return an email. Ask your admin to grant the "email" scope for this app.',
      );
    }
    if (!input.emailVerified) {
      throw new ForbiddenException(
        'The email address on your SSO account is not verified. Only verified emails can be linked to Planwise accounts.',
      );
    }
    const domains = this.parseAllowedDomains(input.allowedDomainsCsv);
    const emailDomain = input.email.split('@')[1]?.toLowerCase();
    if (!emailDomain || (domains.length > 0 && !domains.includes(emailDomain))) {
      throw new ForbiddenException(
        `Your email domain (${emailDomain}) is not permitted to sign in via SSO. Contact your Planwise admin.`,
      );
    }

    // 2a) Existing local user with that (verified) email → link.
    const existingByEmail = await this.prisma.user.findFirst({
      where: { email: input.email, isActive: true },
    });
    if (existingByEmail) {
      await this.prisma.userIdentity.create({
        data: {
          userId: existingByEmail.id,
          provider: input.provider,
          subject: input.subject,
          email: input.email,
        },
      });
      const full = await this.prisma.user.findFirst({
        where: { id: existingByEmail.id },
        include: this.userInclude().include,
      });
      return { user: full, wasCreated: false, wasLinked: true };
    }

    // 2b) JIT-create.
    const [firstName, lastName] = this.splitName(input.name, input.email);
    const created = await this.prisma.user.create({
      data: {
        email: input.email,
        password: null,
        allowPasswordLogin: true,
        firstName,
        lastName,
        // A UserType must be set on the User row; SSO users default
        // to `employee` since Planwise SSO is targeted at internal
        // staff. Admins can flip this on the Employees admin.
        userType: 'employee',
        roleId: input.defaultRoleId,
        isActive: true,
        identities: {
          create: {
            provider: input.provider,
            subject: input.subject,
            email: input.email,
          },
        },
      },
    });
    const full = await this.prisma.user.findFirst({
      where: { id: created.id },
      include: this.userInclude().include,
    });
    this.log.log(`JIT-created user id=${created.id} email=${input.email} via ${input.provider}`);
    return { user: full, wasCreated: true, wasLinked: true };
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private userInclude() {
    // Match the shape AuthService.login expects — same includes as
    // validateUser's second lookup.
    return {
      include: {
        role: {
          include: {
            roleModules: { include: { module: true } },
          },
        },
      },
    };
  }

  private parseAllowedDomains(csv: string): string[] {
    return (csv ?? '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }

  private splitName(name: string | null, email: string): [string, string] {
    if (name && name.trim().length > 0) {
      const parts = name.trim().split(/\s+/);
      if (parts.length === 1) return [parts[0], ''];
      // Last word is last name; everything before is first name(s).
      const last = parts[parts.length - 1];
      const first = parts.slice(0, -1).join(' ');
      return [first, last];
    }
    // Fall back to the email local-part when name is missing.
    const local = email.split('@')[0] ?? 'User';
    return [local, ''];
  }
}
