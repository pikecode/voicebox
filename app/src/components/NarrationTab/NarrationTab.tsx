import { mergeNarrationAudio } from './wav';
import { splitNarration } from './segments';
import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api/client';
import type { GenerationRequest, VoiceProfileResponse } from '@/lib/api/types';
import { Button } from '@/components/ui/button';

type Segment = {
  text: string;
  id?: string;
  transcript?: string;
  error?: string;
  completed?: boolean;
  generationMs?: number;
  transcriptionMs?: number;
};
const normalize = (text: string) => text.replace(/[\p{P}\p{Z}\s]/gu, '');

export function NarrationTab() {
  const [profiles, setProfiles] = useState<VoiceProfileResponse[]>([]);
  const [profile, setProfile] = useState(() => localStorage.getItem('narration-profile') || '');
  const [script, setScript] = useState(() => localStorage.getItem('narration-script') || '');
  const [sources, setSources] = useState(() => localStorage.getItem('narration-sources') || '');
  const [confirmed, setConfirmed] = useState(false);
  const [segments, setSegments] = useState<Segment[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('narration-segments') || '[]');
      return Array.isArray(saved)
        ? saved.filter(
            (item): item is Segment =>
              !!item &&
              typeof item === 'object' &&
              typeof item.text === 'string' &&
              (item.id === undefined || typeof item.id === 'string'),
          )
        : [];
    } catch {
      return [];
    }
  });
  const [busy, setBusy] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editedText, setEditedText] = useState('');
  const [qualityCheck, setQualityCheck] = useState(false);
  const [error, setError] = useState('');
  const [image, setImage] = useState('');
  const [progress, setProgress] = useState('');
  const stop = useRef(false);
  const running = useRef(false);
  useEffect(
    () => () => {
      stop.current = true;
    },
    [],
  );
  function publish(items: Segment[]) {
    setEditingIndex(null);
    setSegments(items.map((s) => ({ ...s })));
    try {
      localStorage.setItem('narration-segments', JSON.stringify(items));
    } catch {
      setError('浏览器存储已满，当前结果仍可用，请导出记录；刷新可能丢失进度。');
    }
  }
  useEffect(() => {
    localStorage.setItem('narration-profile', profile);
  }, [profile]);
  const blockedReason = !script.trim()
    ? '请先填写最终讲解稿'
    : !profile
      ? '请选择讲解音色'
      : !confirmed
        ? '请勾选稿件核验确认；修改稿件或资料后需要重新确认'
        : '';
  useEffect(() => {
    apiClient
      .listProfiles()
      .then((items) => {
        const available = items.filter((p) => String(p.voice_type) !== 'import');
        setProfiles(available);
        setProfile(
          available.find((p) => p.id === localStorage.getItem('narration-profile'))?.id ||
            available.find((p) => p.preset_engine === 'kokoro')?.id ||
            available[0]?.id ||
            '',
        );
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    localStorage.setItem('narration-script', script);
  }, [script]);
  useEffect(() => {
    localStorage.setItem('narration-sources', sources);
  }, [sources]);
  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image);
    },
    [image],
  );

  async function generate(index?: number, resume = false) {
    if (running.current || blockedReason) return;
    running.current = true;
    stop.current = false;
    setBusy(true);
    setError('');
    setProgress('正在准备分句…');
    const items: Segment[] =
      index === undefined && !resume
        ? splitNarration(script).map((text) => ({ text }))
        : segments.map((item) => ({ ...item }));
    publish(items);
    try {
      for (let i = 0; i < items.length; i++) {
        if (stop.current) break;
        if (index !== undefined && i !== index) continue;
        const item = items[i];
        if (resume && item.completed && (!qualityCheck || item.transcript)) continue;
        item.error = undefined;
        if (!resume) {
          item.id = undefined;
          item.completed = false;
          item.transcript = undefined;
          item.generationMs = undefined;
          item.transcriptionMs = undefined;
        }
        const started = performance.now();
        try {
          setProgress(`第 ${i + 1}/${items.length} 句：提交配音任务…`);
          const result = item.id
            ? { id: item.id }
            : await apiClient.generateSpeech({
                profile_id: profile,
                engine: (profiles.find((p) => p.id === profile)?.preset_engine ||
                  profiles.find((p) => p.id === profile)?.default_engine ||
                  'qwen') as GenerationRequest['engine'],
                text: item.text,
                language: 'zh',
                personality: false,
                max_chunk_chars: 100,
                crossfade_ms: 0,
              });
          item.id = result.id;
          publish(items);
          const deadline = Date.now() + 15 * 60 * 1000;
          while (!item.completed) {
            if (stop.current) break;
            const state = await apiClient.getGeneration(result.id);
            setProgress(
              `第 ${i + 1}/${items.length} 句：${state.status === 'loading_model' ? '正在加载模型，首次运行可能较慢' : '正在生成音频'}…`,
            );
            if (state.status === 'failed') {
              item.id = undefined;
              throw new Error(state.error || '生成失败');
            }
            if (state.status === 'completed') {
              item.completed = true;
              item.generationMs = performance.now() - started;
              break;
            }
            if (Date.now() > deadline) throw new Error('等待超时，请在生成历史中检查任务');
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          publish(items);
          if (stop.current) break;
          if (!qualityCheck) continue;
          const transcriptionStarted = performance.now();
          const response = await fetch(apiClient.getAudioUrl(result.id));
          if (!response.ok) throw new Error('音频读取失败');
          const audio = await response.blob();
          setProgress(`第 ${i + 1}/${items.length} 句：音频已生成，正在转写质检…`);
          item.transcript = (
            await apiClient.transcribeAudio(
              new File([audio], 'narration.wav', { type: 'audio/wav' }),
              'zh',
              'base',
            )
          ).text;
          item.transcriptionMs = performance.now() - transcriptionStarted;
        } catch (e) {
          item.error = String(e);
        }
        publish(items);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      running.current = false;
      setProgress(
        stop.current
          ? '已停止等待，后台任务仍可能运行；点击继续可恢复。'
          : '本轮处理结束，请查看各句结果与错误提示。',
      );
      setBusy(false);
    }
  }

  function saveSentence(index: number) {
    const text = editedText.trim();
    if (!text || Array.from(text).length > 100) return;
    if (text !== segments[index].text) {
      const items = segments.map((s, i) => (i === index ? { text } : { ...s }));
      const updatedScript = items.map((s) => s.text).join('\n');
      setScript(updatedScript);
      localStorage.setItem('narration-script', updatedScript);
      publish(items);
      setConfirmed(false);
      setProgress('已修改此句，请核验并重新勾选确认，再点击该句的重新生成。其他句音频已保留。');
    }
    setEditingIndex(null);
  }

  async function exportAudio() {
    if (running.current || !segments.length || segments.some((s) => !s.completed || !s.id)) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const blob = await mergeNarrationAudio(
        segments.map((s) => apiClient.getAudioUrl(s.id!)),
        setProgress,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = '文博讲解完整音频.wav';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setProgress('完整 WAV 已导出，句间加入 200 毫秒静音；请试听确认。');
    } catch (e) {
      setError(String(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function exportReport() {
    const blob = new Blob([JSON.stringify({ script, sources, profile, segments }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '文博讲解质检.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="overflow-auto py-8 space-y-6">
      <h1 className="text-2xl font-semibold">文博讲解工作台</h1>
      <p className="text-muted-foreground">
        上传参考图，核验资料并确认讲解稿，再逐句配音与转写检查。图片目前用于人工参考。
      </p>
      <label className="block space-y-2">
        参考图片
        <input
          className="block"
          type="file"
          accept="image/*"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            setImage(file ? URL.createObjectURL(file) : '');
          }}
        />
      </label>
      {image && <img src={image} alt="讲解参考" className="max-h-64 rounded-lg object-contain" />}
      <label className="block">
        资料来源与核验记录
        <textarea
          className="block w-full border rounded p-3 bg-background mt-2"
          rows={3}
          value={sources}
          disabled={busy}
          onChange={(e) => {
            setSources(e.target.value);
            setConfirmed(false);
          }}
          placeholder="记录出处、可见事实、历史背景与待确认信息"
        />
      </label>
      <label className="block">
        最终讲解稿
        <textarea
          className="block w-full border rounded p-3 bg-background mt-2"
          rows={6}
          value={script}
          disabled={busy}
          onChange={(e) => {
            setScript(e.target.value);
            setConfirmed(false);
            publish([]);
          }}
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          disabled={busy || !profiles.some((p) => p.preset_engine === 'kokoro')}
          onClick={() => {
            const next = profiles.find((p) => p.preset_engine === 'kokoro')!.id;
            if (next !== profile) {
              setProfile(next);
              publish([]);
            }
            setQualityCheck(false);
          }}
        >
          快速试稿 · 晓晓
        </Button>
        <Button
          variant="outline"
          disabled={busy || !profiles.some((p) => p.preset_engine === 'qwen_custom_voice')}
          onClick={() => {
            const next = profiles.find((p) => p.preset_engine === 'qwen_custom_voice')!.id;
            if (next !== profile) {
              setProfile(next);
              publish([]);
            }
            setQualityCheck(true);
          }}
        >
          正式成品 · 文博音色 + 质检
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {profiles.find((p) => p.id === profile)?.preset_engine === 'kokoro'
          ? '快速试稿：本机同稿测试首次约 24 秒，加载后约 2 秒生成 6 秒音频。首次加载请耐心等待。'
          : profiles.find((p) => p.id === profile)?.preset_engine === 'qwen_custom_voice'
            ? '文博成品：本机 MLX 接口测试加载后约 9 秒生成 6 秒音频；首次加载需要更久。长稿可先用晓晓试稿。'
            : '首次使用音色可能需要加载模型，速度取决于所选引擎。'}
      </p>
      <label className="block">
        讲解音色
        <select
          className="block border rounded p-2 bg-background mt-2"
          value={profile}
          disabled={busy}
          onChange={(e) => {
            setProfile(e.target.value);
            publish([]);
          }}
        >
          <option value="">请选择音色</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        我已核验年代、人名和来源，确认此稿用于配音。
      </label>
      <p role="status" aria-live="polite" className="text-sm">
        {busy ? progress : blockedReason || progress || '已就绪，可以开始配音'}
      </p>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={qualityCheck}
          disabled={busy}
          onChange={(e) => setQualityCheck(e.target.checked)}
        />
        生成后进行 Whisper 转写质检（更慢；试稿可关闭）
      </label>
      <div className="flex gap-3 flex-wrap">
        <Button
          variant="outline"
          disabled={busy || editingIndex !== null || !confirmed || !profile || !segments.length}
          onClick={() => void generate(undefined, true)}
        >
          继续未完成句 / 重试失败句
        </Button>
        <Button
          variant="outline"
          disabled={!busy}
          onClick={() => {
            stop.current = true;
            setProgress('正在停止等待；已提交的后台配音任务会继续，之后可点击继续');
          }}
        >
          停止等待
        </Button>
        <Button
          disabled={busy || editingIndex !== null || !confirmed || !profile || !script.trim()}
          onClick={() => void generate()}
        >
          {busy ? '正在处理…' : qualityCheck ? '分句配音并质检' : '分句配音'}
        </Button>
        <Button
          variant="outline"
          disabled={
            busy ||
            editingIndex !== null ||
            !segments.length ||
            segments.some((s) => !s.completed || !s.id)
          }
          onClick={() => void exportAudio()}
        >
          导出完整 WAV
        </Button>
        <Button variant="outline" disabled={busy || !segments.length} onClick={exportReport}>
          导出稿件与质检记录
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        转写一致仅代表文字比对通过。专业词、尾音和实际听感仍需人工试听。音频可逐句下载。
      </p>
      {segments.length > 0 && (
        <p className="text-sm text-muted-foreground">
          共 {segments.length} 句 · 已配音 {segments.filter((s) => s.completed).length} 句 · 已转写{' '}
          {segments.filter((s) => s.transcript !== undefined).length} 句 · 异常{' '}
          {segments.filter((s) => s.error).length}{' '}
          句。已完成音频需要补质检时，勾选质检后点击“继续未完成句”。
        </p>
      )}
      {segments.map((s, i) => (
        <div key={`${i}-${s.text}`} className="border rounded-lg p-4 space-y-2">
          {editingIndex === i ? (
            <div className="space-y-2">
              <label className="block">
                第 {i + 1} 句
                <textarea
                  aria-label={`修改第 ${i + 1} 句`}
                  className="block w-full border rounded p-3 bg-background mt-2"
                  rows={3}
                  value={editedText}
                  onChange={(e) => setEditedText(e.target.value)}
                />
              </label>
              <p className="text-sm text-muted-foreground">
                {Array.from(editedText.trim()).length}/100
                字。保存后仅此句需要重新配音；其他句保留。
              </p>
              <div className="flex gap-2">
                <Button
                  disabled={!editedText.trim() || Array.from(editedText.trim()).length > 100}
                  onClick={() => saveSentence(i)}
                >
                  保存修改
                </Button>
                <Button variant="outline" onClick={() => setEditingIndex(null)}>
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-3">
              <p>
                {i + 1}. {s.text}
              </p>
              <Button
                variant="outline"
                disabled={busy || editingIndex !== null || (!!s.id && !s.completed && !s.error)}
                onClick={() => {
                  setEditingIndex(i);
                  setEditedText(s.text);
                }}
              >
                修改此句
              </Button>
            </div>
          )}
          {s.id && s.completed && (
            <>
              <audio controls preload="none" src={apiClient.getAudioUrl(s.id)} />
              <a
                className="underline text-sm"
                href={apiClient.getAudioUrl(s.id)}
                target="_blank"
                rel="noreferrer"
              >
                打开 / 下载此句音频
              </a>
            </>
          )}
          <p className="text-sm text-muted-foreground">
            {s.completed ? '配音完成' : s.id ? '已提交，可继续等待' : '待生成'}
            {s.generationMs !== undefined && ` · 配音等待 ${(s.generationMs / 1000).toFixed(1)} 秒`}
            {s.transcriptionMs !== undefined &&
              ` · 转写 ${(s.transcriptionMs / 1000).toFixed(1)} 秒`}
          </p>
          {s.transcript && (
            <p>
              转写：{s.transcript} ·{' '}
              {normalize(s.text) === normalize(s.transcript)
                ? '文字一致，待试听'
                : '存在差异，请复核'}
            </p>
          )}
          {s.error && (
            <p role="alert" className="text-destructive">
              {s.error}
            </p>
          )}
          <Button
            variant="outline"
            disabled={busy || editingIndex !== null || !confirmed || !profile}
            onClick={() => void generate(i)}
          >
            重新生成此句
          </Button>
        </div>
      ))}
    </div>
  );
}
