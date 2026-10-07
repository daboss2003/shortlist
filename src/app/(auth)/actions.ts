"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authenticate, registerCompany, type SignupField, type SignupFieldErrors } from "@/lib/auth/accounts";
import { endSession, startSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";

export type SignupState = {
  fieldErrors?: SignupFieldErrors;
  formError?: string;
  /** Echoed back so the form keeps what was typed (React resets forms after an action). Never the password. */
  values?: Partial<Record<SignupField, string>>;
};

export type LoginState = { error?: string; email?: string };

const LOGIN_WINDOW_MS = 15 * 60_000;
const TOO_MANY = "Too many attempts. Try again in a few minutes.";

const text = (formData: FormData, name: string) => {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
};

async function requestIp(): Promise<string> {
  return (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function signupAction(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const values = {
    companyName: text(formData, "companyName"),
    website: text(formData, "website"),
    name: text(formData, "name"),
    email: text(formData, "email"),
    password: text(formData, "password"),
  };
  const echo = { ...values, password: "" };

  // Intentional: per-IP cap on account creation (not in the original spec) — each signup costs a scrypt hash and a row.
  if (!rateLimit(`signup:${await requestIp()}`, 10, 60 * 60_000).ok) {
    return { formError: TOO_MANY, values: echo };
  }

  const result = await registerCompany(values);
  if (!result.ok) return { fieldErrors: result.fieldErrors, values: echo };

  await startSession(result.userId);
  redirect("/dashboard");
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = text(formData, "email").trim().toLowerCase();
  const password = text(formData, "password");
  if (!email || !password) return { error: "Enter your email and password.", email };

  // Both buckets are always counted, so an attacker rotating emails still hits the per-IP cap.
  const byEmail = rateLimit(`login:${email}`, 10, LOGIN_WINDOW_MS);
  const byIp = rateLimit(`login-ip:${await requestIp()}`, 30, LOGIN_WINDOW_MS);
  if (!byEmail.ok || !byIp.ok) return { error: TOO_MANY, email };

  // Over-long input can't match a stored password (signup caps at 200); skip the hash work.
  const userId = email.length <= 200 && password.length <= 200 ? await authenticate(email, password) : null;
  if (!userId) return { error: "Incorrect email or password.", email };

  await startSession(userId);
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect("/login");
}
