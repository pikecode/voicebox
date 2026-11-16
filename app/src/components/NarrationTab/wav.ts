/** Encode mono PCM16 WAV, resampling is handled by the browser decoder. */
export function encodeNarrationWav(
  clips: Float32Array[],
  sampleRate: number,
  gapMs = 200,
): ArrayBuffer {
  const gap = Math.round((sampleRate * gapMs) / 1000);
  const count =
    clips.reduce((total, clip) => total + clip.length, 0) + Math.max(0, clips.length - 1) * gap;
  if (count > 0x7fffffff / 2) throw new Error('音频过长，请分批导出');
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + count * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, count * 2, true);
  let offset = 44;
  clips.forEach((clip, index) => {
    for (const value of clip) {
      const sample = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
      view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      offset += 2;
    }
    if (index < clips.length - 1) offset += gap * 2;
  });
  return buffer;
}

export async function mergeNarrationAudio(
  urls: string[],
  onProgress: (message: string) => void,
): Promise<Blob> {
  const context = new AudioContext({ sampleRate: 24000 });
  try {
    const clips: Float32Array[] = [];
    for (let i = 0; i < urls.length; i++) {
      onProgress(`正在读取第 ${i + 1}/${urls.length} 句音频…`);
      const response = await fetch(urls[i]);
      if (!response.ok) throw new Error(`第 ${i + 1} 句音频读取失败，请检查服务或重新生成`);
      const audio = await context.decodeAudioData(await response.arrayBuffer());
      if (!audio.length) throw new Error(`第 ${i + 1} 句音频为空`);
      const mono = new Float32Array(audio.length);
      for (let channel = 0; channel < audio.numberOfChannels; channel++) {
        const data = audio.getChannelData(channel);
        for (let sample = 0; sample < data.length; sample++)
          mono[sample] += data[sample] / audio.numberOfChannels;
      }
      clips.push(mono);
    }
    onProgress('正在合并完整 WAV…');
    return new Blob([encodeNarrationWav(clips, context.sampleRate)], { type: 'audio/wav' });
  } finally {
    await context.close();
  }
}
