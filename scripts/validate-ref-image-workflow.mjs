#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const path = ".github/workflows/docker-build-ref.yml";
const text = readFileSync(path, "utf8");
const workflow = parse(text);
const trigger = workflow.on ?? workflow.true;

assert.equal(workflow.name, "Build Docker Image from Ref");
assert.ok(trigger.workflow_dispatch, "workflow_dispatch is required");
assert.deepEqual(Object.keys(trigger.workflow_dispatch.inputs), ["ref"]);
assert.equal(workflow.permissions.contents, "read");
assert.equal(workflow.permissions.packages, "write");
assert.deepEqual(Object.keys(workflow.jobs), ["authorize", "build", "publish"]);
assert.match(text, /tag="ref-\$\{sha:0:7\}"/);
assert.match(text, /git rev-parse HEAD \| cut -c1-7/);
assert.doesNotMatch(text, /manual-|:latest\b|:next\b/);
assert.match(text, /push-by-digest=true,name-canonical=true,push=true/);
assert.match(text, /linux\/amd64/);
assert.match(text, /linux\/arm64/);
assert.match(text, /GITHUB_STEP_SUMMARY/);
assert.match(text, /existing tag \$IMAGE:\$TAG is bound to a different manifest/);

console.log("ref image workflow contract passed");
