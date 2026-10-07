import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { Alert, LoadingBlock } from "@/components/ui/feedback";
import { getCurrentEmployer } from "@/lib/auth/dal";
import { findUsableInvite } from "@/lib/auth/invites";
import { APP_NAME } from "@/lib/brand";
import { AuthCard, TextLink } from "../auth-card";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = {
  title: "Create your account",
  // Invite links carry a one-time token; keep them out of search results.
  robots: { index: false, follow: false },
};

export default function SignupPage(props: PageProps<"/signup">) {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <SignupContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function SignupContent({ searchParams }: Pick<PageProps<"/signup">, "searchParams">) {
  if (await getCurrentEmployer()) redirect("/dashboard");
  const { invite: raw } = await searchParams;
  const token = typeof raw === "string" ? raw : undefined;
  const invite = token ? await findUsableInvite(token) : null;

  if (!token || !invite) {
    return (
      <AuthCard title="Signups are by invitation" description="Ask the person who invited you for a link.">
        <div className="space-y-5">
          {token !== undefined && <Alert tone="warning" title="This invite link is invalid or has expired." />}
          <ButtonLink href="/login" size="lg" className="w-full">
            Log in
          </ButtonLink>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your account"
      description={`You've been invited to ${APP_NAME}. Set up your company and post your first job in a few minutes.`}
      footer={
        <>
          Already have an account? <TextLink href="/login">Log in</TextLink>
        </>
      }
    >
      <SignupForm inviteToken={token} invitedEmail={invite.email} />
    </AuthCard>
  );
}
