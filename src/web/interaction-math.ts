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
