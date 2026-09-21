
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ImageVersionSnapshot, InputMedia, MultiAngleOptions, NodeData } from '../../types';
import { Icons } from '../Icons';
import { getModelConfig, MODEL_REGISTRY, getVisibleModels } from '../../services/geminiService';
import { IMAGE_HANDLERS } from '../../services/mode/image/configurations';
import { GenerationFailureNotice, LocalEditableTitle, LocalCustomDropdown, LocalInputThumbnails, LocalMediaStack, LocalPromptTextarea } from './Shared/LocalNodeComponents';

interface TextToImageNodeProps {
  data: NodeData;
  updateData: (id: string, updates: Partial<NodeData>) => void;
  onGenerate: (id: string) => void;
  selected?: boolean;
  showControls?: boolean;
  inputs?: string[];
  inputMedia?: InputMedia[];
  onPreviewReference?: (item: InputMedia) => void;
  onMaximize?: (id: string) => void;
  onPreviewMedia?: (url: string, type: 'image' | 'video') => void;
  onSetImageVersion?: (nodeId: string, version: ImageVersionSnapshot) => void;
  onUseImageVersion?: (nodeId: string, version: ImageVersionSnapshot) => void;
  onDownload?: (id: string) => void;
  onUpload?: (id: string) => void;
  onSaveResult?: (id: string) => void;
  onCrop?: (id: string) => void;
  onMultiAngle?: (id: string, options: MultiAngleOptions) => void;
  onMultiGrid?: (id: string, preset: string) => void;
  onRepaint?: (id: string) => void;
  onLighting?: (id: string) => void;
  onEnhanceImage?: (id: string, resolution: '2K' | '4K') => void;
  onPanorama?: (id: string) => void;
  onToggleFavoriteArtifact?: (nodeId: string, url: string, type: 'image' | 'video') => void;
  isArtifactFavorited?: (nodeId: string, url: string) => boolean;
  isDark?: boolean;
  isSelecting?: boolean;
  canvasScale?: number;
}

