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

writeFileSync("dist/.release-metafile.json", JSON.stringify(result.metafile, null, 2) + "\n");
