
export enum NodeType {
  TEXT_TO_IMAGE = 'TEXT_TO_IMAGE',
  TEXT_TO_VIDEO = 'TEXT_TO_VIDEO',
  TEXT_TO_AUDIO = 'TEXT_TO_AUDIO',
  IMAGE_TO_IMAGE = 'IMAGE_TO_IMAGE',
  IMAGE_TO_VIDEO = 'IMAGE_TO_VIDEO',
  START_END_TO_VIDEO = 'START_END_TO_VIDEO',
  CREATIVE_DESC = 'CREATIVE_DESC',
  ORIGINAL_IMAGE = 'ORIGINAL_IMAGE',
  DIRECTOR_DESK = 'DIRECTOR_DESK',
}

export type VideoGenerationMode = 'text' | 'image' | 'start_end' | 'omni';

export type GenerationKind = 'image' | 'video' | 'audio' | 'text';

export type GenerationTaskStatus =
  | 'submitting'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'needs_check';

export interface GenerationInputSnapshot {
  nodeType: NodeType;
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: string;
  count?: number;
  videoMode?: VideoGenerationMode;
  inputImageCount?: number;
  inputMedia?: Array<Pick<InputMedia, 'id' | 'sourceNodeId' | 'type' | 'title'>>;
  voiceId?: string;
  voiceSpeed?: number;
  voicePitch?: number;
  voiceVolume?: number;
}

export interface GenerationTaskState {
  operationId: string;
  kind: GenerationKind;
  status: GenerationTaskStatus;
  provider?: string;
  providerTaskIds?: string[];
  providerStatus?: string;
  progress?: number;
  providerTaskStatuses?: Record<string, string>;
  providerTaskProgress?: Record<string, number>;
  inputSnapshot: GenerationInputSnapshot;
  startedAt: number;
  updatedAt: number;
  errorMessage?: string;
  errorDetail?: string;
}

export type ArtifactSource = 'provider' | 'mock' | 'local' | 'unknown';

export type InputMediaType = 'image' | 'video' | 'audio' | 'text';

export interface VideoPromptReference {
  id: string;
  sourceNodeId: string;
  type: Exclude<InputMediaType, 'text'>;
  url: string;
  title?: string;
  // Character offset in the plain prompt. Used to render the media chip inline.
  offset?: number;
}

export interface VideoEditAnchor {
  id: string;
  timeSeconds: number;
  timecode: string;
  estimatedFrame: number;
  originalFrameDataUrl: string;
  maskDataUrl: string;
  annotatedFrameDataUrl: string;
}

export interface VideoEditRequest {
  sourceVideoUrl: string;
  prompt: string;
  scope: 'track_same_subject_full_clip';
  anchors: VideoEditAnchor[];
}

export interface ImageVersionSnapshot {
  url: string;
  prompt: string;
  model: string;
  aspectRatio: string;
  resolution: string;
  count: number;
  promptOptimize: boolean;
  createdAt: number;
  batchId?: string;
  batchUrls?: string[];
  batchIndex?: number;
}

export interface TextVersionSnapshot {
  content: string;
  prompt: string;
  model: string;
  title: string;
  source: 'generate' | 'media_analysis' | 'script_analysis' | 'upload';
  createdAt: number;
}

export interface NodeData {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  
  // State
  prompt?: string;
  imageSrc?: string; // Result or Input (Active Selection)
  videoSrc?: string; // Result (Active Selection)
  audioSrc?: string; // Result (Active Selection)
  directorDeskInstanceId?: string; // Scoped 3D director desk scene id
  directorDeskLastCaptureUrl?: string; // Latest capture returned from the embedded director desk
  directorDeskCaptureMetadata?: DirectorDeskCaptureMetadata; // Camera snapshot recorded with a director desk capture
  outputArtifacts?: string[]; // History/Batch results
  imageVersions?: ImageVersionSnapshot[]; // Image history with generation parameters
  textVersions?: TextVersionSnapshot[]; // Text history with generation/upload metadata
  artifactSources?: Record<string, ArtifactSource>; // Source marker for generated/uploaded outputs
  resultSource?: ArtifactSource; // Source marker for the currently selected output
  generationTask?: GenerationTaskState; // Local task state for refresh/recovery of async generation
  favoriteArtifacts?: string[]; // User-favorited node materials
  isLoading?: boolean;
  errorMessage?: string;
  isStackOpen?: boolean; // UI State for expanded gallery
  auditStatus?: 'auditing' | 'passed' | 'failed'; // Seedance 2.0 compliance audit status
  auditFailureReason?: string; // Short user-facing reason shown beside the node
  auditErrorDetail?: string; // Full provider error retained for support/debug copy
  editBadges?: string[]; // Secondary edit status badges stacked on derived nodes
  editRootNodeId?: string; // Original source node for retrying failed secondary edits
  editParentNodeId?: string; // Immediate parent node that spawned this edit
  
  // Configs
  aspectRatio?: string;
  resolution?: string;
  duration?: string; // Video duration (5s, 10s, 15s)
  count?: number;
  model?: string;
  promptOptimize?: boolean; // Prompt Extension/Optimization switch
  swapFrames?: boolean; // For START_END_TO_VIDEO: swap first/last frame order
  videoMode?: VideoGenerationMode;
  // Undefined keeps legacy nodes using all eligible connected media. Once the
  // user edits @ references, this becomes an explicit ordered selection.
  videoPromptReferences?: VideoPromptReference[];
  voiceId?: string;
  voiceSpeed?: number;
  voicePitch?: number;
  voiceVolume?: number;
  
