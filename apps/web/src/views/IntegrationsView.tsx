import { useTranslation } from "react-i18next";
import { Layout } from "@/components/Layout";
import { ExternalLink, Plug } from "lucide-react";

/**
 * /integrations — stub for V1.5 MCP server management UI.
 *
 * V1 routines can already invoke MCP tools via the `agent` step's
 * `mcp_servers_allowed` field once the user has installed an MCP server
 * through the chat's `/mcp install` command. The dedicated install UI lands
 * in V1.5; this view documents the path in the meantime.
 *
 * See `omp-deck/docs/proposals/routines-v1-plan.md` §5 for the design.
 */
export function IntegrationsView() {
	const { t } = useTranslation();
	return (
		<Layout
			sidebar={{
				content: (
					<div className="p-3">
						<div className="meta mb-2">{t("views.integrations.title")}</div>
						<div className="text-sm text-ink-3">
							{t("views.integrations.sidebarHint")}
						</div>
					</div>
				),
				label: t("views.integrations.title"),
			}}
			main={
				<div className="flex h-full min-h-0 flex-col">
					<div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
						<div className="meta">{t("views.integrations.title")}</div>
						<span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta text-accent">
							V1.5
						</span>
					</div>
					<div className="flex flex-1 items-center justify-center px-6 py-8">
						<div className="max-w-2xl space-y-4">
							<div className="flex items-center gap-2">
								<Plug className="h-5 w-5 text-accent" />
								<h2 className="text-lg font-medium text-ink">{t("views.integrations.comingSoon")}</h2>
							</div>
							<p className="text-sm text-ink-2">
								{t("views.integrations.catalogIntro")}{" "}
								<a
									href="https://github.com/taylorwilsdon/google_workspace_mcp"
									target="_blank"
									rel="noreferrer"
									className="text-accent hover:underline"
								>
									Google Workspace
								</a>{" "}
								{t("views.integrations.catalogDetail")}
							</p>
							<p className="text-sm text-ink-2">
								<strong className="text-ink">{t("views.integrations.inV1")}</strong>{" "}
								{t("views.integrations.v1Install")}{" "}
								<code className="paper-code px-1 py-0.5 text-xs">/mcp install &lt;url-or-smithery-id&gt;</code>{" "}
								{t("views.integrations.v1Or")}{" "}
								<code className="paper-code px-1 py-0.5 text-xs">/mcp smithery-search &lt;query&gt;</code>.
								{t("views.integrations.v1OnceInstalled")} <code>agent</code>{" "}
								{t("views.integrations.v1Via")}{" "}
								<code className="paper-code px-1 py-0.5 text-xs">mcp_servers_allowed: [...]</code>.
							</p>
							<p className="text-sm text-ink-2">
								{t("views.integrations.dedicatedStep")} <code>mcp</code>{" "}
								{t("views.integrations.dedicatedStep2")}{" "}
								<code className="paper-code px-1 py-0.5 text-xs">callMcpTool()</code>{" "}
								{t("views.integrations.dedicatedStep3")}
							</p>
							<div className="rounded border border-line bg-paper-2 p-3">
								<div className="meta mb-1.5">{t("views.integrations.designDoc")}</div>
								<a
									href="https://github.com/bjb2/omp-deck/blob/main/docs/proposals/routines-v1-plan.md#5-integrations-via-mcp-v15"
									target="_blank"
									rel="noreferrer"
									className="flex items-center gap-1 text-sm text-accent hover:underline"
								>
									routines-v1-plan.md §5
									<ExternalLink className="h-3 w-3" />
								</a>
							</div>
						</div>
					</div>
				</div>
			}
			inspector={null}
			topBar={null}
		/>
	);
}
