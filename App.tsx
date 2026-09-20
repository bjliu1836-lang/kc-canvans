
import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import Sidebar from './components/Sidebar';
import { AssetSelectionModal } from './components/AssetSelectionModal';
import { AssetLibraryItem, AssetLibraryType, AddToAssetPanelState, ArtifactSource, DirectorDeskCaptureMetadata, GenerationInputSnapshot, GenerationKind, GenerationTaskState, GenerationTaskStatus, ImageVersionSnapshot, InputMedia, MultiAngleOptions, NodeData, NodeGroup, Connection, CanvasTransform, Point, DragMode, NodeType, ProjectCanvasItem, ShotClip, TextVersionSnapshot, VideoEditRequest } from './types';
import BaseNode from './components/Nodes/BaseNode';
import { NodeContent } from './components/Nodes/NodeContent';
import { Icons } from './components/Icons';
import { analyzeConnectedMedia, analyzeScriptAssets, generateAudioWithMetadata, generateCreativeDescription, generateImageWithMetadata, generateVideo, generateMultiAngleImages, resumeVideoTask, type VideoTaskStatusUpdate } from './services/geminiService';
import { storageService } from './services/storageService';
import { ThemeSwitcher } from './components/ThemeSwitcher';
import { StorageModal } from './components/Settings/StorageModal';
import { ExportImportModal } from './components/Settings/ExportImportModal';
import { WelcomeModal, hasShownWelcome } from './components/Settings/WelcomeModal';
import { CropModal } from './components/CropModal';
import { VideoFrameExtractPanel } from './components/VideoFrameExtractPanel';
import { VideoEditPanel } from './components/VideoEditPanel';
import { LoginScreen } from './components/LoginScreen';
import { authService } from './services/authService';
import { getVideoModelCapability, inferVideoMode, resolveVideoMode } from './services/mode/video/capabilities';
import { getErrorDetail } from './services/errorUtils';

const DEFAULT_NODE_WIDTH = 320;
const DEFAULT_NODE_HEIGHT = 240; 
const EMPTY_ARRAY: string[] = [];
const IMAGE_NODE_BASE_SIZE = 400;
const VIDEO_NODE_BASE_HEIGHT = 400;
const CANVAS_MIN_SCALE = 0.4;
const CANVAS_MAX_SCALE = 2;
const IMAGE_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'];
const VIDEO_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9', '9:21'];
const DIRECTOR_DESK_APP_PATH = '/director-desk/';
type LocalExportType = 'video' | 'image' | 'text' | 'audio' | 'all';
type DirectorDeskSession = {
    nodeId: string;
    instanceId: string;
    title: string;
};
type DirectorDeskCapture = {
    dataUrl?: unknown;
    fileName?: unknown;
    metadata?: unknown;
    meta?: unknown;
    prompt?: unknown;
};

const DIRECTOR_DESK_CAPTURE_METADATA_VERSION = 1 as const;
const DIRECTOR_DESK_CAPTURE_ASPECT_PATTERN = /^(?:auto|\d+(?:\.\d+)?:\d+(?:\.\d+)?)$/;

const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const normalizeFiniteTuple = (value: unknown): [number, number, number] | null => {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(item => typeof item === 'number' && Number.isFinite(item))) {
        return null;
    }
    return value as [number, number, number];
};

const normalizeDirectorDeskCaptureMetadata = (value: unknown): DirectorDeskCaptureMetadata | undefined => {
    if (!isRecord(value)) return undefined;
    const metadataVersion = value.metadataVersion ?? value.version;
    if (metadataVersion !== DIRECTOR_DESK_CAPTURE_METADATA_VERSION) return undefined;

    const mode = value.mode === 'director' || value.mode === 'camera' ? value.mode : null;
    const cameraId = value.cameraId === null || typeof value.cameraId === 'string' ? value.cameraId : null;
    const fov = typeof value.fov === 'number' && Number.isFinite(value.fov) && value.fov >= 10 && value.fov <= 120
        ? value.fov
        : null;
    const position = normalizeFiniteTuple(value.position);
    const target = normalizeFiniteTuple(value.target);
    if (!mode || fov === null || !position || !target) return undefined;

    const metadata: DirectorDeskCaptureMetadata = {
        metadataVersion: DIRECTOR_DESK_CAPTURE_METADATA_VERSION,
        mode,
        cameraId,
        fov,
        position: [...position],
        target: [...target],
    };
    if (typeof value.cameraName === 'string' && value.cameraName.trim()) {
        metadata.cameraName = value.cameraName.trim().slice(0, 120);
    }
    if (typeof value.aspectRatio === 'string' && DIRECTOR_DESK_CAPTURE_ASPECT_PATTERN.test(value.aspectRatio.trim())) {
        metadata.aspectRatio = value.aspectRatio.trim();
    }
    const viewDirection = normalizeFiniteTuple(value.viewDirection);
    if (viewDirection) metadata.viewDirection = [...viewDirection];
    if (value.targetMode === 'manual' || value.targetMode === 'object') {
        metadata.targetMode = value.targetMode;
    }
    if (value.targetObjectId === null || typeof value.targetObjectId === 'string') {
        metadata.targetObjectId = value.targetObjectId;
    }
    return metadata;
};

const formatDirectorDeskPromptNumber = (value: number) => Number(value.toFixed(1)).toString();

const buildDirectorDeskCapturePrompt = (metadata: DirectorDeskCaptureMetadata) => {
    const direction = metadata.viewDirection || [
        metadata.target[0] - metadata.position[0],
        metadata.target[1] - metadata.position[1],
        metadata.target[2] - metadata.position[2],
    ];
    const directionLength = Math.hypot(...direction);
    const orientation = directionLength > 0.000001
        ? {
            yaw: Math.atan2(direction[0], direction[2]) * 180 / Math.PI,
            pitch: Math.atan2(direction[1], Math.hypot(direction[0], direction[2])) * 180 / Math.PI,
        }
        : null;
    const parts = [
        '3D导演台镜头参考',
        metadata.aspectRatio && metadata.aspectRatio !== 'auto' ? `画幅 ${metadata.aspectRatio}` : null,
        `视野角 FOV ${formatDirectorDeskPromptNumber(metadata.fov)}°`,
        orientation
            ? `相机朝向：水平 ${formatDirectorDeskPromptNumber(orientation.yaw)}°，俯仰 ${formatDirectorDeskPromptNumber(orientation.pitch)}°`
            : null,
        '保持当前构图与主体关系',
    ].filter((part): part is string => Boolean(part));
    return `${parts.join('，')}。`;
};
type CanvasHistoryEntry =
    | { type: 'delete'; label: string; nodes: NodeData[]; connections: Connection[]; groups?: NodeGroup[] }
    | { type: 'create'; label: string; nodes: NodeData[]; connections: Connection[]; groups?: NodeGroup[] }
    | { type: 'upload-update'; label: string; beforeNodes: NodeData[] }
    | { type: 'group-update'; label: string; beforeNodes: NodeData[]; beforeGroups: NodeGroup[] };

type CanvasBounds = { x: number; y: number; width: number; height: number };

const GROUP_PADDING = { top: 56, right: 32, bottom: 32, left: 32 };

const getNodesBounds = (items: NodeData[]): CanvasBounds | null => {
    if (!items.length) return null;
    const minX = Math.min(...items.map(node => node.x));
    const minY = Math.min(...items.map(node => node.y));
    const maxX = Math.max(...items.map(node => node.x + node.width));
    const maxY = Math.max(...items.map(node => node.y + node.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

const getGroupBounds = (group: NodeGroup, allNodes: NodeData[]): CanvasBounds | null => {
    const contentBounds = getNodesBounds(allNodes.filter(node => group.memberIds.includes(node.id)));
    if (!contentBounds) return null;
    return {
        x: contentBounds.x - GROUP_PADDING.left,
        y: contentBounds.y - GROUP_PADDING.top,
        width: contentBounds.width + GROUP_PADDING.left + GROUP_PADDING.right,
        height: contentBounds.height + GROUP_PADDING.top + GROUP_PADDING.bottom,
    };
};

const normalizeNodeGroups = (candidateGroups: NodeGroup[], allNodes: NodeData[]) => {
    const existingIds = new Set(allNodes.map(node => node.id));
    const assigned = new Set<string>();
    return candidateGroups.reduce<NodeGroup[]>((result, group) => {
        const memberIds = Array.from(new Set(group.memberIds)).filter(id => existingIds.has(id) && !assigned.has(id));
        if (memberIds.length < 2) return result;
        memberIds.forEach(id => assigned.add(id));
        result.push({ ...group, title: group.title || '未命名分组', memberIds, layout: group.layout === 'grid' ? 'grid' : 'manual' });
        return result;
    }, []);
};

const createDemoAssetPreview = (label: string, accent: string, background: string) => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
        <defs>
          <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stop-color="${background}"/>
            <stop offset="100%" stop-color="#111827"/>
          </linearGradient>
        </defs>
        <rect width="640" height="480" fill="url(#bg)"/>
        <rect x="52" y="52" width="536" height="376" rx="36" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" stroke-width="2"/>
        <circle cx="320" cy="198" r="76" fill="${accent}" opacity="0.88"/>
        <rect x="186" y="298" width="268" height="48" rx="24" fill="rgba(255,255,255,0.14)"/>
        <text x="320" y="328" text-anchor="middle" fill="#f8fafc" font-size="28" font-family="Arial, sans-serif" font-weight="700">${label}</text>
      </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const DEMO_ASSET_LIBRARY: AssetLibraryItem[] = [
    {
        id: 'asset_role_001',
        type: 'role',
        scope: 'project',
        name: '王上近晨',
        version: '角色A01',
        updatedAt: '今天 10:24',
        previewUrl: createDemoAssetPreview('王上近晨', '#8F91F4', '#172554'),
        description: '主形象，短剧男主核心资产。',
        voiceTimbre: '音色A01',
    },
    {
        id: 'asset_role_001_child_01',
        type: 'role',
        scope: 'project',
        name: '常服',
        version: '角色A01',
        updatedAt: '今天 10:28',
        previewUrl: createDemoAssetPreview('常服', '#38bdf8', '#082f49'),
        description: '王上近晨常服子形象。',
        parentId: 'asset_role_001',
        voiceTimbre: '音色A01',
    },
    {
        id: 'asset_role_001_child_02',
        type: 'role',
        scope: 'project',
        name: '朝服',
        version: '角色A01',
        updatedAt: '今天 10:29',
        previewUrl: createDemoAssetPreview('朝服', '#f97316', '#431407'),
        description: '王上近晨朝服子形象。',
        parentId: 'asset_role_001',
        voiceTimbre: '音色A01',
    },
    {
        id: 'asset_role_001_child_03',
        type: 'role',
        scope: 'project',
        name: '战损',
        version: '角色A01',
        updatedAt: '今天 10:30',
        previewUrl: createDemoAssetPreview('战损', '#ef4444', '#450a0a'),
        description: '王上近晨战损子形象。',
        parentId: 'asset_role_001',
        voiceTimbre: '音色A01',
    },
    {
        id: 'asset_role_002',
        type: 'role',
        scope: 'project',
        name: '大唐公主',
        version: '角色A02',
        updatedAt: '昨天 18:10',
        previewUrl: createDemoAssetPreview('大唐公主', '#f472b6', '#4a044e'),
        description: '主形象，主要情绪线角色。',
        voiceTimbre: '音色A02',
    },
    {
        id: 'asset_role_003',
        type: 'role',
        scope: 'project',
        name: '御史中丞',
        version: '角色A03',
        updatedAt: '昨天 16:42',
        previewUrl: createDemoAssetPreview('御史中丞', '#a78bfa', '#2e1065'),
        description: '朝堂重臣主形象。',
        voiceTimbre: '音色A03',
    },
    {
        id: 'asset_role_004',
        type: 'role',
        scope: 'project',
        name: '禁军统领',
        version: '角色A04',
        updatedAt: '昨天 15:20',
        previewUrl: createDemoAssetPreview('禁军统领', '#94a3b8', '#111827'),
        description: '禁军统领主形象。',
        voiceTimbre: '音色A04',
    },
    {
        id: 'asset_scene_001',
        type: 'scene',
        scope: 'project',
        name: '废弃仓库',
        version: 'v2',
        updatedAt: '昨天 16:32',
        previewUrl: createDemoAssetPreview('场景 / 仓库', '#f59e0b', '#422006'),
        description: '大空间、冷色光、远处蓝色光源，适合悬疑段落。',
    },
    {
        id: 'asset_scene_002',
        type: 'scene',
        scope: 'project',
        name: '雨夜街口',
        version: 'v1',
        updatedAt: '05-30 21:08',
        previewUrl: createDemoAssetPreview('场景 / 街口', '#38bdf8', '#082f49'),
        description: '夜景、湿地反光、霓虹灯，适合追逐和对峙。',
    },
    {
        id: 'asset_prop_001',
        type: 'prop',
        scope: 'project',
        name: '蓝色芯片',
        version: 'v5',
        updatedAt: '今天 09:40',
        previewUrl: createDemoAssetPreview('道具 / 芯片', '#34d399', '#064e3b'),
        description: '核心线索道具，半透明蓝色发光材质。',
    },
];

const DEMO_PROJECT_META = {
    id: 'KC-DRAMA-001',
    name: '《隐秘回响》',
    directorGroup: 'A组导演组',
    lastSavedAt: '刚刚已保存',
};
type ProjectDashboardItem = {
    id: string;
    name: string;
    canvasName: string;
    directorGroup: string;
    projectType: string;
    status: 'active' | 'draft' | 'archived';
    episodeCount: number;
    shotCount: number;
    assetCount: number;
    lastSavedAt: string;
};

type CreditRow = {
    id: string;
    projectId: string;
    project: string;
    group: string;
    user: string;
    type: string;
    model: string;
    credit: number;
    status: NonNullable<NodeData['creditStatus']> | 'estimated';
    nodeTitle: string;
};

const USER_CREDIT_LIMIT = 1200;
const CURRENT_USER_NAME = '导演A';
const MOCK_AUDIT_IMAGE_MARKER = 'ce014d0c-34b4-4504-baeb-1f0833481cc4';
const MOCK_AUDIT_IMAGE_SHA256 = '98dc76d48476d11c6ec26dae0c45dc9bc09fe126c5489241105e7ffa447b9c26';
const MOCK_AUDIT_IMAGE_BYTES = 1142944;
const MOCK_AUDIT_REASON = '参考图片中的人物内容未通过平台安全审核，请调整或更换图片后重试';
const MOCK_AUDIT_ERROR_DETAIL = [
    'Seedance 2.0 content moderation rejected one of the submitted reference images before video task creation.',
    'The input asset did not pass the provider safety review and cannot be used for generation.',
    'Please replace or modify the affected image and submit the request again.',
    'moderation_code=InputImageSensitiveContent;',
    `asset=${MOCK_AUDIT_IMAGE_MARKER}.png;`,
    'request_stage=input_image_review;',
    'trace_id=mock-seedance-audit-001.',
].join(' ');

const getSha256 = async (value: ArrayBuffer) => {
    const digest = await crypto.subtle.digest('SHA-256', value);
    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
};

const isMockRejectedAuditImage = async (item: InputMedia, sourceNode?: NodeData) => {
    const searchable = `${item.url} ${item.title || ''} ${sourceNode?.title || ''}`.toLowerCase();
    if (searchable.includes(MOCK_AUDIT_IMAGE_MARKER)) return true;
    if (!item.url || !globalThis.crypto?.subtle) return false;

    try {
        const response = await fetch(item.url);
        if (!response.ok) return false;
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength !== MOCK_AUDIT_IMAGE_BYTES) return false;
        return (await getSha256(buffer)) === MOCK_AUDIT_IMAGE_SHA256;
    } catch (error) {
        console.warn('[Mock Seedance audit] Unable to inspect image bytes:', error);
        return false;
    }
};

const KC_PROJECT_STORAGE_PREFIX = 'KC_CANVAS_PROJECT_';
const KC_PROJECT_SUMMARIES_KEY = 'KC_CANVAS_PROJECT_SUMMARIES';
const KC_SUB_CANVAS_STORAGE_PREFIX = 'KC_CANVAS_SUB_CANVASES_';

type SubCanvasWorkspaceSnapshot = {
    canvases: ProjectCanvasItem[];
    activeId: string;
    states: Record<string, SubCanvasState>;
};

type SubCanvasState = {
    nodes: NodeData[];
    connections: Connection[];
    transform: CanvasTransform;
    groups: NodeGroup[];
};

const normalizeProjectSummary = (project: ProjectDashboardItem): ProjectDashboardItem => ({
    ...project,
    projectType: project.projectType || '短剧',
});

const DEFAULT_PROJECTS: ProjectDashboardItem[] = [
    {
        id: DEMO_PROJECT_META.id,
        name: DEMO_PROJECT_META.name,
        canvasName: `${DEMO_PROJECT_META.name} 无限画布`,
        directorGroup: DEMO_PROJECT_META.directorGroup,
        projectType: '短剧',
        status: 'active',
        episodeCount: 24,
        shotCount: 316,
        assetCount: 42,
        lastSavedAt: '未保存',
    },
    {
        id: 'KC-DRAMA-002',
        name: '《雾港来信》',
        canvasName: '《雾港来信》 无限画布',
        directorGroup: 'B组导演组',
        projectType: '短剧',
        status: 'draft',
        episodeCount: 18,
        shotCount: 208,
        assetCount: 31,
        lastSavedAt: '未保存',
    },
    {
        id: 'KC-DRAMA-003',
        name: '《逆光证人》',
        canvasName: '《逆光证人》 无限画布',
        directorGroup: 'C组导演组',
        projectType: '短剧',
        status: 'active',
        episodeCount: 30,
        shotCount: 452,
        assetCount: 57,
        lastSavedAt: '未保存',
    },
];

const DEMO_LINEAR_SHOT = {
    projectId: DEMO_PROJECT_META.id,
    directorGroupName: DEMO_PROJECT_META.directorGroup,
    shotId: 'shot_ep01_sc02_003',
    episodeNo: 1,
    sceneNo: 2,
    shotNo: 3,
    shotName: '第1集 第2场 分镜03',
    shotDescription: '男主推门进入废弃仓库，看到远处闪烁的蓝色光源，镜头从背后缓慢推近。',
    prompt: '废弃仓库内，男主推门进入，远处蓝色光源闪烁，低角度跟拍，悬疑短剧质感，冷色调，细节清晰，电影感灯光。',
    model: 'Seedance 2.0',
    aspectRatio: '16:9',
    resolution: '720p',
    duration: '5s',
    creditEstimate: 14,
    creditStatus: 'estimated' as const,
    linearPageUrl: '#linear-shot-demo',
};

// 节点媒体类别：正向/反向连接共用同一套合法性校验规则。
type MediaCategory = 'image' | 'video' | 'text';
type UploadKind = 'image' | 'video' | 'audio' | 'text';

const NODE_MEDIA_CATEGORY: Record<NodeType, MediaCategory> = {
    [NodeType.TEXT_TO_IMAGE]: 'image',
    [NodeType.IMAGE_TO_IMAGE]: 'image',
    [NodeType.ORIGINAL_IMAGE]: 'image',
    [NodeType.TEXT_TO_VIDEO]: 'video',
    [NodeType.IMAGE_TO_VIDEO]: 'video',
    [NodeType.START_END_TO_VIDEO]: 'video',
    [NodeType.CREATIVE_DESC]: 'text',
    [NodeType.TEXT_TO_AUDIO]: 'text',
    [NodeType.DIRECTOR_DESK]: 'image',
};

// 目标节点（下游）允许接收的来源节点（上游）类别：
// - 图片节点：可接图片、文字
// - 视频节点：可接图片、视频、音频/文字
// - 文字节点：可接图片、视频、文字
const ALLOWED_SOURCE_CATEGORIES: Record<MediaCategory, MediaCategory[]> = {
    image: ['image', 'text'],
    video: ['image', 'video', 'text'],
    text: ['image', 'video', 'text'],
};

const TEXT_FILE_PATTERN = /\.(txt|md|markdown)$/i;

const getUploadKindForNode = (type: NodeType): UploadKind => {
    if (type === NodeType.TEXT_TO_AUDIO) return 'audio';
    if (type === NodeType.CREATIVE_DESC) return 'text';
    return NODE_MEDIA_CATEGORY[type] === 'video' ? 'video' : 'image';
};

const UPLOAD_ACCEPT_BY_KIND: Record<UploadKind, string> = {
    image: '.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,image/*',
    video: '.mp4,.webm,.mov,.avi,.mkv,.flv,.wmv,video/*',
    audio: '.mp3,.wav,.ogg,.aac,.m4a,.flac,audio/*',
    text: '.txt,.md,.markdown,text/plain,text/markdown,text/*',
};

const UPLOAD_LABEL_BY_KIND: Record<UploadKind, string> = {
    image: '图片',
    video: '视频',
    audio: '音频',
    text: '文本',
};

const isFileCompatibleWithUploadKind = (file: File, kind: UploadKind) => {
    if (kind === 'image') return file.type.startsWith('image/');
    if (kind === 'video') return file.type.startsWith('video/');
    if (kind === 'audio') return file.type.startsWith('audio/');
    return file.type.startsWith('text/') || TEXT_FILE_PATTERN.test(file.name);
};

const getNodeSizeForAspectRatio = (aspectRatio = '1:1', baseSize = IMAGE_NODE_BASE_SIZE) => {
    const [wRaw, hRaw] = aspectRatio.split(':').map(Number);
    const wRatio = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : 1;
    const hRatio = Number.isFinite(hRaw) && hRaw > 0 ? hRaw : 1;
    const ratio = wRatio / hRatio;

    if (ratio >= 1) {
        return { width: Math.round(baseSize * ratio), height: baseSize };
    }

    return { width: baseSize, height: Math.round(baseSize / ratio) };
};

const getClosestAspectRatio = (width: number, height: number, options = IMAGE_ASPECT_RATIOS) => {
    const sourceRatio = width / height;
    return options.reduce((best, candidate) => {
        const [w, h] = candidate.split(':').map(Number);
        const [bestW, bestH] = best.split(':').map(Number);
        return Math.abs(w / h - sourceRatio) < Math.abs(bestW / bestH - sourceRatio) ? candidate : best;
    }, options[0]);
};

const getImageSizeFromDataUrl = (src: string): Promise<{ width: number; height: number }> => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || img.width || 1, height: img.naturalHeight || img.height || 1 });
    img.onerror = () => resolve({ width: 1, height: 1 });
    img.src = src;
});

const mergeArtifactVersions = (newArtifacts: string | string[], currentArtifact?: string, existingArtifacts: string[] = []) => {
    const ordered = [
        ...(Array.isArray(newArtifacts) ? newArtifacts : [newArtifacts]),
        currentArtifact,
        ...existingArtifacts,
    ];
    const seen = new Set<string>();
    return ordered.filter((item): item is string => {
        if (!item || seen.has(item)) return false;
        seen.add(item);
        return true;
    });
};

const createImageVersionSnapshot = (
    url: string,
    node: Pick<NodeData, 'prompt' | 'model' | 'aspectRatio' | 'resolution' | 'count' | 'promptOptimize'>,
    createdAt = Date.now(),
    batch?: Pick<ImageVersionSnapshot, 'batchId' | 'batchUrls' | 'batchIndex'>
): ImageVersionSnapshot => ({
    url,
    prompt: node.prompt || '',
    model: node.model || 'Seedream 5.0',
    aspectRatio: node.aspectRatio || '1:1',
    resolution: node.resolution || '1k',
    count: node.count || 1,
    promptOptimize: !!node.promptOptimize,
    createdAt,
    ...batch,
});

const mergeImageVersionSnapshots = (
    urls: string[],
    generatedVersions: ImageVersionSnapshot[],
    existingVersions: ImageVersionSnapshot[] = [],
    fallbackNode: NodeData
) => {
    const versionByUrl = new Map<string, ImageVersionSnapshot>();
    [...generatedVersions, ...existingVersions].forEach(version => {
        if (!versionByUrl.has(version.url)) versionByUrl.set(version.url, version);
    });
    return urls.map(url => versionByUrl.get(url) || createImageVersionSnapshot(url, fallbackNode, 0));
};

const createTextVersionSnapshot = (
    content: string,
    node: Pick<NodeData, 'prompt' | 'model' | 'title'>,
    source: TextVersionSnapshot['source'],
    createdAt = Date.now()
): TextVersionSnapshot => ({
    content,
    prompt: node.prompt || '',
    model: node.model || 'Xiaomi MiMo 2.5 Pro',
    title: node.title || 'Text',
    source,
    createdAt,
});

