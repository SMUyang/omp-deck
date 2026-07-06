import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	DEFAULT_PRELUDE,
	getEffectivePrelude,
	getPreludeFilePath,
	readMaintenanceGateState,
	readPreludeOverride,
	readStartCommand,
	readTopologyContextInjectionState,
	readTopologyRerankConfig,
	renderMaintenanceReminder,
	writePreludeOverride,
	writeStartCommand,
} from "./orientation-store.ts";
const ENV_KEYS = [
	"OMP_DECK_DATA_DIR",
	"OMP_DECK_MAINTENANCE_GATE_DISABLED",
	"OMP_MAINTENANCE_GATE_MIN_OP_MSGS",
	"OMP_MAINTENANCE_GATE_MIN_RELEASE_AGE_MS",
	"OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS",
	"OMP_DECK_ORG_ROOT",
	"OMP_DECK_TOPOLOGY_CONTEXT_ENABLED",
	"OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS",
	"OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS",
	"OMP_DECK_API_BASE",
	"OMP_DECK_TOPOLOGY_RERANK_ENABLED",
	"OMP_DECK_TOPOLOGY_RERANK_MIN_CONTEXT_PERCENT",
	"OMP_DECK_TOPOLOGY_RERANK_MIN_CANDIDATE_NODES",
	"OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW",
	"OMP_DECK_TOPOLOGY_RERANK_TIMEOUT_MS",
	"HOME",
	"OMP_AGENT_DIR",
	"USERPROFILE",
];

let saved: Record<string, string | undefined>;
let tmpDataDir: string;
let tmpHomeDir: string;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	tmpDataDir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-orient-data-"));
	tmpHomeDir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-orient-home-"));
	process.env.OMP_DECK_DATA_DIR = tmpDataDir;
	// os.homedir() honors USERPROFILE on Windows and HOME on POSIX. Override
	// both so the test never writes to the real user home no matter which
	// platform Bun picks up.
	process.env.HOME = tmpHomeDir;
	process.env.USERPROFILE = tmpHomeDir;
	for (const k of ENV_KEYS) {
		if (
			k !== "OMP_DECK_DATA_DIR" &&
			k !== "HOME" &&
			k !== "USERPROFILE"
		) {
			delete process.env[k];
		}
	}
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("prelude override", () => {
	test("absent override falls back to DEFAULT_PRELUDE", () => {
		expect(readPreludeOverride()).toBeNull();
		expect(getEffectivePrelude()).toBe(DEFAULT_PRELUDE);
	});

	test("write then read round-trips verbatim", () => {
		const text = "# custom prelude\n— em-dash · middle-dot — done\n";
		writePreludeOverride(text);
		expect(readPreludeOverride()).toBe(text);
		expect(getEffectivePrelude()).toBe(text);
		// File matches verbatim on disk (no BOM, no CRLF translation).
		const onDisk = readFileSync(getPreludeFilePath(), "utf8");
		expect(onDisk).toBe(text);
	});

	test("null clears the override and removes the file", () => {
		writePreludeOverride("anything");
		expect(existsSync(getPreludeFilePath())).toBe(true);
		writePreludeOverride(null);
		expect(existsSync(getPreludeFilePath())).toBe(false);
		expect(getEffectivePrelude()).toBe(DEFAULT_PRELUDE);
	});

	test("clearing an already-absent override is a no-op", () => {
		expect(() => writePreludeOverride(null)).not.toThrow();
		expect(readPreludeOverride()).toBeNull();
	});
});

