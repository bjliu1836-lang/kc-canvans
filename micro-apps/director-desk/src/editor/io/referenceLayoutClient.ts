import {
  validateLayoutDraftCandidate,
  type LayoutDraft,
  type LayoutDraftSource,
} from "../schema/layoutDraft";

const AUTH_TOKEN_KEY = "KC_CANVAS_AUTH_TOKEN";
const INVALID_LAYOUT_MESSAGE = "图片模型未能返回可用的布景结构，请重试或更换参考图";

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
}

function readableLayoutError(status: number, data: Record<string, unknown>) {
  const code = typeof data.error === "string" ? data.error : "";
  if (status === 401) return "登录已失效，请返回画布重新登录";
  if (status === 402) return "图片理解模型额度不足，请补充额度后重试";
  if (code === "DIRECTOR_LAYOUT_MODEL_NOT_CONFIGURED") return "尚未配置图片理解模型，请联系管理员完成模型配置后重试";
  if (code === "DIRECTOR_LAYOUT_IMAGE_REQUIRED") return "参考图无效，请重新选择图片";
  if (code === "DIRECTOR_LAYOUT_INVALID_MODEL_JSON") {
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
  const response = await fetch("/api/director-layout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      image: {
        url: requestUrl,
        fileName: image.fileName,
        sourceId: image.sourceId,
      },
    }),
    signal,
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(readableLayoutError(response.status, data));
  return validateLayoutDraftCandidate(data.draft, image);
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
