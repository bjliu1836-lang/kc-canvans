import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  createImageTo3dJob,
  createImageTo3dJobCredentials,
  getImageTo3dJob,
  imageTo3dAssetUrl,
  IMAGE_TO_3D_ACCESS_KEY_STORAGE,
  type ImageTo3dJobCredentials,
  type ImageTo3dJobStatus,
} from "../io/imageTo3dClient";
import type { ReferenceLayoutImage } from "../io/referenceLayoutClient";
import { readLocalModelFile } from "../loaders/localModelImport";
import type { LayoutDraft, LayoutDraftComponent } from "../schema/layoutDraft";
import { useDirectorStore } from "../store/directorStore";
import { useLayoutDraftPreviewStore } from "../store/layoutDraftPreviewStore";
import { GeneratedAssetPreview } from "./GeneratedAssetPreview";

const JOB_STORAGE_PREFIX = "KC_REFERENCE_LAYOUT_3D_JOB:";
const ACTIVE_STATES = new Set(["storing-input", "queued", "running", "submitting", "processing"]);
type Crop = [number, number, number, number];

interface StoredComponentJob {
  draftId: string;
  sourceId: string;
  sourceFingerprint: string;
  componentId: string;
  credentials: ImageTo3dJobCredentials;
  inputName: string;
}

export function getDraftComponentAssetEligibility(component: LayoutDraftComponent, components: readonly LayoutDraftComponent[], primarySourceId?: string) {
  if (["ground", "wall", "door", "window", "pillar"].includes(component.category)) {
    return "墙面与建筑结构继续使用空间几何，不生成单物体模型。";
  }
  if (component.partOfComponentId) return "这是父对象的子部件；请对可独立选择的主体对象操作。";
  if (component.sourceImageEvidence?.hasPartComponents) return "识别结果包含归属于该对象的子部件；本轮不自动替换复合对象，请选择一个独立物件。";
  if (primarySourceId && component.sourceImageEvidence?.sourceId && component.sourceImageEvidence.sourceId !== primarySourceId) {
    return "该对象的裁剪证据不属于当前主图；请重新识别或确认主图后再生成。";
  }
  if (components.some((candidate) => candidate.partOfComponentId === component.id)) {
    return "该对象仍包含单独显示的子部件，本轮暂不替换整组；请先选择一个独立物件。";
  }
  return null;
}

export function getReferenceImageFingerprint(url: string | null | undefined) {
  if (!url) return "missing";
  let hash = 2166136261;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return url.length.toString(36) + "-" + (hash >>> 0).toString(36);
}

function sessionKey(scopeId: string | null, draftId: string, sourceId: string, sourceFingerprint: string, componentId: string) {
  return JOB_STORAGE_PREFIX + (scopeId ?? "default") + ":" + draftId + ":" + sourceId + ":" + sourceFingerprint + ":" + componentId;
}

function readStoredJob(key: string): StoredComponentJob | null {
  try {
    const value = sessionStorage.getItem(key);
    if (!value) return null;
    const parsed = JSON.parse(value) as StoredComponentJob;
    if (!parsed.credentials?.id || !parsed.credentials.jobCapability || !parsed.credentials.assetCapability) return null;
    return parsed;
  } catch {
    return null;
  }
}

function cropToFile(source: string, crop: Crop, name: string) {
  return new Promise<File>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const [x, y, width, height] = crop;
      const left = Math.max(0, Math.floor(x * image.naturalWidth));
      const top = Math.max(0, Math.floor(y * image.naturalHeight));
      const right = Math.min(image.naturalWidth, Math.ceil((x + width) * image.naturalWidth));
      const bottom = Math.min(image.naturalHeight, Math.ceil((y + height) * image.naturalHeight));
      if (right - left < 32 || bottom - top < 32) {
        reject(new Error("裁剪范围太小，请扩大框选范围"));
        return;
      }
      try {
        const canvas = document.createElement("canvas");
        canvas.width = right - left;
        canvas.height = bottom - top;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法处理裁剪图片");
        context.drawImage(image, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("图片裁剪失败；请上传单物体参考图"));
            return;
          }
          resolve(new File([blob], name.replace(/\.[^.]+$/, "") + "-crop.png", { type: "image/png" }));
        }, "image/png");
      } catch {
        reject(new Error("参考图无法裁剪；请上传单物体参考图"));
      }
    };
    image.onerror = () => reject(new Error("参考图无法读取；请上传单物体参考图"));
    image.src = source;
  });
}