const mergeTextVersionSnapshots = (
    newVersion: TextVersionSnapshot,
    existingVersions: TextVersionSnapshot[] = []
) => {
    const seen = new Set<string>();
    return [newVersion, ...existingVersions].filter(version => {
        const key = version.content.trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 50);
};

const normalizeTextNodeContent = (node: NodeData): NodeData => {
    if (node.type !== NodeType.CREATIVE_DESC || node.textContent !== undefined) return node;
    return { ...node, textContent: node.optimizedPrompt ?? node.prompt ?? '' };
};

const getTextNodeOutput = (node: NodeData): string => {
    if (node.type === NodeType.CREATIVE_DESC) return node.textContent || node.optimizedPrompt || '';
    return node.optimizedPrompt || node.prompt || '';
};

type GenerationScope = {
    projectId: string;
    canvasId: string;
    nodeId: string;
    operationId: string;
};

const RECOVERABLE_GENERATION_STATUSES: GenerationTaskStatus[] = ['submitting', 'queued', 'running', 'timed_out'];

const generationScopeKey = (scope: Pick<GenerationScope, 'projectId' | 'canvasId' | 'nodeId' | 'operationId'>) =>
    `${scope.projectId}:${scope.canvasId}:${scope.nodeId}:${scope.operationId}`;

const generationTargetKey = (scope: Pick<GenerationScope, 'projectId' | 'canvasId' | 'nodeId'>) =>
    `${scope.projectId}:${scope.canvasId}:${scope.nodeId}`;

const getGenerationKind = (node: NodeData): GenerationKind => {
    if (node.type === NodeType.TEXT_TO_IMAGE) return 'image';
    if (node.type === NodeType.TEXT_TO_AUDIO) return 'audio';
    if (node.type === NodeType.CREATIVE_DESC) return 'text';
    return 'video';
};

const createGenerationOperationId = () => `op_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const getChineseGenerationError = (error: unknown, hasProviderTaskId = false): string => {
    const detail = getErrorDetail(error).toLowerCase();
    if (detail.includes('mimo_api_key') || detail.includes('api key') || detail.includes('api_key')) return '未配置模型服务，暂时无法生成';
    if (detail.includes('video_api_not_configured')) return '未配置视频模型服务，暂时无法生成';
    if (detail.includes('media_upload') || detail.includes('not public url') || detail.includes('公网图片')) return '输入素材暂不可访问，请检查素材链接';
    if (detail.includes('timeout') || detail.includes('timed out')) {
        return hasProviderTaskId ? '生成查询超时，刷新后可继续查询' : '提交超时，未拿到任务编号，请核对后再生成';
    }
    if (detail.includes('task_failed') || detail.includes('generation failed')) return '供应商生成失败，请查看原始报错';
    if (detail.includes('no_') || detail.includes('empty_response') || detail.includes('未返回结果')) return '模型未返回结果，请查看原始报错';
    return '生成失败，请查看原始报错';
};

const toGenerationInputSnapshot = (
    node: NodeData,
    inputImages: string[],
    inputMedia: InputMedia[],
    videoMode?: NodeData['videoMode'],
): GenerationInputSnapshot => ({
    nodeType: node.type,
    prompt: node.prompt || '',
    model: node.model,
    aspectRatio: node.aspectRatio,
    resolution: node.resolution,
    duration: node.duration,
    count: node.count || 1,
    videoMode,
    inputImageCount: inputImages.filter(Boolean).length,
    // Keep only references and labels. Local/blob/base64 media stay in the canvas snapshot,
    // while the recovery record remains small enough for localStorage.
    inputMedia: inputMedia.map(item => ({
        id: item.id,
        sourceNodeId: item.sourceNodeId,
        type: item.type,
        title: item.title,
    })),
    voiceId: node.voiceId,
    voiceSpeed: node.voiceSpeed,
    voicePitch: node.voicePitch,
    voiceVolume: node.voiceVolume,
});

// Helper for resizing imported media constraints
const calculateImportDimensions = (naturalWidth: number, naturalHeight: number) => {
    const ratio = naturalWidth / naturalHeight;
    const maxSide = 750;
    let width = naturalWidth;
    let height = naturalHeight;

    if (width > height) {
        if (width > maxSide) {
            width = maxSide;
            height = width / ratio;
        }
    } else {
        if (height > maxSide) {
            height = maxSide;
            width = height * ratio;
        }
    }
    return { width, height, ratio };
};

const App: React.FC = () => {
  return (
      <CanvasWithSidebar />
  );
};

const CanvasWithSidebar: React.FC = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [projects, setProjects] = useState<ProjectDashboardItem[]>(() => {
      if (typeof window === 'undefined') return DEFAULT_PROJECTS;
      try {
          const saved = localStorage.getItem(KC_PROJECT_SUMMARIES_KEY);
          if (!saved) return DEFAULT_PROJECTS.map(normalizeProjectSummary);
          const parsed = JSON.parse(saved) as ProjectDashboardItem[];
          const merged = new Map(DEFAULT_PROJECTS.map(project => [project.id, project]));
          parsed.forEach(project => merged.set(project.id, { ...(merged.get(project.id) || project), ...project }));
          return Array.from(merged.values()).map(normalizeProjectSummary);
      } catch {
          return DEFAULT_PROJECTS.map(normalizeProjectSummary);
      }
  });
  const [currentProject, setCurrentProject] = useState<ProjectDashboardItem | null>(null);
  const [subCanvases, setSubCanvases] = useState<ProjectCanvasItem[]>([]);
  const [activeSubCanvasId, setActiveSubCanvasId] = useState<string>('');
  const [editingSubCanvasId, setEditingSubCanvasId] = useState<string | null>(null);
  const [editingSubCanvasName, setEditingSubCanvasName] = useState('');
  const [isSubCanvasListOpen, setIsSubCanvasListOpen] = useState(false);
  const [showSubCanvasNameDialog, setShowSubCanvasNameDialog] = useState(false);
  const [pendingSubCanvasName, setPendingSubCanvasName] = useState('');
  const [nodes, setNodes] = useState<NodeData[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [groups, setGroups] = useState<NodeGroup[]>([]);
  const [transform, setTransform] = useState<CanvasTransform>({ x: 0, y: 0, k: 1 });
  const nodesRef = useRef<NodeData[]>(nodes);
  const workspaceRef = useRef<{ projectId: string | null; canvasId: string }>({ projectId: currentProject?.id || null, canvasId: activeSubCanvasId });
  const generationBindingByNodeRef = useRef<Map<string, GenerationScope>>(new Map());
  const generationNodeLocksRef = useRef<Set<string>>(new Set());
  const activeGenerationKeysRef = useRef<Set<string>>(new Set());
  const recoveryStartedKeysRef = useRef<Set<string>>(new Set());
  const invalidatedGenerationKeysRef = useRef<Set<string>>(new Set());
  const sessionStartedAtRef = useRef(Date.now());
  nodesRef.current = nodes;
  workspaceRef.current = { projectId: currentProject?.id || null, canvasId: activeSubCanvasId };
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const selectedNodeBounds = useMemo(
      () => getNodesBounds(nodes.filter(node => selectedNodeIds.has(node.id))),
      [nodes, selectedNodeIds],
  );
  const groupBoundsById = useMemo(() => new Map(
      groups.map(group => [group.id, getGroupBounds(group, nodes)] as const).filter((entry): entry is readonly [string, CanvasBounds] => Boolean(entry[1])),
  ), [groups, nodes]);
  const selectedGroup = groups.find(group => group.id === selectedGroupId) || null;
  const [dragMode, setDragMode] = useState<DragMode | 'RESIZE_NODE' | 'SELECT'>('NONE');
  const dragModeRef = useRef(dragMode);
  const blockedSubCanvasStorageKeysRef = useRef<Set<string>>(new Set());
  const canvasHistoryRef = useRef<CanvasHistoryEntry[]>([]);
  const [canvasHistoryCount, setCanvasHistoryCount] = useState(0);

  const clearCanvasHistory = useCallback(() => {
      canvasHistoryRef.current = [];
      setCanvasHistoryCount(0);
  }, []);

  const getEmptySubCanvasState = (): SubCanvasState => ({
      nodes: [],
      connections: [],
      transform: { x: 0, y: 0, k: 1 },
      groups: [],
  });

  const loadSubCanvasState = (state?: Partial<SubCanvasState>) => {
      const fallback = getEmptySubCanvasState();
      clearCanvasHistory();
      const nextNodes = Array.isArray(state?.nodes) ? state.nodes.map(normalizeTextNodeContent) : fallback.nodes;
      setNodes(nextNodes);
      setConnections(Array.isArray(state?.connections) ? state.connections : fallback.connections);
      setTransform(state?.transform || fallback.transform);
      setGroups(normalizeNodeGroups(Array.isArray(state?.groups) ? state.groups : [], nextNodes));
      setSelectedNodeIds(new Set());
      setSelectedGroupId(null);
      setEditingGroupId(null);
      setSelectedConnectionId(null);
      setSelectionBox(null);
      setContextMenu(null);
      setQuickAddMenu(null);
  };

  const getSubCanvasStorageKey = (projectId: string) => `${KC_SUB_CANVAS_STORAGE_PREFIX}${projectId}`;

  const createDefaultSubCanvas = (projectId: string, nodeCount = 0): ProjectCanvasItem => ({
      id: 'canvas-001',
      projectId,
      name: '主画布',
      owner: '我',
      permissionRole: 'owner',
      status: 'active',
      nodeCount,
      assetCount: 0,
      lastSavedAt: '刚刚',
      createdAt: new Date().toISOString().split('T')[0],
  });

  const readSubCanvasWorkspace = (projectId: string): SubCanvasWorkspaceSnapshot | null => {
      if (typeof window === 'undefined') return null;
      try {
          const saved = localStorage.getItem(getSubCanvasStorageKey(projectId));
          if (!saved) return null;
          const parsed = JSON.parse(saved) as SubCanvasWorkspaceSnapshot;
          if (!Array.isArray(parsed.canvases) || parsed.canvases.length === 0) return null;
          return {
              canvases: parsed.canvases,
              activeId: parsed.activeId || parsed.canvases[0].id,
              states: parsed.states || {},
          };
      } catch {
          return null;
      }
  };

  const writeSubCanvasWorkspace = (projectId: string, snapshot: SubCanvasWorkspaceSnapshot) => {
      if (typeof window === 'undefined') return false;
      const storageKey = getSubCanvasStorageKey(projectId);
      if (blockedSubCanvasStorageKeysRef.current.has(storageKey)) return false;
      try {
          localStorage.setItem(storageKey, JSON.stringify(snapshot));
          return true;
      } catch (error) {
          console.error(error);
          blockedSubCanvasStorageKeysRef.current.add(storageKey);
          setSaveStatus('failed');
          return false;
      }
  };

  const getCurrentSubCanvasWorkspace = (nextOverrides: Partial<SubCanvasWorkspaceSnapshot> = {}): SubCanvasWorkspaceSnapshot | null => {
      if (!currentProject || !activeSubCanvasId) return null;
      const previous = readSubCanvasWorkspace(currentProject.id);
      const currentStates = previous?.states || {};
      const canvases = nextOverrides.canvases || subCanvases;
      const activeId = nextOverrides.activeId || activeSubCanvasId;
      const states = {
          ...currentStates,
           [activeSubCanvasId]: {
               nodes,
               connections,
               transform,
               groups,
           },
          ...(nextOverrides.states || {}),
      };
      return { canvases, activeId, states };
  };

  const persistCurrentSubCanvasWorkspace = (overrides: Partial<SubCanvasWorkspaceSnapshot> = {}) => {
      if (!currentProject) return;
      const snapshot = getCurrentSubCanvasWorkspace(overrides);
      if (snapshot) writeSubCanvasWorkspace(currentProject.id, snapshot);
  };

  const persistScopedGenerationNodes = (scope: GenerationScope, nextNodes: NodeData[]) => {
      if (workspaceRef.current.projectId !== scope.projectId || workspaceRef.current.canvasId !== scope.canvasId) return;
      const previous = readSubCanvasWorkspace(scope.projectId);
      const baseCanvases = previous?.canvases || subCanvases;
      const nextCanvases = baseCanvases.map(canvas => canvas.id === scope.canvasId
          ? { ...canvas, nodeCount: nextNodes.length, lastSavedAt: '刚刚' }
          : canvas
      );
      writeSubCanvasWorkspace(scope.projectId, {
          canvases: nextCanvases,
          activeId: previous?.activeId || scope.canvasId,
          states: {
              ...(previous?.states || {}),
              [scope.canvasId]: { nodes: nextNodes, connections, transform, groups },
          },
      });
  };

  // A callback may arrive after the user switched canvases. Keep task state in
  // the original canvas snapshot without writing into the newly visible canvas.
  // The operation id check also prevents an old callback from reviving a node
  // after the user deleted it or started a newer operation for that node.
  const persistGenerationTaskToSnapshot = (scope: GenerationScope, updates: Partial<GenerationTaskState>) => {
      const key = generationScopeKey(scope);
      if (invalidatedGenerationKeysRef.current.has(key)) return false;
      const previous = readSubCanvasWorkspace(scope.projectId);
      const scopedState = previous?.states?.[scope.canvasId];
      const target = scopedState?.nodes.find(node => node.id === scope.nodeId);
      if (!previous || !scopedState || !target?.generationTask || target.generationTask.operationId !== scope.operationId) return false;

      const nextTask: GenerationTaskState = {
          ...target.generationTask,
          ...updates,
          updatedAt: Date.now(),
      };
      const nextNodes = scopedState.nodes.map(node => node.id === scope.nodeId
          ? { ...node, generationTask: nextTask }
          : node
      );
      return writeSubCanvasWorkspace(scope.projectId, {
          ...previous,
          states: {
              ...previous.states,
              [scope.canvasId]: { ...scopedState, nodes: nextNodes },
          },
      });
  };

  const isGenerationScopeCurrent = (scope: GenerationScope) => {
      const key = generationScopeKey(scope);
      if (invalidatedGenerationKeysRef.current.has(key)) return false;
      if (workspaceRef.current.projectId !== scope.projectId || workspaceRef.current.canvasId !== scope.canvasId) return false;
      const target = nodesRef.current.find(node => node.id === scope.nodeId);
      return target?.generationTask?.operationId === scope.operationId;
  };

  const updateGenerationNode = (scope: GenerationScope, updates: Partial<NodeData>) => {
      if (!isGenerationScopeCurrent(scope)) return false;
      const nextNodes = nodesRef.current.map(node => node.id === scope.nodeId ? { ...node, ...updates } : node);
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
      persistScopedGenerationNodes(scope, nextNodes);
      return true;
  };

  const invalidateGenerationForNode = (nodeId: string) => {
      const bindingKey = generationTargetKey({
          projectId: workspaceRef.current.projectId || '',
          canvasId: workspaceRef.current.canvasId,
          nodeId,
      });
      const binding = generationBindingByNodeRef.current.get(bindingKey);
      if (!binding) return;
      invalidatedGenerationKeysRef.current.add(generationScopeKey(binding));
      activeGenerationKeysRef.current.delete(generationScopeKey(binding));
      generationNodeLocksRef.current.delete(bindingKey);
      generationBindingByNodeRef.current.delete(bindingKey);
  };

  useEffect(() => {
    if (!currentProject) {
      setSubCanvases([]);
      setActiveSubCanvasId('');
      return;
    }

    const saved = readSubCanvasWorkspace(currentProject.id);
    if (saved) {
      const activeId = saved.canvases.some(canvas => canvas.id === saved.activeId) ? saved.activeId : saved.canvases[0].id;
      const activeState = saved.states[activeId];
      setSubCanvases(saved.canvases);
      setActiveSubCanvasId(activeId);
      loadSubCanvasState(activeState);
      return;
    }

    const defaultCanvas = createDefaultSubCanvas(currentProject.id, nodes.length);
    setSubCanvases([defaultCanvas]);
    setActiveSubCanvasId(defaultCanvas.id);
    writeSubCanvasWorkspace(currentProject.id, {
      canvases: [defaultCanvas],
      activeId: defaultCanvas.id,
      states: {
          [defaultCanvas.id]: { nodes, connections, transform, groups: [] },
      },
    });
  }, [currentProject?.id]);

  useEffect(() => {
    if (!currentProject || !activeSubCanvasId || subCanvases.length === 0) return;
    const timer = window.setTimeout(() => {
      const nextCanvases = subCanvases.map(canvas => canvas.id === activeSubCanvasId
        ? { ...canvas, nodeCount: nodes.length, lastSavedAt: '刚刚' }
        : canvas
      );
      persistCurrentSubCanvasWorkspace({ canvases: nextCanvases });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [currentProject?.id, activeSubCanvasId, subCanvases, nodes, connections, transform, groups]);

  const handleSwitchSubCanvas = (canvasId: string) => {
      if (canvasId === activeSubCanvasId || !currentProject) return;
      const nextCanvases = subCanvases.map(canvas => canvas.id === activeSubCanvasId
      ? { ...canvas, nodeCount: nodes.length, lastSavedAt: '刚刚' }
      : canvas
    );
    const snapshot = getCurrentSubCanvasWorkspace({
      canvases: nextCanvases,
      activeId: canvasId,
    });
    const nextState = snapshot?.states?.[canvasId];
    if (snapshot) writeSubCanvasWorkspace(currentProject.id, snapshot);
    setSubCanvases(nextCanvases);
    setActiveSubCanvasId(canvasId);
    loadSubCanvasState(nextState);
    setIsSubCanvasListOpen(false);
  };

  const handleRenameSubCanvas = (canvasId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) {
      setEditingSubCanvasId(null);
      return;
    }
    const nextCanvases = subCanvases.map(c => c.id === canvasId ? { ...c, name: trimmed } : c);
    setSubCanvases(nextCanvases);
    persistCurrentSubCanvasWorkspace({ canvases: nextCanvases });
    setEditingSubCanvasId(null);
  };

  const handleCreateSubCanvas = () => {
    if (!currentProject) return;
    setPendingSubCanvasName(`新画布 ${subCanvases.length + 1}`);
    setShowSubCanvasNameDialog(true);
  };

  const handleConfirmCreateSubCanvas = () => {
    const name = pendingSubCanvasName.trim();
    if (!name || !currentProject) {
      setShowSubCanvasNameDialog(false);
      return;
    }
    persistCurrentSubCanvasWorkspace();
    const newCanvas: ProjectCanvasItem = {
      id: 'canvas-' + Date.now(),
      projectId: currentProject.id,
      name,
      owner: '我',
      permissionRole: 'owner',
      status: 'draft',
      nodeCount: 0,
      assetCount: 0,
      lastSavedAt: '刚刚',
      createdAt: new Date().toISOString().split('T')[0],
    };
    const nextCanvases = [...subCanvases, newCanvas];
    const previous = readSubCanvasWorkspace(currentProject.id);
    writeSubCanvasWorkspace(currentProject.id, {
      canvases: nextCanvases,
      activeId: newCanvas.id,
      states: {
        ...(previous?.states || {}),
        [activeSubCanvasId]: { nodes, connections, transform, groups },
        [newCanvas.id]: { nodes: [], connections: [], transform: { x: 0, y: 0, k: 1 }, groups: [] },
      },
    });
    setSubCanvases(nextCanvases);
    setActiveSubCanvasId(newCanvas.id);
    loadSubCanvasState();
    setIsSubCanvasListOpen(false);
    setShowSubCanvasNameDialog(false);
  };

  const handleDeleteSubCanvas = (canvasId: string) => {
    if (!currentProject) return;
    if (subCanvases.length <= 1) {
      window.alert('至少保留一个子画布。');
      return;
    }
    const target = subCanvases.find(canvas => canvas.id === canvasId);
    if (!target) return;
    if (!window.confirm(`确定删除子画布「${target.name}」吗？`)) return;

    const previous = getCurrentSubCanvasWorkspace();
    const nextCanvases = subCanvases.filter(canvas => canvas.id !== canvasId);
    const nextActiveId = canvasId === activeSubCanvasId ? nextCanvases[0].id : activeSubCanvasId;
    const nextStates = { ...(previous?.states || {}) };
    delete nextStates[canvasId];
    writeSubCanvasWorkspace(currentProject.id, {
      canvases: nextCanvases,
      activeId: nextActiveId,
      states: nextStates,
    });

    setSubCanvases(nextCanvases);
    setActiveSubCanvasId(nextActiveId);
    if (canvasId === activeSubCanvasId) {
      loadSubCanvasState(nextStates[nextActiveId]);
    }
    if (editingSubCanvasId === canvasId) {
      setEditingSubCanvasId(null);
      setEditingSubCanvasName('');
    }
  };

  const activeSubCanvas = subCanvases.find(c => c.id === activeSubCanvasId);
  const [projectGroupFilter, setProjectGroupFilter] = useState('全部项目组');
  const [projectTypeFilter, setProjectTypeFilter] = useState('全部项目类型');
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  
  // New Workflow Dialog State
  const [showNewWorkflowDialog, setShowNewWorkflowDialog] = useState(false);
  
  // Project Name State
  const [projectName, setProjectName] = useState(`${DEMO_PROJECT_META.name} 无限画布`);
  
  const [isStorageOpen, setIsStorageOpen] = useState(false);
  const [isExportImportOpen, setIsExportImportOpen] = useState(false);
  const [isWelcomeOpen, setIsWelcomeOpen] = useState(() => !hasShownWelcome());
  const [storageDirName, setStorageDirName] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  // History State (Persist deleted nodes that have content)
  const [deletedNodes, setDeletedNodes] = useState<NodeData[]>([]);

  useEffect(() => {
      dragModeRef.current = dragMode;
  }, [dragMode]);

  useEffect(() => {
      authService.verify().then(setIsAuthenticated).finally(() => setIsCheckingAuth(false));
      const handleExpired = () => setIsAuthenticated(false);
      window.addEventListener('kc-auth-expired', handleExpired);
      return () => window.removeEventListener('kc-auth-expired', handleExpired);
  }, []);

  // 清除旧版本原型遗留的 Sora 2 配置，避免影响 KC 默认模型。
  useEffect(() => {
      if (typeof window !== 'undefined') {
          try {
              const sora2Key = `API_CONFIG_MODEL_Sora 2`;
              const stored = localStorage.getItem(sora2Key);
              if (stored) {
                  const parsed = JSON.parse(stored);
                  // 如果 endpoint 是旧的 chat completions，清除配置
                  if (parsed.endpoint === '/v1/chat/completions') {
                      localStorage.removeItem(sora2Key);
                      console.log('[App] Cleared old Sora 2 config with old endpoint');
                  }
              }
          } catch(e) {
              // 忽略错误
          }
      }
  }, []);

  // Default to dark theme.
  const [canvasBg, setCanvasBg] = useState('#0B0C0E');
  const isDark = canvasBg === '#0B0C0E';
  
  // Sync body class for CSS variables
  useEffect(() => {
    if (isDark) {
      document.body.classList.add('dark');
    } else {
      document.body.classList.remove('dark');
    }
  }, [isDark]);

  useEffect(() => {
    if (currentProject) {
      setCreditProjectId(currentProject.id);
    }
  }, [currentProject?.id]);

  const [selectionBox, setSelectionBox] = useState<{ x: number, y: number, w: number, h: number } | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [suggestedNodes, setSuggestedNodes] = useState<NodeData[]>([]);
  const [previewMedia, setPreviewMedia] = useState<{ url: string, type: 'image' | 'video' | 'audio', title?: string } | null>(null);
  const [previewText, setPreviewText] = useState<{ title: string, text: string } | null>(null);
  const [auditFailureNotice, setAuditFailureNotice] = useState<{ count: number } | null>(null);
  const [cropTarget, setCropTarget] = useState<{ nodeId: string; imageSrc: string; title: string; aspectRatio: string } | null>(null);
  const [saveResultTarget, setSaveResultTarget] = useState<{ nodeId: string; url: string; type: 'image' | 'video'; title: string } | null>(null);
  const [saveResultMode, setSaveResultMode] = useState<'material' | 'new_asset' | 'update_asset'>('material');
  const [saveResultName, setSaveResultName] = useState('');
  const [saveAssetType, setSaveAssetType] = useState<AssetLibraryType>('role');
  const [saveTargetAssetId, setSaveTargetAssetId] = useState(DEMO_ASSET_LIBRARY[0]?.id || '');
  const [saveResultNote, setSaveResultNote] = useState('');
  const [addToAssetPanel, setAddToAssetPanel] = useState<AddToAssetPanelState>({ isOpen: false, nodeId: '', nodeType: 'image' });
  const [isCreditDashboardOpen, setIsCreditDashboardOpen] = useState(false);
  const [creditProjectId, setCreditProjectId] = useState('');
  const [isLocalExportMenuOpen, setIsLocalExportMenuOpen] = useState(false);
  const [isLocalExporting, setIsLocalExporting] = useState(false);
  const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
  const [pendingDeleteRequest, setPendingDeleteRequest] = useState<{ nodeIds: string[]; connectionIds: string[] } | null>(null);
  const [frameExtractTarget, setFrameExtractTarget] = useState<{ nodeId: string; videoSrc: string } | null>(null);
  const [videoEditTarget, setVideoEditTarget] = useState<{ nodeId: string; videoSrc: string; title: string } | null>(null);
  const [directorDeskSession, setDirectorDeskSession] = useState<DirectorDeskSession | null>(null);
  
  // Quick Add Menu State
  const [quickAddMenu, setQuickAddMenu] = useState<{ sourceId: string, x: number, y: number, worldX: number, worldY: number, direction?: 'forward' | 'backward' } | null>(null);

  const [contextMenu, setContextMenu] = useState<{ 
      type: 'CANVAS' | 'NODE', 
      nodeId?: string, 
      nodeType?: NodeType, 
      x: number, 
      y: number, 
      worldX: number, 
      worldY: number 
  } | null>(null);

  const [internalClipboard, setInternalClipboard] = useState<{ nodes: NodeData[], connections: Connection[], groups: NodeGroup[] } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number, y: number, w?: number, h?: number, nodeId?: string }>({ x: 0, y: 0 });
  const initialTransformRef = useRef<CanvasTransform>({ x: 0, y: 0, k: 1 });
  const initialNodePositionsRef = useRef<{id: string, x: number, y: number}[]>([]);
  const initialGroupNodesRef = useRef<NodeData[]>([]);
  const initialSelectionRef = useRef<Set<string>>(new Set());
  const activeDragGroupRef = useRef<string | null>(null);
  const connectionStartRef = useRef<{ nodeId: string, type: 'source' | 'target' } | null>(null);
  const [tempConnection, setTempConnection] = useState<Point | null>(null);
  const lastMousePosRef = useRef<Point>({ x: 0, y: 0 }); 
  
  const workflowInputRef = useRef<HTMLInputElement>(null);
  const assetInputRef = useRef<HTMLInputElement>(null);
  const replaceImageRef = useRef<HTMLInputElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const directorDeskIframeRef = useRef<HTMLIFrameElement>(null);
  const localExportMenuRef = useRef<HTMLDivElement>(null);
  const nodeToReplaceRef = useRef<string | null>(null);
  const nodeToAttachInputRef = useRef<string | null>(null);
  const assetImportPositionRef = useRef<Point | null>(null);
  const assetImportConnectionRef = useRef<{ sourceId: string; direction?: 'forward' | 'backward' } | null>(null);
  const miniMapDragRef = useRef<{
      mapRect: DOMRect;
      metrics: { minX: number; minY: number; scale: number; offsetX: number; offsetY: number };
  } | null>(null);

  const spacePressed = useRef(false);

  const recordCanvasHistory = useCallback((entry: CanvasHistoryEntry) => {
       const isEmpty =
           (entry.type === 'delete' || entry.type === 'create')
               ? entry.nodes.length === 0 && entry.connections.length === 0
               : entry.type === 'group-update'
                   ? entry.beforeNodes.length === 0 && entry.beforeGroups.length === 0
                   : entry.beforeNodes.length === 0;
      if (isEmpty) return;
      canvasHistoryRef.current = [...canvasHistoryRef.current.slice(-49), entry];
      setCanvasHistoryCount(canvasHistoryRef.current.length);
  }, []);

  const undoLastCanvasAction = useCallback(() => {
      const entry = canvasHistoryRef.current.pop();
      if (!entry) return;

      if (entry.type === 'delete') {
          const restoredNodeIds = new Set(entry.nodes.map(node => node.id));
          setNodes(prev => {
              const existingIds = new Set(prev.map(node => node.id));
              return [...prev, ...entry.nodes.filter(node => !existingIds.has(node.id))];
          });
          setConnections(prev => {
              const existingIds = new Set(prev.map(connection => connection.id));
              return [...prev, ...entry.connections.filter(connection => !existingIds.has(connection.id))];
          });
           if (restoredNodeIds.size > 0) {
              setDeletedNodes(prev => prev.filter(node => !restoredNodeIds.has(node.id)));
              setSelectedNodeIds(restoredNodeIds);
              setSelectedConnectionId(null);
          } else if (entry.connections.length > 0) {
              setSelectedNodeIds(new Set());
              setSelectedConnectionId(entry.connections[0].id);
           }
           if (entry.groups) setGroups(entry.groups);
       } else if (entry.type === 'create') {
          const createdNodeIds = new Set(entry.nodes.map(node => node.id));
          const createdConnectionIds = new Set(entry.connections.map(connection => connection.id));
          setConnections(prev => prev.filter(connection =>
              !createdConnectionIds.has(connection.id)
              && !createdNodeIds.has(connection.sourceId)
              && !createdNodeIds.has(connection.targetId)
          ));
           setNodes(prev => prev.filter(node => !createdNodeIds.has(node.id)));
           if (entry.groups?.length) {
               const createdGroupIds = new Set(entry.groups.map(group => group.id));
               setGroups(prev => prev.filter(group => !createdGroupIds.has(group.id)));
           }
          setSelectedNodeIds(new Set());
          setSelectedConnectionId(null);
       } else if (entry.type === 'upload-update') {
          const beforeById = new Map(entry.beforeNodes.map(node => [node.id, node]));
          setNodes(prev => prev.map(node => beforeById.get(node.id) || node));
          setSelectedNodeIds(new Set(entry.beforeNodes.map(node => node.id)));
           setSelectedConnectionId(null);
       } else if (entry.type === 'group-update') {
           const beforeById = new Map(entry.beforeNodes.map(node => [node.id, node]));
           setNodes(prev => prev.map(node => beforeById.get(node.id) || node));
           // `beforeNodes` is intentionally scoped to the changed members. Use
           // the current complete node set when restoring groups, otherwise an
           // unrelated group would be filtered out during undo.
           setGroups(normalizeNodeGroups(entry.beforeGroups, nodesRef.current));
           setSelectedNodeIds(new Set(entry.beforeNodes.map(node => node.id)));
           setSelectedGroupId(null);
           setEditingGroupId(null);
           setSelectedConnectionId(null);
      }
      setContextMenu(null);
      setCanvasHistoryCount(canvasHistoryRef.current.length);
  }, []);

   const addCreatedCanvasItems = useCallback((createdNodes: NodeData[], createdConnections: Connection[] = [], label = '新建节点', createdGroups: NodeGroup[] = []) => {
      if (createdNodes.length > 0) {
          setNodes(prev => [...prev, ...createdNodes]);
      }
       if (createdConnections.length > 0) {
           setConnections(prev => [...prev, ...createdConnections]);
       }
       if (createdGroups.length > 0) {
           setGroups(prev => normalizeNodeGroups([...prev, ...createdGroups], [...nodesRef.current, ...createdNodes]));
       }
       recordCanvasHistory({ type: 'create', label, nodes: createdNodes, connections: createdConnections, groups: createdGroups });
   }, [recordCanvasHistory]);

  const screenToWorld = (x: number, y: number) => ({
    x: (x - transform.x) / transform.k,
    y: (y - transform.y) / transform.k,
  });

  const generateId = () => Math.random().toString(36).substr(2, 9);

  const resolveDirectorDeskPanorama = useCallback((nodeId: string) => {
      const incoming = connections.find(connection => connection.targetId === nodeId);
      if (!incoming) return null;
      const sourceNode = nodes.find(node => node.id === incoming.sourceId);
      if (!sourceNode?.imageSrc) return null;
      return {
          edgeId: incoming.id,
          sourceNodeId: sourceNode.id,
          imageUrl: sourceNode.imageSrc,
          fileName: `${sourceNode.title || '画布全景图'}.png`,
      };
  }, [connections, nodes]);

  const postDirectorDeskSessionToIframe = useCallback(() => {
      if (!directorDeskSession) return;
      const targetWindow = directorDeskIframeRef.current?.contentWindow;
      if (!targetWindow) return;

      targetWindow.postMessage({
          type: 'storyai:director-desk-session',
          payload: {
              instanceId: directorDeskSession.instanceId,
              theme: isDark ? 'dark' : 'light',
          },
      }, window.location.origin);

      const panorama = resolveDirectorDeskPanorama(directorDeskSession.nodeId);
      if (panorama) {
          targetWindow.postMessage({
              type: 'storyai:director-desk-panorama',
              payload: panorama,
          }, window.location.origin);
      }
  }, [directorDeskSession, isDark, resolveDirectorDeskPanorama]);

  const openDirectorDesk = useCallback((nodeId: string) => {
      const node = nodes.find(item => item.id === nodeId);
      if (!node || node.type !== NodeType.DIRECTOR_DESK) return;
      const instanceId = node.directorDeskInstanceId || `director-desk-${node.id}`;
      if (!node.directorDeskInstanceId) {
          setNodes(prev => prev.map(item => item.id === node.id ? { ...item, directorDeskInstanceId: instanceId } : item));
      }
      setDirectorDeskSession({
          nodeId: node.id,
          instanceId,
          title: node.title || '3D导演台',
      });
      setContextMenu(null);
  }, [nodes]);

  const createDirectorDeskCaptureNodes = useCallback(async (captures: DirectorDeskCapture[]) => {
      if (!directorDeskSession || captures.length === 0) return;
      const sourceNode = nodes.find(node => node.id === directorDeskSession.nodeId);
      if (!sourceNode) return;

      const validCaptures = captures
          .map((capture, index) => {
              const metadata = normalizeDirectorDeskCaptureMetadata(capture.metadata ?? capture.meta);
              const prompt = typeof capture.prompt === 'string' ? capture.prompt.trim().slice(0, 2000) : '';
              return {
                  dataUrl: typeof capture.dataUrl === 'string' ? capture.dataUrl : '',
                  fileName: typeof capture.fileName === 'string' ? capture.fileName : `导演台截图_${index + 1}.png`,
                  metadata,
                  prompt: prompt || (metadata ? buildDirectorDeskCapturePrompt(metadata) : ''),
              };
          })
          .filter(capture => capture.dataUrl.startsWith('data:image/'));

      if (validCaptures.length === 0) return;

      const createdNodes = await Promise.all(validCaptures.map(async (capture, index): Promise<NodeData> => {
          const size = await getImageSizeFromDataUrl(capture.dataUrl);
          const aspectRatio = getClosestAspectRatio(size.width, size.height, IMAGE_ASPECT_RATIOS);
          const { width, height } = getNodeSizeForAspectRatio(aspectRatio);
          return {
              id: generateId(),
              type: NodeType.TEXT_TO_IMAGE,
              x: sourceNode.x + sourceNode.width + 80,
              y: sourceNode.y + index * (height + 36),
              width,
              height,
              title: capture.fileName.replace(/\.[^.]+$/, '') || `导演台截图_${index + 1}`,
              imageSrc: capture.dataUrl,
              aspectRatio,
              model: 'Seedream 5.0',
              resolution: '1k',
              count: 1,
              prompt: capture.prompt,
              outputArtifacts: [capture.dataUrl],
              source: 'canvas',
              ...(capture.metadata ? { directorDeskCaptureMetadata: capture.metadata } : {}),
          };
      }));

      addCreatedCanvasItems(createdNodes, [], '导演台截图');
      setNodes(prev => prev.map(node => node.id === sourceNode.id ? {
          ...node,
          directorDeskLastCaptureUrl: validCaptures[0].dataUrl,
      } : node));
      setSelectedNodeIds(new Set(createdNodes.map(node => node.id)));
  }, [addCreatedCanvasItems, directorDeskSession, nodes]);

  useEffect(() => {
      if (!directorDeskSession) return;

      const handleDirectorDeskMessage = (event: MessageEvent) => {
          if (event.origin !== window.location.origin) return;
          if (directorDeskIframeRef.current?.contentWindow && event.source !== directorDeskIframeRef.current.contentWindow) return;

          if (event.data?.type === 'storyai:director-desk-ready') {
              postDirectorDeskSessionToIframe();
              return;
          }

          if (event.data?.type === 'storyai:director-desk-close') {
              setDirectorDeskSession(null);
              return;
          }

          if (event.data?.type === 'storyai:director-desk-captures-sent') {
              const payloadInstanceId = typeof event.data?.payload?.instanceId === 'string'
                  ? event.data.payload.instanceId.trim()
                  : '';
              if (payloadInstanceId && payloadInstanceId !== directorDeskSession.instanceId) return;
              const captures = Array.isArray(event.data?.payload?.captures) ? event.data.payload.captures : [];
              void createDirectorDeskCaptureNodes(captures);
          }
      };

      window.addEventListener('message', handleDirectorDeskMessage);
      return () => window.removeEventListener('message', handleDirectorDeskMessage);
  }, [createDirectorDeskCaptureNodes, directorDeskSession, postDirectorDeskSessionToIframe]);

  // Memoize inputs map to prevent array recreation on every render
  const inputsMap = useMemo(() => {
    const map: Record<string, string[]> = {};
    nodes.forEach(node => {
        map[node.id] = connections
            .filter(c => c.targetId === node.id)
            .map(c => nodes.find(n => n.id === c.sourceId))
            .filter(n => n && (n.imageSrc || n.videoSrc))
            .map(n => n!.imageSrc || n!.videoSrc || '');
    });
    return map;
  }, [nodes, connections]);

  const inputMediaMap = useMemo(() => {
    const map: Record<string, InputMedia[]> = {};
    nodes.forEach(node => {
        map[node.id] = connections
            .filter(c => c.targetId === node.id)
            .map(c => nodes.find(n => n.id === c.sourceId))
            .filter((n): n is NodeData => Boolean(n && (n.imageSrc || n.videoSrc || n.audioSrc || getTextNodeOutput(n))))
            .map(n => {
                const base = { id: n.id, sourceNodeId: n.id, title: n.title };
                if (n.videoSrc) return { ...base, type: 'video', url: n.videoSrc } satisfies InputMedia;
                if (n.imageSrc) return { ...base, type: 'image', url: n.imageSrc } satisfies InputMedia;
                if (n.audioSrc) return { ...base, type: 'audio', url: n.audioSrc } satisfies InputMedia;
                const text = getTextNodeOutput(n);
                return { ...base, type: 'text', url: `text://${n.id}`, text } satisfies InputMedia;
            });
    });
    return map;
  }, [nodes, connections]);

  const getInputImages = useCallback((nodeId: string) => {
    return inputsMap[nodeId] || EMPTY_ARRAY;
  }, [inputsMap]);

  const getInputMedia = useCallback((nodeId: string) => {
    return inputMediaMap[nodeId] || [];
  }, [inputMediaMap]);
  
  const performCopy = () => {
      if (selectedNodeIds.size === 0) return;
      
      const selectedNodes = nodes.filter(n => selectedNodeIds.has(n.id));
       const selectedConnections = connections.filter(c =>
           selectedNodeIds.has(c.sourceId) && selectedNodeIds.has(c.targetId)
       );

       const copiedGroups = groups
           .filter(group => group.memberIds.every(memberId => selectedNodeIds.has(memberId)))
           .map(group => ({ ...group, memberIds: [...group.memberIds] }));
       setInternalClipboard({ nodes: selectedNodes, connections: selectedConnections, groups: copiedGroups });
  };

  const performPaste = (targetPos: Point) => {
      if (!internalClipboard || internalClipboard.nodes.length === 0) return;

       const { nodes: clipboardNodes, connections: clipboardConnections, groups: clipboardGroups } = internalClipboard;
      
      let minX = Infinity, minY = Infinity;
      clipboardNodes.forEach(n => {
          if (n.x < minX) minX = n.x;
          if (n.y < minY) minY = n.y;
      });

      const idMap = new Map<string, string>();
      const newNodes: NodeData[] = [];

      clipboardNodes.forEach(node => {
          const newId = generateId();
          idMap.set(node.id, newId);
          const offsetX = node.x - minX;
          const offsetY = node.y - minY;
          newNodes.push({
              ...node,
              id: newId,
              x: targetPos.x + offsetX,
              y: targetPos.y + offsetY,
              title: node.title.endsWith('(Copy)') ? node.title : `${node.title} (Copy)`,
              isLoading: false,
          });
      });

       const newConnections: Connection[] = clipboardConnections.map(c => ({
          id: generateId(),
          sourceId: idMap.get(c.sourceId)!,
          targetId: idMap.get(c.targetId)!
       }));

       const newGroups = clipboardGroups
           .map(group => ({
               ...group,
               id: `group_${Date.now()}_${generateId()}`,
               title: group.title.endsWith('(副本)') ? group.title : `${group.title} (副本)`,
               memberIds: group.memberIds.map(memberId => idMap.get(memberId)).filter((memberId): memberId is string => Boolean(memberId)),
               createdAt: Date.now(),
           }))
           .filter(group => group.memberIds.length >= 2);

       addCreatedCanvasItems(newNodes, newConnections, '复制节点', newGroups);
      setSelectedNodeIds(new Set(newNodes.map(n => n.id)));
  };

  const handleAlign = useCallback((direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT') => {
      if (selectedNodeIds.size < 2) return;

      setNodes(prevNodes => {
          const selected = prevNodes.filter(n => selectedNodeIds.has(n.id));
          const unselected = prevNodes.filter(n => !selectedNodeIds.has(n.id));
          const updatedNodes = selected.map(n => ({ ...n })); // Shallow clone to mutate

          const isVerticalAlign = direction === 'UP' || direction === 'DOWN';
          
          // Check overlap logic with Threshold to avoid accidental grouping
          const OVERLAP_THRESHOLD = 10;
          const isOverlap = (a: NodeData, b: NodeData) => {
              if (isVerticalAlign) {
                  const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
                  return overlap > OVERLAP_THRESHOLD;
              } else {
                  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
                  return overlap > OVERLAP_THRESHOLD;
              }
          };

          const clusters: NodeData[][] = [];
          const visited = new Set<string>();

          for (const node of updatedNodes) {
              if (visited.has(node.id)) continue;
              const cluster = [node];
              visited.add(node.id);
              const queue = [node];

              while (queue.length > 0) {
                  const current = queue.shift()!;
                  for (const other of updatedNodes) {
                      if (!visited.has(other.id) && isOverlap(current, other)) {
                          visited.add(other.id);
                          cluster.push(other);
                          queue.push(other);
                      }
                  }
              }
              clusters.push(cluster);
          }

          const minTop = Math.min(...updatedNodes.map(n => n.y));
          const maxBottom = Math.max(...updatedNodes.map(n => n.y + n.height));
          const minLeft = Math.min(...updatedNodes.map(n => n.x));
          const maxRight = Math.max(...updatedNodes.map(n => n.x + n.width));

          const HORIZONTAL_GAP = 20; 
          const VERTICAL_GAP = 60;   

          clusters.forEach(cluster => {
              if (direction === 'UP') {
                  cluster.sort((a, b) => (a.y - b.y) || a.id.localeCompare(b.id));
                  let currentY = minTop;
                  cluster.forEach((node) => {
                      node.y = currentY;
                      currentY += node.height + VERTICAL_GAP;
                  });
              } else if (direction === 'DOWN') {
                  cluster.sort((a, b) => (b.y - a.y) || a.id.localeCompare(b.id)); 
                  let currentBottom = maxBottom;
                  cluster.forEach((node) => {
                      node.y = currentBottom - node.height;
                      currentBottom -= (node.height + VERTICAL_GAP);
                  });
              } else if (direction === 'LEFT') {
                  cluster.sort((a, b) => (a.x - b.x) || a.id.localeCompare(b.id));
                  let currentX = minLeft;
                  cluster.forEach((node) => {
                      node.x = currentX;
                      currentX += node.width + HORIZONTAL_GAP;
                  });
              } else if (direction === 'RIGHT') {
                  cluster.sort((a, b) => (b.x - a.x) || a.id.localeCompare(b.id)); 
                  let currentRight = maxRight;
                  cluster.forEach((node) => {
                      node.x = currentRight - node.width;
                      currentRight -= (node.width + HORIZONTAL_GAP);
                  });
              }
          });

          return [...unselected, ...updatedNodes];
      });
  }, [selectedNodeIds]);

  const addNode = (type: NodeType, x?: number, y?: number, dataOverride?: Partial<NodeData>, recordHistory = true) => {
    if (x === undefined || y === undefined) {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const center = screenToWorld(rect.width / 2, rect.height / 2);
        x = center.x - DEFAULT_NODE_WIDTH / 2;
        y = center.y - DEFAULT_NODE_HEIGHT / 2;
      } else {
        x = 0; y = 0;
      }
    }

    let w = dataOverride?.width || DEFAULT_NODE_WIDTH;
    let h = dataOverride?.height || DEFAULT_NODE_HEIGHT;

    if (type === NodeType.ORIGINAL_IMAGE) {
        h = dataOverride?.height || 240;
    } else if (type === NodeType.TEXT_TO_VIDEO || type === NodeType.IMAGE_TO_VIDEO || type === NodeType.START_END_TO_VIDEO) {
        if (!dataOverride?.width) w = 400 * (16/9); 
        if (!dataOverride?.height) h = 400;
    } else if (type === NodeType.TEXT_TO_IMAGE || type === NodeType.IMAGE_TO_IMAGE) {
        if (!dataOverride?.width) w = 400;
        if (!dataOverride?.height) h = 400;
    } else if (type === NodeType.TEXT_TO_AUDIO) {
        if (!dataOverride?.width) w = 420;
        if (!dataOverride?.height) h = 260;
    } else if (type === NodeType.CREATIVE_DESC) {
        if (!dataOverride?.width) w = 520;
        if (!dataOverride?.height) h = 520;
    } else if (type === NodeType.DIRECTOR_DESK) {
        if (!dataOverride?.width) w = 420;
        if (!dataOverride?.height) h = 260;
    }
    
    const getDefaultTitle = (t: NodeType) => {
        switch (t) {
            case NodeType.TEXT_TO_IMAGE: return '生图';
            case NodeType.TEXT_TO_VIDEO: return '生视频';
            case NodeType.TEXT_TO_AUDIO: return '音频';
            case NodeType.CREATIVE_DESC: return 'Text';
            case NodeType.DIRECTOR_DESK: return '3D导演台';
            default: return `原始图片_${Date.now()}`;
        }
    };

    const getDefaultModel = (t: NodeType) => {
        switch (t) {
            case NodeType.TEXT_TO_IMAGE:
                return 'Seedream 5.0';
            case NodeType.TEXT_TO_VIDEO:
                return 'Seedance 2.0';
            case NodeType.TEXT_TO_AUDIO:
                return 'Minimax-speech-2.8-hd';
            case NodeType.CREATIVE_DESC:
                return 'Xiaomi MiMo 2.5 Pro';
            case NodeType.DIRECTOR_DESK:
                return 'StoryAI 3D Director Desk';
            default:
                return '';
        }
    };

    const isVideoType = type === NodeType.TEXT_TO_VIDEO;
    
    const newNode: NodeData = {
      ...dataOverride,
      id: generateId(),
      type,
      x,
      y,
      width: w,
      height: h, 
      title: dataOverride?.title || getDefaultTitle(type),
      aspectRatio: dataOverride?.aspectRatio || (isVideoType ? '16:9' : '1:1'),
      model: dataOverride?.model || getDefaultModel(type),
      resolution: dataOverride?.resolution || (isVideoType ? '720p' : '1k'),
      duration: dataOverride?.duration || (isVideoType ? '5s' : undefined),
      count: 1,
      prompt: dataOverride?.prompt || '',
      textContent: type === NodeType.CREATIVE_DESC ? (dataOverride?.textContent ?? '') : dataOverride?.textContent,
      imageSrc: dataOverride?.imageSrc,
      videoSrc: dataOverride?.videoSrc,
      directorDeskInstanceId: dataOverride?.directorDeskInstanceId || (type === NodeType.DIRECTOR_DESK ? `director-desk-${Date.now()}` : undefined),
      directorDeskLastCaptureUrl: dataOverride?.directorDeskLastCaptureUrl,
      textVersions: dataOverride?.textVersions,
      outputArtifacts: dataOverride?.outputArtifacts || (dataOverride?.imageSrc || dataOverride?.videoSrc ? [dataOverride.imageSrc || dataOverride.videoSrc!] : [])
    };
    
    if (recordHistory) {
        addCreatedCanvasItems([newNode]);
    } else {
        setNodes(prev => [...prev, newNode]);
    }
    setSelectedNodeIds(new Set([newNode.id]));
    return newNode.id;
  };

  const handleQuickAddNode = (type: NodeType) => {
      if (!quickAddMenu) return;

      const newId = generateId();
      let w = DEFAULT_NODE_WIDTH;
      let h = DEFAULT_NODE_HEIGHT;

      const isVideoType = type === NodeType.TEXT_TO_VIDEO;
      const isImageGenType = type === NodeType.TEXT_TO_IMAGE;

      if (type === NodeType.ORIGINAL_IMAGE) {
          h = 240;
      } else if (isVideoType) {
          w = 400 * (16/9); h = 400;
      } else if (isImageGenType) {
          w = 400; h = 400;
      } else if (type === NodeType.TEXT_TO_AUDIO) {
          w = 420; h = 260;
      } else if (type === NodeType.CREATIVE_DESC) {
          w = 520; h = 520;
      }

      const getDefaultTitle = (t: NodeType) => {
          switch (t) {
              case NodeType.TEXT_TO_IMAGE: return '生图';
              case NodeType.TEXT_TO_VIDEO: return '生视频';
              case NodeType.TEXT_TO_AUDIO: return '音频';
              case NodeType.CREATIVE_DESC: return 'Text';
              default: return `原始图片_${Date.now()}`;
          }
      };

      const getDefaultModel = (t: NodeType) => {
          switch (t) {
              case NodeType.TEXT_TO_IMAGE:
                  return 'Seedream 5.0';
              case NodeType.TEXT_TO_VIDEO:
                  return 'Seedance 2.0';
              case NodeType.TEXT_TO_AUDIO:
                  return 'Minimax-speech-2.8-hd';
              case NodeType.CREATIVE_DESC:
                  return 'Xiaomi MiMo 2.5 Pro';
              default:
                  return '';
          }
      };

      // 反向新建时，新节点位于锚点上游(左侧)，让其右边缘对齐落点；正向保持原有左边缘对齐落点。
      const isBackward = quickAddMenu.direction === 'backward';
      const newNode: NodeData = {
          id: newId,
          type,
          x: isBackward ? quickAddMenu.worldX - w : quickAddMenu.worldX,
          y: quickAddMenu.worldY - h / 2,
          width: w,
          height: h,
          title: getDefaultTitle(type),
          aspectRatio: isVideoType ? '16:9' : '1:1',
          model: getDefaultModel(type),
          resolution: isVideoType ? '720p' : '1k',
          duration: isVideoType ? '5s' : undefined,
          count: 1,
          prompt: '',
          textContent: type === NodeType.CREATIVE_DESC ? '' : undefined,
          textVersions: type === NodeType.CREATIVE_DESC ? [] : undefined,
          outputArtifacts: []
      };

      // 反向：新节点作为上游(source)，锚点为下游(target)；正向：保持原有方向。
      const newConnection = isBackward
          ? { id: generateId(), sourceId: newId, targetId: quickAddMenu.sourceId }
          : { id: generateId(), sourceId: quickAddMenu.sourceId, targetId: newId };

      addCreatedCanvasItems([newNode], [newConnection], '新建节点');
      setQuickAddMenu(null);
  };

  const focusNodeInViewport = (node: NodeData, targetScale = transform.k) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTransform({
          x: rect.width / 2 - (node.x + node.width / 2) * targetScale,
          y: rect.height / 2 - (node.y + node.height / 2) * targetScale,
          k: targetScale,
      });
  };

  const handleImportDemoShot = () => {
      const existing = nodes.find(node => node.shotId === DEMO_LINEAR_SHOT.shotId);
      if (existing) {
          setSelectedNodeIds(new Set([existing.id]));
          focusNodeInViewport(existing);
          return;
      }

      const width = 400 * (16 / 9);
      const height = 400;
      const rect = containerRef.current?.getBoundingClientRect();
      const center = rect ? screenToWorld(rect.width / 2, rect.height / 2) : { x: 0, y: 0 };
      const newNode: NodeData = {
          id: generateId(),
          type: NodeType.TEXT_TO_VIDEO,
          x: center.x - width / 2,
          y: center.y - height / 2,
          width,
          height,
          title: DEMO_LINEAR_SHOT.shotName,
          prompt: DEMO_LINEAR_SHOT.prompt,
          aspectRatio: DEMO_LINEAR_SHOT.aspectRatio,
          model: DEMO_LINEAR_SHOT.model,
          resolution: DEMO_LINEAR_SHOT.resolution,
          duration: DEMO_LINEAR_SHOT.duration,
          count: 1,
          outputArtifacts: [],
          source: 'linear_pipeline',
          sourceRefId: DEMO_LINEAR_SHOT.shotId,
          projectId: currentProject?.id || DEMO_LINEAR_SHOT.projectId,
          directorGroupName: currentProject?.directorGroup || DEMO_LINEAR_SHOT.directorGroupName,
          shotId: DEMO_LINEAR_SHOT.shotId,
          episodeNo: DEMO_LINEAR_SHOT.episodeNo,
          sceneNo: DEMO_LINEAR_SHOT.sceneNo,
          shotNo: DEMO_LINEAR_SHOT.shotNo,
          shotName: DEMO_LINEAR_SHOT.shotName,
          shotDescription: DEMO_LINEAR_SHOT.shotDescription,
          linearPageUrl: DEMO_LINEAR_SHOT.linearPageUrl,
          creditEstimate: DEMO_LINEAR_SHOT.creditEstimate,
          creditStatus: DEMO_LINEAR_SHOT.creditStatus,
      };

      addCreatedCanvasItems([newNode]);
      setSelectedNodeIds(new Set([newNode.id]));
  };

  const handleAddAssetToCanvas = (asset: AssetLibraryItem, position?: Point) => {
      const { width, height } = getNodeSizeForAspectRatio('4:3', 300);
      const rect = containerRef.current?.getBoundingClientRect();
      const center = position || (rect ? screenToWorld(rect.width / 2, rect.height / 2) : { x: 0, y: 0 });
      if (asset.type === 'role') {
          addNode(NodeType.TEXT_TO_AUDIO, center.x + width / 2 + 72, center.y - 130, {
              width: 420,
              height: 260,
              title: asset.name,
              prompt: '',
              model: 'Minimax-speech-2.8-hd',
              source: 'asset_library',
              sourceRefId: asset.id,
              projectId: currentProject?.id || DEMO_PROJECT_META.id,
              directorGroupName: currentProject?.directorGroup || DEMO_PROJECT_META.directorGroup,
              outputArtifacts: [],
          });
      }
      addNode(NodeType.TEXT_TO_IMAGE, center.x - width / 2, center.y - height / 2, {
          width,
          height,
          title: asset.name,
          imageSrc: asset.previewUrl,
          aspectRatio: '4:3',
          model: 'Seedream 5.0',
          resolution: '1k',
          source: 'asset_library',
          sourceRefId: asset.id,
          projectId: currentProject?.id || DEMO_PROJECT_META.id,
          directorGroupName: currentProject?.directorGroup || DEMO_PROJECT_META.directorGroup,
          outputArtifacts: [asset.previewUrl],
      });
  };

  

  const handleOpenAssetSelection = (nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    const isVideo = node.type === NodeType.TEXT_TO_VIDEO || node.type === NodeType.IMAGE_TO_VIDEO || node.type === NodeType.START_END_TO_VIDEO;
    setAddToAssetPanel({
      isOpen: true,
      nodeId,
      nodeType: isVideo ? 'video' : 'image',
      imageSrc: node.imageSrc,
      videoSrc: node.videoSrc,
      title: node.title,
    });
  };

  const handleCloseAssetSelection = () => {
    setAddToAssetPanel({ isOpen: false, nodeId: '', nodeType: 'image' });
  };

  const handleAddToExistingAsset = (nodeId: string, assetId: string, targetType: string, closePanel = true) => {
    const asset = DEMO_ASSET_LIBRARY.find(a => a.id === assetId);
    const node = nodes.find(n => n.id === nodeId);
    if (!asset || !node) return;
    updateNodeData(nodeId, { 
      source: 'asset_library', 
      sourceRefId: assetId,
      title: asset.name
    });
    if (closePanel) handleCloseAssetSelection();
  };

  const handleCreateNewAsset = (nodeId: string, assetType: AssetLibraryType, name: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    const newId = `asset_${assetType}_${Date.now()}`;
    const newAsset: AssetLibraryItem = {
      id: newId,
      type: assetType,
      scope: 'project',
      name,
      version: 'v1',
      updatedAt: '刚刚',
      previewUrl: node.imageSrc || node.videoSrc || '',
      description: node.title,
    };
    DEMO_ASSET_LIBRARY.push(newAsset);
    updateNodeData(nodeId, { 
      source: 'asset_library', 
      sourceRefId: newId,
      title: name
    });
    handleCloseAssetSelection();
  };

  const handleAddNodeToShotClip = (nodeId: string, shotClipId: string, closePanel = true) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    updateNodeData(nodeId, {
      source: 'linear_pipeline',
      shotId: shotClipId,
    });
    if (closePanel) handleCloseAssetSelection();
  };

  const handleAddShotClipToCanvas = (clip: ShotClip, position?: Point) => {
    const { width: vw, height: vh } = getNodeSizeForAspectRatio('16:9', 350);
    const rect = containerRef.current?.getBoundingClientRect();
    const center = position || (rect ? screenToWorld(rect.width / 2, rect.height / 2) : { x: 0, y: 0 });
    
    const videoNode: NodeData = {
      id: generateId(),
      type: NodeType.TEXT_TO_VIDEO,
      x: center.x - vw / 2,
      y: center.y,
      width: vw,
      height: vh,
      title: clip.shotName,
      prompt: clip.prompt || '',
      videoSrc: clip.videoUrl || undefined,
      model: 'Seedance 2.0',
      aspectRatio: '16:9',
      resolution: '720p',
      duration: '5s',
      source: 'material_library',
      sourceRefId: clip.id,
      projectId: currentProject?.id || DEMO_PROJECT_META.id,
    };
    
    addCreatedCanvasItems([videoNode]);
  };

