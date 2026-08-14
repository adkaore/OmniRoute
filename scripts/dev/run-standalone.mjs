#!/usr/bin/env node

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

if (existsSync("scripts/ops/start-with-remote-env-and-backup.mjs")) {
  await import(pathToFileURL("scripts/ops/start-with-remote-env-and-backup.mjs").href);
} else {
  const {
    resolveRuntimePorts,
    withRuntimePortEnv,
    resolveMaxOldSpaceMb,
    spawnWithForwardedSignals,
  } = await import("../build/runtime-env.mjs");
  const { bootstrapEnv } = await import("../build/bootstrap-env.mjs");

  const env = bootstrapEnv();
  const runtimePorts = resolveRuntimePorts(env);
  const childEnv = withRuntimePortEnv(env, runtimePorts);

  const maxOldSpaceMb = resolveMaxOldSpaceMb(childEnv.OMNIROUTE_MEMORY_MB);
  childEnv.NODE_OPTIONS =
    `${childEnv.NODE_OPTIONS || ""} --max-old-space-size=${maxOldSpaceMb}`.trim();

  const entry = existsSync("server-ws.mjs") ? "server-ws.mjs" : "server.js";

  spawnWithForwardedSignals("node", [entry], {
    stdio: "inherit",
    env: childEnv,
  });
}

