import { describe, expect, it } from "vitest";
import { renderBrandedCliPackage } from "../src/cli-package.js";

describe("client-branded CLI package rendering", () => {
  it("puts the customer's identity on the package, binary, and help entrypoint", () => {
    const files = renderBrandedCliPackage(
      {
        packageName: "@acme/ops-cli",
        binaryName: "acme",
        displayName: "Acme Ops",
        version: "3.2.1",
        endpoint: "https://api.acme.example/mcp",
        supportUrl: "https://acme.example/support",
        poweredBy: "Chumbo Cloud",
      },
      { chumboVersion: "^0.12.0" },
    );
    const manifest = JSON.parse(files["package.json"]);

    expect(manifest).toMatchObject({
      name: "@acme/ops-cli",
      version: "3.2.1",
      bin: { acme: "bin/cli.js" },
      dependencies: { chumbo: "^0.12.0" },
    });
    expect(files["bin/cli.js"]).toContain(
      '"endpoint": "https://api.acme.example/mcp"',
    );
    expect(files["README.md"]).toContain("acme login");
    expect(files["README.md"]).toContain("@acme/ops-cli");
  });

  it("rejects identities that cannot safely become npm or shell names", () => {
    expect(() =>
      renderBrandedCliPackage(
        {
          packageName: "@Acme/Ops CLI",
          binaryName: "Acme Ops",
          displayName: "Acme Ops",
          version: "1.0.0",
          endpoint: "https://api.acme.example/mcp",
        },
        { chumboVersion: "^0.12.0" },
      ),
    ).toThrow(/packageName/);
  });

  it("rejects an invalid package version", () => {
    expect(() =>
      renderBrandedCliPackage(
        {
          packageName: "@acme/ops-cli",
          binaryName: "acme",
          displayName: "Acme Ops",
          version: "latest",
          endpoint: "https://api.acme.example/mcp",
        },
        { chumboVersion: "^0.12.0" },
      ),
    ).toThrow(/semantic version/);
  });

  it("rejects plaintext production endpoints but permits loopback development", () => {
    const base = {
      packageName: "@acme/ops-cli",
      binaryName: "acme",
      displayName: "Acme Ops",
      version: "1.0.0",
    } as const;

    expect(() =>
      renderBrandedCliPackage(
        { ...base, endpoint: "http://api.acme.example/mcp" },
        { chumboVersion: "^0.12.0" },
      ),
    ).toThrow(/HTTPS/);
    expect(() =>
      renderBrandedCliPackage(
        { ...base, endpoint: "http://127.0.0.1:8787/mcp" },
        { chumboVersion: "^0.12.0" },
      ),
    ).not.toThrow();
  });
});