  // Creative Desc specific
  textContent?: string;
  optimizedPrompt?: string;

  // Project / linear shot context. These fields are optional so existing nodes
  // keep working unchanged; video nodes can carry shot data when imported from the linear pipeline.
  projectId?: string;
  canvasId?: string;
  directorGroupName?: string;
  source?: 'canvas' | 'linear_pipeline' | 'asset_library' | 'material_library' | 'local_upload';
  sourceRefId?: string;
  shotId?: string;
  episodeNo?: number;
  sceneNo?: number;
  shotNo?: number;
  shotName?: string;
  shotDescription?: string;
  linearPageUrl?: string;
  creditEstimate?: number;
  creditStatus?: 'idle' | 'estimated' | 'reserved' | 'confirmed' | 'failed' | 'refunded';

  // Camera movement preset for video generation
  cameraMovement?: string;

  // UI State
  activeToolbarItem?: string;
}

/**
 * A semantic canvas group. Member nodes deliberately keep their world
 * coordinates so existing links, minimap, and node tools need no translation.
 */
export interface NodeGroup {
  id: string;
  title: string;
  memberIds: string[];
  layout: 'manual' | 'grid';
  /** Visual treatment for the group container. Old canvases use the default. */
  backgroundColor?: GroupBackgroundColor;
  createdAt: number;
}

export type GroupBackgroundColor = 'default' | 'gray' | 'blue' | 'teal' | 'yellow' | 'orange' | 'red' | 'pink';

export interface DirectorDeskCaptureMetadata {
  metadataVersion: 1;
  mode: 'director' | 'camera';
  cameraId: string | null;
  cameraName?: string;
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
  aspectRatio?: string;
  viewDirection?: [number, number, number];
  targetMode?: 'manual' | 'object';
  targetObjectId?: string | null;
}

export interface PromptTemplate {
  id: string;
  category: string;
  title: string;
  prompt: string;
}

export interface CameraMovementPreset {
  key: string;
  label: string;
  description: string;
  icon: string;
}

export type AssetLibraryType = 'role' | 'scene' | 'prop';
export type AssetLibraryScope = 'project' | 'public';

export interface AssetLibraryItem {
  id: string;
  type: AssetLibraryType;
  scope?: AssetLibraryScope;
  name: string;
  version: string;
  updatedAt: string;
  previewUrl: string;
  description: string;
  parentId?: string;  // parent asset for hierarchy
  voiceTimbre?: string; // voice timbre for role assets
  episodeNo?: number;
  sceneNo?: number;
  shotNo?: number;
}

export interface MultiAngleOptions {
  angles: string[];
  prompt?: string;
  consistency?: 'standard' | 'high';
  background?: 'keep' | 'clean' | 'solid';
  aspectRatio?: string;
  countPerAngle?: number;
  yaw?: number;
  pitch?: number;
  zoom?: 'wide' | 'medium' | 'close';
  preset?: string;
  targetMode?: 'scene' | 'subject';
}

export interface MultiAngleResult {
  angle: string;
  label: string;
  url: string;
  prompt?: string;
}

export interface InputMedia {
  id?: string;
  sourceNodeId?: string;
  type: InputMediaType;
  url: string;
  text?: string;
  title?: string;
}

export interface MaterialLibraryItem {
  id: string;
  nodeId?: string;
  url: string;
  type: 'image' | 'video' | 'text';
  title: string;
  text?: string;
  isFavorite?: boolean;
}

export interface ShotClip {
  id: string;
  episodeNo: number;
  sceneNo: number;
  shotNo: number;
  shotName: string;
  videoUrl: string;
  prompt?: string;
  keyframeUrls: string[];
  audioUrl?: string;
  description?: string;
}

export type AddToAssetType = 'role' | 'scene' | 'prop' | 'shot_clip';

export interface AddToAssetPanelState {
  isOpen: boolean;
  nodeId: string;
  nodeType: 'image' | 'video';
  imageSrc?: string;
  videoSrc?: string;
  title?: string;
}

export interface Connection {
  id: string;
  sourceId: string;
  targetId: string;
  canvasId?: string;
}

export interface CanvasTransform {
  x: number;
  y: number;
  k: number; // Scale
}

export type DragMode = 'NONE' | 'PAN' | 'DRAG_NODE' | 'DRAG_GROUP' | 'SELECT' | 'CONNECT' | 'RESIZE_NODE';

export interface Point {
  x: number;
  y: number;
}

export type CanvasPermissionRole = 'owner' | 'editor' | 'viewer';

export interface ProjectCanvasItem {
  id: string;
  projectId: string;
  name: string;
  owner: string;
  permissionRole: CanvasPermissionRole;
  status: 'active' | 'draft' | 'archived';
  nodeCount: number;
  assetCount: number;
  lastSavedAt: string;
  createdAt: string;
  entrySource?: 'canvas_space' | 'linear_workflow';
}

export interface CanvasPermission {
  id: string;
  canvasId: string;
  userName: string;
  role: CanvasPermissionRole;
  updatedAt: string;
}
