import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { LoadingBlock } from "@/components/ui/feedback";
import { requireEmployer } from "@/lib/auth/dal";
import { getCompanySettings } from "@/lib/company/settings";
import { RETENTION_DAY_OPTIONS } from "@/lib/retention";
import { PageHeader } from "../_components/page-header";
import { CompanyProfileForm } from "./company-profile-form";
import { RetentionForm } from "./retention-form";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Settings" description="Your company profile and how long candidate data is kept." />
      <Suspense fallback={<LoadingBlock label="Loading settings…" />}>
        <SettingsContent />
      </Suspense>
    </div>
  );
}

async function SettingsContent() {
  const { companyId } = await requireEmployer();
  const settings = await getCompanySettings(companyId);
  if (!settings) notFound();

  return (
    <div className="space-y-6">
      <CompanyProfileForm defaults={{ name: settings.name, website: settings.website ?? "" }} />
      <RetentionForm saved={settings.retentionDays} options={RETENTION_DAY_OPTIONS} />
    </div>
  );
}
