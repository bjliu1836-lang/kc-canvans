
import { MODEL_REGISTRY, getModelConfig, saveModelConfig, registerCustomModel, deleteModel, isCustomModel, getVisibleModels } from "./mode/config";
import type { ModelConfig } from "./mode/config";
import type { InputMedia, MultiAngleOptions, MultiAngleResult, VideoGenerationMode } from "../types";
import { generateMockImage } from "./mockGeneration";
import { apiFetch } from "./authService";

// Re-export for UI
export { MODEL_REGISTRY, getModelConfig, saveModelConfig, registerCustomModel, deleteModel, isCustomModel, getVisibleModels };
export type { ModelConfig };

export interface GenerationResult {
  urls: string[];
  mock: boolean;
}

export interface VideoTaskStatusUpdate {
  taskId: string;
  status: string;
  progress?: number;
  providerStatus?: string;
  errorDetail?: string;
}

export interface VideoGenerationOptions {
  mode?: VideoGenerationMode;
  inputMedia?: InputMedia[];
  onTaskCreated?: (taskIds: string[], provider?: string) => void;
  onStatus?: (update: VideoTaskStatusUpdate) => void;
}

// --- Generators ---

export const generateCreativeDescription = async (input: string, mode: 'IMAGE' | 'VIDEO', modelName?: string): Promise<string> => {
  const prompt = input.trim();
  if (!prompt) throw new Error('请输入文本生成指令');
  try {
     const res = await apiFetch('/api/generate/text', {
       method: 'POST',
       body: JSON.stringify({ task: 'text', prompt, mode, modelName }),
     });
     if (res.mock) throw new Error('MIMO_API_KEY 未配置');
     if (!res.text) throw new Error('MIMO_TEXT_EMPTY_RESPONSE');
     return res.text;
  } catch (e) {
    console.error(`Error generating text with ${modelName || 'MiMo'}`, e);
    throw e;
  }
};

const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
});

const normalizeMediaForModel = async (media: InputMedia): Promise<InputMedia> => {
    if (!media.url.startsWith('blob:')) return media;
    const response = await fetch(media.url);
    const blob = await response.blob();
    return { ...media, url: await blobToDataUrl(blob) };
};

const toDataUrl = async (src: string): Promise<string> => {
    if (src.startsWith('data:image/')) return src;
    if (!src.startsWith('blob:')) return src;

    const response = await fetch(src);
    const blob = await response.blob();
    return await blobToDataUrl(blob);
};

