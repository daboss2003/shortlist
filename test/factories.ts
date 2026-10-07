import { db } from "@/db";
import { companies, jobs, users } from "@/db/schema";

let n = 0;

/** Creates a company + one user. Password hash is a placeholder; use hashPassword() when a test logs in. */
export async function makeCompany(name = `Acme ${++n}`) {
  const [company] = await db.insert(companies).values({ name }).returning();
  const [user] = await db
    .insert(users)
    .values({ companyId: company.id, name: "Owner", email: `owner${++n}-${crypto.randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" })
    .returning();
  return { company, user };
}

export async function makeJob(companyId: string, overrides: Partial<typeof jobs.$inferInsert> = {}) {
  const [job] = await db
    .insert(jobs)
    .values({
      companyId,
      slug: `job-${++n}-${crypto.randomUUID().slice(0, 8)}`,
      title: "Senior Backend Engineer",
      description: "Build and run our payments APIs.",
      requirements: "5+ years Node.js, PostgreSQL, AWS.",
      skills: ["Node.js", "TypeScript", "PostgreSQL", "AWS"],
      minExperienceYears: 5,
      ...overrides,
    })
    .returning();
  return job;
}
