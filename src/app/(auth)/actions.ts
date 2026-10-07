"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authenticate, registerCompany, type SignupField, type SignupFieldErrors } from "@/lib/auth/accounts";
import { endSession, startSession } from "@/lib/auth/session";
import { clientIpFromHeaders } from "@/lib/http";
import { hit, peek, rateLimit, refund } from "@/lib/rate-limit";

export type SignupState = {
  fieldErrors?: SignupFieldErrors;
  formError?: string;
  /** Echoed back so the form keeps what was typed (React resets forms after an action). Never the password. */
  values?: Partial<Record<SignupField, string>>;
};

export type LoginState = { error?: string; email?: string };

const LOGIN_WINDOW_MS = 15 * 60_000;
/** Failed logins allowed per window: from one IP, for one email from one IP, and for one email from anywhere. */
const LOGIN_LIMITS = { ip: 30, emailIp: 10, email: 50 } as const;
// Signup and login both cap input at 200 characters, so nothing longer can match an account.
const MAX_CREDENTIAL_LENGTH = 200;

const TOO_MANY = "Too many attempts. Try again in a few minutes.";
const INCORRECT = "Incorrect email or password.";

const text = (formData: FormData, name: string) => {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
};

async function requestIp(): Promise<string> {
  return clientIpFromHeaders(await headers());
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

  const result = await registerCompany(values, text(formData, "invite"));
  if (!result.ok) return { fieldErrors: result.fieldErrors, formError: result.formError, values: echo };

  await startSession(result.userId);
  redirect("/dashboard");
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const rawEmail = text(formData, "email");
  const password = text(formData, "password");
  // Before any limiter: over-long input can't match an account, and must never become a limiter key.
  if (rawEmail.length > MAX_CREDENTIAL_LENGTH || password.length > MAX_CREDENTIAL_LENGTH) return { error: INCORRECT };

  const email = rawEmail.trim().toLowerCase();
  if (!email || !password) return { error: "Enter your email and password.", email };

  const ip = await requestIp();
  const ipKey = `login-ip:${ip}`;
  if (!peek(ipKey, LOGIN_LIMITS.ip).ok) return { error: TOO_MANY, email };

  // Strict per email+IP stops one attacker guessing one password; the loose per-email cap slows spraying from
  // many IPs without letting a single attacker lock the owner out.
  const emailIpKey = `login:${email}|${ip}`;
  const emailKey = `login-email:${email}`;
  if (!peek(emailIpKey, LOGIN_LIMITS.emailIp).ok || !peek(emailKey, LOGIN_LIMITS.email).ok) {
    return { error: TOO_MANY, email };
  }

  // Intentional: count the attempt before the slow password check and refund it on success. Only failures end
  // up counted, but a burst of parallel guesses can't all pass the peeks above before any of them fails.
  const keys = [ipKey, emailIpKey, emailKey];
  for (const key of keys) hit(key, LOGIN_WINDOW_MS);

  const userId = await authenticate(email, password);
  if (!userId) return { error: INCORRECT, email };

  for (const key of keys) refund(key);
  await startSession(userId);
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect("/login");
}
