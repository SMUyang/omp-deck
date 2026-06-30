/**
 * JSON-lines transport for `omp --mode rpc`.
 *
 * Spawns the user's omp binary in RPC mode and provides typed request/response
 * correlation plus event subscription. Does NOT depend on the deck's embedded
 * SDK — it talks to whatever `omp` is on PATH (or OMP_DECK_OMP_BIN).
 */
import type { FileSink, Subprocess } from "bun";
import { logger } from "../log.ts";

const log = logger("rpc-transport");

/** A command sent to omp over stdin (one JSON object per line). */
export interface RpcCommand {
	readonly id: string;
	readonly type: string;
	readonly [key: string]: unknown;
}

export interface RpcCommandBody {
	readonly type: string;
	readonly [key: string]: unknown;
}

/** A correlated response from omp on stdout. */
export interface RpcResponse {
	readonly id?: string;
	readonly type: "response";
	readonly command: string;
	readonly success: boolean;
	readonly data?: unknown;
	readonly error?: string;
}

/** Any non-response JSON line: agent events, ext-ui requests, subagent frames, etc. */
export interface RpcEvent {
	readonly type: string;
	readonly [key: string]: unknown;
}

export type RpcEventListener = (event: RpcEvent) => void;

// ─── Type guards ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponse(value: unknown): value is RpcResponse {
	if (!isRecord(value)) return false;
	return (
		value.type === "response" &&
		typeof value.command === "string" &&
		typeof value.success === "boolean"
	);
}

function isReady(value: unknown): boolean {
	return isRecord(value) && value.type === "ready";
}

// ─── Transport ────────────────────────────────────────────────────────

export interface OmpRpcTransportOptions {
	/** Path to the omp binary (e.g. "omp" or "/Users/hyan/.bun/bin/omp"). */
	bin: string;
	/** Working directory for the RPC process. */
	cwd: string;
	/** Extra CLI args appended after `--mode rpc`. */
	extraArgs?: readonly string[];
	/** Timeout for the ready signal in ms (default: 30 000). */
	readyTimeoutMs?: number;
}

interface PendingRequest {
	command: string;
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
}

export interface PendingResponseKey {
	readonly id: string;
	readonly command: string;
}

export function selectPendingResponseKey(
	response: Pick<RpcResponse, "id" | "command">,
	pending: Iterable<PendingResponseKey>,
): string | undefined {
	if (response.id) {
		for (const item of pending) {
			if (item.id === response.id) return item.id;
		}
		return undefined;
	}

	let matchedId: string | undefined;
	for (const item of pending) {
		if (item.command !== response.command) continue;
		if (matchedId) return undefined;
		matchedId = item.id;
	}
	return matchedId;
}

type PipedReader = ReadableStream<Uint8Array>;
type PipedWriter = FileSink;

export class OmpRpcTransport {
	readonly #bin: string;
	readonly #cwd: string;
	readonly #extraArgs: readonly string[];
	readonly #readyTimeoutMs: number;
	#proc: Subprocess | null = null;
	#stdin: PipedWriter | null = null;
	#stdout: PipedReader | null = null;
	#stderr: PipedReader | null = null;
	#buffer = "";
	#requestCounter = 0;
	#pending = new Map<string, PendingRequest>();
	#listeners = new Set<RpcEventListener>();
	#ready = false;
	#stderrChunks: string[] = [];

	constructor(options: OmpRpcTransportOptions) {
		this.#bin = options.bin;
		this.#cwd = options.cwd;
		this.#extraArgs = options.extraArgs ?? [];
		this.#readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
	}

