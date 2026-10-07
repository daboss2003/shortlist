import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { authenticate } from "@/lib/auth/accounts";
import { createInvite } from "@/lib/auth/invites";
import { hashPassword } from "@/lib/auth/password";
import { hit, peek, rateLimit, resetRateLimits } from "@/lib/rate-limit";
import { makeCompany } from "../../../test/factories";

const mocks = vi.hoisted(() => ({ xff: "203.0.113.1" }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": mocks.xff }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...mod, hit: vi.fn(mod.hit), peek: vi.fn(mod.peek), refund: vi.fn(mod.refund), rateLimit: vi.fn(mod.rateLimit) };
});
vi.mock("@/lib/auth/accounts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/auth/accounts")>();
  return { ...mod, authenticate: vi.fn(mod.authenticate) };
});

const { loginAction, signupAction } = await import("./actions");

const PASSWORD = "correct horse battery";
const TOO_MANY = { error: "Too many attempts. Try again in a few minutes." };

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const login = (email: string, password: string, ip = "203.0.113.1") => {
  mocks.xff = ip;
  return loginAction({}, form({ email, password })).catch((err: Error) => ({ redirected: err.message }));
};
const LOGGED_IN = { redirected: "REDIRECT:/dashboard" };

async function makeUser() {
  const { user } = makeCompany();
  db.update(users).set({ passwordHash: await hashPassword(PASSWORD) }).where(eq(users.id, user.id)).run();
  return user;
}

/** Real password checks cost ~50 ms; bulk failure tests swap in an instant "wrong password". */
const fastFailures = () => vi.mocked(authenticate).mockResolvedValue(null);

beforeEach(() => {
  resetRateLimits();
  vi.mocked(authenticate).mockReset();
  vi.mocked(hit).mockClear();
  vi.mocked(peek).mockClear();
  vi.mocked(rateLimit).mockClear();
});

describe("loginAction", () => {
  it("rejects over-long input before touching any rate limiter or password check", async () => {
    const huge = `${"a".repeat(1_000_000)}@example.com`;
    expect(await login(huge, PASSWORD)).toEqual({ error: "Incorrect email or password." });
    expect(await login("a@example.com", "p".repeat(201))).toEqual({ error: "Incorrect email or password." });
    expect(peek).not.toHaveBeenCalled();
    expect(hit).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("logs in with the right password", async () => {
    const user = await makeUser();
    expect(await login(` ${user.email.toUpperCase()} `, PASSWORD)).toEqual(LOGGED_IN);
  });

  it("doesn't count successful logins", async () => {
    const user = await makeUser();
    for (let i = 0; i < 12; i++) expect(await login(user.email, PASSWORD)).toEqual(LOGGED_IN);
  });

  it("blocks an email from one IP after 10 failures, but not the owner on another IP", async () => {
    const user = await makeUser();
    fastFailures();
    for (let i = 0; i < 10; i++) {
      expect(await login(user.email, "wrong")).toEqual({ error: "Incorrect email or password.", email: user.email });
    }
    vi.mocked(authenticate).mockReset();
    expect(await login(user.email, PASSWORD)).toEqual({ ...TOO_MANY, email: user.email });
    expect(await login(user.email, PASSWORD, "198.51.100.7")).toEqual(LOGGED_IN);
  });

  it("blocks an IP after 30 failures across any emails, checking the IP first", async () => {
    const user = await makeUser();
    fastFailures();
    for (let i = 0; i < 30; i++) await login(`spray${i}@example.com`, "wrong");
    vi.mocked(authenticate).mockReset();
    vi.mocked(peek).mockClear();

    expect(await login(user.email, PASSWORD)).toEqual({ ...TOO_MANY, email: user.email });
    expect(peek).toHaveBeenCalledTimes(1);
    expect(vi.mocked(peek).mock.calls[0][0]).toBe("login-ip:203.0.113.1");
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("slows spraying one email from many IPs after 50 failures", async () => {
    const user = await makeUser();
    fastFailures();
    for (let i = 0; i < 50; i++) await login(user.email, "wrong", `10.0.${Math.floor(i / 250)}.${i % 250}`);
    expect(await login(user.email, "wrong", "192.0.2.200")).toEqual({ ...TOO_MANY, email: user.email });
    expect(await login("someone-else@example.com", "wrong", "192.0.2.200")).toMatchObject({
      error: "Incorrect email or password.",
    });
  });

  it("can't be bypassed with a burst of parallel guesses", async () => {
    const user = await makeUser();
    vi.mocked(authenticate).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(null), 5)));
    const results = await Promise.all(Array.from({ length: 25 }, () => login(user.email, "wrong")));
    expect(authenticate).toHaveBeenCalledTimes(10);
    expect(results.filter((r) => "error" in r && r.error === TOO_MANY.error)).toHaveLength(15);
  });

  it("keys the IP on the trusted proxy entry, so spoofed X-Forwarded-For values don't reset the count", async () => {
    const user = await makeUser();
    fastFailures();
    for (let i = 0; i < 10; i++) await login(user.email, "wrong", `198.51.100.${i}, 203.0.113.1`);
    expect(await login(user.email, "wrong", "192.0.2.99, 203.0.113.1")).toEqual({ ...TOO_MANY, email: user.email });
  });
});

describe("signupAction", () => {
  const signupForm = (overrides: Record<string, string> = {}) =>
    form({
      companyName: "Acme Logistics",
      website: "",
      name: "Jane Doe",
      email: `jane.${crypto.randomUUID()}@acme.com`,
      password: PASSWORD,
      invite: createInvite().token,
      ...overrides,
    });
  const signup = (fd: FormData, xff = "203.0.113.50") => {
    mocks.xff = xff;
    return signupAction({}, fd).catch((err: Error) => ({ redirected: err.message }));
  };

  it("creates the account with a valid invite and signs in", async () => {
    expect(await signup(signupForm())).toEqual(LOGGED_IN);
  });

  it("shows the generic invite error, echoing what was typed except the password", async () => {
    const result = await signup(signupForm({ invite: "", email: "jane@acme.com" }));
    expect(result).toEqual({
      fieldErrors: {},
      formError: "This invite link is invalid or has expired. Ask for a new one.",
      values: { companyName: "Acme Logistics", website: "", name: "Jane Doe", email: "jane@acme.com", password: "" },
    });
  });

  it("limits signups per trusted IP, ignoring spoofed X-Forwarded-For entries", async () => {
    for (let i = 0; i < 10; i++) await signup(signupForm({ invite: "" }), `192.0.2.${i}, 203.0.113.60`);
    expect(await signup(signupForm(), "192.0.2.77, 203.0.113.60")).toMatchObject({
      formError: "Too many attempts. Try again in a few minutes.",
    });
    expect(await signup(signupForm(), "203.0.113.61")).toEqual(LOGGED_IN);
  });
});
