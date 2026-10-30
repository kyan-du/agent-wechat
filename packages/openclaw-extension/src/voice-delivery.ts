import { randomUUID } from "node:crypto";
import type { VoiceJob } from "@kyan-du/agent-wechat-shared";

export type VoiceJobClient = {
  createVoiceJob(chatId: string, audio: Uint8Array, idempotencyKey: string): Promise<VoiceJob>;
  getVoiceJob(jobId: string): Promise<VoiceJob>;
};

const TERMINAL = new Set(["completed", "failed", "cancelled", "needs_review"]);

export const AUDIO_EXT_MIME: Record<string, string> = {
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg",
  m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac",
};

export async function waitForVoiceJob(
  client: VoiceJobClient,
  jobId: string,
  opts: { timeoutMs?: number; pollMs?: number; statusGraceMs?: number; now?: () => number } = {},
): Promise<VoiceJob> {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 1000;
  const deadline = now() + (opts.timeoutMs ?? 25 * 60_000);
  const grace = opts.statusGraceMs ?? 30_000;
  let lastStatusAt = now();
  while (now() < deadline) {
    let job: VoiceJob;
    try {
      job = await client.getVoiceJob(jobId);
      lastStatusAt = now();
    } catch (error) {
      if (now() - lastStatusAt > grace) {
        throw new Error(`Voice job ${jobId} status is unavailable: ${String(error)}. Inspect the job before retrying.`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    if (TERMINAL.has(job.status)) {
      if (job.status === "completed") return job;
      const sent = job.chunks.filter((c) => c.status === "verified").length;
      throw new Error(
        `Voice job ${jobId} ${job.status}: ${sent}/${job.chunks.length} notes verified. ${job.error ?? ""} Do not resend the whole recording.`.trim(),
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Voice job ${jobId} exceeded the wait. Inspect the job before retrying.`);
}

export async function sendVoiceNote(
  client: VoiceJobClient,
  chatId: string,
  audio: Uint8Array,
  mimeType: string,
  idempotencyKey: string = randomUUID(),
  wait: typeof waitForVoiceJob = waitForVoiceJob,
): Promise<string> {
  if (!mimeType.startsWith("audio/")) throw new Error(`Voice media must be audio, got ${mimeType}`);
  const job = await client.createVoiceJob(chatId, audio, idempotencyKey);
  await wait(client, job.jobId);
  return job.jobId;
}
