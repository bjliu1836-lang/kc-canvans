import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InputMedia, NodeData } from '../../types';
import { Icons } from '../Icons';
import { getVisibleModels, MODEL_REGISTRY } from '../../services/geminiService';
import { GenerationFailureNotice, LocalCustomDropdown, LocalEditableTitle, LocalInputThumbnails, LocalPromptTextarea, MockResultBadge } from './Shared/LocalNodeComponents';

interface TextToAudioNodeProps {
  data: NodeData;
  updateData: (id: string, updates: Partial<NodeData>) => void;
  onGenerate: (id: string) => void;
  selected?: boolean;
  showControls?: boolean;
  inputMedia?: InputMedia[];
  onPreviewReference?: (item: InputMedia) => void;
  onDownload?: (id: string) => void;
  onUpload?: (id: string) => void;
  isDark?: boolean;
  isSelecting?: boolean;
  canvasScale?: number;
}

const clampText = (value = '') => value.slice(0, 50000);

export const TextToAudioNode: React.FC<TextToAudioNodeProps> = ({
  data,
  updateData,
  onGenerate,
  selected,
  showControls,
  inputMedia = [],
  onPreviewReference,
  onDownload,
  onUpload,
  isDark = true,
  isSelecting,
  canvasScale = 1,
}) => {
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
  const [audioModels, setAudioModels] = useState<string[]>([]);
  const isSelectedAndStable = selected && showControls && !isSelecting;
  const hasResult = Boolean(data.audioSrc) && !data.isLoading;
  const hasGenerationError = Boolean(data.errorMessage || data.generationTask?.errorMessage || data.generationTask?.status === 'needs_check');
  const generationErrorMessage = data.errorMessage || data.generationTask?.errorMessage || '提交未确认，未拿到任务编号，请核对后再生成';
  const generationErrorDetail = data.generationTask?.errorDetail || data.errorMessage;
  const prompt = data.prompt || '';
  const charCount = prompt.length;
  const versionPanelRef = useRef<HTMLDivElement>(null);
  const audioArtifacts = data.outputArtifacts || [];
  const sortedAudioArtifacts = data.audioSrc ? [data.audioSrc, ...audioArtifacts.filter(item => item !== data.audioSrc)] : audioArtifacts;
  const showVersionBadge = !!selected && !data.isStackOpen && audioArtifacts.length > 1;
  // Panel stays a constant screen size while zooming via the --panel-inverse-scale CSS var,
  // so zoom no longer re-renders the node (heavy base64 media stays off the hot path).
  const panelTransform: React.CSSProperties = {
    transform: 'translateX(-50%) scale(var(--panel-inverse-scale, 1))',
    transformOrigin: 'top center',
  };

  const updateModels = useCallback(() => {
    const models = getVisibleModels().filter(key => MODEL_REGISTRY[key]?.category === 'AUDIO');
    setAudioModels(models.length ? models : ['Minimax-speech-2.8-hd']);
  }, []);

  useEffect(() => {
    updateModels();
    window.addEventListener('modelRegistryUpdated', updateModels);
    return () => window.removeEventListener('modelRegistryUpdated', updateModels);
  }, [updateModels]);

  useEffect(() => {
    if (!data.isStackOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (versionPanelRef.current && !versionPanelRef.current.contains(event.target as Node)) {
        updateData(data.id, { isStackOpen: false });
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [data.id, data.isStackOpen, updateData]);

  useEffect(() => {
    if (!selected && data.isStackOpen) updateData(data.id, { isStackOpen: false });
  }, [selected, data.id, data.isStackOpen, updateData]);

  const voiceOptions = useMemo(() => ['male-qn-qingse', 'female-shaonv', 'male-qn-jingying'], []);
  const nodeBorder = selected
    ? (isDark ? 'border-zinc-400 ring-2 ring-zinc-400/20' : 'border-gray-500 ring-2 ring-gray-400/20')
    : (isDark ? 'border-zinc-600' : 'border-gray-300');
  const titleColor = isDark ? 'text-zinc-300' : 'text-gray-700';
  const panelBg = isDark ? 'bg-[#202020]/95 border-zinc-700 text-zinc-200' : 'bg-white/95 border-gray-200 text-gray-900 shadow-xl';
  const mutedText = isDark ? 'text-zinc-500' : 'text-gray-400';
  const inputText = isDark ? 'text-zinc-200 placeholder-zinc-500' : 'text-gray-800 placeholder-gray-400';
  return (
    <>
      <div className="absolute bottom-full left-0 mb-3 flex items-center gap-2 pointer-events-auto">
        <Icons.Music size={18} className={titleColor} />
        <LocalEditableTitle
          title={data.title || '音频节点'}
          onUpdate={(title) => updateData(data.id, { title })}
          isDark={isDark}
        />
      </div>

      <div className={`relative h-full w-full overflow-hidden rounded-xl border-[3px] ${nodeBorder} ${isDark ? 'bg-[#222]' : 'bg-white'} shadow-xl transition-colors`}>
        {hasResult ? (
          <div className="flex h-full flex-col justify-center gap-5 px-6">
            {data.resultSource === 'mock' && <MockResultBadge isDark={isDark} className="left-4 top-4" />}
            <div className="flex min-w-0 items-center gap-3">
              <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${isDark ? 'bg-[#4446CE]/20 text-[#C7C8FF]' : 'bg-[#F0F1FF] text-[#4446CE]'}`}>
                <Icons.Volume2 size={23} />
              </div>
              <div className="min-w-0">
                <div className={`text-xs font-medium ${mutedText}`}>音频播放器</div>
                <div className={`mt-0.5 truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{data.title || '音频'}</div>
              </div>
            </div>
            <audio
              src={data.audioSrc}
              controls
              preload="metadata"
              className="w-full"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            />
            <button
              className={`self-end h-8 rounded-lg px-3 text-xs font-semibold transition-all ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900'}`}
              onClick={(event) => {
                event.stopPropagation();
                onDownload?.(data.id);
              }}
            >
              下载音频
            </button>
          </div>
        ) : (
          <div className={`flex h-full flex-col justify-center px-10 ${mutedText}`}>
            {hasGenerationError ? (
              <div className="flex flex-col items-center justify-center text-center">
                <div className={`flex h-14 w-14 items-center justify-center rounded-2xl ${isDark ? 'bg-red-500/10 text-red-300' : 'bg-red-50 text-red-600'}`}>
                  <Icons.AlertTriangle size={26} />
                </div>
                <span className={`mt-3 text-sm font-semibold ${isDark ? 'text-red-200' : 'text-red-600'}`}>生成失败</span>
                <GenerationFailureNotice
                  message={generationErrorMessage}
                  detail={generationErrorDetail}
                  isDark={isDark}
                />
              </div>
            ) : (
              <>
                <div className={`absolute left-1/2 top-1/2 h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-2xl flex items-center justify-center ${isDark ? 'bg-zinc-800/50 text-zinc-500' : 'bg-gray-100 text-gray-400'}`}>
                  <Icons.Music size={26} className="opacity-60" />
                </div>
                <div className="relative z-10 mt-24 text-sm">
                  <div className="mb-3">尝试:</div>
                  <div className={`inline-flex items-center gap-2 text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-gray-800'}`}>
                    <Icons.Volume2 size={15} />
                    <span>音频生成</span>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {showVersionBadge && (
          <div
            className="absolute left-1/2 top-3 z-30 flex -translate-x-1/2 cursor-pointer select-none items-center gap-1 rounded-full border border-white/10 bg-black/30 px-2 py-1 text-[10px] text-white shadow-lg backdrop-blur-md transition-colors hover:bg-black/50"
            onClick={(event) => {
              event.stopPropagation();
              updateData(data.id, { isStackOpen: true });
            }}
          >
            <Icons.Layers size={10} className="text-[#8F91F4]" />
            <span className="font-bold">版本</span>
            <span className="font-bold tabular-nums">{audioArtifacts.length}</span>
            <Icons.ChevronRight size={10} className="text-zinc-400" />
          </div>
        )}

        {data.isStackOpen && (
          <div ref={versionPanelRef} className={`absolute left-1/2 top-12 z-[100] w-[560px] max-w-[calc(100vw-48px)] -translate-x-1/2 rounded-2xl border p-3 shadow-2xl backdrop-blur-xl ${isDark ? 'border-zinc-700 bg-[#181818]/95' : 'border-gray-200 bg-white/95'}`} onMouseDown={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <span className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>音频版本</span>
              <button
                className={`h-7 w-7 rounded-lg flex items-center justify-center ${isDark ? 'text-zinc-400 hover:bg-zinc-800 hover:text-white' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'}`}
                onClick={(event) => {
                  event.stopPropagation();
                  updateData(data.id, { isStackOpen: false });
                }}
              >
                <Icons.X size={18} />
              </button>
            </div>
            <div className="grid grid-cols-5 gap-2">
              {sortedAudioArtifacts.map((src, index) => {
                const isMain = src === data.audioSrc;
                return (
                  <div key={src + index} className={`relative aspect-square rounded-xl border p-2 ${isMain ? 'border-[#4446CE]/70 ring-1 ring-[#8F91F4]/30' : (isDark ? 'border-zinc-800' : 'border-gray-200')} ${isDark ? 'bg-zinc-950/70' : 'bg-gray-50'}`}>
                    <div className="flex h-full flex-col items-center justify-center gap-2">
                      <Icons.Volume2 size={22} className={isMain ? 'text-[#B9BAFF]' : mutedText} />
                      <span className={`text-center text-[10px] font-semibold ${isMain ? 'text-[#B9BAFF]' : mutedText}`}>{isMain ? '当前' : `版本 ${index + 1}`}</span>
                      {!isMain && (
                        <button
                          className={`h-6 rounded-md px-2 text-[10px] font-semibold ${isDark ? 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700' : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            updateData(data.id, {
                              audioSrc: src,
                              resultSource: data.artifactSources?.[src] || 'unknown',
                              generationTask: undefined,
                              isStackOpen: false,
                            });
                          }}
                        >
                          设为当前
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {data.isLoading && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/55 backdrop-blur-sm">
            <Icons.Loader2 size={32} className="mb-3 animate-spin text-[#8F91F4]" />
            <span className="text-sm font-medium text-white/85">语音生成中...</span>
          </div>
        )}
      </div>

      {isSelectedAndStable && (
        <div className="absolute top-full left-1/2 z-[70] min-w-[780px] pt-4 pointer-events-auto" style={panelTransform} onMouseDown={(event) => event.stopPropagation()}>
          {inputMedia.length > 0 && (
            <LocalInputThumbnails
              inputs={[]}
              items={inputMedia}
              ready={true}
              isDark={isDark}
              label="参考文本"
              onPreview={onPreviewReference}
            />
          )}
          <div className={`${panelBg} rounded-[22px] border p-4 flex flex-col gap-4`}>
            <LocalPromptTextarea
              className={`min-h-[124px] w-full resize-none bg-transparent text-lg leading-relaxed outline-none ${inputText}`}
              placeholder="输入要合成的文本"
              value={prompt}
              maxLength={50000}
              onChange={(value) => updateData(data.id, { prompt: clampText(value) })}
              isDark={isDark}
              expandedTitle="编辑音频文本"
            />

            <div className="flex items-center gap-3">
              <LocalCustomDropdown
                options={audioModels}
                value={data.model || 'Minimax-speech-2.8-hd'}
                onChange={(value: string) => updateData(data.id, { model: value })}
                isOpen={activeDropdown === 'model'}
                onToggle={() => setActiveDropdown(activeDropdown === 'model' ? null : 'model')}
                onClose={() => setActiveDropdown(null)}
                align="left"
                width="w-[210px]"
                isDark={isDark}
              />
              <LocalCustomDropdown
                icon={Icons.Mic}
                options={voiceOptions}
                value={data.voiceId || voiceOptions[0]}
                onChange={(value: string) => updateData(data.id, { voiceId: value })}
                isOpen={activeDropdown === 'voice'}
                onToggle={() => setActiveDropdown(activeDropdown === 'voice' ? null : 'voice')}
                onClose={() => setActiveDropdown(null)}
                align="left"
                width="w-[180px]"
                isDark={isDark}
              />
              <div className="flex-1" />
              <span className={`text-sm tabular-nums ${mutedText}`}>{charCount}/50000</span>
              <span className={`inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm font-semibold ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
                <Icons.Zap size={13} />
                {data.creditEstimate || 1}
              </span>
              <button
                className={`h-11 w-11 rounded-full flex items-center justify-center transition-all ${
                  data.isLoading || !prompt.trim()
                    ? 'bg-zinc-500 text-white cursor-not-allowed'
                    : isDark ? 'bg-zinc-200 text-zinc-950 hover:bg-white' : 'bg-gray-900 text-white hover:bg-black'
                }`}
                onClick={() => onGenerate(data.id)}
                disabled={data.isLoading || !prompt.trim()}
                title={prompt.trim() ? (hasResult ? '基于当前参数生成一个新版本' : '生成语音') : '请输入要合成的文本'}
              >
                {data.isLoading ? <Icons.Loader2 size={20} className="animate-spin" /> : <Icons.ArrowUp size={23} />}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
