import { useEffect, useRef, useState, type PointerEvent } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import {
  Channel,
  TimebaseMode,
  TriggerType,
  type ChannelState,
  type ScopeState,
} from "../../shared/scope-types.js";
import { ControlKind, type InteractiveControl } from "../../shared/websocket-protocol.js";
import { formatAmplitude } from "../format-value.js";
import {
  channelOffsetFromMarkerDrag,
  horizontalPositionFromDrag,
  triggerLevelFromMarkerDrag,
} from "../interaction-math.js";
import type { ScopeBinding } from "../scope-binding.js";
import { DeepCaptureKind, useScopeStore } from "../scope-store.js";
import {
  divisionSplits,
  formatTimeAxisValues,
  timeAxisUnit,
} from "./waveform-axis.js";
import { WaveformDisplayMode, type WaveformController } from "./waveform-controller.js";
import { drawScopeGraticule } from "./waveform-graticule.js";
import {
  waveformMarkerPlacement,
  type WaveformMarkerPlacement,
} from "./waveform-marker.js";

interface WaveformPlotProps {
  scope: ScopeState;
  controller: WaveformController;
  client: ScopeBinding;
}

interface PlotLayout {
  width: number;
  height: number;
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
}

const INTERACTION_UPDATE_INTERVAL_MS = 50;
const AXIS_FONT = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const CHANNEL_STROKES: Record<Channel, string> = {
  [Channel.Ch1]: "#f4d03f",
  [Channel.Ch2]: "#2ecc71",
  [Channel.Ch3]: "#3498db",
  [Channel.Ch4]: "#e74c3c",
};

type DragState =
  | {
      kind: "live-horizontal";
      pointerId: number;
      startX: number;
      startPosition: number;
      scale: number;
      width: number;
    }
  | {
      kind: "deep-horizontal";
      pointerId: number;
      startX: number;
      startPosition: number;
      scale: number;
      width: number;
    }
  | {
      kind: "channel";
      pointerId: number;
      channel: Channel;
      startY: number;
      startOffset: number;
      startMarkerY: number;
      scale: number;
      height: number;
    }
  | {
      kind: "trigger";
      pointerId: number;
      startY: number;
      startLevel: number;
      startMarkerY: number;
      sourceOffset: number;
      scale: number;
      height: number;
    };

const CHANNELS = [Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4] as const;

function channelScaleName(channel: Channel): string {
  return `ch${channel}`;
}

function channelAxis(channel: ChannelState): uPlot.Axis {
  const stroke = CHANNEL_STROKES[channel.channel];
  return {
    scale: channelScaleName(channel.channel),
    side: 1,
    stroke,
    font: AXIS_FONT,
    gap: 4,
    size: 58,
    space: 20,
    incrs: [channel.scale],
    splits: (_plot, _axisIndex, scaleMin, scaleMax) =>
      divisionSplits(scaleMin, scaleMax, 8),
    grid: { show: false },
    ticks: {
      show: true,
      stroke,
      size: 5,
    },
    values: (_plot, ticks) => ticks.map((value) => formatAmplitude(value, channel.unit)),
  };
}

function readPlotLayout(plot: uPlot, width: number, height: number): PlotLayout {
  return {
    width,
    height,
    plotLeft: plot.bbox.left / plot.pxRatio,
    plotTop: plot.bbox.top / plot.pxRatio,
    plotWidth: plot.bbox.width / plot.pxRatio,
    plotHeight: plot.bbox.height / plot.pxRatio,
  };
}

function channelMarkerPlacement(
  scope: ScopeState,
  channel: Channel,
  layout: PlotLayout,
): WaveformMarkerPlacement {
  const state = scope.channels[channel - 1];
  if (
    !validMarkerLayout(layout) ||
    state === undefined ||
    !Number.isFinite(state.scale) ||
    state.scale <= 0 ||
    !Number.isFinite(state.offset)
  ) {
    return fallbackMarkerPlacement(layout);
  }
  return waveformMarkerPlacement(
    0,
    -state.offset - 4 * state.scale,
    -state.offset + 4 * state.scale,
    layout.plotTop,
    layout.plotHeight,
  );
}

function triggerMarkerPlacement(
  scope: ScopeState,
  layout: PlotLayout,
): WaveformMarkerPlacement | null {
  if (scope.trigger.type !== TriggerType.Edge) {
    return null;
  }
  const source = scope.channels[scope.trigger.source - 1];
  if (source === undefined) {
    return null;
  }
  if (
    !validMarkerLayout(layout) ||
    !Number.isFinite(source.scale) ||
    source.scale <= 0 ||
    !Number.isFinite(source.offset) ||
    !Number.isFinite(scope.trigger.level)
  ) {
    return null;
  }
  return waveformMarkerPlacement(
    scope.trigger.level,
    -source.offset - 4 * source.scale,
    -source.offset + 4 * source.scale,
    layout.plotTop,
    layout.plotHeight,
  );
}

