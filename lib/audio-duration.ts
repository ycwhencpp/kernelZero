const MPEG_1_BITRATES_KBPS = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
} as const;

const MPEG_2_BITRATES_KBPS = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return value;
}

function wavDurationSeconds(bytes: Uint8Array): number | null {
  if (
    bytes.byteLength < 12 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WAVE"
  ) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let byteRate = 0;
  let dataBytes = 0;
  let offset = 12;

  while (offset + 8 <= bytes.byteLength) {
    const chunkName = ascii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > bytes.byteLength) return null;

    if (chunkName === "fmt " && chunkSize >= 16) {
      byteRate = view.getUint32(dataOffset + 8, true);
    } else if (chunkName === "data") {
      dataBytes += chunkSize;
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  if (byteRate <= 0 || dataBytes <= 0) return null;
  return dataBytes / byteRate;
}

function id3v2Length(bytes: Uint8Array, offset: number): number | null {
  if (
    offset + 10 > bytes.byteLength ||
    ascii(bytes, offset, 3) !== "ID3"
  ) {
    return null;
  }
  const sizeBytes = bytes.subarray(offset + 6, offset + 10);
  if ([...sizeBytes].some((value) => (value & 0x80) !== 0)) return null;
  const bodyLength =
    (sizeBytes[0] << 21) |
    (sizeBytes[1] << 14) |
    (sizeBytes[2] << 7) |
    sizeBytes[3];
  const hasFooter = (bytes[offset + 5] & 0x10) !== 0;
  return 10 + bodyLength + (hasFooter ? 10 : 0);
}

type Mp3Frame = {
  byteLength: number;
  durationSeconds: number;
};

function mp3Frame(bytes: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > bytes.byteLength) return null;
  const header =
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>> 0;
  if (((header & 0xffe00000) >>> 0) !== 0xffe00000) return null;

  const versionBits = (header >>> 19) & 0b11;
  const layerBits = (header >>> 17) & 0b11;
  const bitrateIndex = (header >>> 12) & 0b1111;
  const sampleRateIndex = (header >>> 10) & 0b11;
  const padding = (header >>> 9) & 1;
  if (
    versionBits === 0b01 ||
    layerBits === 0 ||
    bitrateIndex === 0 ||
    bitrateIndex === 0b1111 ||
    sampleRateIndex === 0b11
  ) {
    return null;
  }

  const layer = (4 - layerBits) as 1 | 2 | 3;
  const mpeg1 = versionBits === 0b11;
  const bitrateTable = mpeg1
    ? MPEG_1_BITRATES_KBPS[layer]
    : MPEG_2_BITRATES_KBPS[layer];
  const bitrate = bitrateTable[bitrateIndex] * 1_000;
  const baseSampleRate = [44_100, 48_000, 32_000][sampleRateIndex];
  const sampleRate = versionBits === 0b11
    ? baseSampleRate
    : versionBits === 0b10
      ? baseSampleRate / 2
      : baseSampleRate / 4;
  const samplesPerFrame = layer === 1
    ? 384
    : layer === 2 || mpeg1
      ? 1_152
      : 576;
  const byteLength = layer === 1
    ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
    : Math.floor(
        ((layer === 3 && !mpeg1 ? 72 : 144) * bitrate) / sampleRate + padding,
      );
  if (byteLength < 4 || offset + byteLength > bytes.byteLength) return null;

  return {
    byteLength,
    durationSeconds: samplesPerFrame / sampleRate,
  };
}

function mp3DurationSeconds(bytes: Uint8Array): number | null {
  let offset = 0;
  let frameCount = 0;
  let durationSeconds = 0;

  while (offset < bytes.byteLength) {
    const tagLength = id3v2Length(bytes, offset);
    if (tagLength !== null) {
      offset += tagLength;
      continue;
    }

    const frame = mp3Frame(bytes, offset);
    if (!frame) {
      offset += 1;
      continue;
    }
    frameCount += 1;
    durationSeconds += frame.durationSeconds;
    offset += frame.byteLength;
  }

  return frameCount > 0 ? durationSeconds : null;
}

/** Reads duration from the encoded audio container without invoking a media process. */
export function encodedAudioDurationSeconds(
  audio: ArrayBuffer,
  contentType: string,
): number {
  const bytes = new Uint8Array(audio);
  const normalizedType = contentType.split(";", 1)[0].trim().toLowerCase();
  const durationSeconds = normalizedType === "audio/wav" || normalizedType === "audio/x-wav"
    ? wavDurationSeconds(bytes)
    : normalizedType === "audio/mpeg" || normalizedType === "audio/mp3"
      ? mp3DurationSeconds(bytes)
      : null;

  if (!durationSeconds || !Number.isFinite(durationSeconds)) {
    throw new Error(
      `Unable to determine the generated audio duration from ${normalizedType || "unknown audio"} output.`,
    );
  }
  return durationSeconds;
}
