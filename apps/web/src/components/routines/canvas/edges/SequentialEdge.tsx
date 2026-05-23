/**
 * Default canvas edge. Curved bezier path; renders inferred edges as dashed
 * so users can tell the difference between an explicitly authored layout edge
 * and one P1.3's `graph-import` synthesized from `when:` references.
 *
 * P3 will introduce labeled `true`/`false` variants on branch outputs.
 */

import {
	BaseEdge,
	getBezierPath,
	type EdgeProps,
} from "@xyflow/react";
import { memo } from "react";

import type { SequentialEdge as SequentialEdgeType } from "../graph-types";

export const SequentialEdge = memo(function SequentialEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	data,
	style,
	markerEnd,
}: EdgeProps<SequentialEdgeType>) {
	const [path] = getBezierPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
	});

	const inferred = data?.inferred ?? false;
	return (
		<BaseEdge
			id={id}
			path={path}
			markerEnd={markerEnd}
			style={{
				strokeWidth: 1,
				strokeDasharray: inferred ? "4 4" : undefined,
				...style,
			}}
		/>
	);
});