const ensurePublicImageUrl = async (src: string): Promise<string> => {
    if (!src) return src;
    if (/^https?:\/\//i.test(src)) return src;

    const dataUrl = await toDataUrl(src);
    if (!dataUrl.startsWith('data:image/')) return src;

    const result = await apiFetch('/api/media/upload', {
        method: 'POST',
        body: JSON.stringify({ dataUrl }),
    });
    if (!result.url) throw new Error('MEDIA_UPLOAD_NO_URL');
    return result.url;
};

const prepareVideoInputImages = async (inputImages: string[]): Promise<string[]> => {
    return await Promise.all(inputImages.filter(Boolean).map(ensurePublicImageUrl));
};

export const analyzeConnectedMedia = async (
    prompt: string,
    inputMedia: InputMedia[],
    modelName?: string
): Promise<string> => {
    const normalizedMedia = await Promise.all(inputMedia.map(normalizeMediaForModel));
    const result = await apiFetch('/api/generate/text', {
        method: 'POST',
        body: JSON.stringify({
            task: 'media-analysis',
            prompt,
            inputMedia: normalizedMedia,
            modelName,
        }),
    });
    if (result.mock) throw new Error('MIMO_API_KEY 未配置');
    return result.text || '';
};

export const analyzeScriptAssets = async (script: string, modelName?: string): Promise<string> => {
    const result = await apiFetch('/api/generate/text', {
        method: 'POST',
        body: JSON.stringify({
            task: 'script-assets',
            prompt: script,
            modelName,
        }),
    });
    if (result.mock) throw new Error('MIMO_API_KEY 未配置');
    return result.text || '';
};

export const generateImageWithMetadata = async (
    prompt: string, 
    aspectRatio: string = "1:1", 
    modelName: string = "Seedream 5.0", 
    resolution: string = "1k", 
    count: number = 1,
    inputImages: string[] = [],
    promptOptimize: boolean = false
): Promise<GenerationResult> => {
  try {
      const result = await apiFetch('/api/generate/image', {
        method: 'POST',
        body: JSON.stringify({ prompt, aspectRatio, modelName, resolution, count, inputImages, promptOptimize }),
      });
      return { urls: result.urls || [], mock: Boolean(result.mock) };
  } catch (e) {
      if (modelName === 'Seedream 5.0') {
          const total = Math.max(1, Math.min(count, 4));
          await new Promise(resolve => setTimeout(resolve, 650));
          return {
            urls: Array.from({ length: total }, (_, index) =>
                generateMockImage(prompt, aspectRatio, resolution, index, inputImages.length)
            ),
            mock: true,
          };
      }
      console.error(`Error generating image with ${modelName}`, e);
      throw e;
  }
};

export const generateImage = async (
    prompt: string,
    aspectRatio: string = "1:1",
    modelName: string = "Seedream 5.0",
    resolution: string = "1k",
    count: number = 1,
    inputImages: string[] = [],
    promptOptimize: boolean = false
): Promise<string[]> => {
    const result = await generateImageWithMetadata(prompt, aspectRatio, modelName, resolution, count, inputImages, promptOptimize);
    return result.urls;
};

const VIDEO_POLL_INTERVAL_MS = 6000;
const VIDEO_POLL_TIMEOUT_MS = 30 * 60 * 1000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const getVideoStatus = (result: any): string => {
    return String(
        result?.status ||
        result?.data?.status ||
        result?.state ||
        result?.data?.state ||
        result?.task_status ||
        result?.data?.task_status ||
        result?.output?.task_status ||
        ''
    ).toLowerCase();
};

const getVideoUrl = (result: any): string => {
    return (
        // Volcengine Ark Seedance returns the URL under content.video_url
        result?.content?.video_url ||
        result?.data?.content?.video_url ||
        result?.video_url ||
        result?.videoUrl ||
        result?.remixed_from_video_id ||
        result?.url ||
        result?.data?.video_url ||
        result?.data?.videoUrl ||
        result?.data?.remixed_from_video_id ||
        result?.data?.url ||
        result?.output?.video_url ||
        result?.output?.videoUrl ||
        result?.output?.remixed_from_video_id ||
        result?.output?.url ||
        result?.result?.video_url ||
        result?.result?.remixed_from_video_id ||
        result?.result?.url ||
        result?.urls?.[0] ||
        result?.data?.urls?.[0] ||
        ''
    );
};

type VideoPollOptions = {
    initialPollDelayMs?: number;
    onStatus?: (update: VideoTaskStatusUpdate) => void;
};

const normalizeProgress = (value: unknown): number | undefined => {
    const progress = Number(value);
    return Number.isFinite(progress) ? progress : undefined;
};

export const pollVideoTask = async (taskId: string, options: VideoPollOptions = {}): Promise<string> => {
    const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
    let lastError: unknown = null;
    let lastStatus = '';
    let lastProgress: unknown = null;

    let firstPoll = true;
    while (Date.now() < deadline) {
        const delay = firstPoll ? (options.initialPollDelayMs ?? VIDEO_POLL_INTERVAL_MS) : VIDEO_POLL_INTERVAL_MS;
        firstPoll = false;
        if (delay > 0) await sleep(delay);

        try {
            const result = await apiFetch(`/api/generate/video/poll?taskId=${encodeURIComponent(taskId)}`);
            const status = getVideoStatus(result);
            lastStatus = status || lastStatus;
            lastProgress = result?.progress ?? result?.data?.progress ?? result?.output?.progress ?? lastProgress;
            options.onStatus?.({
                taskId,
                status: ['completed', 'succeeded', 'success', 'done'].includes(status)
                    ? 'succeeded'
                    : ['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)
                        ? 'failed'
                        : 'running',
                providerStatus: status || undefined,
                progress: normalizeProgress(lastProgress),
            });

            if (['completed', 'succeeded', 'success', 'done'].includes(status)) {
                const url = getVideoUrl(result);
                if (!url) {
                    options.onStatus?.({ taskId, status: 'failed', providerStatus: status, errorDetail: 'AGNES_VIDEO_NO_URL_RETURNED' });
                    throw new Error('AGNES_VIDEO_NO_URL_RETURNED');
                }
                return url;
            }

            if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)) {
                const message = result?.error?.message || result?.message || result?.error || 'Unknown error';
                options.onStatus?.({ taskId, status: 'failed', providerStatus: status, errorDetail: String(message) });
                throw new Error(`AGNES_VIDEO_TASK_FAILED: ${message}`);
            }
        } catch (error: any) {
            lastError = error;
            const message = String(error?.message || '');
            if (
                message.includes('AGNES_VIDEO_TASK_FAILED') ||
                message.includes('AGNES_VIDEO_NO_URL_RETURNED') ||
                message.includes('VIDEO_API_NOT_CONFIGURED') ||
                message.includes('TASK_ID_REQUIRED') ||
                /AGNES_VIDEO_4\d\d/.test(message)
            ) {
                throw error;
            }
        }
    }

    const suffix = lastError instanceof Error ? ` (最后一次轮询: ${lastError.message})` : '';
    const statusSuffix = lastStatus ? `，最后状态: ${lastStatus}${lastProgress !== null ? ` ${lastProgress}%` : ''}` : '';
    options.onStatus?.({
        taskId,
        status: 'timed_out',
        providerStatus: lastStatus || undefined,
        progress: normalizeProgress(lastProgress),
        errorDetail: `AGNES_VIDEO_TIMEOUT${statusSuffix}${suffix}`,
    });
    throw new Error(`AGNES_VIDEO_TIMEOUT${statusSuffix}${suffix}`);
};

