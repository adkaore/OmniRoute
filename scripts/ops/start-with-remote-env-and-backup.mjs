import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const repoUrl = process.env.DB_BACKUP_REPO || "git@github.com:adkaore/omniroute-db-sql.git";
const branch = process.env.DB_BACKUP_BRANCH || "main";
const envPath = process.env.REMOTE_ENV_PATH || ".env";
const backupFileName = process.env.DB_BACKUP_FILE_NAME || "omniroute.sql";
const intervalMs = Math.max(
  5 * 60 * 1000,
  Number.parseInt(process.env.DB_BACKUP_INTERVAL_MS || String(20 * 60 * 1000), 10)
);
const initialDelayMs = Math.max(
  0,
  Number.parseInt(process.env.DB_BACKUP_INITIAL_DELAY_MS || String(2 * 60 * 1000), 10)
);
const shutdownTimeoutMs = Number.parseInt(
  process.env.DB_BACKUP_SHUTDOWN_TIMEOUT_MS || "15000",
  10
);

function log(message) {
  console.log(`[startup] ${message}`);
}

function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      stdio: options.stdio || "pipe",
      env: options.env || process.env,
      cwd: options.cwd || process.cwd(),
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
    child.on("error", (error) => resolveRun({ code: 1, stdout, stderr: String(error) }));
  });
}

function parseEnv(content) {
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function prepareSshKey(workDir, { required = false } = {}) {
  const keyB64 = process.env.GITHUB_DEPLOY_KEY_B64;
  const rawKey = process.env.GITHUB_DEPLOY_KEY;
  if (!keyB64 && !rawKey) {
    if (required) throw new Error("GITHUB_DEPLOY_KEY_B64 is not configured");
    return null;
  }

  const sshDir = join(workDir, ".ssh");
  mkdirSync(sshDir, { recursive: true });
  const keyPath = join(sshDir, "id_ed25519");
  const keyContent = keyB64 ? Buffer.from(keyB64, "base64").toString("utf8") : rawKey;
  writeFileSync(keyPath, keyContent, { mode: 0o600 });
  writeFileSync(
    join(sshDir, "config"),
    [
      "Host github.com",
      "  HostName github.com",
      "  User git",
      `  IdentityFile ${keyPath.replace(/\\/g, "/")}`,
      "  StrictHostKeyChecking accept-new",
      "",
    ].join("\n"),
    { mode: 0o600 }
  );

  return {
    ...process.env,
    GIT_SSH_COMMAND: `ssh -F ${join(sshDir, "config").replace(/\\/g, "/")}`,
  };
}

async function cloneBackupRepo(workDir, { requireSshKey = false } = {}) {
  const env = prepareSshKey(workDir, { required: requireSshKey }) || process.env;
  const cloneDir = join(workDir, "repo");
  let clone = await run("git", ["clone", "--depth", "1", "--branch", branch, repoUrl, cloneDir], {
    env,
  });
  if (
    clone.code !== 0 &&
    /Remote branch .* not found|not found in upstream origin/i.test(clone.stderr)
  ) {
    clone = await run("git", ["clone", "--depth", "1", repoUrl, cloneDir], { env });
    if (clone.code === 0) {
      await run("git", ["checkout", "-B", branch], { cwd: cloneDir, env });
    }
  }
  if (clone.code !== 0) {
    throw new Error(clone.stderr.trim() || clone.stdout.trim());
  }
  return { cloneDir, env };
}

function resolveDataDir() {
  if (process.env.DATA_DIR?.trim()) return process.env.DATA_DIR.trim();
  return join(homedir(), ".omniroute");
}

function getRuntimeDbPath() {
  if (process.env.DB_BACKUP_SOURCE?.trim()) return process.env.DB_BACKUP_SOURCE.trim();
  return join(resolveDataDir(), "storage.sqlite");
}

function ensureSqlite3Available() {
  const check = spawnSync("sqlite3", ["-version"], { stdio: "pipe" });
  return !check.error && check.status === 0;
}

function isValidSqliteFile(filePath) {
  if (!existsSync(filePath)) return false;
  const stat = statSync(filePath);
  if (stat.size < 16) return false;
  const fd = openSync(filePath, "r");
  try {
    const header = Buffer.alloc(16);
    readSync(fd, header, 0, 16, 0);
    return header.toString("utf8") === "SQLite format 3\0";
  } finally {
    closeSync(fd);
  }
}

async function loadRemoteEnvFromRepo(cloneDir) {
  const remoteEnvFile = join(cloneDir, envPath);
  if (!existsSync(remoteEnvFile)) {
    log(`remote env not found at ${envPath}`);
    return;
  }

  const parsed = parseEnv(readFileSync(remoteEnvFile, "utf8"));
  let loaded = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "GITHUB_DEPLOY_KEY" || key === "GITHUB_DEPLOY_KEY_B64") continue;
    if (process.env[key] !== undefined && process.env[key] !== "") continue;
    process.env[key] = value;
    loaded++;
  }
  log(`loaded ${loaded} missing env var(s) from ${repoUrl}:${envPath}`);
}

