import type {
  DirectorCharacterBoneMap,
  DirectorCameraTargetBodyPart,
  DirectorCameraTargetFollowMode,
} from "./semanticBody";

export type ViewMode = "director" | "camera";
export type RightPanelKind = "scene" | "character" | "prop" | "camera";
export type DirectorObjectKind = "character" | "scene" | "prop" | "camera" | "panorama";
export const GEOMETRY_PRIMITIVE_OPTIONS = [
  { type: "box", label: "立方体" },
  { type: "sphere", label: "球体" },
  { type: "cylinder", label: "圆柱体" },
  { type: "torus", label: "环状体" },
  { type: "cone", label: "圆锥" },
  { type: "pyramid", label: "棱锥" },
] as const;
export type GeometryPrimitiveType = (typeof GEOMETRY_PRIMITIVE_OPTIONS)[number]["type"];
export type DirectorLayoutCategory = "ground" | "wall" | "door" | "window" | "table" | "chair" | "sofa" | "cabinet" | "pillar" | "prop";
export type CharacterRigType = "mannequin" | "ue4-mannequin" | "mixamo" | "vrm" | "custom-humanoid";
export type CharacterBodyType =
  | "mannequin"
  | "female"
  | "broad"
  | "muscular"
  | "slim"
  | "teen"
  | "child"
  | "chibi";
export type DirectorAssetKind = "character" | "scene" | "prop" | "panorama";
export type DirectorAssetSource = "local" | "library";
export type PanoramaProjectionMode = "equirectangular" | "backdrop";
export type DirectorModelFormat = "fbx" | "obj" | "glb";
export type GroundMaterialPresetId = "studio" | "concrete" | "asphalt" | "wood" | "grass";
export type CharacterRigProfile = "mixamo" | "mixamo-alt" | "bip" | "cc-base" | "generic-humanoid" | "unknown";
export type CharacterImportReadiness = "ready" | "native-only" | "manual-mapping" | "static-only";

export interface DirectorTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface SceneSettings {
  scale: number;
  position: [number, number, number];
  rotation: [number, number, number];
  backgroundColor: string;
  backgroundBrightness: number;
  panoramaYaw: number;
  panoramaRadius: number;
  showLabels: boolean;
  snapToGrid: boolean;
  showGrid: boolean;
  showGround: boolean;
  groundMaterialPreset: GroundMaterialPresetId;
  /** Multiplier for the world-space size of each ground texture tile. */
  groundTextureScale: number;
  groundColor: string;
  groundBrightness: number;
  groundOpacity: number;
  groundHeight: number;
  pathCollisionEnabled: boolean;
}

export interface CharacterRigState {
  rigType: CharacterRigType;
  posePresetId: string | null;
  actionPresetId?: string | null;
  controls: Record<string, number>;
}

export interface DirectorAssetRef {
  id: string;
  kind: DirectorAssetKind;
  sourceType: "model" | "image";
  fileName: string;
  name?: string;
  url: string;
  assetSource?: DirectorAssetSource;
  projectionMode?: PanoramaProjectionMode;
  modelFormat?: DirectorModelFormat;
  storageKey?: string;
  byteLength?: number;
  characterRigProfile?: CharacterRigProfile;
  characterImportReadiness?: CharacterImportReadiness;
  characterOrientationCorrection?: [number, number, number];
  characterBoneMap?: DirectorCharacterBoneMap;
}

export interface DirectorAnimationClipRef {
  id: string;
  name: string;
  duration: number;
  trackCount: number;
}

export interface DirectorAnimationAssetRef {
  id: string;
  name: string;
  fileName: string;
  url: string;
  modelFormat: Extract<DirectorModelFormat, "fbx" | "glb">;
  storageKey?: string;
  byteLength?: number;
  rigProfile: CharacterRigProfile;
  sourceCharacterAssetId?: string;
  clips: DirectorAnimationClipRef[];
}

