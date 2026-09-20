import {
  Channel,
  MathChannel,
  WaveformSource,
  channelForWaveformSource,
  mathForWaveformSource,
} from "../shared/scope-types.js";

const CHANNEL_ACCENTS: Record<Channel, string> = {
  [Channel.Ch1]: "#f4d03f",
  [Channel.Ch2]: "#2ecc71",
  [Channel.Ch3]: "#3498db",
  [Channel.Ch4]: "#e74c3c",
};

const MATH_ACCENTS: Record<MathChannel, string> = {
  [MathChannel.Math1]: "#9b59b6",
  [MathChannel.Math2]: "#1abc9c",
  [MathChannel.Math3]: "#e67e22",
  [MathChannel.Math4]: "#ec407a",
};

export function waveformSourceLabel(source: WaveformSource): string {
  const channel = channelForWaveformSource(source);
  if (channel !== null) return `CH${channel}`;
  const math = mathForWaveformSource(source);
  if (math !== null) return `MATH${math}`;
  return `Source ${source}`;
}

export function waveformSourceAccent(source: WaveformSource): string {
  const channel = channelForWaveformSource(source);
  if (channel !== null) return CHANNEL_ACCENTS[channel];
  const math = mathForWaveformSource(source);
  if (math !== null) return MATH_ACCENTS[math];
  return "#d7e0e8";
}

export function mathAccent(math: MathChannel): string {
  return MATH_ACCENTS[math];
}