const handlePaste = useCallback(async (e: ClipboardEvent) => {
    const activeElement = document.activeElement;
    const isInputFocused = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement;
    if (isInputFocused) return;

    const items = e.clipboardData?.items;
    let hasSystemMedia = false;
    const mousePos = lastMousePosRef.current;
    const worldPos = screenToWorld(mousePos.x, mousePos.y);

    if (items) {
        for (let i = 0; i < items.length; i++) {
            const item = items[i] as DataTransferItem;
            if (item.type.indexOf('image') !== -1) {
                hasSystemMedia = true;
                const file = item.getAsFile();
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        const img = new Image();
                        img.onload = () => {
                            const aspectRatio = getClosestAspectRatio(img.width, img.height, IMAGE_ASPECT_RATIOS);
                            const { width, height } = getNodeSizeForAspectRatio(aspectRatio);
                            const src = event.target?.result as string;
                            addNode(NodeType.TEXT_TO_IMAGE, worldPos.x, worldPos.y, {
                                width, height, imageSrc: src, title: `图片_${new Date().toLocaleTimeString()}`, aspectRatio, model: 'Seedream 5.0', resolution: '1k', outputArtifacts: [src]
                            });
                        };
                        img.src = event.target?.result as string;
                    };
                    reader.readAsDataURL(file);
                }
            } else if (item.type.indexOf('video') !== -1) {
                hasSystemMedia = true;
                const file = item.getAsFile();
                if (file) {
                    const url = URL.createObjectURL(file);
                    const video = document.createElement('video');
                    video.preload = 'metadata';
                    video.onloadedmetadata = () => {
                         const aspectRatio = getClosestAspectRatio(video.videoWidth, video.videoHeight, VIDEO_ASPECT_RATIOS);
                         const { width, height } = getNodeSizeForAspectRatio(aspectRatio, VIDEO_NODE_BASE_HEIGHT);
                         addNode(NodeType.TEXT_TO_VIDEO, worldPos.x, worldPos.y, {
                             width, height, videoSrc: url, title: file.name, aspectRatio, model: 'Seedance 1.5 Pro', resolution: '720p', duration: '5s', outputArtifacts: [url]
                         });
                    };
                    video.src = url;
                }
            }
        }
    }
    if (!hasSystemMedia && internalClipboard) performPaste(worldPos);
  }, [transform, internalClipboard]); 

  useEffect(() => {
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  const createNodeGroup = useCallback(() => {
      const memberIds = Array.from(selectedNodeIds);
      if (memberIds.length < 2) {
          window.alert('请先选择至少两个节点再打组。');
          return;
      }
      const beforeGroups = groups;
      const beforeNodes = nodes.filter(node => selectedNodeIds.has(node.id));
      const id = `group_${Date.now()}_${generateId()}`;
      const nextGroup: NodeGroup = {
          id,
          title: `分组 ${groups.length + 1}`,
          memberIds,
          layout: 'manual',
          createdAt: Date.now(),
      };
      recordCanvasHistory({ type: 'group-update', label: '打组', beforeNodes, beforeGroups });
      // A node has at most one semantic group. Re-grouping selected nodes removes
      // them from their prior group and automatically drops undersized groups.
      setGroups(normalizeNodeGroups([...groups.map(group => ({
          ...group,
          memberIds: group.memberIds.filter(memberId => !selectedNodeIds.has(memberId)),
      })), nextGroup], nodes));
      setSelectedGroupId(id);
      setEditingGroupId(null);
  }, [groups, nodes, recordCanvasHistory, selectedNodeIds]);

  const ungroupNodeGroup = useCallback((groupId = selectedGroupId) => {
      if (!groupId) return;
      const group = groups.find(item => item.id === groupId);
      if (!group) return;
      recordCanvasHistory({
          type: 'group-update',
          label: '解组',
          beforeNodes: nodes.filter(node => group.memberIds.includes(node.id)),
          beforeGroups: groups,
      });
      setGroups(groups.filter(item => item.id !== groupId));
      setSelectedNodeIds(new Set(group.memberIds));
      setSelectedGroupId(null);
      setEditingGroupId(null);
  }, [groups, nodes, recordCanvasHistory, selectedGroupId]);

  const arrangeNodeGroup = useCallback((groupId = selectedGroupId) => {
      if (!groupId) return;
      const group = groups.find(item => item.id === groupId);
      if (!group) return;
      const groupNodes = nodes.filter(node => group.memberIds.includes(node.id));
      const bounds = getNodesBounds(groupNodes);
      if (!bounds || groupNodes.length < 2) return;

      const originalIndex = new Map(nodes.map((node, index) => [node.id, index]));
      const sorted = [...groupNodes].sort((a, b) => (a.y - b.y) || (a.x - b.x) || ((originalIndex.get(a.id) || 0) - (originalIndex.get(b.id) || 0)));
      const aspect = bounds.width / Math.max(bounds.height, 1);
      const columns = Math.max(1, Math.min(4, Math.round(Math.sqrt(sorted.length * Math.max(0.65, Math.min(aspect, 1.8))))));
      const rows = Math.ceil(sorted.length / columns);
      const columnWidths = Array.from({ length: columns }, () => 0);
      const rowHeights = Array.from({ length: rows }, () => 0);
      sorted.forEach((node, index) => {
          columnWidths[index % columns] = Math.max(columnWidths[index % columns], node.width);
          rowHeights[Math.floor(index / columns)] = Math.max(rowHeights[Math.floor(index / columns)], node.height);
      });
      const gapX = 48;
      const gapY = 48;
      const columnX = columnWidths.reduce<number[]>((positions, width, index) => {
          positions.push(index === 0 ? bounds.x : positions[index - 1] + columnWidths[index - 1] + gapX);
          return positions;
      }, []);
      const rowY = rowHeights.reduce<number[]>((positions, height, index) => {
          positions.push(index === 0 ? bounds.y : positions[index - 1] + rowHeights[index - 1] + gapY);
          return positions;
      }, []);
      const positionById = new Map(sorted.map((node, index) => {
          const col = index % columns;
          const row = Math.floor(index / columns);
          return [node.id, {
              x: columnX[col] + (columnWidths[col] - node.width) / 2,
              y: rowY[row] + (rowHeights[row] - node.height) / 2,
          }] as const;
      }));
      recordCanvasHistory({ type: 'group-update', label: '整理分组', beforeNodes: groupNodes, beforeGroups: groups });
      setNodes(previous => previous.map(node => {
          const position = positionById.get(node.id);
          return position ? { ...node, ...position } : node;
      }));
      setGroups(previous => previous.map(item => item.id === groupId ? { ...item, layout: 'grid' } : item));
  }, [groups, nodes, recordCanvasHistory, selectedGroupId]);

  const downloadNodeCollection = useCallback(async (nodeIds: Iterable<string>, label: string) => {
      const ids = new Set(nodeIds);
      const entries = nodes
          .filter(node => ids.has(node.id))
          .map(node => {
              const url = node.videoSrc || node.audioSrc || node.imageSrc;
              const type = node.videoSrc ? 'video' : node.audioSrc ? 'audio' : 'image';
              const extension = node.videoSrc ? 'mp4' : node.audioSrc ? 'mp3' : 'png';
              return url ? { url, type, extension, title: node.title } : null;
          })
          .filter((entry): entry is { url: string; type: string; extension: string; title: string } => Boolean(entry));
      const seenUrls = new Set<string>();
      const uniqueEntries = entries.filter(entry => !seenUrls.has(entry.url) && (seenUrls.add(entry.url), true));
      if (!uniqueEntries.length) {
          window.alert(`「${label}」内没有可下载的当前内容。`);
          return;
      }
      let succeeded = 0;
      let failed = 0;
      for (let index = 0; index < uniqueEntries.length; index += 1) {
          const entry = uniqueEntries[index];
          const filename = `${String(index + 1).padStart(2, '0')}_${sanitizeExportName(entry.title)}_${entry.type}.${entry.extension}`;
          try {
              const response = await fetch(entry.url);
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              await saveLocalExportBlob(await response.blob(), filename);
              succeeded += 1;
          } catch (error) {
              console.error('Batch download failed:', entry.url, error);
              failed += 1;
          }
      }
      window.alert(failed ? `「${label}」已下载 ${succeeded} 项，${failed} 项下载失败。` : `「${label}」已下载 ${succeeded} 项。`);
  }, [nodes]);

  const executeDeleteCanvasItems = useCallback((nodeIds: Set<string>, connectionIds: Set<string>) => {
      const nodesToDelete = nodes.filter(node => nodeIds.has(node.id));
      const connectionsToDelete = connections.filter(connection =>
          connectionIds.has(connection.id)
          || nodeIds.has(connection.sourceId)
          || nodeIds.has(connection.targetId)
      );
      if (nodesToDelete.length === 0 && connectionsToDelete.length === 0) return;

      nodesToDelete.forEach(node => invalidateGenerationForNode(node.id));

       recordCanvasHistory({ type: 'delete', label: '删除', nodes: nodesToDelete, connections: connectionsToDelete, groups });
      const withContent = nodesToDelete.filter(node => node.imageSrc || node.videoSrc || node.audioSrc);
      if (withContent.length > 0) {
          setDeletedNodes(prev => [...prev, ...withContent]);
      }
       if (nodeIds.size > 0) {
          const nextNodes = nodes.filter(node => !nodeIds.has(node.id));
          nodesRef.current = nextNodes;
           setNodes(nextNodes);
           setGroups(previous => normalizeNodeGroups(previous.map(group => ({
               ...group,
               memberIds: group.memberIds.filter(memberId => !nodeIds.has(memberId)),
           })), nextNodes));
           if (selectedGroupId && groups.some(group => group.id === selectedGroupId && group.memberIds.some(memberId => nodeIds.has(memberId)))) {
               setSelectedGroupId(null);
               setEditingGroupId(null);
           }
       }
      if (connectionsToDelete.length > 0) {
          const deletedConnectionIds = new Set(connectionsToDelete.map(connection => connection.id));
          setConnections(prev => prev.filter(connection => !deletedConnectionIds.has(connection.id)));
      }
      setSelectedNodeIds(new Set());
      setSelectedConnectionId(null);
   }, [connections, groups, nodes, recordCanvasHistory, invalidateGenerationForNode, selectedGroupId]);

  const deleteCanvasItems = useCallback((nodeIds: Set<string>, connectionIds: Set<string>) => {
      if (nodeIds.size > 0) {
          setPendingDeleteRequest({
              nodeIds: Array.from(nodeIds),
              connectionIds: Array.from(connectionIds),
          });
          return;
      }
      executeDeleteCanvasItems(nodeIds, connectionIds);
  }, [executeDeleteCanvasItems]);

  const confirmPendingDelete = useCallback(() => {
      if (!pendingDeleteRequest) return;
      executeDeleteCanvasItems(new Set(pendingDeleteRequest.nodeIds), new Set(pendingDeleteRequest.connectionIds));
      setPendingDeleteRequest(null);
  }, [executeDeleteCanvasItems, pendingDeleteRequest]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if (directorDeskSession) {
            if (e.key === 'Escape') setDirectorDeskSession(null);
            return;
        }
        const target = e.target as HTMLElement;
        const isInput = target.tagName === 'INPUT'
            || target.tagName === 'TEXTAREA'
            || target.tagName === 'SELECT'
            || target.isContentEditable
            || Boolean(target.closest('[contenteditable="true"], [role="textbox"]'));
         if (!isInput) {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
                e.preventDefault();
                if (e.shiftKey) {
                    const inferredGroup = selectedGroupId || groups.find(group => group.memberIds.every(id => selectedNodeIds.has(id)))?.id;
                    ungroupNodeGroup(inferredGroup);
                } else {
                    createNodeGroup();
                }
                return;
            }
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                undoLastCanvasAction();
                return;
            }
            if (e.key === 'Delete' || e.key === 'Backspace') {
                 const connectionIds = selectedConnectionId ? new Set([selectedConnectionId]) : new Set<string>();
                 deleteCanvasItems(selectedNodeIds, connectionIds);
             }
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                e.preventDefault();
                performCopy();
            }
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
                if (e.key === 'ArrowUp') { e.preventDefault(); handleAlign('UP'); }
                if (e.key === 'ArrowDown') { e.preventDefault(); handleAlign('DOWN'); }
                if (e.key === 'ArrowLeft') { e.preventDefault(); handleAlign('LEFT'); }
                if (e.key === 'ArrowRight') { e.preventDefault(); handleAlign('RIGHT'); }
            }
        }
        
        if (e.key === 'Escape') {
            if (editingGroupId) setEditingGroupId(null);
            if (pendingDeleteRequest) setPendingDeleteRequest(null);
            if (previewMedia) setPreviewMedia(null);
            if (previewText) setPreviewText(null);
            if (contextMenu) setContextMenu(null);
            if (quickAddMenu) setQuickAddMenu(null);
            if (directorDeskSession) setDirectorDeskSession(null);
            if (showNewWorkflowDialog) setShowNewWorkflowDialog(false);
            if (isStorageOpen) setIsStorageOpen(false);
            if (isExportImportOpen) setIsExportImportOpen(false);
        }
        if (e.code === 'Space') spacePressed.current = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') spacePressed.current = false; };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keyup', handleKeyUp);
    };
  }, [selectedNodeIds, selectedGroupId, editingGroupId, groups, selectedConnectionId, pendingDeleteRequest, previewMedia, previewText, contextMenu, quickAddMenu, directorDeskSession, showNewWorkflowDialog, isStorageOpen, isExportImportOpen, handleAlign, createNodeGroup, ungroupNodeGroup, deleteCanvasItems, undoLastCanvasAction]);

  useEffect(() => {
    // Load storage directory name for the top-right indicator
    const loadStorageInfo = async () => {
        const name = await storageService.getDownloadDirectoryName();
        setStorageDirName(name);
    };
    if (isStorageOpen === false) {
        // Refresh when modal closes
        loadStorageInfo();
    }
    loadStorageInfo();
    
    const handleGlobalMouseUp = () => {
        if (dragModeRef.current !== 'NONE') {
            setDragMode('NONE');
            setTempConnection(null);
            connectionStartRef.current = null;
            dragStartRef.current = { x: 0, y: 0 };
            setSuggestedNodes([]);
            setSelectionBox(null);
        }
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [isStorageOpen]);

  useEffect(() => {
    if (!isLocalExportMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!localExportMenuRef.current?.contains(event.target as Node)) {
        setIsLocalExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isLocalExportMenuOpen]);

  const handleOpenStorageSettings = () => {
      setIsStorageOpen(true);
  };

  const handleImportWorkflow = (data: { nodes: NodeData[], connections: Connection[], groups?: NodeGroup[], transform?: CanvasTransform, projectName?: string }) => {
      // 保存当前有内容的节点到历史
      const withContent = nodes.filter(n => n.imageSrc || n.videoSrc);
      if (withContent.length > 0) setDeletedNodes(prev => [...prev, ...withContent]);

      clearCanvasHistory();
      setNodes(data.nodes);
      setConnections(data.connections);
      setGroups(normalizeNodeGroups(data.groups || [], data.nodes));
      if (data.transform) setTransform(data.transform);
      if (data.projectName) setProjectName(data.projectName);
      setSelectedNodeIds(new Set());
  };

  const updateNodeData = useCallback((id: string, updates: Partial<NodeData>) => {
    setNodes(prev => prev.map(n => n.id === id ? { ...n, ...updates } : n));
  }, []);

  // Frontend-only Seedance audit prototype. The specified test image is detected by
  // filename/URL marker or exact SHA-256, so blob: and data: uploads still work.
  const handleSeedanceAudit = useCallback(async (nodeId: string) => {
    const target = nodes.find(node => node.id === nodeId);
    if (!target?.imageSrc) return;

    updateNodeData(nodeId, {
        auditStatus: 'auditing',
        auditFailureReason: undefined,
        auditErrorDetail: undefined,
    });
    await new Promise(resolve => window.setTimeout(resolve, 650));
    const failed = await isMockRejectedAuditImage({
        id: target.id,
        sourceNodeId: target.id,
        type: 'image',
        url: target.imageSrc,
        title: target.title,
    }, target);

    updateNodeData(nodeId, failed ? {
        auditStatus: 'failed',
        auditFailureReason: MOCK_AUDIT_REASON,
        auditErrorDetail: MOCK_AUDIT_ERROR_DETAIL,
    } : {
        auditStatus: 'passed',
        auditFailureReason: undefined,
        auditErrorDetail: undefined,
    });
    if (failed) setAuditFailureNotice({ count: 1 });
  }, [nodes, updateNodeData]);

  const getEstimatedCredits = (node: NodeData) => {
      const count = node.count || 1;
      if (node.type === NodeType.TEXT_TO_VIDEO || node.type === NodeType.START_END_TO_VIDEO) return 14 * count;
      if (node.type === NodeType.TEXT_TO_IMAGE) return 2 * count;
      if (node.type === NodeType.CREATIVE_DESC) return 1;
      return 0;
  };

  const getCreditRows = (): CreditRow[] => {
      const activeProjectId = currentProject?.id || DEMO_PROJECT_META.id;
      const activeProjectName = currentProject?.name || projectName;
      const activeGroup = currentProject?.directorGroup || DEMO_PROJECT_META.directorGroup;
      const taskRows: CreditRow[] = nodes
          .filter(node => node.creditEstimate || node.creditStatus)
          .map((node, index) => ({
              id: node.id,
              projectId: node.projectId || activeProjectId,
              project: activeProjectName,
              group: currentProject?.directorGroup || node.directorGroupName || activeGroup,
              user: index % 2 === 0 ? CURRENT_USER_NAME : '制片助理B',
              type: node.type === NodeType.CREATIVE_DESC ? '文本分析' : node.type === NodeType.TEXT_TO_IMAGE ? '图片生成' : '视频生成',
              model: node.model || '-',
              credit: node.creditEstimate || getEstimatedCredits(node),
              status: node.creditStatus || 'estimated',
              nodeTitle: node.title,
          }));

      const projectRows = projects.flatMap((project, index): CreditRow[] => {
          if (project.id === activeProjectId && taskRows.length > 0) return [];
          return [
              {
                  id: `${project.id}_credit_image`,
                  projectId: project.id,
                  project: project.name,
                  group: project.directorGroup,
                  user: CURRENT_USER_NAME,
                  type: '图片生成',
                  model: 'Seedream 5.0',
                  credit: 2 + index,
                  status: index % 2 === 0 ? 'confirmed' : 'reserved',
                  nodeTitle: '角色/场景参考图',
              },
              {
                  id: `${project.id}_credit_video`,
                  projectId: project.id,
                  project: project.name,
                  group: project.directorGroup,
                  user: index % 2 === 0 ? CURRENT_USER_NAME : '制片助理B',
                  type: '视频生成',
                  model: 'Seedance 1.5 Pro',
                  credit: 14 + index * 2,
                  status: 'confirmed',
                  nodeTitle: '分镜视频',
              },
          ];
      });

      return [...taskRows, ...projectRows];
  };

  const getUserCreditStats = () => {
      const rows = getCreditRows().filter(row => row.user === CURRENT_USER_NAME);
      const used = rows
          .filter(row => row.status === 'confirmed' || row.status === 'reserved')
          .reduce((sum, row) => sum + row.credit, 0);
      return {
          rows,
          used,
          available: Math.max(0, USER_CREDIT_LIMIT - used),
      };
  };

  const releaseGeneration = (scope: GenerationScope) => {
      const key = generationScopeKey(scope);
      activeGenerationKeysRef.current.delete(key);
      const bindingKey = generationTargetKey(scope);
      const currentBinding = generationBindingByNodeRef.current.get(bindingKey);
      if (currentBinding?.operationId === scope.operationId) {
          generationBindingByNodeRef.current.delete(bindingKey);
          generationNodeLocksRef.current.delete(bindingKey);
      }
  };

  const setGenerationTask = (scope: GenerationScope, updates: Partial<GenerationTaskState>) => {
      const target = nodesRef.current.find(node => node.id === scope.nodeId);
      if (isGenerationScopeCurrent(scope) && target?.generationTask) {
          return updateGenerationNode(scope, {
              generationTask: {
                  ...target.generationTask,
                  ...updates,
                  updatedAt: Date.now(),
              },
          });
      }
      // Once the scope is off-screen, update only its persisted snapshot. A
      // same-canvas mismatch is treated as stale and cannot fall back to an
      // older localStorage copy.
      if (workspaceRef.current.projectId === scope.projectId && workspaceRef.current.canvasId === scope.canvasId) return false;
      return persistGenerationTaskToSnapshot(scope, updates);
  };

  const applyGeneratedResults = (
      scope: GenerationScope,
      initialNode: NodeData,
      results: string[],
      source: ArtifactSource,
      creditEstimate: number,
  ) => {
      if (!results.length) return false;
      const buildResultUpdates = (current: NodeData): Partial<NodeData> | null => {
          if (!current.generationTask) return null;
          const kind = current.generationTask.kind;
          const currentSrc = kind === 'image' ? current.imageSrc : kind === 'video' ? current.videoSrc : current.audioSrc;
          const initialSrc = kind === 'image' ? initialNode.imageSrc : kind === 'video' ? initialNode.videoSrc : initialNode.audioSrc;
          const preserveSelection = Boolean(currentSrc && currentSrc !== initialSrc);
          const newArtifacts = mergeArtifactVersions(results, currentSrc, current.outputArtifacts || []);
          const artifactSources = { ...(current.artifactSources || {}) };
          results.forEach(url => { artifactSources[url] = source; });
          const task: GenerationTaskState = {
              ...current.generationTask,
              status: 'succeeded',
              providerStatus: current.generationTask.providerStatus || 'completed',
              updatedAt: Date.now(),
              errorMessage: undefined,
              errorDetail: undefined,
          };
          const updates: Partial<NodeData> = {
              isLoading: false,
              errorMessage: undefined,
              outputArtifacts: newArtifacts,
              artifactSources,
              generationTask: task,
              creditEstimate,
              creditStatus: 'confirmed',
          };

          if (!preserveSelection) {
              updates.resultSource = source;
              if (kind === 'image') updates.imageSrc = results[0];
              if (kind === 'video') updates.videoSrc = results[0];
              if (kind === 'audio') updates.audioSrc = results[0];
          }

          if (kind === 'image') {
              const generatedAt = Date.now();
              const batchId = `${scope.nodeId}-${generatedAt}`;
              const generatedVersions = results.map((url, index) => createImageVersionSnapshot(
                  url,
                  initialNode,
                  generatedAt + index,
                  { batchId, batchUrls: [...results], batchIndex: index }
              ));
              updates.imageVersions = mergeImageVersionSnapshots(
                  newArtifacts,
                  generatedVersions,
                  current.imageVersions,
                  initialNode,
              );
          }

          // If the user selected/uploaded another candidate while the request was away,
          // keep that current value and only add the fresh results to its history.
          if (preserveSelection && currentSrc) {
              updates.resultSource = current.resultSource || current.artifactSources?.[currentSrc] || 'unknown';
          }
          return updates;
      };

      if (isGenerationScopeCurrent(scope)) {
          const current = nodesRef.current.find(node => node.id === scope.nodeId);
          const updates = current ? buildResultUpdates(current) : null;
          return updates ? updateGenerationNode(scope, updates) : false;
      }

      // A completed provider task can resolve while its canvas is hidden. Write
      // the complete result to that canvas snapshot so returning to it does not
      // show a succeeded task with missing media.
      if (workspaceRef.current.projectId === scope.projectId && workspaceRef.current.canvasId === scope.canvasId) return false;
      if (invalidatedGenerationKeysRef.current.has(generationScopeKey(scope))) return false;
      const previous = readSubCanvasWorkspace(scope.projectId);
      const scopedState = previous?.states?.[scope.canvasId];
      const persistedNode = scopedState?.nodes.find(node => node.id === scope.nodeId);
      if (!previous || !scopedState || !persistedNode?.generationTask || persistedNode.generationTask.operationId !== scope.operationId) return false;
      const updates = buildResultUpdates(persistedNode);
      if (!updates) return false;
      const nextNodes = scopedState.nodes.map(node => node.id === scope.nodeId ? { ...node, ...updates } : node);
      return writeSubCanvasWorkspace(scope.projectId, {
          ...previous,
          states: {
              ...previous.states,
              [scope.canvasId]: { ...scopedState, nodes: nextNodes },
          },
      });
  };

  const markGenerationFailure = (scope: GenerationScope, error: unknown, creditEstimate: number) => {
      const target = nodesRef.current.find(node => node.id === scope.nodeId);
      if (!target?.generationTask || !isGenerationScopeCurrent(scope)) return false;
      const taskIds = target.generationTask.providerTaskIds || [];
      const detail = getErrorDetail(error);
      const isTimeout = /timeout|timed out/i.test(detail);
      const status: GenerationTaskStatus = isTimeout
          ? (taskIds.length > 0 ? 'timed_out' : 'needs_check')
          : 'failed';
      const message = getChineseGenerationError(error, taskIds.length > 0);
      const updated = updateGenerationNode(scope, {
          isLoading: false,
          errorMessage: message,
          generationTask: {
              ...target.generationTask,
              status,
              errorMessage: message,
              errorDetail: detail,
              updatedAt: Date.now(),
          },
          creditEstimate,
          creditStatus: 'refunded',
      });
      if (updated) alert(message);
      return updated;
  };

  const handleGenerate = async (nodeId: string) => {
    const node = nodesRef.current.find(n => n.id === nodeId);
    if (!node || !currentProject?.id || !activeSubCanvasId) return;
    const generationTarget = { projectId: currentProject.id, canvasId: activeSubCanvasId, nodeId };
    const generationTargetKeyValue = generationTargetKey(generationTarget);
    if (node.isLoading || generationNodeLocksRef.current.has(generationTargetKeyValue)) return;

    const connectedMedia = getInputMedia(node.id);
    const connectedImages = connectedMedia.filter(item => item.type === 'image');
    const isVideoNode = node.type === NodeType.TEXT_TO_VIDEO
        || node.type === NodeType.IMAGE_TO_VIDEO
        || node.type === NodeType.START_END_TO_VIDEO;
    const requestedVideoMode = inferVideoMode(node);
    const videoMode = resolveVideoMode(requestedVideoMode, node.model, connectedImages.length > 0);
    const connectedMediaById = new Map(
        connectedMedia.map(item => [item.id || item.sourceNodeId || `${item.type}:${item.url}`, item]),
    );
    const selectedVideoMedia = node.videoPromptReferences === undefined
        ? connectedMedia.filter(item => (
            videoMode === 'image' ? item.type === 'image'
                : videoMode === 'omni' ? item.type === 'image' || item.type === 'video' || item.type === 'audio'
                    : videoMode === 'start_end' ? item.type === 'image'
                        : false
        ))
        : node.videoPromptReferences
            .map(reference => connectedMediaById.get(reference.id))
            .filter((item): item is InputMedia => Boolean(item))
            .filter(item => (
                videoMode === 'image' ? item.type === 'image'
                    : videoMode === 'omni' ? item.type === 'image' || item.type === 'video' || item.type === 'audio'
                        : false
            ));

    if (isVideoNode) {
        const capability = getVideoModelCapability(node.model);
        const imageCount = videoMode === 'start_end'
            ? connectedImages.length
            : selectedVideoMedia.filter(item => item.type === 'image').length;
        const videoCount = selectedVideoMedia.filter(item => item.type === 'video').length;
        const audioCount = selectedVideoMedia.filter(item => item.type === 'audio').length;
        const validationMessage =
            videoMode === 'image' && imageCount === 0 ? '请连接并 @ 引用至少一张图片'
                : videoMode === 'start_end' && connectedImages.length < 2 ? '请连接两张图片作为首帧和尾帧'
                    : videoMode === 'omni' && selectedVideoMedia.length === 0 ? '请连接并 @ 引用至少一个图片、视频或音频素材'
                        : imageCount > capability.maxImages ? `当前模型最多支持 ${capability.maxImages} 张图片`
                            : videoCount > capability.maxVideos ? `当前模型最多支持 ${capability.maxVideos} 个视频`
                                : audioCount > capability.maxAudio ? `当前模型最多支持 ${capability.maxAudio} 个音频`
                                    : '';
        if (validationMessage) {
            alert(validationMessage);
            return;
        }
    }

    const creditEstimate = node.creditEstimate || getEstimatedCredits(node);
    const inputs = getInputImages(node.id);
    const operationId = createGenerationOperationId();
    const scope: GenerationScope = {
        projectId: currentProject.id,
        canvasId: activeSubCanvasId,
        nodeId,
        operationId,
    };
    const existingBinding = generationBindingByNodeRef.current.get(generationTargetKeyValue);
    if (existingBinding) invalidatedGenerationKeysRef.current.add(generationScopeKey(existingBinding));
    const kind = getGenerationKind(node);
    const task: GenerationTaskState = {
        operationId,
        kind,
        status: 'submitting',
        inputSnapshot: toGenerationInputSnapshot(node, inputs, isVideoNode ? selectedVideoMedia : connectedMedia, isVideoNode ? videoMode : undefined),
        startedAt: Date.now(),
        updatedAt: Date.now(),
    };
    generationBindingByNodeRef.current.set(generationTargetKeyValue, scope);
    generationNodeLocksRef.current.add(generationTargetKeyValue);
    activeGenerationKeysRef.current.add(generationScopeKey(scope));
    recoveryStartedKeysRef.current.add(generationScopeKey(scope));
    const startedNodes = nodesRef.current.map(candidate => candidate.id === nodeId ? {
        ...candidate,
        isLoading: true,
        errorMessage: undefined,
        auditFailureReason: undefined,
        auditErrorDetail: undefined,
        generationTask: task,
        creditEstimate,
        creditStatus: 'reserved' as const,
    } : candidate);
    nodesRef.current = startedNodes;
    setNodes(startedNodes);
    persistScopedGenerationNodes(scope, startedNodes);

    // Frontend-only Seedance 2.0 audit gate. It blocks the real request only when the
    // designated prototype image is present, then marks the exact source image node.
    try {
      if (isVideoNode && (node.model === 'Seedance 2.0' || node.model === 'Seedance 2.0 Fast')) {
          const auditMedia = (videoMode === 'start_end' ? connectedImages : selectedVideoMedia)
              .filter((item): item is InputMedia => item.type === 'image' && Boolean(item.sourceNodeId));
          const uniqueAuditMedia = Array.from(new Map<string, InputMedia>(
              auditMedia.map(item => [item.sourceNodeId as string, item] as const),
          ).values());

          if (uniqueAuditMedia.length > 0) {
              const auditNodeIds = new Set(uniqueAuditMedia.map(item => item.sourceNodeId as string));
              const auditingNodes = nodesRef.current.map(candidate => auditNodeIds.has(candidate.id) ? {
                  ...candidate,
                  auditStatus: 'auditing',
                  auditFailureReason: undefined,
                  auditErrorDetail: undefined,
              } : candidate);
              nodesRef.current = auditingNodes;
              setNodes(auditingNodes);

              await new Promise(resolve => window.setTimeout(resolve, 650));
              const auditResults = await Promise.all(uniqueAuditMedia.map(async item => {
                  const sourceNode = nodesRef.current.find(candidate => candidate.id === item.sourceNodeId);
                  return {
                      nodeId: item.sourceNodeId as string,
                      failed: await isMockRejectedAuditImage(item, sourceNode),
                  };
              }));
              const failedNodeIds = new Set(auditResults.filter(result => result.failed).map(result => result.nodeId));

              const auditedNodes = nodesRef.current.map(candidate => {
                  if (!auditNodeIds.has(candidate.id)) return candidate;
                  if (failedNodeIds.has(candidate.id)) {
                      return {
                          ...candidate,
                          auditStatus: 'failed',
                          auditFailureReason: MOCK_AUDIT_REASON,
                          auditErrorDetail: MOCK_AUDIT_ERROR_DETAIL,
                      };
                  }
                  return {
                      ...candidate,
                      auditStatus: 'passed',
                      auditFailureReason: undefined,
                      auditErrorDetail: undefined,
                  };
              });
              nodesRef.current = auditedNodes;
              setNodes(auditedNodes);

              if (failedNodeIds.size > 0) {
                  updateGenerationNode(scope, {
                      isLoading: false,
                      errorMessage: undefined,
                      auditFailureReason: MOCK_AUDIT_REASON,
                      auditErrorDetail: MOCK_AUDIT_ERROR_DETAIL,
                      generationTask: {
                          ...task,
                          status: 'failed',
                          errorMessage: '审核未通过',
                          errorDetail: MOCK_AUDIT_ERROR_DETAIL,
                          updatedAt: Date.now(),
                      },
                      creditEstimate,
                      creditStatus: 'refunded',
                  });
                  setAuditFailureNotice({ count: failedNodeIds.size });
                  return;
              }
          }
      }

      // Debug: Log input images for troubleshooting
      console.log(`[Generation] Node: ${node.title} (${node.type}), Input Images:`, inputs.length > 0 ? inputs.map(i => i.substring(0, 50) + '...') : 'None');

      if (node.type === NodeType.CREATIVE_DESC) {
          const res = await generateCreativeDescription(node.prompt || '', node.model === 'TEXT_TO_VIDEO' ? 'VIDEO' : 'IMAGE', node.model);
          if (isGenerationScopeCurrent(scope)) {
              const current = nodesRef.current.find(candidate => candidate.id === nodeId);
              updateGenerationNode(scope, {
                  textContent: res,
                  optimizedPrompt: res,
                  textVersions: mergeTextVersionSnapshots(
                      createTextVersionSnapshot(res, node, 'generate'),
                      current?.textVersions || node.textVersions,
                  ),
                  isLoading: false,
                  generationTask: { ...task, status: 'succeeded', updatedAt: Date.now() },
                  creditEstimate,
                  creditStatus: 'confirmed',
              });
          }
      } else if (node.type === NodeType.TEXT_TO_IMAGE) {
          const result = await generateImageWithMetadata(
              node.prompt || '', node.aspectRatio, node.model, node.resolution, node.count || 1, inputs, false,
          );
          if (!applyGeneratedResults(scope, node, result.urls, result.mock ? 'mock' : 'provider', creditEstimate)) {
              if (!isGenerationScopeCurrent(scope)) return;
              throw new Error('未返回结果');
          }
      } else if (node.type === NodeType.TEXT_TO_AUDIO) {
          const result = await generateAudioWithMetadata(
              node.prompt || '',
              node.model,
              node.voiceId,
              node.voiceSpeed || 1,
              node.voicePitch || 0,
              node.voiceVolume || 1,
          );
          if (!applyGeneratedResults(scope, node, result.urls, result.mock ? 'mock' : 'provider', creditEstimate)) {
              if (!isGenerationScopeCurrent(scope)) return;
              throw new Error('未返回结果');
          }
      } else if (isVideoNode) {
          const selectedImages = videoMode === 'start_end'
              ? connectedImages.map(item => item.url)
              : selectedVideoMedia.filter(item => item.type === 'image').map(item => item.url);
          const orderedInputs = videoMode === 'start_end' && node.swapFrames && selectedImages.length >= 2
              ? [selectedImages[1], selectedImages[0], ...selectedImages.slice(2)]
              : selectedImages;
          const results = await generateVideo(
              node.prompt || '',
              orderedInputs,
              node.aspectRatio,
              node.model,
              node.resolution,
              node.duration,
              node.count || 1,
              false,
              {
                  mode: videoMode,
                  inputMedia: selectedVideoMedia,
                  onTaskCreated: (taskIds, provider) => {
                      const current = nodesRef.current.find(candidate => candidate.id === nodeId);
                      setGenerationTask(scope, {
                          status: 'queued',
                          provider: provider || current?.generationTask?.provider,
                          providerTaskIds: taskIds,
                          providerTaskStatuses: {},
                          providerTaskProgress: {},
                      });
                  },
                  onStatus: (update: VideoTaskStatusUpdate) => {
                      const current = nodesRef.current.find(candidate => candidate.id === nodeId);
                      const statuses = { ...(current?.generationTask?.providerTaskStatuses || {}), [update.taskId]: update.status };
                      const progresses = { ...(current?.generationTask?.providerTaskProgress || {}) };
                      if (update.progress !== undefined) progresses[update.taskId] = update.progress;
                      setGenerationTask(scope, {
                          status: update.status === 'timed_out' ? 'timed_out' : update.status === 'failed' ? 'failed' : 'running',
                          providerStatus: update.providerStatus,
                          progress: update.progress,
                          providerTaskStatuses: statuses,
                          providerTaskProgress: progresses,
                          errorDetail: update.errorDetail || current?.generationTask?.errorDetail,
                      });
                  },
              },
          );
          if (!applyGeneratedResults(scope, node, results, 'provider', creditEstimate)) {
              if (!isGenerationScopeCurrent(scope)) return;
              throw new Error('未返回结果');
          }
      } else {
          throw new Error('未返回结果');
      }
    } catch (error) {
      console.error(error);
      markGenerationFailure(scope, error, creditEstimate);
    } finally {
      releaseGeneration(scope);
    }
  };

  const recoverVideoGeneration = (scope: GenerationScope, task: GenerationTaskState) => {
      const taskIds = Array.from(new Set(task.providerTaskIds || [])).filter(Boolean);
      if (!taskIds.length || !isGenerationScopeCurrent(scope)) return;
      const key = generationScopeKey(scope);
      activeGenerationKeysRef.current.add(key);
      generationNodeLocksRef.current.add(generationTargetKey(scope));
      recoveryStartedKeysRef.current.add(key);
      updateGenerationNode(scope, {
          isLoading: true,
          errorMessage: undefined,
          generationTask: {
              ...task,
              status: 'running',
              errorMessage: undefined,
              updatedAt: Date.now(),
          },
      });
      const target = nodesRef.current.find(node => node.id === scope.nodeId);
      if (!target) {
          releaseGeneration(scope);
          return;
      }
      const snapshotNode: NodeData = {
          ...target,
          prompt: task.inputSnapshot.prompt ?? target.prompt,
          model: task.inputSnapshot.model ?? target.model,
          aspectRatio: task.inputSnapshot.aspectRatio ?? target.aspectRatio,
          resolution: task.inputSnapshot.resolution ?? target.resolution,
          duration: task.inputSnapshot.duration ?? target.duration,
          count: task.inputSnapshot.count ?? target.count,
          videoMode: task.inputSnapshot.videoMode ?? target.videoMode,
      };
      Promise.all(taskIds.map(taskId => resumeVideoTask(taskId, (update: VideoTaskStatusUpdate) => {
          const current = nodesRef.current.find(node => node.id === scope.nodeId);
          const statuses = { ...(current?.generationTask?.providerTaskStatuses || {}), [update.taskId]: update.status };
          const progresses = { ...(current?.generationTask?.providerTaskProgress || {}) };
          if (update.progress !== undefined) progresses[update.taskId] = update.progress;
          setGenerationTask(scope, {
              status: update.status === 'timed_out' ? 'timed_out' : update.status === 'failed' ? 'failed' : 'running',
              providerStatus: update.providerStatus,
              progress: update.progress,
              providerTaskStatuses: statuses,
              providerTaskProgress: progresses,
              errorDetail: update.errorDetail || current?.generationTask?.errorDetail,
          });
      }))).then(results => {
          applyGeneratedResults(scope, snapshotNode, results, 'provider', target.creditEstimate || getEstimatedCredits(target));
      }).catch(error => {
          markGenerationFailure(scope, error, target.creditEstimate || getEstimatedCredits(target));
      }).finally(() => {
          releaseGeneration(scope);
      });
  };

  useEffect(() => {
      if (!currentProject?.id || !activeSubCanvasId) return;
      nodes.forEach(node => {
          const task = node.generationTask;
          if (!task || task.kind !== 'video' || !RECOVERABLE_GENERATION_STATUSES.includes(task.status)) return;
          const scope: GenerationScope = {
              projectId: currentProject.id,
              canvasId: activeSubCanvasId,
              nodeId: node.id,
              operationId: task.operationId,
          };
          const key = generationScopeKey(scope);
          const taskIds = Array.from(new Set(task.providerTaskIds || [])).filter(Boolean);
          if (activeGenerationKeysRef.current.has(key) || recoveryStartedKeysRef.current.has(key)) return;
          if (!taskIds.length) {
              if (task.status === 'submitting' && task.startedAt < sessionStartedAtRef.current) {
                  updateGenerationNode(scope, {
                      isLoading: false,
                      errorMessage: '提交未确认，未拿到任务编号，请核对后再生成',
                      generationTask: {
                          ...task,
                          status: 'needs_check',
                          errorMessage: '提交未确认，未拿到任务编号，请核对后再生成',
                          errorDetail: task.errorDetail || '刷新时未发现供应商任务编号，未自动重建请求',
                          updatedAt: Date.now(),
                      },
                  });
              }
              return;
          }
          recoveryStartedKeysRef.current.add(key);
          recoverVideoGeneration(scope, task);
      });
  }, [currentProject?.id, activeSubCanvasId, nodes]);

  const handleAnalyzeMedia = async (nodeId: string) => {
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      const inputMedia = getInputMedia(node.id).filter(item => item.type === 'image' || item.type === 'video');
      if (!inputMedia.length) {
          alert("请先把图片或视频节点连接到文本节点前面");
          return;
      }

      const creditEstimate = node.creditEstimate || getEstimatedCredits(node);
      updateNodeData(nodeId, { isLoading: true, creditEstimate, creditStatus: 'reserved' });
      try {
          const text = await analyzeConnectedMedia(node.prompt || '', inputMedia, node.model);
          updateNodeData(nodeId, {
              textContent: text,
              optimizedPrompt: text,
              textVersions: mergeTextVersionSnapshots(
                  createTextVersionSnapshot(text, node, 'media_analysis'),
                  node.textVersions
              ),
              isLoading: false,
              creditEstimate,
              creditStatus: 'confirmed'
          });
      } catch (e) {
          console.error(e);
          alert(`分析失败: ${(e as Error).message}`);
          updateNodeData(nodeId, { isLoading: false, creditEstimate, creditStatus: 'refunded' });
      }
  };

  const handleAnalyzeScript = async (nodeId: string) => {
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      if (!node.prompt?.trim()) {
          alert("请先在文本节点里输入或粘贴剧本内容");
          return;
      }

      const creditEstimate = node.creditEstimate || getEstimatedCredits(node);
      updateNodeData(nodeId, { isLoading: true, creditEstimate, creditStatus: 'reserved' });
      try {
          const text = await analyzeScriptAssets(node.prompt, node.model);
          updateNodeData(nodeId, {
              textContent: text,
              optimizedPrompt: text,
              textVersions: mergeTextVersionSnapshots(
                  createTextVersionSnapshot(text, node, 'script_analysis'),
                  node.textVersions
              ),
              isLoading: false,
              creditEstimate,
              creditStatus: 'confirmed'
          });
      } catch (e) {
          console.error(e);
          alert(`剧本分析失败: ${(e as Error).message}`);
          updateNodeData(nodeId, { isLoading: false, creditEstimate, creditStatus: 'refunded' });
      }
  };

  const handleMaximize = (nodeId: string) => {
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      if (node.videoSrc) setPreviewMedia({ url: node.videoSrc, type: 'video' });
      else if (node.imageSrc) setPreviewMedia({ url: node.imageSrc, type: 'image' });
      else alert("没有可预览的内容");
  };

  const openSaveResultModal = (nodeId: string) => {
      const node = nodes.find(n => n.id === nodeId) || deletedNodes.find(n => n.id === nodeId);
      if (!node) return;
      const url = node.videoSrc || node.imageSrc;
      if (!url) {
          alert('当前节点没有可保存的结果');
          return;
      }
      const type = node.videoSrc ? 'video' : 'image';
      setSaveResultTarget({ nodeId, url, type, title: node.title });
      setSaveResultName(node.title || (type === 'video' ? '视频素材' : '图片素材'));
      setSaveResultMode('material');
      setSaveAssetType('role');
      setSaveTargetAssetId(DEMO_ASSET_LIBRARY[0]?.id || '');
      setSaveResultNote('');
  };

  const handleConfirmSaveResult = () => {
      if (!saveResultTarget) return;
      const selectedAsset = DEMO_ASSET_LIBRARY.find(asset => asset.id === saveTargetAssetId);
      const title = saveResultName.trim() || saveResultTarget.title;
      const updates: Partial<NodeData> = {
          title,
          outputArtifacts: [
              saveResultTarget.url,
              ...((nodes.find(node => node.id === saveResultTarget.nodeId) || deletedNodes.find(node => node.id === saveResultTarget.nodeId))?.outputArtifacts || []).filter(item => item !== saveResultTarget.url),
          ],
      };

      if (saveResultMode === 'new_asset') {
          updates.source = 'asset_library';
          updates.sourceRefId = `new_${saveAssetType}_${Date.now()}`;
      }
      if (saveResultMode === 'update_asset' && selectedAsset) {
          updates.source = 'asset_library';
          updates.sourceRefId = selectedAsset.id;
      }

      const nextNodes = nodes.map(node => node.id === saveResultTarget.nodeId ? { ...node, ...updates } : node);
      if (nextNodes.some(node => node.id === saveResultTarget.nodeId)) {
          setNodes(nextNodes);
          handleSaveProject(currentProject, nextNodes);
      } else {
          handleSaveProject();
      }
      const actionText = saveResultMode === 'material'
          ? '已保存到项目素材'
          : saveResultMode === 'new_asset'
              ? '已保存为新资产'
              : `已更新资产版本：${selectedAsset?.name || '未选择资产'}`;
      alert(`${actionText}\n\n原型说明：当前为前端演示保存状态，正式系统会调用素材库/资产库接口并保留历史版本。`);
      setSaveResultTarget(null);
  };
  
  const handleHistoryPreview = (url: string, type: 'image' | 'video') => setPreviewMedia({ url, type });

  const resolveSecondaryEditSource = (node: NodeData) => {
      if (node.errorMessage && node.editRootNodeId) {
          return nodes.find(candidate => candidate.id === node.editRootNodeId) || node;
      }
      return node;
  };

  const getDerivedNodePosition = (source: NodeData, width = source.width, height = source.height) => {
      let x = source.x + source.width + 90;
      let y = source.y;
      while (nodes.some(node =>
          Math.abs(node.x - x) < Math.max(48, Math.min(width, node.width) * 0.18) &&
          Math.abs(node.y - y) < Math.max(48, Math.min(height, node.height) * 0.18)
      )) {
          y += 64;
      }
      return { x, y };
  };

  const getStackedEditBadges = (source: NodeData, badge: string) => (
      Array.from(new Set([...(source.editBadges || []), badge]))
  );

  const createDerivedConnection = (source: NodeData, targetId: string): Connection => ({
      id: generateId(),
      sourceId: source.id,
      targetId,
  });

  const buildImageEditNode = (
      sourceNode: NodeData,
      badge: string,
      title: string,
      overrides: Partial<NodeData> = {}
  ): NodeData => {
      const source = resolveSecondaryEditSource(sourceNode);
      const aspectRatio = overrides.aspectRatio || source.aspectRatio || '1:1';
      const size = getNodeSizeForAspectRatio(aspectRatio);
      const width = overrides.width || size.width;
      const height = overrides.height || size.height;
      const position = getDerivedNodePosition(source, width, height);
      return {
          id: generateId(),
          type: NodeType.TEXT_TO_IMAGE,
          x: position.x,
          y: position.y,
          width,
          height,
          title: title.slice(0, 24),
          aspectRatio,
          model: overrides.model || source.model || 'Seedream 5.0',
          resolution: overrides.resolution || source.resolution || '1k',
          count: overrides.count || 1,
          prompt: overrides.prompt ?? source.prompt ?? '',
          imageSrc: overrides.imageSrc,
          outputArtifacts: overrides.outputArtifacts || (overrides.imageSrc ? [overrides.imageSrc] : []),
          imageVersions: overrides.imageVersions,
          isLoading: overrides.isLoading,
          errorMessage: overrides.errorMessage,
          creditEstimate: overrides.creditEstimate,
          creditStatus: overrides.creditStatus,
          editBadges: getStackedEditBadges(source, badge),
          editRootNodeId: source.editRootNodeId || source.id,
          editParentNodeId: source.id,
          source: 'canvas',
          projectId: source.projectId || currentProject?.id || DEMO_PROJECT_META.id,
          canvasId: source.canvasId,
          directorGroupName: source.directorGroupName || currentProject?.directorGroup || DEMO_PROJECT_META.directorGroup,
      };
  };

  const buildVideoEditNode = (
      sourceNode: NodeData,
      badge: string,
      title: string,
      overrides: Partial<NodeData> = {}
  ): NodeData => {
      const source = resolveSecondaryEditSource(sourceNode);
      const width = overrides.width || source.width;
      const height = overrides.height || source.height;
      const position = getDerivedNodePosition(source, width, height);
      return {
          ...source,
          ...overrides,
          id: generateId(),
          x: position.x,
          y: position.y,
          width,
          height,
          title: title.slice(0, 24),
          outputArtifacts: overrides.outputArtifacts || [],
          isStackOpen: false,
          auditStatus: undefined,
          auditFailureReason: undefined,
          auditErrorDetail: undefined,
          editBadges: getStackedEditBadges(source, badge),
          editRootNodeId: source.editRootNodeId || source.id,
          editParentNodeId: source.id,
      };
  };

  const handleSetImageVersion = (nodeId: string, version: ImageVersionSnapshot) => {
      const source = nodesRef.current.find(node => node.id === nodeId);
      if (!source) return;
      invalidateGenerationForNode(nodeId);
      const { width, height } = getNodeSizeForAspectRatio(version.aspectRatio);
      updateNodeData(nodeId, {
          imageSrc: version.url,
          prompt: version.prompt,
          model: version.model,
          aspectRatio: version.aspectRatio,
          resolution: version.resolution,
          count: version.count,
          promptOptimize: version.promptOptimize,
          width,
          height,
          resultSource: source.artifactSources?.[version.url] || 'unknown',
          generationTask: undefined,
      });
  };

  const handleSetVideoVersion = (nodeId: string, src: string) => {
      const source = nodesRef.current.find(node => node.id === nodeId);
      if (!source) return;
      invalidateGenerationForNode(nodeId);
      updateNodeData(nodeId, {
          videoSrc: src,
          resultSource: source.artifactSources?.[src] || 'unknown',
          generationTask: undefined,
      });
  };

  const handleUseImageVersion = (nodeId: string, version: ImageVersionSnapshot) => {
      const source = nodes.find(node => node.id === nodeId);
      if (!source) return;

      const { width, height } = getNodeSizeForAspectRatio(version.aspectRatio);
      let x = source.x + source.width + 80;
      let y = source.y;
      while (nodes.some(node =>
          Math.abs(node.x - x) < 48 &&
          Math.abs(node.y - y) < 48
      )) {
          y += 56;
      }

      const newNode: NodeData = {
          id: generateId(),
          type: NodeType.TEXT_TO_IMAGE,
          x,
          y,
          width,
          height,
          title: source.title,
          prompt: version.prompt,
          imageSrc: version.url,
          outputArtifacts: [version.url],
          imageVersions: [version],
          aspectRatio: version.aspectRatio,
          resolution: version.resolution,
          count: version.count,
          model: version.model,
          promptOptimize: version.promptOptimize,
          resultSource: source.artifactSources?.[version.url] || 'unknown',
          artifactSources: source.artifactSources,
          source: 'canvas',
          projectId: source.projectId || currentProject?.id || DEMO_PROJECT_META.id,
          canvasId: source.canvasId,
          directorGroupName: source.directorGroupName || currentProject?.directorGroup || DEMO_PROJECT_META.directorGroup,
      };

      addCreatedCanvasItems([newNode]);
      setSelectedNodeIds(new Set([newNode.id]));
  };

  // "复制并新建" for video history versions: clone the source video node to the right,
  // keeping all generation params, with the chosen version as its active result.
  const handleUseVideoVersion = (nodeId: string, src: string) => {
      const source = nodes.find(node => node.id === nodeId);
      if (!source) return;

      let x = source.x + source.width + 80;
      let y = source.y;
      while (nodes.some(node =>
          Math.abs(node.x - x) < 48 &&
          Math.abs(node.y - y) < 48
      )) {
          y += 56;
      }

      const newNode: NodeData = {
          ...source,
          id: generateId(),
          x,
          y,
          videoSrc: src,
          outputArtifacts: [src],
          resultSource: source.artifactSources?.[src] || 'unknown',
          artifactSources: source.artifactSources,
          isStackOpen: false,
          isLoading: false,
          auditStatus: undefined,
      };

      addCreatedCanvasItems([newNode]);
      setSelectedNodeIds(new Set([newNode.id]));
  };

  const createPrototypeVideoEdit = (nodeId: string, badge: string, titlePrefix: string, creditEstimate = 4) => {
      const requestedSource = nodes.find(n => n.id === nodeId);
      const source = requestedSource ? resolveSecondaryEditSource(requestedSource) : undefined;
      if (!source?.videoSrc) {
          alert("当前节点没有可编辑的视频");
          return;
      }
      const editNode = buildVideoEditNode(source, badge, `${titlePrefix}_${source.title}`, {
          videoSrc: undefined,
          outputArtifacts: [],
          isLoading: true,
          errorMessage: undefined,
          creditEstimate,
          creditStatus: 'reserved',
      });
      addCreatedCanvasItems([editNode], [createDerivedConnection(source, editNode.id)], '新建节点');
      setSelectedNodeIds(new Set([editNode.id]));
      window.setTimeout(() => {
          updateNodeData(editNode.id, {
              videoSrc: source.videoSrc,
              outputArtifacts: [source.videoSrc!],
              isLoading: false,
              errorMessage: undefined,
              creditStatus: 'confirmed',
          });
      }, 450);
  };

  const handleRemoveSubtitlesEdit = (nodeId: string) => {
      createPrototypeVideoEdit(nodeId, '去字幕', '去字幕', 4);
  };

  const handleEnhanceVideoEdit = (nodeId: string) => {
      createPrototypeVideoEdit(nodeId, '高清修复', '高清修复', 6);
  };

  const handleRemoveBGMEdit = (nodeId: string) => {
      createPrototypeVideoEdit(nodeId, '去BGM', '去BGM', 4);
  };

  const handlePreviewReference = (item: InputMedia) => {
      if (item.type === 'text') {
          setPreviewText({ title: item.title || '参考文本', text: item.text || '' });
          return;
      }
      setPreviewMedia({ url: item.url, type: item.type, title: item.title });
  };

  const handleOpenVideoEdit = (nodeId: string) => {
      const requestedSource = nodes.find(node => node.id === nodeId);
      const source = requestedSource ? resolveSecondaryEditSource(requestedSource) : undefined;
      if (!source?.videoSrc) {
          alert('当前节点没有可编辑的视频');
          return;
      }
      setVideoEditTarget({ nodeId: source.id, videoSrc: source.videoSrc, title: source.title });
  };

  const handleVideoEditSubmit = (request: VideoEditRequest) => {
      const requestedSource = nodes.find(node => node.id === videoEditTarget?.nodeId);
      const source = requestedSource ? resolveSecondaryEditSource(requestedSource) : undefined;
      if (!source?.videoSrc) {
          setVideoEditTarget(null);
          alert('原视频已不存在，请重新打开视频编辑');
          return;
      }

      console.info('[VideoEditMock] request', {
          sourceVideoUrl: request.sourceVideoUrl,
          prompt: request.prompt,
          scope: request.scope,
          anchors: request.anchors.map(anchor => ({
              timeSeconds: anchor.timeSeconds,
              timecode: anchor.timecode,
              estimatedFrame: anchor.estimatedFrame,
              hasOriginalFrame: Boolean(anchor.originalFrameDataUrl),
              hasMask: Boolean(anchor.maskDataUrl),
              hasAnnotatedPreview: Boolean(anchor.annotatedFrameDataUrl),
          })),
      });

      const editNode = buildVideoEditNode(source, '视频编辑·模拟', `视频编辑_${source.title}`, {
          videoSrc: undefined,
          outputArtifacts: [],
          prompt: request.prompt,
          isLoading: true,
          errorMessage: undefined,
          creditEstimate: 6,
          creditStatus: 'reserved',
      });
      addCreatedCanvasItems([editNode], [createDerivedConnection(source, editNode.id)], '新建节点');
      setSelectedNodeIds(new Set([editNode.id]));
      setVideoEditTarget(null);

      window.setTimeout(() => {
          updateNodeData(editNode.id, {
              videoSrc: source.videoSrc,
              outputArtifacts: [source.videoSrc],
              isLoading: false,
              errorMessage: undefined,
              creditStatus: 'confirmed',
          });
      }, 900);
  };

  const handleCropStart = (nodeId: string) => {
      const node = nodes.find(n => n.id === nodeId);
      const source = node ? resolveSecondaryEditSource(node) : undefined;
      if (!source?.imageSrc) {
          alert("当前节点没有可裁剪的图片");
          return;
      }
      setCropTarget({ nodeId: source.id, imageSrc: source.imageSrc, title: source.title, aspectRatio: source.aspectRatio || '1:1' });
  };

  const handleCropConfirm = (croppedSrc: string, naturalWidth: number, naturalHeight: number, aspectRatio: string) => {
      void naturalWidth;
      void naturalHeight;
      if (!cropTarget) return;
      const source = nodes.find(n => n.id === cropTarget.nodeId);
      if (!source) {
          setCropTarget(null);
          return;
      }
      const newNode = buildImageEditNode(source, '裁剪', `裁剪_${cropTarget.title}`, {
          imageSrc: croppedSrc,
          aspectRatio,
          outputArtifacts: [croppedSrc],
      });

      addCreatedCanvasItems([newNode], [createDerivedConnection(resolveSecondaryEditSource(source), newNode.id)], '新建节点');
      setSelectedNodeIds(new Set([newNode.id]));
      setCropTarget(null);
  };

  const handleMultiAngleGenerate = async (nodeId: string, options: MultiAngleOptions) => {
      const requestedSource = nodes.find(n => n.id === nodeId);
      const source = requestedSource ? resolveSecondaryEditSource(requestedSource) : undefined;
      if (!source?.imageSrc) {
          alert("当前节点没有可用于多角度控制的图片");
          return;
      }
      if (!options.angles.length) {
          alert("请至少选择一个角度");
          return;
      }

      const baseAspectRatio = options.aspectRatio && options.aspectRatio !== 'source'
          ? options.aspectRatio
          : (source.aspectRatio || '1:1');
      const placeholderTitle = `多角度_${source.title}`.slice(0, 24);
      const placeholderNode = buildImageEditNode(source, '多角度', placeholderTitle, {
          aspectRatio: baseAspectRatio,
          prompt: options.prompt || source.prompt || '',
          outputArtifacts: [],
          isLoading: true,
          errorMessage: undefined,
          creditEstimate: 4,
          creditStatus: 'reserved',
      });

      const placeholderId = placeholderNode.id;
      const placeholderConnection = createDerivedConnection(source, placeholderId);
      addCreatedCanvasItems([placeholderNode], [placeholderConnection], '新建节点');
      setSelectedNodeIds(new Set([placeholderId]));

      try {
          const results = await generateMultiAngleImages(source.imageSrc, {
              ...options,
              countPerAngle: 1,
          });
          if (!results.length) throw new Error("未返回多角度结果");

          const primary = results[0];
          updateNodeData(placeholderId, {
              title: `${primary.label || primary.angle}_${source.title}`.slice(0, 24),
              imageSrc: primary.url,
              prompt: primary.prompt || options.prompt || source.prompt || '',
              outputArtifacts: results.map(result => result.url),
              isLoading: false,
              errorMessage: undefined,
              creditEstimate: 4,
              creditStatus: 'confirmed',
          });
      } catch (e) {
          console.error(e);
          alert(`多角度生成失败: ${(e as Error).message}`);
          updateNodeData(placeholderId, {
              isLoading: false,
              errorMessage: (e as Error).message,
              creditEstimate: 4,
              creditStatus: 'refunded',
          });
      }
  };

  const createPrototypeImageEdit = (nodeId: string, badge: string, titlePrefix: string, updates: Partial<NodeData> = {}) => {
      const requestedSource = nodes.find(n => n.id === nodeId);
      const source = requestedSource ? resolveSecondaryEditSource(requestedSource) : undefined;
      if (!source?.imageSrc) {
          alert("当前节点没有可编辑的图片");
          return;
      }
      const editNode = buildImageEditNode(source, badge, `${titlePrefix}_${source.title}`, {
          ...updates,
          imageSrc: undefined,
          outputArtifacts: [],
          isLoading: true,
          errorMessage: undefined,
          creditEstimate: updates.creditEstimate || 2,
          creditStatus: 'reserved',
      });
      addCreatedCanvasItems([editNode], [createDerivedConnection(source, editNode.id)], '新建节点');
      setSelectedNodeIds(new Set([editNode.id]));
      window.setTimeout(() => {
          updateNodeData(editNode.id, {
              imageSrc: source.imageSrc,
              outputArtifacts: [source.imageSrc!],
              isLoading: false,
              errorMessage: undefined,
              creditStatus: 'confirmed',
          });
      }, 450);
  };

  const handleLightingEdit = (nodeId: string) => {
      createPrototypeImageEdit(nodeId, '打光', '打光', { creditEstimate: 2 });
  };

  const handleEnhanceImageEdit = (nodeId: string, resolution: '2K' | '4K') => {
      createPrototypeImageEdit(nodeId, '高清', `${resolution}高清`, {
          resolution,
          creditEstimate: resolution === '4K' ? 8 : 4,
      });
  };

  const copyImageToClipboard = async (nodeId: string) => {
      const node = nodes.find(n => n.id === nodeId);
      if (node && node.imageSrc) {
          try {
              const res = await fetch(node.imageSrc);
              const blob = await res.blob();
              await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob as Blob })]);
              alert("图片已复制到剪贴板");
          } catch (e) { console.error(e); alert("复制图片失败"); }
      }
  };

  const triggerReplaceImage = (nodeId: string) => {
      const node = nodes.find(n => n.id === nodeId);
      if (!node || !replaceImageRef.current) return;
      nodeToReplaceRef.current = nodeId;
      replaceImageRef.current.setAttribute('accept', UPLOAD_ACCEPT_BY_KIND[getUploadKindForNode(node.type)] ?? '*/*');
      replaceImageRef.current.value = '';
      replaceImageRef.current.click();
  };

  const handleReplaceImage = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      const nodeId = nodeToReplaceRef.current;
      if (file && nodeId) {
          const node = nodes.find(n => n.id === nodeId);
          if (!node) { /* noop */ }
          // 校验文件类型是否匹配节点类别，不匹配则拒绝
          const _kind = node ? getUploadKindForNode(node.type) : undefined;
          const _typeOk = !node || isFileCompatibleWithUploadKind(file, _kind!);
          if (!_typeOk) {
              alert('当前节点只能上传' + (UPLOAD_LABEL_BY_KIND[_kind!] || '') + '文件');
              if (replaceImageRef.current) replaceImageRef.current.value = '';
              nodeToReplaceRef.current = null;
              return;
          }
          else if (file.type.startsWith('video/') && NODE_MEDIA_CATEGORY[node.type] === 'video') {
              const url = URL.createObjectURL(file);
              const video = document.createElement('video');
              video.preload = 'metadata';
              video.onloadedmetadata = () => {
                  const aspectRatio = getClosestAspectRatio(video.videoWidth, video.videoHeight, VIDEO_ASPECT_RATIOS);
                  const nodeSize = getNodeSizeForAspectRatio(aspectRatio, VIDEO_NODE_BASE_HEIGHT);
                  const newArtifacts = mergeArtifactVersions(url, node.videoSrc, node.outputArtifacts || []);
                  recordCanvasHistory({ type: 'upload-update', label: '上传文件', beforeNodes: [node] });
                  updateNodeData(nodeId, {
                      videoSrc: url,
                      title: node.shotId ? node.title : file.name,
                      width: nodeSize.width,
                      height: nodeSize.height,
                      aspectRatio,
                      outputArtifacts: newArtifacts
                  });
              };
              video.src = url;
          } else if (file.type.startsWith('audio/') && NODE_MEDIA_CATEGORY[node.type] === 'text') {
              const url = URL.createObjectURL(file);
              recordCanvasHistory({ type: 'upload-update', label: '上传文件', beforeNodes: [node] });
              updateNodeData(nodeId, {
                  audioSrc: url,
                  title: file.name || node.title,
                  outputArtifacts: mergeArtifactVersions(url, node.audioSrc, node.outputArtifacts || []),
              });
          } else if ((file.type.startsWith('text/') || TEXT_FILE_PATTERN.test(file.name)) && node.type === NodeType.CREATIVE_DESC) {
              const reader = new FileReader();
              reader.onload = (event) => {
                  const text = String(event.target?.result || '');
                  recordCanvasHistory({ type: 'upload-update', label: '上传文件', beforeNodes: [node] });
                  updateNodeData(nodeId, {
                      title: file.name || node.title,
                      textContent: text,
                      optimizedPrompt: text,
                      textVersions: mergeTextVersionSnapshots(
                          createTextVersionSnapshot(text, { ...node, title: file.name || node.title }, 'upload'),
                          node.textVersions
                      ),
                  });
              };
              reader.readAsText(file, 'utf-8');
          } else if (file.type.startsWith('image/') && NODE_MEDIA_CATEGORY[node.type] === 'image') {
           const reader = new FileReader();
           reader.onload = (event) => {
               const img = new Image();
               img.onload = () => {
                    const aspectRatio = getClosestAspectRatio(img.width, img.height, IMAGE_ASPECT_RATIOS);
                    const { width, height } = getNodeSizeForAspectRatio(aspectRatio);
                    const src = event.target?.result as string;
                    const newArtifacts = mergeArtifactVersions(src, node.imageSrc, node.outputArtifacts || []);
                    recordCanvasHistory({ type: 'upload-update', label: '上传文件', beforeNodes: [node] });
                    updateNodeData(nodeId, {
                        imageSrc: src,
                        title: node.shotId ? node.title : (file.name || node.title),
                        width, height,
                        aspectRatio,
                        outputArtifacts: newArtifacts,
                        errorMessage: undefined,
                        auditStatus: undefined,
                        auditFailureReason: undefined,
                        auditErrorDetail: undefined,
                    });
               };
               img.src = event.target?.result as string;
           };
           reader.readAsDataURL(file);
          }
      }
      nodeToReplaceRef.current = null;
  };

  const triggerAttachInput = (nodeId: string) => {
      nodeToAttachInputRef.current = nodeId;
      const node = nodes.find(n => n.id === nodeId);
      if (attachInputRef.current && node) {
          attachInputRef.current.setAttribute('accept', UPLOAD_ACCEPT_BY_KIND[getUploadKindForNode(node.type)] ?? '*/*');
          attachInputRef.current.value = '';
          attachInputRef.current.click();
      }
  };

  const addInputSourceNode = (targetId: string, source: NodeData) => {
      const target = nodes.find(n => n.id === targetId);
      const upstreamCount = connections.filter(c => c.targetId === targetId).length;
      const x = target ? target.x - source.width - 90 : source.x;
      const y = target ? target.y + upstreamCount * 80 : source.y;
      const sourceNode = { ...source, x, y };
      const newConnection = { id: generateId(), sourceId: sourceNode.id, targetId };
      addCreatedCanvasItems([sourceNode], [newConnection], '上传文件');
      setSelectedNodeIds(new Set([targetId]));
  };

  const handleAttachInputAsset = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      const targetId = nodeToAttachInputRef.current;
      if (!file || !targetId) {
          if (attachInputRef.current) attachInputRef.current.value = '';
          nodeToAttachInputRef.current = null;
          return;
      }

      const target = nodes.find(n => n.id === targetId);
      if (!target) {
          if (attachInputRef.current) attachInputRef.current.value = '';
          nodeToAttachInputRef.current = null;
          return;
      }

      // 校验文件类型是否匹配节点类别
      const _kind = getUploadKindForNode(target.type);
      const _typeOk = isFileCompatibleWithUploadKind(file, _kind);
      if (!_typeOk) {
          alert('当前节点只能上传' + (UPLOAD_LABEL_BY_KIND[_kind] || '') + '文件');
          if (attachInputRef.current) attachInputRef.current.value = '';
          nodeToAttachInputRef.current = null;
          return;
      }

      const baseTitle = file.name || `本地素材_${new Date().toLocaleTimeString()}`;

      if (file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = (event) => {
              const img = new Image();
              img.onload = () => {
                  const aspectRatio = getClosestAspectRatio(img.width, img.height, IMAGE_ASPECT_RATIOS);
                  const { width, height } = getNodeSizeForAspectRatio(aspectRatio);
                  const src = event.target?.result as string;
                  recordCanvasHistory({ type: 'upload-update', label: '上传文件', beforeNodes: [target] });
                  updateNodeData(targetId, {
                      type: NodeType.TEXT_TO_IMAGE,
                      width,
                      height,
                      title: target.shotId ? target.title : baseTitle,
                      imageSrc: src,
                      videoSrc: undefined,
                      aspectRatio,
                      model: target.type === NodeType.TEXT_TO_IMAGE ? (target.model || 'Seedream 5.0') : 'Seedream 5.0',
                      resolution: target.resolution || '1k',
                      count: target.count || 1,
                      outputArtifacts: [
                          src,
                          ...(target.type === NodeType.TEXT_TO_IMAGE ? (target.outputArtifacts || []).filter(item => item !== src) : []),
                      ],
                  });
              };
              img.src = event.target?.result as string;
          };
          reader.readAsDataURL(file);
      } else if (file.type.startsWith('video/')) {
          const url = URL.createObjectURL(file);
          const video = document.createElement('video');
          video.preload = 'metadata';
          video.onloadedmetadata = () => {
              const aspectRatio = getClosestAspectRatio(video.videoWidth, video.videoHeight, VIDEO_ASPECT_RATIOS);
              const { width, height } = getNodeSizeForAspectRatio(aspectRatio, VIDEO_NODE_BASE_HEIGHT);
              recordCanvasHistory({ type: 'upload-update', label: '上传文件', beforeNodes: [target] });
              updateNodeData(targetId, {
                  type: NodeType.TEXT_TO_VIDEO,
                  width,
                  height,
                  title: target.shotId ? target.title : baseTitle,
                  videoSrc: url,
                  imageSrc: undefined,
                  aspectRatio,
                  model: target.type === NodeType.TEXT_TO_VIDEO || target.type === NodeType.START_END_TO_VIDEO ? (target.model || 'Seedance 1.5 Pro') : 'Seedance 1.5 Pro',
                  resolution: target.resolution || '720p',
                  duration: target.duration || '5s',
                  count: target.count || 1,
                  outputArtifacts: [
                      url,
                      ...((target.type === NodeType.TEXT_TO_VIDEO || target.type === NodeType.START_END_TO_VIDEO) ? (target.outputArtifacts || []).filter(item => item !== url) : []),
                  ],
              });
          };
          video.src = url;
      } else if (file.type.startsWith('audio/')) {
          const url = URL.createObjectURL(file);
          recordCanvasHistory({ type: 'upload-update', label: '上传文件', beforeNodes: [target] });
          updateNodeData(targetId, {
              type: NodeType.TEXT_TO_AUDIO,
              width: 420,
              height: 260,
              title: target.shotId ? target.title : baseTitle,
              audioSrc: url,
              imageSrc: undefined,
              videoSrc: undefined,
              aspectRatio: undefined,
              model: target.type === NodeType.TEXT_TO_AUDIO ? (target.model || 'Minimax-speech-2.8-hd') : 'Minimax-speech-2.8-hd',
              outputArtifacts: [
                  url,
                  ...(target.type === NodeType.TEXT_TO_AUDIO ? (target.outputArtifacts || []).filter(item => item !== url) : []),
              ],
              isLoading: false,
              errorMessage: undefined,
          });
      } else {
          const reader = new FileReader();
          reader.onload = (event) => {
              const text = String(event.target?.result || '');
              recordCanvasHistory({ type: 'upload-update', label: '上传文件', beforeNodes: [target] });
              updateNodeData(targetId, {
                  type: target.type === NodeType.CREATIVE_DESC ? NodeType.CREATIVE_DESC : target.type,
                  title: target.shotId ? target.title : baseTitle,
                  prompt: target.type === NodeType.CREATIVE_DESC ? target.prompt : text,
                  textContent: target.type === NodeType.CREATIVE_DESC ? text : target.textContent,
                  optimizedPrompt: target.type === NodeType.CREATIVE_DESC ? text : target.optimizedPrompt,
                  textVersions: target.type === NodeType.CREATIVE_DESC
                      ? mergeTextVersionSnapshots(
                          createTextVersionSnapshot(text, { ...target, title: baseTitle }, 'upload'),
                          target.textVersions
                      )
                      : target.textVersions,
              });
          };
          reader.readAsText(file, 'utf-8');
      }

      if (attachInputRef.current) attachInputRef.current.value = '';
      nodeToAttachInputRef.current = null;
  };

  const persistProjectSummaries = (nextProjects: ProjectDashboardItem[]) => {
      setProjects(nextProjects);
      try {
          localStorage.setItem(KC_PROJECT_SUMMARIES_KEY, JSON.stringify(nextProjects));
      } catch (error) {
          console.error(error);
      }
  };

  const handleSaveProject = (project = currentProject, snapshotNodes = nodes) => {
      if (!project) return false;
      setSaveStatus('saving');
      try {
          const savedAt = new Date().toLocaleString('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
          });
           const projectSnapshot = {
               nodes: snapshotNodes,
               connections,
               transform,
               groups,
              projectName,
              deletedNodes,
              savedAt,
              version: '1.0',
          };
          localStorage.setItem(`${KC_PROJECT_STORAGE_PREFIX}${project.id}`, JSON.stringify(projectSnapshot));
          const savedProject = { ...project, canvasName: projectName, lastSavedAt: savedAt };
          const nextProjects = projects.some(item => item.id === project.id)
              ? projects.map(item => item.id === project.id ? savedProject : item)
              : [savedProject, ...projects];
          persistProjectSummaries(nextProjects);
          setCurrentProject(prev => prev ? { ...prev, canvasName: projectName, lastSavedAt: savedAt } : prev);
          setSaveStatus('saved');
          window.setTimeout(() => setSaveStatus('idle'), 1400);
          return true;
      } catch (error) {
          console.error(error);
          setSaveStatus('failed');
          return false;
      }
  };

  const clearCanvasState = (nextProjectName = `${DEMO_PROJECT_META.name} 无限画布`) => {
      const withContent = nodes.filter(n => n.imageSrc || n.videoSrc);
      if (withContent.length > 0) setDeletedNodes(prev => [...prev, ...withContent]);
      clearCanvasHistory();
       setNodes([]);
       setConnections([]);
       setGroups([]);
      setTransform({ x: 0, y: 0, k: 1 });
      setProjectName(nextProjectName);
      setSelectedNodeIds(new Set());
      setSelectionBox(null);
      setSelectedConnectionId(null);
  };

  const openProject = (project: ProjectDashboardItem) => {
      clearCanvasHistory();
      let loaded = false;
      try {
          const saved = localStorage.getItem(`${KC_PROJECT_STORAGE_PREFIX}${project.id}`);
          if (saved) {
              const data = JSON.parse(saved);
               setNodes(Array.isArray(data.nodes) ? data.nodes : []);
               setConnections(Array.isArray(data.connections) ? data.connections : []);
               setGroups(normalizeNodeGroups(Array.isArray(data.groups) ? data.groups : [], Array.isArray(data.nodes) ? data.nodes : []));
              setDeletedNodes(Array.isArray(data.deletedNodes) ? data.deletedNodes : []);
              setTransform(data.transform || { x: 0, y: 0, k: 1 });
              setProjectName(data.projectName || project.canvasName);
              loaded = true;
          }
      } catch (error) {
          console.error(error);
      }
      if (!loaded) {
           setNodes([]);
           setConnections([]);
           setGroups([]);
          setDeletedNodes([]);
          setTransform({ x: 0, y: 0, k: 1 });
          setProjectName(project.canvasName);
      }
      setCurrentProject(project);
      setSelectedNodeIds(new Set());
      setSelectedConnectionId(null);
      setSelectionBox(null);
      setContextMenu(null);
      setQuickAddMenu(null);
      setSaveStatus('idle');
  };

  const createProject = () => {
      const now = Date.now();
      const newProject: ProjectDashboardItem = {
          id: `KC-DRAMA-${now}`,
          name: `新项目 ${projects.length + 1}`,
          canvasName: `新项目 ${projects.length + 1} 无限画布`,
          directorGroup: '未分组',
          projectType: '短剧',
          status: 'draft',
          episodeCount: 0,
          shotCount: 0,
          assetCount: 0,
          lastSavedAt: '未保存',
      };
      const nextProjects = [newProject, ...projects];
      persistProjectSummaries(nextProjects);
      openProject(newProject);
  };

  const deleteProject = (project: ProjectDashboardItem, event?: React.MouseEvent) => {
      event?.stopPropagation();
      const isDefaultProject = DEFAULT_PROJECTS.some(item => item.id === project.id);
      if (isDefaultProject) {
          window.alert('内置演示项目不能删除。');
          return;
      }
      if (!window.confirm(`确定删除项目「${project.name}」吗？\n\n该操作会清除本机保存的项目画布和子画布数据。`)) return;

      try {
          const projectStorageKey = `${KC_PROJECT_STORAGE_PREFIX}${project.id}`;
          const subCanvasStorageKey = getSubCanvasStorageKey(project.id);
          localStorage.removeItem(projectStorageKey);
          localStorage.removeItem(subCanvasStorageKey);
          blockedSubCanvasStorageKeysRef.current.delete(subCanvasStorageKey);
      } catch (error) {
          console.error(error);
      }

      const nextProjects = projects.filter(item => item.id !== project.id);
      persistProjectSummaries(nextProjects);
      if (currentProject?.id === project.id) {
          setCurrentProject(null);
          clearCanvasState();
      }
  };

  const returnToProjectManagement = () => {
      handleSaveProject();
      setCurrentProject(null);
  };

  const handleNewWorkflow = () => setShowNewWorkflowDialog(true);
  
  const handleConfirmNew = (shouldSave: boolean) => {
    if (shouldSave) handleSaveProject();
    clearCanvasState(currentProject?.canvasName || `${DEMO_PROJECT_META.name} 无限画布`);
    setShowNewWorkflowDialog(false);
  };

  const handleLoadWorkflow = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const data = JSON.parse(event.target?.result as string);
            if (data.nodes && data.connections) {
                setNodes(data.nodes);
                setConnections(data.connections);
                setGroups(normalizeNodeGroups(Array.isArray(data.groups) ? data.groups : [], data.nodes));
                if (data.transform) setTransform(data.transform);
                if (data.projectName) setProjectName(data.projectName);
            }
        } catch (err) { console.error(err); alert("Invalid workflow file"); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleDownload = async (nodeId: string) => {
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      const url = node.videoSrc || node.audioSrc || node.imageSrc;
      if (!url) { alert("No content to download."); return; }
      
      const ext = node.videoSrc ? 'mp4' : (node.audioSrc ? 'mp3' : 'png');
      const filename = `${node.title.replace(/\s+/g, '_')}_${Date.now()}.${ext}`;

      try {
          const response = await fetch(url);
          const blob = await response.blob();
          
          // Try storage service first
          const saved = await storageService.saveFile(blob, filename);
          if (saved) return;

          const blobUrl = URL.createObjectURL(blob as Blob);
          const link = document.createElement('a');
          link.href = blobUrl;
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(blobUrl);
      } catch (e) {
          const link = document.createElement('a');
          link.href = url;
          link.download = filename;
          link.target = "_blank"; 
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
      }
  };

  const sanitizeExportName = (value: string) => value
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || '未命名';

  const getExportExtension = (blob: Blob, url: string, fallback: string) => {
      const mimeExtensions: Record<string, string> = {
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp',
          'image/gif': 'gif',
          'image/svg+xml': 'svg',
          'video/mp4': 'mp4',
          'video/webm': 'webm',
          'video/quicktime': 'mov',
          'audio/mpeg': 'mp3',
          'audio/mp4': 'm4a',
          'audio/wav': 'wav',
          'audio/x-wav': 'wav',
          'audio/ogg': 'ogg',
      };
      if (mimeExtensions[blob.type]) return mimeExtensions[blob.type];
      const match = url.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
      return match?.[1]?.toLowerCase() || fallback;
  };

  const saveLocalExportBlob = async (blob: Blob, filename: string) => {
      const saved = await storageService.saveFile(blob, filename);
      if (saved) return;
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  };

  const handleLocalExport = async (exportType: LocalExportType) => {
      if (isLocalExporting) return;

      type MediaExportEntry = {
          type: 'image' | 'video' | 'audio';
          url: string;
          title: string;
          fallbackExtension: string;
      };

      const mediaEntries: MediaExportEntry[] = [];
      const textEntries: { title: string; text: string }[] = [];
      const seenMedia = new Set<string>();

      const addMedia = (entry: MediaExportEntry) => {
          const key = `${entry.type}:${entry.url}`;
          if (!entry.url || seenMedia.has(key)) return;
          seenMedia.add(key);
          mediaEntries.push(entry);
      };

      nodes.forEach(node => {
          const artifacts = node.outputArtifacts || [];
          if ([NodeType.TEXT_TO_IMAGE, NodeType.IMAGE_TO_IMAGE, NodeType.ORIGINAL_IMAGE].includes(node.type)) {
              [node.imageSrc, ...artifacts, ...(node.imageVersions || []).map(version => version.url)]
                  .filter((url): url is string => !!url)
                  .forEach(url => addMedia({ type: 'image', url, title: node.title, fallbackExtension: 'png' }));
          }
          if ([NodeType.TEXT_TO_VIDEO, NodeType.IMAGE_TO_VIDEO, NodeType.START_END_TO_VIDEO].includes(node.type)) {
              [node.videoSrc, ...artifacts]
                  .filter((url): url is string => !!url)
                  .forEach(url => addMedia({ type: 'video', url, title: node.title, fallbackExtension: 'mp4' }));
          }
          if (node.type === NodeType.TEXT_TO_AUDIO) {
              [node.audioSrc, ...artifacts]
                  .filter((url): url is string => !!url)
                  .forEach(url => addMedia({ type: 'audio', url, title: node.title, fallbackExtension: 'mp3' }));
          }
          if (node.type === NodeType.CREATIVE_DESC) {
              const text = (node.textContent || node.optimizedPrompt || node.prompt || '').trim();
              if (text) textEntries.push({ title: node.title, text });
          }
      });

      const selectedMedia = exportType === 'all'
          ? mediaEntries
          : mediaEntries.filter(entry => entry.type === exportType);
      const shouldExportText = exportType === 'text' || exportType === 'all';
      const exportCount = selectedMedia.length + (shouldExportText && textEntries.length ? 1 : 0);

      if (!exportCount) {
          const typeLabel = { video: '视频', image: '图片', text: '文本', audio: '音频', all: '可导出内容' }[exportType];
          alert(`当前画布没有${typeLabel}`);
          setIsLocalExportMenuOpen(false);
          return;
      }

      setIsLocalExporting(true);
      setIsLocalExportMenuOpen(false);
      let failedCount = 0;

      try {
          for (let index = 0; index < selectedMedia.length; index += 1) {
              const entry = selectedMedia[index];
              try {
                  const response = await fetch(entry.url);
                  if (!response.ok) throw new Error(`HTTP ${response.status}`);
                  const blob = await response.blob();
                  const extension = getExportExtension(blob, entry.url, entry.fallbackExtension);
                  const filename = `${sanitizeExportName(entry.title)}_${entry.type}_${index + 1}.${extension}`;
                  await saveLocalExportBlob(blob, filename);
              } catch (error) {
                  failedCount += 1;
                  console.error('Local export failed:', entry.url, error);
              }
          }

          if (shouldExportText && textEntries.length) {
              const textContent = textEntries
                  .map(entry => `【${entry.title}】\n${entry.text}`)
                  .join('\n\n--------------------\n\n');
              const filename = `${sanitizeExportName(projectName)}_文本.txt`;
              await saveLocalExportBlob(new Blob([textContent], { type: 'text/plain;charset=utf-8' }), filename);
          }

          const successCount = exportCount - failedCount;
          if (failedCount) {
              alert(`已导出 ${successCount} 个文件，${failedCount} 个文件导出失败`);
          } else {
              alert(`已导出 ${successCount} 个文件`);
          }
      } finally {
          setIsLocalExporting(false);
      }
  };

  const saveAssetFile = async (url: string, type: 'image' | 'video', title = 'asset') => {
      const ext = type === 'video' ? 'mp4' : 'png';
      const filename = `${title.replace(/\s+/g, '_')}_${Date.now()}.${ext}`;
      try {
          const response = await fetch(url);
          const blob = await response.blob();
          const saved = await storageService.saveFile(blob, filename);
          if (saved) return;

          const blobUrl = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = blobUrl;
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(blobUrl);
      } catch {
          const link = document.createElement('a');
          link.href = url;
          link.download = filename;
          link.target = '_blank';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
      }
  };

  const copyAssetToClipboard = async (url: string, type: 'image' | 'video') => {
      try {
          if (type === 'image' && navigator.clipboard && 'ClipboardItem' in window) {
              const response = await fetch(url);
              const blob = await response.blob();
              await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
              return;
          }
          await navigator.clipboard.writeText(url);
      } catch (error) {
          console.error(error);
          alert('复制素材失败，请尝试先保存到本地。');
      }
  };

  const deleteAssetFromLibrary = (nodeId: string, url: string, type: 'image' | 'video') => {
      const updateList = (list: NodeData[]) => list.map(node => {
          if (node.id !== nodeId) return node;
          const artifacts = (node.outputArtifacts || []).filter(item => item !== url);
          const updates: Partial<NodeData> = { outputArtifacts: artifacts };
          if (type === 'image' && node.imageSrc === url) {
              updates.imageSrc = artifacts[0];
          }
          if (type === 'video' && node.videoSrc === url) {
              updates.videoSrc = artifacts[0];
          }
          return { ...node, ...updates };
      });

      setNodes(prev => updateList(prev));
      setDeletedNodes(prev => updateList(prev).filter(node => node.imageSrc || node.videoSrc || node.outputArtifacts?.length));
  };

  const handleAddMaterialToCanvas = (_item: any) => {
      // Placeholder: material library add-to-canvas
  };

  const handleToggleMaterialFavorite = (_nodeId: string, _url: string, _type: 'image' | 'video') => {
      // Placeholder: material library toggle favorite
  };

  const getImportedNodeConnection = (nodeId: string): Connection | null => {
      const connection = assetImportConnectionRef.current;
      if (!connection) return null;

      const isBackward = connection.direction === 'backward';
      assetImportConnectionRef.current = null;
      return {
          id: generateId(),
          sourceId: isBackward ? nodeId : connection.sourceId,
          targetId: isBackward ? connection.sourceId : nodeId,
      };
  };

  const addUploadedFileNode = (file: File, center: Point) => {
      if (file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = (event) => {
              const src = event.target?.result as string;
              const img = new Image();
              img.onload = () => {
                  const aspectRatio = getClosestAspectRatio(img.width, img.height, IMAGE_ASPECT_RATIOS);
                  const { width, height } = getNodeSizeForAspectRatio(aspectRatio);
                  const nodeId = generateId();
                  const newNode: NodeData = {
                      id: nodeId,
                      type: NodeType.TEXT_TO_IMAGE,
                      x: center.x - width / 2,
                      y: center.y - height / 2,
                      width,
                      height,
                      imageSrc: src,
                      title: file.name,
                      aspectRatio,
                      model: 'Seedream 5.0',
                      resolution: '1k',
                      source: 'local_upload',
                      outputArtifacts: [src],
                  };
                  const newConnection = getImportedNodeConnection(nodeId);
                  addCreatedCanvasItems([newNode], newConnection ? [newConnection] : [], '上传文件');
                  setSelectedNodeIds(new Set([nodeId]));
              };
              img.src = src;
          };
          reader.readAsDataURL(file);
          return;
      }

      if (file.type.startsWith('video/')) {
          const url = URL.createObjectURL(file);
          const video = document.createElement('video');
          video.preload = 'metadata';
          video.onloadedmetadata = () => {
              const aspectRatio = getClosestAspectRatio(video.videoWidth, video.videoHeight, VIDEO_ASPECT_RATIOS);
              const { width, height } = getNodeSizeForAspectRatio(aspectRatio, VIDEO_NODE_BASE_HEIGHT);
              const nodeId = generateId();
              const newNode: NodeData = {
                  id: nodeId,
                  type: NodeType.TEXT_TO_VIDEO,
                  x: center.x - width / 2,
                  y: center.y - height / 2,
                  width,
                  height,
                  videoSrc: url,
                  title: file.name,
                  aspectRatio,
                  model: 'Seedance 1.5 Pro',
                  resolution: '720p',
                  duration: '5s',
                  source: 'local_upload',
                  outputArtifacts: [url],
              };
              const newConnection = getImportedNodeConnection(nodeId);
              addCreatedCanvasItems([newNode], newConnection ? [newConnection] : [], '上传文件');
              setSelectedNodeIds(new Set([nodeId]));
          };
          video.src = url;
          return;
      }

      if (file.type.startsWith('text/') || TEXT_FILE_PATTERN.test(file.name)) {
          const reader = new FileReader();
          reader.onload = (event) => {
              const text = String(event.target?.result || '');
              const nodeId = generateId();
              const versionSource = {
                  prompt: '',
                  model: 'Xiaomi MiMo 2.5 Pro',
                  title: file.name,
              };
              const newNode: NodeData = {
                  id: nodeId,
                  type: NodeType.CREATIVE_DESC,
                  x: center.x - 260,
                  y: center.y - 260,
                  width: 520,
                  height: 520,
                  title: file.name,
                  prompt: '',
                  textContent: text,
                  optimizedPrompt: text,
                  model: 'Xiaomi MiMo 2.5 Pro',
                  source: 'local_upload',
                  textVersions: [createTextVersionSnapshot(text, versionSource, 'upload')],
              };
              const newConnection = getImportedNodeConnection(nodeId);
              addCreatedCanvasItems([newNode], newConnection ? [newConnection] : [], '上传文件');
              setSelectedNodeIds(new Set([nodeId]));
          };
          reader.readAsText(file);
      }
  };

  const handleImportAsset = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
        assetImportPositionRef.current = null;
        assetImportConnectionRef.current = null;
        return;
    }
    
    const rect = containerRef.current?.getBoundingClientRect();
    const center = assetImportPositionRef.current || (rect ? screenToWorld(rect.width / 2, rect.height / 2) : { x: 0, y: 0 });
    assetImportPositionRef.current = null;
    
    addUploadedFileNode(file, center);
    e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };

  const handleDrop = (e: React.DragEvent) => {
      e.preventDefault(); e.stopPropagation();
      const worldPos = screenToWorld(e.clientX, e.clientY);
      const nodeType = (e.dataTransfer.getData('application/kc-node-type') || e.dataTransfer.getData('text/plain')) as NodeType;
      if (nodeType && Object.values(NodeType).includes(nodeType)) {
          addNode(nodeType, worldPos.x, worldPos.y);
          return;
      }

      const assetId = e.dataTransfer.getData('application/kc-asset');
      if (assetId) {
          const asset = DEMO_ASSET_LIBRARY.find(item => item.id === assetId);
          if (asset) handleAddAssetToCanvas(asset, worldPos);
          return;
      }
      const shotClipData = e.dataTransfer.getData('application/kc-shot-clip');
      if (shotClipData) {
          try {
              const clip = JSON.parse(shotClipData) as ShotClip;
              handleAddShotClipToCanvas(clip, worldPos);
          } catch (error) {
              console.error('Invalid shot clip drag payload', error);
          }
          return;
      }

      const files: File[] = Array.from(e.dataTransfer.files); 
      if (files.length === 0) return;
      assetImportConnectionRef.current = null;
      files.forEach((file, index) => {
          const offsetX = index * 20; const offsetY = index * 20;
          addUploadedFileNode(file, { x: worldPos.x + offsetX, y: worldPos.y + offsetY });
      });
  };

  // 画布容器只有在“已登录 + 已打开项目”后才渲染，手势监听需在此之后再挂载。
  const isCanvasMounted = isAuthenticated && !!currentProject;

  // 触控板手势：双指滑动平移画布，双指捏合(张开放大/收拢缩小)缩放。
  // 采用原生非 passive 监听以真正阻止浏览器默认的页面滚动/缩放/前进后退（React 的 onWheel 默认 passive，preventDefault 无效）。
  // 用 requestAnimationFrame 把高频手势事件合并到每帧只计算一次，避免大组件逐事件重渲染导致卡顿。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let rafId: number | null = null;
    let panX = 0;
    let panY = 0;
    let zoomFactor = 1;
    let anchorX = 0;
    let anchorY = 0;

    const flush = () => {
      rafId = null;
      const dPanX = panX, dPanY = panY, dZoom = zoomFactor, ax = anchorX, ay = anchorY;
      panX = 0; panY = 0; zoomFactor = 1;
      setTransform(prev => {
        let { x, y, k } = prev;
        if (dZoom !== 1) {
          const newK = Math.min(Math.max(CANVAS_MIN_SCALE, k * dZoom), CANVAS_MAX_SCALE);
          const worldX = (ax - x) / k;
          const worldY = (ay - y) / k;
          x = ax - worldX * newK;
          y = ay - worldY * newK;
          k = newK;
        }
        if (dPanX !== 0 || dPanY !== 0) {
          x += dPanX;
          y += dPanY;
        }
        return { x, y, k };
      });
    };

    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('textarea,input,select,[contenteditable="true"],[data-canvas-wheel-pass-through="true"]')) {
        return;
      }

      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        // 捏合缩放：deltaY<0 张开放大，deltaY>0 收拢缩小；以光标位置为锚点
        zoomFactor *= Math.exp(-e.deltaY * 0.01);
        anchorX = e.clientX - rect.left;
        anchorY = e.clientY - rect.top;
      } else {
        // 双指滑动平移
        panX -= e.deltaX;
        panY -= e.deltaY;
      }
      if (rafId == null) rafId = requestAnimationFrame(flush);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [isCanvasMounted]);

  const zoomCanvas = (direction: 1 | -1) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const nextK = Math.min(Math.max(CANVAS_MIN_SCALE, transform.k + direction * 0.1), CANVAS_MAX_SCALE);
      const anchorX = rect.width / 2;
      const anchorY = rect.height / 2;
      const worldX = (anchorX - transform.x) / transform.k;
      const worldY = (anchorY - transform.y) / transform.k;
      setTransform({
          x: anchorX - worldX * nextK,
          y: anchorY - worldY * nextK,
          k: nextK,
      });
  };

  const arrangeCanvasNodes = () => {
      const targetIds = selectedNodeIds.size > 0 ? selectedNodeIds : new Set(nodes.map(node => node.id));
      if (targetIds.size === 0) return;

      setNodes(prev => {
          const targetNodes = prev.filter(node => targetIds.has(node.id));
          if (targetNodes.length === 0) return prev;

          const sorted = [...targetNodes].sort((a, b) => (a.y - b.y) || (a.x - b.x));
          const minX = Math.min(...sorted.map(node => node.x));
          const minY = Math.min(...sorted.map(node => node.y));
          const maxWidth = Math.max(...sorted.map(node => node.width));
          const maxHeight = Math.max(...sorted.map(node => node.height));
          const columns = Math.min(4, Math.ceil(Math.sqrt(sorted.length)));
          const gapX = 88;
          const gapY = 72;
          const positionMap = new Map<string, Point>();

          sorted.forEach((node, index) => {
              const col = index % columns;
              const row = Math.floor(index / columns);
              positionMap.set(node.id, {
                  x: minX + col * (maxWidth + gapX),
                  y: minY + row * (maxHeight + gapY),
              });
          });

          return prev.map(node => {
              const next = positionMap.get(node.id);
              return next ? { ...node, x: next.x, y: next.y } : node;
          });
      });
  };

  const getMiniMapMetrics = () => {
      const miniWidth = 220;
      const miniHeight = 126;
      const rect = containerRef.current?.getBoundingClientRect();
      const view = rect
          ? {
              x: -transform.x / transform.k,
              y: -transform.y / transform.k,
              width: rect.width / transform.k,
              height: rect.height / transform.k,
          }
          : { x: -500, y: -320, width: 1000, height: 640 };

      const nodeBounds = nodes.length
          ? {
              minX: Math.min(...nodes.map(node => node.x)),
              minY: Math.min(...nodes.map(node => node.y)),
              maxX: Math.max(...nodes.map(node => node.x + node.width)),
              maxY: Math.max(...nodes.map(node => node.y + node.height)),
          }
          : {
              minX: view.x - 400,
              minY: view.y - 280,
              maxX: view.x + view.width + 400,
              maxY: view.y + view.height + 280,
          };

      const padding = 160;
      const minX = Math.min(nodeBounds.minX, view.x) - padding;
      const minY = Math.min(nodeBounds.minY, view.y) - padding;
      const maxX = Math.max(nodeBounds.maxX, view.x + view.width) + padding;
      const maxY = Math.max(nodeBounds.maxY, view.y + view.height) + padding;
      const width = Math.max(1, maxX - minX);
      const height = Math.max(1, maxY - minY);
      const scale = Math.min((miniWidth - 20) / width, (miniHeight - 18) / height);
      const offsetX = (miniWidth - width * scale) / 2;
      const offsetY = (miniHeight - height * scale) / 2;

      const toMini = (x: number, y: number) => ({
          x: offsetX + (x - minX) * scale,
          y: offsetY + (y - minY) * scale,
      });

      return {
          miniWidth,
          miniHeight,
          minX,
          minY,
          scale,
          offsetX,
          offsetY,
          view,
          nodeRects: nodes.map(node => {
              const point = toMini(node.x, node.y);
              return {
                  id: node.id,
                  x: point.x,
                  y: point.y,
                  width: Math.max(4, node.width * scale),
                  height: Math.max(4, node.height * scale),
                  selected: selectedNodeIds.has(node.id),
              };
          }),
          viewportRect: {
              ...toMini(view.x, view.y),
              width: Math.max(8, view.width * scale),
              height: Math.max(8, view.height * scale),
          },
      };
  };

  const moveCanvasToMiniMapPoint = (
      clientX: number,
      clientY: number,
      mapRect: DOMRect,
      metrics: { minX: number; minY: number; scale: number; offsetX: number; offsetY: number }
  ) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const localX = Math.max(0, Math.min(mapRect.width, clientX - mapRect.left));
      const localY = Math.max(0, Math.min(mapRect.height, clientY - mapRect.top));
      const worldX = metrics.minX + (localX - metrics.offsetX) / metrics.scale;
      const worldY = metrics.minY + (localY - metrics.offsetY) / metrics.scale;
      setTransform({
          x: rect.width / 2 - worldX * transform.k,
          y: rect.height / 2 - worldY * transform.k,
          k: transform.k,
      });
  };

  const handleMiniMapMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
      event.preventDefault();
      const mapRect = event.currentTarget.getBoundingClientRect();
      const metrics = getMiniMapMetrics();
      miniMapDragRef.current = { mapRect, metrics };
      moveCanvasToMiniMapPoint(event.clientX, event.clientY, mapRect, metrics);

      const handleMove = (moveEvent: MouseEvent) => {
          const drag = miniMapDragRef.current;
          if (!drag) return;
          moveCanvasToMiniMapPoint(moveEvent.clientX, moveEvent.clientY, drag.mapRect, drag.metrics);
      };
      const handleUp = () => {
          miniMapDragRef.current = null;
          window.removeEventListener('mousemove', handleMove);
          window.removeEventListener('mouseup', handleUp);
      };

      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleUp);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (contextMenu) setContextMenu(null);
    if (quickAddMenu) setQuickAddMenu(null);
    if (selectedConnectionId) setSelectedConnectionId(null);
    if (e.button === 1 || (e.button === 0 && spacePressed.current)) {
      setDragMode('PAN');
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      initialTransformRef.current = { ...transform };
      e.preventDefault(); return;
    }
    if (e.target === containerRef.current && e.button === 0) {
      setDragMode('SELECT');
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      setSelectionBox({ x: 0, y: 0, w: 0, h: 0 });
      initialSelectionRef.current = e.shiftKey ? new Set(selectedNodeIds) : new Set();
      if (!e.shiftKey) setSelectedNodeIds(new Set());
      setSelectedGroupId(null);
      setEditingGroupId(null);
    }
  };

  const handleNodeMouseDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (contextMenu) setContextMenu(null);
    if (quickAddMenu) setQuickAddMenu(null);
    if (selectedConnectionId) setSelectedConnectionId(null);
    if (e.button === 0) {
      setDragMode('DRAG_NODE');
        dragStartRef.current = { x: e.clientX, y: e.clientY };
        const isAlreadySelected = selectedNodeIds.has(id);
        let newSelection = new Set(selectedNodeIds);
        if (e.shiftKey) { isAlreadySelected ? newSelection.delete(id) : newSelection.add(id); } else { if (!isAlreadySelected) { newSelection.clear(); newSelection.add(id); } }
      setSelectedNodeIds(newSelection);
      setSelectedGroupId(null);
      initialNodePositionsRef.current = nodes.map(n => ({ id: n.id, x: n.x, y: n.y }));
    }
  };

  const handleGroupMouseDown = (e: React.MouseEvent, groupId: string) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const group = groups.find(item => item.id === groupId);
      if (!group) return;
      setDragMode('DRAG_GROUP');
      activeDragGroupRef.current = groupId;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      initialNodePositionsRef.current = nodes
          .filter(node => group.memberIds.includes(node.id))
          .map(node => ({ id: node.id, x: node.x, y: node.y }));
      initialGroupNodesRef.current = nodes.filter(node => group.memberIds.includes(node.id));
      setSelectedNodeIds(new Set(group.memberIds));
      setSelectedGroupId(groupId);
      setSelectedConnectionId(null);
  };

  const handleGroupDoubleClick = (e: React.MouseEvent, groupId: string) => {
      e.stopPropagation();
      e.preventDefault();
      const group = groups.find(item => item.id === groupId);
      if (!group) return;
      setSelectedGroupId(groupId);
      setEditingGroupId(groupId);
      setSelectedNodeIds(new Set());
  };

  const handleNodeDoubleClick = (e: React.MouseEvent, id: string) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('button, input, textarea, select, a, [contenteditable="true"], [role="textbox"]')) {
          return;
      }
      const node = nodes.find(item => item.id === id);
      if (!node) return;
      e.stopPropagation();
      e.preventDefault();
      if (node.type === NodeType.DIRECTOR_DESK) {
          openDirectorDesk(node.id);
          return;
      }
      setDragMode('NONE');
      setSelectedNodeIds(new Set([id]));
      setSelectedConnectionId(null);
      setContextMenu(null);
      focusNodeInViewport(node, CANVAS_MAX_SCALE);
  };

  const handleNodeContextMenu = (e: React.MouseEvent, id: string, type: NodeType) => {
      e.stopPropagation(); e.preventDefault();
      const worldPos = screenToWorld(e.clientX, e.clientY);
      setContextMenu({ type: 'NODE', nodeId: id, nodeType: type, x: e.clientX, y: e.clientY, worldX: worldPos.x, worldY: worldPos.y });
      if (!selectedNodeIds.has(id)) setSelectedNodeIds(new Set([id]));
  };

  const handleCanvasContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      const worldPos = screenToWorld(e.clientX, e.clientY);
      setContextMenu({ type: 'CANVAS', x: e.clientX, y: e.clientY, worldX: worldPos.x, worldY: worldPos.y });
  };

  const handleResizeStart = (e: React.MouseEvent, nodeId: string) => {
      e.stopPropagation(); e.preventDefault();
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      setDragMode('RESIZE_NODE');
      dragStartRef.current = { x: e.clientX, y: e.clientY, w: node.width, h: node.height, nodeId: nodeId };
      setSelectedNodeIds(new Set([nodeId]));
  };

  const handleConnectStart = (e: React.MouseEvent, nodeId: string, type: 'source' | 'target') => {
    e.stopPropagation(); e.preventDefault();
    connectionStartRef.current = { nodeId, type };
    setDragMode('CONNECT');
    setTempConnection(screenToWorld(e.clientX, e.clientY));
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
    const worldPos = screenToWorld(e.clientX, e.clientY);
    if (dragMode !== 'NONE' && e.buttons === 0) { setDragMode('NONE'); dragStartRef.current = { x: 0, y: 0 }; return; }
    if (dragMode === 'PAN') {
      setTransform({ ...initialTransformRef.current, x: initialTransformRef.current.x + (e.clientX - dragStartRef.current.x), y: initialTransformRef.current.y + (e.clientY - dragStartRef.current.y) });
    } else if (dragMode === 'DRAG_NODE') {
      const dx = (e.clientX - dragStartRef.current.x) / transform.k;
      const dy = (e.clientY - dragStartRef.current.y) / transform.k;
      setNodes(prev => prev.map(n => { if (selectedNodeIds.has(n.id)) { const initial = initialNodePositionsRef.current.find(init => init.id === n.id); if (initial) return { ...n, x: initial.x + dx, y: initial.y + dy }; } return n; }));
    } else if (dragMode === 'DRAG_GROUP') {
      const dx = (e.clientX - dragStartRef.current.x) / transform.k;
      const dy = (e.clientY - dragStartRef.current.y) / transform.k;
      const memberIds = new Set(initialNodePositionsRef.current.map(item => item.id));
      setNodes(prev => prev.map(node => {
          if (!memberIds.has(node.id)) return node;
          const initial = initialNodePositionsRef.current.find(item => item.id === node.id);
          return initial ? { ...node, x: initial.x + dx, y: initial.y + dy } : node;
      }));
    } else if (dragMode === 'SELECT') {
        const x = Math.min(dragStartRef.current.x, e.clientX);
        const y = Math.min(dragStartRef.current.y, e.clientY);
        const w = Math.abs(e.clientX - dragStartRef.current.x);
        const h = Math.abs(e.clientY - dragStartRef.current.y);
        setSelectionBox({ x: x - containerRef.current!.getBoundingClientRect().left, y: y - containerRef.current!.getBoundingClientRect().top, w, h });
        const worldStartX = (x - containerRef.current!.getBoundingClientRect().left - transform.x) / transform.k;
        const worldStartY = (y - containerRef.current!.getBoundingClientRect().top - transform.y) / transform.k;
        const worldWidth = w / transform.k; const worldHeight = h / transform.k;
        const newSelection = new Set(initialSelectionRef.current);
        nodes.forEach(n => { if (n.x < worldStartX + worldWidth && n.x + n.width > worldStartX && n.y < worldStartY + worldHeight && n.y + n.height > worldStartY) newSelection.add(n.id); });
        setSelectedNodeIds(newSelection);
    } else if (dragMode === 'CONNECT') {
        setTempConnection(worldPos);
        const start = connectionStartRef.current;
        if (start) {
            const candidates = nodes.filter(n => n.id !== start.nodeId)
                // 正向起点(source)：候选为合法的下游节点；反向起点(target)：候选为合法的上游节点
                .filter(n => start.type === 'source' ? canConnectNodes(start.nodeId, n.id) : canConnectNodes(n.id, start.nodeId))
                .map(n => ({ node: n, dist: Math.sqrt(Math.pow(worldPos.x - (n.x + n.width/2), 2) + Math.pow(worldPos.y - (n.y + n.height/2), 2)) }))
                .filter(item => item.dist < 500).sort((a, b) => a.dist - b.dist).slice(0, 3).map(item => item.node);
            setSuggestedNodes(candidates);
        }
    } else if (dragMode === 'RESIZE_NODE') {
        const nodeId = dragStartRef.current.nodeId;
        const node = nodes.find(n => n.id === nodeId);
        if (node) {
            const dx = (e.clientX - dragStartRef.current.x) / transform.k;
            let ratio = 1.33; 
            if (node.aspectRatio) { const [w, h] = node.aspectRatio.split(':').map(Number); if (!isNaN(w) && !isNaN(h) && h !== 0) ratio = w / h; } 
            else if (node.type === NodeType.ORIGINAL_IMAGE) { ratio = (dragStartRef.current.w || 1) / (dragStartRef.current.h || 1); }
            let minWidth = 150;
            if (node.type !== NodeType.CREATIVE_DESC) {
                const limit1 = ratio >= 1 ? 400 * ratio : 400;
                minWidth = Math.max(limit1, 400); 
            } else minWidth = 280;
            let newWidth = Math.max(minWidth, (dragStartRef.current.w || 0) + dx);
            setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, width: newWidth, height: newWidth / ratio } : n));
        }
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    // 连线拖到空白处释放：弹出快捷新建菜单。正向(从输出端口拖出)新建下游节点，反向(从输入端口拖出)新建上游节点。
    if (dragMode === 'CONNECT' && connectionStartRef.current) {
         const world = screenToWorld(e.clientX, e.clientY);
         const direction = connectionStartRef.current.type === 'source' ? 'forward' : 'backward';
         setQuickAddMenu({ sourceId: connectionStartRef.current.nodeId, x: e.clientX, y: e.clientY, worldX: world.x, worldY: world.y, direction });
    }
    if (dragMode === 'DRAG_GROUP' && activeDragGroupRef.current && initialGroupNodesRef.current.length > 0) {
      recordCanvasHistory({
        type: 'group-update',
        label: '移动分组',
        beforeNodes: initialGroupNodesRef.current,
        beforeGroups: groups,
      });
    }
    if (dragMode !== 'NONE') {
      setDragMode('NONE');
      setTempConnection(null);
      connectionStartRef.current = null;
      setSuggestedNodes([]);
      setSelectionBox(null);
      activeDragGroupRef.current = null;
      initialGroupNodesRef.current = [];
    }
  };

  const nodeHasMedia = (node: NodeData): boolean =>
      !!(node.imageSrc || node.videoSrc || node.audioSrc || (node.outputArtifacts && node.outputArtifacts.length > 0));

  // 校验一条 source→target 连线是否合法（与拖拽方向无关）。
  const canConnectNodes = (sourceId: string, targetId: string): boolean => {
      if (!sourceId || !targetId || sourceId === targetId) return false;
      const source = nodes.find(n => n.id === sourceId);
      const target = nodes.find(n => n.id === targetId);
      if (!source || !target) return false;
      if (target.type === NodeType.ORIGINAL_IMAGE) return false;

      const sourceCategory = NODE_MEDIA_CATEGORY[source.type];
      const targetCategory = NODE_MEDIA_CATEGORY[target.type];

      // 有素材后的连接限制：
      // - 视频节点有素材 → 不能作为 target（禁止上游连入），作为 source 只能连视频节点
      // - 图片节点有素材 → 作为 target 时上游只能是图片节点
      // - 文字节点有素材 → 不能作为 target（禁止上游连入）
      if (nodeHasMedia(target)) {
          if (targetCategory === 'text') return false;
          if (targetCategory === 'image' && sourceCategory !== 'image') return false;
      }
      if (nodeHasMedia(source) && sourceCategory === 'video' && targetCategory !== 'video' && targetCategory !== 'text') return false;

      return ALLOWED_SOURCE_CATEGORIES[targetCategory]?.includes(sourceCategory) ?? false;
  };

  const createConnection = (sourceId: string, targetId: string) => {
      if (canConnectNodes(sourceId, targetId) && !connections.some(c => c.sourceId === sourceId && c.targetId === targetId)) {
          const newConnection = { id: generateId(), sourceId, targetId };
          addCreatedCanvasItems([], [newConnection], '连接节点');
      }
      setDragMode('NONE'); setTempConnection(null); connectionStartRef.current = null; setSuggestedNodes([]);
  };

  const handlePortMouseUp = (e: React.MouseEvent, nodeId: string, type: 'source' | 'target') => {
      const start = connectionStartRef.current;
      if (dragMode !== 'CONNECT' || !start) return;
      // 在发起连接的同一节点上释放：视为未拖出连线，交由画布默认逻辑处理(如正向的快捷添加菜单)。
      if (start.nodeId === nodeId) return;
      e.stopPropagation(); e.preventDefault();
      // 正向：从输出端口(source)拖出，落到目标节点的输入端口(target)
      if (start.type === 'source' && type === 'target') createConnection(start.nodeId, nodeId);
      // 反向：从输入端口(target)拖出，落到上游节点的输出端口(source)
      else if (start.type === 'target' && type === 'source') createConnection(nodeId, start.nodeId);
  };

  const deleteNode = (id: string) => {
      deleteCanvasItems(new Set([id]), new Set());
  };

  const removeConnection = (id: string) => {
      deleteCanvasItems(new Set(), new Set([id]));
  };

  const renderNewWorkflowDialog = () => {
      if (!showNewWorkflowDialog) return null;
      return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setShowNewWorkflowDialog(false)}>
            <div className={`w-[400px] p-6 rounded-2xl shadow-2xl border flex flex-col gap-4 transform transition-all scale-100 ${isDark ? 'bg-[#1A1D21] border-zinc-700 text-gray-200' : 'bg-white border-gray-200 text-gray-800'}`} onClick={(e) => e.stopPropagation()}>
                <div>
                    <h3 className="text-lg font-bold flex items-center gap-2"><Icons.FilePlus size={20} className="text-[#4446CE]"/>清空当前画布</h3>
                    <p className={`text-xs mt-2 leading-relaxed ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>是否在清空画布之前保存当前项目？<br/>清空后节点和连线会从当前画布移除。</p>
                </div>
                <div className={`flex justify-end gap-2 mt-2 pt-4 border-t ${isDark ? 'border-zinc-800' : 'border-gray-100'}`}>
                    <button onClick={() => setShowNewWorkflowDialog(false)} className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${isDark ? 'hover:bg-zinc-800 text-gray-400' : 'hover:bg-gray-100 text-gray-600'}`}>取消</button>
                    <button onClick={() => handleConfirmNew(false)} className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors ${isDark ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20' : 'bg-red-50 text-red-600 hover:bg-red-100 border border-red-200'}`}>不保存</button>
                    <button onClick={() => handleConfirmNew(true)} className={`px-4 py-2 rounded-lg text-xs font-bold text-white transition-colors shadow-lg shadow-[#4446CE]/20 flex items-center gap-1.5 ${isDark ? 'bg-[#4446CE] hover:bg-[#4446CE]' : 'bg-[#4446CE] hover:bg-[#8F91F4]'}`}><Icons.Save size={14}/>保存并清空</button>
                </div>
            </div>
        </div>
      );
  };

  const renderDeleteConfirmDialog = () => {
      if (!pendingDeleteRequest) return null;
      const targetNodes = nodes.filter(node => pendingDeleteRequest.nodeIds.includes(node.id));
      const affectedConnections = connections.filter(connection =>
          pendingDeleteRequest.connectionIds.includes(connection.id)
          || pendingDeleteRequest.nodeIds.includes(connection.sourceId)
          || pendingDeleteRequest.nodeIds.includes(connection.targetId)
      );
      const title = targetNodes.length === 1 ? targetNodes[0].title : `${targetNodes.length} 个节点`;

      return (
          <div className="fixed inset-0 z-[320] flex items-center justify-center bg-black/70 backdrop-blur-sm" onMouseDown={(event) => event.stopPropagation()}>
              <div className={`w-[min(420px,92vw)] rounded-2xl border p-5 shadow-2xl ${isDark ? 'border-red-500/30 bg-[#18181b] text-zinc-100' : 'border-red-200 bg-white text-gray-900'}`}>
                  <div className="flex items-start gap-3">
                      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${isDark ? 'bg-red-500/15 text-red-300' : 'bg-red-50 text-red-600'}`}>
                          <Icons.Trash2 size={22} />
                      </div>
                      <div className="min-w-0">
                          <div className="text-base font-bold">确认删除节点</div>
                          <p className={`mt-2 text-sm leading-6 ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
                              将删除「{title}」以及相关连线 {affectedConnections.length} 条。删除后可用 Ctrl/⌘+Z 撤回。
                          </p>
                      </div>
                  </div>
                  <div className={`mt-5 flex justify-end gap-2 border-t pt-4 ${isDark ? 'border-zinc-800' : 'border-gray-100'}`}>
                      <button
                          type="button"
                          onClick={() => setPendingDeleteRequest(null)}
                          className={`rounded-lg px-4 py-2 text-xs font-semibold transition-colors ${isDark ? 'text-zinc-300 hover:bg-zinc-800' : 'text-gray-600 hover:bg-gray-100'}`}
                      >
                          取消
                      </button>
                      <button
                          type="button"
                          onClick={confirmPendingDelete}
                          className={`rounded-lg px-4 py-2 text-xs font-bold transition-colors ${isDark ? 'bg-red-500 text-white hover:bg-red-400' : 'bg-red-600 text-white hover:bg-red-500'}`}
                      >
                          确认删除
                      </button>
                  </div>
              </div>
          </div>
      );
  };

  const renderProjectDashboard = () => {
      const statusClass = (status: ProjectDashboardItem['status']) => {
          if (status === 'active') return isDark ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' : 'bg-emerald-50 text-emerald-700 border-emerald-100';
          if (status === 'draft') return isDark ? 'bg-amber-500/10 text-amber-300 border-amber-500/20' : 'bg-amber-50 text-amber-700 border-amber-100';
          return isDark ? 'bg-zinc-800 text-zinc-400 border-zinc-700' : 'bg-gray-100 text-gray-500 border-gray-200';
      };
      const statusText: Record<ProjectDashboardItem['status'], string> = {
          active: '制作中',
          draft: '草稿',
          archived: '归档',
      };

      return (
          <div className={`min-h-screen w-full ${isDark ? 'bg-[#0b0c0e] text-zinc-100' : 'bg-[#f5f7fa] text-gray-900'}`}>
              <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-8 py-7">
                  <header className="flex items-center justify-between gap-6">
                      <div className="flex items-center gap-3">
                          <div className={`h-11 w-11 rounded-2xl flex items-center justify-center ${isDark ? 'bg-[#4446CE]/15 text-[#B9BAFF]' : 'bg-[#E1E3FF] text-[#4446CE]'}`}>
                              <Icons.Sparkles size={22} />
                          </div>
                          <div>
                              <h1 className="text-xl font-bold">KC 无限画布项目管理</h1>
                              <p className={`mt-1 text-sm ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>先选择项目，再进入对应画布继续创作和保存。</p>
                          </div>
                      </div>
                      <div className="flex items-center gap-2">
                          <button
                              onClick={createProject}
                              className={`h-10 rounded-xl px-4 text-sm font-semibold flex items-center gap-2 ${isDark ? 'bg-[#4446CE] text-white hover:bg-[#4446CE]' : 'bg-[#4446CE] text-white hover:bg-[#4446CE]'}`}
                          >
                              <Icons.FilePlus size={16} />
                              新建项目
                          </button>
                          <button
                              onClick={() => toggleTheme(!isDark)}
                              className={`h-10 rounded-xl border px-3 text-sm font-semibold flex items-center gap-2 ${isDark ? 'border-zinc-800 text-zinc-400 hover:bg-zinc-900 hover:text-white' : 'border-gray-200 text-gray-600 hover:bg-white hover:text-gray-900'}`}
                          >
                              {isDark ? <Icons.Moon size={16} /> : <Icons.Sun size={16} />}
                              {isDark ? '暗色' : '亮色'}
                          </button>
                      </div>
                  </header>

                  <section className="mt-8 grid grid-cols-4 gap-4">
                      {[
                          ['项目数', projects.length],
                          ['制作中', projects.filter(project => project.status === 'active').length],
                          ['分镜总数', projects.reduce((sum, project) => sum + project.shotCount, 0)],
                          ['资产总数', projects.reduce((sum, project) => sum + project.assetCount, 0)],
                      ].map(([label, value]) => (
                          <div key={String(label)} className={`rounded-2xl border p-4 ${isDark ? 'border-zinc-800 bg-zinc-950/45' : 'border-gray-200 bg-white'}`}>
                              <div className={`text-xs ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>{label}</div>
                              <div className="mt-2 text-2xl font-bold tabular-nums">{value}</div>
                          </div>
                      ))}
                  </section>

                  <main className="mt-6 grid grid-cols-3 gap-4">
                      {projects.map(project => (
                          <button
                              key={project.id}
                              onClick={() => openProject(project)}
                              className={`group rounded-2xl border p-5 text-left transition-all ${isDark ? 'border-zinc-800 bg-[#16181c] hover:border-[#4446CE]/45 hover:bg-[#1a1d23]' : 'border-gray-200 bg-white hover:border-[#B9BAFF] hover:shadow-md'}`}
                          >
                              <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                      <div className={`inline-flex rounded-lg border px-2 py-1 text-[11px] font-semibold ${statusClass(project.status)}`}>
                                          {statusText[project.status]}
                                      </div>
                                      <h2 className="mt-3 truncate text-lg font-bold">{project.name}</h2>
                                  </div>
                                  <Icons.ChevronRight size={20} className={`mt-1 transition-transform group-hover:translate-x-1 ${isDark ? 'text-zinc-600' : 'text-gray-400'}`} />
                              </div>
                              <div className={`mt-5 grid grid-cols-3 gap-2 rounded-xl p-3 ${isDark ? 'bg-zinc-950/60' : 'bg-gray-50'}`}>
                                  <div>
                                      <div className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-gray-400'}`}>集数</div>
                                      <div className="mt-1 text-sm font-semibold">{project.episodeCount}</div>
                                  </div>
                                  <div>
                                      <div className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-gray-400'}`}>分镜</div>
                                      <div className="mt-1 text-sm font-semibold">{project.shotCount}</div>
                                  </div>
                                  <div>
                                      <div className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-gray-400'}`}>资产</div>
                                      <div className="mt-1 text-sm font-semibold">{project.assetCount}</div>
                                  </div>
                              </div>
                              <div className={`mt-4 flex items-center justify-between text-xs ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>
                                  <span>{project.canvasName}</span>
                              </div>
                          </button>
                      ))}
                  </main>
              </div>
          </div>
      );
  };

  const renderProjectDashboardV2 = () => {
      const groupOptions = ['全部项目组', ...Array.from(new Set(projects.map(project => project.directorGroup || '未分组')))];
      const typeOptions = ['全部项目类型', ...Array.from(new Set(projects.map(project => project.projectType || '短剧')))];
      const normalizedSearch = projectSearchQuery.trim().toLowerCase();
      const visibleProjects = projects.filter(project => {
          const groupMatched = projectGroupFilter === '全部项目组' || project.directorGroup === projectGroupFilter;
          const typeMatched = projectTypeFilter === '全部项目类型' || (project.projectType || '短剧') === projectTypeFilter;
          const searchMatched = !normalizedSearch
              || project.name.toLowerCase().includes(normalizedSearch)
              || project.canvasName.toLowerCase().includes(normalizedSearch)
              || project.directorGroup.toLowerCase().includes(normalizedSearch);
          return groupMatched && typeMatched && searchMatched;
      });
      const selectClass = `h-10 rounded-xl border px-3 text-sm outline-none transition-colors ${
          isDark ? 'border-zinc-800 bg-zinc-950/70 text-zinc-200 hover:border-zinc-700' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
      }`;
      const searchClass = `h-10 w-full rounded-xl border pl-9 pr-3 text-sm outline-none transition-colors ${
          isDark ? 'border-zinc-800 bg-zinc-950/70 text-zinc-100 placeholder:text-zinc-600 focus:border-[#4446CE]' : 'border-gray-200 bg-white text-gray-900 placeholder:text-gray-400 focus:border-[#4446CE]'
      }`;

      return (
          <div className={`min-h-screen w-full ${isDark ? 'bg-[#0b0c0e] text-zinc-100' : 'bg-[#f5f7fa] text-gray-900'}`}>
              <div className="mx-auto flex min-h-screen w-full max-w-[1680px] flex-col px-8 py-7">
                  <header className="flex items-center justify-between gap-6">
                      <div className="flex items-center gap-3">
                          <div className={`h-11 w-11 rounded-2xl flex items-center justify-center ${isDark ? 'bg-[#4446CE]/15 text-[#B9BAFF]' : 'bg-[#E1E3FF] text-[#4446CE]'}`}>
                              <Icons.Sparkles size={22} />
                          </div>
                          <div>
                              <h1 className="text-xl font-bold">KC 无限画布项目管理</h1>
                              <p className={`mt-1 text-sm ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>先选择项目，再进入对应画布继续创作和保存。</p>
                          </div>
                      </div>
                      <div className="flex items-center gap-2">
                          <button
                              onClick={() => toggleTheme(!isDark)}
                              className={`h-10 rounded-xl border px-3 text-sm font-semibold flex items-center gap-2 ${isDark ? 'border-zinc-800 text-zinc-400 hover:bg-zinc-900 hover:text-white' : 'border-gray-200 text-gray-600 hover:bg-white hover:text-gray-900'}`}
                          >
                              {isDark ? <Icons.Moon size={16} /> : <Icons.Sun size={16} />}
                              {isDark ? '暗色' : '亮色'}
                          </button>
                      </div>
                  </header>

                  <section className={`mt-8 flex flex-col gap-3 rounded-2xl border p-4 md:flex-row md:items-center ${isDark ? 'border-zinc-800 bg-zinc-950/35' : 'border-gray-200 bg-white/80'}`}>
                      <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-[180px_180px_minmax(240px,1fr)]">
                          <select
                              value={projectGroupFilter}
                              onChange={(e) => setProjectGroupFilter(e.target.value)}
                              className={selectClass}
                              aria-label="项目组筛选"
                          >
                              {groupOptions.map(option => <option key={option} value={option}>{option}</option>)}
                          </select>
                          <select
                              value={projectTypeFilter}
                              onChange={(e) => setProjectTypeFilter(e.target.value)}
                              className={selectClass}
                              aria-label="项目类型筛选"
                          >
                              {typeOptions.map(option => <option key={option} value={option}>{option}</option>)}
                          </select>
                          <div className="relative">
                              <Icons.Search size={16} className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 ${isDark ? 'text-zinc-500' : 'text-gray-400'}`} />
                              <input
                                  value={projectSearchQuery}
                                  onChange={(e) => setProjectSearchQuery(e.target.value)}
                                  className={searchClass}
                                  placeholder="搜索项目名称、画布名称或导演组"
                              />
                          </div>
                      </div>
                      <div className={`text-sm ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>
                          共 {visibleProjects.length} 个项目
                      </div>
                  </section>

                  <main className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                      {visibleProjects.map(project => (
                          <div
                              key={project.id}
                              role="button"
                              tabIndex={0}
                              onClick={() => openProject(project)}
                              onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                      event.preventDefault();
                                      openProject(project);
                                  }
                              }}
                              className={`group relative min-h-[138px] cursor-pointer rounded-2xl border p-4 text-left transition-all ${isDark ? 'border-zinc-800 bg-[#16181c] hover:border-[#4446CE]/45 hover:bg-[#1a1d23]' : 'border-gray-200 bg-white hover:border-[#B9BAFF] hover:shadow-md'}`}
                          >
                              {!DEFAULT_PROJECTS.some(item => item.id === project.id) && (
                                  <button
                                      type="button"
                                      onClick={(event) => deleteProject(project, event)}
                                      className={`absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-lg opacity-65 transition-all hover:opacity-100 ${isDark ? 'text-zinc-500 hover:bg-red-500/10 hover:text-red-300' : 'text-gray-400 hover:bg-red-50 hover:text-red-600'}`}
                                      title="删除项目"
                                      aria-label={`删除项目 ${project.name}`}
                                  >
                                      <Icons.Trash2 size={14} />
                                  </button>
                              )}
                              <div className="flex h-full flex-col justify-between gap-5">
                                  <div className="min-w-0 pr-8">
                                      <h2 className="truncate text-base font-bold leading-6">{project.name}</h2>
                                  </div>
                                  <Icons.ChevronRight size={18} className={`transition-transform group-hover:translate-x-1 ${isDark ? 'text-zinc-600' : 'text-gray-400'}`} />
                              </div>
                          </div>
                      ))}
                      {visibleProjects.length === 0 && (
                          <div className={`col-span-full rounded-2xl border p-8 text-center text-sm ${isDark ? 'border-zinc-800 bg-zinc-950/40 text-zinc-500' : 'border-gray-200 bg-white text-gray-500'}`}>
                              没有找到匹配的项目
                          </div>
                      )}
                  </main>
              </div>
          </div>
      );
  };

  const renderSaveResultModal = () => {
      if (!saveResultTarget) return null;
      const modeButtonClass = (mode: typeof saveResultMode) => `rounded-xl border px-3 py-2 text-left transition-all ${
          saveResultMode === mode
              ? (isDark ? 'border-[#4446CE] bg-[#4446CE]/15 text-[#C7C8FF]' : 'border-[#4446CE] bg-[#F0F1FF] text-[#3739B0]')
              : (isDark ? 'border-zinc-800 bg-zinc-950/45 text-zinc-400 hover:border-zinc-700 hover:text-zinc-100' : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300 hover:text-gray-900')
      }`;
      const inputClass = `w-full rounded-xl border px-3 py-2 text-sm outline-none ${
          isDark ? 'border-zinc-800 bg-zinc-950/60 text-zinc-100 placeholder:text-zinc-600 focus:border-[#4446CE]' : 'border-gray-200 bg-white text-gray-900 placeholder:text-gray-400 focus:border-[#4446CE]'
      }`;

      return (
          <div className="fixed inset-0 z-[260] flex items-center justify-center bg-black/70 backdrop-blur-md" onClick={() => setSaveResultTarget(null)}>
              <div className={`w-[720px] max-w-[92vw] rounded-3xl border shadow-2xl ${isDark ? 'border-zinc-800 bg-[#15171b] text-zinc-100' : 'border-gray-200 bg-white text-gray-900'}`} onClick={(event) => event.stopPropagation()}>
                  <div className={`flex items-center justify-between border-b px-6 py-4 ${isDark ? 'border-zinc-800' : 'border-gray-100'}`}>
                      <div>
                          <h3 className="text-lg font-bold">保存结果</h3>
                          <p className={`mt-1 text-xs ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>保存到项目素材，或作为资产版本沉淀给线性系统复用。</p>
                      </div>
                      <button className={`h-9 w-9 rounded-full flex items-center justify-center ${isDark ? 'hover:bg-zinc-800 text-zinc-400 hover:text-white' : 'hover:bg-gray-100 text-gray-500 hover:text-gray-900'}`} onClick={() => setSaveResultTarget(null)}>
                          <Icons.X size={20} />
                      </button>
                  </div>

                  <div className="grid grid-cols-[220px_1fr] gap-5 p-6">
                      <div className={`overflow-hidden rounded-2xl border ${isDark ? 'border-zinc-800 bg-zinc-950' : 'border-gray-200 bg-gray-50'}`}>
                          <div className="aspect-video w-full">
                              {saveResultTarget.type === 'video'
                                  ? <video src={saveResultTarget.url} className="h-full w-full object-cover" muted controls preload="metadata" />
                                  : <img src={saveResultTarget.url} className="h-full w-full object-cover" alt="保存预览" />}
                          </div>
                          <div className="p-3">
                              <div className={`text-xs ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>当前项目</div>
                              <div className="mt-1 truncate text-sm font-semibold">{currentProject?.name || projectName}</div>
                          </div>
                      </div>

                      <div className="space-y-4">
                          <div>
                              <label className={`text-xs font-semibold ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>名称</label>
                              <input className={`${inputClass} mt-1.5`} value={saveResultName} onChange={(event) => setSaveResultName(event.target.value)} placeholder="输入素材或资产名称" />
                          </div>

                          <div className="grid grid-cols-3 gap-2">
                              <button className={modeButtonClass('material')} onClick={() => setSaveResultMode('material')}>
                                  <div className="text-sm font-semibold">项目素材</div>
                                  <div className="mt-1 text-[11px] opacity-70">只保存到当前项目素材库</div>
                              </button>
                              <button className={modeButtonClass('new_asset')} onClick={() => setSaveResultMode('new_asset')}>
                                  <div className="text-sm font-semibold">新资产</div>
                                  <div className="mt-1 text-[11px] opacity-70">创建角色/场景/道具资产</div>
                              </button>
                              <button className={modeButtonClass('update_asset')} onClick={() => setSaveResultMode('update_asset')}>
                                  <div className="text-sm font-semibold">更新资产</div>
                                  <div className="mt-1 text-[11px] opacity-70">追加为已有资产新版本</div>
                              </button>
                          </div>

                          {saveResultMode === 'new_asset' && (
                              <div>
                                  <label className={`text-xs font-semibold ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>资产类型</label>
                                  <div className="mt-1.5 flex gap-2">
                                      {[
                                          ['role', '角色'],
                                          ['scene', '场景'],
                                          ['prop', '道具'],
                                      ].map(([value, label]) => (
                                          <button
                                              key={value}
                                              className={`h-9 flex-1 rounded-xl border text-sm font-semibold ${saveAssetType === value ? (isDark ? 'border-[#4446CE] bg-[#4446CE]/15 text-[#C7C8FF]' : 'border-[#4446CE] bg-[#F0F1FF] text-[#3739B0]') : (isDark ? 'border-zinc-800 text-zinc-400 hover:bg-zinc-900' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}`}
                                              onClick={() => setSaveAssetType(value as AssetLibraryType)}
                                          >
                                              {label}
                                          </button>
                                      ))}
                                  </div>
                              </div>
                          )}

                          {saveResultMode === 'update_asset' && (
                              <div>
                                  <label className={`text-xs font-semibold ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>选择要更新的资产</label>
                                  <select className={`${inputClass} mt-1.5`} value={saveTargetAssetId} onChange={(event) => setSaveTargetAssetId(event.target.value)}>
                                      {DEMO_ASSET_LIBRARY.map(asset => (
                                          <option key={asset.id} value={asset.id}>{asset.name} / {asset.version}</option>
                                      ))}
                                  </select>
                                  <p className={`mt-1 text-[11px] ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>正式系统会保留历史版本，不覆盖旧结果。</p>
                              </div>
                          )}

                          <div>
                              <label className={`text-xs font-semibold ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>备注</label>
                              <textarea className={`${inputClass} mt-1.5 min-h-[70px] resize-none`} value={saveResultNote} onChange={(event) => setSaveResultNote(event.target.value)} placeholder="可填写本次优化原因、适用分镜或版本说明" />
                          </div>
                      </div>
                  </div>

                  <div className={`flex items-center justify-between border-t px-6 py-4 ${isDark ? 'border-zinc-800' : 'border-gray-100'}`}>
                      <div className={`text-xs ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>当前为原型演示，后续接项目素材库/资产库接口。</div>
                      <div className="flex gap-2">
                          <button className={`h-10 rounded-xl px-4 text-sm font-semibold ${isDark ? 'text-zinc-400 hover:bg-zinc-900 hover:text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}`} onClick={() => setSaveResultTarget(null)}>取消</button>
                          <button className="h-10 rounded-xl bg-[#4446CE] px-4 text-sm font-semibold text-white hover:bg-[#4446CE]" onClick={handleConfirmSaveResult}>确认保存</button>
                      </div>
                  </div>
              </div>
          </div>
      );
  };

  const renderCreditDashboard = () => {
      if (!isCreditDashboardOpen) return null;
      const statusText: Record<string, string> = {
          estimated: '预计',
          reserved: '已预扣',
          confirmed: '已扣减',
          refunded: '已返还',
          failed: '异常',
          idle: '未开始',
      };
      const taskRows = nodes
          .filter(node => node.creditEstimate || node.creditStatus)
          .map((node, index) => ({
              id: node.id,
              project: currentProject?.name || projectName,
              group: currentProject?.directorGroup || node.directorGroupName || '-',
              user: index % 2 === 0 ? '导演A' : '制片助理B',
              type: node.type === NodeType.CREATIVE_DESC ? '文本分析' : node.type === NodeType.TEXT_TO_IMAGE ? '图片生成' : '视频生成',
              model: node.model || '-',
              credit: node.creditEstimate || getEstimatedCredits(node),
              status: node.creditStatus || 'estimated',
              nodeTitle: node.title,
          }));
      const fallbackRows = [
          { id: 'mock_1', project: currentProject?.name || '演示项目', group: currentProject?.directorGroup || 'A组导演组', user: '导演A', type: '视频生成', model: 'Seedance 1.5 Pro', credit: 14, status: 'confirmed', nodeTitle: '第1集 第2场 分镜03' },
          { id: 'mock_2', project: currentProject?.name || '演示项目', group: currentProject?.directorGroup || 'A组导演组', user: '制片助理B', type: '图片生成', model: 'Seedream 5.0', credit: 2, status: 'reserved', nodeTitle: '角色参考图' },
          { id: 'mock_3', project: currentProject?.name || '演示项目', group: currentProject?.directorGroup || 'A组导演组', user: '导演A', type: '文本分析', model: 'Xiaomi MiMo 2.5 Pro', credit: 1, status: 'refunded', nodeTitle: '剧本角色表' },
      ];
      const rows = taskRows.length ? taskRows : fallbackRows;
      const total = rows.reduce((sum, row) => sum + row.credit, 0);
      const confirmed = rows.filter(row => row.status === 'confirmed').reduce((sum, row) => sum + row.credit, 0);
      const reserved = rows.filter(row => row.status === 'reserved').reduce((sum, row) => sum + row.credit, 0);
      const refunded = rows.filter(row => row.status === 'refunded').reduce((sum, row) => sum + row.credit, 0);

      return (
          <div className="fixed inset-0 z-[250] bg-black/70 backdrop-blur-md p-6" onClick={() => setIsCreditDashboardOpen(false)}>
              <div className={`mx-auto flex h-full max-w-6xl flex-col rounded-3xl border shadow-2xl ${isDark ? 'border-zinc-800 bg-[#121417] text-zinc-100' : 'border-gray-200 bg-white text-gray-900'}`} onClick={(event) => event.stopPropagation()}>
                  <div className={`flex items-center justify-between border-b px-6 py-4 ${isDark ? 'border-zinc-800' : 'border-gray-100'}`}>
                      <div>
                          <h3 className="text-xl font-bold">后台积分看板</h3>
                          <p className={`mt-1 text-sm ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>按项目、导演组、人员、模型和任务类型查看画布消耗。</p>
                      </div>
                      <button className={`h-10 w-10 rounded-full flex items-center justify-center ${isDark ? 'hover:bg-zinc-800 text-zinc-400 hover:text-white' : 'hover:bg-gray-100 text-gray-500 hover:text-gray-900'}`} onClick={() => setIsCreditDashboardOpen(false)}>
                          <Icons.X size={22} />
                      </button>
                  </div>

                  <div className="grid grid-cols-4 gap-4 p-6">
                      {[
                          ['今日消耗', total],
                          ['已确认扣减', confirmed],
                          ['当前预扣', reserved],
                          ['失败返还', refunded],
                      ].map(([label, value]) => (
                          <div key={String(label)} className={`rounded-2xl border p-4 ${isDark ? 'border-zinc-800 bg-zinc-950/45' : 'border-gray-200 bg-gray-50'}`}>
                              <div className={`text-xs ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>{label}</div>
                              <div className="mt-2 text-2xl font-bold tabular-nums">{value}</div>
                              <div className={`mt-1 text-[11px] ${isDark ? 'text-zinc-600' : 'text-gray-400'}`}>积分</div>
                          </div>
                      ))}
                  </div>

                  <div className="flex-1 overflow-auto px-6 pb-6">
                      <table className="w-full border-separate border-spacing-y-2 text-sm">
                          <thead>
                              <tr className={isDark ? 'text-zinc-500' : 'text-gray-500'}>
                                  {['项目', '导演组', '人员', '任务类型', '模型', '节点', '积分', '状态'].map(head => (
                                      <th key={head} className="px-3 py-2 text-left text-xs font-semibold">{head}</th>
                                  ))}
                              </tr>
                          </thead>
                          <tbody>
                              {rows.map(row => (
                                  <tr key={row.id} className={isDark ? 'bg-zinc-950/55 text-zinc-200' : 'bg-gray-50 text-gray-800'}>
                                      <td className="rounded-l-xl px-3 py-3">{row.project}</td>
                                      <td className="px-3 py-3">{row.group}</td>
                                      <td className="px-3 py-3">{row.user}</td>
                                      <td className="px-3 py-3">{row.type}</td>
                                      <td className="px-3 py-3">{row.model}</td>
                                      <td className="px-3 py-3">{row.nodeTitle}</td>
                                      <td className="px-3 py-3 font-semibold tabular-nums">{row.credit}</td>
                                      <td className="rounded-r-xl px-3 py-3">
                                          <span className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                                              row.status === 'confirmed'
                                                  ? (isDark ? 'bg-emerald-500/10 text-emerald-300' : 'bg-emerald-50 text-emerald-700')
                                                  : row.status === 'reserved'
                                                      ? (isDark ? 'bg-[#4446CE]/10 text-[#B9BAFF]' : 'bg-[#F0F1FF] text-[#3739B0]')
                                                      : row.status === 'refunded'
                                                          ? (isDark ? 'bg-zinc-800 text-zinc-300' : 'bg-gray-100 text-gray-600')
                                                          : (isDark ? 'bg-amber-500/10 text-amber-300' : 'bg-amber-50 text-amber-700')
                                          }`}>
                                              {statusText[row.status] || row.status}
                                          </span>
                                      </td>
                                  </tr>
                              ))}
                          </tbody>
                      </table>
                  </div>
              </div>
          </div>
      );
  };

  const renderCreditDashboardV2 = () => {
      if (!isCreditDashboardOpen) return null;
      const statusText: Record<string, string> = {
          estimated: '预计',
          reserved: '已预扣',
          confirmed: '已扣除',
          refunded: '已返还',
          failed: '异常',
          idle: '未开始',
      };
      const rows = getCreditRows();
      const activeProjectId = creditProjectId || currentProject?.id || projects[0]?.id || 'all';
      const visibleRows = activeProjectId === 'all' ? rows : rows.filter(row => row.projectId === activeProjectId);
      const total = visibleRows.reduce((sum, row) => sum + row.credit, 0);
      const confirmed = visibleRows.filter(row => row.status === 'confirmed').reduce((sum, row) => sum + row.credit, 0);
      const reserved = visibleRows.filter(row => row.status === 'reserved').reduce((sum, row) => sum + row.credit, 0);
      const refunded = visibleRows.filter(row => row.status === 'refunded').reduce((sum, row) => sum + row.credit, 0);
      const projectSummaries = projects.map(project => {
          const projectRows = rows.filter(row => row.projectId === project.id);
          return {
              ...project,
              total: projectRows.reduce((sum, row) => sum + row.credit, 0),
              confirmed: projectRows.filter(row => row.status === 'confirmed').reduce((sum, row) => sum + row.credit, 0),
              reserved: projectRows.filter(row => row.status === 'reserved').reduce((sum, row) => sum + row.credit, 0),
          };
      });

      return (
          <div className="fixed inset-0 z-[250] bg-black/70 backdrop-blur-md p-6" onClick={() => setIsCreditDashboardOpen(false)}>
              <div className={`mx-auto flex h-full max-w-6xl flex-col rounded-3xl border shadow-2xl ${isDark ? 'border-zinc-800 bg-[#121417] text-zinc-100' : 'border-gray-200 bg-white text-gray-900'}`} onClick={(event) => event.stopPropagation()}>
                  <div className={`flex items-center gap-4 border-b px-6 py-4 ${isDark ? 'border-zinc-800' : 'border-gray-100'}`}>
                      <div className="min-w-0 flex-1">
                          <h3 className="text-xl font-bold">项目积分看板</h3>
                          <p className={`mt-1 text-sm ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>查看所有项目的大体消耗，默认展开当前项目明细。</p>
                      </div>
                      <select
                          value={activeProjectId}
                          onChange={(event) => setCreditProjectId(event.target.value)}
                          className={`h-10 rounded-xl border px-3 text-sm outline-none ${isDark ? 'border-zinc-700 bg-zinc-950 text-zinc-200' : 'border-gray-200 bg-white text-gray-700'}`}
                      >
                          <option value="all">全部项目</option>
                          {projects.map(project => (
                              <option key={project.id} value={project.id}>{project.name}</option>
                          ))}
                      </select>
                      <button className={`h-10 w-10 rounded-full flex items-center justify-center ${isDark ? 'hover:bg-zinc-800 text-zinc-400 hover:text-white' : 'hover:bg-gray-100 text-gray-500 hover:text-gray-900'}`} onClick={() => setIsCreditDashboardOpen(false)}>
                          <Icons.X size={22} />
                      </button>
                  </div>

                  <div className="grid grid-cols-4 gap-4 px-6 pt-6">
                      {[
                          ['当前查看消耗', total],
                          ['已确认扣除', confirmed],
                          ['当前预扣', reserved],
                          ['失败返还', refunded],
                      ].map(([label, value]) => (
                          <div key={String(label)} className={`rounded-2xl border p-4 ${isDark ? 'border-zinc-800 bg-zinc-950/45' : 'border-gray-200 bg-gray-50'}`}>
                              <div className={`text-xs ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>{label}</div>
                              <div className="mt-2 text-2xl font-bold tabular-nums">{value}</div>
                              <div className={`mt-1 text-[11px] ${isDark ? 'text-zinc-600' : 'text-gray-400'}`}>积分</div>
                          </div>
                      ))}
                  </div>

                  <div className="grid grid-cols-3 gap-3 px-6 py-4">
                      {projectSummaries.map(project => (
                          <button
                              key={project.id}
                              onClick={() => setCreditProjectId(project.id)}
                              className={`rounded-2xl border p-3 text-left transition-all ${
                                  activeProjectId === project.id
                                      ? (isDark ? 'border-[#4446CE]/60 bg-[#4446CE]/10' : 'border-[#B9BAFF] bg-[#F0F1FF]')
                                      : (isDark ? 'border-zinc-800 bg-zinc-950/35 hover:border-zinc-700' : 'border-gray-200 bg-gray-50 hover:border-gray-300')
                              }`}
                          >
                              <div className="truncate text-sm font-bold">{project.name}</div>
                              <div className={`mt-1 truncate text-xs ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>{project.directorGroup}</div>
                              <div className="mt-3 flex items-center justify-between text-xs">
                                  <span className={isDark ? 'text-zinc-500' : 'text-gray-500'}>总消耗</span>
                                  <span className="font-bold tabular-nums">{project.total}</span>
                              </div>
                          </button>
                      ))}
                  </div>

                  <div className="flex-1 overflow-auto px-6 pb-6">
                      <table className="w-full border-separate border-spacing-y-2 text-sm">
                          <thead>
                              <tr className={isDark ? 'text-zinc-500' : 'text-gray-500'}>
                                  {['项目', '导演组', '人员', '任务类型', '模型', '节点', '积分', '状态'].map(head => (
                                      <th key={head} className="px-3 py-2 text-left text-xs font-semibold">{head}</th>
                                  ))}
                              </tr>
                          </thead>
                          <tbody>
                              {visibleRows.map(row => (
                                  <tr key={row.id} className={isDark ? 'bg-zinc-950/55 text-zinc-200' : 'bg-gray-50 text-gray-800'}>
                                      <td className="rounded-l-xl px-3 py-3">{row.project}</td>
                                      <td className="px-3 py-3">{row.group}</td>
                                      <td className="px-3 py-3">{row.user}</td>
                                      <td className="px-3 py-3">{row.type}</td>
                                      <td className="px-3 py-3">{row.model}</td>
                                      <td className="px-3 py-3">{row.nodeTitle}</td>
                                      <td className="px-3 py-3 font-semibold tabular-nums">{row.credit}</td>
                                      <td className="rounded-r-xl px-3 py-3">
                                          <span className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                                              row.status === 'confirmed'
                                                  ? (isDark ? 'bg-emerald-500/10 text-emerald-300' : 'bg-emerald-50 text-emerald-700')
                                                  : row.status === 'reserved'
                                                      ? (isDark ? 'bg-[#4446CE]/10 text-[#B9BAFF]' : 'bg-[#F0F1FF] text-[#3739B0]')
                                                      : row.status === 'refunded'
                                                          ? (isDark ? 'bg-zinc-800 text-zinc-300' : 'bg-gray-100 text-gray-600')
                                                          : (isDark ? 'bg-amber-500/10 text-amber-300' : 'bg-amber-50 text-amber-700')
                                          }`}>
                                              {statusText[row.status] || row.status}
                                          </span>
                                      </td>
                                  </tr>
                              ))}
                          </tbody>
                      </table>
                  </div>
              </div>
          </div>
      );
  };

  const renderCanvasNavigator = () => {
      const metrics = getMiniMapMetrics();
      const panelClass = isDark ? 'border-zinc-800 bg-[#18181b]/95 text-zinc-100' : 'border-gray-200 bg-white/95 text-gray-900';
      const buttonClass = isDark ? 'text-zinc-400 hover:bg-white/5 hover:text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900';

      return (
          <div className="absolute bottom-4 left-4 z-50 flex flex-col gap-2">
              {isMiniMapOpen && (
                  <div className={`rounded-2xl border p-2 shadow-2xl backdrop-blur-xl ${panelClass}`}>
                      <div
                          className={`relative overflow-hidden rounded-xl border cursor-grab active:cursor-grabbing ${isDark ? 'border-zinc-700 bg-zinc-950/70' : 'border-gray-200 bg-gray-50'}`}
                          style={{ width: metrics.miniWidth, height: metrics.miniHeight }}
                          onMouseDown={handleMiniMapMouseDown}
                          title="拖动小地图移动画布"
                      >
                          <svg width={metrics.miniWidth} height={metrics.miniHeight} className="absolute inset-0">
                              {metrics.nodeRects.map(rect => (
                                  <rect
                                      key={rect.id}
                                      x={rect.x}
                                      y={rect.y}
                                      width={rect.width}
                                      height={rect.height}
                                      rx={2}
                                      fill={rect.selected ? '#8F91F4' : (isDark ? '#71717a' : '#9ca3af')}
                                      opacity={rect.selected ? 0.9 : 0.55}
                                  />
                              ))}
                              <rect
                                  x={metrics.viewportRect.x}
                                  y={metrics.viewportRect.y}
                                  width={metrics.viewportRect.width}
                                  height={metrics.viewportRect.height}
                                  fill="transparent"
                                  stroke={isDark ? '#e5e7eb' : '#111827'}
                                  strokeWidth={1.5}
                                  strokeDasharray="4 3"
                              />
                          </svg>
                      </div>
                  </div>
              )}
              <div className={`flex items-center gap-1 rounded-2xl border px-2 py-1.5 shadow-xl backdrop-blur-xl ${panelClass}`}>
                  <button className={`h-9 w-9 rounded-xl flex items-center justify-center ${buttonClass}`} title="小地图" onClick={() => setIsMiniMapOpen(prev => !prev)}>
                      <Icons.Map size={17} />
                  </button>
                  <button className={`h-9 w-9 rounded-xl flex items-center justify-center ${buttonClass}`} title="整理画布" onClick={arrangeCanvasNodes}>
                      <Icons.LayoutGrid size={17} />
                  </button>
                  <button className={`h-9 w-9 rounded-xl flex items-center justify-center ${buttonClass}`} title={isDark ? '切换亮色' : '切换暗色'} onClick={() => toggleTheme(!isDark)}>
                      {isDark ? <Icons.Moon size={17} /> : <Icons.Sun size={17} />}
                  </button>
                  <div className={`mx-1 h-5 w-px ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />
                  <button className={`h-9 w-9 rounded-xl flex items-center justify-center ${buttonClass}`} title="缩小" onClick={() => zoomCanvas(-1)}>
                      <Icons.Minus size={16} />
                  </button>
                  <span className={`min-w-12 text-center text-sm font-semibold tabular-nums ${isDark ? 'text-zinc-200' : 'text-gray-700'}`}>{Math.round(transform.k * 100)}%</span>
                  <button className={`h-9 w-9 rounded-xl flex items-center justify-center ${buttonClass}`} title="放大" onClick={() => zoomCanvas(1)}>
                      <Icons.Plus size={18} />
                  </button>
              </div>
          </div>
      );
  };

  const renderContextMenu = () => {
    if (!contextMenu) return null;
    return (
        <div className={`fixed z-50 border rounded-xl shadow-2xl py-2 min-w-[180px] flex flex-col backdrop-blur-xl animate-in fade-in zoom-in-95 duration-100 ${isDark ? 'bg-zinc-900/95 border-zinc-700/80' : 'bg-white/95 border-gray-200'}`} style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
            <button
                className={`mx-1 flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs transition-all duration-150 ${
                    canvasHistoryCount > 0
                        ? (isDark ? 'text-gray-300 hover:bg-zinc-800/80 hover:text-white' : 'text-gray-700 hover:bg-gray-100 hover:text-black')
                        : (isDark ? 'cursor-not-allowed text-zinc-600' : 'cursor-not-allowed text-gray-300')
                }`}
                onClick={undoLastCanvasAction}
                disabled={canvasHistoryCount === 0}
            >
                <Icons.RotateCcw size={14} />
                <span className="flex-1">撤回上一步</span>
                <span className={`text-[9px] ${isDark ? 'text-zinc-500' : 'text-gray-400'}`}>Ctrl/⌘+Z</span>
            </button>
            <div className={`h-px my-1.5 mx-2 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`}></div>
            {contextMenu.type === 'NODE' && contextMenu.nodeId && (() => {
                const menuItemClass = `text-left px-3 py-2 text-xs transition-all duration-150 flex items-center gap-2.5 rounded-md mx-1 ${isDark ? 'text-gray-300 hover:bg-zinc-800/80 hover:text-white' : 'text-gray-700 hover:bg-gray-100 hover:text-black'}`;
                const node = nodes.find(n => n.id === contextMenu.nodeId);
                const isImageNode = Boolean(node?.imageSrc) || contextMenu.nodeType === NodeType.TEXT_TO_IMAGE || contextMenu.nodeType === NodeType.IMAGE_TO_IMAGE || contextMenu.nodeType === NodeType.ORIGINAL_IMAGE;
                const isVideoNode = Boolean(node?.videoSrc) || contextMenu.nodeType === NodeType.TEXT_TO_VIDEO || contextMenu.nodeType === NodeType.IMAGE_TO_VIDEO || contextMenu.nodeType === NodeType.START_END_TO_VIDEO;
                const isTextNode = contextMenu.nodeType === NodeType.CREATIVE_DESC;
                const isDirectorDeskNode = contextMenu.nodeType === NodeType.DIRECTOR_DESK;
                
                return (
                    <>
                        <button className={menuItemClass} onClick={() => { performCopy(); setContextMenu(null); }}>
                            <Icons.Copy size={14}/> 复制节点
                        </button>
                        {isDirectorDeskNode && (
                            <button className={menuItemClass} onClick={() => { if (contextMenu.nodeId) openDirectorDesk(contextMenu.nodeId); }}>
                                <Icons.Clapperboard size={14}/> 进入导演台
                            </button>
                        )}
                        {isTextNode && (
                            <button className={menuItemClass} onClick={() => { const text = node ? getTextNodeOutput(node) : ''; if (text) navigator.clipboard?.writeText(text); setContextMenu(null); }}>
                                <Icons.FileText size={14}/> 复制文本
                            </button>
                        )}
                        {isImageNode && (
                            <button className={menuItemClass} onClick={() => { if (contextMenu.nodeId) { handleSeedanceAudit(contextMenu.nodeId); setContextMenu(null); } }}>
                                <Icons.ShieldCheck size={14} className="text-emerald-400"/> Seedance 2.0 合规审核
                            </button>
                        )}
                        <div className={`h-px my-1.5 mx-2 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`}></div>
                        <button className={`text-left px-3 py-2 text-xs transition-all duration-150 flex items-center gap-2.5 rounded-md mx-1 text-red-400 ${isDark ? 'hover:bg-red-500/10 hover:text-red-300' : 'hover:bg-red-50 hover:text-red-600'}`} onClick={() => { if (contextMenu.nodeId) deleteNode(contextMenu.nodeId); setContextMenu(null); }}>
                            <Icons.Trash2 size={14}/> 删除
                        </button>
                    </>
                );
            })()}
            {contextMenu.type === 'CANVAS' && (() => {
                const menuItemClass = `text-left px-3 py-2 text-xs transition-all duration-150 flex items-center gap-2.5 rounded-md mx-1 ${isDark ? 'text-gray-300 hover:bg-zinc-800/80 hover:text-white' : 'text-gray-700 hover:bg-gray-100 hover:text-black'}`;
                return (
                    <>
                        <button className={`${menuItemClass} ${!internalClipboard ? 'opacity-40 cursor-not-allowed' : ''}`} onClick={() => { performPaste({ x: contextMenu.worldX, y: contextMenu.worldY }); setContextMenu(null); }} disabled={!internalClipboard}>
                            <Icons.Copy size={14}/> 粘贴
                        </button>
                        <div className={`h-px my-1.5 mx-2 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`}></div>
                        <div className={`px-3 py-1 text-[9px] font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-gray-400'}`}>添加节点</div>
                        <button className={menuItemClass} onClick={() => { addNode(NodeType.TEXT_TO_IMAGE, contextMenu.worldX, contextMenu.worldY); setContextMenu(null); }}>
                            <div className="w-5 h-5 rounded bg-[#4446CE]/10 flex items-center justify-center"><Icons.Image size={12} className="text-[#8F91F4]"/></div>
                            <span>生图</span>
                        </button>
                        <button className={menuItemClass} onClick={() => { addNode(NodeType.CREATIVE_DESC, contextMenu.worldX, contextMenu.worldY); setContextMenu(null); }}>
                            <div className="w-5 h-5 rounded bg-zinc-500/10 flex items-center justify-center"><Icons.FileText size={12} className={isDark ? 'text-zinc-300' : 'text-zinc-600'}/></div>
                            <span>文本</span>
                        </button>
                        <button className={menuItemClass} onClick={() => { addNode(NodeType.TEXT_TO_VIDEO, contextMenu.worldX, contextMenu.worldY); setContextMenu(null); }}>
                            <div className="w-5 h-5 rounded bg-[#4446CE]/10 flex items-center justify-center"><Icons.Video size={12} className="text-[#8F91F4]"/></div>
                            <span>生视频</span>
                        </button>
                        <button className={menuItemClass} onClick={() => { addNode(NodeType.TEXT_TO_AUDIO, contextMenu.worldX, contextMenu.worldY); setContextMenu(null); }}>
                            <div className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center"><Icons.Music size={12} className="text-amber-300"/></div>
                            <span>音频</span>
                        </button>
                        <button className={menuItemClass} onClick={() => { addNode(NodeType.DIRECTOR_DESK, contextMenu.worldX, contextMenu.worldY); setContextMenu(null); }}>
                            <div className="w-5 h-5 rounded bg-[#4446CE]/10 flex items-center justify-center"><Icons.Clapperboard size={12} className="text-[#8F91F4]"/></div>
                            <span>3D导演台</span>
                        </button>
                        <button className={menuItemClass} onClick={() => { assetImportPositionRef.current = { x: contextMenu.worldX, y: contextMenu.worldY }; assetImportConnectionRef.current = null; assetInputRef.current?.click(); setContextMenu(null); }}>
                            <div className="w-5 h-5 rounded bg-emerald-500/10 flex items-center justify-center"><Icons.Upload size={12} className="text-emerald-400"/></div>
                            <span>上传</span>
                        </button>
                    </>
                );
            })()}
        </div>
    );
  };

  const renderQuickAddMenu = () => {
    if (!quickAddMenu) return null;
    
    const menuItemClass = `text-left px-3 py-2 text-xs transition-all duration-150 flex items-center gap-2.5 rounded-lg mx-1 ${isDark ? 'text-gray-300 hover:bg-zinc-800/80 hover:text-white' : 'text-gray-700 hover:bg-gray-100 hover:text-black'}`;
    const groupLabelClass = `px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-gray-400'}`;
    
    return (
        <div 
            className={`fixed z-50 border rounded-xl shadow-2xl py-2 min-w-[200px] flex flex-col animate-in fade-in zoom-in-95 duration-150 backdrop-blur-xl ${isDark ? 'bg-zinc-900/95 border-zinc-700/80' : 'bg-white/95 border-gray-200'}`} 
            style={{ left: quickAddMenu.x, top: quickAddMenu.y }} 
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div className={`px-3 pb-2 mb-1 text-[11px] font-semibold border-b ${isDark ? 'text-gray-200 border-zinc-800' : 'text-gray-800 border-gray-100'}`}>
                连接到节点
            </div>
            
            <div className={groupLabelClass}>生成</div>
            <button className={menuItemClass} onClick={() => handleQuickAddNode(NodeType.TEXT_TO_IMAGE)}>
                <div className="w-6 h-6 rounded-md bg-[#4446CE]/10 flex items-center justify-center"><Icons.Image size={14} className="text-[#8F91F4]"/></div>
                <span>生图</span>
            </button>
            <button className={menuItemClass} onClick={() => handleQuickAddNode(NodeType.CREATIVE_DESC)}>
                <div className="w-6 h-6 rounded-md bg-zinc-500/10 flex items-center justify-center"><Icons.FileText size={14} className={isDark ? 'text-zinc-300' : 'text-zinc-600'}/></div>
                <span>文本</span>
            </button>
            <button className={menuItemClass} onClick={() => handleQuickAddNode(NodeType.TEXT_TO_VIDEO)}>
                <div className="w-6 h-6 rounded-md bg-[#4446CE]/10 flex items-center justify-center"><Icons.Video size={14} className="text-[#8F91F4]"/></div>
                <span>生视频</span>
            </button>
            <button className={menuItemClass} onClick={() => handleQuickAddNode(NodeType.TEXT_TO_AUDIO)}>
                <div className="w-6 h-6 rounded-md bg-amber-500/10 flex items-center justify-center"><Icons.Music size={14} className="text-amber-300"/></div>
                <span>音频</span>
            </button>
            <button className={menuItemClass} onClick={() => {
                assetImportPositionRef.current = { x: quickAddMenu.worldX, y: quickAddMenu.worldY };
                assetImportConnectionRef.current = { sourceId: quickAddMenu.sourceId, direction: quickAddMenu.direction };
                assetInputRef.current?.click();
                setQuickAddMenu(null);
            }}>
                <div className="w-6 h-6 rounded-md bg-emerald-500/10 flex items-center justify-center"><Icons.Upload size={14} className="text-emerald-400"/></div>
                <span>上传</span>
            </button>
            
        </div>
    );
  };

  const toggleTheme = (dark: boolean) => {
      setCanvasBg(dark ? '#0B0C0E' : '#F5F7FA');
  };

  if (isCheckingAuth) {
      return (
          <div className="w-full h-screen flex items-center justify-center bg-[#0b0c0e] text-zinc-300">
              <Icons.Loader2 size={24} className="animate-spin mr-2" />
              加载中...
          </div>
      );
  }

  if (!isAuthenticated) {
      return <LoginScreen onLogin={() => setIsAuthenticated(true)} />;
  }

  if (!currentProject) {
       return renderProjectDashboardV2();
  }

  const activeSelectionBounds = selectedGroup
      ? groupBoundsById.get(selectedGroup.id) || null
      : selectedNodeBounds;
  const canvasRect = containerRef.current?.getBoundingClientRect();
  const selectionFrameStyle = activeSelectionBounds && canvasRect ? {
      left: canvasRect.left + transform.x + activeSelectionBounds.x * transform.k,
      top: canvasRect.top + transform.y + activeSelectionBounds.y * transform.k,
      width: activeSelectionBounds.width * transform.k,
      height: activeSelectionBounds.height * transform.k,
  } : null;
  const toolbarPosition = activeSelectionBounds && canvasRect ? (() => {
      const centerX = canvasRect.left + transform.x + (activeSelectionBounds.x + activeSelectionBounds.width / 2) * transform.k;
      const estimatedHalfWidth = selectedGroup ? 170 : 118;
      return {
          left: Math.max(canvasRect.left + estimatedHalfWidth + 8, Math.min(centerX, canvasRect.right - estimatedHalfWidth - 8)),
          top: Math.max(canvasRect.top + 8, canvasRect.top + transform.y + activeSelectionBounds.y * transform.k - 44),
      };
  })() : null;

  return (
    <div className="w-full h-screen overflow-hidden flex relative font-sans text-gray-800">
        <WelcomeModal
            isOpen={isWelcomeOpen}
            onClose={() => setIsWelcomeOpen(false)}
            isDark={isDark}
        />
        <StorageModal
            isOpen={isStorageOpen}
            onClose={() => setIsStorageOpen(false)}
            isDark={isDark}
        />
        <ExportImportModal
            isOpen={isExportImportOpen}
            onClose={() => setIsExportImportOpen(false)}
            isDark={isDark}
            projectName={projectName}
            onProjectNameChange={setProjectName}
            nodes={nodes}
            connections={connections}
            transform={transform}
            onImport={handleImportWorkflow}
        />
        {auditFailureNotice && (
            <div
                className="pointer-events-none fixed inset-x-0 top-4 z-[420] flex justify-center px-4"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="pointer-events-auto flex w-fit max-w-[min(760px,calc(100vw-32px))] items-center gap-3 rounded-xl border border-red-300/30 bg-red-500/80 px-4 py-2.5 text-white shadow-[0_12px_36px_rgba(127,29,29,0.35)] backdrop-blur-xl">
                    <Icons.AlertCircle size={17} className="shrink-0" />
                    <div className="min-w-0 text-sm leading-5">
                        <span className="font-semibold">部分图片审核未通过：</span>
                        <span>
                            检测到 {auditFailureNotice.count} 张参考图片未通过审核，相关图片节点已标红。请点击视频节点内的“审核未通过”查看原因，调整图片后重新生成。
                        </span>
                    </div>
                    <div className="ml-1 h-5 w-px shrink-0 bg-white/25" />
                    <div className="relative shrink-0 group/audit-notice-close">
                        <button
                            type="button"
                            onClick={() => setAuditFailureNotice(null)}
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/15 hover:text-white"
                            aria-label="关闭审核提示"
                        >
                            <Icons.X size={16} />
                        </button>
                        <div className="pointer-events-none absolute right-0 top-full mt-1.5 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[9px] text-zinc-200 opacity-0 shadow-lg transition-opacity group-hover/audit-notice-close:opacity-100">
                            关闭
                        </div>
                    </div>
                </div>
            </div>
        )}

        <Sidebar 
          onAddNode={addNode} 
          onNewWorkflow={handleNewWorkflow}
          onSaveProject={() => handleSaveProject()}
          onBackToProjects={returnToProjectManagement}
          onOpenCreditDashboard={() => setIsCreditDashboardOpen(true)}
          onImportAsset={() => assetInputRef.current?.click()}
          onOpenExportImport={() => setIsExportImportOpen(true)}
          nodes={[...nodes, ...deletedNodes]}
          onPreviewMedia={handleHistoryPreview}
          onPreviewText={(title, text) => setPreviewText({ title, text })}
          onSaveAsset={saveAssetFile}
          onOpenSaveResult={openSaveResultModal}
          onCopyAsset={copyAssetToClipboard}
          onDeleteAsset={deleteAssetFromLibrary}
          assetLibrary={DEMO_ASSET_LIBRARY}
          onAddAssetToCanvas={handleAddAssetToCanvas}
          onAddMaterialToCanvas={handleAddMaterialToCanvas}
          onToggleMaterialFavorite={handleToggleMaterialFavorite}
          onAddShotClipToCanvas={handleAddShotClipToCanvas}
          isDark={isDark}
        />
        <input type="file" ref={workflowInputRef} hidden accept=".aistudio-flow,.json" onChange={handleLoadWorkflow} />
        <input type="file" ref={assetInputRef} hidden accept="image/*,video/*,.txt,.md,.markdown,text/plain" onChange={handleImportAsset} />
        <input type="file" ref={replaceImageRef} hidden accept="*/*" onChange={handleReplaceImage} />
        <input type="file" ref={attachInputRef} hidden accept="image/*,video/*,audio/*,.txt,.md,.markdown,text/plain,text/markdown" onChange={handleAttachInputAsset} />
        <div 
            ref={containerRef}
            className={`flex-1 w-full h-full relative grid-pattern select-none ${dragMode === 'PAN' ? 'cursor-grabbing' : 'cursor-grab'}`}
            style={{ 
                backgroundColor: canvasBg,
                '--grid-color': isDark ? '#27272a' : '#E4E4E7'
            } as React.CSSProperties}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onContextMenu={handleCanvasContextMenu}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
            <div
                className="absolute origin-top-left will-change-transform"
                style={{
                    transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`,
                    '--canvas-scale': transform.k,
                    '--panel-inverse-scale': 1 / Math.max(transform.k, 0.1),
                } as React.CSSProperties}
            >
                {/* Persistent group backdrops live in world coordinates; nodes keep
                    their existing world coordinates above them. */}
                {groups.map(group => {
                    const bounds = groupBoundsById.get(group.id);
                    if (!bounds) return null;
                    const isSelected = selectedGroupId === group.id;
                    const isEditing = editingGroupId === group.id;
                    return (
                        <React.Fragment key={group.id}>
                            <div
                                className={`absolute rounded-2xl border transition-colors ${isSelected ? 'border-[#4446CE] bg-[#4446CE]/[0.08]' : (isDark ? 'border-zinc-700/80 bg-zinc-900/20' : 'border-[#C8CAFF] bg-[#EEF0FF]/45')}`}
                                style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, zIndex: 2, pointerEvents: 'none' }}
                            />
                            <div
                                className={`absolute left-3 top-3 flex h-9 max-w-[calc(100%-24px)] items-center gap-2 rounded-lg border px-3 text-xs font-semibold shadow-sm ${isSelected ? 'border-[#4446CE]/45 bg-[#4446CE] text-white' : (isDark ? 'border-zinc-700 bg-zinc-900 text-zinc-200' : 'border-[#C8CAFF] bg-white text-[#3739B0]')}`}
                                style={{ left: bounds.x, top: bounds.y, zIndex: 60, pointerEvents: 'auto', cursor: 'grab' }}
                                onMouseDown={(event) => handleGroupMouseDown(event, group.id)}
                                onDoubleClick={(event) => handleGroupDoubleClick(event, group.id)}
                                title="拖动整体移动；双击进入组内编辑"
                            >
                                <span className="truncate">{group.title}</span>
                                <span className={`shrink-0 text-[10px] font-medium ${isSelected ? 'text-white/70' : 'text-current opacity-55'}`}>{group.memberIds.length} 个节点</span>
                                {isEditing && <span className="shrink-0 rounded bg-white/20 px-1.5 py-0.5 text-[9px]">组内编辑</span>}
                            </div>
                        </React.Fragment>
                    );
                })}
                {/* Connection Lines - Rendered as absolute positioned divs with SVG */}
                {connections.map(conn => {
                    const source = nodes.find(n => n.id === conn.sourceId);
                    const target = nodes.find(n => n.id === conn.targetId);
                    if (!source || !target) return null;
                    
                    // 源节点右侧输出端口位置
                    const sx = source.x + source.width;
                    const sy = source.y + source.height / 2;
                    // 目标节点左侧输入端口位置
                    const tx = target.x;
                    const ty = target.y + target.height / 2;
                    
                    // 计算贝塞尔曲线控制点
                    const dist = Math.abs(tx - sx);
                    const cp = Math.max(50, dist * 0.4);
                    
                    // 计算SVG边界
                    const minX = Math.min(sx, tx) - cp - 20;
                    const minY = Math.min(sy, ty) - 20;
                    const maxX = Math.max(sx, tx) + cp + 20;
                    const maxY = Math.max(sy, ty) + 20;
                    const svgWidth = maxX - minX;
                    const svgHeight = maxY - minY;
                    
                    // 相对于SVG的坐标
                    const relSx = sx - minX;
                    const relSy = sy - minY;
                    const relTx = tx - minX;
                    const relTy = ty - minY;
                    
                    const d = `M ${relSx} ${relSy} C ${relSx + cp} ${relSy}, ${relTx - cp} ${relTy}, ${relTx} ${relTy}`;
                    const isSelected = selectedConnectionId === conn.id;
                    const isConnectedToSelectedNode = selectedNodeIds.has(conn.sourceId) || selectedNodeIds.has(conn.targetId);
                    
                    // 连接线颜色
                    const lineColor = isSelected ? (isDark ? "#d4d4d8" : "#52525b") : (isDark ? "#71717a" : "#9ca3af");
                    
                    // 计算贝塞尔曲线上 t=0.5 的实际中点位置
                    const t = 0.5;
                    const p0x = relSx, p0y = relSy;
                    const p1x = relSx + cp, p1y = relSy;
                    const p2x = relTx - cp, p2y = relTy;
                    const p3x = relTx, p3y = relTy;
                    const midX = Math.pow(1-t,3)*p0x + 3*Math.pow(1-t,2)*t*p1x + 3*(1-t)*Math.pow(t,2)*p2x + Math.pow(t,3)*p3x;
                    const midY = Math.pow(1-t,3)*p0y + 3*Math.pow(1-t,2)*t*p1y + 3*(1-t)*Math.pow(t,2)*p2y + Math.pow(t,3)*p3y;
                    
                    return (
                        <svg 
                            key={conn.id}
                            className="absolute"
                            style={{ 
                                left: minX, 
                                top: minY, 
                                width: svgWidth, 
                                height: svgHeight,
                                zIndex: isSelected ? 20 : 5,
                                overflow: 'visible',
                                pointerEvents: 'none'
                            }}
                        >
                            {/* 点击区域 */}
                            <path 
                                d={d} 
                                stroke="transparent" 
                                strokeWidth={16} 
                                fill="none" 
                                style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                                onClick={(e) => { e.stopPropagation(); setSelectedConnectionId(conn.id); }}
                            />
                            {/* Base connection line */}
                            <path 
                                d={d} 
                                stroke={lineColor}
                                strokeWidth={isSelected ? 2.5 : 2}
                                fill="none" 
                                strokeLinecap="round"
                                opacity={isSelected ? 0.9 : 0.5}
                                style={{ pointerEvents: 'none' }}
                            />
                            {/* Flowing glow only for connections touching the selected node. */}
                            {isConnectedToSelectedNode && (
                                <>
                                    <path
                                        d={d}
                                        stroke="#7DD3FC"
                                        strokeWidth={isSelected ? 7 : 6}
                                        fill="none"
                                        strokeLinecap="round"
                                        strokeDasharray="14 34"
                                        opacity={isSelected ? 0.34 : 0.24}
                                        style={{
                                            pointerEvents: 'none',
                                            filter: 'drop-shadow(0 0 4px rgba(125, 211, 252, 0.9))',
                                        }}
                                    >
                                        <animate
                                            attributeName="stroke-dashoffset"
                                            from="0"
                                            to="-48"
                                            dur="4.8s"
                                            repeatCount="indefinite"
                                        />
                                    </path>
                                    <path
                                        d={d}
                                        stroke="#BAE6FD"
                                        strokeWidth={isSelected ? 2.2 : 1.6}
                                        fill="none"
                                        strokeLinecap="round"
                                        strokeDasharray="14 34"
                                        opacity={isSelected ? 0.9 : 0.72}
                                        style={{ pointerEvents: 'none' }}
                                    >
                                        <animate
                                            attributeName="stroke-dashoffset"
                                            from="0"
                                            to="-48"
                                            dur="4.8s"
                                            repeatCount="indefinite"
                                        />
                                    </path>
                                </>
                            )}
                            {/* 删除按钮 - 使用纯 SVG 实现 */}
                            {isSelected && (
                                <g 
                                    style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                                    onClick={(e) => { e.stopPropagation(); removeConnection(conn.id); }}
                                    onMouseDown={(e) => e.stopPropagation()}
                                >
                                    {/* 按钮背景 */}
                                    <circle 
                                        cx={midX} 
                                        cy={midY} 
                                        r={10}
                                        fill={isDark ? "#27272a" : "#ffffff"}
                                        stroke={isDark ? "#52525b" : "#d1d5db"}
                                        strokeWidth={1}
                                        className="hover:stroke-red-500"
                                    />
                                    {/* X 图标 */}
                                    <line 
                                        x1={midX - 4} y1={midY - 4} 
                                        x2={midX + 4} y2={midY + 4} 
                                        stroke={isDark ? "#a1a1aa" : "#6b7280"}
                                        strokeWidth={2}
                                        strokeLinecap="round"
                                        className="hover:stroke-red-500"
                                    />
                                    <line 
                                        x1={midX + 4} y1={midY - 4} 
                                        x2={midX - 4} y2={midY + 4} 
                                        stroke={isDark ? "#a1a1aa" : "#6b7280"}
                                        strokeWidth={2}
                                        strokeLinecap="round"
                                        className="hover:stroke-red-500"
                                    />
                                </g>
                            )}
                        </svg>
                    );
                })}
                
                {/* 拖拽连接预览线 */}
                {dragMode === 'CONNECT' && connectionStartRef.current && tempConnection && (() => {
                    const sourceNode = nodes.find(n => n.id === connectionStartRef.current?.nodeId);
                    if (!sourceNode) return null;

                    // 反向连接(从输入端口拖出)时，预览线从节点左侧出发，曲线向左弯。
                    const fromSource = connectionStartRef.current?.type === 'source';
                    const sx = fromSource ? sourceNode.x + sourceNode.width : sourceNode.x;
                    const sy = sourceNode.y + sourceNode.height / 2;
                    const tx = tempConnection.x;
                    const ty = tempConnection.y;

                    const dist = Math.abs(tx - sx);
                    const cp = Math.max(30, dist * 0.3);

                    const minX = Math.min(sx, tx) - cp - 20;
                    const minY = Math.min(sy, ty) - 20;
                    const maxX = Math.max(sx, tx) + cp + 20;
                    const maxY = Math.max(sy, ty) + 20;

                    const relSx = sx - minX;
                    const relSy = sy - minY;
                    const relTx = tx - minX;
                    const relTy = ty - minY;

                    const c1x = fromSource ? relSx + cp : relSx - cp;
                    const c2x = fromSource ? relTx - cp : relTx + cp;
                    const d = `M ${relSx} ${relSy} C ${c1x} ${relSy}, ${c2x} ${relTy}, ${relTx} ${relTy}`;
                    
                    return (
                        <svg 
                            className="absolute pointer-events-none"
                            style={{ 
                                left: minX, 
                                top: minY, 
                                width: maxX - minX, 
                                height: maxY - minY,
                                zIndex: 100,
                                overflow: 'visible'
                            }}
                        >
                            {/* 虚线预览 */}
                            <path 
                                d={d} 
                                stroke="#4446CE"
                                strokeWidth={2} 
                                fill="none" 
                                strokeDasharray="6,4" 
                                strokeLinecap="round"
                            />
                            {/* 目标点指示器 */}
                            <circle 
                                cx={relTx} 
                                cy={relTy} 
                                r={5} 
                                fill="#4446CE"
                            />
                        </svg>
                    );
                })()}
                {nodes.map(node => (
                    <BaseNode
                        key={node.id}
                        data={node}
                        selected={selectedNodeIds.has(node.id)}
                        onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                        onDoubleClick={(e) => handleNodeDoubleClick(e, node.id)}
                        onContextMenu={(e) => handleNodeContextMenu(e, node.id, node.type)}
                        onConnectStart={(e, type) => handleConnectStart(e, node.id, type)}
                        onPortMouseUp={handlePortMouseUp}
                        onResizeStart={(e) => handleResizeStart(e, node.id)}
                        onAttachInput={triggerAttachInput}
                        onAddToAssetLibrary={handleOpenAssetSelection}
                        scale={transform.k}
                        isDark={isDark}
                        auditState={node.auditStatus}
                    >
                        <NodeContent 
                            data={node} 
                            updateData={updateNodeData} 
                            onGenerate={handleGenerate} 
                            selected={selectedNodeIds.has(node.id)}
                            showControls={selectedNodeIds.size === 1}
                            inputs={getInputImages(node.id)}
                            inputMedia={getInputMedia(node.id)}
                            onPreviewReference={handlePreviewReference}
                            onMaximize={handleMaximize}
                             onPreviewMedia={handleHistoryPreview}
                             onSetImageVersion={handleSetImageVersion}
                             onSetVideoVersion={handleSetVideoVersion}
                             onUseImageVersion={handleUseImageVersion}
                            onUseVideoVersion={handleUseVideoVersion}
                            onDownload={handleDownload}
                            onUpload={triggerReplaceImage}
                            onSaveResult={openSaveResultModal}
                            onCrop={handleCropStart}
                            onMultiAngle={handleMultiAngleGenerate}
                            onLighting={handleLightingEdit}
                            onEnhanceImage={handleEnhanceImageEdit}
                            onOpenDirectorDesk={openDirectorDesk}
                            onExtractFrames={(nodeId: string) => {
                                const n = nodes.find(nd => nd.id === nodeId);
                                if (n?.videoSrc) setFrameExtractTarget({ nodeId, videoSrc: n.videoSrc });
                            }}
                            onEditVideo={handleOpenVideoEdit}
                            onRemoveSubtitles={handleRemoveSubtitlesEdit}
                            onEnhanceVideo={handleEnhanceVideoEdit}
                            onRemoveBGM={handleRemoveBGMEdit}
                            onAnalyzeMedia={handleAnalyzeMedia}
                            onAnalyzeScript={handleAnalyzeScript}
                            isSelecting={dragMode === 'SELECT'}
                            onDelete={deleteNode}
                            onAddToAssetLibrary={handleOpenAssetSelection}
                            isDark={isDark}
                            canvasScale={transform.k}
                        />
                    </BaseNode>
                ))}
            </div>
            {dragMode === 'CONNECT' && suggestedNodes.length > 0 && lastMousePosRef.current && (
                <div className={`fixed z-50 border rounded-xl shadow-2xl p-2 flex flex-col gap-1 w-48 pointer-events-auto ${isDark ? 'bg-[#1A1D21] border-zinc-700' : 'bg-white border-gray-200'}`} style={{ left: lastMousePosRef.current.x + 20, top: lastMousePosRef.current.y }}>
                    <div className={`text-[10px] uppercase font-bold px-2 py-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Quick Connect</div>
                    {suggestedNodes.map(node => (
                        <button key={node.id} className={`flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors ${isDark ? 'hover:bg-zinc-800 text-gray-300 hover:text-[#8F91F4]' : 'hover:bg-gray-100 text-gray-700 hover:text-[#4446CE]'}`} onClick={(e) => { e.stopPropagation(); const start = connectionStartRef.current!; if (start.type === 'source') createConnection(start.nodeId, node.id); else createConnection(node.id, start.nodeId); }}>
                            {node.type === NodeType.TEXT_TO_VIDEO ? <Icons.Video size={12} /> : <Icons.Image size={12} />}<span className="truncate">{node.title}</span>
                        </button>
                    ))}
                </div>
            )}
            {dragMode === 'SELECT' && selectionBox && (
                <div className="fixed border border-[#4446CE]/50 bg-[#4446CE]/10 pointer-events-none z-50" style={{ left: containerRef.current!.getBoundingClientRect().left + selectionBox.x, top: containerRef.current!.getBoundingClientRect().top + selectionBox.y, width: selectionBox.w, height: selectionBox.h }}/>
            )}
            {!selectedGroup && selectionFrameStyle && selectedNodeIds.size > 1 && dragMode !== 'SELECT' && (
                <div
                    className="fixed z-[70] pointer-events-none border-2 border-[#4446CE] rounded-md bg-[#4446CE]/[0.035]"
                    style={selectionFrameStyle}
                />
            )}
            {toolbarPosition && (selectedGroup || (!selectedGroup && selectedNodeIds.size > 1)) && dragMode !== 'SELECT' && (
                <div
                    className={`fixed z-[120] flex items-center gap-1 rounded-xl border px-1.5 py-1 shadow-xl backdrop-blur-xl ${isDark ? 'border-zinc-700 bg-zinc-900/95 text-zinc-100' : 'border-gray-200 bg-white/95 text-gray-700'}`}
                    style={{ left: toolbarPosition.left, top: toolbarPosition.top, transform: 'translateX(-50%)' }}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    {selectedGroup ? (
                        <>
                            <button
                                type="button"
                                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${isDark ? 'hover:bg-zinc-800' : 'hover:bg-gray-100'}`}
                                onClick={() => arrangeNodeGroup(selectedGroup.id)}
                                title="按当前位置的阅读顺序整理为宫格"
                            >
                                <Icons.LayoutGrid size={14} /> 整理
                            </button>
                            <button
                                type="button"
                                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${isDark ? 'hover:bg-zinc-800' : 'hover:bg-gray-100'}`}
                                onClick={() => downloadNodeCollection(selectedGroup.memberIds, selectedGroup.title)}
                            >
                                <Icons.Download size={14} /> 批量下载
                            </button>
                            <button
                                type="button"
                                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${isDark ? 'hover:bg-red-500/15 hover:text-red-300' : 'hover:bg-red-50 hover:text-red-600'}`}
                                onClick={() => ungroupNodeGroup(selectedGroup.id)}
                            >
                                <Icons.X size={14} /> 解组
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                type="button"
                                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${isDark ? 'hover:bg-zinc-800' : 'hover:bg-gray-100'}`}
                                onClick={() => downloadNodeCollection(selectedNodeIds, '所选节点')}
                            >
                                <Icons.Download size={14} /> 批量下载
                            </button>
                            <button
                                type="button"
                                disabled={selectedNodeIds.size < 2}
                                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${selectedNodeIds.size < 2 ? 'cursor-not-allowed opacity-40' : (isDark ? 'hover:bg-[#4446CE]/25 hover:text-[#C7C8FF]' : 'hover:bg-[#F0F1FF] hover:text-[#3739B0]')}`}
                                onClick={createNodeGroup}
                            >
                                <Icons.Folder size={14} /> 打组
                            </button>
                        </>
                    )}
                </div>
            )}
            
            {/* Top Left Project Name */}
            <div className="absolute top-4 left-4 z-50" onMouseDown={(event) => event.stopPropagation()}>
                <div className={`flex items-center gap-3 px-2.5 py-2 rounded-2xl backdrop-blur-xl border transition-all duration-300 ${
                    isDark 
                        ? 'bg-[#18181b]/90 border-zinc-800 shadow-xl' 
                        : 'bg-white/90 border-gray-200 shadow-lg'
                }`}>
                    <button
                        type="button"
                        onClick={returnToProjectManagement}
                        title="返回项目列表"
                        aria-label="返回项目列表"
                        className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 font-bold transition-all ${
                            isDark
                                ? 'text-[#B9BAFF] hover:bg-[#4446CE]/15 hover:text-[#C7C8FF]'
                                : 'text-[#4446CE] hover:bg-[#F0F1FF] hover:text-[#3739B0]'
                        }`}
                    >
                        <Icons.ChevronLeft size={18} strokeWidth={2.8} />
                    </button>
                    {/* Logo */}
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                        isDark ? 'bg-[#4446CE]/20 text-[#8F91F4]' : 'bg-[#E1E3FF] text-[#4446CE]'
                    }`}>
                        <Icons.Sparkles size={16} />
                    </div>
                    
                    <div className="min-w-0">
                        <div
                            className={`block max-w-[220px] truncate text-sm font-bold ${
                                isDark ? 'text-[#E1E3FF]' : 'text-[#3739B0]'
                            }`}
                            title={projectName}
                            aria-readonly="true"
                        >
                            {projectName}
                        </div>
                        {/* Sub-canvas dropdown */}
                        <div className="relative mt-0.5">
                            <button
                                type="button"
                                onClick={() => setIsSubCanvasListOpen(!isSubCanvasListOpen)}
                                className={`flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-[11px] font-semibold shadow-sm transition-all ${isDark ? 'border-[#8F91F4]/10 bg-[#8F91F4]/5 text-[#C7C8FF]/80 hover:border-[#B9BAFF]/30 hover:bg-[#8F91F4]/10 hover:text-[#E1E3FF]' : 'border-[#E1E3FF] bg-[#F0F1FF]/70 text-[#3739B0] hover:border-[#C7C8FF] hover:bg-[#E1E3FF]/80 hover:text-[#2F318F]'}`}
                            >
                                <Icons.LayoutGrid size={12} />
                                <span className="max-w-[200px] truncate">{activeSubCanvas?.name || '选择画布'}</span>
                                <Icons.ChevronDown size={10} />
                            </button>
                            {isSubCanvasListOpen && (
                                <div className={`absolute top-full left-0 mt-2 flex h-[calc(100vh-118px)] min-h-[240px] max-h-[610px] w-[312px] flex-col rounded-2xl border p-2 shadow-[0_24px_80px_rgba(2,6,23,0.32)] z-[210] backdrop-blur-2xl ${isDark ? 'bg-[#0c1118]/95 border-[#B9BAFF]/15 ring-1 ring-white/10' : 'bg-white/95 border-[#E1E3FF] ring-1 ring-[#F0F1FF]'}`} onMouseDown={(e) => e.stopPropagation()}>
                                    {/* New Canvas Button - Prominent, at top */}
                                    <button
                                        type="button"
                                        className={`mb-3 h-10 w-full rounded-xl text-xs font-semibold flex items-center justify-center gap-2 border shadow-sm transition-all ${isDark ? 'border-[#8F91F4]/30 bg-gradient-to-r from-[#4446CE]/20 to-[#8F91F4]/10 text-[#E1E3FF] hover:border-[#B9BAFF]/50 hover:from-[#4446CE]/30 hover:to-[#8F91F4]/20' : 'border-[#C7C8FF] bg-gradient-to-r from-[#F0F1FF] to-[#F0F1FF] text-[#3739B0] hover:border-[#B9BAFF] hover:from-[#E1E3FF] hover:to-[#E1E3FF]'}`}
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onClick={(e) => { e.stopPropagation(); handleCreateSubCanvas(); }}
                                    >
                                        <Icons.Plus size={13} strokeWidth={2.5} />
                                        新建子画布
                                    </button>
                                    <div className={`h-px mb-3 ${isDark ? 'bg-gradient-to-r from-transparent via-[#B9BAFF]/20 to-transparent' : 'bg-gradient-to-r from-transparent via-[#E1E3FF] to-transparent'}`} />
                                    <div className={`px-2 pb-1.5 text-[10px] font-bold tracking-wide ${isDark ? 'text-[#E1E3FF]/45' : 'text-[#4446CE]/55'}`}>子画布</div>
                                    <div className="space-y-1">
                                        {subCanvases.map(canvas => (
                                            <div key={canvas.id} className={`group flex h-10 items-center gap-1.5 rounded-xl border px-2 transition-all ${activeSubCanvasId === canvas.id ? (isDark ? 'border-[#8F91F4]/25 bg-[#8F91F4]/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]' : 'border-[#C7C8FF] bg-[#F0F1FF] shadow-sm') : (isDark ? 'border-transparent hover:border-white/10 hover:bg-white/5' : 'border-transparent hover:border-gray-200 hover:bg-gray-50')}`}>
                                                <button
                                                    type="button"
                                                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                                    onClick={() => handleSwitchSubCanvas(canvas.id)}
                                                >
                                                    <span className={`h-3 w-1.5 rounded-full shrink-0 ${activeSubCanvasId === canvas.id ? (isDark ? 'bg-[#B9BAFF] shadow-[0_0_12px_rgba(68,70,206,0.55)]' : 'bg-[#4446CE]') : (isDark ? 'bg-zinc-700' : 'bg-gray-300')}`} />
                                                    {editingSubCanvasId === canvas.id ? (
                                                        <input
                                                            value={editingSubCanvasName}
                                                            onChange={(e) => setEditingSubCanvasName(e.target.value)}
                                                            onBlur={() => handleRenameSubCanvas(canvas.id, editingSubCanvasName)}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') handleRenameSubCanvas(canvas.id, editingSubCanvasName);
                                                                if (e.key === 'Escape') setEditingSubCanvasId(null);
                                                            }}
                                                            autoFocus
                                                            className={`min-w-0 flex-1 bg-transparent text-xs font-medium outline-none border-b ${isDark ? 'text-white border-[#8F91F4]' : 'text-gray-900 border-[#4446CE]'}`}
                                                            onMouseDown={(e) => e.stopPropagation()}
                                                            onClick={(e) => e.stopPropagation()}
                                                        />
                                                    ) : (
                                                        <span className={`truncate text-xs font-semibold ${activeSubCanvasId === canvas.id ? (isDark ? 'text-[#E1E3FF]' : 'text-[#2F318F]') : (isDark ? 'text-zinc-300' : 'text-gray-700')}`}>{canvas.name}</span>
                                                    )}
                                                </button>
                                                <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                                                    <button
                                                        type="button"
                                                        className={`w-6 h-6 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'text-zinc-400 hover:bg-[#8F91F4]/10 hover:text-[#E1E3FF]' : 'text-gray-500 hover:bg-[#E1E3FF] hover:text-[#3739B0]'}`}
                                                        onClick={(e) => { e.stopPropagation(); setEditingSubCanvasId(canvas.id); setEditingSubCanvasName(canvas.name); }}
                                                        title="修改子画布名称"
                                                    >
                                                        <Icons.Edit3 size={11} />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className={`w-6 h-6 rounded-lg flex items-center justify-center transition-colors ${subCanvases.length <= 1 ? 'cursor-not-allowed opacity-35' : (isDark ? 'text-zinc-500 hover:bg-red-500/10 hover:text-red-300' : 'text-gray-400 hover:bg-red-50 hover:text-red-600')}`}
                                                        onClick={(e) => { e.stopPropagation(); handleDeleteSubCanvas(canvas.id); }}
                                                        disabled={subCanvases.length <= 1}
                                                        title={subCanvases.length <= 1 ? '至少保留一个子画布' : '删除子画布'}
                                                    >
                                                        <Icons.Trash2 size={11} />
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                </div>
            </div>

            {/* Top Right Toolbar */}
            <div className="absolute top-4 right-4 z-50">
                <div className={`flex items-center gap-1 px-2 py-1.5 rounded-2xl backdrop-blur-xl border transition-all ${
                    isDark 
                        ? 'bg-[#18181b]/90 border-zinc-800 shadow-xl' 
                        : 'bg-white/90 border-gray-200 shadow-lg'
                }`}>
                    {/* Zoom */}
                    <span className={`hidden px-3 py-1.5 text-sm font-medium tabular-nums ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        {Math.round(transform.k * 100)}%
                    </span>
                    
                    <div className={`hidden w-px h-5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />

                    <div
                        title="当前用户积分余额"
                        className={`flex h-9 cursor-default items-center gap-1.5 rounded-xl px-3 text-sm font-semibold ${
                            isDark ? 'bg-amber-500/10 text-amber-200' : 'bg-amber-50 text-amber-700'
                        }`}
                    >
                        <Icons.Coins size={15} />
                        <span className="tabular-nums">{getUserCreditStats().available}</span>
                    </div>
                    
                    <div className={`w-px h-5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />

                    <div ref={localExportMenuRef} className="relative">
                        <button
                            onClick={() => setIsLocalExportMenuOpen(prev => !prev)}
                            disabled={isLocalExporting}
                            title="保存文件到本地"
                            className={`flex h-9 items-center gap-1.5 rounded-xl px-2.5 text-sm font-medium transition-all ${
                                isLocalExporting
                                    ? 'cursor-wait opacity-60'
                                    : isDark
                                        ? 'text-gray-400 hover:bg-white/5 hover:text-white'
                                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                            }`}
                        >
                            {isLocalExporting ? <Icons.Loader2 size={15} className="animate-spin" /> : <Icons.Download size={15} />}
                            <Icons.ChevronDown size={13} className={`transition-transform ${isLocalExportMenuOpen ? 'rotate-180' : ''}`} />
                            <span className="sr-only">保存文件到本地</span>
                        </button>
                        {isLocalExportMenuOpen && (
                            <div
                                className={`absolute right-0 top-[calc(100%+8px)] z-[130] w-44 overflow-hidden rounded-xl border p-1.5 shadow-2xl backdrop-blur-xl ${
                                    isDark ? 'border-zinc-700 bg-[#18181b]/95 text-zinc-100' : 'border-gray-200 bg-white/95 text-gray-900'
                                }`}
                                onMouseDown={(event) => event.stopPropagation()}
                            >
                                {[
                                    { type: 'video' as const, label: '导出视频', icon: Icons.Video },
                                    { type: 'image' as const, label: '导出图片', icon: Icons.Image },
                                    { type: 'text' as const, label: '导出文本', icon: Icons.FileText },
                                    { type: 'audio' as const, label: '导出音频', icon: Icons.Music },
                                    { type: 'all' as const, label: '导出全部', icon: Icons.Download },
                                ].map(item => (
                                    <button
                                        key={item.type}
                                        type="button"
                                        className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs font-semibold transition-colors ${
                                            isDark ? 'text-zinc-300 hover:bg-zinc-800 hover:text-white' : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
                                        }`}
                                        onClick={() => void handleLocalExport(item.type)}
                                    >
                                        <item.icon size={14} />
                                        <span>{item.label}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                    
                    <div className={`w-px h-5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />

                    {/* Credit dashboard */}
                    <button
                        onClick={() => setIsCreditDashboardOpen(true)}
                        className={`hidden items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-all ${
                            isDark ? 'text-gray-400 hover:text-white hover:bg-white/5' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                        }`}
                    >
                        <Icons.Database size={15} />
                        <span>积分看板</span>
                    </button>

                    <div className={`hidden w-px h-5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />
                    
                    {/* Theme */}
                    <button
                        onClick={() => toggleTheme(!isDark)}
                        className={`hidden items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-all ${
                            isDark ? 'text-gray-400 hover:text-white hover:bg-white/5' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                        }`}
                    >
                        {isDark ? <Icons.Moon size={15} /> : <Icons.Sun size={15} />}
                        <span>{isDark ? '暗色' : '亮色'}</span>
                    </button>
                    
                    <button
                        onClick={returnToProjectManagement}
                        className={`hidden items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-all ${
                            isDark ? 'text-gray-400 hover:text-white hover:bg-white/5' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                        }`}
                    >
                        <Icons.FolderOpen size={15} />
                        <span>项目</span>
                    </button>
                    
                    <div className={`w-px h-5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />
                    
                    {/* Canvas import / export */}
                    <button
                        onClick={() => setIsExportImportOpen(true)}
                        title="导入/导出画布"
                        className={`flex h-9 w-9 items-center justify-center rounded-xl text-sm font-medium transition-all ${
                            isDark ? 'text-gray-400 hover:text-white hover:bg-white/5' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                        }`}
                    >
                        <Icons.FolderOpen size={15} />
                        <span className="sr-only">导入/导出画布</span>
                    </button>
                    
                </div>
            </div>
            {renderCanvasNavigator()}
            {/* Sub-canvas dropdown outside-click overlay */}
      {isSubCanvasListOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setIsSubCanvasListOpen(false)} />
      )}
      {/* Sub-canvas naming dialog */}
      {showSubCanvasNameDialog && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center" onMouseDown={(e) => e.stopPropagation()}>
          <div className="fixed inset-0 bg-black/40" onClick={() => setShowSubCanvasNameDialog(false)} />
          <div className={`relative z-10 w-[320px] rounded-2xl border p-5 shadow-2xl ${isDark ? 'bg-[#181b22] border-zinc-700' : 'bg-white border-gray-200'}`}>
            <div className={`text-sm font-semibold mb-3 ${isDark ? 'text-zinc-100' : 'text-gray-800'}`}>新建子画布</div>
            <input
              autoFocus
              value={pendingSubCanvasName}
              onChange={(e) => setPendingSubCanvasName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmCreateSubCanvas();
                if (e.key === 'Escape') setShowSubCanvasNameDialog(false);
              }}
              placeholder="输入画布名称"
              className={`w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors ${isDark ? 'bg-zinc-900 border-zinc-600 text-white placeholder-zinc-500 focus:border-[#8F91F4]' : 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400 focus:border-[#4446CE]'}`}
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setShowSubCanvasNameDialog(false)}
                className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${isDark ? 'text-zinc-300 hover:bg-zinc-700' : 'text-gray-600 hover:bg-gray-100'}`}
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleConfirmCreateSubCanvas}
                className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${isDark ? 'bg-[#4446CE] text-white hover:bg-[#8F91F4]' : 'bg-[#4446CE] text-white hover:bg-[#4446CE]'}`}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
            {renderContextMenu()}
            {renderQuickAddMenu()}
            {renderNewWorkflowDialog()}
            {renderDeleteConfirmDialog()}
            {renderSaveResultModal()}
            {renderCreditDashboardV2()}
            {directorDeskSession && (
                <div className="fixed inset-0 z-[900] flex flex-col bg-[#0B0C0E]">
                    <div className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950/95 px-4 text-zinc-100">
                        <div className="flex min-w-0 items-center gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#4446CE]/20 text-[#B9BAFF]">
                                <Icons.Clapperboard size={18} />
                            </div>
                            <div className="min-w-0">
                                <div className="truncate text-sm font-semibold">{directorDeskSession.title}</div>
                                <div className="text-[11px] text-zinc-500">截图后会在导演台节点旁边生成图片节点</div>
                            </div>
                        </div>
                        <button
                            type="button"
                            className="flex h-9 items-center gap-2 rounded-xl border border-zinc-700 px-3 text-xs font-semibold text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
                            onClick={() => setDirectorDeskSession(null)}
                        >
                            <Icons.X size={15} />
                            <span>关闭</span>
                        </button>
                    </div>
                    <iframe
                        key={directorDeskSession.instanceId}
                        ref={directorDeskIframeRef}
                        title="3D导演台"
                        src={`${DIRECTOR_DESK_APP_PATH}?instanceId=${encodeURIComponent(directorDeskSession.instanceId)}&theme=${isDark ? 'dark' : 'light'}&hostOrigin=${encodeURIComponent(window.location.origin)}`}
                        className="min-h-0 flex-1 border-0 bg-black"
                        onLoad={postDirectorDeskSessionToIframe}
                        allow="clipboard-write; fullscreen"
                    />
                </div>
            )}
            {previewMedia && (
                <div data-media-preview-overlay className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/80 backdrop-blur-md animate-in fade-in duration-200" onClick={() => setPreviewMedia(null)}>
                    <div className={`relative bg-black rounded-2xl shadow-2xl overflow-hidden border border-zinc-700 ${previewMedia.type === 'audio' ? 'w-[min(420px,90vw)] p-5' : 'max-w-[90vw] max-h-[90vh]'}`} onClick={(e) => e.stopPropagation()}>
                         <button className="absolute top-2 right-2 bg-black/50 text-white p-2 rounded-full hover:bg-red-500 transition-colors z-10" onClick={() => setPreviewMedia(null)}><Icons.X size={20} /></button>
                         {previewMedia.type === 'video' ? (
                             <video src={previewMedia.url} controls autoPlay className="max-w-full max-h-[90vh]" />
                         ) : previewMedia.type === 'audio' ? (
                             <div className="flex flex-col gap-4 pt-7 text-white">
                                 <div className="flex min-w-0 items-center gap-3">
                                     <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#4446CE]/25 text-[#C7C8FF]">
                                         <Icons.Music size={22} />
                                     </div>
                                     <div className="min-w-0">
                                         <div className="text-xs text-zinc-500">音频素材</div>
                                         <div className="truncate text-sm font-semibold">{previewMedia.title || '音频'}</div>
                                     </div>
                                 </div>
                                 <audio src={previewMedia.url} controls autoPlay className="w-full" />
                             </div>
                         ) : (
                             <img src={previewMedia.url} alt="Preview" className="max-w-full max-h-[90vh] object-contain" />
                         )}
                    </div>
                </div>
            )}
            {previewText && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md animate-in fade-in duration-200" onClick={() => setPreviewText(null)}>
                    <div className={`relative w-[min(760px,92vw)] max-h-[86vh] rounded-2xl shadow-2xl border overflow-hidden ${isDark ? 'bg-[#18181b] border-zinc-700 text-zinc-100' : 'bg-white border-gray-200 text-gray-900'}`} onClick={(e) => e.stopPropagation()}>
                        <div className={`h-14 px-5 flex items-center justify-between border-b ${isDark ? 'border-zinc-800' : 'border-gray-100'}`}>
                            <div className="flex items-center gap-2 min-w-0">
                                <Icons.FileText size={18} />
                                <span className="font-semibold truncate">{previewText.title}</span>
                            </div>
                            <button className={`w-9 h-9 rounded-full flex items-center justify-center ${isDark ? 'hover:bg-zinc-800 text-zinc-400 hover:text-white' : 'hover:bg-gray-100 text-gray-500 hover:text-gray-900'}`} onClick={() => setPreviewText(null)}><Icons.X size={20} /></button>
                        </div>
                        <pre className={`max-h-[calc(86vh-56px)] overflow-auto whitespace-pre-wrap break-words p-5 text-sm leading-7 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`}>{previewText.text}</pre>
                    </div>
                </div>
            )}
            {addToAssetPanel.isOpen && (
                <AssetSelectionModal
                    isOpen={addToAssetPanel.isOpen}
                    nodeId={addToAssetPanel.nodeId}
                    nodeType={addToAssetPanel.nodeType}
                    nodeTitle={addToAssetPanel.title}
                    assetLibrary={DEMO_ASSET_LIBRARY}
                    shotClips={[
                      { id: 'shot_001', episodeNo: 1, sceneNo: 1, shotNo: 1, shotName: '开场全景', description: '第一集第一场开场镜头' },
                      { id: 'shot_002', episodeNo: 1, sceneNo: 1, shotNo: 2, shotName: '主角近景', description: '主角登场特写' },
                      { id: 'shot_003', episodeNo: 1, sceneNo: 2, shotNo: 1, shotName: '街道跟拍', description: '街道追逐戏' },
                      { id: 'shot_004', episodeNo: 2, sceneNo: 1, shotNo: 1, shotName: '室内对话', description: '办公室对话场景' },
                    ]}
                    isDark={isDark}
                    onClose={handleCloseAssetSelection}
                    onAddToExistingAsset={handleAddToExistingAsset}
                    onCreateNewAsset={handleCreateNewAsset}
                    onAddToShotClip={handleAddNodeToShotClip}
                />
            )}

            {cropTarget && (
                <CropModal
                    imageSrc={cropTarget.imageSrc}
                    sourceTitle={cropTarget.title}
                    initialAspectRatio={cropTarget.aspectRatio}
                    isDark={isDark}
                    onClose={() => setCropTarget(null)}
                    onConfirm={handleCropConfirm}
                />
            )}

            {videoEditTarget && (
                <VideoEditPanel
                    isOpen={true}
                    videoSrc={videoEditTarget.videoSrc}
                    sourceTitle={videoEditTarget.title}
                    isDark={isDark}
                    onClose={() => setVideoEditTarget(null)}
                    onSubmit={handleVideoEditSubmit}
                />
            )}

            {frameExtractTarget && (
                <VideoFrameExtractPanel
                    isOpen={true}
                    videoSrc={frameExtractTarget.videoSrc}
                    isDark={isDark}
                    onClose={() => setFrameExtractTarget(null)}
                    onExtractFrame={(imageDataUrl, timeSeconds, videoWidth, videoHeight) => {
                        const sourceNode = nodes.find(n => n.id === frameExtractTarget.nodeId);
                        if (!sourceNode) { setFrameExtractTarget(null); return; }
                        const ratio = videoWidth && videoHeight ? videoWidth / videoHeight : 16 / 9;
                        const baseSize = 480;
                        const nodeW = ratio >= 1 ? baseSize : Math.round(baseSize * ratio);
                        const nodeH = ratio >= 1 ? Math.round(baseSize / ratio) : baseSize;
                        const aspectRatio = getClosestAspectRatio(videoWidth || 16, videoHeight || 9, IMAGE_ASPECT_RATIOS);
                        const source = resolveSecondaryEditSource(sourceNode);
                        const position = getDerivedNodePosition(source, nodeW, nodeH);
                        const newNode: NodeData = {
                            id: generateId(),
                            type: NodeType.TEXT_TO_IMAGE,
                            x: position.x,
                            y: position.y,
                            width: nodeW,
                            height: nodeH,
                            title: `截帧_${String(Math.floor(timeSeconds / 60)).padStart(2, '0')}:${String(Math.floor(timeSeconds % 60)).padStart(2, '0')}_${sourceNode.title}`.slice(0, 30),
                            imageSrc: imageDataUrl,
                            aspectRatio,
                            model: sourceNode.model || 'Seedream 5.0',
                            resolution: sourceNode.resolution || '1k',
                            count: 1,
                            prompt: sourceNode.prompt || '',
                            outputArtifacts: [imageDataUrl],
                            editBadges: getStackedEditBadges(source, '截帧'),
                            editRootNodeId: source.editRootNodeId || source.id,
                            editParentNodeId: source.id,
                            source: 'canvas',
                        };
                        addCreatedCanvasItems([newNode], [createDerivedConnection(source, newNode.id)], '新建节点');
                        setSelectedNodeIds(new Set([newNode.id]));
                        setFrameExtractTarget(null);
                    }}
                />
            )}
        </div>
    </div>
  );
};

export default App;