export interface DirectorObject {
  id: string;
  name: string;
  kind: DirectorObjectKind;
  visible: boolean;
  locked: boolean;
  transform: DirectorTransform;
  bodyType?: CharacterBodyType;
  color?: string;
  assetRefId?: string;
  geometryType?: GeometryPrimitiveType;
  crowdId?: string;
  crowdLabel?: string;
  linkedCameraId?: string | null;
  characterRig?: CharacterRigState;
  motionPath?: DirectorObjectMotionPath;
  layoutSource?: {
    batchId: string;
    draftId: string;
    sourceId: string;
    sourceFileName: string;
    componentId: string;
    category: DirectorLayoutCategory | "character";
    confidence: number;
    uncertain: boolean;
    /** Layout-generated catalog asset whose local model is fitted to the recognized unit box. */
    catalogFit?: "unit-box-bottom-center-v1";
    /** Generated single-object assets preserve mesh proportions inside the recognized target box. */
    generatedAssetSource?: "reference-image-object-v1";
    generatedAssetFit?: "uniform-contained-bottom-center-v1";
    /** Frozen fit reference; later object scale edits must not be normalized away. */
    generatedAssetFitTargetSize?: [number, number, number];
    generatedAssetNeedsReview?: boolean;
    /** 参考图识别出的受限模型语义与材质提示；不等同于外部 image-to-3D 资产。 */
    modelDescriptor?: string;
    appearance?: {
      color?: string;
      roughness?: number;
      metalness?: number;
      /** 局部 +Z 正面在世界中的朝向；由对象 rotation 同步呈现。 */
      frontDirectionDegrees?: number;
    };
    assembly?: Array<{
      primitive: "box" | "cylinder" | "sphere" | "cone" | "torus";
      position: [number, number, number];
      size: [number, number, number];
      rotation?: [number, number, number];
      /** Bounded per-part opacity for semantic preset details such as a sheer curtain. */
      opacity?: number;
    }>;
    groundFootprint?: Array<{
      outer: [number, number][];
      holes?: [number, number][][];
      confidence: number;
    }>;
    /** category === "character" 时携带的占位元数据（姿态与估算身高）。 */
    characterMeta?: {
      posture: "stand" | "sit" | "crouch" | "kneel" | "lie" | "unknown";
      facingDirection?: "image_left" | "image_right" | "toward_camera" | "away_from_camera" | "image_up" | "image_down" | "unknown";
      kneelVariant?: "one-knee" | "two-knee" | "seiza";
      handGesture?: "prayer";
      height: number;
    };
  };
}

export interface DirectorLayoutBatch {
  id: string;
  draftId: string;
  sourceId: string;
  sourceFileName: string;
  createdAt: string;
  scale: {
    mode: "estimated" | "anchored";
    confidence: number;
    anchorComponentId?: string;
    anchorWidthMeters?: number;
    anchorDimension?: "width" | "height";
  };
  objectIds: string[];
  /** 单图透视推断的对照机位；应用时以独立相机保存，绝不覆盖既有运镜。 */
  referenceCamera?: DirectorLayoutReferenceCamera;
  referenceCameraId?: string;
}

export interface DirectorLayoutReferenceCamera {
  projection: "perspective";
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  /** Intrinsic source-image aspect used to fit a matching preview frame when known. */
  imageAspectRatio?: number;
  /** 0 表示按场景边界自动取景，并非模型恢复出的原始相机。 */
  confidence: number;
  source: "model" | "bounds-fallback" | "estimated";
  /** Numeric-only audit trail for bounded observation-based camera fitting. */
  fitDiagnostics?: {
    qualityStatus?: "accepted" | "needsReview" | "unavailable";
    itemCount: number;
    candidateCount: number;
    baselineProjectionError: number | null;
    bestProjectionError: number | null;
    appliedProjectionError?: number | null;
    cameraOnlyBestProjectionError?: number | null;
    floorProjectionRejectedCandidateCount?: number;
    pairDiagnostics?: Array<{
      id: string;
      observedCenter: [number, number];
      observedSize: [number, number];
      predictedCenter: [number, number];
      predictedSize: [number, number];
      centerError: number;
      scaleError: number;
      weightedContribution: number;
    }>;
    bestCandidate: { position: [number, number, number]; target: [number, number, number]; fov: number } | null;
    applied: boolean;
    passedErrorThreshold?: boolean;
    movedGroundItems?: number;
    movedComponents?: number;
    positionAdjustmentMeters?: number;
    spatialEvidenceTrace?: {
      selectedBranch: "footprint" | "joint" | "none";
      sourceFootprintIds: string[];
      eligiblePairIds: string[];
      uniqueCameraCandidateCount: number;
      initializedCameraCandidateCount: number;
      preselectionSafeFootprintCandidateCount?: number;
      postSelectionFootprintCandidateCount?: number;
      targetSafeFootprintCandidateCount?: number;
      safetyCheckStoppedEarly?: boolean;
      initializedFootprintIds: string[];
      safetyCheckedFootprintCandidateCount: number;
      failedInitializationById: Array<{ id: string; cameraCount: number }>;
      footprintOverlapRejectedCandidateCount: number;
      majorOverlapRejects: Array<{ firstId: string; secondId: string; candidateCount: number; maxPenetrationMeters: number }>;
      selectedRefinementSearch?: {
        evaluationBudget: number; evaluationCount: number; feasibleEvaluationCount: number; acceptedMoves: number;
        completedScaleLevels: number; budgetExhausted: boolean;
        positionEvidence: Array<{ id: string; basis: "visible-footprint-fixed" | "visible-center-contact-fixed" | "visible-center-contact-bounded" | "observed-bbox-center-bounded" | "low-confidence-bbox-center-bounded"; fixed: boolean; maxDeltaMeters: number }>;
      } | null;
      selectedInitializedIds: string[];
      selectedAfterCarryIds: string[];
      returnedByFitIds: string[];
    };
    postTransformSafety?: {
      newMajorOverlapPairs: Array<{ firstId: string; secondId: string; classification: "hard" | "review" | "allowed"; reason: string; penetrationMeters: number }>;
      cameraInsideComponentIds: string[];
      alignmentRejected: boolean;
    };
    collisionPairs?: Array<{ firstId: string; secondId: string; classification: "hard" | "review" | "allowed"; reason: string }>;
    physicalValidity?: {
      withinRoom: boolean;
      roomBoundsEvaluated?: boolean;
      cameraOutsideGeometry: boolean;
      cameraGeometryEvaluated?: boolean;
      hardCollisionCount: number;
      initialPenetrationMeters?: number;
      finalPenetrationMeters?: number;
      initialCollisionCounts?: { totalCandidates: number; hard: number; review: number; allowed: number };
      finalCollisionCounts?: { totalCandidates: number; hard: number; review: number; allowed: number };
      roomBoundaryViolations?: Array<{ componentId: string; edge: "left" | "right" | "front" | "back"; overflowMeters: number }>;
    };
    rejectionReason: "insufficient-evidence" | "no-safe-candidate" | "insufficient-improvement" | "error-too-high" | "unsafe-collision" | null;
  };
}

