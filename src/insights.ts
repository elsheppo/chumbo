import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SupabaseMcpCapabilityKind,
  SupabaseMcpLifecycleEvent,
  SupabaseMcpLifecycleOutcome,
} from "./types.js";

export const SLOW_STEP_THRESHOLD_MS = 10_000;
export const UNLINKED_CALL_BUCKET_MS = 30 * 60 * 1_000;

export type InsightsLookbackDays = 7 | 30 | 90;
export type CapabilityLabelMap = Readonly<Record<string, string>>;

export interface RawRunEvent {
  occurredAt: string;
  capabilityKind: SupabaseMcpCapabilityKind;
  capabilityName: string;
  durationMs: number | null;
  outcome: SupabaseMcpLifecycleOutcome;
  runId?: string | null;
  runStartedAt?: string | null;
  runRejected?: string | null;
  errorCode?: string | null;
  clientLabel?: string | null;
}

export interface RunStep {
  kind: "call" | "loop";
  label: string;
  capabilityNames: string[];
  capabilityKinds: SupabaseMcpCapabilityKind[];
  callCount: number;
  cycleCount?: number;
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  outcome: SupabaseMcpLifecycleOutcome;
  friction: boolean;
  slow: boolean;
  inputRequired: boolean;
  errorCodes: string[];
}

export interface RunTimeline {
  runId: string;
  startedAt: string;
  endedAt: string;
  totalDurationMs: number;
  callCount: number;
  steps: RunStep[];
  hasFriction: boolean;
  hasSlowStep: boolean;
  errorCount: number;
  inputRequiredCount: number;
  clientLabel?: string | null;
}

export interface UnlinkedCallGroup {
  windowStart: string;
  windowEnd: string;
  callCount: number;
  rejectedHandleCount: number;
  totalDurationMs: number;
  steps: RunStep[];
  hasFriction: boolean;
  hasSlowStep: boolean;
}

export interface BuildRunTimelineOptions {
  labels?: CapabilityLabelMap;
  slowThresholdMs?: number;
  unlinkedBucketMs?: number;
}

