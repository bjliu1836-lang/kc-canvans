import {
  Box,
  Eye,
  EyeOff,
  ImagePlus,
  LoaderCircle,
  RefreshCw,
  Ruler,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DIRECTOR_DESK_REFERENCE_IMAGES_EVENT,
  DIRECTOR_DESK_SESSION_OPENED_EVENT,
  getHostReferenceImages,
  type HostReferenceImage,
} from "../io/hostBridge";
import {
  readReferenceImageFile,
  requestReferenceLayout,
  type ReferenceLayoutImage,
} from "../io/referenceLayoutClient";
import {
  calibrateLayoutDraft,
  LayoutDraftValidationError,
  type LayoutDraftComponent,
} from "../schema/layoutDraft";
import { useDirectorStore } from "../store/directorStore";
import { useLayoutDraftPreviewStore } from "../store/layoutDraftPreviewStore";
import { InspectorSection } from "./InspectorControls";

const CATEGORY_LABELS: Record<LayoutDraftComponent["category"], string> = {
  ground: "地面",
  wall: "墙体",
  door: "门",
  window: "窗",
  table: "桌子",
  chair: "椅子",
  sofa: "沙发",
  cabinet: "柜子",
};

let retainedLocalImage: ReferenceLayoutImage | null = null;
let retainedSelectedSourceId = "";
let retainedAppliedBatchId: string | null = null;

function connectedImageToReference(image: HostReferenceImage): ReferenceLayoutImage {
  return {
    sourceId: image.sourceNodeId,
    fileName: image.fileName,
    url: image.imageUrl,
    origin: "canvas",
  };
}

function finiteDraftNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function ReferenceLayoutPanel() {
  const applyLayoutDraft = useDirectorStore((state) => state.applyLayoutDraft);
  const layoutBatches = useDirectorStore((state) => state.project.layoutBatches ?? []);
  const draft = useLayoutDraftPreviewStore((state) => state.draft);
  const selectedComponentId = useLayoutDraftPreviewStore((state) => state.selectedComponentId);
  const setDraft = useLayoutDraftPreviewStore((state) => state.setDraft);
  const selectComponent = useLayoutDraftPreviewStore((state) => state.selectComponent);
  const [connectedImages, setConnectedImages] = useState(() => getHostReferenceImages().map(connectedImageToReference));
  const [localImage, setLocalImage] = useState<ReferenceLayoutImage | null>(retainedLocalImage);
  const [selectedSourceId, setSelectedSourceId] = useState<string>(retainedSelectedSourceId);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anchorWidth, setAnchorWidth] = useState("");
  const [appliedBatchId, setAppliedBatchId] = useState<string | null>(retainedAppliedBatchId);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  const images = useMemo(
    () => [localImage, ...connectedImages].filter((image): image is ReferenceLayoutImage => Boolean(image)),
    [connectedImages, localImage]
  );
  const selectedImage = images.find((image) => image.sourceId === selectedSourceId) ?? images[0] ?? null;
  const selectedComponent = draft?.components.find((component) => component.id === selectedComponentId) ?? null;
  const replaceBatchId = appliedBatchId && layoutBatches.some((batch) => batch.id === appliedBatchId)
    ? appliedBatchId
    : selectedImage
      ? [...layoutBatches].reverse().find((batch) => batch.sourceId === selectedImage.sourceId)?.id ?? null
      : null;

  useEffect(() => {
    const updateConnectedImages = (event: Event) => {
      const detail = (event as CustomEvent<{ images?: HostReferenceImage[] }>).detail;
      const next = Array.isArray(detail?.images) ? detail.images.map(connectedImageToReference) : [];
      setConnectedImages(next);
      setSelectedSourceId((current) => current || next[0]?.sourceId || "");
    };
    const resetForInstance = () => {
      abortRef.current?.abort();
      requestIdRef.current += 1;
      setGenerating(false);
      setError(null);
      setLocalImage(null);
      setConnectedImages([]);
      setSelectedSourceId("");
      setAppliedBatchId(null);
      retainedLocalImage = null;
      retainedSelectedSourceId = "";
      retainedAppliedBatchId = null;
      setDraft(null);
    };
    window.addEventListener(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, updateConnectedImages);
    window.addEventListener(DIRECTOR_DESK_SESSION_OPENED_EVENT, resetForInstance);
    return () => {
      window.removeEventListener(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, updateConnectedImages);
      window.removeEventListener(DIRECTOR_DESK_SESSION_OPENED_EVENT, resetForInstance);
      abortRef.current?.abort();
      setDraft(null);
    };
  }, [setDraft]);

  useEffect(() => {
    if (!selectedSourceId && images[0]) {
      retainedSelectedSourceId = images[0].sourceId;
      setSelectedSourceId(images[0].sourceId);
    }
  }, [images, selectedSourceId]);

  function chooseSource(sourceId: string) {
    abortRef.current?.abort();
    requestIdRef.current += 1;
    setGenerating(false);
    setSelectedSourceId(sourceId);
    retainedSelectedSourceId = sourceId;
    setDraft(null);
    setError(null);
    setAnchorWidth("");
    setAppliedBatchId(null);
    retainedAppliedBatchId = null;
  }

  async function generateLayout() {
    if (!selectedImage || generating) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const requestId = ++requestIdRef.current;
    setGenerating(true);
    setError(null);
    try {
      const nextDraft = await requestReferenceLayout(selectedImage, controller.signal);
      if (requestId !== requestIdRef.current || controller.signal.aborted) return;
      setDraft(nextDraft);
      setAnchorWidth("");
    } catch (reason) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      setError(reason instanceof Error ? reason.message : "粗布景生成失败，请重试");
    } finally {
      if (requestId === requestIdRef.current) setGenerating(false);
    }
  }

  function cancelGeneration() {
    abortRef.current?.abort();
    requestIdRef.current += 1;
    setGenerating(false);
    setError("已取消本次生成");
  }

  function updateComponent(id: string, updater: (component: LayoutDraftComponent) => LayoutDraftComponent) {
    if (!draft) return;
    setDraft({
      ...draft,
      components: draft.components.map((component) => component.id === id ? updater(component) : component),
    });
  }

  function updateTuple(
    component: LayoutDraftComponent,
    field: "position" | "size",
    axis: 0 | 1 | 2,
    value: string
  ) {
    const parsed = finiteDraftNumber(value);
    if (parsed === null || (field === "size" && parsed <= 0)) return component;
    const next = [...component[field]] as [number, number, number];
    next[axis] = parsed;
    return { ...component, [field]: next };
  }

  function applyScaleAnchor() {
    if (!draft || !selectedComponent) return;
    const parsed = finiteDraftNumber(anchorWidth);
    try {
      setDraft(calibrateLayoutDraft(draft, selectedComponent.id, parsed ?? Number.NaN));
      setError(null);
    } catch (reason) {
      setError(reason instanceof LayoutDraftValidationError ? reason.message : "尺寸校正失败");
    }
  }

  function applyDraft(mode: "append" | "replace-batch") {
    if (!draft) return;
    const result = applyLayoutDraft({
      draft,
      mode,
      replaceBatchId: mode === "replace-batch" ? replaceBatchId : null,
    });
    setAppliedBatchId(result.batchId);
    retainedAppliedBatchId = result.batchId;
    setDraft(null);
    setError(null);
  }

  return (
    <InspectorSection title="参考图粗布景">
      <div
        className="reference-layout-panel"
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <p className="reference-layout-help">从一张图片估算地面、墙门窗和基础家具，确认后再加入当前场景。</p>
        {selectedImage ? (
          <div className="reference-layout-source-preview">
            <img alt="当前粗布景参考图" src={selectedImage.url} />
            <div><strong>{selectedImage.fileName}</strong><span>{selectedImage.origin === "canvas" ? "来自画布连接" : "本地图片"}</span></div>
          </div>
        ) : null}
        <div className="reference-layout-source-row">
          {images.length ? (
            <select
              aria-label="选择粗布景参考图"
              value={selectedImage?.sourceId ?? ""}
              onChange={(event) => chooseSource(event.currentTarget.value)}
            >
              {images.map((image) => <option key={`${image.origin}:${image.sourceId}`} value={image.sourceId}>{image.fileName}</option>)}
            </select>
          ) : <span className="reference-layout-empty">尚无画布连接图片</span>}
          <button className="reference-layout-icon-button" type="button" title="选择本地图片" aria-label="选择本地参考图" onClick={() => inputRef.current?.click()}>
            <ImagePlus aria-hidden="true" size={15} />
          </button>
          <input
            ref={inputRef}
            className="visually-hidden"
            aria-label="上传粗布景参考图"
            accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
            type="file"
            onChange={(event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              if (file) void readReferenceImageFile(file).then((image) => {
                retainedLocalImage = image;
                setLocalImage(image);
                chooseSource(image.sourceId);
              }).catch((reason) => setError(reason instanceof Error ? reason.message : "参考图读取失败"));
              input.value = "";
            }}
          />
        </div>

        <div className="reference-layout-action-row">
          <button className="inspector-action-button" disabled={!selectedImage || generating} type="button" onClick={() => void generateLayout()}>
            {generating ? <LoaderCircle className="is-spinning" aria-hidden="true" size={15} /> : draft ? <RefreshCw aria-hidden="true" size={15} /> : <Sparkles aria-hidden="true" size={15} />}
            {generating ? "正在识别..." : draft ? "重新生成" : "生成粗布景"}
          </button>
          {generating ? (
            <button className="reference-layout-secondary-button" type="button" onClick={cancelGeneration}><X aria-hidden="true" size={14} />取消</button>
          ) : null}
        </div>
        {error ? <p className="reference-layout-error" role="alert">{error}</p> : null}

        {draft ? (
          <div className="reference-layout-draft" aria-label="粗布景暂存预览">
            <div className="reference-layout-draft-heading">
              <span><Box aria-hidden="true" size={14} />暂存预览 · {draft.components.length} 个组件</span>
              <em>{draft.scale.mode === "anchored" ? "已按已知尺寸校正" : "未锚定 · 尺度为估计"}</em>
            </div>
            <div className="reference-layout-component-list">
              {draft.components.map((component) => (
                <button
                  key={component.id}
                  className={`reference-layout-component-row${selectedComponentId === component.id ? " is-selected" : ""}`}
                  type="button"
                  onClick={() => selectComponent(component.id)}
                >
                  <span>{component.name}</span>
                  <small>{CATEGORY_LABELS[component.category]} · {Math.round(component.confidence * 100)}%</small>
                  {component.uncertain ? <i>待确认</i> : null}
                </button>
              ))}
            </div>
            {selectedComponent ? (
              <div className="reference-layout-editor" aria-label={`编辑${selectedComponent.name}`}>
                <div className="reference-layout-editor-title">
                  <input
                    aria-label="组件名称"
                    value={selectedComponent.name}
                    onChange={(event) => updateComponent(selectedComponent.id, (component) => ({ ...component, name: event.target.value.slice(0, 80) }))}
                  />
                  <button type="button" title={selectedComponent.visible ? "隐藏组件" : "显示组件"} aria-label={selectedComponent.visible ? "隐藏组件" : "显示组件"} onClick={() => updateComponent(selectedComponent.id, (component) => ({ ...component, visible: !component.visible }))}>
                    {selectedComponent.visible ? <Eye aria-hidden="true" size={14} /> : <EyeOff aria-hidden="true" size={14} />}
                  </button>
                  <button type="button" title="删除组件" aria-label="删除组件" onClick={() => setDraft({ ...draft, components: draft.components.filter((component) => component.id !== selectedComponent.id) })}>
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </div>
                <div className="reference-layout-field-grid">
                  {(["X", "Y", "Z"] as const).map((axisLabel, axis) => (
                    <label key={`position-${axisLabel}`}>位置 {axisLabel}<input aria-label={`位置 ${axisLabel}`} type="number" step="0.1" value={selectedComponent.position[axis]} onChange={(event) => updateComponent(selectedComponent.id, (component) => updateTuple(component, "position", axis as 0 | 1 | 2, event.target.value))} /></label>
                  ))}
                  {(["宽", "高", "深"] as const).map((axisLabel, axis) => (
                    <label key={`size-${axisLabel}`}>尺寸{axisLabel}<input aria-label={`尺寸${axisLabel}`} type="number" min="0.01" step="0.1" value={selectedComponent.size[axis]} onChange={(event) => updateComponent(selectedComponent.id, (component) => updateTuple(component, "size", axis as 0 | 1 | 2, event.target.value))} /></label>
                  ))}
                  <label className="reference-layout-rotation-field">Y 轴旋转<input aria-label="Y 轴旋转" type="number" step="1" value={selectedComponent.rotationYDegrees} onChange={(event) => {
                    const value = finiteDraftNumber(event.target.value);
                    if (value !== null) updateComponent(selectedComponent.id, (component) => ({ ...component, rotationYDegrees: value }));
                  }} /></label>
                </div>
                <div className="reference-layout-anchor-row">
                  <Ruler aria-hidden="true" size={14} />
                  <label>已知宽度（米）<input aria-label="已知宽度（米）" type="number" min="0.01" max="100" step="0.1" value={anchorWidth} onChange={(event) => setAnchorWidth(event.target.value)} /></label>
                  <button type="button" disabled={!anchorWidth} onClick={applyScaleAnchor}>校正</button>
                </div>
              </div>
            ) : null}
            <div className="reference-layout-commit-row">
              <button className="reference-layout-primary-button" disabled={!draft.components.length} type="button" onClick={() => applyDraft("append")}>添加到当前场景</button>
              <button className="reference-layout-secondary-button" disabled={!replaceBatchId || !draft.components.length} type="button" onClick={() => applyDraft("replace-batch")}>替换此生成批次</button>
            </div>
          </div>
        ) : null}
      </div>
    </InspectorSection>
  );
}
