import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  validateHostHeader,
  validateOriginHeader,
} from "@modelcontextprotocol/server";
import type { McpAppCsp } from "./mcp-apps.js";
import { PACKAGE_VERSION } from "./version.js";

export interface StagedAppView {
  readonly viewId: string;
  readonly url: string;
  readonly cspHeader: string;
  readonly uri?: string;
}

export interface DevAppSimulatorOptions {
  /** Loopback port for the isolated sandbox iframe server (default: `0` ephemeral). */
  readonly sandboxPort?: number;
  /** Optional callback invoked when a View reports a CSP violation. */
  readonly onCspViolation?: (violation: CspViolationReport) => void;
}

export interface CspViolationReport {
  readonly effectiveDirective: string;
  readonly blockedURI: string;
  readonly sourceFile?: string;
  readonly lineNumber?: number;
}

export interface DevAppSimulatorHandle {
  readonly sandboxOrigin: string;
  readonly sandboxPort: number;
  stageView(input: {
    readonly html: string;
    readonly csp?: McpAppCsp;
    readonly uri?: string;
  }): StagedAppView;
  renderWorkbenchSlotHtml(options: {
    readonly workbenchToken: string;
    readonly initialAppName?: string;
  }): string;
  watchApps(options: {
    readonly appsDir: string;
    readonly debounceMs?: number;
    readonly onChange: (appName: string) => void | Promise<void>;
  }): () => void;
  close(): Promise<void>;
}

const CSP_REPORTER_SCRIPT = `<script>(function(){document.addEventListener("securitypolicyviolation",function(e){try{window.parent.postMessage({__chumboCspViolation:{effectiveDirective:e.effectiveDirective||e.violatedDirective||"unknown",blockedURI:e.blockedURI||"",sourceFile:e.sourceFile||"",lineNumber:e.lineNumber||0}},"*");}catch(_){}});})();</script>`;

/**
 * Synthesize an exact SEP-1865 HTTP `Content-Security-Policy` header from `_meta.ui.csp`.
 * Empty `connectDomains`, `frameDomains`, or `baseUriDomains` emit `'none'`.
 */
export function buildMcpAppCspHeader(csp: McpAppCsp = {}): string {
  const res = csp.resourceDomains?.length
    ? ` ${csp.resourceDomains.join(" ")}`
    : "";
  const connect = csp.connectDomains?.length
    ? csp.connectDomains.join(" ")
    : "'none'";
  const frames = csp.frameDomains?.length
    ? csp.frameDomains.join(" ")
    : "'none'";
  const baseUri = csp.baseUriDomains?.length
    ? csp.baseUriDomains.join(" ")
    : "'none'";
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline'${res}`,
    `style-src 'unsafe-inline'${res}`,
    `img-src data: blob:${res}`,
    `font-src data:${res}`,
    `media-src data: blob:${res}`,
    `connect-src ${connect}`,
    `frame-src ${frames}`,
    `base-uri ${baseUri}`,
    "form-action 'none'",
  ].join("; ");
}

/** Prepend a `securitypolicyviolation` listener before View scripts execute inside the sandbox. */
export function injectCspViolationReporter(html: string): string {
  if (/<head\b[^>]*>/iu.test(html)) {
    return html.replace(
      /<head\b[^>]*>/iu,
      (match) => `${match}${CSP_REPORTER_SCRIPT}`,
    );
  }
  return `${CSP_REPORTER_SCRIPT}${html}`;
}

/**
 * Self-contained inline browser SEP-1865 JSON-RPC 2.0 `postMessage` host bridge.
 *
 * Uses zero `@modelcontextprotocol/ext-apps/app-bridge` or `@modelcontextprotocol/sdk` v1
 * imports, gates strictly on `event.source === iframe.contentWindow && event.origin === "null"`
 * for `<iframe sandbox="allow-scripts">`, and proxies server calls through the workbench's
 * CSRF-protected `/__chumbo/workbench/mcp` endpoint.
 */