const errorCodePattern = /^[A-Za-z0-9_.:-]{1,64}$/;
const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function eventFingerprint(
  installationId: string,
  surfaceId: string,
  event: SupabaseMcpLifecycleEvent,
): Promise<string> {
  const canonical = JSON.stringify([
    installationId,
    surfaceId,
    event.type,
    event.traceId,
    event.capability.kind,
    event.capability.name,
    event.timestamp,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(canonical),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

function sanitizeErrorCode(
  candidate: string | null | undefined,
): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  return errorCodePattern.test(trimmed) ? trimmed : null;
}

export type SupabaseMcpEventSink = (
  event: SupabaseMcpLifecycleEvent,
) => void | Promise<void>;

/**
 * Fan out each lifecycle event to every configured sink without letting one
 * failing sink block another. If any sink fails, throws after all sinks finish
 * so the runtime's `onError({ phase: "events" })` hook still observes it.
 */
export function composeEventSinks(
  ...sinks: ReadonlyArray<SupabaseMcpEventSink | null | undefined>
): SupabaseMcpEventSink {
  const active = sinks.filter(
    (sink): sink is SupabaseMcpEventSink => typeof sink === "function",
  );
  return async (event: SupabaseMcpLifecycleEvent): Promise<void> => {
    if (active.length === 0) return;
    const results = await Promise.allSettled(
      active.map((sink) => Promise.resolve().then(() => sink(event))),
    );
    const rejected = results.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    if (rejected.length === 1) throw rejected[0]!.reason;
    if (rejected.length > 1) {
      throw new AggregateError(
        rejected.map((entry) => entry.reason),
        `${rejected.length} lifecycle event sinks failed`,
      );
    }
  };
}

export interface CreateTelemetrySinkOptions<Database = any> {
  /**
   * Service-role Supabase client (or lazy factory) authorized to invoke
   * `public.chumbo_telemetry_ingest_v2`.
   */
  supabase: SupabaseClient<Database> | (() => SupabaseClient<Database>);
  /** Stable installation identifier. Defaults to `"self-hosted"`. */
  installationId?: string;
  /** Stable MCP surface identifier. Defaults to `"default"`. */
  surfaceId?: string;
  /**
   * Optional bounded ASCII error-code extractor (`^[A-Za-z0-9_.:-]{1,64}$`).
   * Never return free-text error messages or caller arguments.
   */
  resolveErrorCode?: (
    event: Extract<SupabaseMcpLifecycleEvent, { type: "capability.finished" }>,
  ) => string | null | undefined;
}

/**
 * Create a payload-free `onEvent` sink writing directly to `chumbo_telemetry`
 * (`chumbo-telemetry@2`) inside your own Supabase project.
 */
export function createTelemetrySink<Database = any>(
  options: CreateTelemetrySinkOptions<Database>,
): SupabaseMcpEventSink {
  const installationId = options.installationId ?? "self-hosted";
  const surfaceId = options.surfaceId ?? "default";
  if (
    !installationId ||
    installationId.length > 128 ||
    !surfaceId ||
    surfaceId.length > 128
  ) {
    throw new Error(
      "Telemetry installationId and surfaceId must be 1-128 characters.",
    );
  }

  return async (event: SupabaseMcpLifecycleEvent): Promise<void> => {
    const client =
      typeof options.supabase === "function"
        ? options.supabase()
        : options.supabase;
    const fingerprint = await eventFingerprint(
      installationId,
      surfaceId,
      event,
    );
    const run = event.schemaVersion === 2 ? event.run : null;
    const finished = event.type === "capability.finished" ? event : null;
    const resolvedCode = finished
      ? sanitizeErrorCode(
          finished.errorCode ?? options.resolveErrorCode?.(finished),
        )
      : null;
    const runRejected =
      event.schemaVersion === 2 && "runRejected" in event
        ? sanitizeErrorCode(event.runRejected)
        : null;
    const sessionId =
      event.schemaVersion === 2 &&
      "sessionId" in event &&
      typeof event.sessionId === "string" &&
      event.sessionId.length > 0 &&
      event.sessionId.length <= 128
        ? event.sessionId
        : null;

    const { error } = await (client as SupabaseClient<any>).rpc(
      "chumbo_telemetry_ingest_v2",
      {
        requested_installation_id: installationId,
        requested_surface_id: surfaceId,
        requested_event_type: event.type,
        requested_occurred_at: event.timestamp,
        requested_trace_id: event.traceId,
        requested_event_fingerprint: fingerprint,
        requested_server_name: event.server.name,
        requested_server_version: event.server.version,
        requested_capability_kind: event.capability.kind,
        requested_capability_name: event.capability.name,
        requested_subject: event.principal?.subject ?? null,
        requested_client_id: event.principal?.clientId ?? null,
        requested_authentication_mode: event.authentication.mode,
        requested_authentication_strategy: event.authentication.strategy,
        requested_run_id: run?.id ?? null,
        requested_run_started_at: run?.startedAt ?? null,
        requested_session_id: sessionId,
        requested_run_rejected: runRejected,
        requested_error_code: resolvedCode,
        requested_duration_ms: finished?.durationMs ?? null,
        requested_outcome: finished?.outcome ?? null,
      },
    );
    if (error) throw new Error(error.message);
  };
}

export function humanizeCapabilityName(
  name: string,
  labels?: CapabilityLabelMap,
): string {
  const configured = labels?.[name]?.trim();
  if (configured) return configured;
  const words = name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[._/-]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (words.length === 0) return name;
  const joined = words.map((word) => word.toLowerCase()).join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

function worstOutcome(
  outcomes: readonly SupabaseMcpLifecycleOutcome[],
): SupabaseMcpLifecycleOutcome {
  if (outcomes.includes("failure")) return "failure";
  if (outcomes.includes("tool-error")) return "tool-error";
  if (outcomes.includes("input-required")) return "input-required";
  return "success";
}

function uniqueErrorCodes(events: readonly RawRunEvent[]): string[] {
  const codes = new Set<string>();
  for (const event of events) {
    const code = event.errorCode?.trim();
    if (code) codes.add(code);
  }
  return [...codes];
}

function stepSignature(event: RawRunEvent): string {
  return `${event.capabilityKind}\u0000${event.capabilityName}`;
}

export function collapseStepRepeats(
  events: readonly RawRunEvent[],
  options: { labels?: CapabilityLabelMap; slowThresholdMs?: number } = {},
): RunStep[] {
  const slowThresholdMs = options.slowThresholdMs ?? SLOW_STEP_THRESHOLD_MS;
  const labels = options.labels;
  const steps: RunStep[] = [];
  let index = 0;

  while (index < events.length) {
    let matchedCycleLength = 0;
    let matchedCycles = 1;

    for (const cycleLength of [1, 2, 3]) {
      if (index + cycleLength * 2 > events.length) continue;
      let cycles = 1;
      while (index + (cycles + 1) * cycleLength <= events.length) {
        let matches = true;
        for (let offset = 0; offset < cycleLength; offset += 1) {
          if (
            stepSignature(events[index + offset]!) !==
            stepSignature(events[index + cycles * cycleLength + offset]!)
          ) {
            matches = false;
            break;
          }
        }
        if (!matches) break;
        cycles += 1;
      }
      if (cycles >= 2) {
        matchedCycleLength = cycleLength;
        matchedCycles = cycles;
        break;
      }
    }

    if (matchedCycleLength > 0 && matchedCycles >= 2) {
      const spanLength = matchedCycleLength * matchedCycles;
      const slice = events.slice(index, index + spanLength);
      const pattern = events.slice(index, index + matchedCycleLength);
      const patternLabels = pattern.map((entry) =>
        humanizeCapabilityName(entry.capabilityName, labels),
      );
      const label =
        matchedCycleLength === 1
          ? `Repeated: ${patternLabels[0]!} (×${matchedCycles})`
          : `Back and forth: ${patternLabels.join(" → ")} (×${matchedCycles})`;
      const allDurationsKnown = slice.every(
        (entry) => entry.durationMs !== null,
      );
      const totalDuration = slice.reduce(
        (sum, entry) => sum + (entry.durationMs ?? 0),
        0,
      );
      steps.push({
        kind: "loop",
        label,
        capabilityNames: pattern.map((entry) => entry.capabilityName),
        capabilityKinds: pattern.map((entry) => entry.capabilityKind),
        callCount: spanLength,
        cycleCount: matchedCycles,
        startedAt: slice[0]!.occurredAt,
        endedAt: slice[slice.length - 1]!.occurredAt,
        durationMs: allDurationsKnown ? totalDuration : totalDuration || null,
        outcome: worstOutcome(slice.map((entry) => entry.outcome)),
        friction: slice.some(
          (entry) =>
            entry.outcome === "tool-error" || entry.outcome === "failure",
        ),
        slow: slice.some(
          (entry) =>
            entry.durationMs !== null && entry.durationMs > slowThresholdMs,
        ),
        inputRequired: slice.some(
          (entry) => entry.outcome === "input-required",
        ),
        errorCodes: uniqueErrorCodes(slice),
      });
      index += spanLength;
      continue;
    }

    const current = events[index]!;
    steps.push({
      kind: "call",
      label: humanizeCapabilityName(current.capabilityName, labels),
      capabilityNames: [current.capabilityName],
      capabilityKinds: [current.capabilityKind],
      callCount: 1,
      startedAt: current.occurredAt,
      endedAt: current.occurredAt,
      durationMs: current.durationMs,
      outcome: current.outcome,
      friction:
        current.outcome === "tool-error" || current.outcome === "failure",
      slow: current.durationMs !== null && current.durationMs > slowThresholdMs,
      inputRequired: current.outcome === "input-required",
      errorCodes: uniqueErrorCodes([current]),
    });
    index += 1;
  }

  return steps;
}

export function buildRunTimeline(
  rawEvents: readonly RawRunEvent[],
  options: BuildRunTimelineOptions = {},
): { runs: RunTimeline[]; unlinkedCalls: UnlinkedCallGroup[] } {
  const slowThresholdMs = options.slowThresholdMs ?? SLOW_STEP_THRESHOLD_MS;
  const unlinkedBucketMs = options.unlinkedBucketMs ?? UNLINKED_CALL_BUCKET_MS;

  const indexed = rawEvents.map((event, index) => ({
    event,
    index,
    ms: Date.parse(event.occurredAt),
  }));
  indexed.sort((left, right) =>
    left.ms !== right.ms ? left.ms - right.ms : left.index - right.index,
  );

  const byRunId = new Map<string, RawRunEvent[]>();
  const unlinked: Array<{ event: RawRunEvent; ms: number }> = [];

  for (const item of indexed) {
    const runId = item.event.runId?.trim() ?? "";
    const rejected = Boolean(item.event.runRejected?.trim());
    if (runId && !rejected) {
      const list = byRunId.get(runId);
      if (list) list.push(item.event);
      else byRunId.set(runId, [item.event]);
    } else {
      unlinked.push({ event: item.event, ms: item.ms });
    }
  }

  const runs: RunTimeline[] = [];
  for (const [runId, group] of byRunId.entries()) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const explicitStart = group
      .map((entry) => entry.runStartedAt)
      .find(
        (candidate): candidate is string =>
          typeof candidate === "string" &&
          !Number.isNaN(Date.parse(candidate)) &&
          Date.parse(candidate) <= Date.parse(first.occurredAt),
      );
    const startedAt = explicitStart ?? first.occurredAt;
    const steps = collapseStepRepeats(group, {
      ...(options.labels !== undefined ? { labels: options.labels } : {}),
      slowThresholdMs,
    });
    const errorCount = group.filter(
      (entry) => entry.outcome === "tool-error" || entry.outcome === "failure",
    ).length;
    const inputRequiredCount = group.filter(
      (entry) => entry.outcome === "input-required",
    ).length;
    const clientLabel =
      group.map((entry) => entry.clientLabel).find((label) => Boolean(label)) ??
      null;
    runs.push({
      runId,
      startedAt,
      endedAt: last.occurredAt,
      totalDurationMs: group.reduce(
        (sum, entry) => sum + (entry.durationMs ?? 0),
        0,
      ),
      callCount: group.length,
      steps,
      hasFriction: errorCount > 0,
      hasSlowStep: steps.some((step) => step.slow),
      errorCount,
      inputRequiredCount,
      clientLabel,
    });
  }

  runs.sort((left, right) => {
    const diff = Date.parse(right.startedAt) - Date.parse(left.startedAt);
    return diff !== 0 ? diff : left.runId.localeCompare(right.runId);
  });

  const unlinkedCalls: UnlinkedCallGroup[] = [];
  let currentBucket: { startMs: number; events: RawRunEvent[] } | null = null;
  for (const item of unlinked) {
    const bucketFloor =
      Math.floor(item.ms / unlinkedBucketMs) * unlinkedBucketMs;
    if (!currentBucket || currentBucket.startMs !== bucketFloor) {
      if (currentBucket) {
        const steps = collapseStepRepeats(currentBucket.events, {
          ...(options.labels !== undefined ? { labels: options.labels } : {}),
          slowThresholdMs,
        });
        unlinkedCalls.push({
          windowStart: new Date(currentBucket.startMs).toISOString(),
          windowEnd: new Date(
            currentBucket.startMs + unlinkedBucketMs,
          ).toISOString(),
          callCount: currentBucket.events.length,
          rejectedHandleCount: currentBucket.events.filter((entry) =>
            Boolean(entry.runRejected),
          ).length,
          totalDurationMs: currentBucket.events.reduce(
            (sum, entry) => sum + (entry.durationMs ?? 0),
            0,
          ),
          steps,
          hasFriction: steps.some((step) => step.friction),
          hasSlowStep: steps.some((step) => step.slow),
        });
      }
      currentBucket = { startMs: bucketFloor, events: [item.event] };
    } else {
      currentBucket.events.push(item.event);
    }
  }
  if (currentBucket) {
    const steps = collapseStepRepeats(currentBucket.events, {
      ...(options.labels !== undefined ? { labels: options.labels } : {}),
      slowThresholdMs,
    });
    unlinkedCalls.push({
      windowStart: new Date(currentBucket.startMs).toISOString(),
      windowEnd: new Date(
        currentBucket.startMs + unlinkedBucketMs,
      ).toISOString(),
      callCount: currentBucket.events.length,
      rejectedHandleCount: currentBucket.events.filter((entry) =>
        Boolean(entry.runRejected),
      ).length,
      totalDurationMs: currentBucket.events.reduce(
        (sum, entry) => sum + (entry.durationMs ?? 0),
        0,
      ),
      steps,
      hasFriction: steps.some((step) => step.friction),
      hasSlowStep: steps.some((step) => step.slow),
    });
  }
  unlinkedCalls.sort(
    (left, right) =>
      Date.parse(right.windowStart) - Date.parse(left.windowStart),
  );

  return { runs, unlinkedCalls };
}

export interface PrincipalIdentityOverride {
  displayName?: string;
  email?: string | null;
}

export interface CreateSupabaseInsightsAdapterOptions<Database = any> {
  supabase: SupabaseClient<Database>;
  installationId?: string;
  surfaceId?: string;
  projectSlug?: string;
  projectLabel?: string;
  labels?: CapabilityLabelMap;
  resolvePrincipal?: (
    subjectIds: readonly string[],
  ) =>
    | Readonly<Record<string, PrincipalIdentityOverride>>
    | Promise<Readonly<Record<string, PrincipalIdentityOverride>>>;
}

/**
 * Create a client-safe `InsightsAdapter` backed by the `chumbo_insights_*`
 * RPCs installed by `chumbo-telemetry@2` (`chumbo setup --insights`).
 */
export function createSupabaseInsightsAdapter<Database = any>(
  options: CreateSupabaseInsightsAdapterOptions<Database>,
) {
  const client = options.supabase as SupabaseClient<any>;
  const installationId = options.installationId ?? "self-hosted";
  const surfaceId = options.surfaceId ?? "default";
  const projectSlug = options.projectSlug ?? "self-hosted";
  const projectLabel = options.projectLabel ?? "MCP Server";

  return {
    async loadAggregate(input: { lookbackDays: InsightsLookbackDays }) {
      const { data, error } = await client.rpc("chumbo_insights_aggregate", {
        requested_lookback_days: input.lookbackDays,
        requested_installation_id: installationId,
        requested_surface_id: surfaceId,
      });
      if (error) throw new Error(error.message);
      return {
        schemaVersion: 1 as const,
        project: { slug: projectSlug, label: projectLabel },
        servedAt: String(data.period.to),
        data,
      };
    },
    async loadPeople(input: { lookbackDays: InsightsLookbackDays }) {
      const { data, error } = await client.rpc("chumbo_insights_people", {
        requested_lookback_days: input.lookbackDays,
        requested_installation_id: installationId,
        requested_surface_id: surfaceId,
      });
      if (error) throw new Error(error.message);
      const people = Array.isArray(data?.people) ? [...data.people] : [];
      if (options.resolvePrincipal && people.length > 0) {
        const overrides = await options.resolvePrincipal(
          people.map((person: { id: string }) => person.id),
        );
        for (const person of people) {
          const custom = overrides[person.id];
          if (custom?.displayName) person.displayName = custom.displayName;
          if (custom?.email !== undefined) person.email = custom.email;
        }
        people.sort((left, right) =>
          String(left.displayName)
            .toLowerCase()
            .localeCompare(String(right.displayName).toLowerCase()),
        );
      }
      return { period: data.period, people };
    },
    async loadMemberRuns(input: {
      memberId: string;
      lookbackDays: InsightsLookbackDays;
      before?: string;
      limit?: number;
    }) {
      const to = input.before ? new Date(input.before) : new Date();
      const windowEnd = new Date();
      const windowStart = new Date(
        windowEnd.getTime() - input.lookbackDays * 86_400_000,
      );
      const { data, error } = await client.rpc("chumbo_insights_runs", {
        p_member: input.memberId,
        p_from: windowStart.toISOString(),
        p_to: to.toISOString(),
        requested_installation_id: installationId,
        requested_surface_id: surfaceId,
        ...(input.limit !== undefined ? { requested_limit: input.limit } : {}),
      });
      if (error) throw new Error(error.message);
      const built = buildRunTimeline(
        Array.isArray(data?.events) ? data.events : [],
        options.labels ? { labels: options.labels } : {},
      );
      let member = data.member;
      if (options.resolvePrincipal && member?.id) {
        const overrides = await options.resolvePrincipal([member.id]);
        const custom = overrides[member.id];
        if (custom) {
          member = {
            ...member,
            ...(custom.displayName ? { displayName: custom.displayName } : {}),
            ...(custom.email !== undefined ? { email: custom.email } : {}),
          };
        }
      }
      return {
        member,
        period: {
          lookbackDays: input.lookbackDays,
          from: windowStart.toISOString(),
          to: windowEnd.toISOString(),
        },
        runs: built.runs,
        unlinkedCalls: built.unlinkedCalls,
        hasMore: Boolean(data?.hasMore),
        nextBefore: data?.nextBefore ?? null,
      };
    },
  };
}
