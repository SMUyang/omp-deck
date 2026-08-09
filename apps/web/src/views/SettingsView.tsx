import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Download, Play, RotateCcw, Save, Square, X } from "lucide-react";
import type {
	BridgeInfo,
	BridgeName,
	EnvEntry,
	GateKnob,
	ListEnvSettingsResponse,
	MaintenanceGateState,
	NotificationLevel,
	PreludeResponse,
	StartCommand,
	TopologyContextInjectionState,
	TopologyRerankConfig,
	TopologyRerankHttpProtocol,
	UpdateTopologyRerankConfigRequest,
} from "@omp-deck/protocol";
import type { ModelInfo, ModelRef, ProviderInfo, VersionInfo } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { OAuthFlowModal } from "@/components/settings/OAuthFlowModal";
import { OmpSettingsForm } from "@/components/settings/OmpSettingsForm";
import { bridgesApi } from "@/lib/bridges-api";
import { settingsApi } from "@/lib/settings-api";
import { orientationApi } from "@/lib/orientation-api";
import { api } from "@/lib/api";
import { authApi } from "@/lib/auth-api";
import { playNotificationTone } from "@/lib/audio";
import { useNotificationPermission } from "@/lib/notifications";
import { useStore, type NotificationItem } from "@/lib/store";
import { THEMES, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import {
	buildPatchRequest,
	formatModelRef,
	parseModelRef,
	roleEntriesFromResponse,
	stripThinkingSuffix,
	type ModelRoleEntry,
	type ModelRolesResponse,
} from "./model-roles";

const SECTIONS = [
	{ id: "env", labelKey: "views.settings.section.env", descriptionKey: "views.settings.section.envDesc" },
	{ id: "providers", labelKey: "views.settings.section.providers", descriptionKey: "views.settings.section.providersDesc" },
	{ id: "cpa", labelKey: "views.settings.section.cpa", descriptionKey: "views.settings.section.cpaDesc" },
	{ id: "messaging", labelKey: "views.settings.section.messaging", descriptionKey: "views.settings.section.messagingDesc" },
	{ id: "orientation", labelKey: "views.settings.section.orientation", descriptionKey: "views.settings.section.orientationDesc" },
	{ id: "model-roles", labelKey: "views.settings.section.modelRoles", descriptionKey: "views.settings.section.modelRolesDesc" },
	{ id: "omp-config", labelKey: "views.settings.section.ompConfig", descriptionKey: "views.settings.section.ompConfigDesc" },
	{ id: "appearance", labelKey: "views.settings.section.appearance", descriptionKey: "views.settings.section.appearanceDesc" },
	{ id: "workspaces", labelKey: "views.settings.section.workspaces", descriptionKey: "views.settings.section.workspacesDesc" },
	{ id: "notifications", labelKey: "views.settings.section.notifications", descriptionKey: "views.settings.section.notificationsDesc" },
	{ id: "about", labelKey: "views.settings.section.about", descriptionKey: "views.settings.section.aboutDesc" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsView() {
	const { t } = useTranslation();
	const [params, setParams] = useSearchParams();
	const selected = normalizeSection(params.get("section"));

	function setSection(section: SectionId): void {
		const next = new URLSearchParams(params);
		next.set("section", section);
		setParams(next, { replace: true });
	}

	return (
		<Layout
			sidebar={{ content: <SettingsSideRail />, label: t("views.settings.nav") }}
			inspector={{ content: <SettingsInspector />, label: t("views.settings.detail") }}
			main={
				<div className="flex h-full min-h-0 flex-col">
					<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
						<div className="meta">{t("views.settings.title")}</div>
						<div className="text-xs text-ink-3">{t("views.settings.subtitle")}</div>
					</div>
					<div className="grid min-h-0 flex-1 grid-cols-[220px_1fr] overflow-hidden">
						<nav className="border-r border-line bg-paper-2/40 p-2">
							{SECTIONS.map((section) => (
								<button
									key={section.id}
									type="button"
									onClick={() => setSection(section.id)}
									className={cn(
										"mb-1 block w-full rounded-md px-2 py-2 text-left transition-colors",
										selected === section.id ? "bg-accent-soft text-accent" : "hover:bg-paper-3",
									)}
								>
									<div className="font-mono text-xs font-medium uppercase tracking-meta">
										{t(section.labelKey)}
									</div>
									<div className="mt-0.5 text-xs text-ink-3">{t(section.descriptionKey)}</div>
								</button>
							))}
						</nav>
						<section className="min-h-0 overflow-auto p-4">
							{selected === "env" ? (
								<EnvSection />
							) : selected === "providers" ? (
								<div className="flex flex-col gap-6">
									<ProvidersSection />
									<CustomProvidersSection />
								</div>
							) : selected === "cpa" ? (
								<CpaSection />
							) : selected === "messaging" ? (
								<MessagingSection />
							) : selected === "orientation" ? (
								<OrientationSection />
							) : selected === "appearance" ? (
								<AppearanceSection />
							) : selected === "model-roles" ? (
								<ModelRolesSection />
							) : selected === "omp-config" ? (
								<OmpConfigSection />
							) : selected === "notifications" ? (
								<NotificationsSection />
							) : selected === "about" ? (
								<AboutSection />
							) : (
								<StubSection section={selected} />
							)}
						</section>
					</div>
				</div>
			}
		/>
	);
}

function EnvSection() {
	const { t } = useTranslation();
	const [data, setData] = useState<ListEnvSettingsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [editing, setEditing] = useState<EnvEntry | null>(null);
	const [restartMessage, setRestartMessage] = useState<string | undefined>();

	async function refresh(): Promise<void> {
		try {
			const next = await settingsApi.listEnv();
			setData(next);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	const grouped = useMemo(() => {
		const entries = data?.entries ?? [];
		const isDeckKey = (key: string) =>
			key.startsWith("OMP_DECK_") ||
			key === "OMP_AGENT_DIR" ||
			key === "LOG_LEVEL" ||
			key === "PI_NO_TITLE" ||
			key === "OMP_MODEL";
		const isMessagingKey = (key: string) => key.startsWith("TELEGRAM_") || key.startsWith("SLACK_");
		return {
			deck: entries.filter((e) => isDeckKey(e.key)),
			messaging: entries.filter((e) => isMessagingKey(e.key)),
			sdk: entries.filter((e) => !isDeckKey(e.key) && !isMessagingKey(e.key)),
		};
	}, [data]);

	async function restart(): Promise<void> {
		try {
			const resp = await settingsApi.restartServer();
			setRestartMessage(resp.message || t("views.settings.env.restartScheduled"));
		} catch (e) {
			setError(String(e));
		}
	}

	return (
		<div className="mx-auto max-w-6xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{t("views.settings.env.title")}</h1>
				<p className="mt-1 max-w-3xl text-sm text-ink-3">
					{t("views.settings.env.intro")}
				</p>
			</div>

			{data?.restartRequired ? (
				<div className="flex items-center gap-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
					<div className="min-w-0 flex-1">
						{t("views.settings.env.restartRequired")}
					</div>
					<Button variant="outline" size="sm" onClick={() => void restart()}>
						<RotateCcw className="h-3.5 w-3.5" />
						{t("views.settings.env.restart")}
					</Button>
				</div>
			) : null}
			{restartMessage ? (
				<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
					{restartMessage}
				</div>
			) : null}
			{error ? (
				<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}

			<div className="rounded-md border border-line bg-paper-2 px-3 py-2 font-mono text-2xs text-ink-3">
				<div>dataDir: {data?.dataDir ?? "..."}</div>
				<div>envFile: {data?.envFilePath ?? "..."}</div>
			</div>

			{loading ? <div className="text-sm text-ink-3">{t("views.settings.loading")}</div> : null}
			{data ? (
				<>
					<EnvTable title={t("views.settings.env.deckTable")} entries={grouped.deck} onEdit={setEditing} />
					<EnvTable title={t("views.settings.env.messagingTable")} entries={grouped.messaging} onEdit={setEditing} />
					<EnvTable title={t("views.settings.env.sdkTable")} entries={grouped.sdk} onEdit={setEditing} />
				</>
			) : null}

			<EditEnvModal
				entry={editing}
				onClose={() => setEditing(null)}
				onSaved={(next) => {
					setData(next);
					setEditing(null);
				}}
			/>
		</div>
	);
}

function MessagingSection() {
	const { t } = useTranslation();
	const [data, setData] = useState<ListEnvSettingsResponse | null>(null);
	const [bridges, setBridges] = useState<BridgeInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [editing, setEditing] = useState<EnvEntry | null>(null);

	async function refresh(): Promise<void> {
		try {
			const [envResp, bridgeResp] = await Promise.all([settingsApi.listEnv(), bridgesApi.list()]);
			setData(envResp);
			setBridges(bridgeResp.bridges);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	// 4s polling. The settings page only mounts one section at a time, so
	// the interval is cleared automatically when the user switches to a
	// different section. The document.visibilityState check skips work
	// when the browser tab is in the background.
	useEffect(() => {
		// Skip the immediate fetch too when the tab is hidden — otherwise a
		// user opening Settings from a background tab would pay for two
		// network round-trips before the visibility check kicks in.
		if (document.visibilityState !== "visible") return;
		void refresh();
		const id = window.setInterval(() => {
			if (document.visibilityState === "visible") void refresh();
		}, 4000);
		return () => window.clearInterval(id);
	}, []);

	const entries = data?.entries ?? [];
	const telegramToken = entries.find((entry) => entry.key === "TELEGRAM_BOT_TOKEN");
	const telegramAllowed = entries.find((entry) => entry.key === "TELEGRAM_ALLOWED_USERS");
	const telegramDb = entries.find((entry) => entry.key === "TELEGRAM_BRIDGE_DB_PATH");
	const telegramInfo = bridges.find((b) => b.name === "telegram");

	function applyBridge(next: BridgeInfo): void {
		setBridges((prev) => {
			const idx = prev.findIndex((b) => b.name === next.name);
			if (idx === -1) return [...prev, next];
			const out = prev.slice();
			out[idx] = next;
			return out;
		});
	}

	return (
		<div className="mx-auto max-w-5xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{t("views.settings.messaging.title")}</h1>
				<p className="mt-1 max-w-3xl text-sm text-ink-3">
					{t("views.settings.messaging.intro")}
				</p>
			</div>

			{error ? (
				<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}
			{loading ? <div className="text-sm text-ink-3">{t("views.settings.loading")}</div> : null}

			<BridgeCard
				title="Telegram"
				description={t("views.settings.messaging.telegramDesc")}
				info={telegramInfo}
				credentialRows={[
					{ label: t("views.settings.messaging.botToken"), entry: telegramToken },
					{ label: t("views.settings.messaging.allowedUsers"), entry: telegramAllowed },
					{ label: t("views.settings.messaging.mappingDbPath"), entry: telegramDb },
				]}
				onEdit={setEditing}
				onApplyBridge={applyBridge}
				onError={setError}
			/>

			<div className="rounded-md border border-dashed border-line bg-paper-2 p-4">
				<div className="meta">Slack</div>
				<p className="mt-1 text-sm text-ink-3">
					{t("views.settings.messaging.slackHint")}
				</p>
			</div>

			<EditEnvModal
				entry={editing}
				onClose={() => setEditing(null)}
				onSaved={(next) => {
					setData(next);
					setEditing(null);
					void refresh();
				}}
			/>
		</div>
	);
}

function BridgeCard({
	title,
	description,
	info,
	credentialRows,
	onEdit,
	onApplyBridge,
	onError,
}: {
	title: string;
	description: string;
	info: BridgeInfo | undefined;
	credentialRows: Array<{ label: string; entry: EnvEntry | undefined }>;
	onEdit: (entry: EnvEntry) => void;
	onApplyBridge: (next: BridgeInfo) => void;
	onError: (message: string | undefined) => void;
}) {
	const { t } = useTranslation();
	const [busy, setBusy] = useState<"start" | "stop" | "restart" | undefined>();

	async function run(action: "start" | "stop" | "restart", name: BridgeName): Promise<void> {
		setBusy(action);
		onError(undefined);
		try {
			const next = await bridgesApi[action](name);
			onApplyBridge(next);
		} catch (e) {
			onError(String((e as Error).message ?? e));
		} finally {
			setBusy(undefined);
		}
	}

	const status = info?.status ?? "stopped";
	const missing = info?.missingEnv ?? [];
	const canStart = status !== "running" && status !== "starting" && missing.length === 0;
	const canStop = status === "running" || status === "starting";
	const canRestart = status === "running";

	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="flex items-center justify-between gap-3 border-b border-line bg-paper-2 px-3 py-2">
				<div>
					<div className="meta">{title}</div>
					<div className="mt-0.5 text-xs text-ink-3">{description}</div>
				</div>
				<div className="flex items-center gap-2">
					<Badge tone={bridgeStatusTone(status)}>{bridgeStatusLabel(status, info, t)}</Badge>
				</div>
			</div>
			<div className="space-y-3 p-3">
				{missing.length > 0 ? (
					<div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
						{t("views.settings.bridge.missingEnv", { names: missing.join(", ") })}
					</div>
				) : null}
				{info?.lastError ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{info.lastError}
					</div>
				) : null}
				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant="primary"
						size="sm"
						disabled={!canStart || busy !== undefined}
						onClick={() => info && void run("start", info.name)}
					>
						<Play className="h-3.5 w-3.5" />
						{busy === "start" ? t("views.settings.bridge.starting") : t("views.settings.bridge.start")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={!canStop || busy !== undefined}
						onClick={() => info && void run("stop", info.name)}
					>
						<Square className="h-3.5 w-3.5" />
						{busy === "stop" ? t("views.settings.bridge.stopping") : t("views.settings.bridge.stop")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={!canRestart || busy !== undefined}
						onClick={() => info && void run("restart", info.name)}
					>
						<RotateCcw className="h-3.5 w-3.5" />
						{busy === "restart" ? t("views.settings.bridge.restarting") : t("views.settings.bridge.restart")}
					</Button>
					{info ? <BridgeMeta info={info} /> : null}
				</div>
				<div className="divide-y divide-line rounded-md border border-line">
					{credentialRows.map((row) => (
						<MessagingCredentialRow key={row.label} label={row.label} entry={row.entry} onEdit={onEdit} />
					))}
				</div>
				{info ? <BridgeLogsPanel name={info.name} /> : null}
			</div>
		</div>
	);
}

function BridgeMeta({ info }: { info: BridgeInfo }) {
	const { t } = useTranslation();
	const parts: string[] = [];
	if (info.status === "running") {
		if (info.pid !== undefined) parts.push(t("views.settings.bridge.pid", { pid: info.pid }));
		if (info.startedAt) parts.push(t("views.settings.bridge.up", { uptime: formatUptime(info.startedAt) }));
	} else if (info.exitCode !== undefined) {
		parts.push(t("views.settings.bridge.exit", { code: info.exitCode }));
	}
	if (info.crashCount > 0) parts.push(t("views.settings.bridge.crashes", { count: info.crashCount }));
	if (parts.length === 0) return null;
	return <div className="font-mono text-2xs text-ink-3">{parts.join(" · ")}</div>;
}
function BridgeLogsPanel({ name }: { name: BridgeName }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [lines, setLines] = useState<Array<{ stream: string; text: string; timestamp: string }>>([]);
	const [fetching, setFetching] = useState(false);

	async function load(): Promise<void> {
		setFetching(true);
		try {
			const resp = await bridgesApi.logs(name);
			setLines(resp.lines);
		} catch (e) {
			setLines([{ stream: "stderr", text: String(e), timestamp: new Date().toISOString() }]);
		} finally {
			setFetching(false);
		}
	}

	useEffect(() => {
		if (!open) return;
		// Skip the immediate fetch when the tab is hidden, same reason as
		// MessagingSection.
		if (document.visibilityState !== "visible") return;
		void load();
		const id = window.setInterval(() => {
			if (document.visibilityState === "visible") void load();
		}, 2500);
		return () => window.clearInterval(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, name]);
	return (
		<div className="rounded-md border border-line bg-paper-2">
			<button
				type="button"
				className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-ink-2 hover:bg-paper-3"
				onClick={() => setOpen((v) => !v)}
			>
				<span>{t("views.settings.bridge.logs")}</span>
				<span className="font-mono text-2xs text-ink-3">{open ? t("views.settings.bridge.hide") : t("views.settings.bridge.show")}</span>
			</button>
			{open ? (
				<div className="max-h-64 overflow-auto border-t border-line bg-paper p-2 font-mono text-2xs">
					{fetching && lines.length === 0 ? <div className="text-ink-3">{t("views.settings.loading")}</div> : null}
					{!fetching && lines.length === 0 ? <div className="text-ink-3">{t("views.settings.bridge.noLogLines")}</div> : null}
					{lines.map((line, idx) => (
						<div
							key={`${line.timestamp}-${idx}`}
							className={cn("whitespace-pre-wrap", line.stream === "stderr" ? "text-danger" : "text-ink-2")}
						>
							{line.text}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

function MessagingCredentialRow({
	label,
	entry,
	onEdit,
}: {
	label: string;
	entry: EnvEntry | undefined;
	onEdit: (entry: EnvEntry) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="grid grid-cols-[160px_1fr_120px] items-center gap-3 px-3 py-2 text-sm">
			<div>
				<div className="font-medium text-ink">{label}</div>
				<div className="font-mono text-2xs text-ink-4">{entry?.key ?? t("views.settings.env.missingSchema")}</div>
			</div>
			<div className="min-w-0">
				<div className="truncate font-mono text-xs text-ink-2">{entry?.masked ?? t("views.settings.env.unavailable")}</div>
				<div className="mt-0.5 flex flex-wrap gap-1">
					{entry ? <Badge tone={sourceTone(entry.source)}>{sourceLabel(entry.source, t)}</Badge> : null}
					{entry ? envApplyBadge(entry, t) : null}
				</div>
			</div>
			<div className="flex justify-end">
				<Button variant="outline" size="sm" disabled={!entry} onClick={() => entry && onEdit(entry)}>
					{t("views.settings.env.replace")}
				</Button>
			</div>
		</div>
	);
}

function EnvTable({
	title,
	entries,
	onEdit,
}: {
	title: string;
	entries: EnvEntry[];
	onEdit: (entry: EnvEntry) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="meta">{title}</div>
			</div>
			<div className="divide-y divide-line">
				{entries.map((entry) => (
					<div key={entry.key} className="grid grid-cols-[220px_1fr_120px_100px] gap-3 px-3 py-2 text-sm">
						<div className="min-w-0">
							<div className="truncate font-mono text-xs font-medium text-ink">{entry.key}</div>
							<div className="mt-0.5 text-xs text-ink-4">{entry.valueType}</div>
						</div>
						<div className="min-w-0">
							<div className="truncate font-mono text-xs text-ink-2">{entry.masked}</div>
							<div className="mt-0.5 truncate text-xs text-ink-3">{entry.description}</div>
						</div>
						<div className="flex flex-col items-start gap-1">
							<Badge tone={sourceTone(entry.source)}>{sourceLabel(entry.source, t)}</Badge>
							{envApplyBadge(entry, t)}
						</div>
						<div className="flex justify-end">
							<Button variant="outline" size="sm" onClick={() => onEdit(entry)}>
								{t("views.settings.env.replace")}
							</Button>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

function EditEnvModal({
	entry,
	onClose,
	onSaved,
}: {
	entry: EnvEntry | null;
	onClose: () => void;
	onSaved: (next: ListEnvSettingsResponse) => void;
}) {
	const { t } = useTranslation();
	const [value, setValue] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		if (!entry) return;
		setValue(entry.sensitive ? "" : entry.source === "unset" ? "" : entry.masked);
		setError(undefined);
	}, [entry]);

	if (!entry) return null;

	async function save(nextValue: string | null): Promise<void> {
		if (!entry) return;
		setSaving(true);
		try {
			const next = await settingsApi.patchEnv({ [entry.key]: nextValue });
			onSaved(next);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Modal open={Boolean(entry)} onClose={onClose} widthClass="max-w-xl">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="min-w-0 flex-1">
					<div className="truncate font-mono text-xs font-semibold text-ink">{entry.key}</div>
					<div className="text-xs text-ink-3">{t("views.settings.env.writesToEnv")}</div>
				</div>
				<Button variant="ghost" size="icon" onClick={onClose} aria-label={t("views.settings.close")}>
					<X className="h-4 w-4" />
				</Button>
			</div>
			<div className="space-y-3 overflow-auto p-4">
				<div className="flex flex-wrap gap-1.5">
					<Badge tone={sourceTone(entry.source)}>{sourceLabel(entry.source, t)}</Badge>
					{entry.sensitive ? <Badge tone="danger">{t("views.settings.env.secret")}</Badge> : null}
					{entry.restartRequired ? <Badge tone="warn">{t("views.settings.env.restartRequired")}</Badge> : <Badge tone="success">{t("views.settings.env.hotApply")}</Badge>}
				</div>
				<p className="text-sm text-ink-3">{entry.description}</p>
				{entry.source === "process-env" ? (
					<div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
						{t("views.settings.env.processEnvWarning")}
					</div>
				) : null}
				<label className="block">
					<div className="meta mb-1">{t("views.settings.env.newValue")}</div>
					<input
						className="field h-9 w-full px-2 font-mono text-sm"
						type={entry.sensitive ? "password" : "text"}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						placeholder={entry.sensitive ? t("views.settings.env.pasteValue") : entry.defaultValue ?? t("views.settings.env.unset")}
					/>
				</label>
				{entry.options ? (
					<div className="text-xs text-ink-3">{t("views.settings.env.allowed", { list: entry.options.join(", ") })}</div>
				) : null}
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
			</div>
			<div className="flex items-center justify-between gap-2 border-t border-line px-3 py-3">
				<Button variant="danger" size="sm" disabled={saving} onClick={() => void save(null)}>
					{t("views.settings.env.unset")}
				</Button>
				<div className="flex gap-2">
					<Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
						{t("views.settings.cancel")}
					</Button>
					<Button variant="primary" size="sm" onClick={() => void save(value)} disabled={saving}>
						<Save className="h-3.5 w-3.5" />
						{t("views.settings.save")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}

function AppearanceSection() {
	const { t } = useTranslation();
	const theme = useTheme();
	return (
		<div className="mx-auto max-w-5xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{t("views.settings.appearance.title")}</h1>
				<p className="mt-1 max-w-3xl text-sm text-ink-3">
					{t("views.settings.appearance.intro")}
				</p>
			</div>

			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				{THEMES.map((def) => (
					<ThemeCard
						key={def.id}
						definition={def}
						isActive={theme.active === def.id}
						isPinned={theme.stored === def.id}
						onPick={() => theme.set(def.id)}
					/>
				))}
			</div>

			<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-paper-2 px-3 py-2 text-sm">
				<div className="min-w-0">
					<div className="meta">{t("views.settings.appearance.systemPreference")}</div>
					<div className="mt-0.5 text-xs text-ink-3">
						{theme.usingSystem
							? t("views.settings.appearance.followingOs", { os: theme.systemPreferred })
							: t("views.settings.appearance.pinnedTo", { stored: theme.stored, os: theme.systemPreferred })}
					</div>
				</div>
				<Button
					variant="outline"
					size="sm"
					disabled={theme.usingSystem}
					onClick={() => theme.clear()}
				>
					{t("views.settings.appearance.matchSystem")}
				</Button>
			</div>

			<div className="overflow-hidden rounded-md border border-line bg-paper">
				<div className="border-b border-line bg-paper-2 px-3 py-2">
					<div className="meta">{t("views.settings.appearance.fontPreview")}</div>
					<div className="mt-0.5 text-xs text-ink-3">{t("views.settings.appearance.fontPreviewHint")}</div>
				</div>
				<div className="space-y-3 p-4">
					<div>
						<div className="meta mb-1">{t("views.settings.appearance.sans")}</div>
						<div className="font-sans text-base text-ink">
							{t("views.settings.appearance.sansSample")}
						</div>
					</div>
					<div>
						<div className="meta mb-1">{t("views.settings.appearance.mono")}</div>
						<div className="rounded-md border border-line bg-paper-code px-3 py-2 font-mono text-xs text-ink-2">
							{"const status = await bridgesApi.start(\"telegram\");"}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * Notifications settings — surfaces the bits T-85 already plumbed:
 * browser-permission state with a request CTA, audio toggle, per-level tone
 * preview, a way to re-show the dismissed permission banner, server identity
 * pulled from the heartbeat frame, and a tail of the in-app notification log.
 */
function NotificationsSection() {
	const { t } = useTranslation();
	const {
		permission,
		requestPermission,
		audioEnabled,
		setAudioEnabled,
		bannerDismissed,
	} = useNotificationPermission();
	const heartbeat = useStore((s) => s.heartbeat);
	const notifications = useStore((s) => s.notifications);
	const dismissNotification = useStore((s) => s.dismissNotification);

	// Show the freshest notifications first; cap to keep the panel tidy.
	// We don't filter by `dismissed` here on purpose — the user dismissed
	// the toast, not the historical record.
	const recent = useMemo(
		() => notifications.slice().reverse().slice(0, 20),
		[notifications],
	);

	// Heartbeat-age clock so "5s ago" updates without re-receiving a frame.
	// Ticks only while the tab is visible and the panel is mounted; cheap
	// when hidden because we never reach the setState call.
	const [nowMs, setNowMs] = useState(() => Date.now());
	useEffect(() => {
		const handle = window.setInterval(() => {
			if (document.visibilityState === "visible") setNowMs(Date.now());
		}, 1000);
		return () => window.clearInterval(handle);
	}, []);

	return (
		<div className="mx-auto max-w-3xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{t("views.settings.notifications.title")}</h1>
				<p className="mt-1 text-sm text-ink-3">
					{t("views.settings.notifications.intro")}
				</p>
			</div>

			<PermissionCard
				permission={permission}
				onRequest={() => void requestPermission()}
			/>

			<AudioCard
				audioEnabled={audioEnabled}
				onToggle={setAudioEnabled}
			/>

			<BannerResetCard
				bannerDismissed={bannerDismissed}
				permission={permission}
				onReset={() => {
					try {
						localStorage.removeItem("omp-deck:notifications:banner-dismissed");
					} catch {
						/* quota / private */
					}
					// The banner component reads the flag from localStorage on mount;
					// a reload is the simplest way to re-evaluate it everywhere it's
					// rendered without threading an extra store action through.
					window.location.reload();
				}}
			/>

			<ServerIdentityCard heartbeat={heartbeat} nowMs={nowMs} />

			<RecentNotificationsCard
				items={recent}
				onDismiss={(id) => dismissNotification(id)}
			/>
		</div>
	);
}

function PermissionCard({
	permission,
	onRequest,
}: {
	permission: ReturnType<typeof useNotificationPermission>["permission"];
	onRequest: () => void;
}) {
	const { t } = useTranslation();
	const tone =
		permission === "granted"
			? "success"
			: permission === "denied"
				? "danger"
				: permission === "unsupported"
					? "muted"
					: "warn";
	const label =
		permission === "granted"
			? t("views.settings.notifications.granted")
			: permission === "denied"
				? t("views.settings.notifications.denied")
				: permission === "unsupported"
					? t("views.settings.notifications.unsupported")
					: t("views.settings.notifications.notRequested");

	return (
		<div className="rounded-md border border-line bg-paper-2 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="meta">{t("views.settings.notifications.browserPermission")}</div>
					<div className="mt-0.5 text-sm text-ink">
						{t("views.settings.notifications.browserPermissionDesc")}
					</div>
				</div>
				<Badge tone={tone}>{label}</Badge>
			</div>
			<div className="mt-3 text-xs text-ink-3">
				{permission === "default" ? (
					<>{t("views.settings.notifications.permDefault")}</>
				) : permission === "granted" ? (
					<>{t("views.settings.notifications.permGranted")}</>
				) : permission === "denied" ? (
					<>{t("views.settings.notifications.permDenied")}</>
				) : (
					<>{t("views.settings.notifications.permUnsupported")}</>
				)}
			</div>
			{permission === "default" ? (
				<div className="mt-3">
					<Button size="sm" variant="primary" onClick={onRequest}>
						{t("views.settings.notifications.enable")}
					</Button>
				</div>
			) : null}
		</div>
	);
}

function AudioCard({
	audioEnabled,
	onToggle,
}: {
	audioEnabled: boolean;
	onToggle: (enabled: boolean) => void;
}) {
	const { t } = useTranslation();
	const levels: NotificationLevel[] = ["info", "warn", "error", "critical"];
	return (
		<div className="rounded-md border border-line bg-paper-2 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="meta">{t("views.settings.notifications.audioCues")}</div>
					<div className="mt-0.5 text-sm text-ink">
						{t("views.settings.notifications.audioCuesDesc")}
					</div>
				</div>
				<label className="flex items-center gap-2 text-xs text-ink-2">
					<input
						type="checkbox"
						checked={audioEnabled}
						onChange={(e) => onToggle(e.target.checked)}
					/>
					<span>{audioEnabled ? t("views.settings.notifications.enabled") : t("views.settings.notifications.muted")}</span>
				</label>
			</div>
			<div className="mt-3 flex flex-wrap gap-2">
				{levels.map((level) => (
					<Button
						key={level}
						size="sm"
						variant="outline"
						disabled={!audioEnabled}
						onClick={() => void playNotificationTone(level)}
					>
						<Play className="mr-1 h-3 w-3" />
						{level}
					</Button>
				))}
			</div>
			{!audioEnabled ? (
				<div className="mt-2 text-xs text-ink-3">{t("views.settings.notifications.enableAudioHint")}</div>
			) : null}
		</div>
	);
}

function BannerResetCard({
	bannerDismissed,
	permission,
	onReset,
}: {
	bannerDismissed: boolean;
	permission: ReturnType<typeof useNotificationPermission>["permission"];
	onReset: () => void;
}) {
	const { t } = useTranslation();
	// Banner only ever shows when permission is "default" AND not dismissed,
	// so the reset is only meaningful in that combination.
	const canReset = bannerDismissed && permission === "default";
	return (
		<div className="rounded-md border border-line bg-paper-2 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="meta">{t("views.settings.notifications.permissionBanner")}</div>
					<div className="mt-0.5 text-sm text-ink">
						{t("views.settings.notifications.permissionBannerDesc")}
					</div>
					<div className="mt-1 text-xs text-ink-3">
						{permission !== "default"
							? t("views.settings.notifications.bannerSuppressed")
							: bannerDismissed
								? t("views.settings.notifications.bannerDismissed")
								: t("views.settings.notifications.bannerVisible")}
					</div>
				</div>
				<Button
					size="sm"
					variant="outline"
					disabled={!canReset}
					onClick={onReset}
				>
					<RotateCcw className="mr-1 h-3 w-3" />
					{t("views.settings.notifications.resetBanner")}
				</Button>
			</div>
		</div>
	);
}

function ServerIdentityCard({
	heartbeat,
	nowMs,
}: {
	heartbeat:
		| {
				lastReceivedAtMs: number;
				serverStartedAt: string;
				pid: number;
				uptimeSecs: number;
				buildSha: string | null;
				version: string;
		  }
		| null;
	nowMs: number;
}) {
	const { t } = useTranslation();
	if (!heartbeat) {
		return (
			<div className="rounded-md border border-line bg-paper-2 p-4 text-xs text-ink-3">
				<div className="meta mb-1">{t("views.settings.serverIdentity")}</div>
				{t("views.settings.notifications.waitingHeartbeat")}
			</div>
		);
	}
	const ageMs = Math.max(0, nowMs - heartbeat.lastReceivedAtMs);
	const ageTone: "success" | "warn" | "danger" =
		ageMs < 10_000 ? "success" : ageMs < 30_000 ? "warn" : "danger";
	const ageLabel = ageMs < 1_000 ? t("views.settings.notifications.justNow") : t("views.settings.notifications.secondsAgo", { seconds: Math.round(ageMs / 1000) });
	const shortSha = heartbeat.buildSha ? heartbeat.buildSha.slice(0, 7) : t("views.settings.notifications.unknown");
	return (
		<div className="rounded-md border border-line bg-paper-2 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="meta">{t("views.settings.serverIdentity")}</div>
				<Badge tone={ageTone}>{t("views.settings.notifications.lastHeartbeat", { label: ageLabel })}</Badge>
			</div>
			<dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-xs text-ink-2">
				<dt className="text-ink-3">{t("views.settings.notifications.pid")}</dt>
				<dd>{heartbeat.pid}</dd>
				<dt className="text-ink-3">{t("views.settings.notifications.version")}</dt>
				<dd>{heartbeat.version}</dd>
				<dt className="text-ink-3">{t("views.settings.notifications.build")}</dt>
				<dd>{shortSha}</dd>
				<dt className="text-ink-3">{t("views.settings.notifications.started")}</dt>
				<dd>{new Date(heartbeat.serverStartedAt).toLocaleString()}</dd>
				<dt className="text-ink-3">{t("views.settings.notifications.uptime")}</dt>
				<dd>{formatUptime(heartbeat.serverStartedAt)}</dd>
			</dl>
		</div>
	);
}

function RecentNotificationsCard({
	items,
	onDismiss,
}: {
	items: ReadonlyArray<NotificationItem>;
	onDismiss: (id: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="meta">{t("views.settings.notifications.recentActivity")}</div>
				<div className="mt-0.5 text-xs text-ink-3">
					{t("views.settings.notifications.recentActivityDesc")}
				</div>
			</div>
			{items.length === 0 ? (
				<div className="px-3 py-6 text-center text-xs text-ink-3">
					{t("views.settings.notifications.noNotifications")}
				</div>
			) : (
				<ul className="divide-y divide-line">
					{items.map((item) => (
						<li
							key={item.id}
							className={cn(
								"flex items-start gap-3 px-3 py-2 text-sm",
								item.dismissed && "opacity-60",
							)}
						>
							<Badge tone={notificationLevelTone(item.level)}>{item.level}</Badge>
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium text-ink">{item.title}</div>
								{item.body ? (
									<div className="mt-0.5 text-xs text-ink-2">{item.body}</div>
								) : null}
								<div className="mt-1 font-mono text-2xs text-ink-3">
									{new Date(item.timestamp).toLocaleString()}
									{item.source ? ` · ${item.source}` : ""}
								</div>
							</div>
							{!item.dismissed ? (
								<Button
									size="sm"
									variant="ghost"
									onClick={() => onDismiss(item.id)}
									aria-label={t("views.settings.dismiss")}
									title={t("views.settings.dismiss")}
								>
									<X className="h-3 w-3" />
								</Button>
							) : null}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function notificationLevelTone(
	level: NotificationLevel,
): "default" | "accent" | "warn" | "danger" | "success" | "muted" {
	switch (level) {
		case "info":
			return "accent";
		case "warn":
			return "warn";
		case "error":
			return "danger";
		case "critical":
			return "danger";
		default:
			return "default";
	}
}

function ThemeCard({
	definition,
	isActive,
	isPinned,
	onPick,
}: {
	definition: (typeof THEMES)[number];
	isActive: boolean;
	isPinned: boolean;
	onPick: () => void;
}) {
	const { t } = useTranslation();
	return (
		<button
			type="button"
			onClick={onPick}
			data-theme-preview={definition.id}
			aria-pressed={isActive}
			className={cn(
				"group flex flex-col gap-3 rounded-md border bg-paper p-3 text-left transition-colors",
				isActive ? "border-accent ring-1 ring-accent/40" : "border-line hover:border-ink/30",
			)}
		>
			<div className="flex items-center justify-between gap-2">
				<div>
					<div className="text-sm font-semibold text-ink">{definition.label}</div>
					<div className="mt-0.5 text-xs text-ink-3">{definition.description}</div>
				</div>
				<div className="flex shrink-0 flex-col items-end gap-1">
					{isActive ? <Badge tone="accent">{t("views.settings.appearance.active")}</Badge> : null}
					{!isActive && isPinned ? <Badge tone="muted">{t("views.settings.appearance.pinned")}</Badge> : null}
				</div>
			</div>
			<ThemeSwatchStrip definition={definition} />
		</button>
	);
}

function ThemeSwatchStrip({ definition }: { definition: (typeof THEMES)[number] }) {
	// Render swatches inside an isolated `data-theme="..."` wrapper so each card
	// shows its OWN palette regardless of which theme the rest of the UI uses.
	return (
		<div
			data-theme={definition.id}
			className="grid grid-cols-4 gap-1.5 rounded-md border border-line/60 bg-paper p-1.5"
		>
			{definition.swatchTokens.map((s) => (
				<div key={s.token} className="flex flex-col items-stretch gap-1">
					<div
						className="h-8 w-full rounded"
						style={{ backgroundColor: `rgb(var(--${s.token}))` }}
					/>
					<div className="text-center font-mono text-2xs uppercase tracking-meta text-ink-3">
						{s.label}
					</div>
				</div>
			))}
		</div>
	);
}

/**
 * Orientation section — surfaces the three artifacts that shape every deck
 * session so non-developer users can view and tweak them without touching
 * server source. See kb://system/imperatives-belong-in-orchestrator-not-prelude
 * for the prelude-vs-orchestrator architecture that motivated this surface.
 */
function OrientationSection() {
	const { t } = useTranslation();
	return (
		<div className="mx-auto max-w-5xl space-y-6">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{t("views.settings.orientation.title")}</h1>
				<p className="mt-1 max-w-3xl text-sm text-ink-3">
					{t("views.settings.orientation.intro1")}{" "}
					<code className="font-mono text-xs">/start</code>{" "}
					{t("views.settings.orientation.intro2")}
				</p>
			</div>
			<PreludeCard />
			<StartCommandCard />
			<MaintenanceGateCard />
			<TopologyContextCard />
			<TopologyRerankCard />
			<TopologyEmbeddingCard />
		</div>
	);
}

function PreludeCard() {
	const { t } = useTranslation();
	const [data, setData] = useState<PreludeResponse | null>(null);
	const [draft, setDraft] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [status, setStatus] = useState<string | undefined>();

	async function refresh(): Promise<void> {
		try {
			const next = await orientationApi.getPrelude();
			setData(next);
			setDraft(next.override ?? next.default);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	const usingOverride = data ? data.override !== null : false;
	const dirty = data ? draft !== (data.override ?? data.default) : false;

	async function save(): Promise<void> {
		setSaving(true);
		try {
			const next = await orientationApi.putPrelude({ value: draft });
			setData(next);
			setDraft(next.override ?? next.default);
			setStatus(t("views.settings.orientation.preludeSaved"));
			setError(undefined);
			window.setTimeout(() => setStatus(undefined), 3000);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	async function resetToDefault(): Promise<void> {
		setSaving(true);
		try {
			const next = await orientationApi.putPrelude({ value: null });
			setData(next);
			setDraft(next.default);
			setStatus(t("views.settings.orientation.overrideCleared"));
			setError(undefined);
			window.setTimeout(() => setStatus(undefined), 3000);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="flex items-center gap-2">
					<div className="meta">{t("views.settings.orientation.prelude")}</div>
					{usingOverride ? <Badge tone="accent">{t("views.settings.orientation.override")}</Badge> : <Badge tone="muted">{t("views.settings.orientation.default")}</Badge>}
				</div>
				<p className="mt-1 text-xs text-ink-3">
					{t("views.settings.orientation.preludeDesc", { hook: "createAgentSession" })}{" "}
					<code className="font-mono">/start</code>
					{t("views.settings.orientation.preludeDesc2")}
				</p>
				<div className="mt-1 font-mono text-2xs text-ink-3">
					{data?.path ?? "..."}
				</div>
			</div>
			<div className="space-y-3 p-4">
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{status ? (
					<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
						{status}
					</div>
				) : null}
				{loading ? (
					<div className="text-sm text-ink-3">{t("views.settings.loading")}</div>
				) : (
					<>
						<textarea
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							spellCheck={false}
							className="block min-h-[320px] w-full resize-y rounded-md border border-line bg-paper-2 px-3 py-2 font-mono text-xs leading-relaxed text-ink"
						/>
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
								<Save className="h-3.5 w-3.5" />
								{t("views.settings.save")}
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => void resetToDefault()}
								disabled={saving || !usingOverride}
							>
								<RotateCcw className="h-3.5 w-3.5" />
								{t("views.settings.orientation.resetToDefault")}
							</Button>
							{dirty ? (
								<span className="font-mono text-2xs text-warn">{t("views.settings.unsavedChanges")}</span>
							) : null}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function StartCommandCard() {
	const { t } = useTranslation();
	const [data, setData] = useState<StartCommand | null>(null);
	const [description, setDescription] = useState("");
	const [body, setBody] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [status, setStatus] = useState<string | undefined>();

	async function refresh(): Promise<void> {
		try {
			const next = await orientationApi.getStartCommand();
			setData(next);
			setDescription(next.description);
			setBody(next.body);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	const dirty = data ? description !== data.description || body !== data.body : false;

	async function save(): Promise<void> {
		setSaving(true);
		try {
			const next = await orientationApi.putStartCommand({ description, body });
			setData(next);
			setDescription(next.description);
			setBody(next.body);
			setStatus(t("views.settings.orientation.startSaved"));
			setError(undefined);
			window.setTimeout(() => setStatus(undefined), 3000);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="flex items-center gap-2">
					<div className="meta">{t("views.settings.orientation.startOrchestrator")}</div>
					{data?.exists ? <Badge tone="default">{t("views.settings.orientation.onDisk")}</Badge> : <Badge tone="warn">{t("views.settings.orientation.missing")}</Badge>}
				</div>
				<p className="mt-1 text-xs text-ink-3">
					{t("views.settings.orientation.startDesc")}
				</p>
				<div className="mt-1 font-mono text-2xs text-ink-3">
					{data?.path ?? "..."}
				</div>
			</div>
			<div className="space-y-3 p-4">
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{status ? (
					<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
						{status}
					</div>
				) : null}
				{loading ? (
					<div className="text-sm text-ink-3">{t("views.settings.loading")}</div>
				) : (
					<>
						<label className="block space-y-1">
							<span className="meta">{t("views.settings.orientation.description")}</span>
							<input
								type="text"
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder={t("views.settings.orientation.descriptionPlaceholder")}
								className="block w-full rounded-md border border-line bg-paper-2 px-3 py-2 font-mono text-xs text-ink"
							/>
						</label>
						<label className="block space-y-1">
							<span className="meta">{t("views.settings.orientation.body")}</span>
							<textarea
								value={body}
								onChange={(e) => setBody(e.target.value)}
								spellCheck={false}
								className="block min-h-[280px] w-full resize-y rounded-md border border-line bg-paper-2 px-3 py-2 font-mono text-xs leading-relaxed text-ink"
							/>
						</label>
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
								<Save className="h-3.5 w-3.5" />
								{t("views.settings.save")}
							</Button>
							{dirty ? (
								<span className="font-mono text-2xs text-warn">{t("views.settings.unsavedChanges")}</span>
							) : null}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function MaintenanceGateCard() {
	const { t } = useTranslation();
	const [data, setData] = useState<MaintenanceGateState | null>(null);
	const [draft, setDraft] = useState<{
		enabled: boolean;
		minOpMsgs: string;
		minReleaseAgeMs: string;
		fireFloorMs: string;
	} | null>(null);
	const [previewMode, setPreviewMode] = useState<"deck" | "flat-file">("deck");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [status, setStatus] = useState<string | undefined>();

	async function refresh(): Promise<void> {
		try {
			const next = await orientationApi.getMaintenanceGate();
			setData(next);
			setDraft({
				enabled: next.enabled,
				minOpMsgs: String(next.knobs.minOpMsgs.rawValue ?? ""),
				minReleaseAgeMs: String(next.knobs.minReleaseAgeMs.rawValue ?? ""),
				fireFloorMs: String(next.knobs.fireFloorMs.rawValue ?? ""),
			});
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	function parseKnob(value: string): number | null {
		const trimmed = value.trim();
		if (trimmed === "") return null;
		const n = Number.parseInt(trimmed, 10);
		return Number.isFinite(n) && n > 0 ? n : NaN;
	}

	async function save(): Promise<void> {
		if (!draft) return;
		const parsedOp = parseKnob(draft.minOpMsgs);
		const parsedRel = parseKnob(draft.minReleaseAgeMs);
		const parsedFire = parseKnob(draft.fireFloorMs);
		if (Number.isNaN(parsedOp) || Number.isNaN(parsedRel) || Number.isNaN(parsedFire)) {
			setError(t("views.settings.orientation.gateKnobError"));
			return;
		}
		setSaving(true);
		try {
			const next = await orientationApi.putMaintenanceGate({
				enabled: draft.enabled,
				minOpMsgs: parsedOp,
				minReleaseAgeMs: parsedRel,
				fireFloorMs: parsedFire,
			});
			setData(next);
			setDraft({
				enabled: next.enabled,
				minOpMsgs: String(next.knobs.minOpMsgs.rawValue ?? ""),
				minReleaseAgeMs: String(next.knobs.minReleaseAgeMs.rawValue ?? ""),
				fireFloorMs: String(next.knobs.fireFloorMs.rawValue ?? ""),
			});
			setStatus(t("views.settings.orientation.gateSaved"));
			setError(undefined);
			window.setTimeout(() => setStatus(undefined), 3000);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	const profile: "deck" | "flat-file" | "inactive" = !data
		? "inactive"
		: !data.enabled
			? "inactive"
			: data.orgRoot
				? "deck"
				: "flat-file";

	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="flex items-center gap-2">
					<div className="meta">{t("views.settings.orientation.maintenanceGate")}</div>
					{profile === "deck" ? <Badge tone="accent">{t("views.settings.orientation.deckProfile")}</Badge> : null}
					{profile === "flat-file" ? <Badge tone="default">{t("views.settings.orientation.flatFileProfile")}</Badge> : null}
					{profile === "inactive" ? <Badge tone="muted">{t("views.settings.orientation.inactive")}</Badge> : null}
				</div>
				<p className="mt-1 text-xs text-ink-3">
					{t("views.settings.orientation.gateDesc", { hook: "turn_end" })}
				</p>
				<div className="mt-1 space-y-0.5 font-mono text-2xs text-ink-3">
					<div>{t("views.settings.orientation.gateExtension", { path: data?.installedExtensionPath ?? "..." })}</div>
					<div>{t("views.settings.orientation.gateInstalled", { value: data ? (data.installedExtensionPresent ? t("views.settings.orientation.yes") : t("views.settings.orientation.missing")) : "..." })}</div>
					<div>OMP_DECK_ORG_ROOT: {data?.orgRoot ?? t("views.settings.orientation.unset")} ({data?.orgRootSource ?? ""})</div>
				</div>
			</div>
			<div className="space-y-4 p-4">
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{status ? (
					<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
						{status}
					</div>
				) : null}
				{loading || !draft || !data ? (
					<div className="text-sm text-ink-3">Loading...</div>
				) : (
					<>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={draft.enabled}
								onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
							/>
							<span>{t("views.settings.orientation.enabled")}</span>
							<span className="ml-2 font-mono text-2xs text-ink-3">
								OMP_DECK_MAINTENANCE_GATE_DISABLED = {data.disabledRaw ?? t("views.settings.orientation.unset")} ({data.disabledSource})
							</span>
						</label>

						<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
							<GateKnobInput
								label="minOpMsgs"
								help={t("views.settings.orientation.minOpMsgsHelp")}
								knob={data.knobs.minOpMsgs}
								value={draft.minOpMsgs}
								onChange={(v) => setDraft({ ...draft, minOpMsgs: v })}
							/>
							<GateKnobInput
								label="minReleaseAgeMs"
								help={t("views.settings.orientation.minReleaseAgeMsHelp")}
								knob={data.knobs.minReleaseAgeMs}
								value={draft.minReleaseAgeMs}
								onChange={(v) => setDraft({ ...draft, minReleaseAgeMs: v })}
							/>
							<GateKnobInput
								label="fireFloorMs"
								help={t("views.settings.orientation.fireFloorMsHelp")}
								knob={data.knobs.fireFloorMs}
								value={draft.fireFloorMs}
								onChange={(v) => setDraft({ ...draft, fireFloorMs: v })}
							/>
						</div>

						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" onClick={() => void save()} disabled={saving}>
								<Save className="h-3.5 w-3.5" />
								{t("views.settings.save")}
							</Button>
							<Button size="sm" variant="outline" onClick={() => void refresh()} disabled={saving}>
								<RotateCcw className="h-3.5 w-3.5" />
								{t("views.settings.reload")}
							</Button>
							{!data.installedExtensionPresent ? (
								<span className="font-mono text-2xs text-warn">
									{t("views.settings.orientation.extensionMissing")}
								</span>
							) : null}
						</div>

						<div className="overflow-hidden rounded-md border border-line bg-paper-2">
							<div className="flex items-center gap-2 border-b border-line px-3 py-2">
								<div className="meta">{t("views.settings.orientation.reminderPreview")}</div>
								<div className="ml-auto flex items-center gap-1">
									<Button
										size="sm"
										variant={previewMode === "deck" ? "primary" : "outline"}
										onClick={() => setPreviewMode("deck")}
									>
										{t("views.settings.orientation.deck")}
									</Button>
									<Button
										size="sm"
										variant={previewMode === "flat-file" ? "primary" : "outline"}
										onClick={() => setPreviewMode("flat-file")}
									>
										{t("views.settings.orientation.flatFile")}
									</Button>
								</div>
							</div>
							<pre className="overflow-x-auto whitespace-pre-wrap px-3 py-2 font-mono text-2xs leading-relaxed text-ink-2">
								{previewMode === "deck" ? data.preview.deckMode : data.preview.flatFileMode}
							</pre>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function parseNonNegativeNumberOrNull(value: string): number | null {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const n = Number.parseFloat(trimmed);
	return Number.isFinite(n) && n >= 0 ? n : NaN;
}
function parsePositiveIntegerOrNull(value: string): number | null {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const n = Number.parseInt(trimmed, 10);
	return Number.isFinite(n) && n > 0 ? n : NaN;
}
function parseFloatRange(value: string, min: number, max: number): number {
	const trimmed = value.trim();
	if (trimmed === "") return NaN;
	const n = Number.parseFloat(trimmed);
	if (!Number.isFinite(n) || n < min || n > max) return NaN;
	return n;
}

function TopologyContextCard() {
	const { t } = useTranslation();
	const [data, setData] = useState<TopologyContextInjectionState | null>(null);
	const [draft, setDraft] = useState<{
		enabled: boolean;
		apiBase: string;
		maxFocusChars: string;
		timeoutMs: string;
	} | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [status, setStatus] = useState<string | undefined>();

	function applyState(next: TopologyContextInjectionState): void {
		setData(next);
		setDraft({
			enabled: next.enabled,
			apiBase: String(next.apiBase.rawValue ?? ""),
			maxFocusChars: String(next.maxFocusChars.rawValue ?? ""),
			timeoutMs: String(next.timeoutMs.rawValue ?? ""),
		});
	}

	async function refresh(): Promise<void> {
		try {
			applyState(await orientationApi.getTopologyContextInjection());
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	async function save(): Promise<void> {
		if (!draft) return;
		const maxFocusChars = parsePositiveIntegerOrNull(draft.maxFocusChars);
		const timeoutMs = parsePositiveIntegerOrNull(draft.timeoutMs);
		if (Number.isNaN(maxFocusChars) || Number.isNaN(timeoutMs)) {
			setError(t("views.settings.orientation.ctxIntError"));
			return;
		}
		setSaving(true);
		try {
			const next = await orientationApi.putTopologyContextInjection({
				enabled: draft.enabled,
				apiBase: draft.apiBase.trim() || null,
				maxFocusChars,
				timeoutMs,
			});
			applyState(next);
			setStatus(t("views.settings.saved"));
			setError(undefined);
			window.setTimeout(() => setStatus(undefined), 3000);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="flex items-center gap-2">
					<div className="meta">{t("views.settings.orientation.ctxInjection")}</div>
					{data?.active ? <Badge tone="accent">{t("views.settings.orientation.active")}</Badge> : (data?.enabled ? <Badge tone="default">{t("views.settings.orientation.inactive")}</Badge> : <Badge tone="muted">{t("views.settings.orientation.disabled")}</Badge>)}
					{data?.installStatus !== "current" && data?.installStatus === "user-owned-or-outdated" ? <Badge tone="warn">{t("views.settings.orientation.userOwned")}</Badge> : null}
				</div>
				<p className="mt-1 text-xs text-ink-3">
					{t("views.settings.orientation.ctxDesc")}
				</p>
				<div className="mt-1 space-y-0.5 font-mono text-2xs text-ink-3">
					<div>{t("views.settings.orientation.ctxInstalled", { path: data?.installedExtensionPath ?? "..." })}</div>
					<div>{t("views.settings.orientation.ctxBundled", { path: data?.bundledExtensionPath ?? "..." })}</div>
					<div>{t("views.settings.orientation.ctxApiBase", { value: data?.apiBase.value ?? "...", source: data?.apiBase.source ?? "" })}</div>
				</div>
			</div>
			<div className="space-y-4 p-4">
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{status ? (
					<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
						{status}
					</div>
				) : null}
				{loading || !draft || !data ? (
					<div className="text-sm text-ink-3">Loading...</div>
				) : (
					<>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={draft.enabled}
								onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
							/>
							<span>{t("views.settings.orientation.enabled")}</span>
							<span className="ml-2 font-mono text-2xs text-ink-3">
								OMP_DECK_TOPOLOGY_CONTEXT_ENABLED = {data.enabledRaw ?? t("views.settings.orientation.unset")} ({data.enabledSource})
							</span>
						</label>

						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<label className="block space-y-1 sm:col-span-2">
								<span className="meta">apiBase</span>
								<input
									type="text"
									value={draft.apiBase}
									onChange={(e) => setDraft({ ...draft, apiBase: e.target.value })}
									placeholder={String(data.apiBase.default)}
									className="block w-full rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-xs text-ink"
								/>
								<div className="font-mono text-2xs text-ink-3">
									{t("views.settings.orientation.ctxApiBaseHint", { value: data.apiBase.value, source: data.apiBase.source })}
								</div>
							</label>
							<GateKnobInput
								label="maxFocusChars"
								help={t("views.settings.orientation.maxFocusCharsHelp")}
								knob={data.maxFocusChars}
								value={draft.maxFocusChars}
								onChange={(v) => setDraft({ ...draft, maxFocusChars: v })}
							/>
							<GateKnobInput
								label="timeoutMs"
								help={t("views.settings.orientation.timeoutMsHelp")}
								knob={data.timeoutMs}
								value={draft.timeoutMs}
								onChange={(v) => setDraft({ ...draft, timeoutMs: v })}
							/>
						</div>

						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" onClick={() => void save()} disabled={saving}>
								<Save className="h-3.5 w-3.5" />
								{t("views.settings.save")}
							</Button>
							<Button size="sm" variant="outline" onClick={() => void refresh()} disabled={saving}>
								<RotateCcw className="h-3.5 w-3.5" />
								{t("views.settings.reload")}
							</Button>
							{!data.installedExtensionPresent ? (
								<span className="font-mono text-2xs text-warn">
									{t("views.settings.orientation.ctxExtMissing")}
								</span>
							) : null}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function TopologyRerankCard() {
	const { t } = useTranslation();
	const [data, setData] = useState<TopologyRerankConfig | null>(null);
	const [draft, setDraft] = useState<{
		enabled: boolean;
		rerankModelRole: string;
		minContextPercent: string;
		minCandidateNodes: string;
		localConfidenceBelow: string;
		timeoutMs: string;
		provider: "model_role" | "http";
		http: {
			baseUrl: string;
			endpointPath: string;
			protocol: TopologyRerankHttpProtocol;
			timeoutMs: string;
			confidenceThreshold: string;
			minCandidateNodes: string;
			minContextPercent: string;
			authHeaderName: string;
			model: string;
		};
	} | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [status, setStatus] = useState<string | undefined>();

	function applyState(next: TopologyRerankConfig): void {
		setData(next);
		const provider: "model_role" | "http" = next.provider.value === "http" ? "http" : "model_role";
		setDraft({
			enabled: next.enabled,
			rerankModelRole: String(next.rerankModelRoleRaw ?? ""),
			provider,
			minContextPercent: String(next.minContextPercent.rawValue ?? ""),
			minCandidateNodes: String(next.minCandidateNodes.rawValue ?? ""),
			localConfidenceBelow: String(next.localConfidenceBelow.rawValue ?? ""),
			timeoutMs: String(next.timeoutMs.rawValue ?? ""),
			http: {
				baseUrl: String(next.http.baseUrl.rawValue ?? ""),
				protocol: (next.http.protocol.rawValue as TopologyRerankHttpProtocol | undefined) ?? "deck-internal",
				endpointPath: String(next.http.endpointPath.rawValue ?? ""),
				timeoutMs: String(next.http.timeoutMs.rawValue ?? ""),
				confidenceThreshold: String(next.http.confidenceThreshold.rawValue ?? ""),
				minCandidateNodes: String(next.http.minCandidateNodes.rawValue ?? ""),
				minContextPercent: String(next.http.minContextPercent.rawValue ?? ""),
				model: String(next.http.model.rawValue ?? ""),
				authHeaderName: String(next.http.authHeaderName.rawValue ?? ""),
			},
		});
	}

	async function refresh(): Promise<void> {
		try {
			applyState(await orientationApi.getTopologyRerankConfig());
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	async function save(): Promise<void> {
		if (!draft) return;
		const minContextPercent = parseNonNegativeNumberOrNull(draft.minContextPercent);
		const minCandidateNodes = parsePositiveIntegerOrNull(draft.minCandidateNodes);
		const timeoutMs = parsePositiveIntegerOrNull(draft.timeoutMs);
		const confidence = parseFloatRange(draft.localConfidenceBelow, 0, 1);
		const httpTimeoutMs = parsePositiveIntegerOrNull(draft.http.timeoutMs);
		const httpMinCandidateNodes = parsePositiveIntegerOrNull(draft.http.minCandidateNodes);
		const httpConfidence = parseFloatRange(draft.http.confidenceThreshold, 0, 1);
		const httpMinContextPercent = parseNonNegativeNumberOrNull(draft.http.minContextPercent);
		if (Number.isNaN(minCandidateNodes) || Number.isNaN(timeoutMs) || Number.isNaN(httpTimeoutMs) || Number.isNaN(httpMinCandidateNodes)) {
			setError(t("views.settings.orientation.intKnobError"));
			return;
		}
		if (Number.isNaN(minContextPercent) || Number.isNaN(httpMinContextPercent)) {
			setError(t("views.settings.orientation.percentKnobError"));
			return;
		}
		if (Number.isNaN(confidence) && draft.localConfidenceBelow.trim() !== "") {
			setError(t("views.settings.orientation.confidenceError"));
			return;
		}
		if (Number.isNaN(httpConfidence) && draft.http.confidenceThreshold.trim() !== "") {
			setError(t("views.settings.orientation.httpConfidenceError"));
			return;
		}
		setSaving(true);
		try {
			const next = await orientationApi.putTopologyRerankConfig({
				enabled: draft.enabled,
				rerankModelRole: draft.rerankModelRole.trim() || null,
				provider: draft.provider,
				minContextPercent,
				minCandidateNodes,
				localConfidenceBelow: Number.isNaN(confidence) ? null : confidence,
				timeoutMs,
				http: {
					baseUrl: draft.http.baseUrl.trim() || null,
					endpointPath: draft.http.endpointPath.trim() || null,
					protocol: (draft.http.protocol as TopologyRerankHttpProtocol) || null,
					timeoutMs: httpTimeoutMs,
					confidenceThreshold: Number.isNaN(httpConfidence) ? null : httpConfidence,
					minCandidateNodes: httpMinCandidateNodes,
					model: draft.http.model.trim() || null,
					minContextPercent: httpMinContextPercent,
					authHeaderName: draft.http.authHeaderName.trim() || null,
				},
			});
			applyState(next);
			setStatus(t("views.settings.saved"));
			setError(undefined);
			window.setTimeout(() => setStatus(undefined), 3000);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="flex items-center gap-2">
					<div className="meta">{t("views.settings.orientation.topologyRerank")}</div>
					{data?.enabled ? <Badge tone="accent">{t("views.settings.orientation.enabled")}</Badge> : <Badge tone="muted">{t("views.settings.orientation.disabled")}</Badge>}
				</div>
				<p className="mt-1 text-xs text-ink-3">
					{t("views.settings.orientation.rerankDesc")}
				</p>
				<div className="mt-1 font-mono text-2xs text-ink-3">
					{t("views.settings.orientation.rerankModelRoleLine", { role: data?.rerankModelRole ?? "...", roleSource: data?.rerankModelRoleSource ?? "", provider: data?.provider.value ?? "...", providerSource: data?.provider.source ?? "" })}
				</div>
			</div>
			<div className="space-y-4 p-4">
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{status ? (
					<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
						{status}
					</div>
				) : null}
				{loading || !draft || !data ? (
					<div className="text-sm text-ink-3">Loading...</div>
				) : (
					<>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={draft.enabled}
								onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
							/>
							<span>{t("views.settings.orientation.enabled")}</span>
							<span className="ml-2 font-mono text-2xs text-ink-3">
								OMP_DECK_TOPOLOGY_RERANK_ENABLED = {data.enabledRaw ?? t("views.settings.orientation.unset")} ({data.enabledSource})
							</span>
						</label>

						<div className="space-y-1">
							<span className="meta">{t("views.settings.orientation.provider")}</span>
							<div className="flex flex-wrap items-center gap-3 text-sm">
								<label className="flex items-center gap-1">
									<input
										type="radio"
										name="topology-rerank-provider"
										checked={draft.provider === "model_role"}
										onChange={() => setDraft({ ...draft, provider: "model_role" })}
									/>
									<span>{t("views.settings.orientation.modelRoleProvider")}</span>
								</label>
								<label className="flex items-center gap-1">
									<input
										type="radio"
										name="topology-rerank-provider"
										checked={draft.provider === "http"}
										onChange={() => setDraft({ ...draft, provider: "http" })}
									/>
									<span>{t("views.settings.orientation.httpProvider")}</span>
								</label>
							</div>
							<div className="font-mono text-2xs text-ink-3">
								{t("views.settings.orientation.effectiveSource", { value: data.provider.value, source: data.provider.source })}
							</div>
						</div>

						<label className="block space-y-1">
							<span className="meta">rerankModelRole</span>
							<input
								type="text"
								value={draft.rerankModelRole}
								onChange={(e) => setDraft({ ...draft, rerankModelRole: e.target.value })}
								placeholder={data.rerankModelRole}
								className="block w-full rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-xs text-ink"
							/>
							<div className="font-mono text-2xs text-ink-3">
								{t("views.settings.orientation.effectiveSourceEmpty", { value: data.rerankModelRole, source: data.rerankModelRoleSource })}
							</div>
						</label>

						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
							<GateKnobInput
								label="minContextPercent"
								help={t("views.settings.orientation.minContextPercentHelp")}
								knob={data.minContextPercent}
								value={draft.minContextPercent}
								onChange={(v) => setDraft({ ...draft, minContextPercent: v })}
							/>
							<GateKnobInput
								label="minCandidateNodes"
								help={t("views.settings.orientation.minCandidateNodesHelp")}
								knob={data.minCandidateNodes}
								value={draft.minCandidateNodes}
								onChange={(v) => setDraft({ ...draft, minCandidateNodes: v })}
							/>
							<GateKnobInput
								label="timeoutMs"
								help={t("views.settings.orientation.rerankTimeoutHelp")}
								knob={data.timeoutMs}
								value={draft.timeoutMs}
								onChange={(v) => setDraft({ ...draft, timeoutMs: v })}
							/>
							<label className="block space-y-1">
								<span className="meta">localConfidenceBelow</span>
								<input
									type="text"
									value={draft.localConfidenceBelow}
									onChange={(e) => setDraft({ ...draft, localConfidenceBelow: e.target.value })}
									placeholder={String(data.localConfidenceBelow.default)}
									className="block w-full rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-xs text-ink"
								/>
								<div className="font-mono text-2xs text-ink-3">
									{t("views.settings.orientation.effectiveDefaultSource", { value: data.localConfidenceBelow.value, default: data.localConfidenceBelow.default, source: data.localConfidenceBelow.source })}
								</div>
							</label>
						</div>

						{draft.provider === "http" ? (
							<div className="space-y-3 rounded-md border border-line bg-paper-2 p-3">
								<div className="meta">{t("views.settings.orientation.httpEndpoint")}</div>
								<p className="text-xs text-ink-3">
									{t("views.settings.orientation.httpEndpointDesc", { patch: "RerankPatch" })}
								</p>
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
									<label className="block space-y-1 sm:col-span-2">
										<span className="meta">http.baseUrl</span>
										<input
											type="text"
											value={draft.http.baseUrl}
											onChange={(e) => setDraft({ ...draft, http: { ...draft.http, baseUrl: e.target.value } })}
											placeholder="https://api.example.com"
											className="block w-full rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs text-ink"
										/>
										<div className="font-mono text-2xs text-ink-3">
											{t("views.settings.orientation.effectiveDefaultSource", { value: data.http.baseUrl.value || t("views.settings.orientation.unset"), default: data.http.baseUrl.default, source: data.http.baseUrl.source })}
										</div>
									</label>
									<label className="block space-y-1">
										<span className="meta">http.endpointPath</span>
										<input
											type="text"
											value={draft.http.endpointPath}
											onChange={(e) => setDraft({ ...draft, http: { ...draft.http, endpointPath: e.target.value } })}
											placeholder={data.http.endpointPath.default}
											className="block w-full rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs text-ink"
										/>
										<div className="font-mono text-2xs text-ink-3">
											{t("views.settings.orientation.effectiveDefaultSource", { value: data.http.endpointPath.value, default: data.http.endpointPath.default, source: data.http.endpointPath.source })}
										</div>
									</label>
									<label className="block space-y-1">
										<span className="meta">http.protocol</span>
										<select
											value={draft.http.protocol || "deck-internal"}
											onChange={(e) => setDraft({ ...draft, http: { ...draft.http, protocol: e.target.value as TopologyRerankHttpProtocol } })}
											className="block w-full rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs text-ink"
										>
											<option value="deck-internal">deck-internal</option>
											<option value="siliconflow-rerank">siliconflow-rerank</option>
										</select>
										<div className="font-mono text-2xs text-ink-3">
											{t("views.settings.orientation.effectiveDefaultSource", { value: data.http.protocol.value, default: data.http.protocol.default, source: data.http.protocol.source })}
										</div>
									</label>
									<label className="block space-y-1">
										<span className="meta">http.authHeaderName</span>
										<input
											type="text"
											value={draft.http.authHeaderName}
											onChange={(e) => setDraft({ ...draft, http: { ...draft.http, authHeaderName: e.target.value } })}
											placeholder={data.http.authHeaderName.default}
											className="block w-full rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs text-ink"
										/>
										<div className="font-mono text-2xs text-ink-3">
											{t("views.settings.orientation.effectiveDefaultSource", { value: data.http.authHeaderName.value, default: data.http.authHeaderName.default, source: data.http.authHeaderName.source })}
										</div>
									</label>
									<label className="block space-y-1">
										<span className="meta">http.model</span>
										<input
											type="text"
											value={draft.http.model}
											onChange={(e) => setDraft({ ...draft, http: { ...draft.http, model: e.target.value } })}
											placeholder={data.http.model.default}
											className="block w-full rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs text-ink"
										/>
										<div className="font-mono text-2xs text-ink-3">
											{t("views.settings.orientation.effectiveDefaultSource", { value: data.http.model.value, default: data.http.model.default, source: data.http.model.source })}
										</div>
									</label>
									<GateKnobInput
										label="http.timeoutMs"
										help={t("views.settings.orientation.httpTimeoutHelp")}
										knob={data.http.timeoutMs}
										value={draft.http.timeoutMs}
										onChange={(v) => setDraft({ ...draft, http: { ...draft.http, timeoutMs: v } })}
									/>
									<GateKnobInput
										label="http.minCandidateNodes"
										help={t("views.settings.orientation.httpMinCandidatesHelp")}
										knob={data.http.minCandidateNodes}
										value={draft.http.minCandidateNodes}
										onChange={(v) => setDraft({ ...draft, http: { ...draft.http, minCandidateNodes: v } })}
									/>
									<label className="block space-y-1">
										<span className="meta">http.confidenceThreshold</span>
										<input
											type="text"
											value={draft.http.confidenceThreshold}
											onChange={(e) => setDraft({ ...draft, http: { ...draft.http, confidenceThreshold: e.target.value } })}
											placeholder={String(data.http.confidenceThreshold.default)}
											className="block w-full rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs text-ink"
										/>
										<div className="font-mono text-2xs text-ink-3">
											{t("views.settings.orientation.effectiveDefaultSource", { value: data.http.confidenceThreshold.value, default: data.http.confidenceThreshold.default, source: data.http.confidenceThreshold.source })}
										</div>
									</label>
									<GateKnobInput
										label="http.minContextPercent"
										help={t("views.settings.orientation.httpMinContextHelp")}
										knob={data.http.minContextPercent}
										value={draft.http.minContextPercent}
										onChange={(v) => setDraft({ ...draft, http: { ...draft.http, minContextPercent: v } })}
									/>
								</div>
							</div>
						) : null}

						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" onClick={() => void save()} disabled={saving}>
								<Save className="h-3.5 w-3.5" />
								{t("views.settings.save")}
							</Button>
							<Button size="sm" variant="outline" onClick={() => void refresh()} disabled={saving}>
								<RotateCcw className="h-3.5 w-3.5" />
								{t("views.settings.reload")}
							</Button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function TopologyEmbeddingCard() {
	const { t } = useTranslation();
	type Draft = {
		enabled: boolean;
		model: string;
		baseUrl: string;
		endpointPath: string;
		timeoutMs: string;
	};
	const [draft, setDraft] = useState<Draft | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [status, setStatus] = useState<string | undefined>();

	function entryMasked(key: string, entries: Array<{ key: string; masked: string; isSet: boolean }>): string {
		const entry = entries.find((e) => e.key === key);
		if (!entry || !entry.isSet) return "";
		return entry.masked;
	}

	async function refresh(): Promise<void> {
		try {
			const env = await settingsApi.listEnv();
			const entries = env.entries;
			const enabledEntry = entries.find((e) => e.key === "OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED");
			const enabledRaw = enabledEntry?.masked;
			const enabled = enabledEntry?.isSet && enabledRaw != null && ["1", "true", "yes", "on"].includes(enabledRaw.toLowerCase());
			setDraft({
				enabled: Boolean(enabled),
				model: entryMasked("OMP_DECK_TOPOLOGY_EMBEDDING_MODEL", entries) || "BAAI/bge-large-zh-v1.5",
				baseUrl: entryMasked("OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL", entries),
				endpointPath: entryMasked("OMP_DECK_TOPOLOGY_EMBEDDING_ENDPOINT_PATH", entries) || "/embeddings",
				timeoutMs: entryMasked("OMP_DECK_TOPOLOGY_EMBEDDING_TIMEOUT_MS", entries) || "30000",
			});
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => { void refresh(); }, []);

	async function save(): Promise<void> {
		if (!draft) return;
		const timeoutMs = parsePositiveIntegerOrNull(draft.timeoutMs);
		if (Number.isNaN(timeoutMs)) {
			setError(t("views.settings.orientation.timeoutIntError"));
			return;
		}
		setSaving(true);
		try {
			await settingsApi.patchEnv({
				OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED: draft.enabled ? "1" : null,
				OMP_DECK_TOPOLOGY_EMBEDDING_MODEL: draft.model.trim() || null,
				OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL: draft.baseUrl.trim() || null,
				OMP_DECK_TOPOLOGY_EMBEDDING_ENDPOINT_PATH: draft.endpointPath.trim() || null,
				OMP_DECK_TOPOLOGY_EMBEDDING_TIMEOUT_MS: timeoutMs !== null ? String(timeoutMs) : null,
			});
			setStatus(t("views.settings.saved"));
			setError(undefined);
			window.setTimeout(() => setStatus(undefined), 3000);
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="overflow-hidden rounded-md border border-line bg-paper">
			<div className="border-b border-line bg-paper-2 px-3 py-2">
				<div className="flex items-center gap-2">
					<div className="meta">{t("views.settings.orientation.topologyEmbedding")}</div>
					{draft?.enabled ? <Badge tone="accent">{t("views.settings.orientation.enabled")}</Badge> : <Badge tone="muted">{t("views.settings.orientation.disabled")}</Badge>}
				</div>
				<p className="mt-1 text-xs text-ink-3">
					{t("views.settings.orientation.embeddingDesc")}
				</p>
			</div>
			<div className="space-y-4 p-4">
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
				{status ? (
					<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
						{status}
					</div>
				) : null}
				{loading || !draft ? (
					<div className="text-sm text-ink-3">Loading...</div>
				) : (
					<>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={draft.enabled}
								onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
							/>
							<span>{t("views.settings.orientation.enabled")}</span>
							<span className="ml-2 font-mono text-2xs text-ink-3">
								OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED
							</span>
						</label>

						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<label className="block space-y-1 sm:col-span-2">
								<span className="meta">model</span>
								<input
									type="text"
									value={draft.model}
									onChange={(e) => setDraft({ ...draft, model: e.target.value })}
									placeholder="BAAI/bge-large-zh-v1.5"
									className="block w-full rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-xs text-ink"
								/>
								<div className="font-mono text-2xs text-ink-3">
									OMP_DECK_TOPOLOGY_EMBEDDING_MODEL
								</div>
							</label>
							<label className="block space-y-1 sm:col-span-2">
								<span className="meta">baseUrl</span>
								<input
									type="text"
									value={draft.baseUrl}
									onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
									placeholder="https://api.siliconflow.cn/v1"
									className="block w-full rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-xs text-ink"
								/>
								<div className="font-mono text-2xs text-ink-3">
									OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL
								</div>
							</label>
							<label className="block space-y-1">
								<span className="meta">endpointPath</span>
								<input
									type="text"
									value={draft.endpointPath}
									onChange={(e) => setDraft({ ...draft, endpointPath: e.target.value })}
									placeholder="/embeddings"
									className="block w-full rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-xs text-ink"
								/>
								<div className="font-mono text-2xs text-ink-3">
									OMP_DECK_TOPOLOGY_EMBEDDING_ENDPOINT_PATH
								</div>
							</label>
							<label className="block space-y-1">
								<span className="meta">timeoutMs</span>
								<input
									type="text"
									value={draft.timeoutMs}
									onChange={(e) => setDraft({ ...draft, timeoutMs: e.target.value })}
									placeholder="30000"
									className="block w-full rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-xs text-ink"
								/>
								<div className="font-mono text-2xs text-ink-3">
									OMP_DECK_TOPOLOGY_EMBEDDING_TIMEOUT_MS
								</div>
							</label>
						</div>

						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" onClick={() => void save()} disabled={saving}>
								<Save className="h-3.5 w-3.5" />
								{t("views.settings.save")}
							</Button>
							<Button size="sm" variant="outline" onClick={() => void refresh()} disabled={saving}>
								<RotateCcw className="h-3.5 w-3.5" />
								{t("views.settings.reload")}
							</Button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function GateKnobInput({
	label,
	help,
	knob,
	value,
	onChange,
}: {
	label: string;
	help: string;
	knob: GateKnob;
	value: string;
	onChange: (v: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<label className="block space-y-1">
			<span className="meta">{label}</span>
			<input
				type="text"
				inputMode="numeric"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={String(knob.default)}
				className="block w-full rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-xs text-ink"
			/>
			<div className="font-mono text-2xs text-ink-3">
				{help}
			</div>
			<div className="font-mono text-2xs text-ink-3">
				{t("views.settings.orientation.effectiveDefaultSource", { value: knob.value, default: knob.default, source: knob.source })}
			</div>
		</label>
	);
}

function ModelRolesSection() {
	const { t } = useTranslation();
	const [data, setData] = useState<ModelRolesResponse | null>(null);
	const [draft, setDraft] = useState<Record<string, string>>({});
	const [newRole, setNewRole] = useState("");
	const [newModel, setNewModel] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();
	// Auto-configure preview state
	const [autoPreview, setAutoPreview] = useState<{
		recommended: Record<string, string>;
		matched: Array<{ role: string; selector: string; reason: string }>;
		preserved: string[];
		existing: Record<string, string>;
	} | null>(null);
	const [autoLoading, setAutoLoading] = useState(false);

	async function refresh(): Promise<void> {
		try {
			const next = await settingsApi.listModelRoles();
			setData(next);
			setDraft({ ...next.roles });
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	const entries = useMemo(() => roleEntriesFromResponse({ roles: draft, models: data?.models ?? [] }), [draft, data]);
	const modelOptions = useMemo(() => normalizeModelOptions(data?.models ?? []), [data]);

	async function saveRole(role: string): Promise<void> {
		const value = draft[role];
		const ref = value ? parseModelRef(value) : null;
		setSaving(true);
		try {
			const next = await settingsApi.patchModelRoles(buildPatchRequest({ [role]: ref }).roles);
			setData(next);
			setDraft({ ...next.roles });
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	async function removeRole(role: string): Promise<void> {
		setSaving(true);
		try {
			const next = await settingsApi.patchModelRoles(buildPatchRequest({ [role]: null }).roles);
			setData(next);
			setDraft({ ...next.roles });
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	function addDraftRole(): void {
		const role = newRole.trim();
		if (!role || !newModel) return;
		setDraft((current) => ({ ...current, [role]: newModel }));
		setNewRole("");
		setNewModel("");
	}

	async function autoConfigure(): Promise<void> {
		setAutoLoading(true);
		setError(undefined);
		try {
			const preview = await settingsApi.autoConfigureModelRoles();
			setAutoPreview(preview);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setAutoLoading(false);
		}
	}

	async function applyAutoConfigure(): Promise<void> {
		if (!autoPreview) return;
		setSaving(true);
		setError(undefined);
		try {
			// Merge recommendations over existing roles, preserving unmentioned ones.
			const next = { ...autoPreview.existing, ...autoPreview.recommended };
			const result = await settingsApi.patchModelRoles(next);
			setData(result);
			setDraft({ ...result.roles });
			setAutoPreview(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="mx-auto max-w-5xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{t("views.settings.modelRoles.title")}</h1>
				<p className="mt-1 max-w-3xl text-sm text-ink-3">
					{t("views.settings.modelRoles.intro")}
				</p>
			</div>
			{error ? <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</div> : null}
			{loading ? <div className="text-sm text-ink-3">Loading...</div> : null}
			{/* Auto-configure: scan the model pool and propose role bindings */}
			<div className="rounded-md border border-line bg-paper p-3">
				<div className="flex items-center justify-between gap-2">
					<div>
						<div className="meta">{t("views.settings.modelRoles.autoConfigure")}</div>
						<div className="mt-0.5 text-2xs text-ink-3">
							{t("views.settings.modelRoles.autoConfigureDesc")}
						</div>
					</div>
					<button
						type="button"
						className="btn-secondary h-7 shrink-0 text-2xs"
						onClick={() => void autoConfigure()}
						disabled={autoLoading}
					>
						{autoLoading ? t("views.settings.modelRoles.scanning") : t("views.settings.modelRoles.scanPool")}
					</button>
				</div>
				{autoPreview ? (
					<div className="mt-3 border-t border-line pt-3">
						{autoPreview.matched.length === 0 ? (
							<div className="text-2xs text-ink-3">{t("views.settings.modelRoles.noMatches")}</div>
						) : (
							<div className="space-y-1">
								{autoPreview.matched.map((m) => (
									<div key={m.role} className="flex items-center justify-between gap-2 font-mono text-2xs">
										<span className="text-ink-2">{m.role}</span>
										<span className="truncate text-ink" title={m.reason}>{m.selector}</span>
									</div>
								))}
							</div>
						)}
						<div className="mt-3 flex items-center gap-2">
							<button
								type="button"
								className="btn-primary h-7 px-3 text-2xs"
								onClick={() => void applyAutoConfigure()}
								disabled={saving || autoPreview.matched.length === 0}
							>
								{saving ? t("views.settings.modelRoles.applying") : t("views.settings.modelRoles.apply")}
							</button>
							<button
								type="button"
								className="btn-secondary h-7 px-3 text-2xs"
								onClick={() => setAutoPreview(null)}
							>
								{t("views.settings.cancel")}
							</button>
						</div>
					</div>
				) : null}
			</div>
			<div className="overflow-hidden rounded-md border border-line bg-paper">
				<div className="border-b border-line px-3 py-2">
					<div className="meta">{t("views.settings.modelRoles.configured")}</div>
				</div>
				<div className="divide-y divide-line">
				{entries.map((entry) => {
					const rawValue = draft[entry.name] ?? entry.value;
					const { base: selectValue } = stripThinkingSuffix(rawValue);
					return (
						<ModelRoleRow
							key={entry.name}
							entry={entry}
							selectValue={selectValue}
							thinking={entry.thinking}
							models={modelOptions}
							saving={saving}
							onChange={(baseRef) => {
								const next = entry.thinking ? `${baseRef}:${entry.thinking}` : baseRef;
								setDraft((current) => ({ ...current, [entry.name]: next }));
							}}
							onSave={() => void saveRole(entry.name)}
							onRemove={() => void removeRole(entry.name)}
						/>
					);
				})}
					{entries.length === 0 ? <div className="px-3 py-4 text-sm text-ink-3">{t("views.settings.modelRoles.none")}</div> : null}
				</div>
			</div>
			<div className="rounded-md border border-line bg-paper p-3">
				<div className="meta">{t("views.settings.modelRoles.addRole")}</div>
				<div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
					<input
						type="text"
						value={newRole}
						onChange={(e) => setNewRole(e.target.value)}
						placeholder="advisor"
						className="rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-xs text-ink"
					/>
					<select
						value={newModel}
						onChange={(e) => setNewModel(e.target.value)}
						className="rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-xs text-ink"
					>
						<option value="">{t("views.settings.modelRoles.chooseModel")}</option>
						{modelOptions.map((model) => (
							<option key={model.value} value={model.value}>{model.label}</option>
						))}
					</select>
					<Button size="sm" onClick={addDraftRole} disabled={!newRole.trim() || !newModel}>{t("views.settings.add")}</Button>
				</div>
			</div>
		</div>
	);
}

function ModelRoleRow({
	entry,
	selectValue,
	thinking,
	models,
	saving,
	onChange,
	onSave,
	onRemove,
}: {
	entry: ModelRoleEntry;
	selectValue: string;
	thinking?: string;
	models: Array<{ value: string; label: string }>;
	saving: boolean;
	onChange: (baseRef: string) => void;
	onSave: () => void;
	onRemove: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="grid gap-3 px-3 py-3 md:grid-cols-[180px_minmax(0,1fr)_auto] md:items-center">
			<div>
				<div className="font-mono text-sm text-ink">{entry.name}</div>
				<div className="mt-1 flex items-center gap-1">
					{entry.dynamic ? <Badge tone="muted">{t("views.settings.modelRoles.custom")}</Badge> : <Badge tone="accent">{t("views.settings.modelRoles.builtIn")}</Badge>}
					{thinking ? <Badge tone="default">:{thinking}</Badge> : null}
				</div>
			</div>
			<select value={selectValue} onChange={(e) => onChange(e.target.value)} className="rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-xs text-ink">
				{selectValue && !models.some((m) => m.value === selectValue) ? (
					<option value={selectValue}>{selectValue}</option>
				) : null}
				{models.map((model) => (
					<option key={model.value} value={model.value}>{model.label}</option>
				))}
			</select>
			<div className="flex gap-2">
				<Button size="sm" onClick={onSave} disabled={saving || !selectValue}>{t("views.settings.save")}</Button>
				{entry.dynamic ? <Button size="sm" variant="ghost" onClick={onRemove} disabled={saving}><X className="h-3.5 w-3.5" />{t("views.settings.remove")}</Button> : null}
			</div>
		</div>
	);
}

function normalizeModelOptions(models: unknown[]): Array<{ value: string; label: string }> {
	return models.flatMap((model) => {
		const info = model as Partial<ModelInfo>;
		if (typeof info.provider !== "string" || typeof info.id !== "string") return [];
		const ref: ModelRef = { provider: info.provider, id: info.id };
		return [{ value: formatModelRef(ref), label: `${info.label ?? info.id} (${formatModelRef(ref)})` }];
	});
}

function StubSection({ section }: { section: Exclude<SectionId, "env" | "messaging" | "appearance" | "notifications"> }) {
	const { t } = useTranslation();
	const spec = SECTIONS.find((s) => s.id === section)!;
	return (
		<div className="mx-auto max-w-3xl rounded-md border border-dashed border-line bg-paper-2 p-6">
			<div className="meta">{t(spec.labelKey)}</div>
			<h1 className="mt-2 text-xl font-semibold">{t("views.settings.notBuilt")}</h1>
			<p className="mt-1 text-sm text-ink-3">{t("views.settings.notBuiltHint")}</p>
		</div>
	);
}

function SettingsSideRail() {
	const { t } = useTranslation();
	return <div className="p-3 text-xs text-ink-3">{t("views.settings.title")}</div>;
}

function SettingsInspector() {
	const { t } = useTranslation();
	return (
		<div className="space-y-2 p-3 text-xs text-ink-3">
			<div className="meta">{t("views.settings.notes")}</div>
			<p>{t("views.settings.notesHint")}</p>
		</div>
	);
}

function normalizeSection(raw: string | null): SectionId {
	return SECTIONS.some((s) => s.id === raw) ? (raw as SectionId) : "env";
}

function sourceLabel(source: EnvEntry["source"], t: (key: string) => string): string {
	if (source === "process-env") return t("views.settings.source.processEnv");
	if (source === "env-file") return t("views.settings.source.envFile");
	return source;
}

function sourceTone(source: EnvEntry["source"]): "accent" | "default" | "muted" {
	if (source === "process-env") return "accent";
	if (source === "env-file") return "default";
	return "muted";
}

function envApplyBadge(entry: EnvEntry, t: (key: string) => string) {
	if (entry.hotApply) return <Badge tone="success">{t("views.settings.envApply.hot")}</Badge>;
	if (entry.restartTarget === "telegram-bridge") return <Badge tone="warn">{t("views.settings.envApply.bridgeRestart")}</Badge>;
	if (entry.restartRequired) return <Badge tone="warn">{t("views.settings.envApply.serverRestart")}</Badge>;
	return <Badge tone="muted">{t("views.settings.envApply.manual")}</Badge>;
}

function bridgeStatusTone(status: BridgeInfo["status"]): "success" | "muted" | "warn" | "danger" {
	if (status === "running") return "success";
	if (status === "starting") return "warn";
	if (status === "crashed") return "danger";
	return "muted";
}

function bridgeStatusLabel(status: BridgeInfo["status"], info: BridgeInfo | undefined, t: (key: string, opts?: Record<string, unknown>) => string): string {
	if (status === "running") return t("views.settings.bridge.statusRunning");
	if (status === "starting") return t("views.settings.bridge.statusStarting");
	if (status === "crashed") return info?.exitSignal ? t("views.settings.bridge.statusCrashedSignal", { signal: info.exitSignal }) : t("views.settings.bridge.statusCrashed");
	if (info && info.missingEnv.length > 0) return t("views.settings.bridge.statusMissingCredentials");
	return t("views.settings.bridge.statusStopped");
}

function formatUptime(startedIso: string): string {
	const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedIso)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d${hours % 24}h`;
}

/**
 * OMP Config section — edit omp's native config.yml settings.
 * Schema-driven tabs + raw JSON editor for advanced values.
 */
function OmpConfigSection() {
	return <OmpSettingsForm />;
}
/**
 * CPA section — CLIProxyAPI connection, usage monitoring, and config management.
 * Reads/writes ~/.config/pi-cliproxyapi/config.json and CPA_USAGE_* env vars.
 */
function CpaSection() {
	const { t } = useTranslation();
	const [config, setConfig] = useState<{
		proxy?: { endpoint: string; hasKey: boolean; providerPrefix?: string };
		builtinProviders?: Record<string, { enabled: boolean; apiOverride?: string; models?: string[] }>;
		customProviders?: Record<string, { api: string; models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }> }>;
	} | null>(null);
	const [configPath, setConfigPath] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [note, setNote] = useState<string | undefined>();

	// Connection form
	const [endpoint, setEndpoint] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [providerPrefix, setProviderPrefix] = useState("");
	const [savingConn, setSavingConn] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<string | undefined>();

	// Usage monitoring form
	const [usageUrl, setUsageUrl] = useState("");
	const [usageUser, setUsageUser] = useState("");
	const [usagePass, setUsagePass] = useState("");
	const [usagePassSet, setUsagePassSet] = useState(false);
	const [usageTimeout, setUsageTimeout] = useState("10000");
	const [savingUsage, setSavingUsage] = useState(false);

	// Clear cache
	const [clearing, setClearing] = useState(false);

	async function refresh() {
		try {
			const resp = await api.getCpaConfig();
			setConfig(resp.config);
			setConfigPath(resp.path);
			if (resp.config?.proxy) {
				setEndpoint(resp.config.proxy.endpoint);
				setProviderPrefix(resp.config.proxy.providerPrefix ?? "");
			}
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoaded(true);
		}
	}

	async function refreshUsage() {
		try {
			const env = await settingsApi.listEnv();
			const find = (key: string) => env.entries.find((e) => e.key === key);
			setUsageUrl(find("CPA_USAGE_BASE_URL")?.masked ?? "");
			setUsageUser(find("CPA_USAGE_USERNAME")?.masked ?? "");
		setUsagePassSet(find("CPA_USAGE_PASSWORD")?.isSet ?? false);
		setUsageTimeout(find("CPA_USAGE_TIMEOUT_MS")?.masked ?? "10000");
		} catch { /* ignore */ }
	}

	useEffect(() => { void refresh(); void refreshUsage(); }, []);

	async function saveConnection() {
		setSavingConn(true);
		setNote(undefined);
		setError(undefined);
			try {
			const proxy: Record<string, string> = { endpoint: endpoint.trim() };
			if (apiKey.trim()) proxy.apiKey = apiKey.trim();
			if (providerPrefix.trim()) proxy.providerPrefix = providerPrefix.trim();
			await api.updateCpaConfig({ proxy });
			setApiKey("");
			setNote(t("views.settings.cpa.connectionSaved"));
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingConn(false);
		}
	}

	async function testConnection() {
		setTesting(true);
		setTestResult(undefined);
		try {
			const body: Record<string, string> = {};
			if (endpoint.trim()) body.endpoint = endpoint.trim();
			if (apiKey.trim()) body.apiKey = apiKey.trim();
			const res = await api.testCpaConnection(body);
			if (res.ok) {
				setTestResult(t("views.settings.cpa.connected", { count: res.modelCount ?? 0 }));
			} else {
				setTestResult(t("views.settings.cpa.failed", { error: res.error ?? t("views.settings.cpa.unknownError") }));
			}
		} catch (err) {
			setTestResult(t("views.settings.cpa.error", { error: err instanceof Error ? err.message : String(err) }));
		} finally {
			setTesting(false);
		}
	}

	async function saveUsage() {
		setSavingUsage(true);
		setNote(undefined);
		setError(undefined);
		try {
			const updates: Record<string, string | null> = {
				CPA_USAGE_BASE_URL: usageUrl.trim() || null,
				CPA_USAGE_USERNAME: usageUser.trim() || null,
				CPA_USAGE_TIMEOUT_MS: usageTimeout.trim() || null,
			};
			if (usagePass.trim()) updates.CPA_USAGE_PASSWORD = usagePass.trim();
			await settingsApi.patchEnv(updates);
			setUsagePass("");
			setNote(t("views.settings.cpa.usageSaved"));
			await refreshUsage();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingUsage(false);
		}
	}

	async function clearCache() {
		setClearing(true);
		try {
			const res = await api.clearCpaCache();
			setNote(res.existed ? t("views.settings.cpa.cacheCleared") : t("views.settings.cpa.noCache"));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setClearing(false);
		}
	}

	if (!loaded) return <div className="font-mono text-2xs text-ink-3">{t("views.settings.cpa.loading")}</div>;

	return (
		<div className="flex flex-col gap-6">
			{/* CPA Connection */}
			<div>
				<h2 className="meta">{t("views.settings.cpa.connection")}</h2>
				<p className="mt-1 text-xs text-ink-3">
					{t("views.settings.cpa.connectionDesc", { path: configPath || t("views.settings.cpa.notFound") })}
				</p>
				<div className="mt-3 rounded border border-line bg-paper-2 p-4">
					<div className="grid grid-cols-2 gap-2">
						<input type="text" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={t("views.settings.cpa.endpointPlaceholder")} className="field h-8 px-2 font-mono text-xs" autoComplete="off" />
						<input type="text" value={providerPrefix} onChange={(e) => setProviderPrefix(e.target.value)} placeholder={t("views.settings.cpa.prefixPlaceholder")} className="field h-8 px-2 font-mono text-xs" autoComplete="off" />
					</div>
					<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={config?.proxy?.hasKey ? t("views.settings.cpa.apiKeyReplace") : t("views.settings.cpa.apiKey")} className="field mt-2 h-8 w-full px-2 font-mono text-xs" autoComplete="off" />
					<div className="mt-2 flex items-center gap-3">
						<Button onClick={() => void saveConnection()} disabled={savingConn || !endpoint.trim()} variant="ghost">
							{savingConn ? t("views.settings.saving") : t("views.settings.cpa.saveConnection")}
						</Button>
						<Button onClick={() => void testConnection()} disabled={testing || !endpoint.trim()} variant="ghost">
							{testing ? t("views.settings.testing") : t("views.settings.cpa.testConnection")}
						</Button>
						{testResult ? <span className="text-xs text-ink-2">{testResult}</span> : null}
					</div>
				</div>
			</div>
			{/* CPA Usage Monitoring */}
			<div>
				<h2 className="meta">{t("views.settings.cpa.usageMonitoring")}</h2>
				<p className="mt-1 text-xs text-ink-3">{t("views.settings.cpa.usageDesc")}</p>
				<div className="mt-3 rounded border border-line bg-paper-2 p-4">
					<input type="text" value={usageUrl} onChange={(e) => setUsageUrl(e.target.value)} placeholder={t("views.settings.cpa.collectorUrl")} className="field h-8 w-full px-2 font-mono text-xs" autoComplete="off" />
					<div className="mt-2 grid grid-cols-2 gap-2">
						<input type="text" value={usageUser} onChange={(e) => setUsageUser(e.target.value)} placeholder={t("views.settings.cpa.username")} className="field h-8 px-2 font-mono text-xs" autoComplete="off" />
						<input type="password" value={usagePass} onChange={(e) => setUsagePass(e.target.value)} placeholder={usagePassSet ? t("views.settings.cpa.passReplace") : t("views.settings.cpa.password")} className="field h-8 px-2 font-mono text-xs" autoComplete="off" />
					</div>
					<input type="text" value={usageTimeout} onChange={(e) => setUsageTimeout(e.target.value)} placeholder={t("views.settings.cpa.timeoutMs")} className="field mt-2 h-8 w-full px-2 font-mono text-xs" autoComplete="off" />
					<div className="mt-2 flex items-center gap-3">
						<Button onClick={() => void saveUsage()} disabled={savingUsage} variant="ghost">
							{savingUsage ? t("views.settings.saving") : t("views.settings.cpa.saveMonitoring")}
						</Button>
					</div>
				</div>
			</div>
			{/* CPA Custom Providers */}
			{config?.customProviders && Object.keys(config.customProviders).length > 0 ? (
				<div>
					<h2 className="meta">{t("views.settings.cpa.customProviders")}</h2>
					<p className="mt-1 text-xs text-ink-3">{t("views.settings.cpa.customProvidersDesc")}</p>
					<div className="mt-3 grid grid-cols-1 gap-2">
						{Object.entries(config.customProviders).map(([name, prov]) => (
							<div key={name} className="rounded border border-line bg-paper-2/30 p-3">
								<div className="text-sm font-medium text-ink">{name}</div>
								<div className="mt-0.5 text-2xs text-ink-3">{prov.api} · {t("views.settings.cpa.modelCount", { count: prov.models.length })}</div>
								<div className="mt-1 flex flex-wrap gap-1">
									{prov.models.slice(0, 8).map((m) => (
										<span key={m.id} className="rounded bg-paper-3 px-1.5 py-0.5 font-mono text-2xs text-ink-2">{m.id}</span>
									))}
									{prov.models.length > 8 ? <span className="text-2xs text-ink-3">{t("views.settings.cpa.more", { count: prov.models.length - 8 })}</span> : null}
								</div>
							</div>
						))}
					</div>
				</div>
			) : null}
			{/* CPA Built-in Providers */}
			{config?.builtinProviders && Object.keys(config.builtinProviders).length > 0 ? (
				<div>
					<h2 className="meta">{t("views.settings.cpa.builtinProviders")}</h2>
					<p className="mt-1 text-xs text-ink-3">{t("views.settings.cpa.builtinProvidersDesc")}</p>
					<div className="mt-3 grid grid-cols-1 gap-2">
						{Object.entries(config.builtinProviders).map(([name, prov]) => (
							<div key={name} className="rounded border border-line bg-paper-2/30 p-3">
								<div className="flex items-center justify-between">
									<div className="text-sm font-medium text-ink">{name}</div>
									<Badge tone={prov.enabled ? "success" : "default"}>{prov.enabled ? t("views.settings.cpa.enabled") : t("views.settings.cpa.disabled")}</Badge>
								</div>
								{prov.apiOverride ? <div className="mt-0.5 text-2xs text-ink-3">{t("views.settings.cpa.api", { value: prov.apiOverride })}</div> : null}
								{prov.models && prov.models.length > 0 ? (
									<div className="mt-1 flex flex-wrap gap-1">
										{prov.models.slice(0, 8).map((m) => (
											<span key={m} className="rounded bg-paper-3 px-1.5 py-0.5 font-mono text-2xs text-ink-2">{m}</span>
										))}
										{prov.models.length > 8 ? <span className="text-2xs text-ink-3">{t("views.settings.cpa.more", { count: prov.models.length - 8 })}</span> : null}
									</div>
								) : null}
							</div>
						))}
					</div>
				</div>
			) : null}
			{/* Actions */}
			<div>
				<Button onClick={() => void clearCache()} disabled={clearing} variant="ghost">
					{clearing ? t("views.settings.clearing") : t("views.settings.cpa.clearCache")}
				</Button>
			</div>
			{note ? <div className="rounded border border-success/30 bg-success/5 p-2 text-xs text-success">{note}</div> : null}
			{error ? <div className="rounded border border-danger/40 bg-danger/5 p-2 text-xs text-danger">{error}</div> : null}
		</div>
	);
}
/**
 * Custom providers — any OpenAI-compatible endpoint written to omp's
 * models.yml. Full CRUD via /api/providers/custom. Syncs to both
 * terminal omp and the deck model picker.
 */
function CustomProvidersSection() {
	const { t } = useTranslation();
	const [providers, setProviders] = useState<Array<{ name: string; baseUrl: string; api: string; modelCount: number; hasKey: boolean }>>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [note, setNote] = useState<string | undefined>();

	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiType, setApiType] = useState("openai-completions");
	const [apiKey, setApiKey] = useState("");
	const [modelId, setModelId] = useState("");
	const [modelName, setModelName] = useState("");
	const [authNone, setAuthNone] = useState(false);
	const [saving, setSaving] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

	async function refresh() {
		try {
			const resp = await api.listCustomProviders();
			setProviders(resp.providers);
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoaded(true);
		}
	}

	useEffect(() => { void refresh(); }, []);

	async function save() {
		if (!name.trim() || !baseUrl.trim() || !modelId.trim()) return;
		if (!authNone && !apiKey.trim()) return;
		setSaving(true);
		setNote(undefined);
		setError(undefined);
		try {
			const res = await api.upsertCustomProvider({
				name: name.trim(),
				baseUrl: baseUrl.trim(),
				api: apiType,
				...(authNone ? { auth: "none" as const } : { apiKey: apiKey.trim() }),
				models: [{ id: modelId.trim(), ...(modelName.trim() ? { name: modelName.trim() } : {}) }],
			});
			setName(""); setBaseUrl(""); setApiKey(""); setModelId(""); setModelName("");
			setNote(res.reloadRequired ? t("views.settings.providerSavedReload") : t("views.settings.providerSaved"));
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	async function remove(providerName: string) {
		try {
			await api.deleteCustomProvider(providerName);
			setConfirmDelete(null);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	if (!loaded) return <div className="font-mono text-2xs text-ink-3">{t("views.settings.customProviders.loading")}</div>;

	return (
		<div>
			<h2 className="meta">{t("views.settings.customProviders.title")}</h2>
			<p className="mt-1 text-xs text-ink-3">
				{t("views.settings.customProviders.intro")}
			</p>
			{providers.length > 0 ? (
				<div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
					{providers.map((p) => (
						<div key={p.name} className="rounded border border-line bg-paper-2/30 p-3">
							<div className="flex items-start justify-between gap-2">
								<div className="min-w-0">
									<div className="text-sm font-medium text-ink">{p.name}</div>
									<div className="mt-0.5 truncate font-mono text-2xs text-ink-3">{p.baseUrl}</div>
									<div className="mt-0.5 text-2xs text-ink-3">
										{p.api} · {t("views.settings.customProviders.modelCount", { count: p.modelCount })} · {p.hasKey ? t("views.settings.customProviders.keySet") : t("views.settings.customProviders.noKey")}
									</div>
								</div>
								<Button variant="ghost" className="shrink-0 text-xs text-danger hover:text-danger" onClick={() => setConfirmDelete(p.name)}>
									{t("views.settings.delete")}
								</Button>
							</div>
						</div>
					))}
				</div>
			) : null}
			<div className="mt-3 rounded border border-line bg-paper-2 p-4">
				<div className="text-sm font-medium text-ink">{t("views.settings.customProviders.addTitle")}</div>
				<div className="mt-3 grid grid-cols-2 gap-2">
					<input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("views.onboarding.provider.namePlaceholder")} className="field h-8 px-2 font-mono text-xs" autoComplete="off" />
					<input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={t("views.onboarding.provider.baseUrlPlaceholder")} className="field h-8 px-2 font-mono text-xs" autoComplete="off" />
				</div>
				<select value={apiType} onChange={(e) => setApiType(e.target.value)} className="field mt-2 h-8 w-full px-2 font-mono text-xs">
					<option value="openai-completions">openai-completions</option>
					<option value="openai-responses">openai-responses</option>
					<option value="openai-codex-responses">openai-codex-responses</option>
					<option value="azure-openai-responses">azure-openai-responses</option>
					<option value="anthropic-messages">anthropic-messages</option>
					<option value="google-generative-ai">google-generative-ai</option>
					<option value="google-vertex">google-vertex</option>
				</select>
				{!authNone ? (
					<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={t("views.onboarding.provider.apiKeyPlaceholder")} className="field mt-2 h-8 w-full px-2 font-mono text-xs" autoComplete="off" />
				) : null}
				<label className="mt-2 flex items-center gap-1.5 font-mono text-2xs text-ink-3">
					<input type="checkbox" checked={authNone} onChange={(e) => setAuthNone(e.target.checked)} />
					{t("views.onboarding.provider.noAuth")}
				</label>
				<div className="mt-2 flex gap-2">
					<input type="text" value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder={t("views.onboarding.provider.modelIdPlaceholder")} className="field h-8 flex-1 px-2 font-mono text-xs" autoComplete="off" />
					<input type="text" value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder={t("views.onboarding.provider.displayNamePlaceholder")} className="field h-8 w-40 px-2 font-mono text-xs" autoComplete="off" />
				</div>
				<div className="mt-2 flex items-center gap-3">
					<Button onClick={() => void save()} disabled={saving || !name.trim() || !baseUrl.trim() || !modelId.trim() || (!authNone && !apiKey.trim())} variant="ghost">
						{saving ? t("views.settings.saving") : t("views.onboarding.provider.addProvider")}
					</Button>
					{note ? <span className="text-xs text-success">{note}</span> : null}
				</div>
			</div>
			<Modal open={confirmDelete !== null} onClose={() => setConfirmDelete(null)} widthClass="max-w-md">
				<div className="flex flex-col gap-3 p-5">
					<h2 className="text-base font-semibold text-ink">{t("views.settings.customProviders.deleteTitle", { name: confirmDelete })}</h2>
					<p className="text-xs text-ink-3">
						{t("views.settings.customProviders.deleteDesc")}
					</p>
					<div className="flex justify-end gap-2 border-t border-line pt-3">
						<Button variant="ghost" onClick={() => setConfirmDelete(null)}>{t("views.settings.cancel")}</Button>
						<Button variant="danger" onClick={() => confirmDelete && void remove(confirmDelete)}>{t("views.settings.delete")}</Button>
					</div>
				</div>
			</Modal>
			{error ? (
				<div className="mt-2 rounded border border-danger/40 bg-danger/5 p-3 text-xs text-danger">{error}</div>
			) : null}
		</div>
	);
}
/**
 * Providers section — list every OAuth-capable provider with its current
 * auth state. Login opens OAuthFlowModal; Revoke clears credentials and
 * fires `models_changed` server-side so the picker re-empties without a
 * deck restart. See docs/oauth-deck-sdk-findings.md for the SDK contract.
 */
function ProvidersSection() {
	const { t } = useTranslation();
	const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(true);
	const [activeFlow, setActiveFlow] = useState<{ id: string; name: string } | null>(null);
	const [confirmRevoke, setConfirmRevoke] = useState<{ id: string; name: string } | null>(null);
	const [revoking, setRevoking] = useState(false);

	async function refresh(): Promise<void> {
		try {
			const resp = await authApi.listProviders();
			setProviders(resp.providers);
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	async function revoke(): Promise<void> {
		if (!confirmRevoke) return;
		setRevoking(true);
		try {
			await authApi.revoke(confirmRevoke.id);
			setConfirmRevoke(null);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRevoking(false);
		}
	}

	if (loading) {
		return <div className="font-mono text-2xs text-ink-3">{t("views.settings.providers.loading")}</div>;
	}
	if (error) {
		return (
			<div className="rounded border border-danger/40 bg-danger/5 p-3 text-xs text-danger">
				{error}
			</div>
		);
	}
	if (!providers) return null;

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h2 className="meta">{t("views.settings.providers.title")}</h2>
				<p className="mt-1 text-xs text-ink-3">
					{t("views.settings.providers.intro")}
				</p>
			</div>
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				{providers.map((p) => (
					<ProviderCard
						key={p.id}
						info={p}
						onLogin={() => setActiveFlow({ id: p.id, name: p.name })}
						onRevoke={() => setConfirmRevoke({ id: p.id, name: p.name })}
					/>
				))}
			</div>
			<OAuthFlowModal
				open={activeFlow !== null}
				provider={activeFlow?.id ?? null}
				providerName={activeFlow?.name ?? null}
				onClose={() => setActiveFlow(null)}
				onComplete={() => {
					setActiveFlow(null);
					void refresh();
				}}
			/>
			<Modal open={confirmRevoke !== null} onClose={() => setConfirmRevoke(null)} widthClass="max-w-md">
				<div className="flex flex-col gap-3 p-5">
					<h2 className="text-base font-semibold text-ink">
						{t("views.settings.providers.signOutTitle", { name: confirmRevoke?.name })}
					</h2>
					<p className="text-xs text-ink-3">
						{t("views.settings.providers.signOutDesc")}
					</p>
					<div className="flex justify-end gap-2 border-t border-line pt-3">
						<Button variant="ghost" onClick={() => setConfirmRevoke(null)} disabled={revoking}>
							{t("views.settings.cancel")}
						</Button>
						<Button variant="danger" onClick={revoke} disabled={revoking}>
							{revoking ? t("views.settings.providers.signingOut") : t("views.settings.providers.signOut")}
						</Button>
					</div>
				</div>
			</Modal>
		</div>
	);
}

function ProviderCard({
	info,
	onLogin,
	onRevoke,
}: {
	info: ProviderInfo;
	onLogin: () => void;
	onRevoke: () => void;
}) {
	const { t } = useTranslation();
	const tone =
		info.state === "oauth"
			? "border-success/40 bg-success/5"
			: info.state === "api-key"
				? "border-accent/30 bg-accent-soft/40"
				: "border-line bg-paper-2/30";
	const stateLabel =
		info.state === "oauth"
			? t("views.settings.providers.stateOauth")
			: info.state === "api-key"
				? t("views.settings.providers.stateApiKey")
				: t("views.settings.providers.stateNotConfigured");
	const stateBadgeTone: "success" | "accent" | "default" =
		info.state === "oauth" ? "success" : info.state === "api-key" ? "accent" : "default";
	return (
		<div className={cn("flex flex-col gap-2 rounded border p-3", tone)}>
			<div className="flex items-baseline justify-between gap-2">
				<div className="truncate text-sm font-medium text-ink" title={info.name}>
					{info.name}
				</div>
				<Badge tone={stateBadgeTone}>{stateLabel}</Badge>
			</div>
			<div className="font-mono text-2xs text-ink-4">
				{info.id}
				{info.count > 1 ? <span className="ml-1.5">{t("views.settings.providers.credentials", { count: info.count })}</span> : null}
			</div>
			<div className="mt-1 flex gap-2">
				{info.state === "unconfigured" ? (
					<Button variant="primary" onClick={onLogin} className="flex-1">
						{t("views.settings.providers.login")}
					</Button>
				) : info.state === "oauth" ? (
					<>
						<Button variant="outline" onClick={onLogin} className="flex-1">
							{t("views.settings.providers.replace")}
						</Button>
						<Button variant="ghost" onClick={onRevoke}>
							{t("views.settings.providers.signOut")}
						</Button>
					</>
				) : (
					<Button variant="outline" onClick={onLogin} className="flex-1">
						{t("views.settings.providers.loginReplaceKey")}
					</Button>
				)}
			</div>
		</div>
	);
}

function AboutSection() {
	const { t } = useTranslation();
	const heartbeat = useStore((s) => s.heartbeat);
	const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
	const [updating, setUpdating] = useState(false);
	const [updateResult, setUpdateResult] = useState<string | undefined>();

	useEffect(() => {
		void fetch("/api/version")
			.then((res) => res.json())
			.then((data) => setVersionInfo(data as VersionInfo))
			.catch(() => {});
	}, []);

	async function runUpdate(): Promise<void> {
		setUpdating(true);
		setUpdateResult(undefined);
		try {
			const result = await api.runUpdate();
			if (result.ok) {
				setUpdateResult(t("views.settings.about.updateSucceeded", { type: result.installType }));
			} else {
				setUpdateResult(result.error ?? t("views.settings.about.updateFailed"));
			}
		} catch (e) {
			setUpdateResult(String(e));
		} finally {
			setUpdating(false);
		}
	}

	const current = versionInfo?.current ?? heartbeat?.version ?? "unknown";
	const latest = versionInfo?.latest ?? null;
	const updateAvailable = versionInfo?.updateAvailable ?? false;

	return (
		<div className="mx-auto max-w-2xl space-y-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{t("views.settings.about.title")}</h1>
				<p className="mt-1 text-sm text-ink-3">{t("views.settings.about.intro")}</p>
			</div>

			<div className="rounded-md border border-line bg-paper-2 p-4">
				<div className="meta mb-2">{t("views.settings.about.version")}</div>
				<div className="flex items-center gap-3">
					<span className="font-mono text-sm text-ink">{current}</span>
					{updateAvailable ? (
						<Badge tone="warn">{latest ? t("views.settings.about.updateAvailableWith", { latest }) : t("views.settings.about.updateAvailable")}</Badge>
					) : (
						<Badge tone="success">{t("views.settings.about.upToDate")}</Badge>
					)}
				</div>
				{updateAvailable ? (
					<div className="mt-3 flex items-center gap-2">
						<Button
							variant="primary"
							size="sm"
							disabled={updating}
							onClick={() => void runUpdate()}
						>
							<Download className="mr-1 h-3.5 w-3.5" />
							{updating ? t("views.settings.about.updating") : t("views.settings.about.updateNow")}
						</Button>
						<a
							href={versionInfo?.releaseUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="text-xs text-ink-3 underline hover:text-ink-2"
						>
							{t("views.settings.about.releaseNotes")}
						</a>
					</div>
				) : null}
				{updateResult ? (
					<div className="mt-3 rounded-md border border-line bg-paper px-3 py-2 font-mono text-xs text-ink-2 whitespace-pre-wrap">
						{updateResult}
					</div>
				) : null}
			</div>

			<div className="rounded-md border border-line bg-paper-2 p-4">
				<div className="meta mb-2">{t("views.settings.serverIdentity")}</div>
				{heartbeat ? (
					<dl className="space-y-1 text-xs">
						<div className="flex gap-2">
							<dt className="w-20 text-ink-3">{t("views.settings.notifications.pid")}</dt>
							<dd className="font-mono text-ink">{heartbeat.pid}</dd>
						</div>
						<div className="flex gap-2">
							<dt className="w-20 text-ink-3">{t("views.settings.notifications.version")}</dt>
							<dd className="font-mono text-ink">{heartbeat.version}</dd>
						</div>
						<div className="flex gap-2">
							<dt className="w-20 text-ink-3">{t("views.settings.notifications.build")}</dt>
							<dd className="font-mono text-ink">{heartbeat.buildSha?.slice(0, 12) ?? "—"}</dd>
						</div>
						<div className="flex gap-2">
							<dt className="w-20 text-ink-3">{t("views.settings.notifications.started")}</dt>
							<dd className="font-mono text-ink">{new Date(heartbeat.serverStartedAt).toLocaleString()}</dd>
						</div>
						<div className="flex gap-2">
							<dt className="w-20 text-ink-3">{t("views.settings.notifications.uptime")}</dt>
							<dd className="font-mono text-ink">{Math.round(heartbeat.uptimeSecs)}s</dd>
						</div>
					</dl>
				) : (
					<div className="text-xs text-ink-3">{t("views.settings.notifications.waitingHeartbeat")}</div>
				)}
			</div>
		</div>
	);
}