export const TextToImageNode: React.FC<TextToImageNodeProps> = ({
    data, updateData, onGenerate, selected, showControls, inputs = [], inputMedia = [], onPreviewReference, onMaximize, onPreviewMedia, onSetImageVersion, onUseImageVersion, onDownload, onUpload, onSaveResult, onCrop, onMultiAngle, onMultiGrid, onRepaint, onLighting, onEnhanceImage, onPanorama, onToggleFavoriteArtifact, isArtifactFavorited, onAddToAssetLibrary, isDark = true, isSelecting, canvasScale = 1
}) => {
    const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
    const [deferredInputs, setDeferredInputs] = useState(false);
    const [isConfigured, setIsConfigured] = useState(true);
    const [imageModels, setImageModels] = useState<string[]>([]);
    const [isAngleEditorOpen, setIsAngleEditorOpen] = useState(false);
    const [anglePrompt, setAnglePrompt] = useState('');
    const [angleConsistency, setAngleConsistency] = useState<'standard' | 'high'>('high');
    const [angleBackground, setAngleBackground] = useState<'keep' | 'clean' | 'solid'>('clean');
    const [angleAspectRatio, setAngleAspectRatio] = useState('沿原图');
    const [anglePreset, setAnglePreset] = useState('custom');
    const [yaw, setYaw] = useState(0);
    const [pitch, setPitch] = useState(0);
    const [zoom, setZoom] = useState<'wide' | 'medium' | 'close'>('medium');
    const [showAnglePrompt, setShowAnglePrompt] = useState(false);
    const [isAngleDragging, setIsAngleDragging] = useState(false);
    const anglePadRef = useRef<HTMLDivElement>(null);

    const [isLightingOpen, setIsLightingOpen] = useState(false);
    const [lightView, setLightView] = useState<'perspective' | 'front'>('perspective');
    const [lightBrightness, setLightBrightness] = useState(50);
    const [lightDirection, setLightDirection] = useState<string>('front');
    const [lightRimEnabled, setLightRimEnabled] = useState(false);
    const [lightSmartMode, setLightSmartMode] = useState(false);
    const [isLightDragging, setIsLightDragging] = useState(false);
    const [lightAzimuth, setLightAzimuth] = useState(0);
    const [lightElevation, setLightElevation] = useState(30);
    const lightPadRef = useRef<HTMLDivElement>(null);
    const [isHdRestoreOpen, setIsHdRestoreOpen] = useState(false);

    const isSelectedAndStable = selected && !isSelecting;
    // Panel stays a constant screen size while zooming via the --panel-inverse-scale CSS var,
    // so zoom no longer re-renders the node (heavy base64 media stays off the hot path).
    const panelTransform: React.CSSProperties = {
        transform: 'translateX(-50%) scale(var(--panel-inverse-scale, 1))',
        transformOrigin: 'top center',
    };
    const topToolbarTransform: React.CSSProperties = {
        transform: 'translateX(-50%) scale(var(--panel-inverse-scale, 1))',
        transformOrigin: 'bottom center',
    };

    const checkConfig = useCallback(() => {
         const mName = data.model || 'Seedream 5.0';
         const cfg = getModelConfig(mName);
         setIsConfigured(mName === 'Seedream 5.0' || !!cfg.key);
    }, [data.model]);

    const updateModels = useCallback(() => {
        const visibleModels = getVisibleModels();
        const models = visibleModels.filter(k => MODEL_REGISTRY[k]?.category === 'IMAGE');
        setImageModels(models);
    }, []);

    useEffect(() => { 
        checkConfig(); 
        updateModels();
        window.addEventListener('modelConfigUpdated', checkConfig); 
        window.addEventListener('modelRegistryUpdated', updateModels);
        return () => {
            window.removeEventListener('modelConfigUpdated', checkConfig);
            window.removeEventListener('modelRegistryUpdated', updateModels);
        };
    }, [checkConfig, updateModels]);

    useEffect(() => { if (isSelectedAndStable && showControls) { const t = setTimeout(() => setDeferredInputs(true), 100); return () => clearTimeout(t); } else setDeferredInputs(false); }, [isSelectedAndStable, showControls]);

    // Get Rules for current model
    const currentModel = data.model || 'Seedream 5.0';
    const handler = IMAGE_HANDLERS[currentModel] || IMAGE_HANDLERS['Seedream 5.0']; // Fallback rules
    const rules = handler.rules;
    const supportedResolutions = rules.resolutions || ['1k'];
    const supportedRatios = rules.ratios || ['1:1', '16:9'];
    const anglePresets = [
        { key: 'custom', label: '自定义', yaw: 0, pitch: 0, zoom: 'medium' as const },
        { key: 'fisheye', label: '鱼眼视角', yaw: 0, pitch: 0, zoom: 'wide' as const },
        { key: 'tilt', label: '倾斜视角', yaw: -25, pitch: 15, zoom: 'medium' as const },
        { key: 'front_top', label: '正面俯拍', yaw: 0, pitch: 35, zoom: 'medium' as const },
        { key: 'front_low', label: '正面仰拍', yaw: 0, pitch: -25, zoom: 'medium' as const },
        { key: 'panorama_top', label: '全景俯拍', yaw: 0, pitch: 55, zoom: 'wide' as const },
        { key: 'back_view', label: '背面视角', yaw: 180, pitch: 0, zoom: 'medium' as const },
    ];
    const angleAspectOptions = ['沿原图', '1:1', '3:4', '4:3', '9:16', '16:9'];
    const consistencyOptions = [
        { value: 'standard' as const, label: '标准' },
        { value: 'high' as const, label: '高一致' },
    ];
    const backgroundOptions = [
        { value: 'keep' as const, label: '保留背景' },
        { value: 'clean' as const, label: '干净背景' },
        { value: 'solid' as const, label: '纯色背景' },
    ];

    const applyAnglePreset = (preset: typeof anglePresets[number]) => {
        setAnglePreset(preset.key);
        setYaw(preset.yaw);
        setPitch(preset.pitch);
        setZoom(preset.zoom);
    };

    const updateAngleFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = anglePadRef.current;
        if (!target) return;
        const rect = target.getBoundingClientRect();
        const nx = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
        const ny = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1);
        setAnglePreset('custom');
        setYaw(Math.round((nx - 0.5) * 360));
        setPitch(Math.round((0.5 - ny) * 180));
    };

    const handleAnglePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        event.stopPropagation();
        setIsAngleDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        updateAngleFromPointer(event);
    };

    const handleAnglePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!isAngleDragging) return;
        updateAngleFromPointer(event);
    };

    const handleAnglePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
        setIsAngleDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    const handleMultiAngleGenerate = () => {
        if (!data.imageSrc || data.isLoading) return;
        onMultiAngle?.(data.id, {
            angles: [anglePreset],
            prompt: anglePrompt,
            consistency: angleConsistency,
            background: angleBackground,
            aspectRatio: angleAspectRatio === '沿原图' ? 'source' : angleAspectRatio,
            countPerAngle: 1,
            yaw,
            pitch,
            zoom,
            preset: anglePreset,
            targetMode: 'scene',
        });
    };

    const LIGHT_DIRECTIONS: { key: string; label: string }[] = [
        { key: 'left', label: '左侧' }, { key: 'top', label: '顶部' }, { key: 'right', label: '右侧' },
        { key: 'front', label: '前方' }, { key: 'bottom', label: '底部' }, { key: 'back', label: '后方' },
    ];

    const lightDirToAzEl: Record<string, [number, number]> = {
        left: [-90, 0], top: [0, 80], right: [90, 0],
        front: [0, 30], bottom: [0, -60], back: [180, 0],
    };

    const applyLightDirection = (dir: string) => {
        setLightDirection(dir);
        const [az, el] = lightDirToAzEl[dir] || [0, 30];
        setLightAzimuth(az);
        setLightElevation(el);
    };

    const updateLightFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
        const el = lightPadRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        setLightAzimuth(Math.round((nx - 0.5) * 360));
        setLightElevation(Math.round((0.5 - ny) * 180));
        setLightDirection('');
    };

    const handleLightPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation();
        setIsLightDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        updateLightFromPointer(e);
    };
    const handleLightPointerMove = (e: React.PointerEvent<HTMLDivElement>) => { if (isLightDragging) updateLightFromPointer(e); };
    const handleLightPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        setIsLightDragging(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    };

    const handleLightingGenerate = () => {
        if (!data.imageSrc || data.isLoading) return;
        onLighting?.(data.id);
    };

    const handleHdRestoreGenerate = (resolution: '2K' | '4K') => {
        if (!data.imageSrc || data.isLoading) return;
        setIsHdRestoreOpen(false);
        onEnhanceImage?.(data.id, resolution);
    };

    const resetLighting = () => {
        setLightView('perspective');
        setLightBrightness(50);
        setLightDirection('front');
        setLightRimEnabled(false);
        setLightSmartMode(false);
        setLightAzimuth(0);
        setLightElevation(30);
    };

    const handleRatioChange = (ratio: string) => {
        const currentShort = Math.min(data.width, data.height);
        const baseSize = Math.max(currentShort, 400); // Preserve current scale, min 400px

        const [wStr, hStr] = ratio.split(':');
        const wR = parseFloat(wStr);
        const hR = parseFloat(hStr);
        const r = wR / hR;

        let newW, newH;
        if (r >= 1) {
            // Landscape or Square: Height is limiting factor
            newH = baseSize;
            newW = baseSize * r;
        } else {
            // Portrait: Width is limiting factor
            newW = baseSize;
            newH = baseSize / r;
        }
        updateData(data.id, { aspectRatio: ratio, width: Math.round(newW), height: Math.round(newH) });
    };

    const hasResult = !!data.imageSrc && !data.isLoading;
    const isExclusiveEditorOpen = isAngleEditorOpen || isLightingOpen;
    const creditLabel = data.creditStatus === 'reserved'
        ? '已预扣'
        : data.creditStatus === 'confirmed'
            ? '已扣减'
            : data.creditStatus === 'refunded'
                ? '已返还'
                : '预计';
    const baseGenerateCredits = data.creditEstimate || ((data.count || 1) * 2);
    const multiAngleCredits = 4;
    const lightingCredits = 2;
    const hdRestoreOptions = [
        { resolution: '2K' as const, credits: 4 },
        { resolution: '4K' as const, credits: 8 },
    ];
    const renderCreditBadge = (credits: number, tone: 'default' | 'cyan' | 'amber' | 'violet' = 'default') => {
        const toneClass = tone === 'cyan'
            ? (isDark ? 'bg-[#4446CE]/15 text-[#C7C8FF] border-[#8F91F4]/20' : 'bg-[#F0F1FF] text-[#3739B0] border-[#E1E3FF]')
            : tone === 'amber'
                ? (isDark ? 'bg-amber-500/15 text-amber-200 border-amber-400/20' : 'bg-amber-50 text-amber-700 border-amber-100')
                : tone === 'violet'
                    ? (isDark ? 'bg-[#4446CE]/15 text-[#C7C8FF] border-[#8F91F4]/20' : 'bg-[#F0F1FF] text-[#3739B0] border-[#E1E3FF]')
                    : (isDark ? 'bg-zinc-800 text-zinc-300 border-zinc-700' : 'bg-gray-50 text-gray-600 border-gray-200');
        return <span className={`inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-[10px] font-bold tabular-nums ${toneClass}`}>{credits}分</span>;
    };
    
    // Auto-correct
    useEffect(() => { 
        if (data.aspectRatio && !supportedRatios.includes(data.aspectRatio)) updateData(data.id, { aspectRatio: '1:1' }); 
        if (data.resolution && !supportedResolutions.includes(data.resolution)) updateData(data.id, { resolution: supportedResolutions[0] });
    }, [data.model, data.aspectRatio, data.resolution, data.id, updateData, supportedRatios, supportedResolutions]);

    const containerBg = isDark ? 'bg-[#1a1a1a]' : 'bg-white';
    const containerBorder = selected ? 'border-[#4446CE] ring-2 ring-[#4446CE]/30' : (isDark ? 'border-zinc-700/50' : 'border-gray-200');
    const controlPanelBg = isDark ? 'bg-[#1a1a1a]/95 backdrop-blur-xl border-zinc-700/50' : 'bg-white/95 backdrop-blur-xl border-gray-200 shadow-xl';
    const inputBg = isDark ? 'bg-zinc-800/80 hover:bg-zinc-800 border-zinc-700 focus:border-[#4446CE] text-white placeholder-zinc-500' : 'bg-gray-50 hover:bg-white border-gray-200 focus:border-[#4446CE] text-gray-900 placeholder-gray-400';
    const emptyStateIconColor = isDark ? 'bg-zinc-800/50 text-zinc-500' : 'bg-gray-100 text-gray-400';
    const emptyStateTextColor = isDark ? 'text-zinc-500' : 'text-gray-400';

    return (
      <>
        <div className={`w-full h-full relative rounded-2xl border ${containerBorder} ${containerBg} ${data.isStackOpen ? 'overflow-visible' : 'overflow-hidden'} shadow-xl group transition-all duration-200`}>
             {hasResult ? (
                 <>
                     <LocalMediaStack
                         data={data}
                         updateData={updateData}
                         currentSrc={data.imageSrc}
                         onMaximize={onMaximize}
                         isDark={isDark}
                         selected={selected}
                         onToggleFavorite={(src, type) => onToggleFavoriteArtifact?.(data.id, src, type)}
                         isFavorite={(src) => isArtifactFavorited?.(data.id, src) || false}
                         onPreviewMedia={onPreviewMedia}
                         onSetImageVersion={onSetImageVersion}
                         onUseImageVersion={onUseImageVersion}
                     />
                     
                     {/* Hover Overlay with Title & Actions */}
                     <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
                         {/* Top Gradient */}
                         <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-black/60 to-transparent" />
                         
                         {/* Title */}
                         <div className="absolute top-3 left-3 pointer-events-auto">
                             <LocalEditableTitle title={data.title} onUpdate={(t) => updateData(data.id, { title: t })} isDark={true} />
                         </div>
                         
                         {/* Action Buttons */}
                         <div className="absolute top-3 right-3 flex items-center gap-1.5 pointer-events-auto">
                              <button 
                                  title="下载" 
                                  className="w-8 h-8 rounded-lg bg-black/40 hover:bg-black/60 backdrop-blur-md text-white/80 hover:text-white flex items-center justify-center transition-all"
                                  onClick={(e) => { e.stopPropagation(); onDownload?.(data.id); }}
                              >
                                  <Icons.Download size={16} />
                              </button>
                              <button 
                                  title="最大化" 
                                  className="w-8 h-8 rounded-lg bg-black/40 hover:bg-black/60 backdrop-blur-md text-white/80 hover:text-white flex items-center justify-center transition-all"
                                  onClick={(e) => { e.stopPropagation(); onMaximize?.(data.id); }}
                              >
                                  <Icons.Maximize2 size={16} />
                              </button>
                         </div>
                     </div>
                 </>
             ) : (
                 <div className={`w-full h-full flex flex-col items-center justify-center ${emptyStateTextColor}`}>
                     {data.errorMessage ? (
                         <>
                             <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-4 ${isDark ? 'bg-red-500/10 text-red-300' : 'bg-red-50 text-red-600'}`}>
                                 <Icons.AlertTriangle size={28} />
                             </div>
                              <span className={`text-sm font-semibold ${isDark ? 'text-red-200' : 'text-red-600'}`}>生成失败</span>
                              <GenerationFailureNotice
                                  message={data.errorMessage || data.generationTask?.errorMessage}
                                  detail={data.generationTask?.errorDetail || data.errorMessage}
                                  isDark={isDark}
                              />
                         </>
                     ) : (
                         <>
                             <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-4 ${emptyStateIconColor}`}>
                                 <Icons.Image size={28} className="opacity-60"/>
                             </div>
                             <span className="text-sm font-medium opacity-60">生图</span>
                             <span className="text-xs opacity-40 mt-1">选中节点开始创作</span>
                         </>
                     )}
                 </div>
             )}
             
             {/* Loading Overlay */}
             {data.isLoading && (
                 <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-20">
                     <Icons.Loader2 size={32} className="text-[#4446CE] animate-spin mb-3" />
                     <span className="text-white/80 text-sm font-medium">生成中...</span>
                 </div>
             )}
        </div>

        {isSelectedAndStable && showControls && hasResult && !isExclusiveEditorOpen && (
            <div className="absolute bottom-full left-1/2 mb-8 z-[75] flex flex-col items-center gap-2 pointer-events-none" style={topToolbarTransform}>
                {/* Multi-grid dropdown */}
                {/* Main toolbar */}
                <div className={`pointer-events-auto flex items-center gap-1.5 rounded-2xl border px-3 py-2 shadow-2xl backdrop-blur-xl ${isDark ? 'bg-[#202020]/95 border-zinc-700 text-zinc-100' : 'bg-white/95 border-gray-200 text-gray-900'}`} onMouseDown={(e) => e.stopPropagation()}>
                    <button className={`h-9 px-2.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap transition-colors ${isAngleEditorOpen ? (isDark ? 'bg-[#4446CE]/15 text-[#C7C8FF]' : 'bg-[#F0F1FF] text-[#3739B0]') : (isDark ? 'hover:bg-zinc-800' : 'hover:bg-gray-100')}`} onClick={() => { setIsAngleEditorOpen(true); setIsLightingOpen(false); setIsHdRestoreOpen(false); }} title="多角度控制">
                        <Icons.RefreshCw size={16} />
                        <span>多角度</span>
                    </button>
                    <button className={`h-9 px-2.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap transition-colors ${isLightingOpen ? (isDark ? 'bg-amber-500/15 text-amber-300' : 'bg-amber-50 text-amber-700') : (isDark ? 'hover:bg-zinc-800' : 'hover:bg-gray-100')}`} onClick={() => { setIsLightingOpen(true); setIsAngleEditorOpen(false); setIsHdRestoreOpen(false); }} title="调整灯光方向和类型">
                        <Icons.Sun size={16} />
                        <span>打光</span>
                    </button>
                    <button className={`h-9 px-2.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap transition-colors ${isDark ? 'hover:bg-zinc-800' : 'hover:bg-gray-100'}`} onClick={() => onCrop?.(data.id)} title="按画幅裁切图片">
                        <Icons.Crop size={16} />
                        <span>裁剪</span>
                    </button>
                    <div className="relative">
                        <button
                            className={`h-9 px-2.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap transition-colors ${isHdRestoreOpen ? (isDark ? 'bg-[#4446CE]/15 text-[#C7C8FF]' : 'bg-[#F0F1FF] text-[#3739B0]') : (isDark ? 'hover:bg-zinc-800' : 'hover:bg-gray-100')}`}
                            onClick={() => {
                                setIsHdRestoreOpen(value => !value);
                                setIsAngleEditorOpen(false);
                                setIsLightingOpen(false);
                            }}
                            title="选择一键高清分辨率"
                        >
                            <Icons.TrendingUp size={16} />
                            <span>一键高清</span>
                            <Icons.ChevronDown size={13} className={`transition-transform ${isHdRestoreOpen ? 'rotate-180' : ''}`} />
                        </button>
                        {isHdRestoreOpen && (
                            <div className={`absolute left-1/2 top-[calc(100%+8px)] z-[100] w-40 -translate-x-1/2 rounded-xl border p-1.5 shadow-2xl backdrop-blur-xl ${isDark ? 'border-zinc-700 bg-[#202020]/95' : 'border-gray-200 bg-white/95'}`}>
                                {hdRestoreOptions.map(option => (
                                    <button
                                        key={option.resolution}
                                        type="button"
                                        disabled={data.isLoading}
                                        className={`flex h-10 w-full items-center justify-between rounded-lg px-3 text-xs font-semibold transition-colors ${data.isLoading ? 'cursor-not-allowed opacity-50' : (isDark ? 'text-zinc-200 hover:bg-zinc-800' : 'text-gray-700 hover:bg-gray-100')}`}
                                        onClick={() => handleHdRestoreGenerate(option.resolution)}
                                    >
                                        <span>{option.resolution}</span>
                                        <span className={`flex items-center gap-1 tabular-nums ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                                            <Icons.Coins size={13} />
                                            <span>{option.credits}</span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                    <button className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${isDark ? 'hover:bg-zinc-800' : 'hover:bg-gray-100'}`} onClick={() => onUpload?.(data.id)} title="上传">
                        <Icons.Upload size={17} />
                    </button>
                </div>
            </div>
        )}

        {/* Control Panel */}
        {isSelectedAndStable && showControls && (
            <div className="absolute top-full left-1/2 min-w-[520px] pt-4 z-[70] pointer-events-auto" style={panelTransform} onMouseDown={(e) => e.stopPropagation()}>
                  {!isExclusiveEditorOpen && inputMedia.length > 0 && <LocalInputThumbnails inputs={inputs} items={inputMedia} ready={deferredInputs} isDark={isDark} onPreview={onPreviewReference} />}
                  <div className={isExclusiveEditorOpen ? 'flex flex-col' : `${controlPanelBg} rounded-2xl p-4 flex flex-col gap-3 border`}>
                       {!isExclusiveEditorOpen && (
                           <>
                               {/* Prompt Input */}
                               <LocalPromptTextarea
                                   className={`w-full border rounded-xl px-4 py-3 text-sm leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-[#4446CE]/20 min-h-[72px] transition-all ${inputBg}`}
                                   placeholder="描述你想要生成的图片..."
                                   value={data.prompt || ''}
                                   onChange={(value) => updateData(data.id, { prompt: value })}
                                   isDark={isDark}
                                   expandedTitle="编辑图片提示词"
                               />

                               {/* Parameters Row - All in one line */}
                               <div className="flex items-center gap-2">
                                   <LocalCustomDropdown
                                       options={imageModels}
                                       value={data.model || 'Seedream 5.0'}
                                       onChange={(val: any) => updateData(data.id, { model: val })}
                                       isOpen={activeDropdown === 'model'}
                                       onToggle={() => setActiveDropdown(activeDropdown === 'model' ? null : 'model')}
                                       onClose={() => setActiveDropdown(null)}
                                       align="left"
                                       width="w-[130px]"
                                       isDark={isDark}
                                   />
                                   <LocalCustomDropdown icon={Icons.Crop} options={supportedRatios} value={data.aspectRatio || '1:1'} onChange={handleRatioChange} isOpen={activeDropdown === 'ratio'} onToggle={() => setActiveDropdown(activeDropdown === 'ratio' ? null : 'ratio')} onClose={() => setActiveDropdown(null)} isDark={isDark} />
                                   <LocalCustomDropdown icon={Icons.Monitor} options={supportedResolutions} value={data.resolution || '1k'} onChange={(val: any) => updateData(data.id, { resolution: val })} isOpen={activeDropdown === 'res'} onToggle={() => setActiveDropdown(activeDropdown === 'res' ? null : 'res')} onClose={() => setActiveDropdown(null)} disabledOptions={['1k', '2k', '4k'].filter(r => !supportedResolutions.includes(r))} isDark={isDark} />
                                   <LocalCustomDropdown icon={Icons.Layers} options={[1, 2, 3, 4]} value={data.count || 1} onChange={(val: any) => updateData(data.id, { count: val })} isOpen={activeDropdown === 'count'} onToggle={() => setActiveDropdown(activeDropdown === 'count' ? null : 'count')} onClose={() => setActiveDropdown(null)} isDark={isDark} />

                                   <div className="flex-1" />

                                   <button
                                       onClick={() => onGenerate(data.id)}
                                       disabled={data.isLoading || !isConfigured}
                                       title={!isConfigured ? '请在设置中配置 API Key' : (hasResult ? '基于当前参数生成一个新版本' : '开始生成')}
                                       className={`shrink-0 h-8 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-all active:scale-[0.98] ${
                                           data.isLoading || !isConfigured
                                               ? 'bg-gray-400 text-white cursor-not-allowed'
                                               : 'bg-gradient-to-r from-[#4446CE] to-[#4446CE] hover:from-[#4446CE] hover:to-[#8F91F4] text-white shadow-lg shadow-[#4446CE]/25 hover:shadow-[#4446CE]/40'
                                       }`}
                                   >
                                       <span className="text-[11px] font-bold tabular-nums opacity-85">{baseGenerateCredits}分</span>
                                       <span className="h-4 w-px bg-white/25" />
                                       {data.isLoading ? <Icons.Loader2 className="animate-spin" size={15}/> : <Icons.Wand2 size={15} />}
                                       <span>{data.isLoading ? '生成中' : '生成'}</span>
                                   </button>
                               </div>
                           </>
                       )}
                      {data.imageSrc && isAngleEditorOpen && (
                          <div className={`rounded-2xl border p-4 flex flex-col gap-3 ${isDark ? 'border-zinc-700 bg-[#242424]' : 'border-gray-200 bg-white shadow-xl'}`}>
                              <div className="flex items-center justify-between">
                                  <div className={`text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>多角度编辑器</div>
                                  <button
                                      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'hover:bg-zinc-800 text-zinc-400' : 'hover:bg-gray-100 text-gray-500'}`}
                                      onClick={() => setIsAngleEditorOpen(false)}
                                      title="关闭多角度编辑器"
                                  >
                                      <Icons.X size={20} />
                                  </button>
                              </div>

                              <div className="grid grid-cols-7 gap-2">
                                  {anglePresets.map(preset => {
                                      const active = anglePreset === preset.key;
                                      return (
                                          <button
                                              key={preset.key}
                                              className={`h-8 rounded-lg px-2 text-xs font-medium whitespace-nowrap border transition-all ${
                                                  active
                                                      ? (isDark ? 'bg-zinc-600 border-zinc-500 text-white' : 'bg-gray-900 border-gray-900 text-white')
                                                      : (isDark ? 'border-zinc-700/70 bg-zinc-800/25 text-zinc-400 hover:text-white hover:border-zinc-600' : 'border-gray-200 text-gray-600 hover:text-gray-900')
                                              }`}
                                              onClick={() => applyAnglePreset(preset)}
                                          >
                                              {preset.label}
                                          </button>
                                      );
                                  })}
                              </div>

                              <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-4">
                                  <div
                                      ref={anglePadRef}
                                      className={`relative h-[240px] rounded-xl overflow-hidden flex items-center justify-center cursor-grab active:cursor-grabbing touch-none ${isDark ? 'bg-[#303030]' : 'bg-gray-100'}`}
                                      onPointerDown={handleAnglePointerDown}
                                      onPointerMove={handleAnglePointerMove}
                                      onPointerUp={handleAnglePointerUp}
                                      onPointerCancel={handleAnglePointerUp}
                                      title="拖动球形区域调整水平环绕和垂直俯仰"
                                  >
                                      <svg className="absolute inset-[34px] w-[172px] h-[172px] opacity-75 pointer-events-none" viewBox="0 0 172 172" fill="none">
                                          <circle cx="86" cy="86" r="72" stroke="currentColor" className={isDark ? 'text-zinc-500' : 'text-gray-400'} />
                                          <ellipse cx="86" cy="86" rx="32" ry="72" stroke="currentColor" className={isDark ? 'text-zinc-500' : 'text-gray-400'} />
                                          <ellipse cx="86" cy="86" rx="58" ry="72" stroke="currentColor" className={isDark ? 'text-zinc-600' : 'text-gray-300'} />
                                          <ellipse cx="86" cy="86" rx="72" ry="28" stroke="currentColor" className={isDark ? 'text-zinc-500' : 'text-gray-400'} />
                                          <ellipse cx="86" cy="86" rx="72" ry="52" stroke="currentColor" className={isDark ? 'text-zinc-600' : 'text-gray-300'} />
                                          <path d="M14 86H158M86 14V158" stroke="currentColor" className={isDark ? 'text-zinc-600' : 'text-gray-300'} />
                                      </svg>

                                      <button
                                          className={`absolute left-4 top-1/2 -translate-y-1/2 z-20 w-7 h-7 rounded-full flex items-center justify-center ${isDark ? 'text-zinc-400 hover:bg-white/5 hover:text-white' : 'text-gray-500 hover:bg-white'}`}
                                          onPointerDown={(event) => event.stopPropagation()}
                                          onClick={() => { setAnglePreset('custom'); setYaw(value => Math.max(-180, value - 15)); }}
                                          title="向左环绕 15°"
                                      >
                                          <Icons.ChevronLeft size={17} />
                                      </button>
                                      <button
                                          className={`absolute right-4 top-1/2 -translate-y-1/2 z-20 w-7 h-7 rounded-full flex items-center justify-center ${isDark ? 'text-zinc-400 hover:bg-white/5 hover:text-white' : 'text-gray-500 hover:bg-white'}`}
                                          onPointerDown={(event) => event.stopPropagation()}
                                          onClick={() => { setAnglePreset('custom'); setYaw(value => Math.min(180, value + 15)); }}
                                          title="向右环绕 15°"
                                      >
                                          <Icons.ChevronRight size={17} />
                                      </button>
                                      <button
                                          className={`absolute top-3 left-1/2 -translate-x-1/2 z-20 w-7 h-7 rounded-full flex items-center justify-center ${isDark ? 'text-zinc-400 hover:bg-white/5 hover:text-white' : 'text-gray-500 hover:bg-white'}`}
                                          onPointerDown={(event) => event.stopPropagation()}
                                          onClick={() => { setAnglePreset('custom'); setPitch(value => Math.min(90, value + 10)); }}
                                          title="向上俯仰 10°"
                                      >
                                          <Icons.ChevronDown size={17} className="rotate-180" />
                                      </button>
                                      <button
                                          className={`absolute bottom-3 left-1/2 -translate-x-1/2 z-20 w-7 h-7 rounded-full flex items-center justify-center ${isDark ? 'text-zinc-400 hover:bg-white/5 hover:text-white' : 'text-gray-500 hover:bg-white'}`}
                                          onPointerDown={(event) => event.stopPropagation()}
                                          onClick={() => { setAnglePreset('custom'); setPitch(value => Math.max(-90, value - 10)); }}
                                          title="向下俯仰 10°"
                                      >
                                          <Icons.ChevronDown size={17} />
                                      </button>

                                      <img
                                          src={data.imageSrc}
                                          className="absolute z-10 w-[70px] h-[70px] object-cover rounded-lg shadow-2xl ring-1 ring-white/20 pointer-events-none"
                                          draggable={false}
                                          style={{ transform: `scale(${zoom === 'wide' ? 0.86 : zoom === 'close' ? 1.12 : 1})` }}
                                      />
                                      <img
                                          src={data.imageSrc}
                                          className="absolute z-20 w-7 h-7 object-cover rounded border border-white/50 shadow-lg pointer-events-none transition-[left,top] duration-100"
                                          draggable={false}
                                          style={{
                                              left: `${50 + (yaw / 180) * 31}%`,
                                              top: `${50 - (pitch / 90) * 31}%`,
                                              transform: 'translate(-50%, -50%)',
                                          }}
                                      />
                                  </div>

                                  <div className="flex flex-col justify-center gap-4">
                                      {[
                                          { label: '水平环绕', value: yaw, min: -180, max: 180, setter: setYaw, valueLabel: `${yaw}°` },
                                          { label: '垂直俯仰', value: pitch, min: -90, max: 90, setter: setPitch, valueLabel: `${pitch}°` },
                                      ].map(item => (
                                          <div key={item.label} className="grid grid-cols-[72px_1fr_44px] items-center gap-3">
                                              <span className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{item.label}</span>
                                              <input
                                                  type="range"
                                                  min={item.min}
                                                  max={item.max}
                                                  value={item.value}
                                                  onChange={(event) => {
                                                      setAnglePreset('custom');
                                                      item.setter(Number(event.target.value));
                                                  }}
                                                  className="w-full accent-[#67D8E8]"
                                              />
                                              <span className={`text-xs font-semibold text-right tabular-nums ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{item.valueLabel}</span>
                                          </div>
                                      ))}
                                      <div className="grid grid-cols-[72px_1fr_44px] items-center gap-3">
                                          <span className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>景别缩放</span>
                                          <input
                                              type="range"
                                              min={0}
                                              max={2}
                                              step={1}
                                              value={zoom === 'wide' ? 0 : zoom === 'close' ? 2 : 1}
                                              onChange={(event) => {
                                                  setAnglePreset('custom');
                                                  setZoom((['wide', 'medium', 'close'] as const)[Number(event.target.value)]);
                                              }}
                                              className="w-full accent-[#67D8E8]"
                                          />
                                          <span className={`text-xs font-semibold text-right ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{zoom === 'wide' ? '全景' : zoom === 'close' ? '近景' : '中景'}</span>
                                      </div>

                                      <button
                                          className={`self-start h-7 px-2.5 rounded-lg border text-[11px] transition-colors ${showAnglePrompt ? 'border-[#67D8E8]/50 text-[#9CE8F1] bg-[#67D8E8]/10' : (isDark ? 'border-zinc-700 text-zinc-500 hover:text-zinc-200' : 'border-gray-200 text-gray-500')}`}
                                          onClick={() => setShowAnglePrompt(value => !value)}
                                      >
                                          {showAnglePrompt ? '收起高级参数' : '高级参数'}
                                      </button>
                                  </div>
                              </div>

                              {showAnglePrompt && (
                                  <div className={`rounded-xl border p-3 flex flex-col gap-3 ${isDark ? 'border-zinc-700 bg-zinc-900/45' : 'border-gray-200 bg-gray-50'}`}>
                                      <div className="flex flex-wrap items-center gap-2">
                                          <LocalCustomDropdown icon={Icons.Crop} options={angleAspectOptions} value={angleAspectRatio} onChange={(val: any) => setAngleAspectRatio(val)} isOpen={activeDropdown === 'angleAspect'} onToggle={() => setActiveDropdown(activeDropdown === 'angleAspect' ? null : 'angleAspect')} onClose={() => setActiveDropdown(null)} isDark={isDark} />
                                          <div className={`h-8 rounded-lg border p-0.5 flex items-center ${isDark ? 'border-zinc-700 bg-zinc-950/30' : 'border-gray-200 bg-white'}`}>
                                              {backgroundOptions.map(item => (
                                                  <button key={item.value} className={`h-6 px-2.5 rounded-md text-[11px] font-semibold transition-colors ${angleBackground === item.value ? 'bg-[#4446CE] text-white' : (isDark ? 'text-zinc-400 hover:text-white' : 'text-gray-500 hover:text-gray-900')}`} onClick={() => setAngleBackground(item.value)}>{item.label}</button>
                                              ))}
                                          </div>
                                          <div className={`h-8 rounded-lg border p-0.5 flex items-center ${isDark ? 'border-zinc-700 bg-zinc-950/30' : 'border-gray-200 bg-white'}`}>
                                              {consistencyOptions.map(item => (
                                                  <button key={item.value} className={`h-6 px-2.5 rounded-md text-[11px] font-semibold transition-colors ${angleConsistency === item.value ? 'bg-[#4446CE] text-white' : (isDark ? 'text-zinc-400 hover:text-white' : 'text-gray-500 hover:text-gray-900')}`} onClick={() => setAngleConsistency(item.value)}>{item.label}</button>
                                              ))}
                                          </div>
                                      </div>
                                      <LocalPromptTextarea
                                          className={`w-full border rounded-xl px-3 py-2 text-xs leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-[#4446CE]/20 min-h-[52px] transition-all ${inputBg}`}
                                          placeholder="补充材质、光线、风格要求，例如：保持场景空间关系、电影感光线、不要改变建筑布局..."
                                          value={anglePrompt}
                                          onChange={setAnglePrompt}
                                          isDark={isDark}
                                          expandedTitle="编辑多角度补充提示词"
                                      />
                                  </div>
                              )}

                              <div className="flex items-center justify-between">
                                  <button
                                      className={`h-8 px-2 rounded-lg text-xs flex items-center gap-2 transition-colors ${isDark ? 'text-zinc-400 hover:text-white' : 'text-gray-500 hover:text-gray-900'}`}
                                      onClick={() => {
                                          setAnglePreset('custom');
                                          setYaw(0);
                                          setPitch(0);
                                          setZoom('medium');
                                          setAnglePrompt('');
                                          setAngleConsistency('high');
                                          setAngleBackground('clean');
                                          setAngleAspectRatio('沿原图');
                                      }}
                                  >
                                      <Icons.RotateCcw size={15} />
                                      <span>重置参数</span>
                                  </button>
                                  <div className="flex items-center gap-2">
                                      {renderCreditBadge(multiAngleCredits, 'cyan')}
                                      <button
                                          className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${data.isLoading ? 'bg-gray-400 text-white cursor-not-allowed' : 'bg-white text-zinc-950 hover:bg-[#E1E3FF] shadow-lg'}`}
                                          disabled={data.isLoading}
                                          onClick={handleMultiAngleGenerate}
                                          title="生成多角度图片"
                                      >
                                          {data.isLoading ? <Icons.Loader2 size={19} className="animate-spin" /> : <Icons.ArrowUp size={22} />}
                                      </button>
                                  </div>
                              </div>
                          </div>
                      )}
                      {data.imageSrc && isLightingOpen && (
                          <div className={`rounded-2xl border p-5 flex flex-col gap-4 ${isDark ? 'border-zinc-700 bg-[#202020]' : 'border-gray-200 bg-white shadow-xl'}`}>
                              <div className="flex items-center justify-between gap-3">
                                  <div className={`text-lg font-semibold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>打光效果</div>
                                  <button
                                      className={`w-9 h-9 rounded-lg flex items-center justify-center ${isDark ? 'hover:bg-zinc-800 text-zinc-400' : 'hover:bg-gray-100 text-gray-500'}`}
                                      onClick={() => setIsLightingOpen(false)}
                                  >
                                      <Icons.X size={22} />
                                  </button>
                              </div>
                              <div className="grid grid-cols-[240px_1fr] gap-6">
                                  {/* Left: sphere */}
                                  <div className="flex flex-col gap-3">
                                      <div className={`flex p-0.5 rounded-lg ${isDark ? 'bg-zinc-900' : 'bg-gray-100'}`}>
                                          {[{ key: 'perspective' as const, label: '透视' }, { key: 'front' as const, label: '正面' }].map(v => (
                                              <button key={v.key} className={`flex-1 h-8 rounded-md text-xs font-semibold transition-colors ${lightView === v.key ? (isDark ? 'bg-zinc-700 text-white' : 'bg-white text-gray-900 shadow-sm') : (isDark ? 'text-zinc-500' : 'text-gray-400')}`} onClick={() => setLightView(v.key)}>{v.label}</button>
                                          ))}
                                      </div>
                                      <div
                                          ref={lightPadRef}
                                          className={`relative aspect-square rounded-2xl overflow-hidden cursor-crosshair touch-none ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}
                                          onPointerDown={handleLightPointerDown}
                                          onPointerMove={handleLightPointerMove}
                                          onPointerUp={handleLightPointerUp}
                                          onPointerCancel={handleLightPointerUp}
                                      >
                                          {/* Sphere guides */}
                                          <div className={`absolute inset-6 rounded-full border ${isDark ? 'border-zinc-600/50' : 'border-gray-300/60'}`} />
                                          <div className={`absolute inset-12 rounded-full border ${isDark ? 'border-zinc-600/30' : 'border-gray-300/40'}`} />
                                          <div className={`absolute left-1/2 top-6 bottom-6 w-px ${isDark ? 'bg-zinc-600/30' : 'bg-gray-300/40'}`} />
                                          <div className={`absolute top-1/2 left-6 right-6 h-px ${isDark ? 'bg-zinc-600/30' : 'bg-gray-300/40'}`} />
                                          {/* Light beam cone */}
                                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                              <div
                                                  className="absolute w-20 h-28 opacity-40"
                                                  style={{
                                                      left: `${50 + (lightAzimuth / 180) * 35}%`,
                                                      top: `${50 - (lightElevation / 90) * 35}%`,
                                                      transform: `translate(-50%, -50%) rotate(${-lightAzimuth / 3}deg)`,
                                                      background: `conic-gradient(from ${180 + lightAzimuth / 2}deg, rgba(255,255,200,0.5) 0deg, transparent 40deg, transparent 320deg, rgba(255,255,200,0.5) 360deg)`,
                                                      borderRadius: '50%',
                                                  }}
                                              />
                                          </div>
                                          {/* Light dot */}
                                          <div
                                              className="absolute z-10 w-4 h-4 rounded-full bg-amber-400 border-2 border-white shadow-[0_0_12px_rgba(251,191,36,0.6)]"
                                              style={{
                                                  left: `${50 + (lightAzimuth / 180) * 35}%`,
                                                  top: `${50 - (lightElevation / 90) * 35}%`,
                                                  transform: 'translate(-50%, -50%)',
                                              }}
                                          />
                                      </div>
                                  </div>
                                  {/* Right: controls */}
                                  <div className="flex flex-col gap-4 justify-center">
                                      {/* Global / Smart mode */}
                                      <div className="flex items-center justify-between">
                                          <span className={`text-sm font-semibold ${isDark ? 'text-zinc-200' : 'text-gray-800'}`}>全局</span>
                                          <label className="flex items-center gap-2 cursor-pointer">
                                              <span className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>智能模式</span>
                                              <button className={`relative w-10 h-5 rounded-full transition-colors ${lightSmartMode ? 'bg-[#4446CE]' : (isDark ? 'bg-zinc-700' : 'bg-gray-300')}`} onClick={() => setLightSmartMode(!lightSmartMode)}>
                                                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${lightSmartMode ? 'translate-x-5' : 'translate-x-0.5'}`} />
                                              </button>
                                          </label>
                                      </div>
                                      {/* Brightness */}
                                      <div className="flex items-center gap-3">
                                          <span className={`text-sm w-10 shrink-0 ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>亮度</span>
                                          <input type="range" min={0} max={100} value={lightBrightness} onChange={(e) => setLightBrightness(Number(e.target.value))} className="flex-1 accent-amber-400" />
                                          <span className={`text-sm font-semibold w-12 text-right ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{lightBrightness}%</span>
                                      </div>
                                      {/* Color */}
                                      <div className="flex items-center gap-3">
                                          <span className={`text-sm w-10 shrink-0 ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>颜色</span>
                                          <div className={`w-10 h-6 rounded-md border ${isDark ? 'border-zinc-600 bg-zinc-700' : 'border-gray-300 bg-gray-200'}`} style={{ background: `hsl(${lightBrightness * 3.6}, 20%, ${40 + lightBrightness * 0.4}%)` }} />
                                      </div>
                                      {/* Light direction */}
                                      <div>
                                          <span className={`text-sm mb-2 block ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>主光源</span>
                                          <div className="grid grid-cols-3 gap-1.5">
                                              {LIGHT_DIRECTIONS.map(d => (
                                                  <button
                                                      key={d.key}
                                                      className={`h-8 rounded-lg text-xs font-semibold border transition-all ${
                                                          lightDirection === d.key
                                                              ? (isDark ? 'bg-zinc-600 border-zinc-500 text-white' : 'bg-gray-900 border-gray-900 text-white')
                                                              : (isDark ? 'border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-600' : 'border-gray-200 text-gray-500 hover:text-gray-900 hover:border-gray-300')
                                                      }`}
                                                      onClick={() => applyLightDirection(d.key)}
                                                  >
                                                      {d.label}
                                                  </button>
                                              ))}
                                          </div>
                                      </div>
                                      {/* Rim light */}
                                      <div className="flex items-center justify-between">
                                          <span className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>轮廓光</span>
                                          <button className={`relative w-10 h-5 rounded-full transition-colors ${lightRimEnabled ? 'bg-[#4446CE]' : (isDark ? 'bg-zinc-700' : 'bg-gray-300')}`} onClick={() => setLightRimEnabled(!lightRimEnabled)}>
                                              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${lightRimEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                                          </button>
                                      </div>
                                  </div>
                              </div>
                              {/* Footer */}
                              <div className="flex items-center justify-between pt-1">
                                  <button className={`h-8 px-3 rounded-lg text-sm flex items-center gap-2 ${isDark ? 'text-zinc-400 hover:text-white' : 'text-gray-500 hover:text-gray-900'}`} onClick={resetLighting}>
                                      <Icons.RotateCcw size={15} />
                                      <span>重置参数</span>
                                  </button>
                                  <div className="flex items-center gap-2">
                                      {renderCreditBadge(lightingCredits, 'amber')}
                                      <button className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${data.isLoading ? 'bg-gray-400 text-white cursor-not-allowed' : 'bg-white text-zinc-950 hover:bg-amber-100 shadow-lg'}`} disabled={data.isLoading} onClick={handleLightingGenerate} title="应用打光效果">
                                          {data.isLoading ? <Icons.Loader2 size={22} className="animate-spin" /> : <Icons.ArrowUp size={26} />}
                                      </button>
                                  </div>
                              </div>
                          </div>
                      )}
                 </div>
            </div>
        )}
      </>
    );
};
