import { SearchX } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";

export default function DashboardNotFound() {
  return (
    <Card>
      <EmptyState
        icon={<SearchX aria-hidden />}
        title="We couldn't find that"
        description="It may have been deleted, or the link is wrong."
        action={
          <ButtonLink href="/dashboard" variant="secondary">
            Back to jobs
          </ButtonLink>
        }
      />
    </Card>
  );
}
