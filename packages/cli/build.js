import { build } from "esbuild";
import { copyFileSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

const result = await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: "dist/cli.js",
  define: {
    PKG_VERSION: JSON.stringify(pkg.version),
  },
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import{createRequire}from"module";const require=createRequire(import.meta.url);',
    ].join("\n"),
  },
  external: ["qrcode-terminal"],
  metafile: true,
});

const here = dirname(fileURLToPath(import.meta.url));
copyFileSync(
  join(here, "../../scripts/device_identity.py"),
  join(here, "dist/device_identity.py"),
);

const compatibility = {
  schemaVersion: 1,
  cliVersion: pkg.version,
  repository: "ghcr.io/kyan-du/agent-wechat",
  apiVersion: 1,
  allowedReferences: ["local-build", "exact-semver-tag", "sha256-digest"],
  floatingTagsAllowed: false,
};
writeFileSync(join(here, "dist/image-compatibility.json"), `${JSON.stringify(compatibility, null, 2)}\n`);

writeFileSync("dist/.release-metafile.json", JSON.stringify(result.metafile, null, 2) + "\n");
