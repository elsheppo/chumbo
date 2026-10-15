import type { Session } from "@supabase/supabase-js";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type {
  Database,
  Enums,
} from "../../supabase/functions/_shared/database.types.ts";
import { ConnectPanel } from "./ConnectPanel.tsx";
import { supabase } from "./supabase.ts";

type TaskStatus = Enums<"task_status">;
type Team = { id: string; name: string; role: Enums<"team_role"> };
type Task = Pick<
  Database["public"]["Tables"]["tasks"]["Row"],
  "id" | "title" | "status" | "team_id"
>;

const nextStatus: Record<TaskStatus, TaskStatus> = {
  todo: "doing",
  doing: "done",
  done: "todo",
};
const statusLabel: Record<TaskStatus, string> = {
  todo: "To do",
  doing: "Doing",
  done: "Done",
};

export function Workspace({ session }: { session: Session }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadTeams = useCallback(async () => {
    const { data, error } = await supabase
      .from("team_members")
      .select("role, teams(id, name)")
      .eq("user_id", session.user.id)
      .order("created_at");
    if (error) return setError(error.message);
    const next = (data ?? []).flatMap((row) =>
      row.teams
        ? [{ id: row.teams.id, name: row.teams.name, role: row.role }]
        : [],
    );
    setTeams(next);
    setTeamId((current) => current ?? next[0]?.id ?? null);
  }, [session.user.id]);

  const loadTasks = useCallback(async () => {
    if (!teamId) return setTasks([]);
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, status, team_id")
      .eq("team_id", teamId)
      .order("created_at");
    if (error) return setError(error.message);
    setTasks(data ?? []);
  }, [teamId]);

  useEffect(() => void loadTeams(), [loadTeams]);
  useEffect(() => void loadTasks(), [loadTasks]);
  // Agents change the same rows through MCP; refresh when you come back.
  useEffect(() => {
    const refresh = () => void loadTasks();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [loadTasks]);

  async function addTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const title = new FormData(form).get("title")?.toString().trim();
    if (!title || !teamId) return;
    const { error } = await supabase
      .from("tasks")
      .insert({ team_id: teamId, title });
    if (error) return setError(error.message);
    form.reset();
    await loadTasks();
  }

  async function advance(task: Task) {
    const { error } = await supabase
      .from("tasks")
      .update({ status: nextStatus[task.status] })
      .eq("id", task.id);
    if (error) return setError(error.message);
    await loadTasks();
  }

  async function addTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = new FormData(form).get("name")?.toString().trim();
    if (!name) return;
    const { data, error } = await supabase.rpc("create_team", {
      team_name: name,
    });
    if (error) return setError(error.message);
    form.reset();
    setTeamId(data.id);
    await loadTeams();
  }

  const team = teams.find((candidate) => candidate.id === teamId);

  return (
    <div className="layout">
      <header className="row spread">
        <strong>Team Tasks</strong>
        <span className="row">
          <span className="muted">{session.user.email}</span>
          <button className="secondary" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </span>
      </header>

      <nav className="card stack" aria-label="Teams">
        <h2>Teams</h2>
        {teams.map((candidate) => (
          <button
            key={candidate.id}
            className={candidate.id === teamId ? "team active" : "team"}
            onClick={() => setTeamId(candidate.id)}
          >
            {candidate.name}
          </button>
        ))}
        <form onSubmit={addTeam} className="row">
          <input
            name="name"
            placeholder="New team"
            aria-label="New team name"
            maxLength={80}
          />
          <button className="secondary">Add</button>
        </form>
      </nav>

      <main className="card stack" aria-label="Tasks">
        <div className="row spread">
          <h2>{team?.name ?? "No team yet"}</h2>
          <button className="secondary" onClick={() => void loadTasks()}>
            Refresh
          </button>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {team && (
          <form onSubmit={addTask} className="row">
            <input
              name="title"
              placeholder="Add a task"
              aria-label="New task title"
              maxLength={200}
            />
            <button>Add</button>
          </form>
        )}
        <ul className="tasks">
          {tasks.map((task) => (
            <li key={task.id} className="row spread">
              <span className={task.status === "done" ? "done" : undefined}>
                {task.title}
              </span>
              <button
                className={`status ${task.status}`}
                title="Change status"
                onClick={() => advance(task)}
              >
                {statusLabel[task.status]}
              </button>
            </li>
          ))}
          {team && tasks.length === 0 && (
            <li className="muted">No tasks yet.</li>
          )}
        </ul>
      </main>

      <ConnectPanel />
    </div>
  );
}
