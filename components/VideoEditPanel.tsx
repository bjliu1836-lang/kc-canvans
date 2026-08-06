import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InputMedia, VideoEditAnchor, VideoEditRequest, VideoPromptReference } from '../types';
import { Icons } from './Icons';
import { VideoReferencePromptEditor } from './Nodes/Shared/VideoReferencePromptEditor';

interface VideoEditPanelProps {
  isOpen: boolean;
  videoSrc: string;
  sourceTitle: string;
  isDark: boolean;
  onClose: () => void;
  onSubmit: (request: VideoEditRequest) => void;
}

type EditTool = 'brush' | 'rect' | 'eraser';
type HistoryEntry = { image: ImageData; hasDrawing: boolean };

const MAX_WORK_SIZE = 1280;
const FRAME_STEP = 1 / 24;

const formatTimecode = (seconds: number) => {
  const safe = Math.max(0, seconds || 0);
  const minutes = Math.floor(safe / 60);
  const remaining = safe - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remaining.toFixed(3).padStart(6, '0')}`;
};

const getWorkingSize = (width: number, height: number) => {
  const scale = Math.min(1, MAX_WORK_SIZE / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

const getCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement) => {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)),
  };
};

const canvasHasDrawing = (canvas: HTMLCanvasElement) => {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 0) return true;
  }
  return false;
};

export const VideoEditPanel: React.FC<VideoEditPanelProps> = ({
  isOpen,
  videoSrc,
  sourceTitle,
  isDark,
  onClose,
  onSubmit,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<HistoryEntry[]>([]);
  const redoRef = useRef<HistoryEntry[]>([]);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const rectStartRef = useRef<{ x: number; y: number } | null>(null);
  const rectBaseRef = useRef<ImageData | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  const [workingSize, setWorkingSize] = useState({ width: 0, height: 0 });
  const [tool, setTool] = useState<EditTool>('brush');
  const [brushSize, setBrushSize] = useState(28);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isTimelineDragging, setIsTimelineDragging] = useState(false);
  const [hasDrawing, setHasDrawing] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [anchors, setAnchors] = useState<VideoEditAnchor[]>([]);
  const [prompt, setPrompt] = useState('');
  const [references, setReferences] = useState<VideoPromptReference[]>([]);
  const [error, setError] = useState('');
  const [isSending, setIsSending] = useState(false);

  const mutedText = isDark ? 'text-zinc-400' : 'text-gray-500';
  const panelBg = isDark ? 'bg-[#17181b] text-zinc-100' : 'bg-white text-gray-900';
  const border = isDark ? 'border-zinc-700/70' : 'border-gray-200';
  const timelineProgress = duration > 0 ? Math.min(100, Math.max(0, currentTime / duration * 100)) : 0;

  const resetEditor = useCallback(() => {
    setCurrentTime(0);
    setDuration(0);
    setVideoSize({ width: 0, height: 0 });
    setWorkingSize({ width: 0, height: 0 });
    setTool('brush');
    setBrushSize(28);
    setIsPlaying(false);
    setIsTimelineDragging(false);
    setHasDrawing(false);
    setHistoryVersion(value => value + 1);
    setAnchors([]);
    setPrompt('');
    setReferences([]);
    setError('');
    setIsSending(false);
    historyRef.current = [];
    redoRef.current = [];
    const canvas = overlayRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  useEffect(() => {
    if (isOpen) resetEditor();
  }, [isOpen, videoSrc, resetEditor]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !workingSize.width || !workingSize.height) return;
    canvas.width = workingSize.width;
    canvas.height = workingSize.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }
    historyRef.current = [];
    redoRef.current = [];
    setHasDrawing(false);
    setHistoryVersion(value => value + 1);
  }, [workingSize]);

  const saveHistory = useCallback(() => {
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    historyRef.current = [...historyRef.current.slice(-7), {
      image: ctx.getImageData(0, 0, canvas.width, canvas.height),
      hasDrawing,
    }];
    redoRef.current = [];
    setHistoryVersion(value => value + 1);
  }, [hasDrawing]);

  const restoreHistoryEntry = useCallback((entry: HistoryEntry) => {
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.putImageData(entry.image, 0, 0);
    setHasDrawing(entry.hasDrawing);
    setHistoryVersion(value => value + 1);
  }, []);

  const undo = () => {
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext('2d');
    const previous = historyRef.current.pop();
    if (!canvas || !ctx || !previous) return;
    redoRef.current.push({ image: ctx.getImageData(0, 0, canvas.width, canvas.height), hasDrawing });
    restoreHistoryEntry(previous);
  };

  const redo = () => {
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext('2d');
    const next = redoRef.current.pop();
    if (!canvas || !ctx || !next) return;
    historyRef.current.push({ image: ctx.getImageData(0, 0, canvas.width, canvas.height), hasDrawing });
    restoreHistoryEntry(next);
  };

  const clearSelection = () => {
    if (!hasDrawing) return;
    saveHistory();
    const canvas = overlayRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    setHasDrawing(false);
  };

  const clearUncommittedDrawing = useCallback(() => {
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    historyRef.current = [];
    redoRef.current = [];
    setHasDrawing(false);
    setHistoryVersion(value => value + 1);
  }, []);

  const confirmSeek = useCallback(() => {
    if (!hasDrawing) return true;
    const confirmed = window.confirm('当前标注尚未添加为关键帧，切换时间将清空标注。是否继续？');
    if (confirmed) clearUncommittedDrawing();
    return confirmed;
  }, [clearUncommittedDrawing, hasDrawing]);

  const seekTo = useCallback((time: number, shouldConfirm = true) => {
    if (shouldConfirm && !confirmSeek()) return;
    const video = videoRef.current;
    if (!video) return;
    const next = Math.max(0, Math.min(time, video.duration || duration || 0));
    video.currentTime = next;
    setCurrentTime(next);
  }, [confirmSeek, duration]);

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    const width = video.videoWidth || 16;
    const height = video.videoHeight || 9;
    setVideoSize({ width, height });
    setWorkingSize(getWorkingSize(width, height));
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    video.currentTime = 0;
    setCurrentTime(0);
  };

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) {
      video.pause();
      setIsPlaying(false);
      return;
    }
    if (!confirmSeek()) return;
    try {
      await video.play();
      setIsPlaying(true);
    } catch {
      setError('视频暂时无法播放，请检查素材地址。');
    }
  };

  const updateTimeline = (clientX: number) => {
    const timeline = timelineRef.current;
    if (!timeline || !duration) return;
    const rect = timeline.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seekTo(ratio * duration, false);
  };

  const handleTimelinePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!confirmSeek()) return;
    setIsTimelineDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    updateTimeline(event.clientX);
  };

  const handleTimelinePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isTimelineDragging) updateTimeline(event.clientX);
  };

  const handleTimelinePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    setIsTimelineDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const drawBrush = (point: { x: number; y: number }, from?: { x: number; y: number }) => {
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.72)';
    ctx.lineWidth = brushSize;
    ctx.beginPath();
    ctx.moveTo(from?.x ?? point.x, from?.y ?? point.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    ctx.restore();
  };

  const handleDrawPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const canvas = overlayRef.current;
    if (!canvas) return;
    videoRef.current?.pause();
    setIsPlaying(false);
    saveHistory();
    const point = getCanvasPoint(event, canvas);
    drawingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === 'rect') {
      rectStartRef.current = point;
      rectBaseRef.current = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height) || null;
    } else {
      drawBrush(point);
      lastPointRef.current = point;
      setHasDrawing(true);
    }
  };

  const handleDrawPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const point = getCanvasPoint(event, canvas);
    if (tool === 'rect' && rectStartRef.current && rectBaseRef.current) {
      ctx.putImageData(rectBaseRef.current, 0, 0);
      const x = Math.min(rectStartRef.current.x, point.x);
      const y = Math.min(rectStartRef.current.y, point.y);
      const width = Math.abs(point.x - rectStartRef.current.x);
      const height = Math.abs(point.y - rectStartRef.current.y);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.22)';
      ctx.strokeStyle = 'rgba(248, 113, 113, 0.98)';
      ctx.lineWidth = 2;
      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x, y, width, height);
    } else {
      drawBrush(point, lastPointRef.current || point);
      lastPointRef.current = point;
      setHasDrawing(true);
    }
  };

  const handleDrawPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext('2d');
    if (tool === 'rect' && canvas && ctx && rectStartRef.current) {
      const point = getCanvasPoint(event, canvas);
      ctx.putImageData(rectBaseRef.current || ctx.getImageData(0, 0, canvas.width, canvas.height), 0, 0);
      const x = Math.min(rectStartRef.current.x, point.x);
      const y = Math.min(rectStartRef.current.y, point.y);
      const width = Math.abs(point.x - rectStartRef.current.x);
      const height = Math.abs(point.y - rectStartRef.current.y);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.22)';
      ctx.strokeStyle = 'rgba(248, 113, 113, 0.98)';
      ctx.lineWidth = 2;
      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x, y, width, height);
      setHasDrawing(width > 2 && height > 2);
    }
    drawingRef.current = false;
    lastPointRef.current = null;
    rectStartRef.current = null;
    rectBaseRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (canvas && ctx && !canvasHasDrawing(canvas)) setHasDrawing(false);
  };

  const createAnchor = () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    const sourceCanvas = sourceCanvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!video || !overlay || !sourceCanvas || !maskCanvas || !hasDrawing) return;
    if (!videoSize.width || !videoSize.height || !duration) {
      setError('视频仍在加载，请稍后再添加当前帧。');
      return;
    }
    try {
      sourceCanvas.width = videoSize.width;
      sourceCanvas.height = videoSize.height;
      const sourceCtx = sourceCanvas.getContext('2d');
      if (!sourceCtx) return;
      sourceCtx.drawImage(video, 0, 0, videoSize.width, videoSize.height);
      const originalFrameDataUrl = sourceCanvas.toDataURL('image/png');

      const maskSmall = document.createElement('canvas');
      maskSmall.width = overlay.width;
      maskSmall.height = overlay.height;
      const maskSmallCtx = maskSmall.getContext('2d');
      if (!maskSmallCtx) return;
      const overlayPixels = overlay.getContext('2d')?.getImageData(0, 0, overlay.width, overlay.height);
      if (!overlayPixels) return;
      const maskPixels = maskSmallCtx.createImageData(overlay.width, overlay.height);
      for (let index = 0; index < overlayPixels.data.length; index += 4) {
        const selected = overlayPixels.data[index + 3] > 0;
        maskPixels.data[index] = selected ? 255 : 0;
        maskPixels.data[index + 1] = selected ? 255 : 0;
        maskPixels.data[index + 2] = selected ? 255 : 0;
        maskPixels.data[index + 3] = 255;
      }
      maskSmallCtx.putImageData(maskPixels, 0, 0);
      maskCanvas.width = videoSize.width;
      maskCanvas.height = videoSize.height;
      const maskCtx = maskCanvas.getContext('2d');
      if (!maskCtx) return;
      maskCtx.imageSmoothingEnabled = false;
      maskCtx.fillStyle = '#000';
      maskCtx.fillRect(0, 0, videoSize.width, videoSize.height);
      maskCtx.drawImage(maskSmall, 0, 0, videoSize.width, videoSize.height);
      const maskDataUrl = maskCanvas.toDataURL('image/png');

      sourceCtx.drawImage(video, 0, 0, videoSize.width, videoSize.height);
      sourceCtx.drawImage(overlay, 0, 0, videoSize.width, videoSize.height);
      const annotatedFrameDataUrl = sourceCanvas.toDataURL('image/png');
      const id = `video-edit-anchor-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const nextAnchor: VideoEditAnchor = {
        id,
        timeSeconds: currentTime,
        timecode: formatTimecode(currentTime),
        estimatedFrame: Math.round(currentTime * 24),
        originalFrameDataUrl,
        maskDataUrl,
        annotatedFrameDataUrl,
      };
      const nextPromptReference: VideoPromptReference = {
        id,
        sourceNodeId: id,
        type: 'image',
        url: annotatedFrameDataUrl,
        title: `关键帧 ${nextAnchor.timecode}`,
        offset: prompt.length,
      };
      setAnchors(previous => [...previous, nextAnchor]);
      setReferences(previous => [...previous, nextPromptReference]);
      clearUncommittedDrawing();
      setError('');
    } catch (captureError) {
      console.error('[VideoEditPanel] capture failed', captureError);
      setError('当前视频不允许浏览器截取关键帧，请稍后通过媒体代理处理。');
    }
  };

  const anchorMedia = useMemo<InputMedia[]>(() => anchors.map(anchor => ({
    id: anchor.id,
    sourceNodeId: anchor.id,
    type: 'image',
    url: anchor.annotatedFrameDataUrl,
    title: `关键帧 ${anchor.timecode}`,
  })), [anchors]);

  const submit = () => {
    const selectedIds = new Set(references.map(reference => reference.id));
    const selectedAnchors = anchors.filter(anchor => selectedIds.has(anchor.id));
    if (!prompt.trim() || selectedAnchors.length === 0 || isSending) return;
    const request: VideoEditRequest = {
      sourceVideoUrl: videoSrc,
      prompt: prompt.trim(),
      scope: 'track_same_subject_full_clip',
      anchors: selectedAnchors,
    };
    setIsSending(true);
    onSubmit(request);
  };

  if (!isOpen) return null;

  const toolButton = (value: EditTool, icon: React.ReactNode, label: string) => (
    <button
      type="button"
      className={`flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors ${tool === value ? 'bg-[#4446CE] text-white' : isDark ? 'text-zinc-300 hover:bg-zinc-800' : 'text-gray-600 hover:bg-gray-100'}`}
      onClick={() => setTool(value)}
      title={label}
    >
      {icon}<span>{label}</span>
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/60 px-4 py-5 backdrop-blur-sm"
      onMouseDown={event => { event.stopPropagation(); if (event.target === event.currentTarget && !isSending) onClose(); }}
      onKeyDownCapture={event => event.stopPropagation()}
    >
      <div className={`flex max-h-[94vh] w-[min(1040px,calc(100vw-32px))] flex-col overflow-hidden rounded-[24px] border shadow-2xl ${panelBg} ${border}`} onMouseDown={event => event.stopPropagation()}>
        <div className={`flex h-14 shrink-0 items-center justify-between border-b px-5 ${border}`}>
          <div className="flex items-center gap-2">
            <Icons.Edit3 size={18} className="text-[#8F91F4]" />
            <div>
              <h2 className="text-base font-bold">视频编辑</h2>
              <p className={`text-[10px] ${mutedText}`}>{sourceTitle} · 模拟接口</p>
            </div>
          </div>
          <button type="button" className={`flex h-8 w-8 items-center justify-center rounded-lg ${mutedText} hover:bg-white/10 hover:text-white`} onClick={onClose} title="关闭">
            <Icons.X size={18} />
          </button>
        </div>

        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
          <div className={`relative flex h-[min(48vh,500px)] items-center justify-center overflow-hidden rounded-2xl border bg-black ${border}`}>
            <div
              className="relative max-h-full max-w-full"
              style={{
                aspectRatio: videoSize.width && videoSize.height ? `${videoSize.width}/${videoSize.height}` : '16/9',
                width: videoSize.width >= videoSize.height ? '100%' : 'auto',
                height: videoSize.width < videoSize.height ? '100%' : 'auto',
              }}
            >
              <video
                ref={videoRef}
                src={videoSrc}
                className="absolute inset-0 h-full w-full object-contain"
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={() => { if (!isTimelineDragging && videoRef.current) setCurrentTime(videoRef.current.currentTime); }}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
                onError={() => setError('视频暂时无法加载，请检查素材地址。')}
                crossOrigin="anonymous"
                preload="auto"
                playsInline
              />
              <canvas
                ref={overlayRef}
                className="absolute inset-0 h-full w-full cursor-crosshair"
                onPointerDown={handleDrawPointerDown}
                onPointerMove={handleDrawPointerMove}
                onPointerUp={handleDrawPointerUp}
                onPointerCancel={handleDrawPointerUp}
              />
            </div>
            <div className="absolute bottom-3 left-1/2 flex w-[184px] -translate-x-1/2 items-center justify-center gap-5 rounded-2xl bg-black/60 px-4 py-2.5 text-white backdrop-blur-md">
              <button type="button" className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/10" onClick={() => seekTo(currentTime - FRAME_STEP)} title="上一帧"><Icons.SkipBack size={16} /></button>
              <button type="button" className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-zinc-950" onClick={togglePlay} title={isPlaying ? '暂停' : '播放'}>
                {isPlaying ? <Icons.Pause size={18} fill="currentColor" /> : <Icons.Play size={18} fill="currentColor" className="ml-0.5" />}
              </button>
              <button type="button" className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/10" onClick={() => seekTo(currentTime + FRAME_STEP)} title="下一帧"><Icons.SkipForward size={16} /></button>
            </div>
          </div>

          <div
            ref={timelineRef}
            className={`relative mt-3 h-7 cursor-pointer touch-none rounded-full border ${isDark ? 'border-zinc-700 bg-zinc-900' : 'border-gray-200 bg-gray-100'}`}
            onPointerDown={handleTimelinePointerDown}
            onPointerMove={handleTimelinePointerMove}
            onPointerUp={handleTimelinePointerUp}
            onPointerCancel={handleTimelinePointerUp}
          >
            <div className="absolute inset-y-0 left-0 rounded-full bg-[#4446CE]/80" style={{ width: `${timelineProgress}%` }} />
            <div className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[#4446CE] shadow" style={{ left: `${timelineProgress}%` }} />
          </div>

          <div className={`mt-3 flex flex-wrap items-center gap-1.5 rounded-xl border p-2 ${isDark ? 'border-zinc-800 bg-[#202124]' : 'border-gray-200 bg-gray-50'} ${border}`}>
            {toolButton('brush', <Icons.Edit3 size={14} />, '画笔')}
            {toolButton('rect', <Icons.Box size={14} />, '框选')}
            {toolButton('eraser', <Icons.Eraser size={14} />, '橡皮擦')}
            <div className={`mx-1 h-5 w-px ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />
            <label className={`flex items-center gap-2 px-1 text-[11px] ${mutedText}`} title="画笔大小">
              大小
              <input type="range" min="8" max="80" value={brushSize} onChange={event => setBrushSize(Number(event.target.value))} className="w-20 accent-[#4446CE]" />
              <span className="w-5 tabular-nums">{brushSize}</span>
            </label>
            <div className="ml-auto flex items-center gap-1">
              <button type="button" disabled={!historyRef.current.length} className={`flex h-8 w-8 items-center justify-center rounded-lg disabled:opacity-30 ${mutedText} hover:bg-white/10`} onClick={undo} title="撤销"><Icons.RotateCcw size={15} /></button>
              <button type="button" disabled={!redoRef.current.length} className={`flex h-8 w-8 items-center justify-center rounded-lg disabled:opacity-30 ${mutedText} hover:bg-white/10`} onClick={redo} title="重做"><Icons.RefreshCw size={15} /></button>
              <button type="button" disabled={!hasDrawing} className={`h-8 rounded-lg px-2 text-xs disabled:opacity-30 ${mutedText} hover:bg-white/10`} onClick={clearSelection}>清空</button>
            </div>
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">修改指令</span>
                <span className={`text-[11px] ${mutedText}`}>已添加 {anchors.length} 个关键帧</span>
              </div>
              <button type="button" disabled={!hasDrawing || !videoSize.width || !videoSize.height || !duration} className="flex h-8 items-center gap-1.5 rounded-lg bg-[#4446CE] px-3 text-xs font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40" onClick={createAnchor} title="把当前标注帧加入提示词"><Icons.Plus size={14} />添加当前帧</button>
            </div>
            <VideoReferencePromptEditor
              value={prompt}
              onChange={setPrompt}
              references={references}
              onReferencesChange={setReferences}
              inputMedia={anchorMedia}
              mode="image"
              placeholder="描述要对选中区域做的修改，例如：消除画面右侧的路人、将桌上的水杯替换为一束红玫瑰"
              isDark={isDark}
              allowExpand={true}
              referenceHint="关键帧变量会随提示词一起发送；可输入 @ 再次引用已添加的关键帧"
              expandedTitle="编辑视频修改指令"
              showReferenceHint={false}
            />
          </div>

          {error && <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
        </div>

        <div className={`flex shrink-0 items-center justify-between border-t px-5 py-3 ${border}`}>
          <button type="button" disabled={isSending || !prompt.trim() || references.length === 0} className="flex h-10 items-center gap-2 rounded-xl bg-[#4446CE] px-4 text-sm font-semibold text-white shadow-lg shadow-[#4446CE]/20 transition-all hover:bg-[#5b5de0] disabled:cursor-not-allowed disabled:opacity-40" onClick={submit}>
            {isSending ? <Icons.Loader2 size={16} className="animate-spin" /> : <Icons.ArrowUp size={18} />}
            <span>{isSending ? '发送中' : '发送编辑请求'}</span>
          </button>
        </div>
      </div>
      <canvas ref={sourceCanvasRef} className="hidden" />
      <canvas ref={maskCanvasRef} className="hidden" />
    </div>
  );
};
