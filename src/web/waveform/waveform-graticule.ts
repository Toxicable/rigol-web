import type uPlot from "uplot";

export const SCOPE_HORIZONTAL_DIVISIONS = 10;
export const SCOPE_VERTICAL_DIVISIONS = 8;
const SCOPE_GRATICULE_STROKE = "#27313c";

export function graticuleLinePositions(
  origin: number,
  span: number,
  divisions: number,
): number[] {
  if (!Number.isFinite(origin) || !Number.isFinite(span) || !(span > 0)) {
    throw new Error("Graticule origin/span must be finite with positive span");
  }
  if (!Number.isSafeInteger(divisions) || divisions < 1) {
    throw new Error("Graticule divisions must be a positive integer");
  }

  return Array.from(
    { length: divisions + 1 },
    (_unused, index) => origin + (index * span) / divisions,
  );
}

function alignCanvasCoordinate(value: number, lineWidth: number): number {
  const rounded = Math.round(value);
  return lineWidth % 2 === 1 ? rounded + 0.5 : rounded;
}

export function drawScopeGraticule(plot: uPlot): void {
  const { left, top, width, height } = plot.bbox;
  if (!(width > 0) || !(height > 0)) {
    return;
  }

  const ctx = plot.ctx;
  const lineWidth = Math.max(1, Math.round(plot.pxRatio));
  const verticalLines = graticuleLinePositions(
    left,
    width,
    SCOPE_HORIZONTAL_DIVISIONS,
  );
  const horizontalLines = graticuleLinePositions(
    top,
    height,
    SCOPE_VERTICAL_DIVISIONS,
  );

  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = SCOPE_GRATICULE_STROKE;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([]);

  for (const x of verticalLines) {
    const alignedX = alignCanvasCoordinate(x, lineWidth);
    ctx.moveTo(alignedX, top);
    ctx.lineTo(alignedX, top + height);
  }
  for (const y of horizontalLines) {
    const alignedY = alignCanvasCoordinate(y, lineWidth);
    ctx.moveTo(left, alignedY);
    ctx.lineTo(left + width, alignedY);
  }

  ctx.stroke();
  ctx.restore();
}
