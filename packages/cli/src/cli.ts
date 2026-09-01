import { Command, CommanderError, Option } from "commander";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import qrTerminal from "qrcode-terminal";
import {
  WeChatClient,
  WeChatHttpError,
  type CursorPage,
  type Message,
  type SendParams,
} from "@kyan-du/agent-wechat-shared";
import { createSubscriptionClient, type SubscriptionClientOptions } from "./lib/client.js";
import { ensureDeviceIdentity } from "./device-identity.js";
import { buildCliSendParams } from "./send-options.js";
import { localBuildImage } from "./image-reference.js";
import {
  CONFIG_DIR,
  CONTAINER_NAME,
  DEFAULT_PORT,
  GHCR_IMAGE,
  INSTANCE_PATH,
  TOKEN_PATH,
  assertSafePurgePath,
  loadInventory,
  saveInventory,
  secureRegularFile,
} from "./instance-inventory.js";
import {
  clearContainerIdentity,
  dockerAvailable,
  inspectContainer,
  purgeInstance,
  removeOwnedVolume,
  replaceImage,
  startInstance,
  stopInstance,
  outboundFromContainer,
  waitHealthy,
} from "./lifecycle.js";
import { CliError, EXIT, failure, printJson, success } from "./exit-contract.js";
import { checkCliUpgrade, CliUpgradeError } from "./cli-upgrade.js";
import { resolveOutboundConfig, OUTBOUND_ENV_KEYS } from "./outbound-config.js";

declare const PKG_VERSION: string;
const VERSION = typeof PKG_VERSION === "undefined" ? "0.0.0-test" : PKG_VERSION;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function readToken(): string | undefined {
  try {
    secureRegularFile(TOKEN_PATH);
    const value = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("INVALID_AUTH_TOKEN");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof Error && error.message.startsWith("ENOENT:")) return undefined;
    throw error;
  }
}

function ensureToken(): string {
  const current = readToken();
  if (current) return current;
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  fs.writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600, flag: "wx" });
  return token;
}

function client(): WeChatClient {
  return new WeChatClient({
    baseUrl: process.env.AGENT_WECHAT_URL || `http://localhost:${DEFAULT_PORT}`,
    token: process.env.AGENT_WECHAT_TOKEN || readToken(),
  });
}

function subscriptionOptions(): SubscriptionClientOptions {
  return {
    url: process.env.AGENT_WECHAT_URL || `http://localhost:${DEFAULT_PORT}`,
    token: process.env.AGENT_WECHAT_TOKEN || readToken(),
  };
}

function isJson(): boolean { return program.opts().json === true; }
function output<T>(data: T, human: () => void): void { if (isJson()) printJson(success(data)); else human(); }

function mapHttpError(error: WeChatHttpError): CliError {
  if (error.status === 400) return new CliError(error.errorCode || "INVALID_ARGUMENT", "request arguments are invalid", EXIT.ARGUMENT);
  if (error.status === 401) return new CliError("AUTH_REQUIRED", "authentication is required", EXIT.AUTH);
  if (error.status === 429) return new CliError(error.errorCode || "RATE_LIMITED", "request is rate limited", EXIT.RATE_LIMITED, { retryAfter: error.retryAfter });
  if (error.status === 409) return new CliError(error.errorCode || "CONFIRMATION_REQUIRED", "operator confirmation is required", EXIT.CONFIRMATION);
  return new CliError(error.errorCode || "SERVICE_REQUEST_FAILED", `service request failed (${error.status})`, EXIT.SERVICE);
}

async function action<T>(fn: () => Promise<T> | T): Promise<void> {
  try { await fn(); }
  catch (raw) {
    const error = raw instanceof CliError ? raw : raw instanceof WeChatHttpError ? mapHttpError(raw) : new CliError("UNEXPECTED_ERROR", raw instanceof Error ? raw.message : String(raw), EXIT.SERVICE);
    if (isJson()) printJson(failure(error)); else console.error(`${error.code}: ${error.message}`);
    process.exitCode = error.exitCode;
  }
}

