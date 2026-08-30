import {
  textResult,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "chumbo";
import { z } from "zod";

export function registerCapabilities(
  server: SupabaseMcpServer,
  ctx: SupabaseMcpContext,
): void {
  // Replace this starter with one application operation. ctx.supabase is
  // request-scoped; its database authority follows the access mode documented
  // in README.md.
  server.registerTool(
    "whoami",
    {
      description: "Show which application identity is connected.",
      inputSchema: z.object({}),
    },
    async () =>
      textResult(
        ctx.subject
          ? `Connected as ${ctx.subject}.\n\n→ Next: replace whoami with an application operation.`
          : "This public connection has no signed-in user.\n\n→ Next: replace whoami with a public application operation.",
      ),
  );
}
