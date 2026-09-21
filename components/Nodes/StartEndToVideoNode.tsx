
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { InputMedia, NodeData } from '../../types';
import { Icons } from '../Icons';
import { getModelConfig, MODEL_REGISTRY, getVisibleModels } from '../../services/geminiService';
import { VIDEO_HANDLERS } from '../../services/mode/video/configurations';
import { getVideoConstraints, getAutoCorrectedVideoSettings } from '../../services/mode/video/rules';
import { GenerationFailureNotice, LocalEditableTitle, LocalCustomDropdown, LocalMediaStack, LocalPromptTextarea } from './Shared/LocalNodeComponents';

interface StartEndToVideoNodeProps {
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
  onSetVideoVersion?: (nodeId: string, src: string) => void;
  onUseVideoVersion?: (nodeId: string, src: string) => void;
  onDownload?: (id: string) => void;
  onUpload?: (id: string) => void;
  onSaveResult?: (id: string) => void;
  onToggleFavoriteArtifact?: (nodeId: string, url: string, type: 'image' | 'video') => void;
  isArtifactFavorited?: (nodeId: string, url: string) => boolean;
  onAddToAssetLibrary?: (nodeId: string) => void;
  isDark?: boolean;
  isSelecting?: boolean;
  canvasScale?: number;
}