async function restoreDatabaseFromRepo(cloneDir, env) {
  if (process.env.DB_RESTORE_ON_START === "0") {
    log("database restore disabled");
    return;
  }

  const source = join(cloneDir, backupFileName);
  if (!existsSync(source)) {
    log(`database restore skipped: ${backupFileName} not found in backup repo`);
    return;
  }

  if (!backupFileName.endsWith(".sql")) {
    log(
      `database restore skipped: unsupported backup file type for ${backupFileName} (expected .sql)`
    );
    return;
  }

  const sourceStat = statSync(source);
  if (sourceStat.size === 0) {
    log(`database restore skipped: ${backupFileName} is empty`);
    return;
  }
  const sourceText = readFileSync(source, "utf8");
  if (!sourceText.includes("CREATE TABLE")) {
    log(
      `database restore skipped: ${backupFileName} does not look like a valid SQL dump (no CREATE TABLE found)`
    );
    return;
  }

  if (!ensureSqlite3Available()) {
    log("database restore skipped: sqlite3 CLI not found on PATH");
    return;
  }

  const target = getRuntimeDbPath();
  mkdirSync(dirname(target), { recursive: true });
  const tempTarget = `${target}.restoring-${process.pid}`;
  rmSync(tempTarget, { force: true });

  log(`restoring database from SQL dump: ${backupFileName}`);

  const inFd = openSync(source, "r");
  let restoreResult;
  try {
    restoreResult = spawnSync("sqlite3", [tempTarget], { env, stdio: [inFd, "ignore", "pipe"] });
  } finally {
    closeSync(inFd);
  }

  if (restoreResult.error) {
    log(`database restore failed: ${restoreResult.error.message}`);
    rmSync(tempTarget, { force: true });
    return;
  }
  if (restoreResult.status !== 0) {
    const stderr = restoreResult.stderr ? restoreResult.stderr.toString().trim() : "unknown error";
    log(`database restore failed: sqlite3 exited with code ${restoreResult.status}: ${stderr}`);
    rmSync(tempTarget, { force: true });
    return;
  }

  if (!isValidSqliteFile(tempTarget)) {
    log(
      "database restore failed: restored file does not look like a valid SQLite database; keeping existing database untouched"
    );
    rmSync(tempTarget, { force: true });
    return;
  }

  renameSync(tempTarget, target);
  process.env.DB_BACKUP_SOURCE = target;
  log(`database restored from ${backupFileName} to ${target}`);
}

