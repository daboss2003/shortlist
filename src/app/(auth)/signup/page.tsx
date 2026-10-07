import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { LoadingBlock } from "@/components/ui/feedback";
import { getCurrentEmployer } from "@/lib/auth/dal";
import { AuthCard } from "../auth-card";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Create your account" };

export default function SignupPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <SignupContent />
    </Suspense>
  );
}

async function SignupContent() {
  if (await getCurrentEmployer()) redirect("/dashboard");
  return (
    <AuthCard
      title="Create your account"
      description="Set up your company and post your first job in a few minutes."
      footer={{ prompt: "Already have an account?", href: "/login", label: "Log in" }}
    >
      <SignupForm />
    </AuthCard>
  );
}
