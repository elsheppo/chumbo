import {
  collectionInputSchema,
  collectionResult,
  errorResult,
  renderResult,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "chumbo";
import { z } from "zod";
import type { Database } from "../_shared/database.types.ts";

// Every query below runs through ctx.supabase, which carries the connected
// user's access token. The RLS policies in supabase/migrations decide which
// teams and tasks exist for that user; no handler re-implements that check.

const taskStatus = z.enum(["todo", "doing", "done"]);

const taskSummary = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: taskStatus,
  team_id: z.string().uuid(),
  team: z.string(),
});

const taskReceipt = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: taskStatus,
  team_id: z.string().uuid(),
});

const statusLabel = { todo: "To do", doing: "Doing", done: "Done" } as const;

export function registerCapabilities(
  server: SupabaseMcpServer,
  ctx: SupabaseMcpContext<Database>,
): void {
  server.registerTool(
    "list_teams",
    {
      title: "List teams",
      description:
        "List the teams the connected user belongs to, with their role. " +
        "Use a team id to filter list_tasks or to create a task.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        teams: z.array(
          z.object({
            id: z.string().uuid(),
            name: z.string(),
            role: z.enum(["owner", "member"]),
          }),
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { data, error } = await ctx.supabase
        .from("team_members")
        .select("role, teams(id, name)")
        .eq("user_id", ctx.subject ?? "")
        .order("created_at");
      if (error) throw error;
      const teams = (data ?? []).flatMap((row) =>
        row.teams
          ? [{ id: row.teams.id, name: row.teams.name, role: row.role }]
          : [],
      );
      return renderResult({ teams }, ({ teams }) =>
        teams.length === 0
          ? "You do not belong to any team yet.\n\n→ Next: create a team in the web app."
          : [
              `## Your teams – ${teams.length}`,
              ...teams.map(
                (team) => `- **${team.name}** (${team.role}) – ${team.id}`,
              ),
            ].join("\n"),
      );
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "Browse tasks in the connected user's teams in stable id order. " +
        "Optionally filter by team_id or status.",
      inputSchema: collectionInputSchema({
        cursorSchema: z.string().uuid(),
      }).extend({
        team_id: z.string().uuid().optional(),
        status: taskStatus.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, cursor, team_id, status }) => {
      let query = ctx.supabase
        .from("tasks")
        .select("id, title, status, team_id, teams(name)")
        .order("id")
        .limit(limit + 1);
      if (cursor) query = query.gt("id", cursor);
      if (team_id) query = query.eq("team_id", team_id);
      if (status) query = query.eq("status", status);
      const { data, error } = await query;
      if (error) throw error;
      const rows = data ?? [];
      return collectionResult({
        items: rows,
        limit,
        hasMore: rows.length > limit,
        itemSchema: taskSummary,
        project: (row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          team_id: row.team_id,
          team: row.teams?.name ?? "Unknown team",
        }),
        cursorFor: ({ id }) => id,
        tool: "list_tasks",
        arguments: {
          ...(team_id ? { team_id } : {}),
          ...(status ? { status } : {}),
        },
        mode: "hybrid",
        render: ({ items }) =>
          items.length
            ? items
                .map(
                  (task) =>
                    `- [${statusLabel[task.status]}] ${task.title} · ${task.team} (${task.id})`,
                )
                .join("\n")
            : "No tasks match. → Next: call create_task, or remove the filters.",
      });
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Create a task in one of the connected user's teams. " +
        "Call list_teams first if you do not know the team id.",
      inputSchema: z.object({
        team_id: z.string().uuid(),
        title: z.string().trim().min(1).max(200),
        status: taskStatus.default("todo"),
      }),
      outputSchema: taskReceipt,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ team_id, title, status }) => {
      const { data, error } = await ctx.supabase
        .from("tasks")
        .insert({ team_id, title, status })
        .select("id, title, status, team_id")
        .single();
      if (error?.code === "42501") {
        return errorResult(
          "That team does not exist or you are not a member of it. No task was created.",
          "call list_teams and use one of the returned ids.",
        );
      }
      if (error) throw error;
      return renderResult(
        data,
        (task) =>
          `Created "${task.title}" (${statusLabel[task.status]}) – ${task.id}`,
      );
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Rename a task or change its status (todo, doing, done). " +
        "Only tasks in the connected user's teams can be changed.",
      inputSchema: z
        .object({
          id: z.string().uuid(),
          title: z.string().trim().min(1).max(200).optional(),
          status: taskStatus.optional(),
        })
        .refine(
          (value) => value.title !== undefined || value.status !== undefined,
          {
            message: "Provide a new title, a new status, or both",
          },
        ),
      outputSchema: taskReceipt,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ id, title, status }) => {
      const { data, error } = await ctx.supabase
        .from("tasks")
        .update({
          ...(title !== undefined ? { title } : {}),
          ...(status !== undefined ? { status } : {}),
        })
        .eq("id", id)
        .select("id, title, status, team_id")
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return errorResult(
          "No visible task has that id. Nothing was changed.",
          "call list_tasks to find the task id.",
        );
      }
      return renderResult(
        data,
        (task) =>
          `Updated "${task.title}" – now ${statusLabel[task.status]} (${task.id})`,
      );
    },
  );
}