function validMarkerLayout(layout: PlotLayout): boolean {
  return Number.isFinite(layout.plotTop) && layout.plotHeight > 0;
}

function fallbackMarkerPlacement(layout: PlotLayout): WaveformMarkerPlacement {
  return {
    top: Number.isFinite(layout.plotTop) ? layout.plotTop : 0,
    domainY: 0,
    offscreen: null,
  };
}

function markerDirectionGlyph(placement: WaveformMarkerPlacement): string | null {
  switch (placement.offscreen) {
    case "above":
      return "▲";
    case "below":
      return "▼";
    case null:
      return null;
  }
}

export function WaveformPlot({ scope, controller, client }: WaveformPlotProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const pendingInteractionRef = useRef<InteractiveControl | null>(null);
  const interactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [layout, setLayout] = useState<PlotLayout>({
    width: 1,
    height: 1,
    plotLeft: 0,
    plotTop: 0,
    plotWidth: 1,
    plotHeight: 1,
  });
  const [draggingTrigger, setDraggingTrigger] = useState(false);
  const applyOptimisticControl = useScopeStore(
    (state) => state.applyOptimisticControl,
  );
  const setDeepHorizontal = useScopeStore((state) => state.setDeepHorizontal);
  const deepCapture = useScopeStore((state) => state.deepCapture);
  const isDeep =
    deepCapture.kind === DeepCaptureKind.Ready &&
    controller.getDisplayMode() === WaveformDisplayMode.Deep;
  const horizontalScale =
    isDeep && deepCapture.kind === DeepCaptureKind.Ready
      ? deepCapture.scale
      : scope.horizontal.scale;
  const horizontalUnit = timeAxisUnit(horizontalScale);
  const axisConfigSignature = [
    horizontalUnit.symbol,
    ...scope.channels.map(
      (channel) => `${channel.channel}:${channel.enabled ? 1 : 0}:${channel.scale}:${channel.unit}`,
    ),
  ].join("|");

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const enabledChannels = scope.channels.filter((channel) => channel.enabled);
    const options = {
      width,
      height,
      mode: 2,
      cursor: { show: false },
      legend: { show: false },
      hooks: {
        drawClear: [drawScopeGraticule],
      },
      scales: {
        x: { auto: false, time: false },
        ch1: { auto: false },
        ch2: { auto: false },
        ch3: { auto: false },
        ch4: { auto: false },
      },
      axes: [
        {
          stroke: "#d5e0ea",
          font: "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          grid: { show: false },
          ticks: { show: false },
          size: 28,
          splits: (_plot: uPlot, _axisIndex: number, scaleMin: number, scaleMax: number) =>
            divisionSplits(scaleMin, scaleMax, 10),
          values: (_plot: uPlot, ticks: number[]) =>
            formatTimeAxisValues(ticks, horizontalUnit),
        },
        ...enabledChannels.map((channel) => channelAxis(channel)),
      ],
      series: [
        {},
        {
          label: "CH1",
          stroke: CHANNEL_STROKES[Channel.Ch1],
          width: 1.4,
          points: { show: false },
          facets: [{ scale: "x" }, { scale: "ch1" }],
        },
        {
          label: "CH2",
          stroke: CHANNEL_STROKES[Channel.Ch2],
          width: 1.4,
          points: { show: false },
          facets: [{ scale: "x" }, { scale: "ch2" }],
        },
        {
          label: "CH3",
          stroke: CHANNEL_STROKES[Channel.Ch3],
          width: 1.4,
          points: { show: false },
          facets: [{ scale: "x" }, { scale: "ch3" }],
        },
        {
          label: "CH4",
          stroke: CHANNEL_STROKES[Channel.Ch4],
          width: 1.4,
          points: { show: false },
          facets: [{ scale: "x" }, { scale: "ch4" }],
        },
      ],
    } as unknown as uPlot.Options;

    const plot = new uPlot(
      options,
      controller.getPlotData() as unknown as uPlot.AlignedData,
      host,
    );
    plotRef.current = plot;
    setLayout(readPlotLayout(plot, width, height));

    const redraw = () => {
      plot.setData(controller.getPlotData() as unknown as uPlot.AlignedData, false);
      plot.redraw();
    };
    const unsubscribe = controller.subscribe(redraw);
    const resizeObserver = new ResizeObserver(() => {
      const nextWidth = Math.max(1, host.clientWidth);
      const nextHeight = Math.max(1, host.clientHeight);
      plot.setSize({ width: nextWidth, height: nextHeight });
      setLayout(readPlotLayout(plot, nextWidth, nextHeight));
    });
    resizeObserver.observe(host);

    return () => {
      unsubscribe();
      resizeObserver.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [axisConfigSignature, controller]);

  useEffect(() => {
    const plot = plotRef.current;
    if (plot === null) {
      return;
    }

    const visibleRange =
      isDeep && deepCapture.kind === DeepCaptureKind.Ready
        ? {
            xMin: deepCapture.position - 5 * deepCapture.scale,
            xMax: deepCapture.position + 5 * deepCapture.scale,
          }
        : {
            xMin: scope.horizontal.position - 5 * scope.horizontal.scale,
            xMax: scope.horizontal.position + 5 * scope.horizontal.scale,
          };
    plot.setScale("x", { min: visibleRange.xMin, max: visibleRange.xMax });
    for (const channel of scope.channels) {
      plot.setScale(channelScaleName(channel.channel), {
        min: -channel.offset - 4 * channel.scale,
        max: -channel.offset + 4 * channel.scale,
      });
    }
  }, [deepCapture, isDeep, scope]);

  useEffect(() => {
    if (!isDeep || deepCapture.kind !== DeepCaptureKind.Ready) {
      return;
    }

    const xMin = deepCapture.position - 5 * deepCapture.scale;
    const xMax = deepCapture.position + 5 * deepCapture.scale;
    for (const channelInfo of deepCapture.channels) {
      controller.setDesiredDeepTimeRange(
        deepCapture.captureId,
        channelInfo.channel,
        xMin,
        xMax,
        layout.width,
        channelInfo,
      );
    }
  }, [controller, deepCapture, isDeep, layout.width]);

  const beginHorizontalDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (isDeep && deepCapture.kind === DeepCaptureKind.Ready) {
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        kind: "deep-horizontal",
        pointerId: event.pointerId,
        startX: event.clientX,
        startPosition: deepCapture.position,
        scale: deepCapture.scale,
        width: layout.width,
      };
      return;
    }

    if (scope.horizontal.mode !== TimebaseMode.Main) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind: "live-horizontal",
      pointerId: event.pointerId,
      startX: event.clientX,
      startPosition: scope.horizontal.position,
      scale: scope.horizontal.scale,
      width: layout.width,
    };
  };

  const beginChannelDrag = (
    event: PointerEvent<HTMLButtonElement>,
    channel: Channel,
  ) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const channelState = scope.channels[channel - 1];
    if (channelState === undefined) {
      return;
    }
    const placement = channelMarkerPlacement(scope, channel, layout);
    dragRef.current = {
      kind: "channel",
      pointerId: event.pointerId,
      channel,
      startY: event.clientY,
      startOffset: channelState.offset,
      startMarkerY: placement.domainY,
      scale: channelState.scale,
      height: layout.plotHeight,
    };
  };

  const beginTriggerDrag = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (scope.trigger.type !== TriggerType.Edge) {
      return;
    }
    const source = scope.channels[scope.trigger.source - 1];
    const placement = triggerMarkerPlacement(scope, layout);
    if (source === undefined || placement === null) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind: "trigger",
      pointerId: event.pointerId,
      startY: event.clientY,
      startLevel: scope.trigger.level,
      startMarkerY: placement.domainY,
      sourceOffset: source.offset,
      scale: source.scale,
      height: layout.plotHeight,
    };
    setDraggingTrigger(true);
  };

  const controlForPointer = (
    event: PointerEvent<HTMLDivElement>,
  ): InteractiveControl | null => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return null;
    }

    switch (drag.kind) {
      case "deep-horizontal":
        return null;
      case "live-horizontal":
        return {
          kind: ControlKind.HorizontalPosition,
          value: horizontalPositionFromDrag(
            drag.startPosition,
            event.clientX - drag.startX,
            drag.width,
            drag.scale,
          ),
        };
      case "channel":
        return {
          kind: ControlKind.ChannelOffset,
          channel: drag.channel,
          value: channelOffsetFromMarkerDrag(
            drag.startOffset,
            drag.startMarkerY,
            event.clientY - drag.startY,
            drag.height,
            drag.scale,
          ),
        };
      case "trigger":
        return {
          kind: ControlKind.TriggerLevel,
          value: triggerLevelFromMarkerDrag(
            drag.startLevel,
            drag.startMarkerY,
            event.clientY - drag.startY,
            drag.height,
            drag.scale,
            drag.sourceOffset,
          ),
        };
    }
  };

  const updateDeepPan = (event: PointerEvent<HTMLDivElement>): boolean => {
    const drag = dragRef.current;
    if (drag?.kind !== "deep-horizontal" || drag.pointerId !== event.pointerId) {
      return false;
    }

    const position = horizontalPositionFromDrag(
      drag.startPosition,
      event.clientX - drag.startX,
      drag.width,
      drag.scale,
    );
    setDeepHorizontal(position, drag.scale);
    return true;
  };

  const queueInteractionUpdate = (control: InteractiveControl): void => {
    pendingInteractionRef.current = control;
    if (interactionTimerRef.current !== null) {
      return;
    }

    interactionTimerRef.current = setTimeout(() => {
      interactionTimerRef.current = null;
      const pending = pendingInteractionRef.current;
      pendingInteractionRef.current = null;
      if (pending !== null) {
        client.interactionUpdate(pending);
      }
    }, INTERACTION_UPDATE_INTERVAL_MS);
  };

  const flushInteractionUpdate = (): void => {
    if (interactionTimerRef.current !== null) {
      clearTimeout(interactionTimerRef.current);
      interactionTimerRef.current = null;
    }
    pendingInteractionRef.current = null;
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (updateDeepPan(event)) {
      return;
    }

    const control = controlForPointer(event);
    if (control === null) {
      return;
    }
    applyOptimisticControl(control);
    queueInteractionUpdate(control);
  };

  const finishPointer = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.kind === "trigger" && drag.pointerId === event.pointerId) {
      setDraggingTrigger(false);
    }

    if (updateDeepPan(event)) {
      dragRef.current = null;
      return;
    }

    const control = controlForPointer(event);
    flushInteractionUpdate();
    dragRef.current = null;
    if (control === null) {
      return;
    }
    applyOptimisticControl(control);
    void client.interactionCommit(control).catch((error: unknown) => {
      useScopeStore.getState().setError(
        error instanceof Error ? error.message : String(error),
      );
    });
  };

  const triggerPlacement = triggerMarkerPlacement(scope, layout);
  const isPannable = isDeep || scope.horizontal.mode === TimebaseMode.Main;

  return (
    <div className="waveform-shell">
      <div
        className={`waveform-host ${isPannable ? "is-pannable" : ""}`}
        ref={hostRef}
      />
      <div
        className="waveform-interaction-layer"
        onPointerDown={beginHorizontalDrag}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
      >
        {CHANNELS.map((channel) => {
          const channelState = scope.channels[channel - 1];
          if (channelState === undefined || !channelState.enabled) {
            return null;
          }
          const placement = channelMarkerPlacement(scope, channel, layout);
          const directionGlyph = markerDirectionGlyph(placement);
          const directionText = placement.offscreen === "above"
            ? "; reference is above the visible plot"
            : placement.offscreen === "below"
              ? "; reference is below the visible plot"
              : "";
          return (
            <button
              type="button"
              className={`waveform-marker channel-marker ch${channel}`}
              style={{ left: layout.plotLeft + 2, top: placement.top }}
              onPointerDown={(event: PointerEvent<HTMLButtonElement>) => beginChannelDrag(event, channel)}
              key={channel}
              title={`Drag CH${channel} offset${directionText}`}
            >
              {directionGlyph === null ? null : (
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    left: "50%",
                    transform: "translateX(-50%)",
                    top: placement.offscreen === "above" ? -9 : "auto",
                    bottom: placement.offscreen === "below" ? -9 : "auto",
                    fontSize: 8,
                    lineHeight: 1,
                    color: "currentColor",
                  }}
                >
                  {directionGlyph}
                </span>
              )}
              {channel}
            </button>
          );
        })}
        {draggingTrigger && scope.trigger.type === TriggerType.Edge && triggerPlacement !== null ? (
          <div
            className={`trigger-drag-guide ch${scope.trigger.source}`}
            style={{
              left: layout.plotLeft,
              width: layout.plotWidth,
              right: "auto",
              top: triggerPlacement.top,
            }}
            aria-hidden="true"
          />
        ) : null}
        {scope.trigger.type === TriggerType.Edge && triggerPlacement !== null ? (
          <button
            type="button"
            className={`waveform-marker trigger-marker ch${scope.trigger.source}`}
            style={{ right: 2, top: triggerPlacement.top }}
            onPointerDown={beginTriggerDrag}
            title={`Drag CH${scope.trigger.source} trigger level`}
          >
            TCH{scope.trigger.source}
          </button>
        ) : null}
      </div>
    </div>
  );
}
