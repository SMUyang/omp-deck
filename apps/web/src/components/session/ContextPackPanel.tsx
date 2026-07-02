import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SessionContextNode, SessionContextPackResponse } from "@omp-deck/protocol";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ContextPackPanelProps {
	sessionId: string | null;
	query?: string;
	className?: string;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="space-y-1">
			<h4 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{title}</h4>
			<div className="space-y-1 text-xs text-foreground/85">{children}</div>
		</section>
	);
}

function NodeList({ nodes }: { nodes: SessionContextNode[] }) {
	const { t } = useTranslation();
	if (nodes.length === 0) return <div className="text-muted-foreground">{t("sessionContext.none")}</div>;
	return (
		<ul className="space-y-1">
			{nodes.map((node) => (
				<li key={node.id} className="rounded border border-line/60 bg-panel/60 p-2">
					<div className="font-medium">{node.title}</div>
					<div className="text-muted-foreground">{node.compressedBody}</div>
				</li>
			))}
		</ul>
	);
}

export function ContextPackPanel({ sessionId, query = "", className }: ContextPackPanelProps) {
	const { t } = useTranslation();
	const [pack, setPack] = useState<SessionContextPackResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const rebuildAndLoad = useCallback(async () => {
		if (!sessionId) return;
		setLoading(true);
		setError(null);
		try {
			await api.rebuildSessionContext(sessionId);
			setPack(await api.getSessionContextPack(sessionId, { q: query, budget: 4000 }));
		} catch (err) {
			setError(String((err as Error).message ?? err));
		} finally {
			setLoading(false);
		}
	}, [query, sessionId]);

	return (
		<div className={cn("rounded-lg border border-line bg-panel/70 p-3", className)}>
			<div className="flex items-center justify-between gap-2">
				<div>
					<h3 className="text-sm font-semibold">{t("sessionContext.title")}</h3>
					<p className="text-xs text-muted-foreground">{t("sessionContext.description")}</p>
				</div>
				<button
					type="button"
					className="rounded border border-line px-2 py-1 text-xs hover:bg-muted"
					disabled={!sessionId || loading}
					onClick={rebuildAndLoad}
				>
					{loading ? t("sessionContext.building") : t("sessionContext.rebuild")}
				</button>
			</div>
			{error ? (
				<div className="mt-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">{error}</div>
			) : null}
			{pack ? (
				<div className="mt-3 space-y-3">
					<Section title={t("sessionContext.sections.summary")}>
						<pre className="whitespace-pre-wrap rounded bg-black/20 p-2">{pack.summary || t("sessionContext.noSummary")}</pre>
					</Section>
					<Section title={t("sessionContext.sections.goals")}>
						<NodeList nodes={pack.goals} />
					</Section>
					<Section title={t("sessionContext.sections.decisions")}>
						<NodeList nodes={pack.decisions} />
					</Section>
					<Section title={t("sessionContext.sections.issues")}>
						<NodeList nodes={pack.issues} />
					</Section>
					<Section title={t("sessionContext.sections.evidence")}>
						<NodeList nodes={pack.evidence} />
					</Section>
					<Section title={t("sessionContext.sections.rawRefs")}>
						<ul className="space-y-1 text-muted-foreground">
							{pack.rawRefs.slice(0, 12).map((ref, index) => (
								<li key={`${ref.label}-${index}`}>{ref.label}</li>
							))}
						</ul>
					</Section>
				</div>
			) : null}
		</div>
	);
}
