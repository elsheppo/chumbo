import {
  createSupabaseMcp,
  errorResult,
  renderResult,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "supa-mcp";
import { z } from "zod";

interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  status: "active" | "paused" | "complete";
  created_at: string;
}

interface DemoDatabase {
  public: {
    Tables: {
      demo_projects: {
        Row: ProjectRow;
        Insert: {
          id?: string;
          owner_id: string;
          name: string;
          status?: ProjectRow["status"];
          created_at?: string;
        };
        Update: Partial<ProjectRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

const projectUrl = Deno.env.get("SUPABASE_URL");
if (!projectUrl) throw new Error("SUPABASE_URL is not configured");
const resourceUrl = new URL(
  Deno.env.get("AUTHENTICATED_TOOLS_PUBLIC_URL") ??
    `${projectUrl}/functions/v1/authenticated-tools`,
);

function register(server: SupabaseMcpServer, ctx: SupabaseMcpContext<any>) {
  server.registerTool(
    "list_projects",
    {
      title: "List my projects",
      description:
        "List the demonstration projects visible to the connected Supabase user. Postgres RLS owns isolation.",
      inputSchema: z.object({}),
    },
    async () => {
      const { data, error } = await ctx.supabase
        .from("demo_projects")
        .select("id, name, status, created_at")
        .order("created_at", { ascending: false });
      if (error) {
        return errorResult("Could not list projects.", "retry the call.");
      }
      const projects = (data ?? []) as Array<
        Pick<ProjectRow, "id" | "name" | "status" | "created_at">
      >;
      return renderResult({ projects }, ({ projects }) =>
        projects.length === 0
          ? "You have no demonstration projects yet.\n\n→ Next: call create_project with a short name."
          : [
              `## Your projects — ${projects.length}`,
              "",
              ...projects.map(
                (project) =>
                  `- **${project.name}** — ${project.status} (${project.id})`,
              ),
              "",
              "→ Next: call create_project to add another, or use one of these IDs in your application.",
            ].join("\n"),
      );
    },
  );

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description:
        "Create one demonstration project owned by the connected Supabase user. The caller cannot choose another owner.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(120),
      }),
    },
    async ({ name }) => {
      if (!ctx.user?.id) {
        return errorResult(
          "The authenticated user identity is unavailable.",
          "reconnect with a valid Supabase access token.",
        );
      }
      const { data, error } = await ctx.supabase
        .from("demo_projects")
        .insert({ owner_id: ctx.user.id, name })
        .select("id, name, status, created_at")
        .single();
      if (error) {
        return errorResult(
          "Could not create the project.",
          "check the name and retry.",
        );
      }
      const project = data as Pick<
        ProjectRow,
        "id" | "name" | "status" | "created_at"
      >;
      return renderResult({ project }, ({ project }) =>
        [
          `Created **${project.name}**.`,
          "",
          `- Status: ${project.status}`,
          `- ID: ${project.id}`,
          "",
          "→ Next: call list_projects to see the caller's RLS-visible slice.",
        ].join("\n"),
      );
    },
  );
}

const app = createSupabaseMcp<DemoDatabase>({
  server: { name: "Authenticated project tools", version: "0.5.0" },
  resourceUrl,
  auth: { mode: "bearer" },
  register,
});

if (import.meta.main) Deno.serve(app.fetch);
export default app;
