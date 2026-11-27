import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDatabaseUrl = "postgres://postgres:postgres@localhost:5432/solution_pay";
const localPgScript =
    process.env.LOCAL_PG_SCRIPT ||
    path.join(os.homedir(), ".local", "share", "solution-pay-pg", "start.mjs");

function parseDatabaseEndpoint(databaseUrl) {
    try {
        const parsed = new URL(databaseUrl);
        return {
            host: parsed.hostname || "localhost",
            port: parsed.port ? Number(parsed.port) : 5432,
        };
    } catch {
        return { host: "localhost", port: 5432 };
    }
}

function isLocalHost(host) {
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isPortOpen(host, port, timeoutMs = 1000) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port, autoSelectFamily: true });
        let settled = false;
        const finish = (open) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
    });
}

function startLocalPostgres(scriptPath, host, port) {
    return new Promise((resolve, reject) => {
        // Detached so Ctrl+C lets the backend close its pool before Postgres stops
        const child = spawn(process.execPath, [scriptPath], {
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let output = "";
        let settled = false;
        const appendOutput = (chunk) => {
            output = (output + chunk.toString()).slice(-8192);
        };

        const cleanupTimers = () => {
            clearTimeout(startupTimeout);
            clearInterval(fallbackPoll);
        };

        const succeed = () => {
            if (settled) return;
            settled = true;
            cleanupTimers();
            resolve(child);
        };

        const fail = (message) => {
            if (settled) return;
            settled = true;
            cleanupTimers();
            const details = output.trim() ? `\n${output.trim()}` : "";
            reject(new Error(`${message}${details}`));
        };

        child.stdout.on("data", (chunk) => {
            appendOutput(chunk);
            if (output.includes("PostgreSQL ready")) {
                succeed();
            }
        });

        child.stderr.on("data", appendOutput);

        child.once("error", (error) => {
            fail(`Failed to spawn local PostgreSQL (${scriptPath}): ${error.message}`);
        });

        child.once("exit", (code, signal) => {
            fail(`Local PostgreSQL exited unexpectedly (code=${code}, signal=${signal})`);
        });

        const startedAt = Date.now();
        const fallbackPoll = setInterval(async () => {
            if (Date.now() - startedAt < 5000) return;
            if (await isPortOpen(host, port, 500)) {
                succeed();
            }
        }, 500);
        fallbackPoll.unref();

        const startupTimeout = setTimeout(() => {
            child.kill("SIGTERM");
            fail(`Timed out waiting for local PostgreSQL on ${host}:${port}`);
        }, 30_000);
        startupTimeout.unref();
    });
}

function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: rootDir,
            stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (signal) {
                resolve(1);
            } else {
                resolve(code ?? 0);
            }
        });
    });
}

function stopChild(child, signal = "SIGTERM", timeoutMs = 10_000) {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(forceKill);
            resolve();
        };

        child.once("exit", finish);
        try {
            child.kill(signal);
        } catch {
            finish();
            return;
        }

        const forceKill = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            } catch {
                // ignore
            }
            finish();
        }, timeoutMs);
        forceKill.unref();
    });
}

async function main() {
    const databaseUrl = process.env.DATABASE_URL || defaultDatabaseUrl;
    const { host, port } = parseDatabaseEndpoint(databaseUrl);

    let pgChild = null;
    let appChild = null;
    let shuttingDown = false;

    const cleanupAndExit = async (exitCode, forwardSignal = null) => {
        if (shuttingDown) return;
        shuttingDown = true;

        if (appChild && appChild.exitCode === null && appChild.signalCode === null) {
            if (forwardSignal) {
                await stopChild(appChild, forwardSignal);
            } else {
                await new Promise((resolve) => {
                    const timer = setTimeout(() => {
                        stopChild(appChild, "SIGTERM").then(resolve);
                    }, 10_000);
                    timer.unref();
                    appChild.once("exit", () => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
            }
        }

        if (pgChild) {
            console.log("[dev] Stopping local PostgreSQL...");
            await stopChild(pgChild, "SIGTERM");
        }

        process.exit(exitCode);
    };

    process.on("SIGINT", () => {
        const forward = process.stdin.isTTY ? null : "SIGINT";
        void cleanupAndExit(0, forward);
    });
    process.on("SIGTERM", () => {
        void cleanupAndExit(0, "SIGTERM");
    });

    try {
        if (!(await isPortOpen(host, port))) {
            if (isLocalHost(host) && fs.existsSync(localPgScript)) {
                console.log("[dev] Starting local PostgreSQL...");
                pgChild = await startLocalPostgres(localPgScript, host, port);
                console.log(`[dev] Local PostgreSQL ready on ${host}:${port}`);
            } else {
                console.error(
                    `[dev] PostgreSQL is not reachable at ${host}:${port}. Start PostgreSQL (see docs/DATABASE.md) and try again.`
                );
                process.exit(1);
            }
        }

        const tscBin = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
        const buildExit = fs.existsSync(tscBin)
            ? await runCommand(process.execPath, [tscBin])
            : await runCommand("npx", ["tsc"]);
        if (buildExit !== 0) {
            await cleanupAndExit(buildExit);
            return;
        }

        const migrateExit = await runCommand(process.execPath, [
            path.join(rootDir, "dist", "db", "migrate.js"),
        ]);
        if (migrateExit !== 0) {
            await cleanupAndExit(migrateExit);
            return;
        }

        appChild = spawn(process.execPath, [path.join(rootDir, "dist", "index.js")], {
            cwd: rootDir,
            stdio: "inherit",
        });

        appChild.once("error", async (error) => {
            console.error("[dev] Failed to start server:", error.message);
            await cleanupAndExit(1);
        });

        appChild.once("exit", async (code) => {
            await cleanupAndExit(code ?? 0);
        });
    } catch (error) {
        console.error("[dev]", error instanceof Error ? error.message : error);
        await cleanupAndExit(1);
    }
}

void main();