function integer(value: string, name: string, min: number, max: number): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new CliError("INVALID_ARGUMENT", `${name} must be an integer`, EXIT.ARGUMENT);
  const number = Number(value);
  if (number < min || number > max) throw new CliError("INVALID_ARGUMENT", `${name} must be between ${min} and ${max}`, EXIT.ARGUMENT);
  return number;
}

async function confirmDestructive(summary: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || isJson()) throw new CliError("CONFIRMATION_REQUIRED", `${summary}; rerun with --yes`, EXIT.CONFIRMATION);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${summary}\nType "purge" to continue: `);
    if (answer !== "purge") throw new CliError("CONFIRMATION_DECLINED", "destructive operation cancelled", EXIT.CONFIRMATION);
  } finally { rl.close(); }
}

async function login(timeoutMs: number, newAccount: boolean): Promise<void> {
  const { client: subClient, close } = createSubscriptionClient(subscriptionOptions());
  let subscription: { unsubscribe: () => void } | undefined;
  let terminal: "success" | "timeout" | "error" | undefined;
  const abort = () => { subscription?.unsubscribe(); close(); };
  process.once("SIGINT", abort);
  try {
    await new Promise<void>((resolve, reject) => {
      subscription = subClient.status.loginSubscription.subscribe({ timeoutMs, newAccount }, {
        onData: (event) => {
          if (event.type === "qr") {
            if (isJson()) console.error("QR code received; scan it with WeChat");
            else qrTerminal.generate(event.qrData, { small: true });
          } else if (event.type === "login_success") { terminal = "success"; resolve(); }
          else if (event.type === "login_timeout") { terminal = "timeout"; resolve(); }
          else if (event.type === "error") { terminal = "error"; reject(new CliError("LOGIN_FAILED", event.message, EXIT.AUTH)); }
          else if (!isJson() && "message" in event && event.message) console.error(event.message);
        },
        onError: (error) => reject(new CliError("LOGIN_CONNECTION_FAILED", error.message, EXIT.SERVICE)),
      });
    });
  } finally { process.removeListener("SIGINT", abort); subscription?.unsubscribe(); close(); }
  if (terminal === "timeout") throw new CliError("LOGIN_TIMEOUT", "login timed out", EXIT.AUTH);
  if (terminal !== "success") throw new CliError("LOGIN_CANCELLED", "login did not complete", EXIT.AUTH);
  output({ status: "logged_in" }, () => console.log("Login successful"));
}

function regularUpload(target: string): Buffer {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); } catch { throw new CliError("FILE_NOT_FOUND", `file not found: ${target}`, EXIT.ARGUMENT); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CliError("INVALID_UPLOAD_FILE", "upload must be a regular non-symlink file", EXIT.ARGUMENT);
  if (stat.size > MAX_UPLOAD_BYTES) throw new CliError("UPLOAD_TOO_LARGE", `upload exceeds ${MAX_UPLOAD_BYTES} bytes`, EXIT.ARGUMENT);
  return fs.readFileSync(target);
}

function renderMessages(page: CursorPage<Message>): void {
  for (const item of [...page.items].reverse()) console.log(`${item.localId}\t${item.timestamp}\t${item.senderName || item.sender || ""}\t${item.content}`);
  if (page.nextCursor) console.error(`next cursor: ${page.nextCursor}`);
}

async function resetAuth(yes: boolean): Promise<void> {
  const inventory = loadInventory();
  if (!inventory) throw new CliError("INSTANCE_INVENTORY_MISSING", "auth reset requires a trusted running instance", EXIT.CLEANUP);
  await confirmDestructive("Reset WeChat login/session/cache and device identity for the default instance", yes);
  const result = await client().resetAuth();
  if (!result.success) throw new CliError(result.errorCode || "AUTH_RESET_FAILED", result.error || "auth reset failed", EXIT.CLEANUP);
  clearContainerIdentity(inventory);
  stopInstance();
  try {
    removeOwnedVolume(inventory, 1, "wechat-home");
  } catch (error) {
    if (error instanceof CliError && error.code === "VOLUME_DRIVER_UNSUPPORTED") throw error;
    throw new CliError("AUTH_RESET_CLEANUP_INCOMPLETE", `remaining resource: volume:${inventory.volumes[1]}`, EXIT.CLEANUP);
  }
  const remaining: string[] = [];
  for (const file of ["device-identity.env", "device-identity.json"]) {
    const target = path.join(CONFIG_DIR, file);
    try { assertSafePurgePath(target, CONFIG_DIR); fs.unlinkSync(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") remaining.push(file);
    }
  }
  if (remaining.length) throw new CliError("AUTH_RESET_CLEANUP_INCOMPLETE", `remaining resources: ${remaining.join(", ")}`, EXIT.CLEANUP);
  saveInventory({ ...inventory, containerId: undefined, updatedAt: new Date().toISOString() });
  output({ reset: true, restartRequired: true }, () => console.log("WeChat authentication data reset. Run wx start to create a fresh identity."));
}

function programStatus(): Record<string, unknown> {
  const inventory = loadInventory();
  if (!dockerAvailable()) throw new CliError("DOCKER_UNAVAILABLE", "Docker daemon is unavailable", EXIT.ENVIRONMENT, { diagnostics: { docker: "unavailable", inventory: inventory ? "trusted" : "absent" } });
  const container = inspectContainer();
  if (container) {
    if (!inventory) throw new CliError("INSTANCE_INVENTORY_MISSING", "existing container has no trusted inventory", EXIT.ENVIRONMENT);
  }
  return {
    cliVersion: VERSION,
    docker: "available",
    container: container ? (container.State?.Running ? "running" : "stopped") : "absent",
    imageDigest: inventory?.imageDigest,
    inventory: inventory ? "trusted" : "absent",
  };
}

async function syncServer(binary: string, sha256: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new CliError("INVALID_SHA256", "--sha256 must be 64 lowercase hex", EXIT.ARGUMENT);
  const bytes = regularUpload(binary);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new CliError("CHECKSUM_MISMATCH", "developer server checksum mismatch", EXIT.ARGUMENT);
  const info = inspectContainer();
  const inventory = loadInventory();
  if (!info || !inventory || info.Id !== inventory.containerId) throw new CliError("INSTANCE_NOT_RUNNING", "trusted instance is not running", EXIT.SERVICE);
  const remote = `/tmp/agent-server-${process.pid}`;
  execFileSync("docker", ["cp", binary, `${info.Id}:${remote}`], { stdio: "inherit" });
  try {
    execFileSync("docker", ["exec", info.Id, "sh", "-c", `cp /opt/agent-server/agent-server /tmp/agent-server.rollback && chmod 755 ${remote} && mv ${remote} /opt/agent-server/agent-server && pkill -f '^/opt/agent-server/agent-server$'`], { stdio: "inherit" });
    await waitHealthy();
  } catch {
    execFileSync("docker", ["exec", info.Id, "sh", "-c", "test -f /tmp/agent-server.rollback && mv /tmp/agent-server.rollback /opt/agent-server/agent-server && pkill -f '^/opt/agent-server/agent-server$' || true"], { stdio: "ignore" });
    throw new CliError("DEV_SYNC_ROLLBACK", "developer server sync failed and original binary was restored", EXIT.ROLLBACK);
  }
  output({ synced: true, sha256 }, () => console.log("Developer server synchronized"));
}

const program = new Command();
program.name("wx").description("Single-instance agent-wechat CLI").version(VERSION).option("-j, --json", "emit one versioned JSON value on stdout");
program.showSuggestionAfterError();
program.configureOutput({ outputError: (text) => process.stderr.write(text) });
program.exitOverride();

program.command("start")
  .description("Start the compatible single-instance container")
  .option("--image <reference>", `exact ${GHCR_IMAGE} semver/commit tag or digest`)
  .option("--pull", "pull and resolve the selected image")
  .option("--offline", "offline mode; never pull")
  .option("--proxy <url>", "transparent proxy URL")
  .option("--outbound-config <file>", "TOML outbound policy file (never logged)")
  .option("--outbound-queue-capacity <count>", "outbound queue capacity")
  .option("--outbound-disabled", "disable outbound sending")
  .option("--outbound-quiet-start <minutes>", "quiet-hours start minute")
  .option("--outbound-quiet-end <minutes>", "quiet-hours end minute")
  .option("--outbound-hourly-budget <count>", "hourly outbound budget")
  .option("--outbound-daily-budget <count>", "daily outbound budget")
  .option("--outbound-chat-cooldown-ms <ms>", "per-chat cooldown")
  .option("--outbound-min-spacing-ms <ms>", "minimum spacing")
  .option("--outbound-jitter-ms <ms>", "spacing jitter")
  .option("--outbound-long-tail-jitter-ms <ms>", "long-tail jitter")
  .option("--outbound-long-tail-chance-percent <percent>", "long-tail chance")
  .option("--outbound-task-ttl-ms <ms>", "task TTL")
  .option("--outbound-idempotency-ttl-ms <ms>", "idempotency TTL")
  .option("--outbound-idempotency-max-rows <rows>", "idempotency max rows")
  .action((options) => action(async () => {
    if (options.pull && options.offline) throw new CliError("ARGUMENT_CONFLICT", "--pull and --offline are mutually exclusive", EXIT.ARGUMENT);
    const inventory = await startInstance({ identity: ensureDeviceIdentity(CONFIG_DIR), token: ensureToken(), localDefault: localBuildImage(), noPull: options.offline === true, outbound: resolveOutboundConfig(options.outboundConfig, Object.fromEntries([["AGENT_WECHAT_OUTBOUND_QUEUE_CAPACITY", options.outboundQueueCapacity], ["AGENT_WECHAT_OUTBOUND_DISABLED", options.outboundDisabled ? "true" : undefined], ["AGENT_WECHAT_QUIET_START_MIN", options.outboundQuietStart], ["AGENT_WECHAT_QUIET_END_MIN", options.outboundQuietEnd], ["AGENT_WECHAT_HOURLY_BUDGET", options.outboundHourlyBudget], ["AGENT_WECHAT_DAILY_BUDGET", options.outboundDailyBudget], ["AGENT_WECHAT_CHAT_COOLDOWN_MS", options.outboundChatCooldownMs], ["AGENT_WECHAT_OUTBOUND_MIN_SPACING_MS", options.outboundMinSpacingMs], ["AGENT_WECHAT_OUTBOUND_JITTER_MS", options.outboundJitterMs], ["AGENT_WECHAT_OUTBOUND_LONG_TAIL_JITTER_MS", options.outboundLongTailJitterMs], ["AGENT_WECHAT_OUTBOUND_LONG_TAIL_CHANCE_PERCENT", options.outboundLongTailChancePercent], ["AGENT_WECHAT_OUTBOUND_TASK_TTL_MS", options.outboundTaskTtlMs], ["AGENT_WECHAT_OUTBOUND_IDEMPOTENCY_TTL_MS", options.outboundIdempotencyTtlMs], ["AGENT_WECHAT_OUTBOUND_IDEMPOTENCY_MAX_ROWS", options.outboundIdempotencyMaxRows]].filter(([, v]) => v !== undefined))), ...options });
    output({ container: inventory.containerName, imageDigest: inventory.imageDigest, port: inventory.port }, () => console.log(`Started ${inventory.containerName} on port ${inventory.port}`));
  }));

program.command("stop")
  .description("Stop and remove the container; preserve data unless --purge")
  .option("--purge", "delete every resource in the trusted default-instance inventory")
  .option("--yes", "skip only the interactive confirmation")
  .action((options) => action(async () => {
    if (options.purge) {
      const inventory = loadInventory();
      if (!inventory) throw new CliError("INSTANCE_INVENTORY_MISSING", "no trusted instance inventory", EXIT.CLEANUP);
      await confirmDestructive(`Purge default instance: ${inventory.containerName}; volumes ${inventory.volumes.join(", ")}; config ${INSTANCE_PATH}`, options.yes === true);
      const result = purgeInstance();
      output(result, () => console.log(`Purged ${result.removed.length} resources`));
    } else {
      const result = stopInstance();
      output(result, () => console.log(result.stopped ? "Container stopped and removed" : "Container is absent"));
    }
  }));

program.command("restart").description("Restart while preserving data")
  .option("--outbound-config <file>", "TOML outbound policy file (never logged)")
  .option("--outbound-queue-capacity <count>", "outbound queue capacity")
  .option("--outbound-disabled", "disable outbound sending")
  .action((options) => action(async () => {
  const inventory = loadInventory();
  if (!inventory) throw new CliError("INSTANCE_INVENTORY_MISSING", "start the instance first", EXIT.SERVICE);
  const oldContainer = inspectContainer();
  const cliOverrides = Object.fromEntries([["AGENT_WECHAT_OUTBOUND_QUEUE_CAPACITY", options.outboundQueueCapacity], ["AGENT_WECHAT_OUTBOUND_DISABLED", options.outboundDisabled ? "true" : undefined]].filter(([, v]) => v !== undefined));
  const outbound = resolveOutboundConfig(options.outboundConfig, cliOverrides);
  const oldOutbound = oldContainer ? outboundFromContainer(oldContainer) : {};
  stopInstance();
  try {
    const result = await startInstance({ identity: ensureDeviceIdentity(CONFIG_DIR), token: ensureToken(), image: inventory.imageDigest || inventory.imageRef, noPull: true, localDefault: localBuildImage(), outbound: Object.keys(outbound).length ? outbound : oldOutbound });
    output({ restarted: true, imageDigest: result.imageDigest }, () => console.log("Instance restarted"));
  } catch (error) { throw error; }
}));

program.command("status").description("Show read-only lifecycle and authentication status").action(() => action(async () => {
  const status: Record<string, unknown> = programStatus();
  if (status.container === "running") {
    let server: Awaited<ReturnType<WeChatClient["status"]>>;
    try { server = await client().status(); }
    catch { throw new CliError("SERVER_UNREACHABLE", "agent-wechat server is unreachable", EXIT.SERVICE, { diagnostics: status }); }
    status.serverVersion = server.version;
    status.apiVersion = server.apiVersion;
    status.compatible = server.apiVersion === 1;
    if (!status.compatible) throw new CliError("IMAGE_API_INCOMPATIBLE", "server API version is incompatible", EXIT.SERVICE, { diagnostics: status });
    try { status.auth = await client().authStatus(); }
    catch { throw new CliError("AUTH_PROBE_FAILED", "authentication status probe failed", EXIT.SERVICE, { diagnostics: status }); }
  }
  output(status, () => Object.entries(status).forEach(([key, value]) => console.log(`${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`)));
}));

program.command("doctor").description("Run read-only environment and compatibility diagnostics").action(() => action(async () => {
  const checks: Record<string, unknown> = programStatus();
  checks.architecture = os.arch();
  checks.token = readToken() ? "present" : "absent";
  checks.configPermissions = fs.existsSync(CONFIG_DIR) ? (fs.statSync(CONFIG_DIR).mode & 0o777).toString(8) : "absent";
  if (checks.container === "running") {
    try { checks.health = (await fetch(`http://localhost:${DEFAULT_PORT}/health`)).ok ? "ok" : "failed"; }
    catch { checks.health = "unreachable"; }
    if (checks.health !== "ok") throw new CliError("HEALTH_CHECK_FAILED", "service health check failed", EXIT.SERVICE, { diagnostics: checks });
    let server: Awaited<ReturnType<WeChatClient["status"]>>;
    try { server = await client().status(); }
    catch { throw new CliError("SERVER_UNREACHABLE", "agent-wechat server is unreachable", EXIT.SERVICE, { diagnostics: checks }); }
    checks.apiVersion = server.apiVersion;
    if (server.apiVersion !== 1) throw new CliError("IMAGE_API_INCOMPATIBLE", "server API version is incompatible", EXIT.SERVICE, { diagnostics: checks });
    try { checks.auth = await client().authStatus(); }
    catch { throw new CliError("AUTH_PROBE_FAILED", "authentication status probe failed", EXIT.SERVICE, { diagnostics: checks }); }
  }
  output(checks, () => Object.entries(checks).forEach(([key, value]) => console.log(`${key}: ${value}`)));
}));