	#getStderrPreview(): string {
		return this.#stderrChunks.slice(-20).join("").slice(0, 1_000);
	}

	/** Spawn omp --mode rpc and wait for the `ready` signal. */
	async start(): Promise<void> {
		if (this.#proc) throw new Error("transport already started");

		const args = ["--mode", "rpc", ...this.#extraArgs];
		log.info(`spawning ${this.#bin} ${args.join(" ")} (cwd=${this.#cwd})`);

		this.#proc = Bun.spawn({
			cmd: [this.#bin, ...args],
			cwd: this.#cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, NO_COLOR: "1" },
		});

		const stdin = this.#proc.stdin;
		const stdout = this.#proc.stdout;
		const stderr = this.#proc.stderr;
		if (typeof stdin === "number" || stdin === undefined) throw new Error("stdin was not piped");
		if (typeof stdout === "number" || stdout === undefined) throw new Error("stdout was not piped");
		if (typeof stderr === "number" || stderr === undefined) throw new Error("stderr was not piped");
		this.#stdin = stdin;
		this.#stdout = stdout;
		this.#stderr = stderr;

		void this.#pumpStderr();
		await this.#awaitReady();
	}

	/** Send a command and await its correlated response. */
	async send<T = unknown>(command: RpcCommandBody): Promise<T> {
		if (!this.#stdin) throw new Error("transport not started or stdin closed");
		const id = `r${++this.#requestCounter}`;
		const line = JSON.stringify({ ...command, id }) + "\n";

		const pendingResponse = Promise.withResolvers<RpcResponse>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			pendingResponse.reject(
				new Error(
					`RPC timeout: command "${command.type}" (${id}). Stderr: ${this.#getStderrPreview()}`,
				),
			);
		}, 60_000);

		this.#pending.set(id, {
			command: command.type,
			resolve: (resp) => {
				clearTimeout(timer);
				pendingResponse.resolve(resp);
			},
			reject: (err) => {
				clearTimeout(timer);
				pendingResponse.reject(err);
			},
		});

		this.#stdin.write(line);
		const response = await pendingResponse.promise;

		if (!response.success) {
			throw new Error(`RPC "${command.type}" failed: ${response.error ?? "(no error message)"}`);
		}
		return response.data as T;
	}

	/** Subscribe to all non-response events from the RPC process. */
	onEvent(listener: RpcEventListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** True once the `ready` signal has been received. */
	get isReady(): boolean {
		return this.#ready;
	}

	/** Kill the RPC process and reject all pending requests. */
	kill(): void {
		for (const pending of this.#pending.values()) {
			pending.reject(new Error("transport killed"));
		}
		this.#pending.clear();
		this.#listeners.clear();

		if (this.#proc) {
			try {
				this.#proc.kill();
			} catch {
				// already dead
			}
			this.#proc = null;
		}
		this.#stdin = null;
		this.#stdout = null;
		this.#stderr = null;
		this.#ready = false;
	}

	async #awaitReady(): Promise<void> {
		if (!this.#stdout || !this.#proc) throw new Error("transport not started");

		let readyResolve: () => void;
		let readyReject: (err: Error) => void;
		const ready = new Promise<void>((resolve, reject) => {
			readyResolve = resolve;
			readyReject = reject;
		});

		const timer = setTimeout(() => {
			readyReject!(
				new Error(
					`RPC process did not signal ready within ${this.#readyTimeoutMs}ms. Stderr: ${this.#getStderrPreview()}`,
				),
			);
		}, this.#readyTimeoutMs);

		// Race against process exit
		void this.#proc.exited.then((code: number | null) => {
			if (!this.#ready) {
				clearTimeout(timer);
				readyReject!(
					new Error(
						`RPC process exited (code=${code}) before ready. Stderr: ${this.#getStderrPreview()}`,
					),
				);
			}
		});

		// Start the stdout reader loop; it sets #ready when it sees the signal
		void this.#pumpStdout(() => {
			if (this.#ready) {
				clearTimeout(timer);
				readyResolve!();
			}
		});

		await ready;
	}

	async #pumpStderr(): Promise<void> {
		if (!this.#stderr) return;
		const reader = this.#stderr.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				const text = decoder.decode(value, { stream: true });
				this.#stderrChunks.push(text);
				if (this.#stderrChunks.length > 40) {
					this.#stderrChunks.splice(0, this.#stderrChunks.length - 20);
				}
			}
		} catch (err) {
			log.warn("stderr reader stopped", err);
		}
	}

	async #pumpStdout(onLine: () => void): Promise<void> {
		if (!this.#stdout) return;
		const reader = this.#stdout.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				this.#buffer += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = this.#buffer.indexOf("\n")) !== -1) {
					const line = this.#buffer.slice(0, nl).trim();
					this.#buffer = this.#buffer.slice(nl + 1);
					if (!line) continue;
					this.#handleLine(line);
					onLine();
				}
			}
		} catch (err) {
			log.warn("stdout reader stopped", err);
		}

		// Reject any pending requests if the stream ended
		for (const pending of this.#pending.values()) {
			pending.reject(new Error("RPC process stdout closed"));
		}
		this.#pending.clear();
	}

	#handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			log.warn("unparseable RPC line", line.slice(0, 200));
			return;
		}

		if (!isRecord(parsed)) return;

		if (isReady(parsed)) {
			this.#ready = true;
			log.info("RPC process ready");
			return;
		}

		if (isResponse(parsed)) {
			const pendingKeys: PendingResponseKey[] = [];
			for (const [pendingId, pending] of this.#pending) {
				pendingKeys.push({ id: pendingId, command: pending.command });
			}
			const key = selectPendingResponseKey(parsed, pendingKeys);
			if (key) {
				const pending = this.#pending.get(key);
				if (pending) {
					this.#pending.delete(key);
					pending.resolve(parsed);
					return;
				}
			}
			log.warn(`orphan RPC response: ${parsed.command} (${parsed.id})`);
			return;
		}

		// Everything else is an event
		for (const listener of this.#listeners) {
			try {
				listener(parsed as RpcEvent);
			} catch (err) {
				log.warn("event listener threw", err);
			}
		}
	}
}
