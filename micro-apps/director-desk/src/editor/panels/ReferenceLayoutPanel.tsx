import {
  ArrowDownToLine,
  Box,
  CheckCheck,
  Eye,
  EyeOff,
  ImagePlus,
  LoaderCircle,
  Move,
  RefreshCw,
  Ruler,
  Scaling,
  Sparkles,
  Trash2,
  Users,
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
  LAYOUT_ANCHOR_PRESETS,
  LAYOUT_CATEGORY_COLORS,
  LAYOUT_CHARACTER_COLOR,
  LAYOUT_CHARACTER_MAX_HEIGHT,
  LAYOUT_CHARACTER_MIN_HEIGHT,
  LAYOUT_CHARACTER_POSTURES,
  LayoutDraftValidationError,
  type LayoutAnchorDimension,
  type LayoutCharacterPosture,
  type LayoutDraftCharacter,
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

const POSTURE_LABELS: Record<LayoutCharacterPosture, string> = {
  stand: "站立",
  sit: "坐姿",
  crouch: "蹲下",
  kneel: "跪姿",
  lie: "卧姿",
  unknown: "姿态未知",
};

const DIMENSION_LABELS: Record<LayoutAnchorDimension, string> = {
  width: "宽度",
  height: "高度",
};

type GenerationStage = "preparing" | "generating" | "validating";

const STAGE_LABELS: Record<GenerationStage, string> = {
  preparing: "正在准备参考图…",
  generating: "模型识别中",
  validating: "校验布局数据…",
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

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function ReferenceLayoutPanel() {
  const applyLayoutDraft = useDirectorStore((state) => state.applyLayoutDraft);
  const transformLayoutBatch = useDirectorStore((state) => state.transformLayoutBatch);
  const selectObject = useDirectorStore((state) => state.selectObject);
  const toggleObjectSelection = useDirectorStore((state) => state.toggleObjectSelection);
  const requestViewportFocus = useDirectorStore((state) => state.requestViewportFocus);
  const groundHeight = useDirectorStore((state) => state.project.scene.groundHeight);
  const sceneObjects = useDirectorStore((state) => state.project.objects);
  const layoutBatches = useDirectorStore((state) => state.project.layoutBatches ?? []);
  const draft = useLayoutDraftPreviewStore((state) => state.draft);
  const selectedComponentId = useLayoutDraftPreviewStore((state) => state.selectedComponentId);
  const setDraft = useLayoutDraftPreviewStore((state) => state.setDraft);
  const selectComponent = useLayoutDraftPreviewStore((state) => state.selectComponent);
  const hoverComponent = useLayoutDraftPreviewStore((state) => state.hoverComponent);
  const selectedCharacterId = useLayoutDraftPreviewStore((state) => state.selectedCharacterId);
  const selectCharacter = useLayoutDraftPreviewStore((state) => state.selectCharacter);
  const hoverCharacter = useLayoutDraftPreviewStore((state) => state.hoverCharacter);
  const [connectedImages, setConnectedImages] = useState(() => getHostReferenceImages().map(connectedImageToReference));
  const [localImage, setLocalImage] = useState<ReferenceLayoutImage | null>(retainedLocalImage);
  const [selectedSourceId, setSelectedSourceId] = useState<string>(retainedSelectedSourceId);
  const [generating, setGenerating] = useState(false);
  const [stage, setStage] = useState<GenerationStage | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [anchorWidth, setAnchorWidth] = useState("");
  const [anchorDimension, setAnchorDimension] = useState<LayoutAnchorDimension>("width");
  const [appliedBatchId, setAppliedBatchId] = useState<string | null>(retainedAppliedBatchId);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [batchScale, setBatchScale] = useState("1.2");
  const [batchOffsetX, setBatchOffsetX] = useState("");
  const [batchOffsetZ, setBatchOffsetZ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const editedRef = useRef(false);

  const images = useMemo(
    () => [localImage, ...connectedImages].filter((image): image is ReferenceLayoutImage => Boolean(image)),
    [connectedImages, localImage]
  );
  const selectedImage = images.find((image) => image.sourceId === selectedSourceId) ?? images[0] ?? null;
  const selectedComponent = draft?.components.find((component) => component.id === selectedComponentId) ?? null;
  const selectedCharacter = draft?.characters.find((character) => character.id === selectedCharacterId) ?? null;
  const anchorPreset = selectedComponent ? LAYOUT_ANCHOR_PRESETS[selectedComponent.category] : null;
  const uncertainCount = draft?.components.filter((component) => component.uncertain).length ?? 0;
  const uncertainCharacterCount = draft?.characters.filter((character) => character.uncertain).length ?? 0;
  const characterCount = draft?.characters.length ?? 0;
  const replaceBatchId = appliedBatchId && layoutBatches.some((batch) => batch.id === appliedBatchId)
    ? appliedBatchId
    : selectedImage
      ? [...layoutBatches].reverse().find((batch) => batch.sourceId === selectedImage.sourceId)?.id ?? null
      : null;
  const activeBatch = replaceBatchId ? layoutBatches.find((batch) => batch.id === replaceBatchId) ?? null : null;

  // 选中组件变化时，按类别预填推荐真实尺寸，用户可直接确认也可修改
  useEffect(() => {
    if (!anchorPreset) return;
    setAnchorDimension(anchorPreset.dimension);
    setAnchorWidth(String(anchorPreset.meters));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedComponentId]);

  // 生成中的耗时显示
  useEffect(() => {
    if (!generating) return undefined;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  // Ctrl+V 粘贴截图作为参考图（不劫持输入框内粘贴）
  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      if (isEditableTarget(event.target)) return;
      const file = Array.from(event.clipboardData?.files ?? []).find((item) => item.type.startsWith("image/"));
      if (!file) return;
      event.preventDefault();
      void readReferenceImageFile(file).then((image) => {
        retainedLocalImage = image;
        setLocalImage(image);
        chooseSource(image.sourceId);
      }).catch((reason) => setError(reason instanceof Error ? reason.message : "参考图读取失败"));
    }
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setStage(null);
      setError(null);
      setLocalImage(null);
      setConnectedImages([]);
      setSelectedSourceId("");
      setAppliedBatchId(null);
      setConfirmRegenerate(false);
      editedRef.current = false;
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
    setStage(null);
    setSelectedSourceId(sourceId);
    retainedSelectedSourceId = sourceId;
    setDraft(null);
    setError(null);
    setAnchorWidth("");
    setAppliedBatchId(null);
    retainedAppliedBatchId = null;
    setConfirmRegenerate(false);
    editedRef.current = false;
  }

  async function generateLayout() {
    if (!selectedImage || generating) return;
    if (draft && editedRef.current) {
      setConfirmRegenerate(true);
      return;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const requestId = ++requestIdRef.current;
    setGenerating(true);
    setStage("preparing");
    setElapsedSeconds(0);
    setError(null);
    setConfirmRegenerate(false);
    try {
      setStage("generating");
      const nextDraft = await requestReferenceLayout(selectedImage, controller.signal);
      if (requestId !== requestIdRef.current || controller.signal.aborted) return;
      setStage("validating");
      setDraft(nextDraft);
      editedRef.current = false;
      setAnchorWidth("");
    } catch (reason) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      setError(reason instanceof Error ? reason.message : "粗布景生成失败，请重试");
    } finally {
      if (requestId === requestIdRef.current) {
        setGenerating(false);
        setStage(null);
      }
    }
  }

  function cancelGeneration() {
    abortRef.current?.abort();
    requestIdRef.current += 1;
    setGenerating(false);
    setStage(null);
    setError("已取消本次生成");
  }

  function updateComponent(id: string, updater: (component: LayoutDraftComponent) => LayoutDraftComponent) {
    if (!draft) return;
    editedRef.current = true;
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
      setDraft(calibrateLayoutDraft(draft, selectedComponent.id, parsed ?? Number.NaN, anchorDimension));
      editedRef.current = true;
      setError(null);
    } catch (reason) {
      setError(reason instanceof LayoutDraftValidationError ? reason.message : "尺寸校正失败");
    }
  }

  function keepAllUncertain() {
    if (!draft) return;
    editedRef.current = true;
    setDraft({
      ...draft,
      components: draft.components.map((component) => component.uncertain ? { ...component, uncertain: false } : component),
    });
  }

  function dropAllUncertain() {
    if (!draft) return;
    editedRef.current = true;
    setDraft({
      ...draft,
      components: draft.components.filter((component) => !component.uncertain),
    });
  }

  function snapSelectedToGround() {
    if (!draft || !selectedComponent || selectedComponent.category === "ground") return;
    updateComponent(selectedComponent.id, (component) => ({
      ...component,
      position: [component.position[0], groundHeight, component.position[2]] as [number, number, number],
    }));
  }

  function updateCharacter(id: string, updater: (character: LayoutDraftCharacter) => LayoutDraftCharacter) {
    if (!draft) return;
    editedRef.current = true;
    setDraft({
      ...draft,
      characters: draft.characters.map((character) => character.id === id ? updater(character) : character),
    });
  }

  function updateCharacterTuple(
    character: LayoutDraftCharacter,
    field: "position",
    axis: 0 | 1 | 2,
    value: string
  ) {
    const parsed = finiteDraftNumber(value);
    if (parsed === null) return character;
    const next = [...character[field]] as [number, number, number];
    next[axis] = parsed;
    return { ...character, [field]: next };
  }

  function snapSelectedCharacterToGround() {
    if (!selectedCharacter || selectedCharacter.posture === "sit") return;
    updateCharacter(selectedCharacter.id, (character) => ({
      ...character,
      position: [character.position[0], groundHeight, character.position[2]] as [number, number, number],
    }));
  }

  function keepAllUncertainCharacters() {
    if (!draft) return;
    editedRef.current = true;
    setDraft({
      ...draft,
      characters: draft.characters.map((character) => character.uncertain ? { ...character, uncertain: false } : character),
    });
  }

  function dropAllUncertainCharacters() {
    if (!draft) return;
    editedRef.current = true;
    setDraft({
      ...draft,
      characters: draft.characters.filter((character) => !character.uncertain),
    });
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
    editedRef.current = false;
    setError(null);
  }

  function selectWholeBatch() {
    if (!activeBatch) return;
    const [firstId, ...restIds] = activeBatch.objectIds;
    selectObject(firstId ?? null);
    restIds.forEach((id) => toggleObjectSelection(id));
    focusBatchCenter();
  }

  function focusBatchCenter() {
    if (!activeBatch) return;
    const batchObjects = sceneObjects.filter((object) => object.layoutSource?.batchId === activeBatch.id);
    if (!batchObjects.length) return;
    const bounds = batchObjects.reduce(
      (acc, object) => {
        const [x, y, z] = object.transform.position;
        const [sx, sy, sz] = object.transform.scale;
        return {
          minX: Math.min(acc.minX, x - sx / 2), maxX: Math.max(acc.maxX, x + sx / 2),
          minY: Math.min(acc.minY, y), maxY: Math.max(acc.maxY, y + sy),
          minZ: Math.min(acc.minZ, z - sz / 2), maxZ: Math.max(acc.maxZ, z + sz / 2),
        };
      },
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }
    );
    requestViewportFocus([
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      (bounds.minZ + bounds.maxZ) / 2,
    ]);
  }

  function snapBatchToGround() {
    if (!activeBatch) return;
    const count = transformLayoutBatch(activeBatch.id, { snapToGround: true });
    if (count) setError(null);
  }

  function applyBatchScale() {
    if (!activeBatch) return;
    const factor = finiteDraftNumber(batchScale);
    if (factor === null || factor <= 0) {
      setError("缩放倍数必须是大于 0 的数字");
      return;
    }
    const count = transformLayoutBatch(activeBatch.id, { scaleFactor: factor });
    setError(count ? null : "该布景已不在场景中");
  }

  function applyBatchOffset() {
    if (!activeBatch) return;
    const offsetX = finiteDraftNumber(batchOffsetX) ?? 0;
    const offsetZ = finiteDraftNumber(batchOffsetZ) ?? 0;
    if (offsetX === 0 && offsetZ === 0) return;
    const count = transformLayoutBatch(activeBatch.id, { offsetX, offsetZ });
    if (count) {
      setBatchOffsetX("");
      setBatchOffsetZ("");
      setError(null);
    }
  }

  function handleImageFile(file: File) {
    void readReferenceImageFile(file).then((image) => {
      retainedLocalImage = image;
      setLocalImage(image);
      chooseSource(image.sourceId);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "参考图读取失败"));
  }

  return (
    <InspectorSection title="参考图粗布景">
      <div
        className={`reference-layout-panel${dragOver ? " is-dragover" : ""}`}
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          const file = event.dataTransfer?.files?.[0];
          if (file) handleImageFile(file);
        }}
      >
        <p className="reference-layout-help">从一张图片估算地面、墙门窗和基础家具，确认后再加入当前场景。支持拖入图片或 Ctrl+V 粘贴截图。</p>
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
              if (file) handleImageFile(file);
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
        {generating && stage ? (
          <p className="reference-layout-progress" role="status">
            {STAGE_LABELS[stage]}{stage === "generating" ? `（已用 ${elapsedSeconds} 秒，通常需要 20-60 秒）` : ""}
          </p>
        ) : null}
        {confirmRegenerate ? (
          <div className="reference-layout-confirm-row" role="alert">
            <span>已手动修改过当前预览，重新生成将丢弃这些修改。</span>
            <button type="button" onClick={() => { editedRef.current = false; setConfirmRegenerate(false); void generateLayout(); }}>仍要重新生成</button>
            <button type="button" onClick={() => setConfirmRegenerate(false)}>保留修改</button>
          </div>
        ) : null}
        {error ? <p className="reference-layout-error" role="alert">{error}</p> : null}

        {draft ? (
          <div className="reference-layout-draft" aria-label="粗布景暂存预览">
            <div className="reference-layout-draft-heading">
              <span><Box aria-hidden="true" size={14} />暂存预览 · {draft.components.length} 个组件</span>
              <em>{draft.scale.mode === "anchored" ? "已按已知尺寸校正" : "未锚定 · 尺度为估计"}</em>
            </div>
            {uncertainCount > 0 ? (
              <div className="reference-layout-batch-actions">
                <span>{uncertainCount} 个待确认</span>
                <button type="button" onClick={keepAllUncertain}><CheckCheck aria-hidden="true" size={14} />全部保留</button>
                <button type="button" onClick={dropAllUncertain}><Trash2 aria-hidden="true" size={14} />删除待确认</button>
              </div>
            ) : null}
            <div className="reference-layout-component-list">
              {draft.components.map((component) => (
                <button
                  key={component.id}
                  className={`reference-layout-component-row${selectedComponentId === component.id ? " is-selected" : ""}`}
                  type="button"
                  onMouseEnter={() => hoverComponent(component.id)}
                  onMouseLeave={() => hoverComponent(null)}
                  onClick={() => {
                    selectComponent(component.id);
                    requestViewportFocus([
                      component.position[0],
                      component.position[1] + component.size[1] / 2,
                      component.position[2],
                    ]);
                  }}
                >
                  <i
                    aria-hidden="true"
                    className="reference-layout-category-dot"
                    style={{ background: LAYOUT_CATEGORY_COLORS[component.category] }}
                    title={CATEGORY_LABELS[component.category]}
                  />
                  <span>{component.name}</span>
                  <small>{CATEGORY_LABELS[component.category]} · {Math.round(component.confidence * 100)}%</small>
                  {component.uncertain ? <i>待确认</i> : null}
                </button>
              ))}
            </div>
            {characterCount > 0 ? (
              <div className="reference-layout-characters" aria-label="人物占位">
                <div className="reference-layout-characters-heading">
                  <span><Users aria-hidden="true" size={13} />人物 · {characterCount} 个（站位与姿态占位）</span>
                  {uncertainCharacterCount > 0 ? (
                    <span className="reference-layout-adjust-heading-actions">
                      <button type="button" onClick={keepAllUncertainCharacters}><CheckCheck aria-hidden="true" size={12} />全部保留</button>
                      <button type="button" onClick={dropAllUncertainCharacters}><Trash2 aria-hidden="true" size={12} />删除待确认</button>
                    </span>
                  ) : null}
                </div>
                <div className="reference-layout-component-list">
                  {draft?.characters.map((character) => (
                    <button
                      key={character.id}
                      className={`reference-layout-component-row${selectedCharacterId === character.id ? " is-selected" : ""}`}
                      type="button"
                      onMouseEnter={() => hoverCharacter(character.id)}
                      onMouseLeave={() => hoverCharacter(null)}
                      onClick={() => {
                        selectCharacter(character.id);
                        requestViewportFocus([
                          character.position[0],
                          character.position[1] + character.height / 2,
                          character.position[2],
                        ]);
                      }}
                    >
                      <i
                        aria-hidden="true"
                        className="reference-layout-category-dot"
                        style={{ background: LAYOUT_CHARACTER_COLOR }}
                        title="人物占位"
                      />
                      <span>{character.name}</span>
                      <small>{POSTURE_LABELS[character.posture]} · {character.height.toFixed(2)}m · {Math.round(character.confidence * 100)}%</small>
                      {character.uncertain ? <i>待确认</i> : null}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {selectedCharacter ? (
              <div className="reference-layout-editor" aria-label={`编辑${selectedCharacter.name}`}>
                <div className="reference-layout-editor-title">
                  <input
                    aria-label="人物名称"
                    value={selectedCharacter.name}
                    onChange={(event) => updateCharacter(selectedCharacter.id, (character) => ({ ...character, name: event.target.value.slice(0, 80) }))}
                  />
                  <button
                    type="button"
                    title="把脚底贴到地面（修正悬浮）"
                    aria-label="贴地"
                    disabled={selectedCharacter.posture === "sit" || selectedCharacter.position[1] === groundHeight}
                    onClick={snapSelectedCharacterToGround}
                  >
                    <ArrowDownToLine aria-hidden="true" size={14} />
                  </button>
                  <button type="button" title={selectedCharacter.visible ? "隐藏人物" : "显示人物"} aria-label={selectedCharacter.visible ? "隐藏人物" : "显示人物"} onClick={() => updateCharacter(selectedCharacter.id, (character) => ({ ...character, visible: !character.visible }))}>
                    {selectedCharacter.visible ? <Eye aria-hidden="true" size={14} /> : <EyeOff aria-hidden="true" size={14} />}
                  </button>
                  <button type="button" title="删除人物" aria-label="删除人物" onClick={() => { editedRef.current = true; setDraft({ ...draft, characters: draft.characters.filter((character) => character.id !== selectedCharacter.id) }); }}>
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </div>
                <div className="reference-layout-field-grid">
                  {(["X", "Y", "Z"] as const).map((axisLabel, axis) => (
                    <label key={`character-position-${axisLabel}`}>位置 {axisLabel}<input aria-label={`位置 ${axisLabel}`} type="number" step="0.1" value={selectedCharacter.position[axis]} onChange={(event) => updateCharacter(selectedCharacter.id, (character) => updateCharacterTuple(character, "position", axis as 0 | 1 | 2, event.target.value))} /></label>
                  ))}
                  <label>身高（米）<input aria-label="身高（米）" type="number" min={LAYOUT_CHARACTER_MIN_HEIGHT} max={LAYOUT_CHARACTER_MAX_HEIGHT} step="0.05" value={selectedCharacter.height} onChange={(event) => {
                    const value = finiteDraftNumber(event.target.value);
                    if (value === null) return;
                    updateCharacter(selectedCharacter.id, (character) => ({
                      ...character,
                      height: Math.min(LAYOUT_CHARACTER_MAX_HEIGHT, Math.max(LAYOUT_CHARACTER_MIN_HEIGHT, value)),
                    }));
                  }} /></label>
                  <label className="reference-layout-rotation-field">面朝（度）<input aria-label="面朝（度）" type="number" step="15" value={selectedCharacter.rotationYDegrees} onChange={(event) => {
                    const value = finiteDraftNumber(event.target.value);
                    if (value !== null) updateCharacter(selectedCharacter.id, (character) => ({ ...character, rotationYDegrees: value }));
                  }} /></label>
                  <label>姿态
                    <select aria-label="姿态" value={selectedCharacter.posture} onChange={(event) => updateCharacter(selectedCharacter.id, (character) => ({ ...character, posture: event.currentTarget.value as LayoutCharacterPosture }))}>
                      {LAYOUT_CHARACTER_POSTURES.map((posture) => (
                        <option key={posture} value={posture}>{POSTURE_LABELS[posture]}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="reference-layout-anchor-hint">
                  占位素体按「身高 ÷ 原生长度」缩放；坐姿人物的位置 Y 即座面高度，随家具调整。
                </p>
              </div>
            ) : selectedComponent ? (
              <div className="reference-layout-editor" aria-label={`编辑${selectedComponent.name}`}>
                <div className="reference-layout-editor-title">
                  <input
                    aria-label="组件名称"
                    value={selectedComponent.name}
                    onChange={(event) => updateComponent(selectedComponent.id, (component) => ({ ...component, name: event.target.value.slice(0, 80) }))}
                  />
                  <button
                    type="button"
                    title="把底面贴到地面（修正悬浮）"
                    aria-label="贴地"
                    disabled={selectedComponent.category === "ground" || selectedComponent.position[1] === groundHeight}
                    onClick={snapSelectedToGround}
                  >
                    <ArrowDownToLine aria-hidden="true" size={14} />
                  </button>
                  <button type="button" title={selectedComponent.visible ? "隐藏组件" : "显示组件"} aria-label={selectedComponent.visible ? "隐藏组件" : "显示组件"} onClick={() => updateComponent(selectedComponent.id, (component) => ({ ...component, visible: !component.visible }))}>
                    {selectedComponent.visible ? <Eye aria-hidden="true" size={14} /> : <EyeOff aria-hidden="true" size={14} />}
                  </button>
                  <button type="button" title="删除组件" aria-label="删除组件" onClick={() => { editedRef.current = true; setDraft({ ...draft, components: draft.components.filter((component) => component.id !== selectedComponent.id) }); }}>
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
                  <label>锚定维度
                    <select aria-label="锚定维度" value={anchorDimension} onChange={(event) => setAnchorDimension(event.currentTarget.value as LayoutAnchorDimension)}>
                      <option value="width">宽度</option>
                      <option value="height">高度</option>
                    </select>
                  </label>
                  <label>已知{DIMENSION_LABELS[anchorDimension]}（米）<input aria-label={`已知${DIMENSION_LABELS[anchorDimension]}（米）`} type="number" min="0.01" max="100" step="0.1" value={anchorWidth} onChange={(event) => setAnchorWidth(event.target.value)} /></label>
                  <button type="button" disabled={!anchorWidth} onClick={applyScaleAnchor}>校正</button>
                </div>
                {anchorPreset ? <p className="reference-layout-anchor-hint">已按「{anchorPreset.hint}」预填，可直接校正或改成你确知的尺寸。</p> : null}
              </div>
            ) : null}
            <div className="reference-layout-commit-row">
              <button className="reference-layout-primary-button" disabled={!draft.components.length} type="button" onClick={() => applyDraft("append")}>添加到当前场景</button>
              <button className="reference-layout-secondary-button" disabled={!replaceBatchId || !draft.components.length} type="button" onClick={() => applyDraft("replace-batch")}>替换此生成批次</button>
            </div>
            {characterCount > 0 ? (
              <p className="reference-layout-anchor-hint">将同时创建 {characterCount} 个角色占位（内置素体 + 姿态），可像普通角色一样编辑、排走位。</p>
            ) : null}
          </div>
        ) : null}

        {activeBatch ? (
          <div className="reference-layout-adjust" aria-label="布景整体调整">
            <div className="reference-layout-adjust-heading">
              <span><Move aria-hidden="true" size={14} />布景调整 · {activeBatch.sourceFileName}</span>
              <span className="reference-layout-adjust-heading-actions">
                <button type="button" onClick={focusBatchCenter}>看向整组</button>
                <button type="button" onClick={selectWholeBatch}>选中整组</button>
              </span>
            </div>
            <div className="reference-layout-adjust-row">
              <Scaling aria-hidden="true" size={14} />
              <label>整体缩放<input aria-label="整体缩放倍数" type="number" min="0.05" max="10" step="0.05" value={batchScale} onChange={(event) => setBatchScale(event.target.value)} /></label>
              <button type="button" onClick={applyBatchScale}>应用缩放</button>
            </div>
            <div className="reference-layout-adjust-row">
              <Move aria-hidden="true" size={14} />
              <label>平移 X<input aria-label="整体平移 X" type="number" step="0.1" value={batchOffsetX} onChange={(event) => setBatchOffsetX(event.target.value)} /></label>
              <label>平移 Z<input aria-label="整体平移 Z" type="number" step="0.1" value={batchOffsetZ} onChange={(event) => setBatchOffsetZ(event.target.value)} /></label>
              <button type="button" onClick={applyBatchOffset}>应用平移</button>
            </div>
            <div className="reference-layout-adjust-row">
              <ArrowDownToLine aria-hidden="true" size={14} />
              <span>悬浮的组件一键落回地面（角色除外）</span>
              <button type="button" onClick={snapBatchToGround}>整批贴地</button>
            </div>
            <p className="reference-layout-anchor-hint">缩放以布景中心为基准；每次操作可用 Ctrl/Cmd+Z 撤回。</p>
          </div>
        ) : null}
      </div>
    </InspectorSection>
  );
}