export const StartEndToVideoNode: React.FC<StartEndToVideoNodeProps> = ({
    data, updateData, onGenerate, selected, showControls, inputs = [], inputMedia = [], onPreviewReference, onMaximize, onPreviewMedia, onSetVideoVersion, onUseVideoVersion, onDownload, onUpload, onSaveResult, onToggleFavoriteArtifact, isArtifactFavorited, onAddToAssetLibrary, isDark = true, isSelecting, canvasScale = 1
}) => {
    const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
    const [progress, setProgress] = useState(0);
    const [isConfigured, setIsConfigured] = useState(true);
    const [videoModels, setVideoModels] = useState<string[]>([]);

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
    
    // Apply swap if needed
    const swapped = data.swapFrames || false;
    const orderedInputs = swapped && inputs.length >= 2 ? [inputs[1], inputs[0]] : inputs;
    
    const hasStartFrame = orderedInputs.length >= 1;
    const hasEndFrame = orderedInputs.length >= 2;
    const hasValidInputs = hasStartFrame && hasEndFrame;

    const checkConfig = useCallback(() => {
         const mName = data.model || 'Agnes Video V2.0';
         const cfg = getModelConfig(mName);
         // KC backend-proxied video models run through /api/generate/video, so the API key
         // lives on the backend (Cloudflare AGNES_VIDEO_API_KEY), not in the browser.
         const isBackendModel = mName === 'Agnes Video V2.0' || mName === 'Seedance 1.5 Pro';
         setIsConfigured(isBackendModel || !!cfg.key);
    }, [data.model]);

    const updateModels = useCallback(() => {
        const visibleModels = getVisibleModels();
        const models = visibleModels.filter(k => MODEL_REGISTRY[k]?.category === 'VIDEO');
        setVideoModels(models);
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

    // Group models for dropdown
    const groupedVideoModels = useMemo(() => {
        const groups: Record<string, string[]> = {
            'Kling': [],
            'Hailuo': [],
            'Veo': [],
            'Wan': []
        };
        const ungrouped: string[] = [];
        
        videoModels.forEach(m => {
            const lower = m.toLowerCase();
            if (m.startsWith('Kling') || m.includes('可灵')) {
                 groups['Kling'].push(m);
            } else if (m.startsWith('海螺') || lower.includes('hailuo')) {
                 groups['Hailuo'].push(m);
            } else if (m.startsWith('Veo')) {
                 groups['Veo'].push(m);
            } else if (m.startsWith('Wan') || lower.includes('wan')) {
                 groups['Wan'].push(m);
            } else {
                 ungrouped.push(m);
            }
        });
        
        const result = Object.entries(groups)
            .filter(([_, items]) => items.length > 0)
            .map(([label, items]) => ({ label, items }));
            
        return [...result, ...ungrouped];
    }, [videoModels]);

    useEffect(() => { let interval: any; if (data.isLoading) { setProgress(0); interval = setInterval(() => { setProgress(prev => (prev >= 95 ? 95 : prev + Math.max(0.5, (95 - prev) / 20))); }, 200); } else setProgress(0); return () => clearInterval(interval); }, [data.isLoading]);

    const handleRatioChange = (ratio: string) => {
        const currentShort = Math.min(data.width, data.height);
        const baseSize = Math.max(currentShort, 400);

        const [wStr, hStr] = ratio.split(':');
        const wR = parseFloat(wStr);
        const hR = parseFloat(hStr);
        const r = wR / hR;

        let newW, newH;
        if (r >= 1) {
            newH = baseSize;
            newW = baseSize * r;
        } else {
            newW = baseSize;
            newH = baseSize / r;
        }
        updateData(data.id, { aspectRatio: ratio, width: Math.round(newW), height: Math.round(newH) });
    };

    const currentModel = data.model || 'Seedance 1.5 Pro';
    const handler = VIDEO_HANDLERS[currentModel] || VIDEO_HANDLERS['Seedance 1.5 Pro'];
    const rules = handler.rules;

    const resOptions = rules.resolutions || ['720p'];
    const durOptions = rules.durations || ['4s', '8s', '12s'];
    const ratioOptions = rules.ratios || ['16:9'];

    // Constraints & Auto-Correction
    const constraints = getVideoConstraints(currentModel, data.resolution, data.duration, inputs.length);
    const displayResValue = (data.model?.includes('海螺') && (data.resolution === '720p' || data.resolution === '768p')) ? '768p' : data.resolution;

    useEffect(() => {
        let updates: Partial<NodeData> = {};
        const corrections = getAutoCorrectedVideoSettings(currentModel, data.resolution, data.duration, inputs.length);
        if (corrections.resolution) updates.resolution = corrections.resolution;
        if (corrections.duration) updates.duration = corrections.duration;

        if (data.resolution && !resOptions.includes(data.resolution)) updates.resolution = resOptions[0];
        if (data.duration && !durOptions.includes(data.duration)) updates.duration = durOptions[0];
        if (data.aspectRatio && !ratioOptions.includes(data.aspectRatio)) updates.aspectRatio = ratioOptions[0];

        if (Object.keys(updates).length > 0) updateData(data.id, updates);
    }, [data.model, data.resolution, data.duration, data.aspectRatio, resOptions, durOptions, ratioOptions, currentModel, inputs.length, updateData, data.id]);

    const containerBg = isDark ? 'bg-[#1a1a1a]' : 'bg-white';
    const containerBorder = selected ? 'border-emerald-500 ring-2 ring-emerald-500/30' : (isDark ? 'border-zinc-700/50' : 'border-gray-200');
    const controlPanelBg = isDark ? 'bg-[#1a1a1a]/95 backdrop-blur-xl border-zinc-700/50' : 'bg-white/95 backdrop-blur-xl border-gray-200 shadow-xl';
    const inputBg = isDark ? 'bg-zinc-800/80 hover:bg-zinc-800 border-zinc-700 focus:border-emerald-500 text-white placeholder-zinc-500' : 'bg-gray-50 hover:bg-white border-gray-200 focus:border-emerald-500 text-gray-900 placeholder-gray-400';
    const emptyStateIconColor = isDark ? 'bg-zinc-800/50 text-zinc-500' : 'bg-gray-100 text-gray-400';
    const emptyStateTextColor = isDark ? 'text-zinc-500' : 'text-gray-400';
    const warningColor = isDark ? 'text-amber-400' : 'text-amber-600';
    const hasResult = !!data.videoSrc && !data.isLoading;
    const hasGenerationError = Boolean(data.errorMessage || data.generationTask?.errorMessage || data.generationTask?.status === 'needs_check');
    const generationErrorMessage = data.errorMessage || data.generationTask?.errorMessage || '提交未确认，未拿到任务编号，请核对后再生成';
    const generationErrorDetail = data.generationTask?.errorDetail || data.errorMessage;

    // Custom input thumbnails for start/end frames
    const renderFrameThumbnails = () => {
        const thumbBg = isDark ? 'bg-zinc-800/80 border-zinc-700' : 'bg-gray-50 border-gray-200';
        const labelColor = isDark ? 'text-zinc-400' : 'text-gray-500';
        const emptyBg = isDark ? 'bg-zinc-800/50 border-zinc-700 border-dashed' : 'bg-gray-100 border-gray-300 border-dashed';
        
        return (
            <div className={`mb-3 p-3 rounded-xl border ${thumbBg} flex items-center justify-center gap-4`}>
                {/* Start Frame */}
                <div className="flex items-center gap-2">
                    <span className={`text-xs font-semibold ${labelColor}`}>首帧</span>
                    {hasStartFrame ? (
                        <button className="w-14 h-14 rounded-lg overflow-hidden border-2 border-emerald-500/50 shadow-sm" onClick={() => onPreviewReference?.(inputMedia[swapped && inputs.length >= 2 ? 1 : 0] || { type: 'image', url: orderedInputs[0] })} title="查看首帧">
                            <img src={orderedInputs[0]} className="w-full h-full object-cover" alt="首帧" />
                        </button>
                    ) : (
                        <div className={`w-14 h-14 rounded-lg flex items-center justify-center ${emptyBg}`}>
                            <Icons.Frame size={18} className={warningColor} />
                        </div>
                    )}
                </div>

                {/* Swap Button */}
                <button 
                    className={`p-2 rounded-lg transition-all ${
                        inputs.length >= 2
                            ? (isDark ? 'hover:bg-zinc-700 text-zinc-400 hover:text-white' : 'hover:bg-gray-200 text-gray-400 hover:text-gray-600')
                            : 'opacity-30 cursor-not-allowed'
                    } ${isDark ? 'text-zinc-500' : 'text-gray-400'}`}
                    onClick={() => {
                        if (inputs.length >= 2) {
                            updateData(data.id, { swapFrames: !swapped });
                        }
                    }}
                    disabled={inputs.length < 2}
                    title="交换首尾帧"
                >
                    <Icons.ArrowRightLeft size={18} />
                </button>

                {/* End Frame */}
                <div className="flex items-center gap-2">
                    {hasEndFrame ? (
                        <button className="w-14 h-14 rounded-lg overflow-hidden border-2 border-emerald-500/50 shadow-sm" onClick={() => onPreviewReference?.(inputMedia[swapped && inputs.length >= 2 ? 0 : 1] || { type: 'image', url: orderedInputs[1] })} title="查看尾帧">
                            <img src={orderedInputs[1]} className="w-full h-full object-cover" alt="尾帧" />
                        </button>
                    ) : (
                        <div className={`w-14 h-14 rounded-lg flex items-center justify-center ${emptyBg}`}>
                            <Icons.Frame size={18} className={warningColor} />
                        </div>
                    )}
                    <span className={`text-xs font-semibold ${labelColor}`}>尾帧</span>
                </div>
            </div>
        );
    };

    return (
      <>
        <div className={`w-full h-full relative rounded-2xl border ${containerBorder} ${containerBg} ${data.isStackOpen ? 'overflow-visible' : 'overflow-hidden'} shadow-xl group transition-all duration-200`}>
            {hasResult ? (
                 <>
                     <LocalMediaStack
                         data={data}
                         updateData={updateData}
                         currentSrc={data.videoSrc}
                         onMaximize={onMaximize}
                         isDark={isDark}
                         selected={selected}
                         onToggleFavorite={(src, type) => onToggleFavoriteArtifact?.(data.id, src, type)}
                         isFavorite={(src) => isArtifactFavorited?.(data.id, src) || false}
                         onPreviewMedia={onPreviewMedia}
                         onSetVideoVersion={onSetVideoVersion}
                         onUseVideoVersion={onUseVideoVersion}
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
                    <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-4 ${emptyStateIconColor}`}>
                        <Icons.Frame size={28} className="opacity-60"/>
                    </div>
                    <span className="text-sm font-medium opacity-60">首尾帧生视频</span>
                    {!hasValidInputs ? (
                        <span className={`text-xs mt-2 flex items-center gap-1 ${warningColor}`}>
                            <Icons.AlertCircle size={12} />
                            需要连接首帧和尾帧图片
                        </span>
                    ) : hasGenerationError ? (
                        <GenerationFailureNotice
                            message={generationErrorMessage}
                            detail={generationErrorDetail}
                            isDark={isDark}
                        />
                    ) : (
                        <span className="text-xs opacity-40 mt-1">选中节点开始创作</span>
                    )}
                </div>
            )}
            
            {/* Loading Overlay with Progress */}
            {data.isLoading && (
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-20">
                    <div className="relative w-16 h-16 mb-4">
                        <svg className="w-full h-full -rotate-90" viewBox="0 0 64 64">
                            <circle cx="32" cy="32" r="28" fill="none" stroke={isDark ? '#3f3f46' : '#e5e7eb'} strokeWidth="4" />
                            <circle 
                                cx="32" cy="32" r="28" fill="none" 
                                stroke="#10b981" strokeWidth="4" 
                                strokeLinecap="round"
                                strokeDasharray={`${progress * 1.76} 176`}
                                className="transition-all duration-300"
                            />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                            <span className="text-white font-bold text-sm tabular-nums">{Math.floor(progress)}%</span>
                        </div>
                    </div>
                    <span className="text-white/80 text-sm font-medium">视频生成中...</span>
                </div>
            )}
        </div>

        {isSelectedAndStable && showControls && hasResult && (
            <div className={`absolute bottom-full left-1/2 mb-2 z-[75] flex items-center gap-1.5 rounded-2xl border px-3 py-2 shadow-2xl backdrop-blur-xl pointer-events-auto ${isDark ? 'bg-[#202020]/95 border-zinc-700 text-zinc-100' : 'bg-white/95 border-gray-200 text-gray-900'}`} style={topToolbarTransform} onMouseDown={(e) => e.stopPropagation()}>
                <button className={`h-9 px-2.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap transition-colors ${isDark ? 'hover:bg-zinc-800' : 'hover:bg-gray-100'}`} onClick={() => onUpload?.(data.id)} title="上传替换当前视频">
                    <Icons.Upload size={16} />
                    <span>上传</span>
                </button>
            </div>
        )}

        {/* Control Panel */}
        {isSelectedAndStable && showControls && (
          <div className="absolute top-full left-1/2 min-w-[520px] pt-4 z-[70] pointer-events-auto" style={panelTransform} onMouseDown={(e) => e.stopPropagation()}>
               {renderFrameThumbnails()}
               {!hasValidInputs && (
                   <div className={`mb-3 px-4 py-2.5 rounded-xl border flex items-center gap-2 text-xs ${isDark ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' : 'bg-amber-50 border-amber-200 text-amber-600'}`}>
                       <Icons.AlertCircle size={14} />
                       <span>
                           {!hasStartFrame && !hasEndFrame && '请连接两个图片节点作为首帧和尾帧'}
                           {hasStartFrame && !hasEndFrame && '请再连接一个图片节点作为尾帧'}
                       </span>
                   </div>
               )}
              <div className={`${controlPanelBg} rounded-2xl p-4 flex flex-col gap-3 border`}>
                  {/* Prompt Input */}
                  <LocalPromptTextarea
                      className={`w-full border rounded-xl px-4 py-3 text-sm leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500/20 min-h-[72px] transition-all ${inputBg}`}
                      placeholder="描述从首帧到尾帧的运动变化..."
                      value={data.prompt || ''}
                      onChange={(value) => updateData(data.id, { prompt: value })}
                      isDark={isDark}
                      expandedTitle="编辑首尾帧视频提示词"
                  />
                  
                  {/* Parameters Row - All in one line */}
                  <div className="flex items-center gap-2">
                       <LocalCustomDropdown 
                           options={groupedVideoModels} 
                           value={data.model || 'Seedance 1.5 Pro'} 
                           onChange={(val: any) => updateData(data.id, { model: val })} 
                           isOpen={activeDropdown === 'model'} 
                           onToggle={() => setActiveDropdown(activeDropdown === 'model' ? null : 'model')} 
                           onClose={() => setActiveDropdown(null)} 
                           align="left" 
                           width="w-[130px]" 
                           isDark={isDark} 
                       />
                      <LocalCustomDropdown icon={Icons.Crop} options={ratioOptions} value={data.aspectRatio || '16:9'} onChange={handleRatioChange} isOpen={activeDropdown === 'ratio'} onToggle={() => setActiveDropdown(activeDropdown === 'ratio' ? null : 'ratio')} onClose={() => setActiveDropdown(null)} disabledOptions={constraints.disabledRatios} isDark={isDark} />
                      <LocalCustomDropdown icon={Icons.Monitor} options={resOptions} value={displayResValue || '720p'} onChange={(val: any) => updateData(data.id, { resolution: val })} isOpen={activeDropdown === 'res'} onToggle={() => setActiveDropdown(activeDropdown === 'res' ? null : 'res')} onClose={() => setActiveDropdown(null)} disabledOptions={constraints.disabledRes} isDark={isDark} />
                      <LocalCustomDropdown icon={Icons.Clock} options={durOptions} value={data.duration || '8s'} onChange={(val: any) => updateData(data.id, { duration: val })} isOpen={activeDropdown === 'duration'} onToggle={() => setActiveDropdown(activeDropdown === 'duration' ? null : 'duration')} onClose={() => setActiveDropdown(null)} disabledOptions={constraints.disabledDurations} isDark={isDark} />
                       {/* Spacer */}
                       <div className="flex-1" />
                       
                       {/* Generate Button */}
                       <button 
                           onClick={() => onGenerate(data.id)} 
                           disabled={data.isLoading || !hasValidInputs}
                           title={!hasValidInputs ? '需要连接首帧和尾帧' : (hasResult ? '基于当前参数生成一个新版本' : '开始生成')}
                           className={`shrink-0 h-8 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-all active:scale-[0.98] ${
                               data.isLoading || !hasValidInputs
                                   ? 'bg-gray-400 text-white cursor-not-allowed' 
                                   : 'bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white shadow-lg shadow-emerald-500/25 hover:shadow-emerald-500/40'
                           }`}
                       >
                           {data.isLoading ? <Icons.Loader2 className="animate-spin" size={15}/> : <Icons.Wand2 size={15} />}
                           <span>{data.isLoading ? `${Math.floor(progress)}%` : (hasResult ? '生成版本' : '生成')}</span>
                       </button>
                  </div>
              </div>
          </div>
        )}
      </>
    );
};
