import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { LoadingBlock } from "@/components/ui/feedback";
import { getCurrentEmployer } from "@/lib/auth/dal";
import { AuthCard } from "../auth-card";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Log in" };

export default function LoginPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <LoginContent />
    </Suspense>
  );
}

async function LoginContent() {
  if (await getCurrentEmployer()) redirect("/dashboard");
  return (
    <AuthCard
      title="Log in"
      description="Welcome back. Your jobs and ranked candidates are waiting."
      footer="Have an invite? Use the link you were sent."
    >
      <LoginForm />
    </AuthCard>
  );
}
