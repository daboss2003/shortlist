import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingBlock } from "@/components/ui/feedback";
import { getCurrentEmployer, requirePlatformAdmin } from "@/lib/auth/dal";
import { listInvites } from "@/lib/auth/invites";
import { PageHeader } from "../../_components/page-header";
import { CreateInviteForm } from "./create-invite-form";
import { InvitesTable } from "./invites-table";

// Platform admins only. Everyone else gets the dashboard 404, so nothing on this page — title and header
// included — renders until the admin check has passed.

export async function generateMetadata(): Promise<Metadata> {
  const employer = await getCurrentEmployer();
  return { title: employer?.isPlatformAdmin === true ? "Invites" : "Page not found" };
}

export default function InvitesPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <InvitesContent />
    </Suspense>
  );
}

async function InvitesContent() {
  await requirePlatformAdmin();
  const invites = listInvites();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Invites"
        description="Signups are invite-only. Each link creates one company account and works once."
      />
      <CreateInviteForm />
      <InvitesTable invites={invites} />
    </div>
  );
}
