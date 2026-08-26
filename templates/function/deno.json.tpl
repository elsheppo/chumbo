{
  "imports": {
    "@modelcontextprotocol/server": "npm:@modelcontextprotocol/server@2.0.0",
    "@supabase/server": "npm:@supabase/server@1.4.1",
    "@supabase/server/core": "npm:@supabase/server@1.4.1/core",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.105.4",
    "chumbo": "npm:chumbo@{{PACKAGE_VERSION}}",
    "zod": "npm:zod@4.2.0"
  },
  "compilerOptions": {
    "strict": true
  },
  "tasks": {
    "check": "deno check index.ts capabilities.ts",
    "test": "deno test --allow-env --allow-net index_test.ts"
  }
}
