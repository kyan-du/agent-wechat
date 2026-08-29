#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const path = ".github/workflows/docker-commit-verification.yml";
const text = readFileSync(path, "utf8");
const source = readFileSync("packages/cli/src/image-reference.ts", "utf8");
const tests = readFileSync("packages/cli/src/image-reference.test.ts", "utf8");
const workflow = parseYaml(text);
const trigger = workflow.on ?? workflow.true ?? {};

assert.equal(workflow.name, "Publish Docker Commit Verification Image");
assert.deepEqual(Object.keys(trigger), ["push"]);
assert.deepEqual(trigger.push.branches, ["main"]);
assert.equal(workflow.permissions.contents, "read");
assert.equal(workflow.permissions.packages, "write");
assert.equal(workflow.concurrency["cancel-in-progress"], false);
assert.match(workflow.concurrency.group, /github\.sha/);
assert.deepEqual(Object.keys(workflow.jobs), ["authorize", "build", "publish"]);

const authorize = workflow.jobs.authorize;
assert.equal(authorize.outputs.sha, "${{ steps.identity.outputs.sha }}");
assert.equal(authorize.outputs.tag, "${{ steps.identity.outputs.tag }}");
const identity = authorize.steps.find((step) => step.id === "identity");
assert.ok(identity);
assert.match(identity.run, /test "\$GITHUB_REF" = refs\/heads\/main/);
assert.match(identity.run, /test "\$GITHUB_SHA" = "\$\(git rev-parse HEAD\)"/);
assert.match(identity.run, /git rev-parse --show-toplevel/);
assert.match(identity.run, /tag="\$\{GITHUB_SHA::7\}"/);
assert.match(identity.run, /git rev-parse HEAD \| cut -c1-7/);

const build = workflow.jobs.build;
assert.deepEqual(build.needs, "authorize");
assert.deepEqual(build.strategy.matrix.include.map((item) => [item.arch, item.platform]), [
  ["amd64", "linux/amd64"],
  ["arm64", "linux/arm64"],
]);
const buildPush = build.steps.find((step) => String(step.uses).includes("docker/build-push-action@"));
assert.ok(buildPush);
assert.equal(buildPush.with["push-by-digest"], undefined);
assert.match(buildPush.with.outputs, /push-by-digest=true,name-canonical=true,push=true/);
assert.match(buildPush.with["cache-from"], /commit-verification-\$\{\{ matrix\.arch \}\}/);
assert.match(buildPush.with["cache-to"], /commit-verification-\$\{\{ matrix\.arch \}\}/);

const publish = workflow.jobs.publish;
assert.deepEqual(publish.needs, ["authorize", "build"]);
const create = publish.steps.find((step) => step.name === "Create and verify commit tag manifest");
assert.ok(create);
assert.match(create.env.TAG, /needs\.authorize\.outputs\.tag/);
assert.match(create.run, /imagetools inspect "\$IMAGE:\$TAG" --raw/);
assert.match(create.run, /existing tag \$IMAGE:\$TAG is bound to a different manifest/);
assert.match(create.run, /manifest unknown\|no such manifest\|not found/);
assert.match(create.run, /imagetools create --tag "\$IMAGE:\$TAG"/);
assert.match(create.run, /imagetools inspect "\$IMAGE:\$TAG"/);
assert.match(create.run, /linux\/amd64/);
assert.match(create.run, /linux\/arm64/);
assert.doesNotMatch(text, /:latest\b|:next\b/);
assert.doesNotMatch(text, /workflow_dispatch/);
assert.match(source, /COMMIT_TAG = \/\^\[a-f0-9\]\{7\}\$\//);
assert.match(source, /VERSION_TAG\.test\(reference\.slice\(tagPrefix\.length\)\) \|\| COMMIT_TAG\.test/);
assert.match(tests, /09ca8f2/);
assert.match(tests, /09ca8f\"/);

console.log("commit verification image workflow policy passed");
