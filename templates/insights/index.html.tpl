<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{SERVER_NAME}} – Chumbo Insights</title>
    <style>
      :root {
        --ink: #131513;
        --muted: #575d57;
        --surface: #ffffff;
        --subtle: #f5f6f3;
        --border: #dde1da;
        --border-strong: #c2c8be;
        --good-bg: #e7f6ea;
        --good-ink: #175c2a;
        --warn-bg: #fff5d9;
        --warn-ink: #7d5600;
        --err-bg: #fde9e7;
        --err-ink: #8e241b;
        --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
        --sans: ui-sans-serif, system-ui, -apple-system, sans-serif;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--subtle);
        color: var(--ink);
        font: 14px/1.5 var(--sans);
      }
      main {
        max-width: 1080px;
        margin: 0 auto;
        padding: 36px 20px 64px;
        display: grid;
        gap: 20px;
      }
      header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: flex-end;
        gap: 16px;
      }
      .eyebrow {
        margin: 0 0 4px;
        color: var(--muted);
        font: 650 11px/1.2 var(--mono);
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 { margin: 0; font-size: 28px; letter-spacing: -0.02em; }
      h2 { margin: 0 0 6px; font-size: 18px; }
      p { margin: 4px 0 0; color: var(--muted); }
      .panel {
        background: var(--surface);
        border: 1px solid var(--border-strong);
        padding: 20px;
      }
      .grid-4 {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 12px;
      }
      .stat strong { display: block; font-size: 24px; margin: 4px 0; }
      .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
      label { display: grid; gap: 4px; font: 600 11px var(--mono); color: var(--muted); text-transform: uppercase; }
      input, select, button {
        min-height: 36px;
        padding: 0 12px;
        border: 1px solid var(--border-strong);
        background: var(--surface);
        color: var(--ink);
        font: 500 13px var(--sans);
      }
      button { font-weight: 600; cursor: pointer; }
      button.primary { background: var(--ink); color: var(--surface); border-color: var(--ink); }
      table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
      th, td { padding: 10px 8px; border-bottom: 1px solid var(--border); text-align: left; }
      thead th { font: 650 10px var(--mono); color: var(--muted); text-transform: uppercase; }
      code, pre { font-family: var(--mono); font-size: 12px; }
      pre { padding: 12px; background: var(--subtle); border: 1px solid var(--border); overflow-x: auto; }
      .run-card { border: 1px solid var(--border-strong); margin-top: 12px; }
      .run-card.unlinked { border-style: dashed; background: var(--subtle); }
      .run-head {
        display: flex; justify-content: space-between; gap: 12px;
        padding: 10px 14px; background: var(--subtle); border-bottom: 1px solid var(--border);
      }
      .steps { list-style: none; margin: 0; padding: 0; }
      .steps li {
        display: flex; justify-content: space-between; gap: 10px;
        padding: 9px 14px; border-bottom: 1px solid var(--border);
      }
      .steps li:last-child { border-bottom: 0; }
      .badge {
        display: inline-block; padding: 2px 7px; font: 650 10px var(--mono); text-transform: uppercase;
      }
      .badge.good { background: var(--good-bg); color: var(--good-ink); }
      .badge.warn { background: var(--warn-bg); color: var(--warn-ink); }
      .badge.err { background: var(--err-bg); color: var(--err-ink); }
      .hidden { display: none !important; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <p class="eyebrow">{{SERVER_NAME}} / Self-hosted Insights</p>
          <h1>MCP usage &amp; runs</h1>
          <p>Payload-free telemetry – capability names, counts, outcomes, and response times only. Prompts, arguments, and results are never captured.</p>
        </div>
        <div class="row">
          <label>
            Period
            <select id="period">
              <option value="7">Last 7 days</option>
              <option value="30" selected>Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </label>
          <button id="refresh-btn" type="button" class="hidden">Refresh</button>
          <button id="signout-btn" type="button" class="hidden">Sign out</button>
        </div>
      </header>

      <section id="config-panel" class="panel">
        <p class="eyebrow">Connect to your Supabase project</p>
        <h2>Sign in with Supabase Auth</h2>
        <p>Uses your project's public publishable/anon key and your user session. Never paste a service-role key into the browser.</p>
        <form id="auth-form" class="row" style="margin-top: 14px; align-items: flex-end;">
          <label>Supabase URL<input id="sb-url" type="url" value="{{LOCAL_ORIGIN}}" required style="min-width: 260px;" /></label>
          <label>Publishable / Anon Key<input id="sb-key" type="text" placeholder="sb_publishable_... or eyJ..." required style="min-width: 260px;" /></label>
          <label>Email<input id="sb-email" type="email" placeholder="you@example.com" required /></label>
          <label>Password (blank = magic link)<input id="sb-password" type="password" placeholder="Optional password" /></label>
          <button type="submit" class="primary">Sign in</button>
        </form>
        <p id="auth-status" role="status"></p>
      </section>

      <section id="workspace-panel" class="panel hidden">
        <p class="eyebrow">Workspace overview</p>
        <h2>Project totals &amp; people</h2>
        <div id="workspace-content"></div>
      </section>

      <section id="runs-panel" class="panel hidden">
        <p class="eyebrow">Run timelines</p>
        <h2 id="runs-heading">Your recent runs</h2>
        <p>Correlated steps are grouped by verified run or session handle. Stateless calls without a handle appear separately in 30-minute windows.</p>
        <div id="runs-content"></div>
      </section>
    </main>

    <script type="module">
      import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

      const urlInput = document.getElementById("sb-url");
      const keyInput = document.getElementById("sb-key");
      const emailInput = document.getElementById("sb-email");
      const passInput = document.getElementById("sb-password");
      const periodSelect = document.getElementById("period");
      const statusEl = document.getElementById("auth-status");
      const configPanel = document.getElementById("config-panel");
      const workspacePanel = document.getElementById("workspace-panel");
      const workspaceContent = document.getElementById("workspace-content");
      const runsPanel = document.getElementById("runs-panel");
      const runsHeading = document.getElementById("runs-heading");
      const runsContent = document.getElementById("runs-content");
      const refreshBtn = document.getElementById("refresh-btn");
      const signoutBtn = document.getElementById("signout-btn");

      urlInput.value = localStorage.getItem("chumbo_insights_url") || urlInput.value;
      keyInput.value = localStorage.getItem("chumbo_insights_key") || "";

      let supabase = null;
      let activeMemberId = null;
      let activeMemberLabel = "Your";

      const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const fmtMs = (ms) => ms == null ? "–" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
      const humanize = (name) => {
        const w = String(name).replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[._/-]+/).filter(Boolean).join(" ").toLowerCase();
        return w ? w[0].toUpperCase() + w.slice(1) : name;
      };

      function collapseSteps(events) {
        const out = [];
        let i = 0;
        while (i < events.length) {
          let len = 0, cycles = 1;
          for (const k of [1, 2, 3]) {
            if (i + k * 2 > events.length) continue;
            let c = 1;
            while (i + (c + 1) * k <= events.length) {
              let ok = true;
              for (let o = 0; o < k; o++) {
                if (`${events[i + o].capabilityKind}:${events[i + o].capabilityName}` !== `${events[i + c * k + o].capabilityKind}:${events[i + c * k + o].capabilityName}`) { ok = false; break; }
              }
              if (!ok) break;
              c++;
            }
            if (c >= 2) { len = k; cycles = c; break; }
          }
          if (len > 0 && cycles >= 2) {
            const slice = events.slice(i, i + len * cycles);
            const names = events.slice(i, i + len).map((e) => humanize(e.capabilityName));
            out.push({
              label: len === 1 ? `Repeated: ${names[0]} (×${cycles})` : `Back and forth: ${names.join(" → ")} (×${cycles})`,
              codes: events.slice(i, i + len).map((e) => e.capabilityName),
              durationMs: slice.reduce((a, e) => a + (e.durationMs ?? 0), 0),
              friction: slice.some((e) => e.outcome === "tool-error" || e.outcome === "failure"),
              slow: slice.some((e) => (e.durationMs ?? 0) > 10000),
            });
            i += len * cycles;
          } else {
            const e = events[i++];
            out.push({
              label: humanize(e.capabilityName),
              codes: [e.capabilityName],
              durationMs: e.durationMs,
              friction: e.outcome === "tool-error" || e.outcome === "failure",
              slow: (e.durationMs ?? 0) > 10000,
              errorCode: e.errorCode,
            });
          }
        }
        return out;
      }

      async function loadDashboard() {
        if (!supabase) return;
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          configPanel.classList.remove("hidden");
          workspacePanel.classList.add("hidden");
          runsPanel.classList.add("hidden");
          refreshBtn.classList.add("hidden");
          signoutBtn.classList.add("hidden");
          return;
        }
        configPanel.classList.add("hidden");
        workspacePanel.classList.remove("hidden");
        runsPanel.classList.remove("hidden");
        refreshBtn.classList.remove("hidden");
        signoutBtn.classList.remove("hidden");

        const days = Number(periodSelect.value);
        const memberId = activeMemberId || session.user.id;
        runsHeading.textContent = activeMemberId ? `${activeMemberLabel}’s runs` : "Your recent runs";

        const [aggRes, peopleRes] = await Promise.all([
          supabase.rpc("chumbo_insights_aggregate", { requested_lookback_days: days }),
          supabase.rpc("chumbo_insights_people", { requested_lookback_days: days }),
        ]);

        if (aggRes.error || peopleRes.error) {
          workspaceContent.innerHTML = `<p>Workspace-wide totals and People stay fail-closed until you admit organization admins in <code>chumbo_telemetry.insights_is_admin</code>:</p>
<pre>create or replace function chumbo_telemetry.insights_is_admin(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((u.raw_app_meta_data ->> 'role') = 'admin', false)
  from auth.users u where u.id = uid
$$;</pre>`;
        } else {
          const agg = aggRes.data;
          const people = peopleRes.data?.people ?? [];
          workspaceContent.innerHTML = `
            <div class="grid-4" style="margin-top: 12px;">
              <div class="panel stat"><span class="eyebrow">Capability calls</span><strong>${agg.totals.finished}</strong></div>
              <div class="panel stat"><span class="eyebrow">Active callers</span><strong>${agg.totals.activePrincipals}</strong></div>
              <div class="panel stat"><span class="eyebrow">Success rate</span><strong>${(agg.totals.successRate * 100).toFixed(1)}%</strong></div>
              <div class="panel stat"><span class="eyebrow">Median / P95</span><strong>${fmtMs(agg.latency.p50Ms)} / ${fmtMs(agg.latency.p95Ms)}</strong></div>
            </div>
            <table>
              <thead><tr><th>Member (alphabetical)</th><th>Calls</th><th>Active days</th><th>Runs</th><th>Errors</th><th></th></tr></thead>
              <tbody>
                ${people.map((p) => `<tr>
                  <td><strong>${esc(p.displayName)}</strong>${p.email ? `<br/><small>${esc(p.email)}</small>` : ""}</td>
                  <td>${p.finishedCalls}</td>
                  <td>${p.activeDays ?? 0}</td>
                  <td>${p.runCount}</td>
                  <td>${p.failures ?? 0}</td>
                  <td><button type="button" data-member="${esc(p.id)}" data-name="${esc(p.displayName)}">View runs</button></td>
                </tr>`).join("")}
              </tbody>
            </table>`;
          workspaceContent.querySelectorAll("button[data-member]").forEach((btn) => {
            btn.addEventListener("click", () => {
              activeMemberId = btn.getAttribute("data-member");
              activeMemberLabel = btn.getAttribute("data-name");
              loadDashboard();
            });
          });
        }

        const to = new Date();
        const from = new Date(to.getTime() - days * 86400000);
        const runsRes = await supabase.rpc("chumbo_insights_runs", {
          p_member: memberId,
          p_from: from.toISOString(),
          p_to: to.toISOString(),
        });
        if (runsRes.error) {
          runsContent.innerHTML = `<p>${esc(runsRes.error.message)}</p>`;
          return;
        }
        const events = runsRes.data?.events ?? [];
        if (!events.length) {
          runsContent.innerHTML = `<p>No capability calls recorded in the last ${days} days yet.</p>`;
          return;
        }
        const byRun = new Map();
        const unlinked = [];
        for (const ev of events) {
          if (ev.runId && !ev.runRejected) {
            if (!byRun.has(ev.runId)) byRun.set(ev.runId, []);
            byRun.get(ev.runId).push(ev);
          } else {
            unlinked.push(ev);
          }
        }
        const runHtml = [...byRun.entries()].reverse().map(([runId, list]) => {
          const steps = collapseSteps(list);
          const totalMs = list.reduce((a, e) => a + (e.durationMs ?? 0), 0);
          const errors = list.filter((e) => e.outcome === "tool-error" || e.outcome === "failure").length;
          return `<article class="run-card">
            <div class="run-head">
              <span><strong>${esc(new Date(list[0].occurredAt).toUTCString())}</strong> · ${list.length} calls · ${fmtMs(totalMs)}</span>
              <span>${errors ? `<span class="badge err">${errors} error(s)</span>` : `<span class="badge good">Completed</span>`}</span>
            </div>
            <ol class="steps">${steps.map((s) => `<li>
              <span><strong>${esc(s.label)}</strong> ${s.codes.map((c) => `<code>${esc(c)}</code>`).join(" ")}
                ${s.friction ? `<span class="badge err">Error${s.errorCode ? `: ${esc(s.errorCode)}` : ""}</span>` : ""}
                ${s.slow ? `<span class="badge warn">Slow (&gt;10s)</span>` : ""}
              </span>
              <code>${fmtMs(s.durationMs)}</code>
            </li>`).join("")}</ol>
          </article>`;
        }).join("");

        const unlinkedHtml = unlinked.length ? `<h3 style="margin-top:20px;">Calls without a run handle</h3>
          <article class="run-card unlinked">
            <div class="run-head"><span>${unlinked.length} stateless call(s)</span></div>
            <ol class="steps">${collapseSteps(unlinked).map((s) => `<li><span><strong>${esc(s.label)}</strong> ${s.codes.map((c) => `<code>${esc(c)}</code>`).join(" ")}</span><code>${fmtMs(s.durationMs)}</code></li>`).join("")}</ol>
          </article>` : "";

        runsContent.innerHTML = (runHtml || "<p>No correlated runs in this window.</p>") + unlinkedHtml;
      }

      function initClient() {
        if (!urlInput.value || !keyInput.value) return false;
        localStorage.setItem("chumbo_insights_url", urlInput.value.trim());
        localStorage.setItem("chumbo_insights_key", keyInput.value.trim());
        supabase = createClient(urlInput.value.trim(), keyInput.value.trim());
        return true;
      }

      if (initClient()) loadDashboard();

      document.getElementById("auth-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!initClient()) return;
        statusEl.textContent = "Signing in…";
        const email = emailInput.value.trim();
        const password = passInput.value;
        const res = password
          ? await supabase.auth.signInWithPassword({ email, password })
          : await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
        if (res.error) statusEl.textContent = res.error.message;
        else if (!password) statusEl.textContent = "Check your email for the magic sign-in link.";
        else { statusEl.textContent = ""; loadDashboard(); }
      });

      periodSelect.addEventListener("change", () => loadDashboard());
      refreshBtn.addEventListener("click", () => loadDashboard());
      signoutBtn.addEventListener("click", async () => {
        if (supabase) await supabase.auth.signOut();
        activeMemberId = null;
        loadDashboard();
      });
    </script>
  </body>
</html>
