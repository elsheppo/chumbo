import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserCorsCheck,
  buildDoctorReport,
  transportArmorCheck,
} from "../src/doctor.js";
import {
  contextBudgetCheck,
  dataApiGrantsCheck,
  toolSurfaceCheck,
  type ProbeTool,
  type ToolResultRecord,
} from "../src/doctor-checks.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("doctor context-budget, role-accurate GRANT SQL, resource_link, CORS, and transport-armor checks", () => {
  it("computes context-budget metrics, flags bloated schemas, and surfaces contextBudget on DoctorReport", () => {
    const leanTools: ProbeTool[] = [
      {
        name: "list_notes",
        description: "List notes belonging to the signed-in user.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Page size." },
          },
        },
        annotations: { readOnlyHint: true },
      },
    ];
    const clean = contextBudgetCheck(leanTools);
    expect(clean.name).toBe("context-budget");
    expect(clean.ok).toBe(true);
    expect(clean.blocking).toBe(false);
    expect(clean.metrics?.toolCount).toBe(1);
    expect(clean.metrics?.totalPromptTokens).toBeGreaterThan(0);

    const report = buildDoctorReport([clean]);
    expect(report.schemaVersion).toBe(1);
    expect(report.status).toBe("complete");
    expect(report.contextBudget).toEqual(clean.metrics);

    const bloatedProperties: Record<string, unknown> = {};
    for (let i = 0; i < 60; i += 1) {
      bloatedProperties[`field_${i}`] = {
        type: "string",
        description: `Detailed parameter description for field_${i} with extra guidance.`,
      };
    }
    const bloated = contextBudgetCheck([
      {
        name: "huge_update",
        description: "Update many fields at once.",
        inputSchema: { type: "object", properties: bloatedProperties },
        outputSchema: { type: "object", properties: bloatedProperties },
      },
    ]);
    expect(bloated.ok).toBe(false);
    expect(bloated.metrics?.bloatedInputTools).toContain("huge_update");
    expect(bloated.metrics?.bloatedOutputTools).toContain("huge_update");
    expect(bloated.detail).toContain("bloated inputSchema");
    expect(bloated.detail).toContain("bloated outputSchema");
  });

  it("emits role-accurate least-privilege SQL remediation across authenticated, public, and api-key auth modes", () => {
    const tools: ProbeTool[] = [
      { name: "list_invoices", annotations: { readOnlyHint: true } },
      { name: "archive_invoice", annotations: { readOnlyHint: false } },
    ];
    const readFailure: ToolResultRecord[] = [
      {
        tool: "list_invoices",
        caller: "doctor",
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: "permission denied for table public.invoices (42501)",
            },
          ],
        },
      },
    ];

    // 1. Authenticated read-only: RLS + GRANT SELECT only.
    const authRead = dataApiGrantsCheck(readFailure, {
      auth: "oauth",
      tools,
    });
    expect(authRead?.ok).toBe(false);
    expect(authRead?.remediation?.targetRole).toBe("authenticated");
    expect(authRead?.remediation?.sql).toContain(
      "ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;",
    );
    expect(authRead?.remediation?.sql).toContain(
      "GRANT SELECT ON TABLE public.invoices TO authenticated;",
    );
    expect(authRead?.remediation?.sql).not.toContain("GRANT INSERT");

    // 2. Authenticated write + sequence error: commented write template + sequence grant.
    const writeAndSeq = dataApiGrantsCheck(
      [
        ...readFailure,
        {
          tool: "archive_invoice",
          caller: "doctor",
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: "permission denied for table invoices; permission denied for sequence public.invoices_id_seq",
              },
            ],
          },
        },
      ],
      { auth: "bearer", tools },
    );
    expect(writeAndSeq?.remediation?.targetRole).toBe("authenticated");
    expect(writeAndSeq?.remediation?.sql).toContain(
      "-- GRANT INSERT, UPDATE, DELETE ON TABLE public.invoices TO authenticated;",
    );
    expect(writeAndSeq?.remediation?.sql).toContain(
      "GRANT USAGE, SELECT ON SEQUENCE public.invoices_id_seq TO authenticated;",
    );

    // 3. Public read-only: anon SELECT + warning; public write: rpc-definer (never anon writes).
    const pubRead = dataApiGrantsCheck(readFailure, {
      auth: "public",
      tools,
    });
    expect(pubRead?.remediation?.targetRole).toBe("anon");
    expect(pubRead?.remediation?.sql).toContain(
      "GRANT SELECT ON TABLE public.invoices TO anon;",
    );
    const pubWrite = dataApiGrantsCheck(
      [
        {
          tool: "archive_invoice",
          caller: "doctor",
          result: {
            isError: true,
            content: [
              { type: "text", text: "permission denied for table invoices" },
            ],
          },
        },
      ],
      { auth: "public", tools },
    );
    expect(pubWrite?.remediation?.targetRole).toBe("rpc-definer");
    expect(pubWrite?.remediation?.sql).not.toContain(
      "GRANT SELECT ON TABLE public.invoices TO anon",
    );

    // 4. API-key mode: rpc-definer only, NEVER grants anon on private tables.
    const apiKeyFail = dataApiGrantsCheck(readFailure, {
      auth: "api-key",
      tools,
    });
    expect(apiKeyFail?.remediation?.targetRole).toBe("rpc-definer");
    expect(apiKeyFail?.remediation?.sql).toContain("SECURITY DEFINER");
    expect(apiKeyFail?.remediation?.sql).not.toContain(
      "GRANT SELECT ON TABLE public.invoices TO anon",
    );

    // 5. Malicious / unparseable identifier never interpolated into SQL.
    const injection = dataApiGrantsCheck(
      [
        {
          tool: "list_invoices",
          caller: "doctor",
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: "permission denied for table invoices;DROP_TABLE",
              },
            ],
          },
        },
      ],
      { auth: "oauth", tools },
    );
    expect(injection?.remediation?.sql).not.toContain("DROP_TABLE");
  });

  it("flags resource_link results without a text reading card in toolSurfaceCheck", () => {
    const tools: ProbeTool[] = [
      {
        name: "open_doc",
        description: "Open a document as an MCP resource link.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ];
    const bare = toolSurfaceCheck(tools, [
      {
        tool: "open_doc",
        caller: "doctor",
        result: {
          content: [{ type: "resource_link", uri: "docs://1", name: "doc" }],
        },
      },
    ]);
    expect(bare.ok).toBe(false);
    expect(bare.detail).toContain("resource_link and no text reading card");

    const withCard = toolSurfaceCheck(tools, [
      {
        tool: "open_doc",
        caller: "doctor",
        result: {
          content: [
            { type: "text", text: "Document summary card." },
            { type: "resource_link", uri: "docs://1", name: "doc" },
          ],
        },
      },
    ]);
    expect(withCard.ok).toBe(true);
  });

  it("verifies transportArmorCheck (405 + Allow, missing Allow, open SSE, unauthenticated 401 skip) and browserCorsCheck", async () => {
    // 1. Clean 405 with Allow header.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 405,
            headers: { allow: "POST, OPTIONS" },
          }),
      ),
    );
    const ok405 = await transportArmorCheck("https://example.test/mcp", "tok");
    expect(ok405.ok).toBe(true);
    expect(ok405.detail).toContain("HTTP 405");

    // 2. 405 missing Allow header.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 405 })),
    );
    const noAllow = await transportArmorCheck(
      "https://example.test/mcp",
      "tok",
    );
    expect(noAllow.ok).toBe(false);
    expect(noAllow.detail).toContain("Allow");

    // 3. Open 200 text/event-stream fails advisory check.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("event: ping\ndata: {}\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    const openSse = await transportArmorCheck(
      "https://example.test/mcp",
      "tok",
    );
    expect(openSse.ok).toBe(false);
    expect(openSse.detail).toContain("text/event-stream");

    // 4. Unauthenticated 401 skips cleanly with ok: true.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    const unauthSkip = await transportArmorCheck("https://example.test/mcp");
    expect(unauthSkip.ok).toBe(true);
    expect(unauthSkip.detail).toContain("Skipped unauthenticated");

    // 5. browserCorsCheck checks WWW-Authenticate and Mcp-Session-Id when CORS is enabled.
    const missingCors = browserCorsCheck({
      probeHeaders: new Headers({
        "access-control-allow-origin": "https://claude.ai",
      }),
      initializeHeaders: new Headers({
        "mcp-session-id": "cs1_abc",
      }),
      auth: "oauth",
    });
    expect(missingCors?.ok).toBe(false);
    expect(missingCors?.detail).toContain("WWW-Authenticate");
    expect(missingCors?.detail).toContain("Mcp-Session-Id");

    const okCors = browserCorsCheck({
      probeHeaders: new Headers({
        "access-control-allow-origin": "https://claude.ai",
        "access-control-expose-headers": "WWW-Authenticate, Mcp-Session-Id",
      }),
      initializeHeaders: new Headers({
        "mcp-session-id": "cs1_abc",
      }),
      auth: "oauth",
    });
    expect(okCors?.ok).toBe(true);
  });
});
