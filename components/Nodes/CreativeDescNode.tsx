import React, { useEffect, useRef, useState } from 'react';
import { InputMedia, NodeData } from '../../types';
import { Icons } from '../Icons';
import { LocalCustomDropdown, LocalInputThumbnails, LocalPromptTextarea } from './Shared/LocalNodeComponents';

interface CreativeDescNodeProps {
  data: NodeData;
  updateData: (id: string, updates: Partial<NodeData>) => void;
  onGenerate: (id: string) => void;
  onAnalyzeMedia?: (id: string) => void;
  onAnalyzeScript?: (id: string) => void;
  onPreviewReference?: (item: InputMedia) => void;
  selected?: boolean;
  showControls?: boolean;
  isDark?: boolean;
  isSelecting?: boolean;
  inputMedia?: InputMedia[];
  canvasScale?: number;
}

const TEXT_MODELS = ['Xiaomi MiMo 2.5 Pro', 'Xiaomi MiMo 2.5', 'Prompt Helper'];

export const CreativeDescNode: React.FC<CreativeDescNodeProps> = ({
    data, updateData, onGenerate, onAnalyzeMedia, onAnalyzeScript, onPreviewReference, selected, showControls, isDark = true, isSelecting, inputMedia = [], canvasScale = 1
}) => {
    const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
    const [isEditingBody, setIsEditingBody] = useState(false);
    const bodyInputRef = useRef<HTMLTextAreaElement>(null);
    const historyRef = useRef<HTMLDivElement>(null);
    const isSelectedAndStable = selected && showControls && !isSelecting;
    const titleColor = isDark ? 'text-zinc-300' : 'text-gray-700';
    const containerBg = isDark ? 'bg-[#1f1f1f]' : 'bg-white';
    const border = selected
        ? (isDark ? 'border-zinc-400 ring-2 ring-zinc-400/20' : 'border-gray-500 ring-2 ring-gray-400/20')
        : (isDark ? 'border-zinc-600' : 'border-gray-300');
    const inputText = isDark ? 'text-zinc-200 placeholder-zinc-500' : 'text-gray-800 placeholder-gray-400';
    const panelBg = isDark ? 'bg-[#202020]/95 border-zinc-700 text-zinc-200' : 'bg-white/95 border-gray-200 text-gray-900 shadow-xl';
    const actionButton = isDark
        ? 'border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-white'
        : 'border-gray-200 text-gray-600 hover:bg-gray-100 hover:text-gray-900';
    const disabledButton = 'opacity-45 cursor-not-allowed hover:bg-transparent';
    const mediaInputCount = inputMedia.filter(item => item.type === 'image' || item.type === 'video').length;
    const bodyText = data.textContent ?? data.optimizedPrompt ?? '';
    const textVersions = data.textVersions || [];
    const currentVersionIndex = textVersions.findIndex(version => version.content === bodyText);
    const currentVersionNumber = currentVersionIndex >= 0 ? textVersions.length - currentVersionIndex : textVersions.length;
    const showHistoryBadge = isSelectedAndStable && !data.isStackOpen && textVersions.length > 1;
    const creditLabel = data.creditStatus === 'reserved'
        ? '已预扣'
        : data.creditStatus === 'confirmed'
            ? '已扣减'
            : data.creditStatus === 'refunded'
                ? '已返还'
                : '预计';
    // Panel stays a constant screen size while zooming via the --panel-inverse-scale CSS var,
    // so zoom no longer re-renders the node (heavy base64 media stays off the hot path).
    const panelTransform: React.CSSProperties = {
        transform: 'translateX(-50%) scale(var(--panel-inverse-scale, 1))',
        transformOrigin: 'top center',
    };

    useEffect(() => {
        if (isEditingBody) {
            bodyInputRef.current?.focus();
        }
    }, [isEditingBody]);

    useEffect(() => {
        if (!selected) {
            setIsEditingBody(false);
            if (data.isStackOpen) {
                updateData(data.id, { isStackOpen: false });
            }
        }
    }, [selected, data.isStackOpen, data.id, updateData]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (data.isStackOpen && historyRef.current && !historyRef.current.contains(event.target as Node)) {
                updateData(data.id, { isStackOpen: false });
            }
        };
        if (data.isStackOpen) document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [data.isStackOpen, data.id, updateData]);

    const sourceLabel = (source?: string) => {
        switch (source) {
            case 'media_analysis':
                return '媒体分析';
            case 'script_analysis':
                return '角色表';
            case 'upload':
                return '上传';
            default:
                return '生成';
        }
    };

    return (
        <>
            <div className="absolute bottom-full left-4 mb-3 flex items-center gap-2 pointer-events-auto">
                <Icons.FileText size={18} className={titleColor} />
                <input
                    value={data.title || 'Text'}
                    onChange={(event) => updateData(data.id, { title: event.target.value })}
                    className={`w-44 bg-transparent border-none outline-none text-lg font-semibold ${titleColor}`}
                    onMouseDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                />
            </div>

            <div className={`w-full h-full relative rounded-[32px] border-[3px] ${border} ${containerBg} shadow-xl overflow-hidden transition-colors`}>
                {isEditingBody ? (
                    <textarea
                        ref={bodyInputRef}
                        className={`w-full h-full resize-none bg-transparent px-10 py-10 text-3xl leading-relaxed outline-none no-scrollbar ${inputText}`}
                        placeholder="双击编辑输出内容..."
                        value={bodyText}
                        onChange={(event) => updateData(data.id, { textContent: event.target.value })}
                        onMouseDown={(event) => event.stopPropagation()}
                        onWheel={(event) => event.stopPropagation()}
                        onBlur={() => setIsEditingBody(false)}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                setIsEditingBody(false);
                            }
                        }}
                    />
                ) : (
                    <div
                        className={`w-full h-full px-10 py-10 text-3xl leading-relaxed whitespace-pre-wrap break-words select-none ${bodyText ? inputText : isDark ? 'text-zinc-500' : 'text-gray-400'}`}
                        onDoubleClick={(event) => {
                            event.stopPropagation();
                            setIsEditingBody(true);
                        }}
                    >
                        {bodyText || '双击编辑输出内容...'}
                    </div>
                )}

                {data.isLoading && (
                    <div className="absolute inset-0 bg-black/45 backdrop-blur-sm flex flex-col items-center justify-center z-20">
                        <Icons.Loader2 size={34} className="text-zinc-100 animate-spin mb-3" />
                        <span className="text-zinc-100 text-sm font-medium">生成中...</span>
                    </div>
                )}

                {showHistoryBadge && (
                    <button
                        type="button"
                        className="absolute bottom-4 right-4 z-[90] flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/55 px-2.5 py-1.5 text-[10px] font-semibold text-white shadow-lg backdrop-blur-md hover:bg-black/75"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            updateData(data.id, { isStackOpen: true });
                        }}
                    >
                        <Icons.Clock size={12} />
                        <span>历史版本</span>
                        <span className="text-zinc-300">{textVersions.length}</span>
                        <Icons.ChevronRight size={11} className="text-zinc-400" />
                    </button>
                )}

                {data.isStackOpen && textVersions.length > 0 && (
                    <div
                        ref={historyRef}
                        className={`history-version-drawer absolute left-[calc(100%+16px)] top-0 z-[120] flex w-[420px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-2xl border shadow-2xl backdrop-blur-xl ${isDark ? 'border-zinc-700 bg-[#181818]/97 text-zinc-100' : 'border-gray-200 bg-white/97 text-gray-900'}`}
                        style={{ height: Math.max(440, data.height) }}
                        data-canvas-wheel-pass-through="true"
                        onMouseDown={(event) => event.stopPropagation()}
                        onWheelCapture={(event) => event.stopPropagation()}
                    >
                        <div className={`flex items-start justify-between border-b px-4 py-4 ${isDark ? 'border-zinc-800' : 'border-gray-100'}`}>
                            <div>
                                <div className="text-sm font-semibold">历史版本</div>
                                <div className={`mt-1 text-[11px] ${isDark ? 'text-zinc-500' : 'text-gray-400'}`}>
                                    当前 V{currentVersionNumber || textVersions.length}
                                </div>
                            </div>
                            <button
                                type="button"
                                className={`flex h-8 w-8 items-center justify-center rounded-lg ${isDark ? 'text-zinc-400 hover:bg-zinc-800 hover:text-white' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'}`}
                                title="关闭历史版本"
                                aria-label="关闭历史版本"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    updateData(data.id, { isStackOpen: false });
                                }}
                            >
                                <Icons.X size={17} />
                            </button>
                        </div>
                        <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
                            {textVersions.map((version, index) => {
                                const versionNumber = textVersions.length - index;
                                const isCurrent = version.content === bodyText;
                                return (
                                    <div
                                        key={`${version.createdAt}-${index}`}
                                        className={`rounded-xl border p-3 transition-colors ${isCurrent
                                            ? (isDark ? 'border-[#8F91F4]/50 bg-[#4446CE]/12' : 'border-[#C7C8FF] bg-[#F0F1FF]')
                                            : (isDark ? 'border-zinc-800 bg-black/20 hover:border-zinc-700 hover:bg-white/[0.04]' : 'border-gray-200 bg-gray-50/70 hover:border-gray-300 hover:bg-white')
                                        }`}
                                    >
                                        <div className="mb-2 flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-2">
                                                <span className="rounded-full border border-white/15 bg-black/55 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur-md">
                                                    V{versionNumber}
                                                </span>
                                                <span className={`text-[11px] ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
                                                    {sourceLabel(version.source)}
                                                </span>
                                            </div>
                                            <span className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-gray-400'}`}>
                                                {new Date(version.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        </div>
                                        <div className={`max-h-28 overflow-hidden whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs leading-relaxed ${isDark ? 'border-zinc-800 bg-zinc-950/60 text-zinc-300' : 'border-gray-200 bg-white text-gray-700'}`}>
                                            {version.content}
                                        </div>
                                        <div className="mt-3 flex items-center justify-end">
                                            {isCurrent ? (
                                                <span className={`text-[11px] font-semibold ${isDark ? 'text-[#B9BAFF]' : 'text-[#3739B0]'}`}>当前版本</span>
                                            ) : (
                                                <button
                                                    type="button"
                                                    className="h-8 rounded-lg bg-[#4446CE] px-3.5 text-[11px] font-semibold text-white shadow-lg hover:bg-[#5557DB]"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        updateData(data.id, {
                                                            textContent: version.content,
                                                            optimizedPrompt: version.content,
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
            </div>

            {isSelectedAndStable && (
                <div className="absolute top-full left-1/2 min-w-[760px] pt-7 z-[70] pointer-events-auto" style={panelTransform} onMouseDown={(event) => event.stopPropagation()}>
                    {inputMedia.length > 0 && <LocalInputThumbnails inputs={[]} items={inputMedia} ready={true} isDark={isDark} label="参考内容" onPreview={onPreviewReference} />}
                    <div className={`${panelBg} rounded-[22px] border p-4 flex flex-col gap-4`}>
                        <LocalPromptTextarea
                            className={`w-full min-h-[96px] resize-none bg-transparent text-base leading-relaxed outline-none ${inputText}`}
                            placeholder="输入生成或分析指令"
                            value={data.prompt || ''}
                            onChange={(value) => updateData(data.id, { prompt: value })}
                            isDark={isDark}
                            expandedTitle="编辑创意描述"
                        />
                        <div className="flex items-center gap-3">
                            <LocalCustomDropdown
                                options={TEXT_MODELS}
                                value={data.model || TEXT_MODELS[0]}
                                onChange={(value: string) => updateData(data.id, { model: value })}
                                isOpen={activeDropdown === 'model'}
                                onToggle={() => setActiveDropdown(activeDropdown === 'model' ? null : 'model')}
                                onClose={() => setActiveDropdown(null)}
                                align="left"
                                width="w-[190px]"
                                isDark={isDark}
                            />
                            <button
                                onClick={() => onAnalyzeMedia?.(data.id)}
                                disabled={data.isLoading || mediaInputCount === 0}
                                className={`h-8 px-3 rounded-lg border text-xs font-medium flex items-center gap-2 transition-colors ${actionButton} ${mediaInputCount === 0 ? disabledButton : ''}`}
                                title={mediaInputCount === 0 ? '连接图片或视频节点后可分析' : '分析前置图片/视频并生成复刻提示词或分镜表'}
                            >
                                <Icons.Scan size={14} />
                                媒体分析
                            </button>
                            <button
                                onClick={() => onAnalyzeScript?.(data.id)}
                                disabled={data.isLoading || !data.prompt?.trim()}
                                className={`h-8 px-3 rounded-lg border text-xs font-medium flex items-center gap-2 transition-colors ${actionButton} ${!data.prompt?.trim() ? disabledButton : ''}`}
                                title="基于剧本生成角色资产表"
                            >
                                <Icons.BookOpen size={14} />
                                角色表
                            </button>
                            <div className="flex-1" />
                            <div className={`hidden sm:flex h-8 items-center rounded-lg border px-2.5 text-[11px] font-semibold whitespace-nowrap ${
                                data.creditStatus === 'confirmed'
                                    ? (isDark ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300' : 'border-emerald-100 bg-emerald-50 text-emerald-700')
                                    : data.creditStatus === 'reserved'
                                        ? (isDark ? 'border-[#4446CE]/20 bg-[#4446CE]/10 text-[#B9BAFF]' : 'border-[#E1E3FF] bg-[#F0F1FF] text-[#3739B0]')
                                        : data.creditStatus === 'refunded'
                                            ? (isDark ? 'border-zinc-700 bg-zinc-800 text-zinc-300' : 'border-gray-200 bg-gray-50 text-gray-600')
                                            : (isDark ? 'border-zinc-700 bg-zinc-900/60 text-zinc-400' : 'border-gray-200 bg-gray-50 text-gray-500')
                            }`}>
                                {data.creditEstimate || 1}分
                            </div>
                            <button
                                className={`w-8 h-8 rounded-lg flex items-center justify-center ${isDark ? 'text-zinc-300 hover:bg-zinc-800' : 'text-gray-500 hover:bg-gray-100'}`}
                                title="语音输入"
                            >
                                <Icons.Mic size={16} />
                            </button>
                            <div className={`w-px h-6 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />
                            <LocalCustomDropdown
                                options={[1, 2, 3, 4]}
                                value={data.count || 1}
                                onChange={(value: number) => updateData(data.id, { count: value })}
                                isOpen={activeDropdown === 'count'}
                                onToggle={() => setActiveDropdown(activeDropdown === 'count' ? null : 'count')}
                                onClose={() => setActiveDropdown(null)}
                                icon={Icons.Layers}
                                isDark={isDark}
                            />
                            <button
                                onClick={() => onGenerate(data.id)}
                                disabled={data.isLoading}
                                className={`h-10 w-10 rounded-full flex items-center justify-center transition-all ${
                                    data.isLoading
                                        ? 'bg-zinc-500 text-white cursor-wait'
                                        : isDark ? 'bg-zinc-200 text-zinc-900 hover:bg-white' : 'bg-gray-900 text-white hover:bg-black'
                                }`}
                                title="生成"
                            >
                                {data.isLoading ? <Icons.Loader2 size={18} className="animate-spin" /> : <Icons.ArrowUp size={20} />}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
