import { validateLayoutDraftCandidate, type LayoutDraft, type LayoutDraftSource } from "../schema/layoutDraft";
import { imageObservationToLayoutDraft, ImageObservationValidationError } from "../schema/imageObservationLayout";
import { createLayoutGenerationId, recordLayoutGenerationFailed, recordLayoutGenerationStarted, recordNormalizedLayoutDraft } from "./layoutDiagnostics";

const AUTH_TOKEN_KEY = "KC_CANVAS_AUTH_TOKEN";
const INVALID_LAYOUT_MESSAGE = "图片模型未能返回可用的布景结构，请重试或更换参考图";
const IMAGE_OBSERVATION_FORMAT = "image-observations-v1";

function readableLayoutIssue(data: Record<string, unknown>) {
  if (!Array.isArray(data.issues)) return "";
  const issue = data.issues.find((item): item is string => typeof item === "string")?.trim();
  if (!issue || issue.length > 180) return "";
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(issue)) return "";
  if (/(?:\b(?:api[-_ ]?key|token|secret|authorization|bearer)\b|https?:\/\/|data:image\/|[<>{}\[\]`"'\\])/i.test(issue)) return "";
  return issue.replace(/\s+/g, " ");
}

export interface ReferenceLayoutImage extends LayoutDraftSource {
  url: string;
  origin: "local" | "canvas";
  aspectRatio?: number;
}

function readableLayoutError(status: number, data: Record<string, unknown>) {
  const code = typeof data.error === "string" ? data.error : "";
  if (status === 401) return "登录已失效，请返回画布重新登录";
  if (status === 402) return "图片理解模型额度不足，请补充额度后重试";
  if (code === "DIRECTOR_LAYOUT_MODEL_NOT_CONFIGURED") return "尚未配置图片理解模型，请联系管理员完成模型配置后重试";
  if (code === "DIRECTOR_LAYOUT_IMAGE_REQUIRED") return "参考图无效，请重新选择图片";
  if (code === "DIRECTOR_LAYOUT_INVALID_MODEL_JSON" || code === "DIRECTOR_LAYOUT_MODEL_JSON_INVALID" || code === "DIRECTOR_LAYOUT_MODEL_SCHEMA_INVALID") {
    const issue = readableLayoutIssue(data);
    return issue ? `${INVALID_LAYOUT_MESSAGE}（${issue}）` : INVALID_LAYOUT_MESSAGE;
  }
  return typeof data.message === "string" && data.message.trim()
    ? data.message
    : `粗布景生成失败（${status}）`;
}

export async function requestReferenceLayout(
  image: ReferenceLayoutImage,
  signal?: AbortSignal
): Promise<LayoutDraft> {
  const generationId = createLayoutGenerationId();
  let requestUrl = image.url;
  if (requestUrl.startsWith("blob:")) {
    const blob = await fetch(requestUrl, { signal }).then((response) => {
      if (!response.ok) throw new Error("无法读取画布连接的参考图");
      return response.blob();
    });
    requestUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("无法读取画布连接的参考图"));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(blob);
    });
  }
  const token = window.localStorage.getItem(AUTH_TOKEN_KEY) || "";
  recordLayoutGenerationStarted(generationId);
  let response: Response;
  try {
    response = await fetch("/api/director-layout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        outputFormat: IMAGE_OBSERVATION_FORMAT,
        image: {
          url: requestUrl,
          fileName: image.fileName,
          sourceId: image.sourceId,
        },
      }),
      signal,
    });
  } catch (error) {
    recordLayoutGenerationFailed(generationId, signal?.aborted ? "cancelled" : "network-error");
    throw error;
  }
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = response.status === 401 ? "unauthorized"
      : response.status === 402 ? "quota"
      : data.error === "DIRECTOR_LAYOUT_UPSTREAM_HTTP" ? "upstream-http"
      : data.error === "DIRECTOR_LAYOUT_UPSTREAM_RESPONSE_INVALID" ? "upstream-response"
      : data.error === "DIRECTOR_LAYOUT_MODEL_JSON_INVALID" ? "model-json"
      : data.error === "DIRECTOR_LAYOUT_INVALID_MODEL_JSON" ? "model-schema"
      : data.error === "DIRECTOR_LAYOUT_MODEL_SCHEMA_INVALID" ? "model-schema"
      : response.status >= 500 ? "server-error" : "request-rejected";
    const safeErrors = ["DIRECTOR_LAYOUT_UPSTREAM_HTTP", "DIRECTOR_LAYOUT_UPSTREAM_FAILURE", "DIRECTOR_LAYOUT_UPSTREAM_RESPONSE_INVALID", "DIRECTOR_LAYOUT_INVALID_MODEL_JSON", "DIRECTOR_LAYOUT_MODEL_JSON_INVALID", "DIRECTOR_LAYOUT_MODEL_SCHEMA_INVALID"];
    recordLayoutGenerationFailed(generationId, code, {
      error: typeof data.error === "string" && safeErrors.includes(data.error) ? data.error : undefined,
      issues: Array.isArray(data.issues) ? data.issues : undefined,
      issuePaths: Array.isArray(data.issuePaths) ? data.issuePaths : undefined,
      outputShape: data.outputShape,
      providerEnvelope: data.providerEnvelope,
    });
    throw new Error(readableLayoutError(response.status, data));
  }
  try {
    const legacyResponse = data.observationFormat === undefined && data.draft !== undefined;
    if (data.observationFormat !== undefined && data.observationFormat !== IMAGE_OBSERVATION_FORMAT) {
      throw new Error("图片模型返回了不支持的图像观察格式");
    }
    if (!legacyResponse && data.observationFormat !== IMAGE_OBSERVATION_FORMAT) {
      throw new Error("图片模型未返回可用的图像观察结构");
    }
    const draft = {
      ...(legacyResponse
        ? validateLayoutDraftCandidate(data.draft, image, { imageAspectRatio: image.aspectRatio })
        : imageObservationToLayoutDraft(data.visualObservations, image, { imageAspectRatio: image.aspectRatio })),
      diagnosticGenerationId: generationId,
    };
    recordNormalizedLayoutDraft(draft, generationId, legacyResponse ? data.draft : {
      observationFormat: data.observationFormat,
      visualObservations: data.visualObservations,
    });
    return draft;
  } catch (error) {
    recordLayoutGenerationFailed(generationId, error instanceof ImageObservationValidationError ? `${error.kind}-error` : "invalid-structure");
    throw error;
  }
}

export function readReferenceImageFile(file: File): Promise<ReferenceLayoutImage> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(?:png|jpeg|webp)$/.test(file.type)) {
      reject(new Error("仅支持 PNG、JPG 或 WebP 图片"));
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      reject(new Error("参考图不能超过 12 MB"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("参考图读取失败，请重新选择"));
    reader.onload = () => resolve({
      sourceId: `local_${Date.now().toString(36)}`,
      fileName: file.name,
      url: String(reader.result || ""),
      origin: "local",
    });
    reader.readAsDataURL(file);
  });
}
