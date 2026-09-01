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
import { DeepCaptureKind, useScopeStore } from "../scope-store.js";
import type { ScopeWebSocketClient } from "../websocket-client.js";
import { WaveformDisplayMode, type WaveformController } from "./waveform-controller.js";

interface WaveformPlotProps {
  scope: ScopeState;
  controller: WaveformController;
  client: ScopeWebSocketClient;
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

function channelMarkerY(scope: ScopeState, channel: Channel, height: number): number {
  const state = scope.channels[channel - 1];
  if (state === undefined) {
    return height / 2;
  }
  const yMax = -state.offset + 4 * state.scale;
  return Math.max(0, Math.min(height, (yMax / (8 * state.scale)) * height));
}

function triggerMarkerY(scope: ScopeState, height: number): number | null {
  if (scope.trigger.type !== TriggerType.Edge) {
    return null;
  }
  const source = scope.channels[scope.trigger.source - 1];
  if (source === undefined) {
    return null;
  }
  const yMax = -source.offset + 4 * source.scale;
  return Math.max(
    0,
    Math.min(height, ((yMax - scope.trigger.level) / (8 * source.scale)) * height),
  );
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
  const axisConfigSignature = scope.channels
    .map((channel) => `${channel.channel}:${channel.enabled ? 1 : 0}:${channel.scale}:${channel.unit}`)
    .join("|");

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const options = {
      width,
      height,
      mode: 2,
      cursor: { show: false },
      legend: { show: false },
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
        },
        ...scope.channels.filter((channel) => channel.enabled).map(channelAxis),
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
        layout.plotWidth,
        channelInfo,
      );
    }
  }, [controller, deepCapture, isDeep, layout.plotWidth]);

  const beginHorizontalDrag = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - bounds.left;
    const localY = event.clientY - bounds.top;
    if (
      localX < layout.plotLeft ||
      localX > layout.plotLeft + layout.plotWidth ||
      localY < layout.plotTop ||
      localY > layout.plotTop + layout.plotHeight
    ) {
      return;
    }

    if (isDeep && deepCapture.kind === DeepCaptureKind.Ready) {
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        kind: "deep-horizontal",
        pointerId: event.pointerId,
        startX: event.clientX,
        startPosition: deepCapture.position,
        scale: deepCapture.scale,
        width: layout.plotWidth,
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
      width: layout.plotWidth,
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
    dragRef.current = {
      kind: "channel",
      pointerId: event.pointerId,
      channel,
      startY: event.clientY,
      startOffset: channelState.offset,
      startMarkerY: channelMarkerY(scope, channel, layout.plotHeight),
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
    const markerY = triggerMarkerY(scope, layout.plotHeight);
    if (source === undefined || markerY === null) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind: "trigger",
      pointerId: event.pointerId,
      startY: event.clientY,
      startLevel: scope.trigger.level,
      startMarkerY: markerY,
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

  const triggerY = triggerMarkerY(scope, layout.plotHeight);
  const isPannable = isDeep || scope.horizontal.mode === TimebaseMode.Main;
  const plotRight = layout.width - layout.plotLeft - layout.plotWidth;

  return (
    <div className="waveform-shell">
      <div
        className="waveform-grid"
        style={{
          left: layout.plotLeft,
          top: layout.plotTop,
          width: layout.plotWidth,
          height: layout.plotHeight,
        }}
        aria-hidden="true"
      />
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
          return (
            <button
              type="button"
              className={`waveform-marker channel-marker ch${channel}`}
              style={{
                left: layout.plotLeft + 2,
                top: layout.plotTop + channelMarkerY(scope, channel, layout.plotHeight),
              }}
              onPointerDown={(event: PointerEvent<HTMLButtonElement>) => beginChannelDrag(event, channel)}
              key={channel}
              title={`Drag CH${channel} offset`}
            >
              {channel}
            </button>
          );
        })}
        {draggingTrigger && scope.trigger.type === TriggerType.Edge && triggerY !== null ? (
          <div
            className={`trigger-drag-guide ch${scope.trigger.source}`}
            style={{
              left: layout.plotLeft,
              top: layout.plotTop + triggerY,
              width: layout.plotWidth,
            }}
            aria-hidden="true"
          />
        ) : null}
        {scope.trigger.type === TriggerType.Edge && triggerY !== null ? (
          <button
            type="button"
            className={`waveform-marker trigger-marker ch${scope.trigger.source}`}
            style={{
              right: plotRight + 2,
              top: layout.plotTop + triggerY,
            }}
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