export function renderAppHostBridgeScript(options: {
  readonly workbenchToken: string;
  readonly sandboxOrigin: string;
}): string {
  const safeToken = JSON.stringify(options.workbenchToken);
  const safeSandboxOrigin = JSON.stringify(options.sandboxOrigin);
  const safeVersion = JSON.stringify(PACKAGE_VERSION);
  return `(function(){
const WORKBENCH_TOKEN=${safeToken};
const SANDBOX_ORIGIN=${safeSandboxOrigin};
const HOST_VERSION=${safeVersion};
const HOST_THEMES={
  light:{"--color-background-primary":"#ffffff","--color-background-secondary":"#f5f7f6","--color-text-primary":"#17211b","--color-text-secondary":"#5d6a63","--color-border-primary":"#d8ded9","--font-sans":"ui-sans-serif, system-ui, sans-serif","--border-radius-md":"10px"},
  dark:{"--color-background-primary":"#141816","--color-background-secondary":"#1d2320","--color-text-primary":"#eef3f0","--color-text-secondary":"#9aa8a0","--color-border-primary":"#2e3832","--font-sans":"ui-sans-serif, system-ui, sans-serif","--border-radius-md":"10px"}
};
window.__chumboAppHost=function createChumboAppHost(iframe,callbacks){
  let initialized=false;
  let pendingNotifications=[];
  let dropNextMutationReply=false;
  let hostContext={
    theme:"light",
    displayMode:"inline",
    availableDisplayModes:["inline","fullscreen"],
    containerDimensions:{maxHeight:560,width:720},
    safeAreaInsets:{top:0,right:0,bottom:0,left:0},
    platform:"web",
    styles:{variables:HOST_THEMES.light}
  };
  function postToView(message){
    if(!iframe.contentWindow)return;
    if(!iframe.src||!iframe.src.startsWith(SANDBOX_ORIGIN+"/view/"))return;
    iframe.contentWindow.postMessage(message,"*");
  }
  function reply(id,result){postToView({jsonrpc:"2.0",id,result});}
  function replyError(id,code,message){postToView({jsonrpc:"2.0",id,error:{code,message}});}
  function notify(method,params){
    if(!initialized&&method!=="ui/resource-teardown"){pendingNotifications.push({method,params});return;}
    postToView({jsonrpc:"2.0",method,params});
  }
  async function proxyMcp(method,params){
    const res=await fetch("/__chumbo/workbench/mcp",{
      method:"POST",
      headers:{"content-type":"application/json","x-chumbo-workbench-token":WORKBENCH_TOKEN},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,params:params||{}})
    });
    const body=await res.json();
    if(body.error)throw body.error;
    return body.result;
  }
  async function onMessage(event){
    if(event.source!==iframe.contentWindow||event.origin!=="null")return;
    const msg=event.data;
    if(!msg||typeof msg!=="object")return;
    if(msg.__chumboCspViolation){
      callbacks&&callbacks.onCspViolation&&callbacks.onCspViolation(msg.__chumboCspViolation);
      fetch("/__chumbo/workbench/csp-violation",{method:"POST",headers:{"content-type":"application/json","x-chumbo-workbench-token":WORKBENCH_TOKEN},body:JSON.stringify(msg.__chumboCspViolation)}).catch(function(){});
      return;
    }
    if(msg.jsonrpc!=="2.0"||typeof msg.method!=="string")return;
    const method=msg.method;
    const params=msg.params||{};
    if(method==="ui/initialize"){
      reply(msg.id,{
        protocolVersion:"2026-01-26",
        hostInfo:{name:"chumbo-dev-workbench",version:HOST_VERSION},
        hostCapabilities:{openLinks:{},serverTools:{},serverResources:{},logging:{},updateModelContext:{text:{},structuredContent:{}},sandbox:{}},
        hostContext
      });
      callbacks&&callbacks.onEvent&&callbacks.onEvent({type:"initialize",params});
      return;
    }
    if(method==="ui/notifications/initialized"){
      initialized=true;
      const queued=pendingNotifications;
      pendingNotifications=[];
      for(const item of queued)postToView({jsonrpc:"2.0",method:item.method,params:item.params});
      callbacks&&callbacks.onEvent&&callbacks.onEvent({type:"initialized"});
      return;
    }
    if(method==="ping"){reply(msg.id,{});return;}
    if(!initialized&&msg.id!==undefined){
      callbacks&&callbacks.onEvent&&callbacks.onEvent({type:"warning",message:"View sent "+method+" before ui/notifications/initialized"});
    }
    if(method==="ui/notifications/size-changed"){
      if(hostContext.displayMode==="inline"&&typeof params.height==="number"&&params.height>0){
        const maxH=(hostContext.containerDimensions&&hostContext.containerDimensions.maxHeight)||560;
        iframe.style.height=Math.min(params.height,maxH)+"px";
      }
      callbacks&&callbacks.onEvent&&callbacks.onEvent({type:"size-changed",params});
      return;
    }
    if(method==="ui/request-display-mode"){
      const nextMode=params.mode==="fullscreen"?"fullscreen":"inline";
      hostContext=Object.assign({},hostContext,{displayMode:nextMode});
      reply(msg.id,{mode:nextMode});
      callbacks&&callbacks.onDisplayMode&&callbacks.onDisplayMode(nextMode);
      return;
    }
    if(method==="ui/update-model-context"){
      callbacks&&callbacks.onModelContext&&callbacks.onModelContext(params);
      reply(msg.id,{});
      return;
    }
    if(method==="ui/open-link"){
      try{
        const u=new URL(String(params.url||""));
        if(u.protocol==="https:"||(u.protocol==="http:"&&(u.hostname==="localhost"||u.hostname==="127.0.0.1"))){
          window.open(u.href,"_blank","noopener,noreferrer");
          reply(msg.id,{});
        }else{
          reply(msg.id,{isError:true});
        }
      }catch(_){reply(msg.id,{isError:true});}
      return;
    }
    if(method==="tools/call"||method==="tools/list"||method==="resources/read"||method==="resources/list"||method==="prompts/list"){
      try{
        const result=await proxyMcp(method,params);
        callbacks&&callbacks.onEvent&&callbacks.onEvent({type:"mcp",method,params,result});
        if(method==="tools/call"&&dropNextMutationReply){
          dropNextMutationReply=false;
          callbacks&&callbacks.onEvent&&callbacks.onEvent({type:"fault",message:"Withheld tools/call reply after server execution (uncertain-retry test)"});
          return;
        }
        reply(msg.id,result);
      }catch(err){
        replyError(msg.id,(err&&err.code)||-32603,(err&&err.message)||"MCP proxy error");
      }
    }
  }
  window.addEventListener("message",onMessage);
  return {
    sendToolInput:function(args){notify("ui/notifications/tool-input",{arguments:args||{}});},
    sendToolResult:function(result){notify("ui/notifications/tool-result",result);},
    updateHostContext:function(patch){
      hostContext=Object.assign({},hostContext,patch);
      if(patch.theme&&HOST_THEMES[patch.theme]){
        hostContext=Object.assign({},hostContext,{styles:{variables:HOST_THEMES[patch.theme]}});
      }
      notify("ui/notifications/host-context-changed",hostContext);
    },
    setDropNextMutationReply:function(enabled){dropNextMutationReply=Boolean(enabled);},
    teardown:function(){postToView({jsonrpc:"2.0",id:"teardown",method:"ui/resource-teardown",params:{}});},
    destroy:function(){window.removeEventListener("message",onMessage);}
  };
};
})();`;
}

