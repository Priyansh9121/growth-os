/**
 * Development seed data.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Creates a tenancy graph that exercises every access path the product
 * supports, so that local development and integration tests run against
 * realistic structure rather than a single trivial user.
 *
 * SAFETY
 *  - Refuses to run when NODE_ENV=production.
 *  - Every email uses the `.test` TLD, which RFC 6761 reserves as permanently
 *    unresolvable. These addresses cannot receive mail even by accident.
 *  - All names are invented businesses. No real person or company appears.
 *  - The password comes from SEED_PASSWORD and is never committed.
 *
 * WHAT THE GRAPH PROVES
 *
 *   Northbeam Growth Partners (agency)
 *     ├── ABC Plumbing         (client workspace)
 *     └── Harbour Dental       (client workspace)
 *   Meridian Legal             (direct workspace, no agency)
 *
 *   sam@abcplumbing.test     owner of ABC Plumbing         → 1 workspace
 *   riley@northbeam.test     agency_admin at Northbeam     → 2 workspaces (transitive)
 *   jordan@meridianlegal.test owner of Meridian Legal      → 1 workspace
 *
 * Riley reaching two workspaces without any row in `memberships` is the
 * agency model working. Jordan being unable to see either of Riley's
 * workspaces is what the cross-tenant denial tests assert.
 *
 * Run with:  npm run db:seed
 */

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { hash } from '@node-rs/argon2';
import * as schema from '../schema/index';

/** Matches packages/auth/src/password.ts. Duplicated to avoid a dependency cycle. */
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required.');

  const password = process.env['SEED_PASSWORD'];
  if (!password) {
    throw new Error('SEED_PASSWORD is required. See .env.example.');
  }
  if (password.length < 12) {
    throw new Error('SEED_PASSWORD must be at least 12 characters.');
  }

  const client = postgres(connectionString, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });

  try {
    const passwordHash = await hash(password, ARGON2_OPTIONS);

    await db.transaction(async (tx) => {
      // Idempotent: delete the seeded users first. Cascades remove their
      // memberships and sessions, so re-seeding is safe and repeatable.
      await tx.delete(schema.users);
      await tx.delete(schema.workspaces);
      await tx.delete(schema.agencies);

      const [agency] = await tx
        .insert(schema.agencies)
        .values({ name: 'Northbeam Growth Partners', slug: 'northbeam' })
        .returning();
      if (!agency) throw new Error('Failed to insert agency');

      const workspaceRows = await tx
        .insert(schema.workspaces)
        .values([
          {
            name: 'ABC Plumbing',
            slug: 'abc-plumbing',
            agencyId: agency.id,
            timezone: 'Australia/Melbourne',
          },
          {
            name: 'Harbour Dental',
            slug: 'harbour-dental',
            agencyId: agency.id,
            timezone: 'Australia/Sydney',
          },
          // No agency: a direct business, and the isolation counterexample.
          {
            name: 'Meridian Legal',
            slug: 'meridian-legal',
            agencyId: null,
            timezone: 'Australia/Brisbane',
          },
        ])
        .returning();

      const bySlug = new Map(workspaceRows.map((row) => [row.slug, row]));
      const abcPlumbing = bySlug.get('abc-plumbing');
      const meridianLegal = bySlug.get('meridian-legal');
      if (!abcPlumbing || !meridianLegal) throw new Error('Failed to insert workspaces');

      const userRows = await tx
        .insert(schema.users)
        .values([
          {
            email: 'sam@abcplumbing.test',
            name: 'Sam Whitfield',
            passwordHash,
            emailVerifiedAt: new Date(),
          },
          {
            email: 'riley@northbeam.test',
            name: 'Riley Okafor',
            passwordHash,
            emailVerifiedAt: new Date(),
          },
          {
            email: 'jordan@meridianlegal.test',
            name: 'Jordan Vasquez',
            passwordHash,
            emailVerifiedAt: new Date(),
          },
        ])
        .returning();

      const byEmail = new Map(userRows.map((row) => [row.email, row]));
      const sam = byEmail.get('sam@abcplumbing.test');
      const riley = byEmail.get('riley@northbeam.test');
      const jordan = byEmail.get('jordan@meridianlegal.test');
      if (!sam || !riley || !jordan) throw new Error('Failed to insert users');

      // Direct memberships.
      await tx.insert(schema.memberships).values([
        { userId: sam.id, workspaceId: abcPlumbing.id, role: 'owner' },
        { userId: jordan.id, workspaceId: meridianLegal.id, role: 'owner' },
      ]);

      // Agency membership only — Riley holds NO row in `memberships` and still
      // reaches both client workspaces. That is the transitive path working.
      await tx
        .insert(schema.agencyMemberships)
        .values([{ userId: riley.id, agencyId: agency.id, role: 'agency_admin' }]);
    });

    // ---- CRM demo data --------------------------------------------------
    // Written through the real CRM services, not raw inserts: that produces a
    // genuine activity timeline and exercises provenance validation, so a bug
    // in createContact fails the seed instead of lying dormant.
    const { seedCrmForWorkspace } = await import('./seed-crm');
    const { InProcessEventPublisher } = await import('@growth-os/crm');

    const [abc] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.slug, 'abc-plumbing'))
      .limit(1);
    const [samUser] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'sam@abcplumbing.test'))
      .limit(1);

    let crmCounts = { contacts: 0, opportunities: 0, tasks: 0 };
    if (abc && samUser) {
      crmCounts = await seedCrmForWorkspace(db, () => ({
        deps: { db, events: new InProcessEventPublisher() },
        tenant: {
          actor: {
            userId: samUser.id,
            email: samUser.email,
            name: samUser.name,
            sessionId: 'seed',
            workspaces: [],
            agencies: [],
          },
          workspace: {
            workspaceId: abc.id,
            workspaceName: abc.name,
            workspaceSlug: abc.slug,
            agencyId: abc.agencyId,
            role: 'owner' as const,
            via: 'direct' as const,
          },
        },
        correlationId: 'seed',
      }));
    }

    console.log('Seed complete.\n');
    console.log('  Agency     Northbeam Growth Partners');
    console.log('  Workspaces ABC Plumbing, Harbour Dental (agency) · Meridian Legal (direct)\n');
    console.log('  Accounts (password from SEED_PASSWORD):');
    console.log('    sam@abcplumbing.test       owner of ABC Plumbing');
    console.log('    riley@northbeam.test       agency admin — reaches 2 workspaces transitively');
    console.log('    jordan@meridianlegal.test  owner of Meridian Legal\n');
    console.log('  CRM demo data (ABC Plumbing) — all records fictional:');
    console.log(
      `    ${crmCounts.contacts} contacts · ${crmCounts.opportunities} opportunities · ${crmCounts.tasks} tasks\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
});
