import { connection, type NextRequest } from "next/server";
import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";
import { jsonError } from "@/lib/http";
import { isInngestDev, isNetlify } from "@/lib/pipeline/runtime";

// Intentional: public because Inngest calls it. Every request must be signed with INNGEST_SIGNING_KEY: function runs
// (POST) and introspection (GET) always were checked, and enableUnauthedSync: false extends that to app syncs
// (PUT), which the SDK otherwise accepts unsigned and answers by re-registering the app with Inngest. serveOrigin
// pins the URL registered for our functions to APP_URL instead of the request's Host header.
const handler = serve({
  client: inngest,
  functions,
  serveOrigin: process.env.APP_URL,
  enableUnauthedSync: false,
});

type Handler = (request: NextRequest, context: unknown) => Promise<Response>;

let warnedNoAppUrl = false;

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
    if (isNetlify() && !process.env.APP_URL?.trim() && !warnedNoAppUrl) {
      warnedNoAppUrl = true;
      console.error(
        "[inngest] APP_URL is not set, so a sync registers this endpoint under the request's Host header. " +
          "Set APP_URL to the site's URL.",
      );
    }
    await connection();
    return method(request, context);
  };
}

export const GET = guarded(handler.GET);
export const POST = guarded(handler.POST);
export const PUT = guarded(handler.PUT);
