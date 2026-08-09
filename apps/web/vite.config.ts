import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const SERVER_PORT = process.env.OMP_DECK_PORT ?? "8787";
const SERVER_HOST = process.env.OMP_DECK_HOST ?? "127.0.0.1";
const WEB_PORT = Number(process.env.OMP_DECK_WEB_PORT ?? "5173");

const SERVER_HTTP = `http://${SERVER_HOST}:${SERVER_PORT}`;
const SERVER_WS = `ws://${SERVER_HOST}:${SERVER_PORT}`;

export default defineConfig({
	plugins: [react()],
	envPrefix: ["VITE_", "OMP_DECK_"],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		host: SERVER_HOST,
		port: WEB_PORT,
		proxy: {
			"/api": { target: SERVER_HTTP, changeOrigin: true },
			"/ws": { target: SERVER_WS, ws: true, changeOrigin: true },
		},
	},
	build: {
		outDir: "dist",
		// Disable sourcemaps in production — saves ~4MB download on first load.
		// Dev mode still has sourcemaps via Vite's dev server.
		sourcemap: false,
		// Raise limit — our app is legitimately large; the warning is noise.
		chunkSizeWarningLimit: 1200,
		rollupOptions: {
			output: {
				// Split vendor libraries into cacheable chunks.
				// React/zustand/router rarely change between deploys → browser cache hits.
				manualChunks: {
					// Core React runtime (~140KB)
					"react-vendor": ["react", "react-dom", "react-router-dom"],
					// State management (~30KB)
					"state-vendor": ["zustand"],
					// Markdown rendering (~200KB) — used by Chat, KB, Memory
					"markdown-vendor": ["react-markdown", "remark-gfm", "rehype-highlight", "highlight.js"],
				},
			},
		},
	},
});
