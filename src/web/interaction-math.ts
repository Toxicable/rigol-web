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

export function channelOffsetFromMarkerDrag(
  startOffset: number,
  startMarkerY: number,
  deltaY: number,
  plotHeight: number,
  channelScale: number,
): number {
  if (!Number.isFinite(startOffset)) {
    throw new Error("Channel offset must be finite");
  }
  if (!(plotHeight > 0) || !(channelScale > 0)) {
    throw new Error("Plot height and channel scale must be positive");
  }
  if (deltaY === 0) {
    return startOffset;
  }

  const markerY = startMarkerY + deltaY;
  return 4 * channelScale - markerY * ((8 * channelScale) / plotHeight);
}

export function triggerLevelFromMarkerDrag(
  startLevel: number,
  startMarkerY: number,
  deltaY: number,
  plotHeight: number,
  sourceChannelScale: number,
  sourceChannelOffset: number,
): number {
  if (!Number.isFinite(startLevel) || !Number.isFinite(sourceChannelOffset)) {
    throw new Error("Trigger level and source channel offset must be finite");
  }
  if (deltaY === 0) {
    return startLevel;
  }

  return -sourceChannelOffset + channelOffsetFromMarkerDrag(
    startLevel,
    startMarkerY,
    deltaY,
    plotHeight,
    sourceChannelScale,
  );
}
