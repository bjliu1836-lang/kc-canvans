import {
  ArrowDownToLine,
  Box,
  CheckCheck,
  Camera,
  Eye,
  EyeOff,
  ImagePlus,
  LoaderCircle,
  Maximize2,
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
import { downloadLayoutDiagnostics, isLayoutDiagnosticsEnabled, recordLayoutDraftApplied, recordLayoutReferencePreview } from "../io/layoutDiagnostics";
import {
  calibrateLayoutDraft,
  getLayoutDraftReferenceCamera,
  LAYOUT_ANCHOR_PRESETS,
  LAYOUT_CATEGORY_COLORS,
  LAYOUT_CHARACTER_COLOR,
  LAYOUT_CHARACTER_MAX_HEIGHT,
  LAYOUT_CHARACTER_MIN_HEIGHT,
  LAYOUT_CHARACTER_POSTURES,
  LAYOUT_HAND_GESTURES,
  LAYOUT_KNEEL_VARIANTS,
  LayoutDraftValidationError,
  type LayoutAnchorDimension,
  type LayoutCharacterPosture,
  type LayoutHandGesture,
  type LayoutKneelVariant,
  type LayoutDraftCharacter,
  type LayoutDraftComponent,
} from "../schema/layoutDraft";
import { useDirectorStore } from "../store/directorStore";
import { useLayoutDraftPreviewStore } from "../store/layoutDraftPreviewStore";
import { InspectorSection } from "./InspectorControls";

const LAYOUT_VALIDATION_WARNING_LABELS: Record<string, string> = {
  space_type_invalid: "空间类型无法确认。",
  observations_truncated: "可见性证据较多，部分已省略。",
  observation_invalid: "部分可见性证据格式无效，已忽略。",
  observation_component_missing: "部分可见性证据没有对应组件，已忽略。",
  relations_truncated: "空间关系较多，部分已省略。",
  relation_invalid: "部分空间关系格式无效，已忽略。",
  relation_endpoint_missing: "部分空间关系缺少有效组件，已忽略。",
  attachment_unresolved: "门窗附着关系无法安全应用，请检查位置和朝向。",
  attachment_geometry_conflict: "门窗与墙的几何不匹配，请检查位置和朝向。",
  attachment_adjusted_review: "已按明确关系贴合门窗与墙面，请复核结果。",
  head_at_geometry_conflict: "床头与目标墙的位置关系不一致；床保持原位，请确认。",
  head_at_requires_visual_review: "床头墙关系需要对照参考图确认。",
  head_at_endpoint_invalid: "床头关系的端点应为床体（semanticType=bed）指向墙；当前关系待确认。",
  appearance_color_missing: "未识别原图颜色，当前使用默认材质，请确认",
  component_exceeds_room_height: "有可见组件顶部超出已识别墙高；已保留原几何，请对照参考图确认。",
};

function getLayoutValidationWarningLabels(warnings: readonly string[] | undefined) {
  return [...new Set((warnings ?? []).map((warning) => LAYOUT_VALIDATION_WARNING_LABELS[warning]).filter(Boolean))];
}

function getProjectionFitReviewMessage(camera: ReturnType<typeof getLayoutDraftReferenceCamera> | undefined | null, components: readonly LayoutDraftComponent[]) {
  const fit = camera?.fitDiagnostics;
  if (fit?.qualityStatus !== "needsReview" || fit.passedErrorThreshold !== false || !fit.pairDiagnostics?.length) return null;
  const componentNames = new Map(components.map((component) => [component.id, component.name]));
  const residuals = [...fit.pairDiagnostics].sort((a, b) => b.weightedContribution - a.weightedContribution);
  const total = residuals.reduce((sum, item) => sum + item.weightedContribution, 0);
  const selected: typeof residuals = [];
  let contribution = 0;
  for (const residual of residuals) {
    if (selected.length >= 3) break;
    selected.push(residual);
    contribution += residual.weightedContribution;
    if (total <= 0 || contribution >= total * 0.7) break;
  }
  const items = selected.map((residual) => `${componentNames.get(residual.id) ?? residual.id}（中心 ${residual.centerError.toFixed(2)}、尺度 ${residual.scaleError.toFixed(2)}）`);
  return `参考机位投影与观察框仍有较大差异，主要在：${items.join("、")}。请复核这些物件的可见范围、遮挡和估算尺寸；物件位置与尺寸未被自动改写。`;
}

const CATEGORY_LABELS: Record<LayoutDraftComponent["category"], string> = {
  ground: "地面",
  wall: "墙体",
  door: "门",
  window: "窗",
  table: "桌子",
  chair: "椅子",
  sofa: "沙发",
  cabinet: "柜子",
  pillar: "柱子",
  prop: "道具",
};

const POSTURE_LABELS: Record<LayoutCharacterPosture, string> = {
  stand: "站立",
  sit: "坐姿",
  crouch: "蹲下",
  kneel: "跪姿",
  lie: "卧姿",
  unknown: "姿态未知",
};

const KNEEL_VARIANT_LABELS: Record<LayoutKneelVariant, string> = {
  "one-knee": "单膝跪",
  "two-knee": "双膝直身跪",
  seiza: "跪坐（臀落脚跟）",
};

const HAND_GESTURE_LABELS: Record<LayoutHandGesture, string> = {
  prayer: "双手合十",
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

interface RetainedReferenceLayoutPanelState {
  localImage: ReferenceLayoutImage | null;
  selectedSourceId: string;
  appliedBatchId: string | null;
}

const retainedPanelStateByScope = new Map<string, RetainedReferenceLayoutPanelState>();

function getPanelScopeKey(scopeId: string | null) {
  return scopeId || "standalone";
}

function getRetainedPanelState(scopeId: string | null) {
  return retainedPanelStateByScope.get(getPanelScopeKey(scopeId)) ?? {
    localImage: null,
    selectedSourceId: "",
    appliedBatchId: null,
  };
}

function updateRetainedPanelState(
  scopeId: string | null,
  patch: Partial<RetainedReferenceLayoutPanelState>
) {
  const key = getPanelScopeKey(scopeId);
  retainedPanelStateByScope.set(key, { ...getRetainedPanelState(scopeId), ...patch });
}

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
  const setViewMode = useDirectorStore((state) => state.setViewMode);
  const setFinishedShotFov = useDirectorStore((state) => state.setFinishedShotFov);
  const transformLayoutBatch = useDirectorStore((state) => state.transformLayoutBatch);
  const selectObject = useDirectorStore((state) => state.selectObject);
  const toggleObjectSelection = useDirectorStore((state) => state.toggleObjectSelection);
  const requestViewportFocus = useDirectorStore((state) => state.requestViewportFocus);
  const previewReferenceCamera = useDirectorStore((state) => state.previewReferenceCamera);
  const referenceCameraPreview = useDirectorStore((state) => state.referenceCameraPreview);
  const groundHeight = useDirectorStore((state) => state.project.scene.groundHeight);
  const sceneObjects = useDirectorStore((state) => state.project.objects);
  const layoutBatches = useDirectorStore((state) => state.project.layoutBatches ?? []);
  const scopeId = useLayoutDraftPreviewStore((state) => state.scopeId);
  const draft = useLayoutDraftPreviewStore((state) => state.draft);
  const draftEdited = useLayoutDraftPreviewStore((state) => state.draftEdited);
  const selectedComponentId = useLayoutDraftPreviewStore((state) => state.selectedComponentId);
  const setDraft = useLayoutDraftPreviewStore((state) => state.setDraft);
  const openDraftScope = useLayoutDraftPreviewStore((state) => state.openScope);
  const discardDraft = useLayoutDraftPreviewStore((state) => state.discardDraft);
  const selectComponent = useLayoutDraftPreviewStore((state) => state.selectComponent);
  const hoverComponent = useLayoutDraftPreviewStore((state) => state.hoverComponent);
  const selectedCharacterId = useLayoutDraftPreviewStore((state) => state.selectedCharacterId);
  const selectCharacter = useLayoutDraftPreviewStore((state) => state.selectCharacter);
  const hoverCharacter = useLayoutDraftPreviewStore((state) => state.hoverCharacter);
  const initialRetainedPanelState = getRetainedPanelState(scopeId);
  const [connectedImages, setConnectedImages] = useState(() => getHostReferenceImages().map(connectedImageToReference));
  const [localImage, setLocalImage] = useState<ReferenceLayoutImage | null>(initialRetainedPanelState.localImage);
  const [selectedSourceId, setSelectedSourceId] = useState<string>(initialRetainedPanelState.selectedSourceId);
  const [generating, setGenerating] = useState(false);
  const [stage, setStage] = useState<GenerationStage | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [anchorWidth, setAnchorWidth] = useState("");
  const [anchorDimension, setAnchorDimension] = useState<LayoutAnchorDimension>("width");
  const [appliedBatchId, setAppliedBatchId] = useState<string | null>(initialRetainedPanelState.appliedBatchId);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [viewingImage, setViewingImage] = useState<ReferenceLayoutImage | null>(null);
  const [batchScale, setBatchScale] = useState("1.2");
  const [batchOffsetX, setBatchOffsetX] = useState("");
  const [batchOffsetZ, setBatchOffsetZ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const previewButtonRef = useRef<HTMLButtonElement>(null);
  const viewerCloseButtonRef = useRef<HTMLButtonElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const activeScopeRef = useRef(scopeId);

  const images = useMemo(
    () => [localImage, ...connectedImages].filter((image): image is ReferenceLayoutImage => Boolean(image)),
    [connectedImages, localImage]
  );
  const selectedImage = images.find((image) => image.sourceId === selectedSourceId) ?? images[0] ?? null;
  const selectedComponent = draft?.components.find((component) => component.id === selectedComponentId) ?? null;
  const draftReferenceCamera = draft ? getLayoutDraftReferenceCamera(draft) : null;
  const draftValidationWarnings = getLayoutValidationWarningLabels(draft?.validationWarnings);
  const projectionFitReviewMessage = getProjectionFitReviewMessage(draftReferenceCamera, draft?.components ?? []);
  const selectedCharacter = draft?.characters.find((character) => character.id === selectedCharacterId) ?? null;
  const selectedComponentSupport = selectedComponent?.supportComponentId
    ? draft?.components.find((component) => component.id === selectedComponent.supportComponentId) ?? null
    : null;
  const selectedCharacterSupport = selectedCharacter?.supportComponentId
    ? draft?.components.find((component) => component.id === selectedCharacter.supportComponentId) ?? null
    : null;
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

  // 选中组件变化时，旧类别预填常见尺寸；差异较大的新类别要求用户填写实测值。
  useEffect(() => {
    if (!anchorPreset) return;
    setAnchorDimension(anchorPreset.dimension);
    setAnchorWidth(anchorPreset.meters === undefined ? "" : String(anchorPreset.meters));
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

  useEffect(() => {
    if (!viewingImage) return undefined;
    viewerCloseButtonRef.current?.focus();
    function handleViewerKeyDown(event: KeyboardEvent) {
      event.stopPropagation();
      if (event.key === "Tab") {
        event.preventDefault();
        viewerCloseButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      setViewingImage(null);
      window.setTimeout(() => previewButtonRef.current?.focus(), 0);
    }
    window.addEventListener("keydown", handleViewerKeyDown, true);
    return () => window.removeEventListener("keydown", handleViewerKeyDown, true);
  }, [viewingImage]);

  // Ctrl+V 粘贴截图作为参考图（不劫持输入框内粘贴）
  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      if (isEditableTarget(event.target)) return;
      const file = Array.from(event.clipboardData?.files ?? []).find((item) => item.type.startsWith("image/"));
      if (!file) return;
      event.preventDefault();
      void readReferenceImageFile(file).then((image) => {
        updateRetainedPanelState(scopeId, { localImage: image, selectedSourceId: image.sourceId });
        setLocalImage(image);
        chooseSource(image.sourceId);
      }).catch((reason) => setError(reason instanceof Error ? reason.message : "参考图读取失败"));
    }
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId]);

  useEffect(() => {
    if (activeScopeRef.current === scopeId) return;
    if (useDirectorStore.getState().referenceCameraPreview) {
      previewReferenceCamera(null);
      setViewMode("director");
    }
    abortRef.current?.abort();
    requestIdRef.current += 1;
    const retained = getRetainedPanelState(scopeId);
    activeScopeRef.current = scopeId;
    setGenerating(false);
    setStage(null);
    setError(null);
    setLocalImage(retained.localImage);
    setConnectedImages(getHostReferenceImages().map(connectedImageToReference));
    setSelectedSourceId(retained.selectedSourceId);
    setAppliedBatchId(retained.appliedBatchId);
    setConfirmRegenerate(false);
    setViewingImage(null);
  }, [previewReferenceCamera, scopeId, setViewMode]);

  useEffect(() => {
    const updateConnectedImages = (event: Event) => {
      const detail = (event as CustomEvent<{ images?: HostReferenceImage[] }>).detail;
      const next = Array.isArray(detail?.images) ? detail.images.map(connectedImageToReference) : [];
      setConnectedImages(next);
      setSelectedSourceId((current) => current || next[0]?.sourceId || "");
    };
    const resetForInstance = (event: Event) => {
      const instanceId = (event as CustomEvent<{ instanceId?: string }>).detail?.instanceId ?? null;
      openDraftScope(instanceId);
      abortRef.current?.abort();
      requestIdRef.current += 1;
      setGenerating(false);
      setStage(null);
      setError(null);
      setConnectedImages([]);
      setConfirmRegenerate(false);
      setViewingImage(null);
      if (useDirectorStore.getState().referenceCameraPreview) {
        previewReferenceCamera(null);
        setViewMode("director");
      }
    };
    window.addEventListener(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, updateConnectedImages);
    window.addEventListener(DIRECTOR_DESK_SESSION_OPENED_EVENT, resetForInstance);
    return () => {
      window.removeEventListener(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, updateConnectedImages);
      window.removeEventListener(DIRECTOR_DESK_SESSION_OPENED_EVENT, resetForInstance);
      abortRef.current?.abort();
    };
  }, [openDraftScope, previewReferenceCamera, setViewMode]);

  useEffect(() => () => {
    if (useDirectorStore.getState().referenceCameraPreview) {
      useDirectorStore.getState().previewReferenceCamera(null);
      useDirectorStore.getState().setViewMode("director");
    }
  }, []);

  useEffect(() => {
    if (!selectedSourceId && images[0]) {
      updateRetainedPanelState(scopeId, { selectedSourceId: images[0].sourceId });
      setSelectedSourceId(images[0].sourceId);
    }
  }, [images, scopeId, selectedSourceId]);

  function chooseSource(sourceId: string) {
    if (useDirectorStore.getState().referenceCameraPreview) {
      previewReferenceCamera(null);
      setViewMode("director");
    }
    abortRef.current?.abort();
    requestIdRef.current += 1;
    setGenerating(false);
    setStage(null);
    setSelectedSourceId(sourceId);
    updateRetainedPanelState(scopeId, { selectedSourceId: sourceId });
    setError(null);
    setAnchorWidth("");
    setAppliedBatchId(null);
    updateRetainedPanelState(scopeId, { appliedBatchId: null });
    setConfirmRegenerate(false);
    setViewingImage(null);
  }

  function rememberImageAspectRatio(sourceId: string, width: number, height: number) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    const aspectRatio = width / height;
    if (aspectRatio < 0.1 || aspectRatio > 10) return;
    setLocalImage((image) => image?.sourceId === sourceId ? { ...image, aspectRatio } : image);
    setConnectedImages((images) => images.map((image) => image.sourceId === sourceId ? { ...image, aspectRatio } : image));
  }

  function closeImageViewer() {
    setViewingImage(null);
    window.setTimeout(() => previewButtonRef.current?.focus(), 0);
  }

  async function generateLayout(forceReplaceEditedDraft = false) {
    if (!selectedImage || generating) return;
    if (draft && draftEdited && !forceReplaceEditedDraft) {
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
      setDraft(nextDraft, { edited: false });
      const estimatedCamera = getLayoutDraftReferenceCamera(nextDraft);
      if (estimatedCamera.source === "estimated") {
        setViewMode("director");
        previewReferenceCamera({
          ...estimatedCamera,
          ...(selectedImage.aspectRatio ? { imageAspectRatio: selectedImage.aspectRatio } : {}),
        });
      }
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
    setDraft({
      ...draft,
      components: draft.components.map((component) => component.id === id ? updater(component) : component),
    }, { edited: true });
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
      setDraft(calibrateLayoutDraft(draft, selectedComponent.id, parsed ?? Number.NaN, anchorDimension), { edited: true });
      setError(null);
    } catch (reason) {
      setError(reason instanceof LayoutDraftValidationError ? reason.message : "尺寸校正失败");
    }
  }

  function keepAllUncertain() {
    if (!draft) return;
    setDraft({
      ...draft,
      components: draft.components.map((component) => component.uncertain ? { ...component, uncertain: false } : component),
    }, { edited: true });
  }

  function dropAllUncertain() {
    if (!draft) return;
    setDraft({
      ...draft,
      components: draft.components.filter((component) => !component.uncertain),
    }, { edited: true });
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
    setDraft({
      ...draft,
      characters: draft.characters.map((character) => character.id === id ? updater(character) : character),
    }, { edited: true });
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
    setDraft({
      ...draft,
      characters: draft.characters.map((character) => character.uncertain ? { ...character, uncertain: false } : character),
    }, { edited: true });
  }

  function dropAllUncertainCharacters() {
    if (!draft) return;
    setDraft({
      ...draft,
      characters: draft.characters.filter((character) => !character.uncertain),
    }, { edited: true });
  }

  function applyDraft(mode: "append" | "replace-batch") {
    if (!draft) return;
    const wasPreviewingReferenceCamera = Boolean(useDirectorStore.getState().referenceCameraPreview);
    const result = applyLayoutDraft({
      draft,
      mode,
      replaceBatchId: mode === "replace-batch" ? replaceBatchId : null,
    });
    const appliedObjects = useDirectorStore.getState().project.objects.filter((object) => result.objectIds.includes(object.id));
    recordLayoutDraftApplied(draft.diagnosticGenerationId ?? draft.id, result.batchId, appliedObjects);
    if (wasPreviewingReferenceCamera) {
      setFinishedShotFov(null);
      setViewMode("camera");
      previewReferenceCamera(null);
    }
    setAppliedBatchId(result.batchId);
    updateRetainedPanelState(scopeId, { appliedBatchId: result.batchId });
    setDraft(null);
    setError(null);
  }

  function previewDraftReferenceCamera() {
    if (!draft) return;
    if (referenceCameraPreview) {
      recordLayoutReferencePreview(draft.diagnosticGenerationId ?? draft.id, false);
      previewReferenceCamera(null);
      setViewMode("director");
      return;
    }
    setViewMode("director");
    const referenceCamera = {
      ...getLayoutDraftReferenceCamera(draft),
      ...(selectedImage?.aspectRatio ? { imageAspectRatio: selectedImage.aspectRatio } : {}),
    };
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("directorLayoutDebugCamera")) {
      (window as Window & { __directorLayoutDraftCameraDebug?: unknown }).__directorLayoutDraftCameraDebug = {
        draftReferenceCamera: draft.referenceCamera,
        previewReferenceCamera: referenceCamera,
        selectedImageAspectRatio: selectedImage?.aspectRatio,
      };
    }
    recordLayoutReferencePreview(draft.diagnosticGenerationId ?? draft.id, true, referenceCamera);
    previewReferenceCamera(referenceCamera);
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
      updateRetainedPanelState(scopeId, { localImage: image, selectedSourceId: image.sourceId });
      setLocalImage(image);
      chooseSource(image.sourceId);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "参考图读取失败"));
  }

  return (
    <InspectorSection title={draft ? "待应用布景" : "参考图粗布景"}>
      <>
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
            <button
              ref={previewButtonRef}
              className="reference-layout-preview-button"
              type="button"
              aria-label={`查看参考图大图：${selectedImage.fileName}`}
              title="点击查看大图"
              onClick={() => setViewingImage(selectedImage)}
            >
              <img
                alt="当前粗布景参考图"
                src={selectedImage.url}
                onLoad={(event) => rememberImageAspectRatio(selectedImage.sourceId, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
              />
              <Maximize2 aria-hidden="true" size={13} />
            </button>
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
        {isLayoutDiagnosticsEnabled() ? (
          <button className="reference-layout-secondary-button" type="button" onClick={downloadLayoutDiagnostics}>
            <ArrowDownToLine aria-hidden="true" size={14} />导出本次会话的诊断 JSON
          </button>
        ) : null}
        {generating && stage ? (
          <p className="reference-layout-progress" role="status">
            {STAGE_LABELS[stage]}{stage === "generating" ? `（已用 ${elapsedSeconds} 秒，通常需要 20-60 秒）` : ""}
          </p>
        ) : null}
        {confirmRegenerate ? (
          <div className="reference-layout-confirm-row" role="alert">
            <span>已手动修改过当前预览，重新生成将丢弃这些修改。</span>
            <button type="button" onClick={() => { setConfirmRegenerate(false); void generateLayout(true); }}>仍要重新生成</button>
            <button type="button" onClick={() => setConfirmRegenerate(false)}>保留修改</button>
          </div>
        ) : null}
        {error ? <p className="reference-layout-error" role="alert">{error}</p> : null}

        {draft ? (
          <div className="reference-layout-draft" aria-label="粗布景暂存预览">
            <div className="reference-layout-draft-heading">
              <span><Box aria-hidden="true" size={14} />待应用布景 · {draft.components.length} 个组件 / {characterCount} 个人物</span>
          <span className="reference-layout-adjust-heading-actions">
                <em>{draft.scale.mode === "anchored" ? "已按已知尺寸校正" : "未锚定 · 尺度为估计"}</em>
                {draft.referenceCamera?.source === "estimated" ? <em>参考取景 · 待确认</em> : null}
              <button type="button" onClick={previewDraftReferenceCamera} title={referenceCameraPreview ? "退出参考机位预览" : "按同一推断机位查看可编辑草稿"}>
                  <Camera aria-hidden="true" size={13} />参考机位
                </button>
              </span>
            </div>
            <p className="reference-layout-anchor-hint">
              {draftReferenceCamera?.source === "estimated"
                ? "已按原图估算视角与布局，请核对物品位置、比例和遮挡；可直接转动视角调整。"
                : draftReferenceCamera?.fitDiagnostics?.qualityStatus === "needsReview"
                ? "已按原图估算视角与布局，请核对物品位置、比例和遮挡；可直接转动视角调整。"
                : draftReferenceCamera?.fitDiagnostics?.qualityStatus === "accepted"
                  ? "已按原图估算视角与布局，请核对物品位置、比例和遮挡；可直接转动视角调整。"
                  : draftReferenceCamera?.source === "model"
                    ? `参考机位为单图推断（置信度 ${Math.round(draftReferenceCamera.confidence * 100)}%），用于画幅对照。`
                    : "未得到可信相机信息，已按场景边界自动取景；可应用后继续调整机位。"}
            </p>
            {projectionFitReviewMessage ? (
              <div className="reference-layout-diagnostic is-warning" role="alert" aria-label="参考机位残差待复核">
                <p>{projectionFitReviewMessage}</p>
              </div>
            ) : null}
            {draftValidationWarnings.length ? (
              <div className="reference-layout-diagnostic is-warning" role="status" aria-label="布景校验提示">
                {draftValidationWarnings.map((warning) => <p key={warning}>{warning}</p>)}
              </div>
            ) : null}
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
                      <small>{character.posture === "kneel" && character.kneelVariant ? KNEEL_VARIANT_LABELS[character.kneelVariant] : POSTURE_LABELS[character.posture]} · {character.height.toFixed(2)}m · {Math.round(character.confidence * 100)}%</small>
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
                  <button type="button" title="删除人物" aria-label="删除人物" onClick={() => setDraft({ ...draft, characters: draft.characters.filter((character) => character.id !== selectedCharacter.id) }, { edited: true })}>
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
                    {selectedCharacter.posture === "kneel" ? (
                      <select
                        aria-label="跪姿细分"
                        value={selectedCharacter.kneelVariant ?? "one-knee"}
                        onChange={(event) => updateCharacter(selectedCharacter.id, (character) => ({
                          ...character,
                          kneelVariant: event.currentTarget.value as LayoutKneelVariant,
                        }))}
                      >
                        {LAYOUT_KNEEL_VARIANTS.map((variant) => (
                          <option key={variant} value={variant}>{KNEEL_VARIANT_LABELS[variant]}</option>
                        ))}
                      </select>
                    ) : null}
                    <select
                      aria-label="手势"
                      value={selectedCharacter.handGesture ?? ""}
                      onChange={(event) => updateCharacter(selectedCharacter.id, (character) => ({
                        ...character,
                        handGesture: event.currentTarget.value
                          ? event.currentTarget.value as LayoutHandGesture
                          : undefined,
                      }))}
                    >
                      <option value="">默认手势</option>
                      {LAYOUT_HAND_GESTURES.map((gesture) => (
                        <option key={gesture} value={gesture}>{HAND_GESTURE_LABELS[gesture]}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="reference-layout-anchor-hint">
                  占位素体按「身高 ÷ 原生长度」缩放；坐姿人物的位置 Y 即座面高度，随家具调整。
                </p>
                {selectedCharacter.notes || selectedCharacterSupport ? (
                  <p
                    className={`reference-layout-diagnostic${selectedCharacter.uncertain ? " is-warning" : ""}`}
                    title={selectedCharacter.notes}
                  >
                    {selectedCharacterSupport ? <strong>支撑：{selectedCharacterSupport.name}。 </strong> : null}
                    {selectedCharacter.notes}
                  </p>
                ) : null}
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
                  <button type="button" title="删除组件" aria-label="删除组件" onClick={() => setDraft({ ...draft, components: draft.components.filter((component) => component.id !== selectedComponent.id) }, { edited: true })}>
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
                {anchorPreset ? (
                  <p className="reference-layout-anchor-hint">
                    {anchorPreset.meters === undefined
                      ? `${anchorPreset.hint}，请填写你确知的实测尺寸后校正。`
                      : `已按「${anchorPreset.hint}」预填，可直接校正或改成你确知的尺寸。`}
                  </p>
                ) : null}
                {selectedComponent.notes || selectedComponentSupport ? (
                  <p
                    className={`reference-layout-diagnostic${selectedComponent.uncertain ? " is-warning" : ""}`}
                    title={selectedComponent.notes}
                  >
                    {selectedComponentSupport ? <strong>支撑：{selectedComponentSupport.name}。 </strong> : null}
                    {selectedComponent.notes}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="reference-layout-commit-row">
              <button className="reference-layout-primary-button" disabled={!draft.components.length && !characterCount} type="button" onClick={() => applyDraft("append")}>添加到当前场景</button>
              <button className="reference-layout-secondary-button" disabled={!replaceBatchId || (!draft.components.length && !characterCount)} type="button" onClick={() => applyDraft("replace-batch")}>替换此生成批次</button>
              <button className="reference-layout-secondary-button" type="button" onClick={() => { discardDraft(); previewReferenceCamera(null); setError(null); }}>丢弃草稿</button>
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
      {viewingImage ? (
        <div
          aria-label={`参考图查看器：${viewingImage.fileName}`}
          aria-modal="true"
          className="reference-layout-image-viewer"
          role="dialog"
          onClick={closeImageViewer}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            ref={viewerCloseButtonRef}
            aria-label="关闭参考图查看器"
            className="reference-layout-image-viewer-close"
            type="button"
            onClick={closeImageViewer}
          >
            <X aria-hidden="true" size={20} />
          </button>
          <img
            alt={`${viewingImage.fileName} 大图`}
            className="reference-layout-image-viewer-image"
            src={viewingImage.url}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      ) : null}
      </>
    </InspectorSection>
  );
}
