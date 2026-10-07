import { db } from "@/db";
import { companies, jobs, users } from "@/db/schema";

let n = 0;

/** Creates a company + one user. Password hash is a placeholder; use hashPassword() when a test logs in. */
export function makeCompany(name = `Acme ${++n}`) {
  const company = db.insert(companies).values({ name }).returning().get();
  const user = db
    .insert(users)
    .values({ companyId: company.id, name: "Owner", email: `owner${++n}@example.com`, passwordHash: "x" })
    .returning()
    .get();
  return { company, user };
}

export function makeJob(companyId: string, overrides: Partial<typeof jobs.$inferInsert> = {}) {
  return db
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
    .returning()
    .get();
}
