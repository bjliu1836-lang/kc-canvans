import React, { memo } from 'react';
import { ImageVersionSnapshot, InputMedia, MultiAngleOptions, NodeData, NodeType } from '../../types';
import { TextToImageNode } from './TextToImageNode';
import { TextToVideoNode } from './TextToVideoNode';
import { OriginalImageNode } from './OriginalImageNode';
import { CreativeDescNode } from './CreativeDescNode';
import { TextToAudioNode } from './TextToAudioNode';
import { DirectorDeskNode } from './DirectorDeskNode';

interface NodeContentProps {
  data: NodeData;
  updateData: (id: string, updates: Partial<NodeData>) => void;
  onGenerate: (id: string) => void;
  selected?: boolean;
  showControls?: boolean;
  inputs?: string[];
  onMaximize?: (id: string) => void;
  onPreviewMedia?: (url: string, type: 'image' | 'video') => void;
  onSetImageVersion?: (nodeId: string, version: ImageVersionSnapshot) => void;
  onUseImageVersion?: (nodeId: string, version: ImageVersionSnapshot) => void;
  onUseVideoVersion?: (nodeId: string, src: string) => void;
  onDownload?: (id: string) => void;
  onUpload?: (nodeId: string) => void;
  onSaveResult?: (nodeId: string) => void;
  onCrop?: (nodeId: string) => void;
  onMultiAngle?: (nodeId: string, options: MultiAngleOptions) => void;
  onAnalyzeMedia?: (nodeId: string) => void;
  onAnalyzeScript?: (nodeId: string) => void;
  onPreviewReference?: (item: InputMedia) => void;
  onExtractFrames?: (nodeId: string) => void;
  onExtractSingleFrame?: (nodeId: string, imageDataUrl: string, timeSeconds: number) => void;
  onEditVideo?: (nodeId: string) => void;
  onRemoveSubtitles?: (nodeId: string) => void;
  onEnhanceVideo?: (nodeId: string) => void;
  onRemoveBGM?: (nodeId: string) => void;
  onMultiGrid?: (nodeId: string, preset: string) => void;
  onRepaint?: (nodeId: string) => void;
  onLighting?: (nodeId: string) => void;
  onEnhanceImage?: (nodeId: string, resolution: '2K' | '4K') => void;
  onOpenDirectorDesk?: (nodeId: string) => void;
  onPanorama?: (nodeId: string) => void;
  onToggleFavoriteArtifact?: (nodeId: string, url: string, type: 'image' | 'video') => void;
  isArtifactFavorited?: (nodeId: string, url: string) => boolean;
  isSelecting?: boolean;
  onDelete?: (id: string) => void;
  onAddToAssetLibrary?: (nodeId: string) => void;
  isDark?: boolean;
  inputMedia?: InputMedia[];
  canvasScale?: number;
}

const NodeContentComponent: React.FC<NodeContentProps> = (props) => {
    const { data } = props;

    switch (data.type) {
        case NodeType.TEXT_TO_IMAGE:
            return <TextToImageNode {...props} />;
        case NodeType.TEXT_TO_VIDEO:
        case NodeType.IMAGE_TO_VIDEO:
        case NodeType.START_END_TO_VIDEO:
            return <TextToVideoNode {...props} />;
        case NodeType.TEXT_TO_AUDIO:
            return <TextToAudioNode {...props} />;
        case NodeType.ORIGINAL_IMAGE:
            return <OriginalImageNode {...props} />;
        case NodeType.CREATIVE_DESC:
            return <CreativeDescNode {...props} />;
        case NodeType.DIRECTOR_DESK:
            return <DirectorDeskNode {...props} />;
        default:
            return null;
    }
};

export const NodeContent = memo(NodeContentComponent, (prev, next) => {
    if (prev.isSelecting !== next.isSelecting) return false;
    if (prev.isDark !== next.isDark) return false;
    // canvasScale intentionally NOT compared: zoom counter-scaling is handled by the
    // --panel-inverse-scale CSS var (see each node's panelTransform), so changing zoom must
    // never re-render heavy nodes (large base64 media stays off the gesture hot path).

    // Check Inputs
    if (prev.inputs !== next.inputs) {
         if (prev.inputs?.length !== next.inputs?.length) return false;
         if (prev.inputs && next.inputs) { 
             for (let i = 0; i < prev.inputs.length; i++) { 
                 if (prev.inputs[i] !== next.inputs[i]) return false; 
             } 
         }
    }

    if (prev.inputMedia !== next.inputMedia) {
        if (prev.inputMedia?.length !== next.inputMedia?.length) return false;
        if (prev.inputMedia && next.inputMedia) {
            for (let i = 0; i < prev.inputMedia.length; i++) {
                if (
                    prev.inputMedia[i].type !== next.inputMedia[i].type ||
                    prev.inputMedia[i].url !== next.inputMedia[i].url ||
                    prev.inputMedia[i].text !== next.inputMedia[i].text
                ) return false;
            }
        }
    }
    
    // Check Selection/Visibility State
    if (prev.selected !== next.selected || prev.showControls !== next.showControls) return false;

    // Check Data *Excluding* X/Y to prevent re-renders on drag
    if (prev.data === next.data) return true;
    
    const keys = Object.keys(prev.data) as (keyof NodeData)[];
    // Check if keys length changed (rare but possible)
    if (keys.length !== Object.keys(next.data).length) return false;

    for (const key of keys) {
        if (key === 'x' || key === 'y') continue;
        if (prev.data[key] !== next.data[key]) return false;
    }
    
    return true;
});
