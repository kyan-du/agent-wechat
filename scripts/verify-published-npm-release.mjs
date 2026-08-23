#!/usr/bin/env node
import { cleanInstallPublished, exactStableVersionPattern, publicPackages, viewPackage } from "./npm-release-utils.mjs";

const version = process.argv[2];
if (!exactStableVersionPattern.test(version ?? "")) {
  throw new Error("usage: verify-published-npm-release.mjs <exact stable version>");
}

for (const item of publicPackages) {
  const metadata = await viewPackage(item.name, version);
  console.log(`verified ${metadata.name}@${metadata.version} at ${metadata.dist.tarball}`);
}

cleanInstallPublished(version);
console.log(`public registry smoke passed for ${publicPackages.map((item) => `${item.name}@${version}`).join(", ")}`);
