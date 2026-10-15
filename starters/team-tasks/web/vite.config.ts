import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The web app shares generated database types with the MCP function.
  server: { port: 5173, strictPort: true, fs: { allow: [".."] } },
});