/**
 * Start the isolated loopback sandbox server for MCP App View previews.
 *
 * Binds strictly to `127.0.0.1` on a separate port from the workbench UI so `<iframe sandbox="allow-scripts">`
 * executes with an opaque `"null"` origin and cannot access `X-Chumbo-Workbench-Token`.
 */
export async function startDevAppSimulator(
  options: DevAppSimulatorOptions = {},
): Promise<DevAppSimulatorHandle> {
  const staged = new Map<
    string,
    { readonly html: string; readonly cspHeader: string; readonly uri?: string }
  >();
  const allowedHosts = localhostAllowedHostnames();
  const allowedOrigins = localhostAllowedOrigins();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const hostCheck = validateHostHeader(req.headers.host, allowedHosts);
    if (!hostCheck.ok) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden host");
      return;
    }
    const originCheck = validateOriginHeader(
      req.headers.origin,
      allowedOrigins,
    );
    if (!originCheck.ok) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden origin");
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, {
        allow: "GET",
        "content-type": "text/plain; charset=utf-8",
      });
      res.end("Method not allowed");
      return;
    }

    const pathname = (req.url ?? "/").split("?", 1)[0] ?? "/";
    const match = /^\/view\/([a-f0-9-]+)$/u.exec(pathname);
    const viewId = match?.[1];
    const entry = viewId ? staged.get(viewId) : undefined;
    if (!entry) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("View not found");
      return;
    }

    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": entry.cspHeader,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    });
    res.end(entry.html);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.sandboxPort ?? 0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo;
  const sandboxPort = address.port;
  const sandboxOrigin = `http://127.0.0.1:${sandboxPort}`;

  return {
    sandboxOrigin,
    sandboxPort,

    stageView(input) {
      const viewId = randomUUID();
      const cspHeader = buildMcpAppCspHeader(input.csp);
      const html = injectCspViolationReporter(input.html);
      // Keep bounded in-memory staged views (most recent 16):
      if (staged.size >= 16) {
        const oldest = staged.keys().next().value;
        if (oldest) staged.delete(oldest);
      }
      staged.set(viewId, { html, cspHeader, uri: input.uri });
      return {
        viewId,
        url: `${sandboxOrigin}/view/${viewId}`,
        cspHeader,
        ...(input.uri ? { uri: input.uri } : {}),
      };
    },

    renderWorkbenchSlotHtml({ workbenchToken, initialAppName }) {
      const bridgeScript = renderAppHostBridgeScript({
        workbenchToken,
        sandboxOrigin,
      });
      return [
        `<section class="chumbo-app-simulator" data-sandbox-origin="${sandboxOrigin}"${initialAppName ? ` data-initial-app="${initialAppName.replaceAll('"', "&quot;")}"` : ""}>`,
        `  <div class="chumbo-app-toolbar" role="toolbar" aria-label="MCP App host controls">`,
        `    <button type="button" data-sim-theme="light">Light</button>`,
        `    <button type="button" data-sim-theme="dark">Dark</button>`,
        `    <button type="button" data-sim-viewport="560">Inline 560px</button>`,
        `    <button type="button" data-sim-viewport="360">Compact 360px</button>`,
        `    <button type="button" data-sim-viewport="fullscreen">Fullscreen</button>`,
        `    <label><input type="checkbox" data-sim-safe-area /> Mobile safe areas</label>`,
        `    <label><input type="checkbox" data-sim-drop-reply /> Drop next mutation reply</label>`,
        `  </div>`,
        `  <iframe class="chumbo-app-frame" title="MCP App View Sandbox" sandbox="allow-scripts" style="width:100%;height:560px;border:1px solid #d8ded9;border-radius:10px;"></iframe>`,
        `  <script>${bridgeScript}</script>`,
        `</section>`,
      ].join("\n");
    },

    watchApps({ appsDir, debounceMs = 150, onChange }) {
      const timers = new Map<string, ReturnType<typeof setTimeout>>();
      const watcher = watch(
        appsDir,
        { recursive: true },
        (_event, filename) => {
          if (!filename) return;
          const appName = String(filename).split(/[\\/]/u, 1)[0];
          if (!appName || appName.startsWith(".")) return;
          const existing = timers.get(appName);
          if (existing) clearTimeout(existing);
          timers.set(
            appName,
            setTimeout(() => {
              timers.delete(appName);
              void Promise.resolve(onChange(appName)).catch(() => undefined);
            }, debounceMs),
          );
        },
      );
      return () => {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        watcher.close();
      };
    },

    async close() {
      staged.clear();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    },
  };
}
