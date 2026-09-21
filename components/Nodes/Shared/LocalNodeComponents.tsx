
import React, { useState, useEffect, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '../../Icons';
import { ImageVersionSnapshot, InputMedia, NodeData, NodeType } from '../../../types';
import { getErrorDetail } from '../../../services/errorUtils';

// --- Local Components (Extracted) ---

export const LocalEditableTitle: React.FC<{ title: string; onUpdate: (newTitle: string) => void, isDark?: boolean }> = ({ title, onUpdate, isDark = true }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [editValue, setEditValue] = useState(title);
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => { if (isEditing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, [isEditing]);
    useEffect(() => { if (!isEditing) setEditValue(title); }, [title, isEditing]);
    const handleBlur = () => { setIsEditing(false); if (editValue.trim() && editValue !== title) onUpdate(editValue.trim().slice(0, 20)); else setEditValue(title); };

    return isEditing ? (
        <input 
            ref={inputRef} 
            type="text" 
            value={editValue} 
            onChange={(e) => setEditValue(e.target.value)} 
            onBlur={handleBlur} 
            onKeyDown={(e) => { if (e.key === 'Enter') handleBlur(); if (e.key === 'Escape') { setEditValue(title); setIsEditing(false); } }} 
            className={`bg-black/60 backdrop-blur-md text-white border border-white/20 rounded-lg px-3 py-1.5 outline-none w-[160px] text-sm font-semibold focus:border-white/40`} 
            onClick={(e) => e.stopPropagation()} 
            onMouseDown={(e) => e.stopPropagation()} 
        />
    ) : (
        <div 
            className="bg-black/40 backdrop-blur-md text-white font-semibold text-sm px-3 py-1.5 rounded-lg cursor-text border border-transparent hover:border-white/20 truncate max-w-[160px] transition-all" 
            onDoubleClick={(e) => { e.stopPropagation(); setIsEditing(true); setEditValue(title); }} 
            onMouseDown={(e) => e.stopPropagation()} 
            title={title}
        >
            {title}
        </div>
    );
};

export const LocalCustomDropdown = ({ options, value, onChange, isOpen, onToggle, onClose, icon: Icon, width = "w-max", align = "center", disabledOptions = [], isDark = true }: any) => {
    const ref = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);
    const [flyoutTop, setFlyoutTop] = useState<number>(0);
    const hoverTimeout = useRef<any>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) onClose(); };
        if (isOpen) document.addEventListener('mousedown', handleClickOutside, true);
        return () => document.removeEventListener('mousedown', handleClickOutside, true);
    }, [isOpen, onClose]);

    useEffect(() => { if (!isOpen) { setHoveredGroup(null); } }, [isOpen]);

    const handleMouseEnterGroup = (label: string, e: React.MouseEvent) => {
        if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
        if (listRef.current) {
            const listRect = listRef.current.getBoundingClientRect();
            const itemRect = e.currentTarget.getBoundingClientRect();
            setFlyoutTop(itemRect.top - listRect.top);
        }
        setHoveredGroup(label);
    };

    const handleMouseLeave = () => {
        hoverTimeout.current = setTimeout(() => setHoveredGroup(null), 200);
    };

    const handleMouseEnterFlyout = () => {
        if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    };

    const bgClass = isDark ? 'bg-[#1a1a1a] border-zinc-700' : 'bg-white border-gray-200 shadow-xl';
    const hoverClass = isDark ? 'hover:bg-zinc-700' : 'hover:bg-gray-100';
    const iconColor = isDark ? 'text-zinc-400 group-hover:text-white' : 'text-gray-500 group-hover:text-gray-700';
    const optionHover = isDark ? 'hover:bg-zinc-700 hover:text-white' : 'hover:bg-gray-100 hover:text-gray-900';
    const activeItem = isDark ? 'bg-[#4446CE]/15 text-[#8F91F4]' : 'bg-[#F0F1FF] text-[#4446CE]';
    const flyoutBg = isDark ? 'bg-[#1a1a1a] border-zinc-700' : 'bg-white border-gray-200 shadow-xl';

    const activeGroupItems = hoveredGroup ? (options.find((o: any) => typeof o === 'object' && o.label === hoveredGroup)?.items || []) : [];

    return (
        <div className="relative flex items-center" ref={ref}>
            {/* Trigger Button */}
            <button 
                className={`flex items-center gap-2 cursor-pointer group h-8 px-3 rounded-lg border transition-all ${
                    isOpen 
                        ? (isDark ? 'bg-zinc-700 border-zinc-600' : 'bg-gray-100 border-gray-300') 
                        : (isDark ? 'border-zinc-700 hover:border-zinc-600' : 'border-gray-200 hover:border-gray-300')
                } ${hoverClass}`} 
                onClick={(e) => { e.stopPropagation(); onToggle(); }}
            >
                {Icon && <Icon size={15} className={`transition-colors ${isOpen ? (isDark ? 'text-[#8F91F4]' : 'text-[#4446CE]') : iconColor}`} />}
                <span className={`text-xs font-medium transition-colors select-none ${
                    isOpen 
                        ? (isDark ? 'text-white' : 'text-gray-900') 
                        : (isDark ? 'text-zinc-300 group-hover:text-white' : 'text-gray-600 group-hover:text-gray-900')
                } ${Icon ? 'min-w-[20px] text-center' : 'max-w-[90px] truncate'}`}>
                    {value}
                </span>
                {!Icon && <Icons.ChevronRight size={12} className={`transition-all duration-200 ${isOpen ? 'rotate-[-90deg] text-[#8F91F4]' : `rotate-90 ${isDark ? 'text-zinc-500' : 'text-gray-400'}`}`} />}
            </button>

            {/* Main Dropdown Body */}
            {isOpen && (
                <div className={`absolute bottom-full mb-2 ${align === 'left' ? 'left-0' : align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2'} ${width} min-w-[130px] ${bgClass} border rounded-xl shadow-2xl py-1.5 z-[100] animate-in fade-in slide-in-from-bottom-2 duration-150 overflow-visible`} onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
                    
                    <div ref={listRef} className="max-h-[300px] overflow-y-auto custom-scrollbar px-1.5">
                        {options.map((opt: any) => {
                            const isGroup = typeof opt === 'object';
                            const label = isGroup ? opt.label : opt;
                            const isDisabled = !isGroup && disabledOptions.includes(label);
                            const isSelected = !isGroup && label === value;
                            const isGroupHovered = isGroup && hoveredGroup === label;
                            const containsSelection = isGroup && opt.items.includes(value);
                            
                            return (
                                <div 
                                    key={label}
                                    className={`relative px-3 py-2 text-xs font-medium rounded-lg transition-colors flex items-center justify-between cursor-pointer mb-0.5
                                        ${isDisabled 
                                            ? 'text-zinc-600 cursor-not-allowed opacity-50' 
                                            : (isSelected || (isGroup && isGroupHovered)
                                                ? activeItem 
                                                : (containsSelection 
                                                    ? (isDark ? 'text-[#8F91F4]' : 'text-[#4446CE]') + ` ${optionHover}`
                                                    : (isDark ? 'text-zinc-300' : 'text-gray-600') + ` ${optionHover}`
                                                  )
                                            )
                                        }
                                    `}
                                    onMouseEnter={(e) => isGroup ? handleMouseEnterGroup(label, e) : setHoveredGroup(null)}
                                    onMouseLeave={handleMouseLeave}
                                    onClick={(e) => { 
                                        e.stopPropagation(); 
                                        if (!isGroup && !isDisabled) { onChange(label); onClose(); }
                                    }}
                                >
                                    <span className="whitespace-nowrap pr-2">{label}</span>
                                    {isSelected && <Icons.Check size={12} className="text-[#8F91F4] shrink-0 ml-2" />}
                                    {isGroup && <Icons.ChevronRight size={12} className={`shrink-0 ml-2 ${isGroupHovered ? 'text-[#8F91F4]' : (isDark ? 'text-zinc-500' : 'text-gray-400')}`} />}
                                </div>
                            );
                        })}
                    </div>

                    {/* Flyout Menu */}
                    {hoveredGroup && activeGroupItems.length > 0 && (
                        <div 
                            className={`absolute left-full ml-2 w-[150px] ${flyoutBg} border rounded-xl shadow-2xl py-1.5 z-[110] animate-in fade-in slide-in-from-left-2 duration-150 before:absolute before:-left-4 before:top-0 before:h-full before:w-4 before:bg-transparent`}
                            style={{ top: flyoutTop }}
                            onMouseEnter={handleMouseEnterFlyout}
                            onMouseLeave={handleMouseLeave}
                        >
                            <div className="max-h-[250px] overflow-y-auto custom-scrollbar px-1.5">
                                {activeGroupItems.map((subItem: string) => {
                                    const isSubSelected = subItem === value;
                                    return (
                                        <div 
                                            key={subItem}
                                            className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors flex items-center justify-between cursor-pointer mb-0.5
                                                ${isSubSelected ? activeItem : optionHover}
                                                ${!isSubSelected && isDark ? 'text-zinc-300' : ''} 
                                            `}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onChange(subItem);
                                                onClose();
                                            }}
                                        >
                                            <span className="truncate">{subItem}</span>
                                            {isSubSelected && <Icons.Check size={12} className="text-[#8F91F4] shrink-0 ml-2" />}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

const useWheelScrollableTextarea = (ref: React.RefObject<HTMLTextAreaElement>) => {
    useEffect(() => {
        const el = ref.current;
        if (!el) return;

        const handleWheel = (event: WheelEvent) => {
            event.stopPropagation();

            if (document.activeElement !== el) return;

            const maxScrollTop = el.scrollHeight - el.clientHeight;
            if (maxScrollTop <= 0) return;

            event.preventDefault();
            const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
            el.scrollTop = Math.max(0, Math.min(maxScrollTop, el.scrollTop + delta));
        };

        el.addEventListener('wheel', handleWheel, { passive: false });
        return () => el.removeEventListener('wheel', handleWheel);
    }, [ref]);
};

export const LocalPromptTextarea: React.FC<{
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    className?: string;
    isDark?: boolean;
    maxLength?: number;
    expandedTitle?: string;
}> = ({
    value,
    onChange,
    placeholder,
    className = '',
    isDark = true,
    maxLength,
    expandedTitle = '编辑提示词',
}) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const compactRef = useRef<HTMLTextAreaElement>(null);
    const expandedRef = useRef<HTMLTextAreaElement>(null);

    useWheelScrollableTextarea(compactRef);
    useWheelScrollableTextarea(expandedRef);

    useEffect(() => {
        if (!isExpanded) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsExpanded(false);
        };
        window.addEventListener('keydown', handleKeyDown);
        const timer = window.setTimeout(() => expandedRef.current?.focus(), 0);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.clearTimeout(timer);
        };
    }, [isExpanded]);

    const stopCanvasInteraction = (event: React.SyntheticEvent) => event.stopPropagation();
    const modalBg = isDark ? 'bg-[#1b1b1b] border-zinc-700 text-zinc-100' : 'bg-white border-gray-200 text-gray-900';
    const modalTextarea = isDark
        ? 'bg-zinc-950/70 border-zinc-700 text-zinc-100 placeholder-zinc-500 focus:border-[#4446CE]/60'
        : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-[#8F91F4]';
    const iconButton = isDark
        ? 'bg-zinc-800/90 text-zinc-400 hover:text-white hover:bg-zinc-700 border-zinc-700'
        : 'bg-white/90 text-gray-500 hover:text-gray-900 hover:bg-gray-100 border-gray-200';

    return (
        <>
            <div className="relative" data-canvas-wheel-pass-through="true">
                <textarea
                    ref={compactRef}
                    className={`${className} pr-10 overflow-y-auto`}
                    placeholder={placeholder}
                    value={value}
                    maxLength={maxLength}
                    onChange={(event) => onChange(event.target.value)}
                    onMouseDown={stopCanvasInteraction}
                    onClick={stopCanvasInteraction}
                    onWheelCapture={stopCanvasInteraction}
                />
                <button
                    type="button"
                    className={`absolute right-2 top-2 h-6 w-6 rounded-md border flex items-center justify-center transition-colors ${iconButton}`}
                    title="展开编辑"
                    onMouseDown={stopCanvasInteraction}
                    onClick={(event) => {
                        event.stopPropagation();
                        setIsExpanded(true);
                    }}
                >
                    <Icons.Maximize2 size={12} />
                </button>
            </div>
            {isExpanded && createPortal(
                <div
                    className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
                    data-canvas-wheel-pass-through="true"
                    onMouseDown={(event) => {
                        event.stopPropagation();
                        setIsExpanded(false);
                    }}
                    onWheelCapture={stopCanvasInteraction}
                >
                    <div
                        className={`flex h-[min(640px,calc(100vh-48px))] w-[min(920px,calc(100vw-48px))] flex-col rounded-2xl border shadow-2xl ${modalBg}`}
                        onMouseDown={stopCanvasInteraction}
                        onClick={stopCanvasInteraction}
                    >
                        <div className={`flex h-12 shrink-0 items-center justify-between border-b px-4 ${isDark ? 'border-zinc-800' : 'border-gray-200'}`}>
                            <span className="text-sm font-semibold">{expandedTitle}</span>
                            <button
                                type="button"
                                className={`h-8 w-8 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'text-zinc-400 hover:bg-zinc-800 hover:text-white' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'}`}
                                title="关闭"
                                onClick={() => setIsExpanded(false)}
                            >
                                <Icons.X size={16} />
                            </button>
                        </div>
                        <textarea
                            ref={expandedRef}
                            className={`m-4 flex-1 resize-none rounded-xl border p-4 text-base leading-relaxed outline-none transition-colors overflow-y-auto custom-scrollbar ${modalTextarea}`}
                            placeholder={placeholder}
                            value={value}
                            maxLength={maxLength}
                            onChange={(event) => onChange(event.target.value)}
                            onWheelCapture={stopCanvasInteraction}
                        />
                    </div>
                </div>,
                document.body
            )}
        </>
    );
};

export const LocalThumbnailItem = memo(({ item, index, isDark, onPreview }: { item: InputMedia, index: number, isDark: boolean, onPreview?: (item: InputMedia) => void }) => {
    const [loaded, setLoaded] = useState(false);
    const src = item.url;
    return (
        <button
            type="button"
            className={`relative w-[48px] h-[48px] flex-shrink-0 border rounded-lg overflow-hidden shadow-sm group/thumb cursor-pointer hover:border-[#4446CE]/70 transition-colors ${isDark ? 'border-zinc-700 bg-black/40' : 'border-gray-300 bg-gray-100'}`}
            onClick={(event) => {
                event.stopPropagation();
                onPreview?.(item);
            }}
            title="查看参考内容"
        >
            <div className={`absolute inset-0 ${isDark ? 'bg-zinc-800/50' : 'bg-gray-200'}`} />
            {item.type === 'video' ? (
                <>
                    <video src={src} className="absolute inset-0 w-full h-full object-cover" muted playsInline preload="metadata" />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                        <Icons.Play size={16} className="text-white drop-shadow" fill="currentColor" />
                    </div>
                </>
            ) : item.type === 'audio' ? (
                <div className={`absolute inset-0 flex flex-col items-center justify-center px-1 ${isDark ? 'text-violet-300' : 'text-violet-700'}`}>
                    <Icons.Music size={17} />
                    <span className="mt-0.5 max-w-full truncate text-[8px]">{item.title || '音频'}</span>
                </div>
            ) : item.type === 'text' ? (
                <div className={`absolute inset-0 flex flex-col items-center justify-center px-1 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`}>
                    <Icons.FileText size={16} />
                    <span className="mt-0.5 max-w-full truncate text-[8px]">{item.title || 'Text'}</span>
                </div>
            ) : (
                <img src={src} className="absolute inset-0 w-full h-full object-cover will-change-[clip-path]" draggable={false} decoding="async" loading="lazy" onLoad={() => setLoaded(true)} style={{ clipPath: loaded ? 'inset(0 0 0% 0)' : 'inset(0 0 100% 0)', opacity: loaded ? 1 : 0, transition: 'clip-path 0.8s ease-out, opacity 0.3s ease-in' }} />
            )}
            <div className="absolute inset-0 bg-black/0 group-hover/thumb:bg-black/20 transition-colors" />
            <Icons.Maximize2 size={12} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white opacity-0 group-hover/thumb:opacity-100 transition-opacity drop-shadow" />
            <div className="absolute top-0 right-0 bg-black/60 backdrop-blur-sm text-white text-[9px] font-bold px-1.5 rounded-bl z-10">{index + 1}</div>
        </button>
    );
});

export const LocalInputThumbnails = memo(({ inputs, items, ready, isDark, label, onPreview }: { inputs: string[], items?: InputMedia[], ready: boolean, isDark: boolean, label?: string, onPreview?: (item: InputMedia) => void }) => {
    const displayItems = items?.length ? items : inputs.map(url => ({ type: 'image' as const, url }));
    if (!displayItems || displayItems.length === 0) return null;
    const labelColor = isDark ? 'text-zinc-500' : 'text-gray-400';
    return (
       <div className="flex flex-col items-center gap-1 pb-2">
           {label && <span className={`text-[9px] font-bold uppercase ${labelColor}`}>{label}</span>}
           <div className="flex justify-center gap-2 overflow-x-auto no-scrollbar min-h-[48px]">
               {displayItems.slice(0, 8).map((item, i) => (
                   ready ? <LocalThumbnailItem key={(item.url || item.text || '') + i} item={item} index={i} isDark={isDark} onPreview={onPreview} /> : <div key={i} className={`relative w-[48px] h-[48px] flex-shrink-0 border rounded-lg overflow-hidden shadow-sm ${isDark ? 'border-zinc-700 bg-black/40' : 'border-gray-300 bg-gray-100'}`}><div className={`absolute inset-0 ${isDark ? 'bg-zinc-800/50' : 'bg-gray-200'}`} /></div>
               ))}
           </div>
       </div>
    );
});

export const VideoPreview = ({ src, isDark }: { src: string, isDark: boolean }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [isPlaying, setIsPlaying] = useState(true);
    const togglePlay = (e: React.MouseEvent) => { e.stopPropagation(); const v = videoRef.current; if (v) { if (v.paused) { v.play(); setIsPlaying(true); } else { v.pause(); setIsPlaying(false); } } };
    return (
        <div className="relative w-full h-full group/video">
            <video ref={videoRef} src={src} className="w-full h-full object-cover pointer-events-none" loop muted autoPlay playsInline draggable={false} />
            <div className="absolute bottom-3 left-3 z-30 pointer-events-auto opacity-0 group-hover/video:opacity-100 transition-opacity">
                <button onClick={togglePlay} className={`w-8 h-8 rounded-full flex items-center justify-center backdrop-blur-md border transition-all shadow-sm ${isDark ? 'bg-black/60 border-white/10 text-white hover:bg-black/80 hover:scale-110' : 'bg-white/60 border-black/10 text-black hover:bg-white/80 hover:scale-110'}`}>
                    {isPlaying ? <Icons.Pause size={14} fill="currentColor" /> : <Icons.Play size={14} fill="currentColor" className="ml-0.5" />}
                </button>
            </div>
        </div>
    );
};

export const safeDownload = async (src: string) => {
    try {
      const isVideo = /\.(mp4|webm|mov|mkv)(\?|$)/i.test(src);
      const response = await fetch(src);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); 
      link.href = url; 
      link.download = `download_${Date.now()}.${isVideo ? 'mp4' : 'png'}`;
      document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url);
    } catch (e) {
      const link = document.createElement('a'); link.href = src; link.download = `download_${Date.now()}`; link.target = "_blank"; document.body.appendChild(link); link.click(); document.body.removeChild(link);
  }
};

const copyTextToClipboard = async (text: string) => {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
};

export const MockResultBadge: React.FC<{ isDark?: boolean; className?: string }> = ({ isDark = true, className = '' }) => (
    <span className={`pointer-events-none absolute left-3 top-3 z-[95] inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-semibold shadow-lg backdrop-blur-md ${isDark ? 'border-amber-300/25 bg-amber-500/20 text-amber-100' : 'border-amber-300 bg-amber-50 text-amber-700'} ${className}`}>
        模拟结果
    </span>
);

export const GenerationFailureNotice: React.FC<{
    message?: string;
    detail?: string;
    isDark?: boolean;
}> = ({ message = '生成失败，请查看原始报错', detail, isDark = true }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = async (event: React.MouseEvent) => {
        event.stopPropagation();
        if (!detail) return;
        try {
            await copyTextToClipboard(getErrorDetail(detail));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
        } catch (error) {
            console.error('Failed to copy generation error', error);
        }
    };

    return (
        <div className="mt-2 flex max-w-[82%] flex-col items-center gap-1.5 text-center">
            <span className={`line-clamp-2 text-xs leading-5 ${isDark ? 'text-red-200/80' : 'text-red-600/80'}`}>{message}</span>
            {detail && (
                <button
                    type="button"
                    className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[10px] font-semibold transition-colors ${isDark ? 'border-zinc-700 bg-zinc-900/70 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 hover:text-white' : 'border-gray-200 bg-white/80 text-gray-600 hover:bg-gray-100 hover:text-gray-900'}`}
                    aria-label="复制错误详情"
                    onClick={handleCopy}
                >
                    <Icons.Copy size={12} />
                    {copied ? '已复制' : '复制错误详情'}
                </button>
            )}
        </div>
    );
};

export const LocalMediaStack: React.FC<{
    data: NodeData,
    updateData: any,
    currentSrc: string | undefined,
    onMaximize?: any,
    isDark?: boolean,
    selected?: boolean,
    onToggleFavorite?: (src: string, type: 'image' | 'video') => void,
    isFavorite?: (src: string) => boolean,
    onPreviewMedia?: (src: string, type: 'image' | 'video') => void,
    onSetImageVersion?: (nodeId: string, version: ImageVersionSnapshot) => void,
    onSetVideoVersion?: (nodeId: string, src: string) => void,
    onUseImageVersion?: (nodeId: string, version: ImageVersionSnapshot) => void,
    onUseVideoVersion?: (nodeId: string, src: string) => void,
}> = ({
    data, updateData, currentSrc, isDark = true, selected, onPreviewMedia, onSetImageVersion, onSetVideoVersion, onUseImageVersion, onUseVideoVersion
}) => {
    const stackRef = useRef<HTMLDivElement>(null);
    const [hoveredBatchKey, setHoveredBatchKey] = useState<string | null>(null);
    const [batchImageIndexes, setBatchImageIndexes] = useState<Record<string, number>>({});
    const [imageNaturalRatios, setImageNaturalRatios] = useState<Record<string, string>>({});
    const artifacts = data.outputArtifacts || [];
    const sortedArtifacts = currentSrc ? [currentSrc, ...artifacts.filter(a => a !== currentSrc)] : artifacts;
    const isImageHistory = data.type === NodeType.TEXT_TO_IMAGE;
    const isVideoHistory = data.type === NodeType.TEXT_TO_VIDEO || data.type === NodeType.IMAGE_TO_VIDEO || data.type === NodeType.START_END_TO_VIDEO;
    const imageVersionUrls = artifacts.length > 0 ? artifacts : (currentSrc ? [currentSrc] : []);
    const showBadge = !!selected && !data.isStackOpen && artifacts.length > 1;
    const snapshotByUrl = new Map<string, ImageVersionSnapshot>(
        (data.imageVersions || []).map(version => [version.url, version])
    );

    const getImageVersion = (url: string): ImageVersionSnapshot => snapshotByUrl.get(url) || {
        url,
        prompt: data.prompt || '',
        model: data.model || 'Seedream 5.0',
        aspectRatio: imageNaturalRatios[url] || data.aspectRatio || '1:1',
        resolution: data.resolution || '1k',
        count: data.count || 1,
        promptOptimize: !!data.promptOptimize,
        createdAt: 0,
    };
    const withNaturalRatio = (version: ImageVersionSnapshot): ImageVersionSnapshot => ({
        ...version,
        aspectRatio: imageNaturalRatios[version.url] || version.aspectRatio,
    });

    const closeStack = () => {
        setHoveredBatchKey(null);
        updateData(data.id, { isStackOpen: false });
    };

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Element;
            if (target.closest?.('[data-media-preview-overlay]')) return;
            if (data.isStackOpen && stackRef.current && !stackRef.current.contains(event.target as Node)) {
                setHoveredBatchKey(null);
                updateData(data.id, { isStackOpen: false });
            }
        };
        if (data.isStackOpen) document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [data.isStackOpen, data.id, updateData]);

    useEffect(() => {
        if (!selected && data.isStackOpen) {
            setHoveredBatchKey(null);
            updateData(data.id, { isStackOpen: false });
        }
    }, [selected, data.isStackOpen, data.id, updateData]);

    if (isImageHistory) {
        const imageUrlSet = new Set(imageVersionUrls);
        const imageHistoryBatches = imageVersionUrls.reduce<Array<{ key: string; urls: string[] }>>((batches, url) => {
            const version = getImageVersion(url);
            const key = version.batchId || `single:${url}`;
            if (batches.some(batch => batch.key === key)) return batches;
            const urls = Array.from(new Set((version.batchUrls?.length ? version.batchUrls : [url])
                .filter(batchUrl => batchUrl && (imageUrlSet.has(batchUrl) || batchUrl === currentSrc))));
            batches.push({ key, urls: urls.length ? urls : [url] });
            return batches;
        }, []).filter(batch => batch.urls.some(url => url !== currentSrc) || batch.urls.length > 1);
        const drawerWidth = 420;
        const drawerHeight = typeof window === 'undefined'
            ? Math.max(520, data.height)
            : Math.min(Math.max(520, data.height), window.innerHeight - 48);
        const displaySrc = currentSrc;
        const imageShowBadge = !!selected && !data.isStackOpen && imageHistoryBatches.length > 0;
        const shiftBatchImage = (batchKey: string, total: number, direction: -1 | 1) => {
            setBatchImageIndexes(prev => {
                const current = prev[batchKey] || 0;
                return { ...prev, [batchKey]: (current + direction + total) % total };
            });
        };
        const recordNaturalRatio = (url: string, image: HTMLImageElement) => {
            if (!image.naturalWidth || !image.naturalHeight) return;
            const ratio = `${image.naturalWidth}:${image.naturalHeight}`;
            setImageNaturalRatios(prev => prev[url] === ratio ? prev : { ...prev, [url]: ratio });
        };
        return (
            <>
                {displaySrc && (
                    <img
                        src={displaySrc}
                        className={`h-full w-full object-contain pointer-events-none ${isDark ? 'bg-[#09090b]' : 'bg-gray-50'}`}
                        alt="Generated"
                        draggable={false}
                    />
                )}
                {data.resultSource === 'mock' && <MockResultBadge isDark={isDark} />}
                {imageShowBadge && (
                    <button
                        type="button"
                        className="absolute bottom-3 right-3 z-[90] flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/55 px-2.5 py-1.5 text-[10px] font-semibold text-white shadow-lg backdrop-blur-md hover:bg-black/75"
                        onClick={(event) => {
                            event.stopPropagation();
                            updateData(data.id, { isStackOpen: true });
                        }}
                    >
                        <Icons.Clock size={12} />
                        <span>历史记录</span>
                        <span className="text-zinc-300">{imageHistoryBatches.length}</span>
                        <Icons.ChevronRight size={11} className="text-zinc-400" />
                    </button>
                )}
                {data.isStackOpen && (
                    <div
                        ref={stackRef}
                        className={`history-version-drawer absolute left-[calc(100%+16px)] top-0 z-[120] flex max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-2xl border shadow-2xl backdrop-blur-xl ${isDark ? 'border-zinc-700 bg-[#181818]/97 text-zinc-100' : 'border-gray-200 bg-white/97 text-gray-900'}`}
                        style={{
                            width: `min(${drawerWidth}px, calc(100vw - 48px))`,
                            height: `${drawerHeight}px`,
                        }}
                        data-canvas-wheel-pass-through="true"
                        onMouseDown={(event) => event.stopPropagation()}
                        onWheelCapture={(event) => event.stopPropagation()}
                        onMouseLeave={() => setHoveredBatchKey(null)}
                    >
                        <div className={`flex items-start justify-between border-b px-4 py-4 ${isDark ? 'border-zinc-800' : 'border-gray-100'}`}>
                            <div>
                                <div className="text-sm font-semibold">历史版本</div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    className={`h-8 rounded-lg px-3 text-xs font-semibold transition-colors ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900'}`}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        closeStack();
                                    }}
                                >
                                    收起
                                </button>
                                <button
                                    type="button"
                                    className={`flex h-8 w-8 items-center justify-center rounded-lg ${isDark ? 'text-zinc-400 hover:bg-zinc-800 hover:text-white' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'}`}
                                    title="关闭历史记录"
                                    aria-label="关闭历史记录"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        closeStack();
                                    }}
                                >
                                    <Icons.X size={17} />
                                </button>
                            </div>
                        </div>
                        <div className="custom-scrollbar flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
                            {imageHistoryBatches.map((batch, index) => {
                                const versionNumber = imageHistoryBatches.length - index;
                                const activeIndex = Math.min(batchImageIndexes[batch.key] || 0, batch.urls.length - 1);
                                const activeUrl = batch.urls[activeIndex];
                                const version = getImageVersion(activeUrl);
                                const hasMultipleImages = batch.urls.length > 1;
                                return (
                                    <div
                                        key={batch.key}
                                        className={`group/version relative overflow-hidden rounded-xl border ${isDark ? 'border-zinc-800 bg-black/25' : 'border-gray-200 bg-gray-50/80'}`}
                                        onMouseEnter={() => setHoveredBatchKey(batch.key)}
                                        onMouseLeave={() => setHoveredBatchKey(null)}
                                    >
                                        <div
                                            className="relative aspect-video overflow-hidden rounded-xl"
                                            title="点击查看大图"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                onPreviewMedia?.(activeUrl, 'image');
                                            }}
                                        >
                                            <img
                                                src={activeUrl}
                                                className="h-full w-full object-cover"
                                                draggable={false}
                                                onLoad={(event) => recordNaturalRatio(activeUrl, event.currentTarget)}
                                            />
                                            <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/65 to-transparent" />
                                            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/75 to-transparent" />
                                            <span className="absolute left-3 top-3 z-20 rounded-full border border-white/15 bg-black/55 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur-md">
                                                V{versionNumber}
                                            </span>
                                             <div className="absolute inset-x-3 bottom-3 z-30 flex items-center justify-end gap-2">
                                                 <button
                                                     type="button"
                                                     className={`h-8 rounded-lg border px-3 text-[11px] font-semibold shadow-lg ${activeUrl === currentSrc ? 'cursor-default border-white/10 bg-black/45 text-white/55' : 'border-white/10 bg-black/55 text-white hover:bg-black/75'}`}
                                                     disabled={activeUrl === currentSrc}
                                                     onClick={(event) => {
                                                         event.stopPropagation();
                                                         onSetImageVersion?.(data.id, withNaturalRatio(version));
                                                         closeStack();
                                                     }}
                                                 >
                                                     设为当前
                                                 </button>
                                                 <button
                                                     type="button"
                                                     className="h-8 rounded-lg bg-[#4446CE] px-3 text-[11px] font-semibold text-white shadow-lg hover:bg-[#5557DB]"
                                                     onClick={(event) => {
                                                         event.stopPropagation();
                                                         onUseImageVersion?.(data.id, withNaturalRatio(version));
                                                         closeStack();
                                                     }}
                                                 >
                                                     复制并新建
                                                 </button>
                                             </div>
                                            {hasMultipleImages && hoveredBatchKey === batch.key && (
                                                <>
                                                    <button
                                                        type="button"
                                                        className="absolute left-3 top-1/2 z-30 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white shadow-lg backdrop-blur-md hover:bg-black/70"
                                                        aria-label={`查看 V${versionNumber} 上一张`}
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            shiftBatchImage(batch.key, batch.urls.length, -1);
                                                        }}
                                                    >
                                                        <Icons.ChevronLeft size={18} />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="absolute right-3 top-1/2 z-30 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white shadow-lg backdrop-blur-md hover:bg-black/70"
                                                        aria-label={`查看 V${versionNumber} 下一张`}
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            shiftBatchImage(batch.key, batch.urls.length, 1);
                                                        }}
                                                    >
                                                        <Icons.ChevronRight size={18} />
                                                    </button>
                                                    <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/15 bg-black/45 px-2.5 py-1 text-[11px] font-semibold text-white shadow-lg backdrop-blur-md">
                                                        {activeIndex + 1}/{batch.urls.length}
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </>
        );
    }

    if (isVideoHistory && (artifacts.length > 0 || currentSrc)) {
        const videoUrls = artifacts.length > 0 ? artifacts : (currentSrc ? [currentSrc] : []);
        const currentIndex = Math.max(0, videoUrls.findIndex(url => url === currentSrc));
        const currentVersionNumber = Math.max(1, videoUrls.length - currentIndex);
        return (
            <>
                {currentSrc && <VideoPreview src={currentSrc} isDark={isDark || false} />}
                {data.resultSource === 'mock' && <MockResultBadge isDark={isDark} />}
                {showBadge && (
                    <button
                        type="button"
                        className="absolute left-1/2 top-3 z-[90] flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/10 bg-black/50 px-2.5 py-1 text-[10px] font-semibold text-white shadow-lg backdrop-blur-md hover:bg-black/70"
                        onClick={(event) => {
                            event.stopPropagation();
                            updateData(data.id, { isStackOpen: true });
                        }}
                    >
                        <span>V{currentVersionNumber}</span>
                        <span className="text-zinc-300">· {videoUrls.length}个版本</span>
                        <Icons.ChevronRight size={11} className="text-zinc-400" />
                    </button>
                )}
                {data.isStackOpen && (
                    <div
                        ref={stackRef}
                        className={`history-version-drawer absolute left-[calc(100%+16px)] top-0 z-[120] flex w-[420px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-2xl border shadow-2xl backdrop-blur-xl ${isDark ? 'border-zinc-700 bg-[#181818]/97 text-zinc-100' : 'border-gray-200 bg-white/97 text-gray-900'}`}
                        style={{ height: Math.max(440, data.height) }}
                        data-canvas-wheel-pass-through="true"
                        onMouseDown={(event) => event.stopPropagation()}
                        onWheelCapture={(event) => event.stopPropagation()}
                    >
                        <div className={`flex items-start justify-between border-b px-4 py-4 ${isDark ? 'border-zinc-800' : 'border-gray-100'}`}>
                            <div>
                                <div className="text-sm font-semibold">历史版本</div>
                            </div>
                            <button
                                type="button"
                                className={`flex h-8 w-8 items-center justify-center rounded-lg ${isDark ? 'text-zinc-400 hover:bg-zinc-800 hover:text-white' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'}`}
                                title="关闭历史版本"
                                aria-label="关闭历史版本"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    closeStack();
                                }}
                            >
                                <Icons.X size={17} />
                            </button>
                        </div>
                        <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
                            {videoUrls.map((src, index) => {
                                const versionNumber = videoUrls.length - index;
                                // History excludes the version currently shown on the node.
                                if (src === currentSrc) return null;
                                return (
                                    <div
                                        key={src + index}
                                        className={`relative overflow-hidden rounded-xl border transition-colors ${isDark ? 'border-zinc-800 bg-black/20 hover:border-zinc-700 hover:bg-white/[0.04]' : 'border-gray-200 bg-gray-50/70 hover:border-gray-300 hover:bg-white'}`}
                                    >
                                        <div
                                            className={`relative aspect-video w-full cursor-zoom-in ${isDark ? 'bg-black' : 'bg-gray-100'}`}
                                            title="点击查看视频"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                onPreviewMedia?.(src, 'video');
                                            }}
                                        >
                                            <video src={src} className="h-full w-full object-contain" muted playsInline preload="metadata" />
                                            <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/70 to-transparent" />
                                            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/80 to-transparent" />
                                            <span className="absolute left-3 top-3 rounded-full border border-white/15 bg-black/55 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur-md">
                                                V{versionNumber}
                                            </span>
                                            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                                                <Icons.Play size={26} className="text-white/85 drop-shadow" fill="currentColor" />
                                            </div>
                                            <div className="absolute inset-x-3 bottom-3 flex items-center justify-end gap-2">
                                                 <button
                                                     type="button"
                                                     className="h-8 rounded-lg border border-white/10 bg-black/55 px-3 text-[11px] font-semibold text-white shadow-lg hover:bg-black/75"
                                                     onClick={(event) => {
                                                         event.stopPropagation();
                                                         onSetVideoVersion?.(data.id, src);
                                                         closeStack();
                                                     }}
                                                 >
                                                     设为当前
                                                 </button>
                                                 <button
                                                     type="button"
                                                     className="h-8 rounded-lg bg-[#4446CE] px-3.5 text-[11px] font-semibold text-white shadow-lg hover:bg-[#5557DB]"
                                                     onClick={(event) => {
                                                         event.stopPropagation();
                                                         onUseVideoVersion?.(data.id, src);
                                                         closeStack();
                                                     }}
                                                 >
                                                     复制并新建
                                                 </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </>
        );
    }

    if (data.isStackOpen) {
        return (
            <div ref={stackRef} className={`absolute left-1/2 top-10 z-[100] w-[560px] max-w-[calc(100vw-48px)] -translate-x-1/2 rounded-2xl border p-3 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 duration-200 ${isDark ? 'border-zinc-700 bg-[#181818]/95' : 'border-gray-200 bg-white/95'}`} onMouseDown={(event) => event.stopPropagation()}>
                <div className="mb-2 flex items-center justify-between">
                    <span className={`text-xs font-semibold ${isDark ? 'text-zinc-200' : 'text-gray-800'}`}>历史版本</span>
                    <button className={`h-7 w-7 rounded-lg flex items-center justify-center ${isDark ? 'text-zinc-400 hover:bg-zinc-800 hover:text-white' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'}`} onClick={(e) => { e.stopPropagation(); updateData(data.id, { isStackOpen: false }); }}><Icons.X size={16} /></button>
                </div>
                <div className="grid grid-cols-5 gap-2">
                    {sortedArtifacts.map((src, index) => {
                    const isMain = index === 0;
                    const isVideo = /\.(mp4|webm|mov|mkv)(\?|$)/i.test(src) || data.type === 'TEXT_TO_VIDEO';
                    return (
                      <div key={src + index} className={`relative aspect-square overflow-hidden rounded-xl border group/card ${isMain ? 'border-[#8F91F4] ring-1 ring-[#8F91F4]/40' : (isDark ? 'border-zinc-700 bg-black' : 'border-gray-200 bg-white')}`}>
                           <button
                               className="absolute inset-0"
                               title="查看原图"
                               onClick={(e) => {
                                   e.stopPropagation();
                                   onPreviewMedia?.(src, isVideo ? 'video' : 'image');
                               }}
                           >
                           {isVideo ? (
                               <video src={src} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                           ) : (
                               <img src={src} className={`h-full w-full object-cover ${isDark ? 'bg-[#09090b]' : 'bg-gray-50'}`} draggable={false} />
                           )}
                           </button>
                           <div className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold text-white backdrop-blur-md">{isMain ? '当前' : `版本 ${index + 1}`}</div>
                           {!isMain && <button className="absolute bottom-1.5 left-1.5 right-1.5 h-6 rounded-md border border-white/10 bg-black/55 text-[10px] font-bold text-white shadow-sm backdrop-blur-md hover:bg-black/75" onClick={(e) => { e.stopPropagation(); updateData(data.id, { [isVideo ? 'videoSrc' : 'imageSrc']: src, isStackOpen: false }); }}>设为当前</button>}
                      </div>
                    );
                    })}
                </div>
            </div>
        );
    }
    
    // Improved detection: Prioritize strict node type check, then file extension.
    // Removed naive .includes('video') which triggers on random signatures in URLs.
    const isVideo = data.type === 'TEXT_TO_VIDEO' || data.type === 'IMAGE_TO_VIDEO' || data.type === 'START_END_TO_VIDEO' || (currentSrc && /\.(mp4|webm|mov|mkv)(\?|$)/i.test(currentSrc));
    return (
        <>
           {isVideo ? (
               currentSrc && <VideoPreview src={currentSrc} isDark={isDark || false} />
           ) : (
               currentSrc && <img src={currentSrc} className={`w-full h-full object-contain pointer-events-none ${isDark ? 'bg-[#09090b]' : 'bg-gray-50'}`} alt="Generated" draggable={false} />
           )}
           {data.resultSource === 'mock' && <MockResultBadge isDark={isDark} />}
           {showBadge && <div className="absolute left-1/2 top-2 z-30 flex -translate-x-1/2 cursor-pointer select-none items-center gap-1 rounded-full border border-white/10 bg-black/30 px-2 py-1 text-[10px] text-white shadow-lg backdrop-blur-md transition-colors hover:bg-black/50" onClick={(e) => { e.stopPropagation(); updateData(data.id, { isStackOpen: true }); }}><Icons.Layers size={10} className="text-[#8F91F4]"/><span className="font-bold">版本</span><span className="font-bold tabular-nums">{artifacts.length}</span><Icons.ChevronRight size={10} className="text-zinc-400" /></div>}
        </>
    );
};
