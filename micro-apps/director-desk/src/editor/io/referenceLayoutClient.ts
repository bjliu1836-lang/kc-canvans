import {
  validateLayoutDraftCandidate,
  type LayoutDraft,
  type LayoutDraftSource,
} from "../schema/layoutDraft";

const AUTH_TOKEN_KEY = "KC_CANVAS_AUTH_TOKEN";

export interface ReferenceLayoutImage extends LayoutDraftSource {
  url: string;
  origin: "local" | "canvas";
}

function readableLayoutError(status: number, data: Record<string, unknown>) {
  const code = typeof data.error === "string" ? data.error : "";
  if (status === 401) return "登录已失效，请返回画布重新登录";
  if (status === 402) return "图片理解模型额度不足，请补充额度后重试";
  if (code === "DIRECTOR_LAYOUT_MODEL_NOT_CONFIGURED") return "尚未配置支持图片理解的模型，请先配置 MIMO_API_KEY 或 TEXT_API_KEY";
  if (code === "DIRECTOR_LAYOUT_IMAGE_REQUIRED") return "参考图无效，请重新选择图片";
  if (code === "DIRECTOR_LAYOUT_INVALID_MODEL_JSON") return "图片模型未能返回可用的布景结构，请重试或更换参考图";
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