export interface DirectorObjectMotionKeyframe {
  id: string;
  time: number;
  transform: DirectorTransform;
  /** Character action played from this route point until the next point. */
  actionPresetId?: string | null;
  /** Path-facing turns toward the next route point; manual keeps the point rotation. */
  facingMode?: "path" | "manual";
  /** Pass-through keeps moving; hold pauses at this point for holdSeconds. */
  pointBehavior?: DirectorRoutePointBehavior;
  holdSeconds?: number;
  /** Character pose/action used while this point is holding. */
  holdAction?: DirectorRouteHoldAction;
  holdActionPresetId?: string | null;
}

export interface DirectorObjectMotionPath {
  interpolation: CameraMotionInterpolation;
  speedMode?: DirectorRouteSpeedMode;
  customEasing?: DirectorRouteCubicBezier;
  keyframes: DirectorObjectMotionKeyframe[];
}

export interface DirectorCameraCapture {
  id: string;
  index: number;
  name: string;
  dataUrl: string;
  /** Camera values captured at the same render moment as dataUrl. */
  metadata?: DirectorCameraCaptureMetadata;
}

/** Versioned, bounded camera data that can travel with a returned screenshot. */
export interface DirectorCameraCaptureMetadata {
  metadataVersion?: 1;
  mode: "director" | "camera";
  cameraId: string | null;
  cameraName?: string;
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
  aspectRatio?: string;
  /** Actual render direction, useful when target tracking resolves at runtime. */
  viewDirection?: [number, number, number];
  targetMode?: "manual" | "object";
  targetObjectId?: string | null;
}

export type CameraMotionInterpolation = "linear" | "smooth";
export type CameraMotionEasing = "linear" | "ease-in-out";
export type DirectorRouteSpeedMode = "uniform" | "soft" | "custom";
export type DirectorRoutePointBehavior = "pass" | "hold";
export type DirectorRouteHoldAction = "stand" | "current" | "custom";
export type DirectorRouteCubicBezier = [number, number, number, number];

export interface DirectorCameraMotionKeyframe {
  id: string;
  time: number;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  /** Each waypoint may independently aim at a moving scene subject. */
  targetMode?: "manual" | "object";
  targetObjectId?: string | null;
  /** Semantic animated body part used when the target is a character. */
  targetBodyPart?: DirectorCameraTargetBodyPart;
  /** Immediate follows exactly; smooth applies temporal damping in each render view. */
  targetFollowMode?: DirectorCameraTargetFollowMode;
  /** Suppresses high-frequency body animation shake while retaining subject movement. */
  targetStabilizationEnabled?: boolean;
  /** Pass-through keeps moving; hold pauses at this point for holdSeconds. */
  pointBehavior?: DirectorRoutePointBehavior;
  holdSeconds?: number;
}

export interface DirectorCameraMotionPath {
  duration: number;
  loop: boolean;
  interpolation: CameraMotionInterpolation;
  easing: CameraMotionEasing;
  speedMode?: DirectorRouteSpeedMode;
  customEasing?: DirectorRouteCubicBezier;
  keyframes: DirectorCameraMotionKeyframe[];
}

export interface DirectorCameraShot {
  id: string;
  name: string;
  /** Internal camera created for the beginner motion workflow. It has no scene helper object. */
  isVirtual?: boolean;
  fov: number;
  transform: DirectorTransform;
  targetMode: "manual" | "object";
  targetObjectId?: string | null;
  target: [number, number, number];
  lastCaptureUrl?: string | null;
  captures?: DirectorCameraCapture[];
  motionPath?: DirectorCameraMotionPath;
}

export interface DirectorProject {
  version: 1;
  scene: SceneSettings;
  assets: DirectorAssetRef[];
  animationAssets?: DirectorAnimationAssetRef[];
  objects: DirectorObject[];
  cameras: DirectorCameraShot[];
  activeCameraId: string | null;
  panoramaAssetId: string | null;
  layoutBatches?: DirectorLayoutBatch[];
}
