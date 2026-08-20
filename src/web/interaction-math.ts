export interface HorizontalRange {
  xMin: number;
  xMax: number;
}

export function horizontalPositionFromDrag(
  startPosition: number,
  deltaX: number,
  plotWidth: number,
  horizontalScale: number,
): number {
  if (!(plotWidth > 0) || !(horizontalScale > 0)) {
    throw new Error("Plot width and horizontal scale must be positive");
  }

  return startPosition - deltaX * ((10 * horizontalScale) / plotWidth);
}

export function horizontalRangeFromDrag(
  startRange: HorizontalRange,
  deltaX: number,
  plotWidth: number,
): HorizontalRange {
  const span = startRange.xMax - startRange.xMin;
  if (!(plotWidth > 0) || !(span > 0)) {
    throw new Error("Plot width and horizontal range must be positive");
  }

  const delta = deltaX * (span / plotWidth);
  return {
    xMin: startRange.xMin - delta,
    xMax: startRange.xMax - delta,
  };
}

export function channelOffsetFromDrag(
  startOffset: number,
  deltaY: number,
  plotHeight: number,
  channelScale: number,
): number {
  if (!(plotHeight > 0) || !(channelScale > 0)) {
    throw new Error("Plot height and channel scale must be positive");
  }

  return startOffset - deltaY * ((8 * channelScale) / plotHeight);
}

export function triggerLevelFromDrag(
  startLevel: number,
  deltaY: number,
  plotHeight: number,
  sourceChannelScale: number,
): number {
  return channelOffsetFromDrag(
    startLevel,
    deltaY,
    plotHeight,
    sourceChannelScale,
  );
}