describe("start command", () => {
	test("missing file returns exists=false with empty fields", () => {
		const cmd = readStartCommand();
		expect(cmd.exists).toBe(false);
		expect(cmd.description).toBe("");
		expect(cmd.body).toBe("");
		expect(cmd.path.endsWith(path.join(".omp", "agent", "commands", "start.md"))).toBe(true);
	});

	test("resolves start command under OMP_AGENT_DIR when configured", () => {
		const agentDir = path.join(tmpHomeDir, "custom-agent");
		process.env.OMP_AGENT_DIR = agentDir;

		const cmd = readStartCommand();

		expect(cmd.path).toBe(path.join(agentDir, "commands", "start.md"));
		expect(cmd.exists).toBe(false);
	});

	test("write + read round-trips description and body verbatim", () => {
		const desc = "Orient — load context, then list";
		const body = "Line 1\nLine 2 with — em-dash\n";
		writeStartCommand(desc, body);
		const cmd = readStartCommand();
		expect(cmd.exists).toBe(true);
		expect(cmd.description).toBe(desc);
		expect(cmd.body).toBe(body);
	});

	test("empty description omits the frontmatter block", () => {
		writeStartCommand("", "just body content\n");
		const onDisk = readFileSync(readStartCommand().path, "utf8");
		expect(onDisk.startsWith("---")).toBe(false);
		expect(onDisk).toBe("just body content\n");
		const cmd = readStartCommand();
		expect(cmd.description).toBe("");
		expect(cmd.body).toBe("just body content\n");
	});

	test("reads existing frontmatter without description as empty", () => {
		const target = readStartCommand().path;
		const dir = path.dirname(target);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			target,
			`---\nargs: ["x"]\n---\nbody here\n`,
			{ encoding: "utf8", flag: "w" },
		);
		expect(existsSync(dir)).toBe(true);
		const cmd = readStartCommand();
		expect(cmd.description).toBe("");
		expect(cmd.body).toBe("body here\n");
	});

	test("strips surrounding quotes from a quoted description", () => {
		const target = readStartCommand().path;
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(
			target,
			`---\ndescription: "Quoted summary"\n---\nbody\n`,
			{ encoding: "utf8", flag: "w" },
		);
		expect(readStartCommand().description).toBe("Quoted summary");
	});
});

describe("maintenance gate state", () => {
	test("defaults to enabled with all knobs at compiled defaults", () => {
		const state = readMaintenanceGateState();
		expect(state.enabled).toBe(true);
		expect(state.knobs.minOpMsgs.value).toBe(4);
		expect(state.knobs.minOpMsgs.source).toBe("default");
		expect(state.knobs.minReleaseAgeMs.value).toBe(8 * 60_000);
		expect(state.knobs.fireFloorMs.value).toBe(25 * 60_000);
		expect(state.orgRoot).toBeNull();
	});

	test("OMP_DECK_MAINTENANCE_GATE_DISABLED=1 reports enabled=false", () => {
		process.env.OMP_DECK_MAINTENANCE_GATE_DISABLED = "1";
		const state = readMaintenanceGateState();
		expect(state.enabled).toBe(false);
		expect(state.disabledRaw).toBe("1");
		expect(state.disabledSource).toBe("process-env");
	});

	test("non-truthy disable values leave the gate enabled", () => {
		for (const value of ["", "0", "false", "no", "off"]) {
			process.env.OMP_DECK_MAINTENANCE_GATE_DISABLED = value;
			const state = readMaintenanceGateState();
			expect(state.enabled).toBe(true);
		}
	});

	test("knob override surfaces in value/source/raw", () => {
		process.env.OMP_MAINTENANCE_GATE_MIN_OP_MSGS = "7";
		const state = readMaintenanceGateState();
		expect(state.knobs.minOpMsgs.value).toBe(7);
		expect(state.knobs.minOpMsgs.rawValue).toBe("7");
		expect(state.knobs.minOpMsgs.source).toBe("process-env");
	});

	test("invalid knob falls back to default but keeps raw + source", () => {
		process.env.OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS = "not-a-number";
		const state = readMaintenanceGateState();
		expect(state.knobs.fireFloorMs.value).toBe(25 * 60_000);
		expect(state.knobs.fireFloorMs.rawValue).toBe("not-a-number");
		expect(state.knobs.fireFloorMs.source).toBe("process-env");
	});

	test("preview tables differ across profiles in the expected places", () => {
		const deck = renderMaintenanceReminder("deck");
		const flat = renderMaintenanceReminder("flat-file");
		expect(deck).toContain("POST /api/inbox");
		expect(deck).toContain("kb://system/");
		expect(deck).not.toContain("knowledge/<subfolder>");
		expect(flat).toContain("inbox/captures/<item>.md");
		expect(flat).not.toContain("POST /api/inbox");
	});
});

