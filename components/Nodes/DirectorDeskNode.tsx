import React from 'react';
import { NodeData } from '../../types';
import { Icons } from '../Icons';

interface DirectorDeskNodeProps {
  data: NodeData;
  selected?: boolean;
  isDark?: boolean;
  onOpenDirectorDesk?: (nodeId: string) => void;
}

export const DirectorDeskNode: React.FC<DirectorDeskNodeProps> = ({
  data,
  selected,
  isDark = true,
  onOpenDirectorDesk,
}) => {
  const panelBg = isDark ? 'bg-[#1a1a1a]' : 'bg-white';
  const border = selected ? 'border-[#4446CE] ring-2 ring-[#4446CE]/30' : (isDark ? 'border-zinc-700/50' : 'border-gray-200');
  const textMain = isDark ? 'text-zinc-100' : 'text-gray-900';
  const textSub = isDark ? 'text-zinc-400' : 'text-gray-500';
  const mutedPanel = isDark ? 'bg-zinc-900/70 border-zinc-800' : 'bg-gray-50 border-gray-200';

  return (
    <div className={`relative flex h-full w-full flex-col overflow-hidden rounded-2xl border ${border} ${panelBg} shadow-xl transition-all duration-200`}>
      <div className="flex items-start justify-between gap-3 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#8F91F4]/30 bg-[#4446CE]/15 text-[#B9BAFF]">
            <Icons.Clapperboard size={22} />
          </div>
          <div className="min-w-0">
            <div className={`truncate text-sm font-semibold ${textMain}`}>{data.title || '3D导演台'}</div>
            <div className={`mt-1 text-xs ${textSub}`}>场景预演与镜头摆位</div>
          </div>
        </div>
      </div>

      <div className={`mx-4 flex flex-1 items-center justify-center rounded-xl border ${mutedPanel}`}>
        {data.directorDeskLastCaptureUrl ? (
          <img
            src={data.directorDeskLastCaptureUrl}
            alt="导演台最近截图"
            className="h-full w-full rounded-xl object-cover"
            draggable={false}
          />
        ) : (
          <div className={`flex flex-col items-center text-center ${textSub}`}>
            <Icons.Box size={30} className="mb-2 opacity-60" />
            <span className="text-xs">打开导演台编排 3D 场景</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 p-4">
        <span className={`truncate text-[11px] ${textSub}`}>
          截图会回到画布旁边生成图片节点
        </span>
        <button
          type="button"
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-[#4446CE] px-3 text-xs font-semibold text-white shadow-lg shadow-[#4446CE]/20 transition-colors hover:bg-[#3739B0]"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onOpenDirectorDesk?.(data.id);
          }}
        >
          <Icons.Maximize2 size={14} />
          <span>进入</span>
        </button>
      </div>
    </div>
  );
};
