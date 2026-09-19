import { describe, expect, it } from "vitest";
import { renderBrandedCliPackage } from "../src/cli-package.js";

describe("project-branded CLI package rendering", () => {
  it("puts the project's identity on the package, binary, and help entrypoint", () => {
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
      {
        chumboVersion: "^0.12.0",
        license: "Apache-2.0",
        access: "public",
        repository: {
          url: "git+https://github.com/acme/ops.git",
          directory: "packages/cli",
        },
      },
    );
    const manifest = JSON.parse(files["package.json"]);

    expect(manifest).toMatchObject({
      name: "@acme/ops-cli",
      version: "3.2.1",
      bin: { acme: "bin/cli.js" },
      license: "Apache-2.0",
      publishConfig: { access: "public" },
      repository: {
        type: "git",
        url: "git+https://github.com/acme/ops.git",
        directory: "packages/cli",
      },
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

  it("keeps publication metadata bounded and scoped", () => {
    const config = {
      packageName: "@acme/ops-cli",
      binaryName: "acme",
      displayName: "Acme Ops",
      version: "1.0.0",
      endpoint: "https://api.acme.example/mcp",
    } as const;
    expect(() =>
      renderBrandedCliPackage(config, {
        chumboVersion: "0.12.0",
        license: "MIT\nprivate: true",
      }),
    ).toThrow(/license/);
    expect(() =>
      renderBrandedCliPackage(
        { ...config, packageName: "acme-cli" },
        { chumboVersion: "0.12.0", access: "restricted" },
      ),
    ).toThrow(/scope/);
    expect(() =>
      renderBrandedCliPackage(config, {
        chumboVersion: "0.12.0",
        repository: {
          url: "https://user:secret@github.com/acme/ops.git",
        },
      }),
    ).toThrow(/credential-free/);
    expect(() =>
      renderBrandedCliPackage(config, {
        chumboVersion: "0.12.0",
        repository: {
          url: "https://github.com/acme/ops.git",
          directory: "../other",
        },
      }),
    ).toThrow(/safe relative path/);
  });
});
