import { connection, type NextRequest } from "next/server";
import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";
import { jsonError } from "@/lib/http";
import { isInngestDev, isNetlify } from "@/lib/pipeline/runtime";

// Intentional: public because Inngest calls it; requests are verified with INNGEST_SIGNING_KEY
const handler = serve({ client: inngest, functions });

type Handler = (request: NextRequest, context: unknown) => Promise<Response>;

/**
 * `connection()` first: with Cache Components a GET handler is prerendered at build time unless it reads request
 * data, and the Inngest SDK must only ever see real requests.
 */
function guarded(method: Handler): Handler {
  return async (request, context) => {
    if (isNetlify() && isInngestDev()) {
      // Dev mode skips signature verification, which would let anyone on the internet start these functions.
      console.error("[inngest] INNGEST_DEV is set on a deployed site; refusing calls. Use INNGEST_SIGNING_KEY instead.");
      return jsonError(503, "Background jobs are misconfigured.");
    }
    await connection();
    return method(request, context);
  };
}

export const GET = guarded(handler.GET);
export const POST = guarded(handler.POST);
export const PUT = guarded(handler.PUT);
