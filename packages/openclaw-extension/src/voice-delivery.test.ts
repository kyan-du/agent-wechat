import test from "node:test";
import assert from "node:assert/strict";
import { sendVoiceNote, waitForVoiceJob, type VoiceJobClient } from "./voice-delivery.ts";

const job = (status: string, chunks: Array<{ status: string }> = []) => ({ jobId: "j1", status, chunks }) as any;

test("voice: waits until the job completes", async () => {
  const states = [job("queued"), job("running"), job("completed", [{ status: "verified" }])];
  const client: VoiceJobClient = { createVoiceJob: async () => job("queued"), getVoiceJob: async () => states.shift()! };
  assert.equal((await waitForVoiceJob(client, "j1", { pollMs: 1 })).status, "completed");
});

test("voice: reports partial progress on failure without resending", async () => {
  const client: VoiceJobClient = {
    createVoiceJob: async () => job("queued"),
    getVoiceJob: async () => job("needs_review", [{ status: "verified" }, { status: "pending" }]),
  };
  await assert.rejects(waitForVoiceJob(client, "j1", { pollMs: 1 }), /1\/2 notes verified.*Do not resend/);
});

test("voice: rejects non-audio media before creating a job", async () => {
  let created = false;
  const client: VoiceJobClient = { createVoiceJob: async () => { created = true; return job("queued"); }, getVoiceJob: async () => job("completed") };
  await assert.rejects(sendVoiceNote(client, "c", new Uint8Array(1), "image/png"), /must be audio/);
  assert.equal(created, false);
});

test("voice: passes the idempotency key and returns the job id", async () => {
  let key = "";
  const client: VoiceJobClient = { createVoiceJob: async (_c, _a, k) => { key = k; return job("queued"); }, getVoiceJob: async () => job("completed") };
  assert.equal(await sendVoiceNote(client, "c", new Uint8Array(1), "audio/ogg", "k1", async () => job("completed")), "j1");
  assert.equal(key, "k1");
});
