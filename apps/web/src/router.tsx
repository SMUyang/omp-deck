import { lazy, Suspense, useEffect, useRef } from "react";
import { createBrowserRouter, Outlet, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { ChatView } from "./views/ChatView";
import { OnboardingView } from "./views/OnboardingView";

// Lazy-loaded views — keeps the initial bundle to the chat shell only.
// Tasks/Routines drag in @dnd-kit + @xyflow; Kb drags react-markdown +
// highlight.js; each loads on first navigation to that route.
const TasksView = lazy(() => import("./views/TasksView").then((m) => ({ default: m.TasksView })));
const RoutinesView = lazy(() => import("./views/RoutinesView").then((m) => ({ default: m.RoutinesView })));
const RunDetailView = lazy(() => import("./views/RunDetailView").then((m) => ({ default: m.RunDetailView })));
const InboxView = lazy(() => import("./views/InboxView").then((m) => ({ default: m.InboxView })));
const MarketplaceView = lazy(() => import("./views/MarketplaceView").then((m) => ({ default: m.MarketplaceView })));
const KbView = lazy(() => import("./views/KbView").then((m) => ({ default: m.KbView })));
const MemoryView = lazy(() => import("./views/MemoryView").then((m) => ({ default: m.MemoryView })));
const SkillsView = lazy(() => import("./views/SkillsView").then((m) => ({ default: m.SkillsView })));
const IntegrationsView = lazy(() => import("./views/IntegrationsView").then((m) => ({ default: m.IntegrationsView })));
const TopologyView = lazy(() =>
	import("./views/TopologyView").then((m) => ({ default: m.TopologyView })),
);
import { onboardingApi } from "./lib/onboarding-api";

const SettingsView = lazy(() =>
	import("./views/SettingsView").then((m) => ({ default: m.SettingsView })),
);

/**
 * First-paint redirect: if the server reports `needsOnboarding`, route
 * brand-new users to the wizard instead of an empty chat. Only triggers
 * once per page load and only when the user lands on `/` — typing any
 * other URL bypasses the gate (the wizard is escapable, and we don't
 * want to re-trap users who already saw it).
 */
function OnboardingGate() {
	const navigate = useNavigate();
	const location = useLocation();
	const checked = useRef(false);
	useEffect(() => {
		if (checked.current) return;
		checked.current = true;
		if (location.pathname !== "/") return; // user explicitly navigated; respect that
		void onboardingApi
			.state()
			.then((state) => {
				if (state.needsOnboarding) navigate("/onboarding", { replace: true });
			})
			.catch(() => {
				// State endpoint failed — don't block the app. Onboarding can be
				// re-run from Settings if the gate misfires.
			});
	}, [location.pathname, navigate]);
	return <Outlet />;
}


function RouteFallback() {
	return <div className="flex h-64 items-center justify-center p-4 text-sm text-ink-3">Loading…</div>;
}

let _router: ReturnType<typeof createBrowserRouter> | undefined;

function getRouter() {
	return _router ?? (_router = createBrowserRouter([
		{
			element: <OnboardingGate />,
			children: [
				{ path: "/", element: <ChatView /> },
				{ path: "/tasks", element: (
					<Suspense fallback={<RouteFallback />}><TasksView /></Suspense>
				) },
				{ path: "/routines", element: (
					<Suspense fallback={<RouteFallback />}><RoutinesView /></Suspense>
				) },
				{ path: "/routines/:id/runs/:runId", element: (
					<Suspense fallback={<RouteFallback />}><RunDetailView /></Suspense>
				) },
				{ path: "/inbox", element: (
					<Suspense fallback={<RouteFallback />}><InboxView /></Suspense>
				) },
				{ path: "/marketplace", element: (
					<Suspense fallback={<RouteFallback />}><MarketplaceView /></Suspense>
				) },
				{ path: "/skills", element: (
					<Suspense fallback={<RouteFallback />}><SkillsView /></Suspense>
				) },
				{ path: "/memory", element: (
					<Suspense fallback={<RouteFallback />}><MemoryView /></Suspense>
				) },
				{ path: "/topology", element: (
					<Suspense fallback={<RouteFallback />}><TopologyView /></Suspense>
				) },
				{ path: "/kb", element: (
					<Suspense fallback={<RouteFallback />}><KbView /></Suspense>
				) },
				{ path: "/integrations", element: (
					<Suspense fallback={<RouteFallback />}><IntegrationsView /></Suspense>
				) },
				{
					path: "/settings",
					element: (
						<Suspense fallback={<RouteFallback />}>
							<SettingsView />
						</Suspense>
					),
				},
				{ path: "/onboarding", element: <OnboardingView /> },
			],
		},
	]));
}

export function AppRouter() {
	return <RouterProvider router={getRouter()} />;
}