program.command("logs").description("Follow trusted instance logs").action(() => action(() => {
  const info = inspectContainer(); const inventory = loadInventory();
  if (!info || !inventory || info.Id !== inventory.containerId) throw new CliError("INSTANCE_NOT_RUNNING", "trusted instance is not running", EXIT.SERVICE);
  spawn("docker", ["logs", "-f", info.Id], { stdio: "inherit" });
}));

const auth = program.command("auth").description("WeChat authentication");
auth.command("login").option("--timeout <seconds>", "login timeout", "300").option("--new", "request a new-account login flow").action((options) => action(() => login(integer(options.timeout, "timeout", 1, 1800) * 1000, options.new === true)));
auth.command("logout").action(() => action(async () => {
  const result = await client().logout();
  if (!result.success) throw new CliError("LOGOUT_FAILED", result.error || "logout failed", EXIT.AUTH);
  output(result, () => console.log("Logged out"));
}));
auth.command("reset").option("--yes", "skip only the interactive confirmation").action((options) => action(() => resetAuth(options.yes === true)));
auth.command("status").action(() => action(async () => { const result = await client().authStatus(); output(result, () => console.log(result.status)); }));

const chats = program.command("chats").description("List chats without changing unread state").option("--unread", "only chats with unreadCount > 0").option("--limit <number>", "page size", "50").option("--cursor <cursor>", "opaque next-page cursor").action((options) => action(async () => {
  const page = await client().listChatsPage(integer(options.limit, "limit", 1, 100), options.cursor, options.unread === true);
  output(page, () => { for (const chat of page.items) console.log(`${chat.username || chat.id}\t${chat.unreadCount}\t${chat.name}`); if (page.nextCursor) console.error(`next cursor: ${page.nextCursor}`); });
}));
chats.command("show <chat-id>").action((chatId) => action(async () => { const result = await client().getChat(chatId); if (!result) throw new CliError("TARGET_NOT_FOUND", "chat was not found", EXIT.TARGET); output(result, () => console.log(JSON.stringify(result, null, 2))); }));
chats.command("mark-read <chat-id>").action((chatId) => action(async () => { const result = await client().markChatRead(chatId); if (!result.ok) throw new CliError(result.errorCode || "MARK_READ_FAILED", result.error || "mark-read was not verified", EXIT.SERVICE); output(result, () => console.log(`${chatId}: ${result.beforeUnread} -> ${result.afterUnread}`)); }));
chats.command("members <group-id>").description("List a bounded page of group members read-only").option("--limit <number>", "page size", "50").option("--cursor <cursor>", "opaque next-page cursor").action((groupId, options) => action(async () => {
  const page = await client().listGroupMembersPage(groupId, integer(options.limit, "limit", 1, 100), options.cursor);
  output(page, () => { for (const member of page.items) console.log(`${member.memberId}\t${member.displayName}\t${member.groupAlias ?? ""}`); if (page.nextCursor) console.error(`next cursor: ${page.nextCursor}`); });
}));

