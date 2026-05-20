// MUST be first — patches Bun.spawn to redirect python.exe → pythonw.exe on
// Windows so the eval-py kernel doesn't pop a console window. See the file's
// own docblock for the full rationale and shape.
import "./silence-python.ts";
import { loadManagedEnvIntoProcess } from "./env-store.ts";

loadManagedEnvIntoProcess();

import type { Server, ServerWebSocket } from "bun";
import * as path from "node:path";

import { InProcessAgentBridge } from "./bridge/in-process.ts";
import { RoutinesRunner } from "./routines-runner.ts";
import { closeDb, openDb } from "./db/index.ts";
import { loadConfig } from "./config.ts";
import { logger } from "./log.ts";
import { buildRouter } from "./routes.ts";
import { WsHub, type ConnectionData } from "./ws.ts";
import { MarketplaceService } from "./marketplace-service.ts";
import { SkillsService } from "./skills-service.ts";
import { startSkillsWatcher } from "./skills-watcher.ts";
import { buildDefaultBridgeSupervisor } from "./bridge-supervisor.ts";
import type { RestartServerResponse } from "@omp-deck/protocol";

const log = logger("server");

async function main(): Promise<void> {
	const config = loadConfig();
	log.info(`omp-deck server starting`, {
		host: config.host,
		port: config.port,
		defaultCwd: config.defaultCwd,
		webDist: config.webDist,
		devMode: config.devMode,
	});

	openDb({ path: config.dbPath });

	const bridge = new InProcessAgentBridge({
		idleTimeoutMs: config.idleTimeoutMs,
		autoStartCommand: config.autoStartCommand,
	});
	const routinesRunner = new RoutinesRunner();
	routinesRunner.start();
	let server: Server<ConnectionData>;
	const supervisor = buildDefaultBridgeSupervisor();
	const marketplaceService = new MarketplaceService();
	const skillsService = new SkillsService(marketplaceService);
	const router = buildRouter(
		bridge,
		config,
		routinesRunner,
		supervisor,
		marketplaceService,
		skillsService,
		{ restartServer: () => scheduleRestart(server) },
	);
	const skillsWatcherDispose = startSkillsWatcher();
	const ws = new WsHub(bridge);

	server = Bun.serve<ConnectionData>({
		hostname: config.host,
		port: config.port,
		fetch(req, srv) {
			const url = new URL(req.url);

			if (url.pathname === "/ws") {
				const data = ws.createConnectionData();
				const upgraded = srv.upgrade(req, { data });
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname.startsWith("/api/")) {
				const trimmed = new URL(req.url);
				trimmed.pathname = url.pathname.slice(4) || "/";
				return router.fetch(new Request(trimmed.toString(), req));
			}

			// Serve built web assets if a dist directory is available; otherwise
			// fall back to the landing stub. Vite dev server proxies through us
			// for /api and /ws, so its own routes never reach this branch.
			if (config.webDist) {
				return serveStatic(req, config.webDist);
			}

			if (url.pathname === "/" || url.pathname === "/index.html") {
				return new Response(LANDING_HTML, {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}

			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(socket: ServerWebSocket<ConnectionData>) {
				ws.onOpen(socket);
			},
			async message(socket: ServerWebSocket<ConnectionData>, raw) {
				await ws.onMessage(socket, raw as string | Buffer);
			},
			close(socket: ServerWebSocket<ConnectionData>) {
				ws.onClose(socket);
			},
			perMessageDeflate: false,
		},
	});

	log.info(`listening on http://${server.hostname}:${server.port}`);

	let shuttingDown = false;
	async function safeShutdown(reason: string): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info(`shutdown via ${reason}`);
		try {
			routinesRunner.dispose();
		} catch (err) {
			log.error(`runner dispose threw`, err);
		}
		try {
			skillsWatcherDispose();
		} catch (err) {
			log.error(`skills watcher dispose threw`, err);
		}
		try {
			await supervisor.shutdown();
		} catch (err) {
			log.error(`bridge supervisor shutdown threw`, err);
		}
		try {
			await bridge.dispose();
		} catch (err) {
			log.error(`bridge dispose threw`, err);
		}
		try {
			closeDb();
		} catch (err) {
			log.error(`db close threw`, err);
		}
	}

	process.once("SIGINT", () => {
		void safeShutdown("SIGINT").then(() => {
			server.stop(true);
			process.exit(0);
		});
	});
	process.once("SIGTERM", () => {
		void safeShutdown("SIGTERM").then(() => {
			server.stop(true);
			process.exit(0);
		});
	});
	// Last-resort safety net for non-signal exit paths (Bun crash, unhandled
	// rejection escalated to abort, etc). beforeExit fires when the loop drains.
	process.on("beforeExit", () => {
		void safeShutdown("beforeExit");
	});
}

function scheduleRestart(server: Server<ConnectionData>): RestartServerResponse {
	const cmd = [process.execPath, ...process.argv.slice(1)];
	const cwd = process.cwd();
	setTimeout(() => {
		log.info(`restart requested`, { cmd });
		try {
			server.stop(true);
		} catch (err) {
			log.warn(`server stop before restart failed`, err);
		}
		const env = Object.fromEntries(
			Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
		const child = Bun.spawn({
			cmd,
			cwd,
			env,
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
			detached: true,
		});
		child.unref();
		setTimeout(() => process.exit(0), 80);
	}, 100);
	return { ok: true, message: "Restart scheduled" };
}

const LANDING_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>omp-deck server</title>
<style>body{font-family:system-ui;max-width:48em;margin:4em auto;padding:0 1em;color:#e6edf3;background:#0d1117}code{background:#161b22;padding:.1em .4em;border-radius:.3em}a{color:#58a6ff}</style>
</head><body>
<h1>omp-deck server</h1>
<p>Backend is running. The browser UI is served by the <code>@omp-deck/web</code> Vite dev server (typically <a href="http://127.0.0.1:5173">http://127.0.0.1:5173</a> in dev), or the built static assets in production.</p>
<p>API base: <code>/api</code> &nbsp;&nbsp; WebSocket: <code>/ws</code></p>
</body></html>`;

main().catch((err) => {
	log.error(`fatal`, err);
	process.exit(1);
});

async function serveStatic(req: Request, root: string): Promise<Response> {
	const url = new URL(req.url);
	let rel = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
	if (rel === "" || rel === "index.html") rel = "index.html";

	// Reject path traversal.
	if (rel.includes("..")) return new Response("forbidden", { status: 403 });

	const full = path.join(root, rel);
	const resolved = path.resolve(full);
	const rootResolved = path.resolve(root);
	if (!resolved.startsWith(rootResolved)) {
		return new Response("forbidden", { status: 403 });
	}

	const direct = Bun.file(resolved);
	if (await direct.exists()) {
		return new Response(direct);
	}

	// SPA fallback — serve index.html so client-side routing works.
	const index = Bun.file(path.join(rootResolved, "index.html"));
	if (await index.exists()) {
		return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
	}
	return new Response("not found", { status: 404 });
}
