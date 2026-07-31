import { useEffect, useState } from "react";

import { settingsApi } from "@/lib/settings-api";
import { Button } from "@/components/ui/Button";

/**
 * Schema-driven editor for omp's native config.yml.
 *
 * Fetches the setting schema summary (tabs + typed fields) and the current
 * config from the server, then renders a form per tab. Each field saves
 * independently via PATCH on change/blur. A collapsible raw JSON editor is
 * kept for advanced/composite values not covered by the schema form.
 */

interface SchemaSetting {
	path: string;
	label: string;
	description?: string;
	type: string;
	values?: string[];
	default?: unknown;
}

interface SchemaTab {
	id: string;
	label: string;
	settings: SchemaSetting[];
}

export function OmpSettingsForm() {
	const [config, setConfig] = useState<Record<string, unknown> | null>(null);
	const [tabs, setTabs] = useState<SchemaTab[]>([]);
	const [configPath, setConfigPath] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [note, setNote] = useState<string | undefined>();
	const [savingField, setSavingField] = useState<string | undefined>();
	const [showRaw, setShowRaw] = useState(false);
	const [rawText, setRawText] = useState("");
	const [rawError, setRawError] = useState<string | undefined>();
	// Draft text for array/record textareas (unparsed until blur).
	const [drafts, setDrafts] = useState<Record<string, string>>({});

	async function refresh() {
		try {
			const [cfg, schema] = await Promise.all([settingsApi.getOmpConfig(), settingsApi.getOmpSchema()]);
			setConfig(cfg.config);
			setConfigPath(cfg.path);
			setTabs(schema.tabs);
			setRawText(JSON.stringify(cfg.config, null, 2));
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoaded(true);
		}
	}

	useEffect(() => { void refresh(); }, []);

	function get(path: string): unknown {
		const parts = path.split(".");
		let cursor: unknown = config;
		for (const part of parts) {
			if (typeof cursor === "object" && cursor !== null && !Array.isArray(cursor)) {
				cursor = (cursor as Record<string, unknown>)[part];
			} else {
				return undefined;
			}
		}
		return cursor;
	}

	async function saveField(path: string, value: unknown): Promise<void> {
		setSavingField(path);
		setNote(undefined);
		setError(undefined);
		try {
			const parts = path.split(".");
			const updates: Record<string, unknown> = {};
			let cursor = updates;
			for (let i = 0; i < parts.length; i++) {
				if (i === parts.length - 1) {
					cursor[parts[i]!] = value;
				} else {
					const next: Record<string, unknown> = {};
					cursor[parts[i]!] = next;
					cursor = next;
				}
			}
			const resp = await settingsApi.patchOmpConfig(updates);
			setConfig(resp.config);
			setRawText(JSON.stringify(resp.config, null, 2));
			setNote(`Saved: ${path}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingField(undefined);
		}
	}

	async function saveRaw(): Promise<void> {
		setNote(undefined);
		setRawError(undefined);
		try {
			const parsed = JSON.parse(rawText) as Record<string, unknown>;
			const resp = await settingsApi.patchOmpConfig(parsed);
			setConfig(resp.config);
			setRawText(JSON.stringify(resp.config, null, 2));
			setNote("Raw config saved.");
		} catch (err) {
			setRawError(err instanceof Error ? err.message : String(err));
		}
	}

	if (!loaded) return <div className="font-mono text-2xs text-ink-3">Loading omp settings…</div>;

	const field = (s: SchemaSetting) => {
		const value = get(s.path);
		const hasValue = value !== undefined;
		const effective = hasValue ? value : s.default;
		const path = s.path;

		switch (s.type) {
			case "boolean": {
				const checked = effective === true;
				return (
					<label className="flex items-center justify-between gap-2 rounded border border-line bg-paper-2/40 px-2 py-1.5">
						<span className="min-w-0">
							<span className="block truncate font-mono text-2xs text-ink">{s.label}</span>
							<span className="block font-mono text-2xs text-ink-4">{path}</span>
						</span>
						<input
							type="checkbox"
							checked={checked}
							onChange={(e) => void saveField(path, e.target.checked)}
						/>
					</label>
				);
			}
			case "enum": {
				return (
					<label className="flex flex-col gap-1 rounded border border-line bg-paper-2/40 px-2 py-1.5">
						<span className="font-mono text-2xs text-ink">{s.label}</span>
						<span className="font-mono text-2xs text-ink-4">{path}</span>
						<select
							className="field h-7 px-1.5 font-mono text-2xs"
							value={typeof effective === "string" ? effective : ""}
							onChange={(e) => void saveField(path, e.target.value)}
						>
							{s.values?.map((v) => <option key={v} value={v}>{v}</option>)}
						</select>
					</label>
				);
			}
			case "number": {
				return (
					<label className="flex flex-col gap-1 rounded border border-line bg-paper-2/40 px-2 py-1.5">
						<span className="font-mono text-2xs text-ink">{s.label}</span>
						<span className="font-mono text-2xs text-ink-4">{path}</span>
						<input
							type="number"
							step="any"
							className="field h-7 px-1.5 font-mono text-2xs"
							defaultValue={typeof effective === "number" ? String(effective) : ""}
							placeholder={hasValue ? "" : "default"}
							onBlur={(e) => {
								if (e.target.value !== "" && Number.isFinite(Number(e.target.value))) {
									void saveField(path, Number(e.target.value));
								}
							}}
						/>
					</label>
				);
			}
			case "string": {
				return (
					<label className="flex flex-col gap-1 rounded border border-line bg-paper-2/40 px-2 py-1.5">
						<span className="font-mono text-2xs text-ink">{s.label}</span>
						<span className="font-mono text-2xs text-ink-4">{path}</span>
						<input
							type="text"
							className="field h-7 px-1.5 font-mono text-2xs"
							defaultValue={typeof effective === "string" ? effective : ""}
							placeholder={hasValue ? "" : "default"}
							onBlur={(e) => {
								if (e.target.value !== (hasValue ? effective : "")) {
									void saveField(path, e.target.value);
								}
							}}
						/>
					</label>
				);
			}
			case "array":
			case "record": {
				const draft = drafts[path];
				return (
					<label className="flex flex-col gap-1 rounded border border-line bg-paper-2/40 px-2 py-1.5">
						<span className="font-mono text-2xs text-ink">{s.label}</span>
						<span className="font-mono text-2xs text-ink-4">{path} (JSON)</span>
						<textarea
							className="field h-20 resize-y px-1.5 py-1 font-mono text-2xs"
							value={draft ?? JSON.stringify(effective ?? (s.type === "array" ? [] : {}), null, 2)}
							onChange={(e) => setDrafts((d) => ({ ...d, [path]: e.target.value }))}
							onBlur={() => {
								const text = draft ?? "";
								if (text.trim() === "") return;
								try {
									const parsed = JSON.parse(text) as unknown;
									setDrafts((d) => {
										const next = { ...d };
										delete next[path];
										return next;
									});
									void saveField(path, parsed);
								} catch {
									setError(`Invalid JSON for ${path}`);
								}
							}}
							spellCheck={false}
						/>
					</label>
				);
			}
			default:
				return null;
		}
	};

	return (
		<div className="flex flex-col gap-6">
			<div>
				<h2 className="meta">OMP Native Settings</h2>
				<p className="mt-1 text-xs text-ink-3">
					Read/write <code className="text-2xs">{configPath || "~/.omp/agent/config.yml"}</code>. Changes take effect on next session or restart.
				</p>
			</div>

			{tabs.map((tab) => {
				if (tab.settings.length === 0) return null;
				return (
					<div key={tab.id}>
						<h2 className="meta">{tab.label}</h2>
						<div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
							{tab.settings.map((s) => (
								<div key={s.path} title={s.description}>
									{field(s)}
								</div>
							))}
						</div>
					</div>
				);
			})}

			{savingField ? <div className="text-2xs text-ink-3">Saving {savingField}…</div> : null}

			<div>
				<button type="button" onClick={() => setShowRaw((v) => !v)} className="btn-secondary h-7 text-2xs">
					{showRaw ? "Hide" : "Show"} raw config.yml
				</button>
				{showRaw ? (
					<div className="mt-2">
						<textarea
							className="field h-96 w-full p-2 font-mono text-2xs"
							value={rawText}
							onChange={(e) => setRawText(e.target.value)}
							spellCheck={false}
						/>
						<div className="mt-2 flex items-center gap-3">
							<Button onClick={() => void saveRaw()} variant="ghost">Save raw config</Button>
							<Button onClick={() => void refresh()} variant="ghost">Reset</Button>
							{rawError ? <span className="text-xs text-danger">{rawError}</span> : null}
						</div>
					</div>
				) : null}
			</div>

			{note ? <div className="rounded border border-success/30 bg-success/5 p-2 text-xs text-success">{note}</div> : null}
			{error ? <div className="rounded border border-danger/40 bg-danger/5 p-2 text-xs text-danger">{error}</div> : null}
		</div>
	);
}