const contacts = program.command("contacts").description("List contacts read-only").option("--limit <number>", "page size", "200").option("--cursor <cursor>", "opaque next-page cursor").action((options) => action(async () => {
  const page = await client().listContactsPage(integer(options.limit, "limit", 1, 200), options.cursor);
  output(page, () => { for (const contact of page.items) console.log(`${contact.username}\t${contact.remark || contact.nickName}`); if (page.nextCursor) console.error(`next cursor: ${page.nextCursor}`); });
}));
contacts.command("find <name>").action((name) => action(async () => { const result = await client().findContacts(name); output(result, () => result.forEach((item) => console.log(`${item.username}\t${item.remark || item.nickName}`))); }));

program.command("messages <chat-id>").description("Read messages without opening the chat or changing unread state").option("--limit <number>", "page size", "50").option("--cursor <cursor>", "opaque next-page cursor").action((chatId, options) => action(async () => {
  const page = await client().listMessagesPage(chatId, integer(options.limit, "limit", 1, 200), options.cursor);
  output(page, () => renderMessages(page));
}));

program.command("send <chat-id>").description("Send exactly one payload to a stable chat ID")
  .option("--text <message>").option("--image <path>").option("--file <path>")
  .option("--idempotency-key <key>", "stable key for retry/reconciliation")
  .option("--confirm-similar", "confirm operator-reviewed similar text")
  .action((chatId, options) => action(async () => {
    const image: SendParams["image"] | undefined = options.image ? { data: regularUpload(options.image).toString("base64"), mimeType: path.extname(options.image).toLowerCase() === ".jpg" ? "image/jpeg" : "image/png" } : undefined;
    const file: SendParams["file"] | undefined = options.file ? { data: regularUpload(options.file).toString("base64"), filename: path.basename(options.file) } : undefined;
    let params: SendParams;
    try {
      params = buildCliSendParams({ chatId, text: options.text, image, file, confirmSimilar: options.confirmSimilar, idempotencyKey: options.idempotencyKey });
    } catch (error) {
      throw new CliError("INVALID_ARGUMENT", error instanceof Error ? error.message : String(error), EXIT.ARGUMENT);
    }
    const result = await client().sendMessage(params);
    if (!result.success) {
      const uncertain = result.commitAttempted === true;
      throw new CliError(result.errorCode || (uncertain ? "SEND_UNCERTAIN" : "SEND_FAILED"), result.error || "send failed", uncertain ? EXIT.UNCERTAIN : result.errorCode === "SIMILAR_CONTENT_CONFIRMATION_REQUIRED" ? EXIT.CONFIRMATION : EXIT.SERVICE, { commitAttempted: result.commitAttempted });
    }
    output(result, () => console.log("Message sent"));
  }));

