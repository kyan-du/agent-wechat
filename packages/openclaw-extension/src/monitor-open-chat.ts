/** Never report an HTTP-successful response as a verified conversation switch. */
export function requireVerifiedChatOpen(
  result: { ok?: boolean; verified?: boolean; username?: string; errorCode?: string } | null | undefined,
  chatId: string,
): void {
  if (result?.ok !== true || result.verified !== true || result.username !== chatId) {
    const code = result?.errorCode ?? "TARGET_CONFIRMATION_FAILED";
    throw new Error(`Chat open not confirmed: ${code}`);
  }
}
