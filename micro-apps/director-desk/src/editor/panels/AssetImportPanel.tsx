import { useEffect, useState } from "react";
import {
  cancelImageTo3dJob,
  createImageTo3dJob,
  createImageTo3dJobCredentials,
  getImageTo3dJob,
  imageTo3dAssetUrl,
  IMAGE_TO_3D_ACCESS_KEY_STORAGE,
  type ImageTo3dJobCredentials,
  type ImageTo3dJobStatus,
} from "../io/imageTo3dClient";
import { readLocalModelFile } from "../loaders/localModelImport";
import { useDirectorStore } from "../store/directorStore";
import { GeneratedAssetPreview } from "./GeneratedAssetPreview";

const IMAGE_TO_3D_JOB_STORAGE = "KC_IMAGE_TO_3D_JOB";
const ACTIVE_JOB_STATES = new Set(["storing-input", "queued", "running", "submitting", "processing"]);

interface StoredImageTo3dSession {
  credentials: ImageTo3dJobCredentials;
  inputName: string;
  imported?: boolean;
}

function readStoredSession(): StoredImageTo3dSession | null {
  try {
    const value = sessionStorage.getItem(IMAGE_TO_3D_JOB_STORAGE);
    if (!value) return null;
    const parsed = JSON.parse(value) as StoredImageTo3dSession;
    if (!parsed.credentials?.id || !parsed.credentials.jobCapability || !parsed.credentials.assetCapability) return null;
    return parsed;
  } catch {
    return null;
  }
}

function jobMessage(job: ImageTo3dJobStatus | null) {
  if (!job) return "选择单个物体图片后开始生成";
  if (job.state === "completed") return `模型已生成（${Math.ceil((job.glbBytes ?? 0) / 1024)} KB），请预览后确认导入`;
  if (job.state === "unknown") return "提交状态不确定，系统不会自动重试；远端任务可能仍在运行，20分钟保护期后可再试";
  if (job.state === "cancelled") return "任务已取消（仅排队任务可取消）";
  if (job.state === "failed") {
    if (job.error === "DAILY_LIMIT_REACHED") return "过去24小时的生成次数已用完";
    if (job.error === "PROVIDER_CONNECT_FAILED") return "连接3D生成服务失败，请检查服务状态后重试";
    if (job.error === "PROVIDER_SESSION_FAILED") return "生成服务初始化会话失败，请稍后重试";
    if (job.error === "PROVIDER_PREPROCESS_FAILED") return "官方图片预处理失败，请更换图片后重试";
    if (job.error === "PROVIDER_SUBMISSION_FAILED") return "生成服务未能接受任务，请稍后重试";
    if (job.error === "PROVIDER_SUBMISSION_UNCONFIRMED") return "生成任务提交状态未确认，请查看任务状态后再操作";
    if (job.error === "PROVIDER_REQUEST_REJECTED") return "生成服务拒绝了请求，请检查图片格式与服务配置";
    if (job.error === "PROVIDER_QUOTA_EXHAUSTED") return "生成服务额度不足，请检查 Hugging Face 账户额度";
    if (job.error === "PROVIDER_CAPACITY_LIMIT") return "生成服务当前繁忙，请稍后再试";
    if (job.error === "PROVIDER_AUTH_FAILED") return "生成服务凭据失效，请联系管理员更新服务配置";
    if (job.error === "PROVIDER_AUTH_UPDATE_REQUIRED") return "生成服务授权已到期，请联系管理员刷新服务配置";
    if (job.error === "PREPROCESS_INTERRUPTED") return "图片预处理中断了，可重新发起任务";
    if (job.error === "PROVIDER_NOT_CONFIGURED") return "生成服务尚未配置，请联系管理员";
    const phaseLabels: Record<string, string> = {
      connecting: "连接服务",
      "starting-session": "初始化会话",
      preprocessing: "图片预处理",
      submitting: "提交任务",
      generating: "生成模型",
      "saving-result": "保存结果",
    };
    return `生成失败（${phaseLabels[job.phase] || "阶段未知"}），可检查图片后重试`;
  }
  if (job.state === "storing-input") return "正在安全保存输入图片…";
  if (job.state === "queued") return "任务已排队，正在启动";
  if (job.phase === "connecting") return "正在连接生成服务…";
  if (job.phase === "starting-session") return "正在初始化生成会话…";
  if (job.phase === "preprocessing") return "正在进行官方图片预处理…";
  if (job.phase === "submitting") return "正在提交3D生成任务…";
  if (job.phase === "waiting-in-queue") return "生成任务正在排队…";
  if (job.phase === "saving-result") return "正在保存生成结果…";
  if (job.phase === "generating") return "正在生成3D模型…";
  if (job.state === "processing") return "任务正在处理…";
  return "任务正在处理…";
}

