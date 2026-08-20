export interface DownsampledWaveform {
  sampleIndices: Uint32Array;
  values: Float32Array;
}

function validateRequest(
  source: Float32Array,
  startSample: number,
  endSample: number,
  targetPixels: number,
): void {
  if (!Number.isInteger(startSample) || !Number.isInteger(endSample)) {
    throw new Error("Downsample source range must use integer sample indices");
  }
  if (startSample < 0 || endSample <= startSample || endSample > source.length) {
    throw new Error("Downsample source range is outside the source waveform");
  }
  if (!Number.isInteger(targetPixels) || targetPixels < 1) {
    throw new Error("targetPixels must be a positive integer");
  }
}

function requireFiniteSample(value: number, sampleIndex: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Source waveform sample ${sampleIndex} is not finite`);
  }
}

export function downsampleWaveform(
  source: Float32Array,
  startSample: number,
  endSample: number,
  targetPixels: number,
): DownsampledWaveform {
  validateRequest(source, startSample, endSample, targetPixels);
  const sourceCount = endSample - startSample;

  if (sourceCount <= targetPixels * 2) {
    const sampleIndices = new Uint32Array(sourceCount);
    const values = new Float32Array(sourceCount);
    for (let offset = 0; offset < sourceCount; offset += 1) {
      const sampleIndex = startSample + offset;
      const value = source[sampleIndex]!;
      requireFiniteSample(value, sampleIndex);
      sampleIndices[offset] = sampleIndex;
      values[offset] = value;
    }
    return { sampleIndices, values };
  }

  const bucketCount = Math.min(targetPixels, sourceCount);
  const sampleIndices = new Uint32Array(bucketCount * 2);
  const values = new Float32Array(bucketCount * 2);
  let outputCount = 0;

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const bucketStart = startSample + Math.floor((bucket * sourceCount) / bucketCount);
    const bucketEnd = startSample + Math.floor(((bucket + 1) * sourceCount) / bucketCount);

    let minIndex = bucketStart;
    let maxIndex = bucketStart;
    let minValue = source[bucketStart]!;
    let maxValue = minValue;
    requireFiniteSample(minValue, bucketStart);

    for (let sampleIndex = bucketStart + 1; sampleIndex < bucketEnd; sampleIndex += 1) {
      const value = source[sampleIndex]!;
      requireFiniteSample(value, sampleIndex);
      if (value < minValue) {
        minValue = value;
        minIndex = sampleIndex;
      }
      if (value > maxValue) {
        maxValue = value;
        maxIndex = sampleIndex;
      }
    }

    if (minIndex === maxIndex) {
      sampleIndices[outputCount] = minIndex;
      values[outputCount] = minValue;
      outputCount += 1;
      continue;
    }

    if (minIndex < maxIndex) {
      sampleIndices[outputCount] = minIndex;
      values[outputCount] = minValue;
      sampleIndices[outputCount + 1] = maxIndex;
      values[outputCount + 1] = maxValue;
    } else {
      sampleIndices[outputCount] = maxIndex;
      values[outputCount] = maxValue;
      sampleIndices[outputCount + 1] = minIndex;
      values[outputCount + 1] = minValue;
    }
    outputCount += 2;
  }

  return {
    sampleIndices: sampleIndices.slice(0, outputCount),
    values: values.slice(0, outputCount),
  };
}
