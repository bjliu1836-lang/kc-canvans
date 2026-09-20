import React, { useState, useRef, useEffect } from 'react';
import { Icons } from '../Icons';
import { NodeData, NodeGroup, Connection, CanvasTransform } from '../../types';

interface ExportImportModalProps {
    isOpen: boolean;
    onClose: () => void;
    isDark: boolean;
    projectName: string;
    onProjectNameChange: (name: string) => void;
    nodes: NodeData[];
    connections: Connection[];
    groups: NodeGroup[];
    transform: CanvasTransform;
    onImport: (data: { nodes: NodeData[], connections: Connection[], groups?: NodeGroup[], transform?: CanvasTransform, projectName?: string }) => void;
}

type TabType = 'export' | 'import';
type ExportMode = 'json' | 'folder';

export const ExportImportModal: React.FC<ExportImportModalProps> = ({
    isOpen,
    onClose,
    isDark,
    projectName,
    onProjectNameChange,
    nodes,
    connections,
    groups,
    transform,
    onImport
}) => {
    const [activeTab, setActiveTab] = useState<TabType>('export');
    const [exportMode, setExportMode] = useState<ExportMode>('json');
    const [localProjectName, setLocalProjectName] = useState(projectName);
    const [isExporting, setIsExporting] = useState(false);
    const [importError, setImportError] = useState<string | null>(null);
    
    const importInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            setLocalProjectName(projectName);
            setImportError(null);
        }
    }, [isOpen, projectName]);

    // 统计信息
    const stats = {
        totalNodes: nodes.length,
        imageNodes: nodes.filter(n => n.imageSrc).length,
        videoNodes: nodes.filter(n => n.videoSrc).length,
        connections: connections.length,
        historyCount: nodes.reduce((acc, n) => acc + (n.outputArtifacts?.length || 0), 0)
    };

    // 导出 JSON
    const handleExportJSON = async () => {
        setIsExporting(true);
        try {
            const workflowData = {
                version: "2.0",
                projectName: localProjectName,
                exportedAt: new Date().toISOString(),
                nodes,
                connections,
                groups,
                transform
            };
            
            const blob = new Blob([JSON.stringify(workflowData, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            const safeName = localProjectName.replace(/[<>:"/\\|?*]/g, '_').trim() || '未命名项目';
            link.download = `${safeName}.flow`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            
            onProjectNameChange(localProjectName);
            
            setTimeout(() => {
                setIsExporting(false);
                onClose();
            }, 500);
        } catch (e) {
            console.error(e);
            setIsExporting(false);
        }
    };

    // 导出文件夹（包含资源）
    const handleExportFolder = async () => {
        setIsExporting(true);
        try {
            // 检查是否支持 File System Access API
            if ('showDirectoryPicker' in window) {
                const dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
                const safeName = localProjectName.replace(/[<>:"/\\|?*]/g, '_').trim() || '未命名项目';
                
                // 创建项目文件夹
                const projectDir = await dirHandle.getDirectoryHandle(safeName, { create: true });
                
                // 创建子文件夹
                const imagesDir = await projectDir.getDirectoryHandle('images', { create: true });
                const videosDir = await projectDir.getDirectoryHandle('videos', { create: true });
                
                // 保存资源文件
                const assetMap: Record<string, string> = {};
                let imageIndex = 0;
                let videoIndex = 0;
                
                for (const node of nodes) {
                    if (node.imageSrc && node.imageSrc.startsWith('data:')) {
                        const filename = `image_${++imageIndex}.png`;
                        const fileHandle = await imagesDir.getFileHandle(filename, { create: true });
                        const writable = await fileHandle.createWritable();
                        const response = await fetch(node.imageSrc);
                        const blob = await response.blob();
                        await writable.write(blob);
                        await writable.close();
                        assetMap[node.imageSrc] = `images/${filename}`;
                    }
                    if (node.videoSrc && (node.videoSrc.startsWith('data:') || node.videoSrc.startsWith('blob:'))) {
                        const filename = `video_${++videoIndex}.mp4`;
                        const fileHandle = await videosDir.getFileHandle(filename, { create: true });
                        const writable = await fileHandle.createWritable();
                        const response = await fetch(node.videoSrc);
                        const blob = await response.blob();
                        await writable.write(blob);
                        await writable.close();
                        assetMap[node.videoSrc] = `videos/${filename}`;
                    }
                }
                
                // 修改节点中的资源引用
                const exportNodes = nodes.map(node => ({
                    ...node,
                    imageSrc: node.imageSrc ? (assetMap[node.imageSrc] || node.imageSrc) : undefined,
                    videoSrc: node.videoSrc ? (assetMap[node.videoSrc] || node.videoSrc) : undefined
                }));
                
                // 保存工作流 JSON
                const workflowData = {
                    version: "2.0",
                    projectName: localProjectName,
                    exportedAt: new Date().toISOString(),
                    exportMode: 'folder',
                    nodes: exportNodes,
                    connections,
                    transform
                };
                
                const workflowFile = await projectDir.getFileHandle('workflow.json', { create: true });
                const workflowWritable = await workflowFile.createWritable();
                await workflowWritable.write(JSON.stringify(workflowData, null, 2));
                await workflowWritable.close();
                
                onProjectNameChange(localProjectName);
            } else {
                // 降级为 ZIP 下载
                alert('您的浏览器不支持文件夹导出，将使用 JSON 格式导出');
                handleExportJSON();
                return;
            }
            
            setTimeout(() => {
                setIsExporting(false);
                onClose();
            }, 500);
        } catch (e: any) {
            console.error(e);
            if (e.name !== 'AbortError') {
                alert('导出失败: ' + e.message);
            }
            setIsExporting(false);
        }
    };

    const handleExport = () => {
        if (exportMode === 'json') {
            handleExportJSON();
        } else {
            handleExportFolder();
        }
    };

    // 导入
    const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        
        setImportError(null);
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const data = JSON.parse(event.target?.result as string);
                if (data.nodes && data.connections) {
                    onImport({
                        nodes: data.nodes,
                        connections: data.connections,
                        groups: data.groups,
                        transform: data.transform,
                        projectName: data.projectName
                    });
                    onClose();
                } else {
                    setImportError('无效的工作流文件格式');
                }
            } catch (err) {
                console.error(err);
                setImportError('文件解析失败，请确保文件格式正确');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    // 样式
    const bgMain = isDark ? 'bg-[#0a0a0c]' : 'bg-white';
    const bgCard = isDark ? 'bg-[#131316]' : 'bg-gray-50';
    const borderColor = isDark ? 'border-[#1f1f24]' : 'border-gray-200';
    const textMain = isDark ? 'text-gray-100' : 'text-gray-900';
    const textSub = isDark ? 'text-gray-400' : 'text-gray-500';
    const textMuted = isDark ? 'text-gray-600' : 'text-gray-400';

    if (!isOpen) return null;

    return (
        <div 
            className="fixed inset-0 z-[250] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={onClose}
        >
            <div 
                className={`w-full max-w-md rounded-2xl overflow-hidden shadow-2xl border ${bgMain} ${borderColor} animate-in zoom-in-95 slide-in-from-bottom-2 duration-200`}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className={`px-5 py-4 border-b ${borderColor} flex items-center justify-between`}>
                    <h2 className={`text-base font-bold ${textMain}`}>项目管理</h2>
                    <button 
                        onClick={onClose}
                        className={`p-1.5 rounded-lg transition-all ${isDark ? 'hover:bg-white/5 text-gray-400 hover:text-white' : 'hover:bg-gray-100 text-gray-500 hover:text-gray-900'}`}
                    >
                        <Icons.X size={16} />
                    </button>
                </div>

                {/* Tabs */}
                <div className={`px-5 pt-4`}>
                    <div className={`inline-flex p-1 rounded-lg ${isDark ? 'bg-[#1a1a1f]' : 'bg-gray-100'}`}>
                        {[
                            { id: 'export' as TabType, label: '导出', icon: Icons.Download },
                            { id: 'import' as TabType, label: '导入', icon: Icons.Upload },
                        ].map(tab => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-all flex items-center gap-1.5 ${
                                    activeTab === tab.id
                                        ? `${isDark ? 'bg-[#4446CE] text-white' : 'bg-white text-gray-900 shadow-sm'}`
                                        : `${textSub} ${isDark ? 'hover:text-white' : 'hover:text-gray-700'}`
                                }`}
                            >
                                <tab.icon size={12} />
                                {tab.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Content */}
                <div className="p-5 space-y-4">
                    {activeTab === 'export' ? (
                        <>
                            {/* Project Name */}
                            <div className="space-y-1.5">
                                <label className={`text-[10px] font-semibold uppercase tracking-wider ${textSub}`}>
                                    项目名称
                                </label>
                                <input
                                    type="text"
                                    value={localProjectName}
                                    onChange={(e) => setLocalProjectName(e.target.value)}
                                    className={`w-full px-3 py-2 rounded-lg text-sm outline-none border transition-all ${
                                        isDark 
                                            ? 'bg-[#131316] border-[#1f1f24] focus:border-[#4446CE]/50 text-white placeholder-gray-600'
                                            : 'bg-gray-50 border-gray-200 focus:border-[#4446CE] text-gray-900 placeholder-gray-400'
                                    }`}
                                    placeholder="输入项目名称..."
                                />
                            </div>

                            {/* Export Mode */}
                            <div className="space-y-2">
                                <label className={`text-[10px] font-semibold uppercase tracking-wider ${textSub}`}>
                                    导出方式
                                </label>
                                <div className="space-y-2">
                                    <button
                                        onClick={() => setExportMode('json')}
                                        className={`w-full p-3 rounded-lg border transition-all text-left ${
                                            exportMode === 'json'
                                                ? (isDark ? 'border-[#4446CE]/50 bg-[#4446CE]/5' : 'border-[#4446CE] bg-[#F0F1FF]')
                                                : (isDark ? 'border-[#1f1f24] hover:border-[#2a2a32] bg-[#131316]' : 'border-gray-200 hover:border-gray-300 bg-white')
                                        }`}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                                                exportMode === 'json' 
                                                    ? 'bg-[#4446CE]/20 text-[#4446CE]'
                                                    : (isDark ? 'bg-[#1f1f24] text-gray-500' : 'bg-gray-100 text-gray-400')
                                            }`}>
                                                <Icons.FileText size={16} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <h4 className={`text-sm font-medium ${textMain}`}>轻量导出</h4>
                                                <p className={`text-[11px] ${textMuted} truncate`}>导出为单个 .flow 文件</p>
                                            </div>
                                            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                                                exportMode === 'json'
                                                    ? 'border-[#4446CE] bg-[#4446CE]'
                                                    : (isDark ? 'border-zinc-600' : 'border-gray-300')
                                            }`}>
                                                {exportMode === 'json' && <Icons.Check size={10} className="text-white" />}
                                            </div>
                                        </div>
                                    </button>

                                    <button
                                        onClick={() => setExportMode('folder')}
                                        className={`w-full p-3 rounded-lg border transition-all text-left ${
                                            exportMode === 'folder'
                                                ? (isDark ? 'border-[#4446CE]/50 bg-[#4446CE]/5' : 'border-[#4446CE] bg-[#F0F1FF]')
                                                : (isDark ? 'border-[#1f1f24] hover:border-[#2a2a32] bg-[#131316]' : 'border-gray-200 hover:border-gray-300 bg-white')
                                        }`}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                                                exportMode === 'folder' 
                                                    ? 'bg-[#4446CE]/20 text-[#4446CE]'
                                                    : (isDark ? 'bg-[#1f1f24] text-gray-500' : 'bg-gray-100 text-gray-400')
                                            }`}>
                                                <Icons.FolderOpen size={16} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <h4 className={`text-sm font-medium ${textMain}`}>完整导出</h4>
                                                <p className={`text-[11px] ${textMuted} truncate`}>导出为文件夹（含资源）</p>
                                            </div>
                                            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                                                exportMode === 'folder'
                                                    ? 'border-[#4446CE] bg-[#4446CE]'
                                                    : (isDark ? 'border-zinc-600' : 'border-gray-300')
                                            }`}>
                                                {exportMode === 'folder' && <Icons.Check size={10} className="text-white" />}
                                            </div>
                                        </div>
                                    </button>
                                </div>
                            </div>

                            {/* Stats - Inline */}
                            <div className={`flex items-center justify-between px-3 py-2 rounded-lg ${isDark ? 'bg-[#131316]' : 'bg-gray-50'} border ${borderColor}`}>
                                <div className="flex items-center gap-4">
                                    <div className="flex items-center gap-1.5">
                                        <Icons.LayoutGrid size={12} className={textMuted} />
                                        <span className={`text-xs font-medium ${textMain}`}>{stats.totalNodes}</span>
                                        <span className={`text-[10px] ${textMuted}`}>节点</span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <Icons.Image size={12} className={textMuted} />
                                        <span className={`text-xs font-medium ${textMain}`}>{stats.imageNodes + stats.videoNodes}</span>
                                        <span className={`text-[10px] ${textMuted}`}>资源</span>
                                    </div>
                                </div>
                            </div>
                        </>
                    ) : (
                        <>
                            {/* Import Area */}
                            <div 
                                className={`relative p-6 rounded-xl border-2 border-dashed transition-all cursor-pointer group ${
                                    isDark 
                                        ? 'border-zinc-700 hover:border-[#4446CE]/50 bg-[#131316] hover:bg-[#4446CE]/5'
                                        : 'border-gray-300 hover:border-[#4446CE] bg-gray-50 hover:bg-[#F0F1FF]'
                                }`}
                                onClick={() => importInputRef.current?.click()}
                            >
                                <div className="flex flex-col items-center gap-3 text-center">
                                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${
                                        isDark ? 'bg-zinc-800 group-hover:bg-[#4446CE]/20' : 'bg-gray-200 group-hover:bg-[#E1E3FF]'
                                    }`}>
                                        <Icons.Upload size={22} className={`transition-colors ${isDark ? 'text-gray-500 group-hover:text-[#8F91F4]' : 'text-gray-400 group-hover:text-[#4446CE]'}`} />
                                    </div>
                                    <div>
                                        <p className={`text-sm font-medium ${textMain}`}>点击选择或拖拽文件</p>
                                        <p className={`text-[11px] mt-0.5 ${textMuted}`}>支持 .flow, .json 格式</p>
                                    </div>
                                </div>
                                <input
                                    ref={importInputRef}
                                    type="file"
                                    accept=".flow,.json,.aistudio-flow"
                                    onChange={handleImportFile}
                                    className="hidden"
                                />
                            </div>

                            {importError && (
                                <div className={`p-3 rounded-lg ${isDark ? 'bg-red-500/10 border border-red-500/20' : 'bg-red-50 border border-red-200'}`}>
                                    <div className="flex items-center gap-2">
                                        <Icons.AlertCircle size={14} className="text-red-500 shrink-0" />
                                        <p className={`text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`}>{importError}</p>
                                    </div>
                                </div>
                            )}

                            {/* Import Tips */}
                            <div className={`text-[11px] ${textMuted} space-y-1`}>
                                <p>• 导入将替换当前工作流内容</p>
                                <p>• 支持从其他设备导出的文件</p>
                            </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className={`px-5 py-3 border-t ${borderColor} flex items-center justify-end gap-2`}>
                    <button
                        onClick={onClose}
                        className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                            isDark ? 'text-gray-400 hover:text-white hover:bg-white/5' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                        }`}
                    >
                        取消
                    </button>
                    {activeTab === 'export' && (
                        <button
                            onClick={handleExport}
                            disabled={isExporting || !localProjectName.trim()}
                            className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                                isExporting || !localProjectName.trim()
                                    ? 'bg-[#4446CE]/50 text-white/50 cursor-not-allowed'
                                    : 'bg-[#4446CE] hover:bg-[#4446CE] text-white'
                            }`}
                        >
                            {isExporting ? (
                                <Icons.Loader2 size={14} className="animate-spin" />
                            ) : (
                                <Icons.Download size={14} />
                            )}
                            {isExporting ? '导出中...' : '导出'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