describe("topology context injection state", () => {
	test("defaults to disabled and inactive", () => {
		const state = readTopologyContextInjectionState();
		expect(state.enabled).toBe(false);
		expect(state.active).toBe(false);
		expect(state.inactiveReason).toBe("disabled");
		expect(state.apiBase.value).toBe("http://127.0.0.1:8787");
		expect(state.apiBase.source).toBe("default");
		expect(state.maxFocusChars.value).toBe(50_000);
		expect(state.timeoutMs.value).toBe(1500);
		expect(state.installedExtensionPath).toContain("topology-context");
	});

	test("enabled requires an explicit api base", () => {
		process.env.OMP_DECK_TOPOLOGY_CONTEXT_ENABLED = "1";
		delete process.env.OMP_DECK_API_BASE;
		const state = readTopologyContextInjectionState();
		expect(state.enabled).toBe(true);
		expect(state.active).toBe(false);
		expect(state.inactiveReason).toBe("missing_api_base");
		expect(state.apiBase.value).toBe("http://127.0.0.1:8787");
		expect(state.apiBase.source).toBe("default");
	});

	test("enabled with loopback api base becomes active when extension is installed", () => {
		const installed = path.join(tmpHomeDir, ".omp", "agent", "extensions", "topology-context", "index.ts");
		mkdirSync(path.dirname(installed), { recursive: true });
		writeFileSync(installed, "export default function extension() {}\n");
		process.env.OMP_DECK_TOPOLOGY_CONTEXT_ENABLED = "1";
		process.env.OMP_DECK_API_BASE = "http://127.0.0.1:8787/api";
		const state = readTopologyContextInjectionState();
		expect(state.enabled).toBe(true);
		expect(state.active).toBe(true);
		expect(state.inactiveReason).toBeUndefined();
		expect(state.apiBase.value).toBe("http://127.0.0.1:8787");
		expect(state.installedExtensionPresent).toBe(true);
	});

	test("enabled with IPv6 loopback api base becomes active", () => {
		const installed = path.join(tmpHomeDir, ".omp", "agent", "extensions", "topology-context", "index.ts");
		mkdirSync(path.dirname(installed), { recursive: true });
		writeFileSync(installed, "export default function extension() {}\n");
		process.env.OMP_DECK_TOPOLOGY_CONTEXT_ENABLED = "1";
		process.env.OMP_DECK_API_BASE = "http://[::1]:8787/api";
		const state = readTopologyContextInjectionState();
		expect(state.enabled).toBe(true);
		expect(state.active).toBe(true);
		expect(state.apiBase.value).toBe("http://[::1]:8787");
	});

	test("enabled with remote api base is inactive", () => {
		process.env.OMP_DECK_TOPOLOGY_CONTEXT_ENABLED = "1";
		process.env.OMP_DECK_API_BASE = "https://example.com/api";
		const state = readTopologyContextInjectionState();
		expect(state.enabled).toBe(true);
		expect(state.active).toBe(false);
		expect(state.inactiveReason).toBe("invalid_api_base");
	});

	test("knob override surfaces in value source and raw", () => {
		process.env.OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS = "9000";
		process.env.OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS = "2500";
		const state = readTopologyContextInjectionState();
		expect(state.maxFocusChars.value).toBe(9000);
		expect(state.maxFocusChars.rawValue).toBe("9000");
		expect(state.maxFocusChars.source).toBe("process-env");
		expect(state.timeoutMs.value).toBe(2500);
		expect(state.timeoutMs.rawValue).toBe("2500");
		expect(state.timeoutMs.source).toBe("process-env");
	});

	test("decimal knob override falls back instead of truncating", () => {
		process.env.OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS = "9000.7";
		const state = readTopologyContextInjectionState();
		expect(state.maxFocusChars.value).toBe(50_000);
		expect(state.maxFocusChars.rawValue).toBe("9000.7");
		expect(state.maxFocusChars.source).toBe("process-env");
	});
});

describe("topology rerank config", () => {
	test("defaults to enabled with bundled values", () => {
		const state = readTopologyRerankConfig();
		expect(state.enabled).toBe(true);
		expect(state.enabledSource).toBe("default");
		expect(state.rerankModelRole).toBe("topology_query_reranker");
		expect(state.rerankModelRoleSource).toBe("default");
		expect(state.minContextPercent.value).toBe(12);
		expect(state.minCandidateNodes.value).toBe(16);
		expect(state.localConfidenceBelow.value).toBe(0.72);
		expect(state.timeoutMs.value).toBe(30_000);
	});

	test("overrides surface correct source", () => {
		process.env.OMP_DECK_TOPOLOGY_RERANK_ENABLED = "0";
		process.env.OMP_DECK_TOPOLOGY_RERANK_MIN_CANDIDATE_NODES = "32";
		process.env.OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW = "0.5";
		const state = readTopologyRerankConfig();
		expect(state.enabled).toBe(false);
		expect(state.enabledSource).toBe("process-env");
		expect(state.minCandidateNodes.value).toBe(32);
		expect(state.localConfidenceBelow.value).toBe(0.5);
	});

	test("displays non-negative percent not int", () => {
		process.env.OMP_DECK_TOPOLOGY_RERANK_MIN_CONTEXT_PERCENT = "12.5";
		const state = readTopologyRerankConfig();
		expect(state.minContextPercent.value).toBe(12.5);
	});
});
