import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** Field label wrapper. `tone="danger"` colors the hint red. */
export function Field({
	label,
	hint,
	tone,
	children,
}: {
	label: string;
	hint?: string;
	tone?: "danger" | "warn";
	children: ReactNode;
}) {
	const toneClass =
		tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-ink-4";
	return (
		<div>
			<div className="meta mb-0.5 flex items-baseline gap-2">
				<span>{label}</span>
				{hint ? <span className={`font-mono text-2xs ${toneClass}`}>{hint}</span> : null}
			</div>
			{children}
		</div>
	);
}

export function TextInput({
	value,
	onChange,
	placeholder,
	mono,
}: {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	mono?: boolean;
}) {
	return (
		<input
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			className={`field h-7 w-full px-2 text-2xs ${mono ? "font-mono" : ""}`}
		/>
	);
}

export function TextArea({
	value,
	onChange,
	placeholder,
	rows = 3,
	mono = true,
}: {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	rows?: number;
	mono?: boolean;
}) {
	return (
		<textarea
			value={value}
			onChange={(e) => onChange(e.target.value)}
			rows={rows}
			placeholder={placeholder}
			className={`field w-full resize-y px-2 py-1.5 text-2xs leading-relaxed ${mono ? "font-mono" : ""}`}
		/>
	);
}

export function NumInput({
	value,
	onChange,
	placeholder,
}: {
	value: number | undefined;
	onChange: (next: number | undefined) => void;
	placeholder?: string;
}) {
	return (
		<input
			type="number"
			value={value ?? ""}
			onChange={(e) => {
				const raw = e.target.value;
				if (raw === "") onChange(undefined);
				else {
					const n = Number(raw);
					onChange(Number.isFinite(n) ? n : undefined);
				}
			}}
			placeholder={placeholder}
			className="field h-7 w-full px-2 font-mono text-2xs"
		/>
	);
}

export function Select<T extends string>({
	value,
	onChange,
	options,
}: {
	value: T;
	onChange: (next: T) => void;
	options: ReadonlyArray<{ value: T; label: string }>;
}) {
	return (
		<select
			value={value}
			onChange={(e) => onChange(e.target.value as T)}
			className="field h-7 w-full px-2 font-mono text-2xs"
		>
			{options.map((o) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</select>
	);
}

export function TagInput({
	values,
	onChange,
	placeholder,
}: {
	values: string[];
	onChange: (next: string[]) => void;
	placeholder?: string;
}) {
	const { t } = useTranslation();
	function remove(idx: number): void {
		const next = values.slice();
		next.splice(idx, 1);
		onChange(next);
	}
	function add(raw: string): void {
		const trimmed = raw.trim();
		if (!trimmed) return;
		if (values.includes(trimmed)) return;
		onChange([...values, trimmed]);
	}
	return (
		<div className="rounded border border-line bg-paper-2 px-1.5 py-1">
			<div className="flex flex-wrap items-center gap-1">
				{values.map((v, idx) => (
					<span
						key={`${v}-${idx}`}
						className="inline-flex items-center gap-1 rounded bg-paper-3 px-1.5 py-0.5 font-mono text-2xs text-ink-2"
					>
						{v}
						<button
							type="button"
							onClick={() => remove(idx)}
							className="text-ink-4 hover:text-danger"
							aria-label={t("routines.formPrimitives.removeTag", { value: v })}
						>
							×
						</button>
					</span>
				))}
				<input
					placeholder={placeholder ?? t("routines.formPrimitives.addPlaceholder")}
					className="min-w-[6ch] flex-1 bg-transparent px-1 py-0 font-mono text-2xs text-ink outline-none placeholder:text-ink-4"
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === ",") {
							e.preventDefault();
							add((e.target as HTMLInputElement).value);
							(e.target as HTMLInputElement).value = "";
						} else if (e.key === "Backspace" && (e.target as HTMLInputElement).value === "" && values.length > 0) {
							remove(values.length - 1);
						}
					}}
					onBlur={(e) => {
						add(e.target.value);
						e.target.value = "";
					}}
				/>
			</div>
		</div>
	);
}

export function KeyValueEditor({
	pairs,
	onChange,
	keyPlaceholder,
	valuePlaceholder,
}: {
	pairs: Record<string, string>;
	onChange: (next: Record<string, string>) => void;
	keyPlaceholder?: string;
	valuePlaceholder?: string;
}) {
	const { t } = useTranslation();
	const entries = Object.entries(pairs);
	function setEntry(idx: number, key: string, value: string): void {
		const next = entries.slice();
		next[idx] = [key, value];
		onChange(toObj(next));
	}
	function add(): void {
		onChange(toObj([...entries, ["", ""]]));
	}
	function remove(idx: number): void {
		const next = entries.slice();
		next.splice(idx, 1);
		onChange(toObj(next));
	}
	return (
		<div className="space-y-1">
			{entries.length === 0 ? (
				<div className="font-mono text-2xs text-ink-4">{t("routines.formPrimitives.none")}</div>
			) : (
				entries.map(([k, v], idx) => (
					<div key={idx} className="grid grid-cols-[1fr_1fr_auto] gap-1">
						<input
							value={k}
							onChange={(e) => setEntry(idx, e.target.value, v)}
							placeholder={keyPlaceholder ?? t("routines.formPrimitives.key")}
							className="field h-7 w-full px-1.5 font-mono text-2xs"
						/>
						<input
							value={v}
							onChange={(e) => setEntry(idx, k, e.target.value)}
							placeholder={valuePlaceholder ?? t("routines.formPrimitives.value")}
							className="field h-7 w-full px-1.5 font-mono text-2xs"
						/>
						<button
							type="button"
							onClick={() => remove(idx)}
							className="btn-ghost h-7 w-7 p-0 text-ink-4 hover:text-danger"
							aria-label={t("routines.formPrimitives.remove")}
						>
							×
						</button>
					</div>
				))
			)}
			<button
				type="button"
				onClick={add}
				className="font-mono text-2xs text-ink-3 underline-offset-2 hover:text-ink hover:underline"
			>
				{t("routines.formPrimitives.addRow")}
			</button>
		</div>
	);
}

function toObj(entries: Array<[string, string]>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of entries) {
		if (k.trim() !== "") out[k] = v;
	}
	return out;
}
