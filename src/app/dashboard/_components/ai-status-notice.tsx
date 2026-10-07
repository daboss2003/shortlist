import { Alert } from "@/components/ui/feedback";
import type { AiQuota } from "@/lib/ai/quota";
import type { AiStatus } from "@/lib/ai/status";
import { LocalTime } from "./local-time";

/**
 * Warnings about AI ranking for the jobs list: not set up, or today's limit reached. Renders nothing when all
 * is well. Tenants never see env-var names or raw configuration errors; platform admins (who run the server)
 * also get the technical detail.
 */
export function AiStatusNotice({
  status,
  quota,
  showOperatorDetails = false,
}: {
  status: AiStatus;
  quota?: AiQuota;
  showOperatorDetails?: boolean;
}) {
  const notReady = !status.primary || status.error !== null;
  const limitReached = quota?.remaining === 0;
  if (!notReady && !limitReached) return null;

  return (
    <div className="space-y-3">
      {notReady && (
        <Alert tone="warning" title="AI ranking isn't set up yet">
          <p>New CVs will wait in the queue and be ranked automatically once it&apos;s ready.</p>
          {showOperatorDetails && (
            <p className="mt-1">
              Operator details: {status.error ?? "no AI provider key is configured on the server."}
            </p>
          )}
        </Alert>
      )}
      {limitReached && quota && (
        <Alert tone="warning" title={`Daily AI limit reached (${quota.limit} CVs today).`}>
          Remaining CVs will be ranked after <LocalTime iso={quota.resetsAt.toISOString()} />.
        </Alert>
      )}
    </div>
  );
}

const count = (n: number) => n.toLocaleString("en");

/** Muted footnote under the jobs table: which AI ranks candidates, and today's usage when there's a cap. */
export function AiUsageNote({ status, quota }: { status: AiStatus; quota: AiQuota }) {
  const parts: string[] = [];
  if (status.primary && !status.error) {
    parts.push(`Candidates are ranked by ${status.primary.label} (${status.primary.modelId}).`);
  }
  if (quota.limit !== null) parts.push(`AI analyses today: ${count(quota.used)} of ${count(quota.limit)}.`);
  if (parts.length === 0) return null;
  return <p className="text-xs text-ink-muted tabular-nums">{parts.join(" ")}</p>;
}
