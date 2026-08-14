import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const repoUrl = process.env.DB_BACKUP_REPO || "git@github.com:adkaore/omniroute-db-sql.git";
const branch = process.env.DB_BACKUP_BRANCH || "main";
const intervalMs = Math.max(
  5 * 60 * 1000,
  Number.parseInt(process.env.DB_BACKUP_INTERVAL_MS || String(20 * 60 * 1000), 10)
);
const initialDelayMs = Math.max(
  0,
  Number.parseInt(process.env.DB_BACKUP_INITIAL_DELAY_MS || String(2 * 60 * 1000), 10)
);
const backupName = process.env.DB_BACKUP_FILE_NAME || "omniroute.sql";

function log(message) {
  console.log(`[db-backup] ${message}`);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      stdio: options.stdio || "pipe",
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
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

function prepareSshKey(workDir) {
  const keyB64 = process.env.GITHUB_DEPLOY_KEY_B64;
  const rawKey = process.env.GITHUB_DEPLOY_KEY;
  if (!keyB64 && !rawKey) throw new Error("GITHUB_DEPLOY_KEY_B64 is not configured");

  const sshDir = join(workDir, ".ssh");
  mkdirSync(sshDir, { recursive: true });
  const keyPath = join(sshDir, "id_ed25519");
  const keyContent = keyB64 ? Buffer.from(keyB64, "base64").toString("utf8") : rawKey;
  writeFileSync(keyPath, keyContent, { mode: 0o600 });
  const configPath = join(sshDir, "config");
  writeFileSync(
    configPath,
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
    GIT_SSH_COMMAND: `ssh -F ${configPath.replace(/\\/g, "/")}`,
  };
}

function walk(dir, depth = 0, maxDepth = 3) {
  if (!existsSync(dir) || depth > maxDepth) return [];
  let entries = [];
  try {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        if (["node_modules", ".git", ".next", ".build"].includes(item.name)) continue;
        entries = entries.concat(walk(full, depth + 1, maxDepth));
      } else {
        entries.push(full);
      }
    }
  } catch {
    return entries;
  }
  return entries;
}

function findSqliteFile() {
  const explicit =
    process.env.DB_BACKUP_SOURCE || process.env.SQLITE_DB_PATH || process.env.DB_PATH;
  if (explicit && existsSync(explicit)) return resolve(explicit);

  const dataDir = process.env.DATA_DIR;
  const candidates = [
    dataDir,
    join(homedir(), ".omniroute"),
    join(process.cwd(), "data"),
    join(process.cwd(), ".data"),
    "/tmp",
  ]
    .filter(Boolean)
    .flatMap((dir) => walk(String(dir), 0, 2))
    .filter((file) => {
      const name = basename(file).toLowerCase();
      return (
        (name.endsWith(".sqlite") || name.endsWith(".sqlite3") || name.endsWith(".db")) &&
        !name.includes("backup") &&
        !name.includes("probe-failed") &&
        !name.endsWith("-wal") &&
        !name.endsWith("-shm") &&
        !name.endsWith("-journal")
      );
    })
    .map((file) => ({ file, stat: statSync(file) }))
    .filter((entry) => entry.stat.isFile() && entry.stat.size > 0)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.stat.size - a.stat.size);

  return candidates[0]?.file || null;
}

function ensureSqlite3Available() {
  const check = spawnSync("sqlite3", ["-version"], { stdio: "pipe" });
  return !check.error && check.status === 0;
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

export async function backupOnce() {
  const source = findSqliteFile();
  if (!source) {
    log("no sqlite database found; set DB_BACKUP_SOURCE if needed");
    return;
  }

  if (!ensureSqlite3Available()) {
    log("sqlite3 CLI not found on PATH; cannot dump database, skipping backup");
    return;
  }

  const workDir = join(tmpdir(), `omniroute-db-backup-${process.pid}-${Date.now()}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  try {
    const env = prepareSshKey(workDir);
    const repoDir = join(workDir, "repo");

    log(`cloning repository to ${repoDir}`);
    let clone = await run("git", ["clone", "--depth", "1", "--branch", branch, repoUrl, repoDir], {
      env,
    });
    if (
      clone.code !== 0 &&
      /Remote branch .* not found|not found in upstream origin/i.test(clone.stderr)
    ) {
      clone = await run("git", ["clone", "--depth", "1", repoUrl, repoDir], { env });
      if (clone.code === 0) {
        await run("git", ["checkout", "-B", branch], { cwd: repoDir, env });
      }
    }
    if (clone.code !== 0) throw new Error(clone.stderr.trim() || clone.stdout.trim());

    const target = join(repoDir, backupName);

    log(`dumping ${source} to ${backupName}`);
    dumpDatabaseToSql(source, target);

    writeFileSync(
      join(repoDir, "backup-meta.json"),
      JSON.stringify(
        {
          source: backupName,
          sizeBytes: statSync(target).size,
          originalBinarySource: basename(source),
          backedUpAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n"
    );

    await run("git", ["config", "user.name", "omniroute-db-backup"], { cwd: repoDir, env });
    await run("git", ["config", "user.email", "omniroute-db-backup@users.noreply.github.com"], {
      cwd: repoDir,
      env,
    });
    await run("git", ["add", backupName, "backup-meta.json"], { cwd: repoDir, env });

    const diff = await run("git", ["diff", "--cached", "--quiet"], { cwd: repoDir, env });
    if (diff.code === 0) {
      log("no database changes to backup");
      return;
    }

    const commitMessage = `backup: ${new Date().toISOString()}`;
    const commit = await run("git", ["commit", "-m", commitMessage], { cwd: repoDir, env });
    if (commit.code !== 0) throw new Error(commit.stderr.trim() || commit.stdout.trim());

    const push = await run("git", ["push", "origin", `HEAD:${branch}`], { cwd: repoDir, env });
    if (push.code !== 0) throw new Error(push.stderr.trim() || push.stdout.trim());

    log(`uploaded ${backupName} from ${source}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function loop() {
  if (initialDelayMs > 0) {
    log(`waiting ${Math.round(initialDelayMs / 1000)}s before first scheduled backup`);
    await sleep(initialDelayMs);
  }

  while (true) {
    try {
      await backupOnce();
    } catch (error) {
      log(`backup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(intervalMs);
  }
}

if (process.argv[1] && process.argv[1].endsWith("backup-db-to-github.mjs")) {
  if (process.argv.includes("--loop")) {
    await loop();
  } else {
    await backupOnce();
  }
}
