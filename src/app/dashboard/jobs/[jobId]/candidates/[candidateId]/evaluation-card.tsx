import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { RecommendationBadge } from "@/components/candidate/badges";
import { ScoreBadge } from "@/components/candidate/score-badge";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { Evaluation } from "@/lib/ai/schemas";
import { cn } from "@/lib/cn";
import { scoreTone } from "@/lib/format";

// All text here comes from the AI and is untrusted: render as plain text only.

const clampScore = (n: number) => Math.min(100, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)));

const meterFill = { success: "bg-success", warning: "bg-warning", danger: "bg-danger" } as const;

function ScoreMeter({ label, value }: { label: string; value: number }) {
  const score = clampScore(value);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-ink-muted">{label}</span>
        <span className="font-medium text-ink tabular-nums">{score}</span>
      </div>
      <div
        role="meter"
        aria-label={`${label} score`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-subtle"
      >
        <div className={cn("h-full rounded-full", meterFill[scoreTone(score)])} style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}

function PointList({ title, points, tone }: { title: string; points: string[]; tone: "success" | "warning" }) {
  const Icon = tone === "success" ? CheckCircle2 : AlertTriangle;
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-ink">{title}</h3>
      {points.length > 0 ? (
        <ul className="space-y-2">
          {points.map((point, i) => (
            <li key={`${i}-${point}`} className="flex gap-2 text-sm leading-6 text-ink">
              <Icon className={cn("mt-1 size-4 shrink-0", tone === "success" ? "text-success" : "text-warning")} aria-hidden />
              <span className="min-w-0 [overflow-wrap:anywhere]">{point}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-faint">None noted.</p>
      )}
    </section>
  );
}

function SkillList({ title, skills, tone, empty }: { title: string; skills: string[]; tone: BadgeTone; empty: string }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-ink">{title}</h3>
      {skills.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {skills.map((skill, i) => (
            <li key={`${i}-${skill}`}>
              <Badge tone={tone} className="whitespace-normal">
                {skill}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-faint">{empty}</p>
      )}
    </section>
  );
}

export function EvaluationCard({ evaluation, score }: { evaluation: Evaluation; score: number | null }) {
  return (
    <Card>
      <CardHeader title="AI evaluation" description="How well this CV matches the job's requirements." />
      <CardBody className="space-y-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex items-center gap-4 sm:w-52 sm:shrink-0">
            <ScoreBadge score={score ?? clampScore(evaluation.overallScore)} size="lg" />
            <div className="space-y-1">
              <p className="text-xs font-medium text-ink-muted">Match score</p>
              <RecommendationBadge recommendation={evaluation.recommendation} />
            </div>
          </div>
          <div className="grid flex-1 gap-3">
            <ScoreMeter label="Skills" value={evaluation.skillsScore} />
            <ScoreMeter label="Experience" value={evaluation.experienceScore} />
            <ScoreMeter label="Education" value={evaluation.educationScore} />
          </div>
        </div>

        {evaluation.summary.trim() && (
          <p className="text-sm leading-6 text-ink [overflow-wrap:anywhere]">{evaluation.summary}</p>
        )}

        <div className="grid gap-6 sm:grid-cols-2">
          <PointList title="Strengths" points={evaluation.strengths} tone="success" />
          <PointList title="Concerns" points={evaluation.concerns} tone="warning" />
        </div>

        <div className="grid gap-6 border-t border-line pt-5 sm:grid-cols-2">
          <SkillList
            title="Matched skills"
            skills={evaluation.matchedSkills}
            tone="success"
            empty="None of the job's skills were found in the CV."
          />
          <SkillList
            title="Missing skills"
            skills={evaluation.missingSkills}
            tone="neutral"
            empty="No gaps against the job's skills."
          />
        </div>
      </CardBody>
    </Card>
  );
}
