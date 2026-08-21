import { spawnSync } from "node:child_process";

export function classifyGithubRelease(manifest, result) {
  if (result.status !== 0) {
    if (result.status === 1 && (result.stdout ?? "") === "" && /^release not found\s*$/i.test(result.stderr ?? "")) return { state: "absent" };
    throw new Error("GitHub Release query failed closed");
  }
  let release;
  try { release = JSON.parse(result.stdout); } catch { throw new Error("GitHub Release response is malformed"); }
  const expectedTag = manifest.tag;
  const expectedName = manifest.tag;
  const expectedMarker = `Agent-Release-Manifest-SHA256: ${manifest.manifestSha256}`;
  const exact = release.tagName === expectedTag
    && release.name === expectedName
    && release.isPrerelease === false
    && release.isDraft === false
    && release.targetCommitish === manifest.commit
    && typeof release.body === "string"
    && release.body.split("\n").includes(expectedMarker)
    && Array.isArray(release.assets)
    && release.assets.length === 0;
  return exact ? { state: "exact", tag: expectedTag, id: release.id, url: release.url } : {
    state: "drift",
    tag: release.tagName ?? null,
    targetCommitish: release.targetCommitish ?? null,
    isPrerelease: release.isPrerelease ?? null,
    isDraft: release.isDraft ?? null,
    name: release.name ?? null,
    manifestMarker: typeof release.body === "string" && release.body.includes("Agent-Release-Manifest-SHA256:") ? release.body : null,
    assetCount: Array.isArray(release.assets) ? release.assets.length : null,
  };
}

export function queryGithubRelease(manifest, run = spawnSync) {
  const result = run("gh", ["release", "view", manifest.tag, "--json", "id,tagName,targetCommitish,name,isDraft,isPrerelease,body,assets,url"], { encoding: "utf8", env: process.env });
  return classifyGithubRelease(manifest, result);
}