program.command("upgrade").description("Check CLI/image upgrades without claiming atomic self-upgrade")
  .addOption(new Option("--check", "read-only upgrade check"))
  .addOption(new Option("--cli", "print an exact npm CLI upgrade command"))
  .addOption(new Option("--image <reference>", "transactionally rebuild with an exact semver/commit tag or digest"))
  .action((options) => action(async () => {
    const selected = [options.check === true, options.cli === true, typeof options.image === "string"].filter(Boolean).length;
    if (selected > 1) throw new CliError("ARGUMENT_CONFLICT", "--check, --cli, and --image are mutually exclusive", EXIT.ARGUMENT);
    if (options.cli) {
      let result;
      try { result = checkCliUpgrade(VERSION); }
      catch (error) {
        if (error instanceof CliUpgradeError) {
          throw new CliError(error.code, error.message, error.code === "CLI_UPGRADE_REGISTRY_ERROR" ? EXIT.SERVICE : EXIT.ENVIRONMENT);
        }
        throw error;
      }
      return output(result, () => {
        if (result.command) console.log(result.command);
        else console.log(`CLI is already up to date (${result.currentVersion})`);
      });
    }
    if (options.image) {
      const result = await replaceImage({ image: options.image, identity: ensureDeviceIdentity(CONFIG_DIR), token: ensureToken() });
      return output({ upgraded: true, imageDigest: result.imageDigest }, () => console.log(`Image upgraded to ${result.imageDigest}`));
    }
    const result = { cliVersion: VERSION, currentImageDigest: loadInventory()?.imageDigest, mutation: false };
    return output(result, () => console.log(JSON.stringify(result, null, 2)));
  }));

const dev = program.command("dev", { hidden: true });
dev.command("sync-server").requiredOption("--binary <path>").requiredOption("--sha256 <hex>").action((options) => action(() => syncServer(options.binary, options.sha256)));

for (const [oldName, replacement] of [["up", "start"], ["down", "stop"], ["update", "dev sync-server"], ["session", "single-instance prerelease"]] as const) {
  program.command(oldName, { hidden: true }).allowUnknownOption().allowExcessArguments().action(() => action(() => { throw new CliError("LEGACY_COMMAND_REMOVED", `${oldName} was removed; use wx ${replacement}`, EXIT.ARGUMENT); }));
}

function sameEntrypoint(left: string, right: string): boolean {
  try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return path.resolve(left) === path.resolve(right); }
}

if (process.argv[1] && sameEntrypoint(process.argv[1], fileURLToPath(import.meta.url))) {
  program.parseAsync(process.argv).catch((error) => {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return;
      process.exitCode = EXIT.ARGUMENT;
      return;
    }
    console.error(error);
    process.exitCode = EXIT.SERVICE;
  });
}
