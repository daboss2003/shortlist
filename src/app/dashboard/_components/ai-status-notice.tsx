import { Alert } from "@/components/ui/feedback";
import type { AiStatus } from "@/lib/ai/status";

/** Setup/misconfiguration warning for the AI ranking provider. Renders nothing when all is well. */
export function AiStatusNotice({ status }: { status: AiStatus }) {
  if (!status.primary) {
    return (
      <Alert tone="warning" title="AI ranking isn't set up yet">
        <p>
          Add <code className="font-mono text-xs text-ink">GEMINI_API_KEY</code> (or another provider key) to your
          environment. CVs will queue until then.
        </p>
        {status.error && <p className="mt-1">{status.error}</p>}
      </Alert>
    );
  }
  if (status.error) {
    return (
      <Alert tone="warning" title="Check your AI configuration">
        {status.error}
      </Alert>
    );
  }
  return null;
}