async function loadRemoteEnvAndRestoreDatabase() {
  if (process.env.REMOTE_ENV_DISABLED === "1" && process.env.DB_RESTORE_ON_START === "0") {
    log("remote env and database restore disabled");
    return;
  }

  const workDir = join(tmpdir(), `omniroute-startup-${process.pid}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  try {
    const { cloneDir, env } = await cloneBackupRepo(workDir, { requireSshKey: true });
    if (process.env.REMOTE_ENV_DISABLED !== "1") await loadRemoteEnvFromRepo(cloneDir);
    await restoreDatabaseFromRepo(cloneDir, env);
  } catch (error) {
    log(`remote startup sync skipped: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function cleanupQuotaSnapshots() {
  const dbPath = getRuntimeDbPath();
  if (!existsSync(dbPath)) {
    return;
  }

  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (error) {
    return;
  }

  try {
    const db = new Database(dbPath);
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.pragma("cache_size = -16384");
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quota_snapshots'")
        .get();
      if (table) {
        const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
        const deleted = db.prepare("DELETE FROM quota_snapshots WHERE created_at < ?").run(cutoff);
        if (deleted.changes > 0) {
          log(`quota_snapshots cleanup removed ${deleted.changes} row(s) older than 8 days`);
        }
      }
      db.pragma("optimize");
    } finally {
      db.close();
    }
  } catch (error) {
    log(`database cleanup skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function dumpDatabaseToSql(source, target) {
  const outFd = openSync(target, "w");
  let dumpResult;
  try {
    dumpResult = spawnSync("sqlite3", [source, ".dump"], {
      stdio: ["ignore", outFd, "pipe"],
    });
  } finally {
    closeSync(outFd);
  }

  if (dumpResult.error) {
    throw new Error(`failed to spawn sqlite3: ${dumpResult.error.message}`);
  }
  if (dumpResult.status !== 0) {
    const stderr = dumpResult.stderr ? dumpResult.stderr.toString().trim() : "unknown error";
    throw new Error(`sqlite3 .dump exited with code ${dumpResult.status}: ${stderr}`);
  }

  const dumpStat = statSync(target);
  if (dumpStat.size === 0) {
    throw new Error("sqlite3 .dump produced an empty file; refusing to back up");
  }

  const dumpText = readFileSync(target, "utf8");
  if (!dumpText.includes("CREATE TABLE")) {
    throw new Error(
      "sqlite3 .dump output does not contain any CREATE TABLE statements; refusing to back up a suspicious dump"
    );
  }
}

async function backupDatabaseOnce() {
  const source = getRuntimeDbPath();
  if (!existsSync(source)) {
    return;
  }

  if (!ensureSqlite3Available()) {
    log("sqlite3 CLI not found on PATH; skipping backup");
    return;
  }

  const keyB64 = process.env.GITHUB_DEPLOY_KEY_B64;
  const rawKey = process.env.GITHUB_DEPLOY_KEY;
  if (!keyB64 && !rawKey) {
    return;
  }

  const workDir = join(tmpdir(), `omniroute-db-backup-${process.pid}-${Date.now()}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  try {
    const { cloneDir, env } = await cloneBackupRepo(workDir, { requireSshKey: true });
    const target = join(cloneDir, backupFileName);

    dumpDatabaseToSql(source, target);

    writeFileSync(
      join(cloneDir, "backup-meta.json"),
      JSON.stringify(
        {
          source: backupFileName,
          sizeBytes: statSync(target).size,
          originalBinarySource: basename(source),
          backedUpAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n"
    );

    await run("git", ["config", "user.name", "omniroute-db-backup"], { cwd: cloneDir, env });
    await run("git", ["config", "user.email", "omniroute-db-backup@users.noreply.github.com"], {
      cwd: cloneDir,
      env,
    });
    await run("git", ["add", backupFileName, "backup-meta.json"], { cwd: cloneDir, env });

    const diff = await run("git", ["diff", "--cached", "--quiet"], { cwd: cloneDir, env });
    if (diff.code === 0) {
      log("no database changes to backup");
      return;
    }

    const commitMessage = `backup: ${new Date().toISOString()}`;
    const commit = await run("git", ["commit", "-m", commitMessage], { cwd: cloneDir, env });
    if (commit.code !== 0) throw new Error(commit.stderr.trim() || commit.stdout.trim());

    const push = await run("git", ["push", "origin", `HEAD:${branch}`], { cwd: cloneDir, env });
    if (push.code !== 0) throw new Error(push.stderr.trim() || push.stdout.trim());

    log(`database backed up successfully to ${repoUrl}:${branch}`);
  } catch (error) {
    log(`database backup failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    if (typeof global.gc === "function") {
      try {
        global.gc();
      } catch {}
    }
  }
}

let backupTimer = null;

function startPeriodicBackup() {
  if (process.env.DB_BACKUP_LOOP_DISABLED === "1") {
    return;
  }

  const initialTimeout = setTimeout(() => {
    void backupDatabaseOnce();
    backupTimer = setInterval(() => {
      void backupDatabaseOnce();
    }, intervalMs);
    backupTimer.unref?.();
  }, initialDelayMs);

  initialTimeout.unref?.();
}

let isShuttingDown = false;

async function handleShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`${signal} received; running shutdown cleanup`);

  if (backupTimer) {
    clearInterval(backupTimer);
  }

  if (process.env.DB_BACKUP_ON_SHUTDOWN !== "0") {
    log("running final database backup before exit");
    const timeoutPromise = new Promise((resolveSleep) => setTimeout(resolveSleep, shutdownTimeoutMs));
    await Promise.race([backupDatabaseOnce(), timeoutPromise]);
  }

  process.exit(0);
}

process.on("SIGINT", () => void handleShutdown("SIGINT"));
process.on("SIGTERM", () => void handleShutdown("SIGTERM"));

function findServerEntry() {
  const root = process.cwd();
  const candidates = [
    join(root, ".build", "next", "standalone", "server-ws.mjs"),
    join(root, ".next", "standalone", "server-ws.mjs"),
    join(root, ".build", "next", "standalone", "server.js"),
    join(root, ".next", "standalone", "server.js"),
    join(root, "server-ws.mjs"),
    join(root, "server.js"),
    join(root, "scripts", "dev", "standalone-server-ws.mjs"),
    join(root, "scripts", "dev", "run-next.mjs"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ─── Main Execution ─────────────────────────────────────────────────────────

log("starting OmniRoute Heroku/standalone optimized runner");

await loadRemoteEnvAndRestoreDatabase();
process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
process.env.OMNIROUTE_MEMORY_MB ||= "256";
process.env.NODE_ENV = "production";

// Apply port defaults
const port = process.env.PORT || process.env.DASHBOARD_PORT || "20128";
process.env.PORT = port;
process.env.DASHBOARD_PORT = port;
process.env.API_PORT = process.env.API_PORT || port;
process.env.OMNIROUTE_PORT = port;
process.env.HOSTNAME = process.env.HOSTNAME || "0.0.0.0";

cleanupQuotaSnapshots();
startPeriodicBackup();

const serverEntry = findServerEntry();
if (!serverEntry) {
  console.error("[FATAL] No server entrypoint found. Did you run `npm run build`?");
  process.exit(1);
}

log(`starting server in-process via: ${serverEntry}`);

const isStandalone = serverEntry.includes("standalone");
if (isStandalone) {
  const standaloneDir = dirname(serverEntry);
  process.chdir(standaloneDir);
}

await import(pathToFileURL(serverEntry).href);
