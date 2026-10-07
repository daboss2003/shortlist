import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { makeCompany } from "../../../test/factories";
import { SESSION_COOKIE, insertSession } from "./session";

const mocks = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "cvp_session" && mocks.token ? { name, value: mocks.token } : undefined),
  }),
}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const { getCurrentEmployer, requireEmployer, requirePlatformAdmin } = await import("./dal");

function signIn(admin: boolean) {
  const { company, user } = makeCompany();
  if (admin) db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, user.id)).run();
  mocks.token = insertSession(user.id).token;
  return { company, user };
}

beforeEach(() => {
  mocks.token = undefined;
});

describe("session cookie name", () => {
  it("matches the mocked cookie", () => {
    expect(SESSION_COOKIE).toBe("cvp_session");
  });
});

describe("requireEmployer", () => {
  it("redirects to /login when signed out", async () => {
    await expect(requireEmployer()).rejects.toThrow("REDIRECT:/login");
    expect(await getCurrentEmployer()).toBeNull();
  });

  it("returns the employer with the admin flag", async () => {
    const { company } = signIn(false);
    expect(await requireEmployer()).toMatchObject({ companyId: company.id, isPlatformAdmin: false });
  });
});

describe("requirePlatformAdmin", () => {
  it("redirects to /login when signed out", async () => {
    await expect(requirePlatformAdmin()).rejects.toThrow("REDIRECT:/login");
  });

  it("404s for a signed-in non-admin", async () => {
    signIn(false);
    await expect(requirePlatformAdmin()).rejects.toThrow("NOT_FOUND");
  });

  it("returns the admin", async () => {
    const { user } = signIn(true);
    expect(await requirePlatformAdmin()).toMatchObject({ userId: user.id, isPlatformAdmin: true });
  });
});
