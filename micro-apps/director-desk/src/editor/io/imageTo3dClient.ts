const AUTH_TOKEN_KEY = "KC_CANVAS_AUTH_TOKEN";

export interface ImageTo3dJobCredentials {
  id: string;
  jobCapability: string;
  assetCapability: string;
}

export interface ImageTo3dJobStatus {
  id: string;
  state: "queued" | "running" | "submitting" | "processing" | "storing-input" | "completed" | "failed" | "unknown" | "cancelled";
  phase: string;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
  inputName: string;
  glbBytes?: number;
  error?: string;
  retryAt?: number;
  assetUrl?: string;
}

export function createImageTo3dJobCredentials(): ImageTo3dJobCredentials {
  const secret = (length: number) => {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("") )
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  };
  return { id: crypto.randomUUID(), jobCapability: secret(32), assetCapability: secret(32) };
}

export function imageTo3dAssetUrl(credentials: ImageTo3dJobCredentials) {
  return `/api/image-to-3d/jobs/${credentials.id}/asset?cap=${encodeURIComponent(credentials.assetCapability)}`;
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof data.error === "string" ? data.error : "REQUEST_FAILED";
    if (response.status === 401) throw new Error("登录状态已失效，请重新登录");
    if (response.status === 404 && code === "JOB_NOT_FOUND") throw new Error("JOB_NOT_FOUND");
    if (code === "IMAGE_TO_3D_ACCESS_DENIED") throw new Error("服务访问码不正确");
    if (code === "IMAGE_TO_3D_ACCESS_NOT_CONFIGURED" || code === "IMAGE_TO_3D_NOT_CONFIGURED") throw new Error("3D生成服务尚未配置完成");
    if (code === "DAILY_LIMIT_REACHED") throw new Error("过去24小时的生成次数已用完");
    if (code === "JOB_ALREADY_ACTIVE") throw new Error("已有生成任务正在处理，或上一任务状态待确认");
    if (code === "IMAGE_TOO_LARGE") throw new Error("图片大小超过10 MB限制");
    if (code === "INVALID_IMAGE" || code === "IMAGE_REQUIRED") throw new Error("请选择有效的 PNG、JPG 或 WEBP 图片");
    throw new Error("图片转3D请求失败，请检查服务状态后重试");
  }
  return data as T;
}

function authHeaders(): Record<string, string> {
  const token = window.localStorage.getItem(AUTH_TOKEN_KEY) || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function createImageTo3dJob(file: File, accessKey: string, credentials: ImageTo3dJobCredentials) {
  const form = new FormData();
  form.append("image", file, file.name);
  const response = await fetch("/api/image-to-3d/jobs", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "X-Image-To-3D-Access-Key": accessKey,
      "X-Image-To-3D-Job-Id": credentials.id,
      "X-Image-To-3D-Job-Capability": credentials.jobCapability,
      "X-Image-To-3D-Asset-Capability": credentials.assetCapability,
    },
    body: form,
  });
  return await readJson<ImageTo3dJobStatus>(response);
}

export async function getImageTo3dJob(credentials: ImageTo3dJobCredentials) {
  const query = new URLSearchParams({ cap: credentials.jobCapability });
  const response = await fetch(`/api/image-to-3d/jobs/${credentials.id}?${query}`, { headers: authHeaders() });
  return await readJson<ImageTo3dJobStatus>(response);
}

export async function cancelImageTo3dJob(credentials: ImageTo3dJobCredentials) {
  const query = new URLSearchParams({ cap: credentials.jobCapability });
  const response = await fetch(`/api/image-to-3d/jobs/${credentials.id}/cancel?${query}`, {
    method: "POST",
    headers: authHeaders(),
  });
  return await readJson(response);
}