export function AssetImportPanel() {
  const addImportedAsset = useDirectorStore((state) => state.addImportedAsset);
  const [accessKey, setAccessKey] = useState(() => sessionStorage.getItem(IMAGE_TO_3D_ACCESS_KEY_STORAGE) || "");
  const [accessKeyDraft, setAccessKeyDraft] = useState(accessKey);
  const [storedSession, setStoredSession] = useState<StoredImageTo3dSession | null>(() => readStoredSession());
  const [job, setJob] = useState<ImageTo3dJobStatus | null>(null);
  const [creatingJobId, setCreatingJobId] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!storedSession) return;
    if (creatingJobId === storedSession.credentials.id) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let notFoundRetries = 0;
    const poll = async () => {
      try {
        const next = await getImageTo3dJob(storedSession.credentials);
        if (!live) return;
        notFoundRetries = 0;
        setJobError(null);
        setJob(next);
        if (ACTIVE_JOB_STATES.has(next.state)) timer = setTimeout(poll, 2500);
      } catch (error) {
        if (live && error instanceof Error && error.message === "JOB_NOT_FOUND" && notFoundRetries < 8) {
          notFoundRetries += 1;
          timer = setTimeout(poll, 500);
          return;
        }
        if (live) setJobError(error instanceof Error ? error.message : "无法读取任务状态");
      }
    };
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [storedSession?.credentials.id, creatingJobId]);

  function saveAccessKey() {
    const value = accessKeyDraft.trim();
    if (value) sessionStorage.setItem(IMAGE_TO_3D_ACCESS_KEY_STORAGE, value);
    else sessionStorage.removeItem(IMAGE_TO_3D_ACCESS_KEY_STORAGE);
    setAccessKey(value);
  }

  async function startGeneration() {
    if (!imageFile || !accessKey || busy) return;
    setBusy(true);
    setJobError(null);
    const session = { credentials: createImageTo3dJobCredentials(), inputName: imageFile.name } satisfies StoredImageTo3dSession;
    // Persist capabilities before the request so a response lost after task creation can be polled without resubmitting.
    sessionStorage.setItem(IMAGE_TO_3D_JOB_STORAGE, JSON.stringify(session));
    setCreatingJobId(session.credentials.id);
    setStoredSession(session);
    try {
      const created = await createImageTo3dJob(imageFile, accessKey, session.credentials);
      setJob(created);
    } catch (error) {
      setJobError(error instanceof Error ? error.message : "图片转3D请求失败");
    } finally {
      setCreatingJobId(null);
      setBusy(false);
    }
  }

  async function importGeneratedModel() {
    if (!storedSession || job?.state !== "completed" || busy) return;
    setBusy(true);
    setJobError(null);
    try {
      const response = await fetch(imageTo3dAssetUrl(storedSession.credentials));
      if (!response.ok) throw new Error("生成模型暂时无法读取，请稍后再试");
      const blob = await response.blob();
      const generatedFile = new File([blob], `trellis-${storedSession.credentials.id}.glb`, { type: "model/gltf-binary" });
      const result = await readLocalModelFile(generatedFile);
      addImportedAsset({ kind: "prop", ...result });
      const nextSession = { ...storedSession, imported: true };
      sessionStorage.setItem(IMAGE_TO_3D_JOB_STORAGE, JSON.stringify(nextSession));
      setStoredSession(nextSession);
    } catch (error) {
      setJobError(error instanceof Error ? error.message : "模型导入失败");
    } finally {
      setBusy(false);
    }
  }

  async function cancelQueuedJob() {
    if (!storedSession || job?.state !== "queued") return;
    try {
      await cancelImageTo3dJob(storedSession.credentials);
      setJob((current) => current ? { ...current, state: "cancelled", phase: "cancelled" } : current);
    } catch (error) {
      setJobError(error instanceof Error ? error.message : "取消任务失败");
    }
  }

  const previewUrl = storedSession ? imageTo3dAssetUrl(storedSession.credentials) : "";

  return (
    <section className="image-to-3d-generation-panel">
      <div className="asset-import-item">
        <p className="asset-import-status">仅处理单张图片中的单个物体；优先使用干净背景或透明底图片。整房布景请使用参考图布景工具，模型需要预览确认。</p>
        <label>
          服务访问码
          <input
            aria-label="3D生成服务访问码"
            autoComplete="off"
            type="password"
            value={accessKeyDraft}
            onChange={(event) => setAccessKeyDraft(event.currentTarget.value)}
          />
        </label>
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <button type="button" onClick={saveAccessKey}>保存访问码</button>
        <button type="button" onClick={() => { setAccessKeyDraft(""); setAccessKey(""); sessionStorage.removeItem(IMAGE_TO_3D_ACCESS_KEY_STORAGE); }}>清除访问码</button>
        </div>
        <label style={{ display: "block", marginTop: 10 }}>
          单物体图片（PNG / JPG / WEBP，最大10 MB）
          <input
            aria-label="单物体图片"
            accept="image/png,image/jpeg,image/webp"
            type="file"
            onChange={(event) => setImageFile(event.currentTarget.files?.[0] ?? null)}
          />
        </label>
        <button type="button" disabled={!imageFile || !accessKey || busy || Boolean(job && ACTIVE_JOB_STATES.has(job.state))} onClick={() => void startGeneration()}>
          {busy ? "处理中…" : "生成单物体 3D 模型"}
        </button>
        {storedSession && job ? (
          <div style={{ marginTop: 10 }}>
            <p role="status">{jobMessage(job)}</p>
            {job.state === "queued" ? <button type="button" onClick={() => void cancelQueuedJob()}>取消排队任务</button> : null}
            {job.state === "completed" ? <>
              <GeneratedAssetPreview url={previewUrl} />
              <button type="button" disabled={busy || storedSession.imported} onClick={() => void importGeneratedModel()}>
                {storedSession.imported ? "模型已加入场景" : busy ? "正在导入…" : "确认导入导演台"}
              </button>
            </> : null}
          </div>
        ) : null}
        {jobError ? <p className="capture-status" role="alert">{jobError}</p> : null}
      </div>
    </section>
  );
}
