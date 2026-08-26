# Give an MCP a clean product URL

The Supabase function URL works immediately:

```text
https://PROJECT_REF.supabase.co/functions/v1/mcp
```

A product-facing server can instead advertise a URL such as
`https://yourapp.com/mcp` while the same Edge Function continues to run it:

```sh
npx chumbo setup \
  --resume \
  --project-ref PROJECT_REF \
  --public-url https://yourapp.com/mcp \
  --deploy \
  --yes
```

Chumbo sets `MCP_PUBLIC_URL` so MCP and OAuth discovery advertise the clean
URL. The application's Supabase Auth server remains the authorization issuer.
The public route must proxy both `/mcp` and every path beneath it because those
suffix paths serve the protected-resource metadata used during OAuth.

## Use an existing Next.js domain

This needs no new DNS record. Add an external rewrite to `next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/mcp/:path*",
        destination: "https://PROJECT_REF.supabase.co/functions/v1/mcp/:path*",
      },
    ];
  },
};

export default nextConfig;
```

Deploy the site, then verify the route clients will actually use:

```sh
npx chumbo doctor --url https://yourapp.com/mcp
```

## Use a dedicated subdomain

For a URL such as `https://mcp.yourapp.com`, configure that hostname with the
domain's DNS or hosting provider and proxy its complete route tree to the
function. A small Cloudflare Worker is one option:

```ts
const upstream = "https://PROJECT_REF.supabase.co/functions/v1/mcp";

export default {
  async fetch(request: Request) {
    const incoming = new URL(request.url);
    const suffix = incoming.pathname === "/" ? "" : incoming.pathname;
    const target = new URL(`${upstream}${suffix}${incoming.search}`);
    const headers = new Headers(request.headers);
    headers.delete("host");

    return fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    });
  },
};
```

Chumbo cannot change a domain's DNS without access to its provider. Setup
records the exact remaining route and `doctor` verifies it once it exists.

Official platform reference:

- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
