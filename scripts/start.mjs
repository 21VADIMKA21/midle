import { spawn } from "node:child_process";

const web = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start"],
  { stdio: "inherit", env: process.env },
);

let worker = null;
let workerRestartTimer = null;
let shuttingDown = false;

function startWorker() {
  if (shuttingDown || worker) return;

  if (
    !process.env.DATABASE_URL ||
    !process.env.TWITCH_CLIENT_ID ||
    !process.env.TWITCH_CLIENT_SECRET ||
    !process.env.TOKEN_ENCRYPTION_KEY
  ) {
    console.log("[fusion-start] Chat worker not started: configure database and Twitch credentials.");
    return;
  }

  worker = spawn(
    process.execPath,
    ["scripts/chat-worker.mjs"],
    { stdio: "inherit", env: process.env },
  );

  worker.on("exit", (code, signal) => {
    worker = null;
    if (shuttingDown || code === 0) return;

    console.error(
      "[fusion-start] Chat worker exited (" + (signal || code) + "); restarting in 5 seconds.",
    );
    workerRestartTimer = setTimeout(() => {
      workerRestartTimer = null;
      startWorker();
    }, 5_000);
  });

  worker.on("error", (error) => {
    console.error("[fusion-start] Could not launch chat worker:", error.message);
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[fusion-start] Shutting down after", signal);

  if (workerRestartTimer) clearTimeout(workerRestartTimer);
  if (worker && !worker.killed) worker.kill("SIGTERM");
  if (!web.killed) web.kill("SIGTERM");
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

web.on("error", (error) => {
  console.error("[fusion-start] Next.js could not start:", error.message);
  shutdown("web process error");
  process.exitCode = 1;
});

web.on("exit", (code, signal) => {
  shutdown("web process exited");
  process.exit(code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1));
});

startWorker();
