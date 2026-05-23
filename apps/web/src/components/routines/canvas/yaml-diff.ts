/**
 * Tiny line-diff helper used by SavePreviewDialog (T-70).
 *
 * We render the compiled YAML pre-save with green/red line tints so the user
 * can verify that branch compilation didn't silently rewrite anything they
 * didn't intend. A canonical diff library would work but is overkill here:
 * routine YAML is small (typically < 80 lines), so a textbook LCS in O(n*m)
 * is fast enough and ships zero new deps.
 *
 * The shape returned is intentionally simple: an ordered list of
 * `{ kind, text }` lines. `same` lines render neutral; `add` lines render with
 * a green tint and a leading "+"; `del` lines render with a red tint and a
 * leading "-". When the two inputs are byte-identical the list is just one
 * `same` line per line of input — callers can short-circuit on that.
 */

export type DiffKind = "same" | "add" | "del";

export interface DiffLine {
	readonly kind: DiffKind;
	readonly text: string;
}

/**
 * Compute a line-level diff from `before` to `after`. Splits both on `\n`,
 * drops the trailing empty cell that comes from a terminal newline, then
 * walks an LCS table to recover the longest matched sequence and emit a
 * unified-style list.
 *
 * Empty/whitespace lines compare verbatim — a blank line that moves is a
 * delete + add, not a "same". That's the right answer for YAML where blank
 * lines are structural separators between blocks.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
	const a = splitLines(before);
	const b = splitLines(after);

	if (a.length === 0 && b.length === 0) return [];
	if (a.length === 0) return b.map((text) => ({ kind: "add" as const, text }));
	if (b.length === 0) return a.map((text) => ({ kind: "del" as const, text }));

	// LCS length table. dp[i][j] = length of LCS of a[0..i) and b[0..j).
	const n = a.length;
	const m = b.length;
	const dp: Uint32Array = new Uint32Array((n + 1) * (m + 1));
	const stride = m + 1;
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < m; j++) {
			const here = i * stride + j;
			const down = (i + 1) * stride + j;
			const right = i * stride + (j + 1);
			const diag = (i + 1) * stride + (j + 1);
			if (a[i] === b[j]) {
				dp[diag] = dp[here]! + 1;
			} else {
				const dv = dp[down]!;
				const rv = dp[right]!;
				dp[diag] = dv >= rv ? dv : rv;
			}
		}
	}

	// Backtrack to recover the merged sequence.
	const out: DiffLine[] = [];
	let i = n;
	let j = m;
	while (i > 0 && j > 0) {
		if (a[i - 1] === b[j - 1]) {
			out.push({ kind: "same", text: a[i - 1]! });
			i--;
			j--;
			continue;
		}
		const up = dp[(i - 1) * stride + j]!;
		const left = dp[i * stride + (j - 1)]!;
		// Tie-break preference: when dp[up] == dp[left], walk left (emit add) so
		// that in the reversed final ordering, deletes come before adds — the
		// conventional unified-diff shape for replacements.
		if (up > left) {
			out.push({ kind: "del", text: a[i - 1]! });
			i--;
		} else {
			out.push({ kind: "add", text: b[j - 1]! });
			j--;
		}
	}
	while (i > 0) {
		out.push({ kind: "del", text: a[i - 1]! });
		i--;
	}
	while (j > 0) {
		out.push({ kind: "add", text: b[j - 1]! });
		j--;
	}
	out.reverse();
	return out;
}

/**
 * Convenience predicate. `true` when the two strings produce a diff with no
 * adds and no deletes — i.e. they're equivalent after normalizing the trailing
 * newline that we strip in `splitLines`.
 */
export function diffIsClean(diff: ReadonlyArray<DiffLine>): boolean {
	for (const line of diff) {
		if (line.kind !== "same") return false;
	}
	return true;
}

function splitLines(text: string): string[] {
	if (text === "") return [];
	const parts = text.split("\n");
	// A trailing newline produces a phantom empty cell; drop it so identical
	// inputs differing only by trailing-newline aren't flagged as a diff.
	if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
	return parts;
}
