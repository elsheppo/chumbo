import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * The minimal shape `chumbo/node` serves: any app exposing a web-standard
 * fetch handler, such as the result of `createSupabaseMcp`.
 */
export interface NodeFetchApp {
  fetch(request: Request): Response | Promise<Response>;
}

export type NodeRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

export interface ServeOptions {
  /** TCP port to listen on. Defaults to 8080, Cloud Run's conventional port. */
  port?: number;
  /** Bind address. Defaults to 0.0.0.0 so containers accept external traffic. */
  hostname?: string;
}

export interface RunningNodeApp {
  /** A URL that reaches the server from the local machine. */
  url: string;
  server: Server;
  /** Stop listening and end every open connection, including SSE streams. */
  close(): Promise<void>;
}

function requestUrl(request: IncomingMessage): URL {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const protocol =
    (Array.isArray(forwardedProtocol)
      ? forwardedProtocol[0]
      : forwardedProtocol
    )
      ?.split(",")[0]
      ?.trim() || "http";
  const forwardedHost = request.headers["x-forwarded-host"];
  const host =
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ??
    request.headers.host ??
    "localhost";
  return new URL(request.url ?? "/", `${protocol}://${host}`);
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

async function writeResponse(
  response: Response,
  outgoing: ServerResponse,
): Promise<void> {
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") continue;
    outgoing.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);
  if (!response.body) {
    outgoing.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    outgoing,
  );
}

/**
 * Adapt a fetch-handler app to a Node `http` request listener, for embedding
 * a Chumbo MCP app in an existing Node server.
 *
 * The request URL is reconstructed from `x-forwarded-proto` and
 * `x-forwarded-host` when a reverse proxy provides them, so advertised
 * OAuth discovery paths stay correct behind load balancers.
 */
export function toNodeHandler(app: NodeFetchApp): NodeRequestHandler {
  return (incoming, outgoing) => {
    void (async () => {
      const method = incoming.method ?? "GET";
      const body =
        method === "GET" || method === "HEAD"
          ? undefined
          : (Readable.toWeb(incoming) as ReadableStream);
      const request = new Request(requestUrl(incoming), {
        method,
        headers: requestHeaders(incoming),
        ...(body ? { body, duplex: "half" } : {}),
      } as RequestInit);
      const response = await app.fetch(request);
      await writeResponse(response, outgoing);
    })().catch((error: unknown) => {
      if (!outgoing.headersSent) {
        outgoing.statusCode = 500;
        outgoing.setHeader("content-type", "application/json");
        outgoing.end(JSON.stringify({ error: "server_error" }));
      } else {
        outgoing.destroy(
          error instanceof Error ? error : new Error("Response failed"),
        );
      }
    });
  };
}

/**
 * Serve a fetch-handler app over Node's built-in HTTP server. Suitable for
 * Cloud Run, Fly, Railway, or any container platform:
 *
 * ```ts
 * import { serve } from "chumbo/node";
 * const running = await serve(app, { port: Number(process.env.PORT ?? 8080) });
 * ```
 */
export async function serve(
  app: NodeFetchApp,
  options: ServeOptions = {},
): Promise<RunningNodeApp> {
  const hostname = options.hostname ?? "0.0.0.0";
  const server = createServer(toNodeHandler(app));
  server.listen(options.port ?? 8080, hostname);
  await once(server, "listening");
  const address = server.address();
  const port =
    address && typeof address === "object" ? address.port : (options.port ?? 0);
  const reachableHost =
    hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
  return {
    url: `http://${reachableHost}:${port}`,
    server,
    async close() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
