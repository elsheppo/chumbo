{
  "imports": {
    "@modelcontextprotocol/server": "npm:@modelcontextprotocol/server@2.0.0",
    "@supabase/middleware": "npm:@supabase/middleware@1.0.0",
    "@supabase/server": "npm:@supabase/server@1.9.2",
    "@supabase/server/core": "npm:@supabase/server@1.9.2/core",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.105.4",
    "chumbo": "npm:chumbo@{{PACKAGE_VERSION}}",
    "chumbo/middleware": "npm:chumbo@{{PACKAGE_VERSION}}/middleware",
    "chumbo/testing": "npm:chumbo@{{PACKAGE_VERSION}}/testing",
    "zod": "npm:zod@4.6.7"
  },
  "compilerOptions": {
    "strict": true
  },
  "exclude": ["apps/", "dist/"],
  "tasks": {
    "check": "deno check index.ts capabilities.ts",
    "test": "deno test --allow-env --allow-net ."
  }
}