function defaultCrop(component: LayoutDraftComponent): Crop {
  const bbox = component.sourceImageEvidence?.bbox;
  if (!bbox) return [0.2, 0.2, 0.6, 0.6];
  const [left, top, right, bottom] = bbox;
  const padX = (right - left) * 0.08;
  const padY = (bottom - top) * 0.08;
  const x = Math.max(0, left - padX);
  const y = Math.max(0, top - padY);
  return [x, y, Math.min(1, right + padX) - x, Math.min(1, bottom + padY) - y];
}

function statusText(job: ImageTo3dJobStatus | null) {
  if (!job) return "";
  if (job.state === "completed") return "生成完成，请检查模型后采用";
  if (job.state === "failed") return "生成失败（" + job.phase + "）；简模仍可用";
  if (job.state === "unknown") return "提交状态待确认；请先检查任务状态";
  if (job.state === "cancelled") return "任务已取消；简模仍可用";
  return job.phase === "preprocessing" ? "正在准备单物体图片…" : "正在生成单物体模型…";
}

export function DraftComponentAssetGenerator({
  scopeId,
  draft,
  component,
  components,
  sourceImage,
  referenceImages,
  sourceFingerprint,
  isCurrentTarget,
  onModelUnavailable,
  onBindAsset,
  onStateChange,
}: {
  scopeId: string | null;
  draft: LayoutDraft;
  component: LayoutDraftComponent;
  components: readonly LayoutDraftComponent[];
  sourceImage: ReferenceLayoutImage | null;
  referenceImages: readonly ReferenceLayoutImage[];
  sourceFingerprint: string;
  isCurrentTarget: (draftId: string, sourceId: string, sourceFingerprint: string, componentId: string) => boolean;
  onModelUnavailable: (draftId: string, componentId: string, assetRefId: string) => void;
  onBindAsset: (draftId: string, sourceId: string, sourceFingerprint: string, componentId: string, assetRefId: string) => boolean;
  onStateChange: (draftId: string, sourceId: string, componentId: string, state: "generating" | "ready" | "failed" | undefined) => void;
}) {
  const addImportedAsset = useDirectorStore((state) => state.addImportedAsset);
  const evidenceSourceId = component.sourceImageEvidence?.sourceId ?? draft.sourceId;
  const assetSourceImage = referenceImages.find((image) => image.sourceId === evidenceSourceId)
    ?? (sourceImage?.sourceId === evidenceSourceId ? sourceImage : null);
  const assetSourceFingerprint = getReferenceImageFingerprint(assetSourceImage?.url);
  const key = useMemo(() => sessionKey(scopeId, draft.id, evidenceSourceId, assetSourceFingerprint, component.id), [scopeId, draft.id, evidenceSourceId, assetSourceFingerprint, component.id]);
  const [accessKey, setAccessKey] = useState(() => sessionStorage.getItem(IMAGE_TO_3D_ACCESS_KEY_STORAGE) || "");
  const [accessKeyDraft, setAccessKeyDraft] = useState(accessKey);
  const [session, setSession] = useState<StoredComponentJob | null>(() => readStoredJob(key));
  const [job, setJob] = useState<ImageTo3dJobStatus | null>(null);
  const [creatingJobId, setCreatingJobId] = useState<string | null>(null);
  const [customImage, setCustomImage] = useState<File | null>(null);
  const [cropConfirmed, setCropConfirmed] = useState(false);
  const [crop, setCrop] = useState<Crop>(() => defaultCrop(component));
  const [dragStart, setDragStart] = useState<[number, number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stateChangeRef = useRef(onStateChange);
  stateChangeRef.current = onStateChange;
  const eligibility = !assetSourceImage && !customImage && component.sourceImageEvidence
    ? "找不到该对象裁剪证据对应的参考视图；请重新选择图片或上传单物体图。"
    : getDraftComponentAssetEligibility(component, components, evidenceSourceId);
  const hasUsableGeneratedAsset = Boolean(component.generatedAssetRefId && !component.generatedAssetUnavailable);
  const previewUrl = session ? imageTo3dAssetUrl(session.credentials) : "";

  useEffect(() => {
    if (!session || creatingJobId === session.credentials.id) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let missingRetries = 0;
    const poll = async () => {
      try {
        const next = await getImageTo3dJob(session.credentials);
        if (!live) return;
        missingRetries = 0;
        setJob(next);
        if (next.state === "completed") stateChangeRef.current(draft.id, evidenceSourceId, component.id, "ready");
        else if (next.state === "failed" || next.state === "unknown" || next.state === "cancelled") stateChangeRef.current(draft.id, evidenceSourceId, component.id, "failed");
        if (ACTIVE_STATES.has(next.state)) timer = setTimeout(poll, 2500);
      } catch (reason) {
        if (!live) return;
        if (reason instanceof Error && reason.message === "JOB_NOT_FOUND" && missingRetries < 8) {
          missingRetries += 1;
          timer = setTimeout(poll, 500);
          return;
        }
        setError(reason instanceof Error ? reason.message : "无法读取生成状态");
      }
    };
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [session?.credentials.id, creatingJobId, draft.id, evidenceSourceId, component.id]);

  function saveAccessKey() {
    const value = accessKeyDraft.trim();
    if (value) sessionStorage.setItem(IMAGE_TO_3D_ACCESS_KEY_STORAGE, value);
    else sessionStorage.removeItem(IMAGE_TO_3D_ACCESS_KEY_STORAGE);
    setAccessKey(value);
  }

  function point(event: PointerEvent<HTMLDivElement>): [number, number] {
    const rect = event.currentTarget.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    ];
  }

  async function startGeneration() {
    if (!accessKey || busy || (job && ACTIVE_STATES.has(job.state))) return;
    if (session && (!job || job.state === "unknown" || ACTIVE_STATES.has(job.state))) {
      setError("已有任务仍待确认；系统不会自动重复提交。请等待状态更新后再操作。");
      return;
    }
    if (!customImage && (!assetSourceImage || !component.sourceImageEvidence || !cropConfirmed)) {
      setError("请先确认对象裁剪范围，或上传该物件的单独参考图");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const file = customImage ?? await cropToFile(assetSourceImage!.url, crop, assetSourceImage!.fileName);
      if (!/^image\/(?:png|jpeg|webp)$/.test(file.type)) throw new Error("仅支持PNG、JPG或WEBP图片");
      if (file.size > 10 * 1024 * 1024) throw new Error("图片超过10 MB，请缩小裁剪范围");
      const nextSession: StoredComponentJob = {
        draftId: draft.id, sourceId: evidenceSourceId, sourceFingerprint: assetSourceFingerprint, componentId: component.id,
        credentials: createImageTo3dJobCredentials(), inputName: file.name,
      };
      sessionStorage.setItem(key, JSON.stringify(nextSession));
      setSession(nextSession);
      setCreatingJobId(nextSession.credentials.id);
      setJob(null);
      onStateChange(draft.id, evidenceSourceId, component.id, "generating");
      const created = await createImageTo3dJob(file, accessKey, nextSession.credentials);
      setJob(created);
    } catch (reason) {
      onStateChange(draft.id, evidenceSourceId, component.id, "failed");
      setError(reason instanceof Error ? reason.message : "无法启动生成任务");
    } finally {
      setCreatingJobId(null);
      setBusy(false);
    }
  }

  async function adoptResult() {
    if (!session || job?.state !== "completed" || busy) return;
    if (session.sourceFingerprint !== assetSourceFingerprint) {
      setError("参考图已变化；旧生成结果没有绑定到当前物件。请重新生成。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(previewUrl);
      if (!response.ok) throw new Error("模型文件读取失败，请稍后重试");
      const file = new File([await response.blob()], component.name + "-generated.glb", { type: "model/gltf-binary" });
      const imported = await readLocalModelFile(file);
      const current = useLayoutDraftPreviewStore.getState().draft;
      if (!current || current.id !== draft.id || current.sourceGroupKey !== draft.sourceGroupKey || current.components.find((entry) => entry.id === component.id)?.sourceImageEvidence?.sourceId !== evidenceSourceId || !isCurrentTarget(draft.id, evidenceSourceId, assetSourceFingerprint, component.id)) {
        throw new Error("草稿已变化，模型没有绑定到其他物件；请重新选择对象");
      }
      const before = new Set(useDirectorStore.getState().project.assets.map((asset) => asset.id));
      addImportedAsset({ kind: "prop", ...imported, addToScene: false });
      const asset = useDirectorStore.getState().project.assets.find((item) => !before.has(item.id) && item.fileName === imported.fileName);
      if (!asset) throw new Error("模型已下载，但无法登记到模型库");
      if (!onBindAsset(draft.id, evidenceSourceId, assetSourceFingerprint, component.id, asset.id)) throw new Error("草稿或参考图已变化，模型没有绑定到其他物件");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模型导入失败");
    } finally {
      setBusy(false);
    }
  }

  if (eligibility) return <p className="reference-layout-anchor-hint">{eligibility}</p>;

  return (
    <section className="reference-layout-generated-asset" aria-label={"生成" + component.name + "的单物体模型"}>
      <strong>{hasUsableGeneratedAsset ? "已采用生成模型" : job?.state === "completed" ? "生成完成，尚未采用" : job && ACTIVE_STATES.has(job.state) ? "生成中" : component.generatedAssetState === "failed" ? "失败，保留简模" : "单物体生成模型"}</strong>
      {!hasUsableGeneratedAsset ? (
        <>
          <p className="reference-layout-anchor-hint">从识别框开始，可拖动调整；若物件被遮挡或裁剪不准，请上传该物件的单独图片。不会把整张房间图直接提交生成。</p>
          {assetSourceImage && component.sourceImageEvidence ? (
          <div
              className="reference-layout-object-crop"
              role="img"
              aria-label="拖动框选该物件的生成参考范围"
              onPointerDown={(event) => {
                const next = point(event);
                setCropConfirmed(false);
                setDragStart(next);
                setCrop([next[0], next[1], 0, 0]);
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!dragStart) return;
                const next = point(event);
                setCrop([Math.min(dragStart[0], next[0]), Math.min(dragStart[1], next[1]), Math.abs(next[0] - dragStart[0]), Math.abs(next[1] - dragStart[1])]);
              }}
              onPointerUp={() => setDragStart(null)}
              style={{ aspectRatio: String(assetSourceImage.aspectRatio ?? 1.5) }}
            >
              <img src={assetSourceImage.url} alt="参考图对象范围" draggable={false} />
              <span style={{ left: (crop[0] * 100) + "%", top: (crop[1] * 100) + "%", width: (crop[2] * 100) + "%", height: (crop[3] * 100) + "%" }} />
            </div>
          ) : <p className="reference-layout-diagnostic is-warning">原图没有可用对象框；请上传单物体图片。</p>}
          {assetSourceImage && component.sourceImageEvidence ? (
            <button type="button" onClick={() => { setCropConfirmed(true); setCustomImage(null); setError(""); }}>确认当前裁剪范围</button>
          ) : null}
          <label>改用单物体图片<input aria-label="改用单物体图片" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { setCustomImage(event.currentTarget.files?.[0] ?? null); setError(""); }} /></label>
          {customImage ? <small>已选择单物体图片：{customImage.name}</small> : null}
          {component.sourceImageEvidence?.visibility !== "visible" || (component.sourceImageEvidence?.confidence ?? 0) < 0.55 ? (
            <p className="reference-layout-diagnostic is-warning">该物件可见范围或置信度有限；建议使用单独、无遮挡的物件图片。</p>
          ) : null}
        </>
      ) : <p className="reference-layout-anchor-hint">已绑定到此物件；预览和应用共用该模型，保留物体当前的位置、朝向和尺寸。</p>}
      <label>服务访问码<input type="password" autoComplete="off" value={accessKeyDraft} onChange={(event) => setAccessKeyDraft(event.currentTarget.value)} aria-label="参考布景3D生成服务访问码" /></label>
      <div className="reference-layout-generated-actions">
        <button type="button" onClick={saveAccessKey}>保存访问码</button>
        {!hasUsableGeneratedAsset ? <button type="button" disabled={!accessKey || busy || (!customImage && !cropConfirmed) || Boolean(job && ACTIVE_STATES.has(job.state))} onClick={() => void startGeneration()}>{busy ? "处理中…" : session && (!job || job.state === "unknown") ? "等待现有任务状态" : job?.state === "completed" || job?.state === "failed" || job?.state === "cancelled" ? "重新生成此物件" : "确认输入并生成模型"}</button> : null}
      </div>
      {job ? <p role="status">{hasUsableGeneratedAsset ? "模型已采用，保留物体当前的位置、朝向和尺寸。" : statusText(job)}</p> : null}
      {component.generatedAssetUnavailable ? <p className="reference-layout-diagnostic is-warning">模型不可用，暂用简模；可重新生成并再次采用。</p> : null}
      {!hasUsableGeneratedAsset && job?.state === "completed" && previewUrl ? (
        <>
          <GeneratedAssetPreview url={previewUrl} />
          <button className="reference-layout-primary-button" type="button" disabled={busy} onClick={() => void adoptResult()}>{busy ? "正在登记模型…" : "采用到此物件"}</button>
        </>
      ) : null}
      {error ? <p className="reference-layout-diagnostic is-warning" role="alert">{error}</p> : null}
    </section>
  );
}