export const resumeVideoTask = (taskId: string, onStatus?: (update: VideoTaskStatusUpdate) => void): Promise<string> => {
    return pollVideoTask(taskId, { initialPollDelayMs: 0, onStatus });
};

export const generateVideo = async (
    prompt: string, 
    inputImages: string[] = [], 
    aspectRatio: string = "16:9", 
    modelName: string = "Seedance 1.5 Pro", 
    resolution: string = "720p", 
    duration: string = "5s",
    count: number = 1,
    promptOptimize: boolean = false,
    options?: VideoGenerationOptions
): Promise<string[]> => {
    let realModelName = modelName;
    const isStartEndMode = options?.mode === 'start_end' || modelName.endsWith('_FL');
    if (isStartEndMode) realModelName = modelName.replace('_FL', '');
    
    try {
        const videoInputImages = await prepareVideoInputImages(inputImages);
        const normalizedInputMedia = await Promise.all((options?.inputMedia || []).map(async media => {
            if (media.type === 'image') {
                return { ...media, url: await ensurePublicImageUrl(media.url) };
            }
            return await normalizeMediaForModel(media);
        }));
        const result = await apiFetch('/api/generate/video', {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            inputImages: videoInputImages,
            inputMedia: normalizedInputMedia,
            videoMode: options?.mode || (isStartEndMode ? 'start_end' : videoInputImages.length ? 'image' : 'text'),
            aspectRatio,
            modelName: realModelName,
            resolution,
            duration,
            count,
            promptOptimize,
            isStartEndMode,
          }),
        });
        if (Array.isArray(result.urls) && result.urls.length > 0) return result.urls;
        if (Array.isArray(result.taskIds) && result.taskIds.length > 0) {
            const taskIds = result.taskIds.map((taskId: unknown) => String(taskId)).filter(Boolean);
            options?.onTaskCreated?.(taskIds, result.provider);
            return await Promise.all(taskIds.map((taskId: string) => pollVideoTask(taskId, { onStatus: options?.onStatus })));
        }
        return [];
    } catch (e) {
        console.error(`Error generating video with ${modelName}`, e);
        throw e;
    }
};

export const generateAudioWithMetadata = async (
    text: string,
    modelName: string = "Minimax-speech-2.8-hd",
    voiceId: string = "male-qn-qingse",
    speed: number = 1,
    pitch: number = 0,
    volume: number = 1
): Promise<GenerationResult> => {
    const result = await apiFetch('/api/generate/audio', {
        method: 'POST',
        body: JSON.stringify({
            text,
            modelName,
            voiceId,
            speed,
            pitch,
            volume,
        }),
    });
    return { urls: result.urls || [], mock: Boolean(result.mock) };
};

export const generateAudio = async (
    text: string,
    modelName: string = "Minimax-speech-2.8-hd",
    voiceId: string = "male-qn-qingse",
    speed: number = 1,
    pitch: number = 0,
    volume: number = 1
): Promise<string[]> => {
    const result = await generateAudioWithMetadata(text, modelName, voiceId, speed, pitch, volume);
    return result.urls;
};

export const generateMultiAngleImages = async (
    image: string,
    options: MultiAngleOptions
): Promise<MultiAngleResult[]> => {
    const result = await apiFetch('/api/generate/multi-angle', {
        method: 'POST',
        body: JSON.stringify({ image, ...options }),
    });
    return result.results || [];
};
