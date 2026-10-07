import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { CandidateProfile } from "@/lib/ai/schemas";

// All text here is extracted from the CV by the AI and is untrusted: render as plain text only.

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className="mb-3 text-sm font-medium text-ink">{title}</h3>
      {children}
    </section>
  );
}

const Muted = ({ children }: { children: ReactNode }) => <p className="text-sm text-ink-faint">{children}</p>;

function formatYears(years: number | null): string | null {
  if (years === null || !Number.isFinite(years) || years < 0) return null;
  const rounded = Math.round(years * 10) / 10;
  return `${rounded} ${rounded === 1 ? "yr" : "yrs"}`;
}

export function ProfileCard({ profile }: { profile: CandidateProfile }) {
  const years = formatYears(profile.totalExperienceYears);
  return (
    <Card>
      <CardHeader
        title="Profile"
        description={years ? `${years} of professional experience` : "Extracted from the CV"}
      />
      <CardBody className="space-y-6">
        {profile.summary?.trim() && (
          <p className="text-sm leading-6 text-ink [overflow-wrap:anywhere]">{profile.summary}</p>
        )}

        <Section title="Experience">
          {profile.experience.length > 0 ? (
            <ol>
              {profile.experience.map((role, i) => {
                const dates = [role.startDate, role.endDate].filter(Boolean).join(" – ");
                return (
                  <li key={`${i}-${role.title}-${role.company}`} className="group flex gap-3">
                    <div className="flex flex-col items-center" aria-hidden>
                      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-ink-faint" />
                      <span className="mt-1.5 w-px flex-1 bg-line group-last:hidden" />
                    </div>
                    <div className="min-w-0 flex-1 pb-5 group-last:pb-0">
                      <p className="text-sm font-medium text-ink [overflow-wrap:anywhere]">{role.title}</p>
                      <p className="text-sm text-ink-muted [overflow-wrap:anywhere]">
                        {role.company}
                        {dates && <span className="tabular-nums"> · {dates}</span>}
                      </p>
                      {role.description?.trim() && (
                        <p className="mt-2 text-sm leading-6 whitespace-pre-line text-ink-muted [overflow-wrap:anywhere]">
                          {role.description}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <Muted>No work history found in the CV.</Muted>
          )}
        </Section>

        <Section title="Education">
          {profile.education.length > 0 ? (
            <ul className="space-y-3">
              {profile.education.map((edu, i) => {
                const detail = [edu.degree, edu.field].filter(Boolean).join(", ");
                return (
                  <li key={`${i}-${edu.institution}`}>
                    <p className="text-sm font-medium text-ink [overflow-wrap:anywhere]">{edu.institution}</p>
                    {(detail || edu.graduationYear) && (
                      <p className="text-sm text-ink-muted [overflow-wrap:anywhere]">
                        {detail}
                        {detail && edu.graduationYear && " · "}
                        {edu.graduationYear && <span className="tabular-nums">{edu.graduationYear}</span>}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Muted>No education found in the CV.</Muted>
          )}
        </Section>
      </CardBody>
    </Card>
  );
}

function BadgeList({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((item, i) => (
        <li key={`${i}-${item}`} className="min-w-0 max-w-full">
          <Badge tone="neutral" wrap>
            {item}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export function QualificationsCard({ profile }: { profile: CandidateProfile }) {
  return (
    <Card>
      <CardHeader title="Skills & qualifications" />
      <CardBody className="space-y-6">
        <Section title="Skills">
          {profile.skills.length > 0 ? <BadgeList items={profile.skills} /> : <Muted>No skills listed.</Muted>}
        </Section>
        <Section title="Certifications">
          {profile.certifications.length > 0 ? (
            <ul className="space-y-1.5 text-sm text-ink">
              {profile.certifications.map((cert, i) => (
                <li key={`${i}-${cert}`} className="[overflow-wrap:anywhere]">
                  {cert}
                </li>
              ))}
            </ul>
          ) : (
            <Muted>None listed.</Muted>
          )}
        </Section>
        <Section title="Languages">
          {profile.languages.length > 0 ? <BadgeList items={profile.languages} /> : <Muted>None listed.</Muted>}
        </Section>
      </CardBody>
    </Card>
  );
}
