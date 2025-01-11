import { attach, type Nvim } from "../src/index.ts";
import { unlink } from "node:fs/promises";
import { spawn } from "child_process";
import path from "path";

const SOCK = `/tmp/nvim-node-test.sock`;
export async function withNvimProcess(fn: (sock: string) => Promise<void>) {
  try {
    await unlink(SOCK);
  } catch (e) {
    if ((e as { code: string }).code !== "ENOENT") {
      console.error(e);
    }
  }

  const nvimProcess = spawn(
    "nvim",
    ["--headless", "-n", "--clean", "--listen", SOCK],
    {
      // root dir relative to this file
      cwd: path.resolve(path.dirname(__filename), "../"),
    },
  );

  if (!nvimProcess.pid) {
    throw new Error("Failed to start nvim process");
  }

  try {
    nvimProcess.on("error", (err) => {
      throw err;
    });

    nvimProcess.on("exit", (code, signal) => {
      if (code !== 1) {
        throw new Error(
          `Nvim process exited with code ${code} and signal ${signal}`,
        );
      }
    });

    // give enough time for socket to be created
    // TODO: poll for socket instead
    await new Promise((resolve) => setTimeout(resolve, 500));

    await fn(SOCK);
  } finally {
    const res = nvimProcess.kill();
    console.log(`Killed process ${nvimProcess.pid} with result ${res}`);
  }
}

export async function withNvimClient(fn: (nvim: Nvim) => Promise<void>) {
  return withNvimProcess(async (sock) => {
    const nvim = await attach({
      socket: sock,
      client: { name: "test" },
      logging: { level: "debug" },
    });

    try {
      await fn(nvim);
    } finally {
      nvim.detach();
    }
  });
}

process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});
