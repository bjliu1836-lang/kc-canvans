import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { InputMedia, VideoGenerationMode, VideoPromptReference } from '../../../types';
import { Icons } from '../../Icons';

const MEDIA_LABELS = {
    image: '图片',
    video: '视频',
    audio: '音频',
} as const;

const getReferenceId = (item: InputMedia) =>
    item.id || `${item.sourceNodeId || 'media'}:${item.type}:${item.url}`;

const toReference = (item: InputMedia, offset?: number): VideoPromptReference => ({
    id: getReferenceId(item),
    sourceNodeId: item.sourceNodeId || getReferenceId(item),
    type: item.type as VideoPromptReference['type'],
    url: item.url,
    title: item.title,
    offset,
});

const ReferencePreview: React.FC<{ reference: VideoPromptReference; invalid?: boolean }> = ({ reference, invalid }) => {
    if (reference.type === 'image') {
        return <img src={reference.url} className="h-7 w-7 rounded-md object-cover" draggable={false} />;
    }
    if (reference.type === 'video') {
        return (
            <span className="relative h-7 w-7 overflow-hidden rounded-md bg-black">
                <video src={reference.url} className="h-full w-full object-cover" muted preload="metadata" />
                <Icons.Play size={10} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white" fill="currentColor" />
            </span>
        );
    }
    return (
        <span className={`flex h-7 w-7 items-center justify-center rounded-md ${invalid ? 'bg-red-500/15 text-red-300' : 'bg-violet-500/15 text-violet-300'}`}>
            <Icons.Music size={14} />
        </span>
    );
};

interface VideoReferencePromptEditorProps {
    value: string;
    onChange: (value: string) => void;
    references: VideoPromptReference[] | undefined;
    onReferencesChange: (references: VideoPromptReference[]) => void;
    inputMedia: InputMedia[];
    mode: VideoGenerationMode;
    placeholder: string;
    isDark: boolean;
    onPreviewReference?: (item: InputMedia) => void;
    allowExpand?: boolean;
    headerContent?: React.ReactNode;
    referenceHint?: string;
    expandedTitle?: string;
    showReferenceHint?: boolean;
}

interface ExtractedEditorState {
    text: string;
    positions: Array<{ id: string; offset: number }>;
}

const extractEditorState = (root: ParentNode): ExtractedEditorState => {
    let text = '';
    const positions: Array<{ id: string; offset: number }> = [];

    const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            text += (node.textContent || '').replace(/\u200B/g, '');
            return;
        }
        if (!(node instanceof HTMLElement)) {
            node.childNodes.forEach(walk);
            return;
        }

        const referenceId = node.dataset.videoReferenceId;
        if (referenceId) {
            positions.push({ id: referenceId, offset: text.length });
            return;
        }
        if (node.tagName === 'BR') {
            text += '\n';
            return;
        }

        const isBlock = node.tagName === 'DIV' || node.tagName === 'P';
        if (isBlock && text && !text.endsWith('\n')) text += '\n';
        node.childNodes.forEach(walk);
    };

    root.childNodes.forEach(walk);
    return { text, positions };
};

const referenceSignature = (
    value: string,
    references: VideoPromptReference[],
    connectedIds: Set<string>,
    presentationSignature: string,
) =>
    JSON.stringify([
        value,
        presentationSignature,
        references.map(reference => [
            reference.id,
            reference.offset ?? value.length,
            reference.url,
            reference.title || '',
            connectedIds.has(reference.id),
        ]),
    ]);

export const VideoReferencePromptEditor: React.FC<VideoReferencePromptEditorProps> = ({
    value,
    onChange,
    references,
    onReferencesChange,
    inputMedia,
    mode,
    placeholder,
    isDark,
    onPreviewReference,
    allowExpand = true,
    headerContent,
    referenceHint,
    expandedTitle = '编辑视频提示词',
    showReferenceHint = true,
}) => {
    const editorRef = useRef<HTMLDivElement>(null);
    const lastRenderedSignatureRef = useRef('');
    const pendingCaretReferenceIdRef = useRef<string | null>(null);
    const [mentionStart, setMentionStart] = useState<number | null>(null);
    const [mentionCaret, setMentionCaret] = useState<number | null>(null);
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const [isExpanded, setIsExpanded] = useState(false);

    const allowedTypes = useMemo(() => {
        if (mode === 'image') return new Set<InputMedia['type']>(['image']);
        if (mode === 'omni') return new Set<InputMedia['type']>(['image', 'video', 'audio']);
        return new Set<InputMedia['type']>();
    }, [mode]);

    const availableMedia = useMemo(() => {
        const seen = new Set<string>();
        return inputMedia.filter(item => {
            if (!allowedTypes.has(item.type)) return false;
            const id = getReferenceId(item);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        });
    }, [allowedTypes, inputMedia]);

    const filteredMedia = useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        return availableMedia.filter(item => {
            if (!normalizedQuery) return true;
            return `${item.title || ''} ${MEDIA_LABELS[item.type as keyof typeof MEDIA_LABELS] || ''}`
                .toLowerCase()
                .includes(normalizedQuery);
        });
    }, [availableMedia, query]);

    const connectedIds = useMemo(() => new Set(inputMedia.map(getReferenceId)), [inputMedia]);
    const connectedMediaById = useMemo(
        () => new Map(inputMedia.map(item => [getReferenceId(item), item])),
        [inputMedia],
    );
    const allReferences: VideoPromptReference[] = references || [];
    const visibleReferences = allReferences.filter(reference => allowedTypes.has(reference.type));
    const hiddenReferences = allReferences.filter(reference => !allowedTypes.has(reference.type));
    const referenceById = new Map<string, VideoPromptReference>(
        allReferences.map(reference => [reference.id, reference] as [string, VideoPromptReference]),
    );
    const selectedIds = new Set(allReferences.map(reference => reference.id));
    const showMention = mentionStart !== null;
    const presentationSignature = `${isDark ? 'dark' : 'light'}:${inputMedia
        .map(item => `${getReferenceId(item)}:${item.url}:${item.title || ''}`)
        .join('|')}`;

    const closeMention = () => {
        setMentionStart(null);
        setMentionCaret(null);
        setQuery('');
        setActiveIndex(0);
    };

    const createReferenceChip = (reference: VideoPromptReference) => {
        const connectedItem = connectedMediaById.get(reference.id);
        const displayReference = connectedItem ? toReference(connectedItem, reference.offset) : reference;
        const invalid = !connectedIds.has(reference.id);
        const chip = document.createElement('span');
        chip.dataset.videoReferenceId = reference.id;
        chip.contentEditable = 'false';
        chip.title = invalid ? '素材连接已断开' : displayReference.title || MEDIA_LABELS[displayReference.type];
        chip.className = `mx-1 inline-flex h-8 max-w-[180px] select-none items-center gap-1.5 rounded-lg border p-0.5 pr-1.5 align-middle text-[11px] font-semibold transition-colors ${
            invalid
                ? 'border-red-500/30 bg-red-500/10 text-red-300'
                : isDark
                    ? 'border-zinc-600 bg-zinc-950/85 text-zinc-200 hover:border-[#8F91F4] hover:bg-[#4446CE]/15'
                    : 'border-gray-200 bg-white text-gray-700 hover:border-[#4446CE] hover:bg-[#F0F1FF]'
        }`;
        if (displayReference.type === 'audio' || displayReference.type === 'video') {
            chip.className += ' cursor-pointer';
            chip.title = displayReference.type === 'audio' ? '点击播放音频' : '点击放大视频';
        }

        if (displayReference.type === 'image') {
            const image = document.createElement('img');
            image.src = displayReference.url;
            image.draggable = false;
            image.className = 'h-7 w-7 rounded-md object-cover';
            chip.appendChild(image);
        } else if (displayReference.type === 'video') {
            const video = document.createElement('video');
            video.src = displayReference.url;
            video.muted = true;
            video.preload = 'metadata';
            video.className = 'h-7 w-7 rounded-md bg-black object-cover';
            chip.appendChild(video);
        } else {
            const icon = document.createElement('span');
            icon.className = `flex h-7 w-7 items-center justify-center rounded-md text-[10px] ${
                invalid ? 'bg-red-500/15 text-red-300' : 'bg-violet-500/15 text-violet-300'
            }`;
            icon.textContent = '音频';
            chip.appendChild(icon);
        }

        const label = document.createElement('span');
        label.className = 'max-w-[105px] truncate';
        label.textContent = displayReference.title || MEDIA_LABELS[displayReference.type];
        chip.appendChild(label);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.dataset.removeReference = reference.id;
        remove.className = 'flex h-5 w-5 shrink-0 items-center justify-center rounded text-sm leading-none hover:bg-white/10';
        remove.title = '移除引用';
        remove.textContent = '×';
        chip.appendChild(remove);
        return chip;
    };

    const renderEditor = () => {
        const editor = editorRef.current;
        if (!editor) return;
        const ordered = visibleReferences
            .map((reference, index) => ({
                reference,
                index,
                offset: Math.max(0, Math.min(value.length, reference.offset ?? value.length)),
            }))
            .sort((a, b) => a.offset - b.offset || a.index - b.index);

        editor.replaceChildren();
        let cursor = 0;
        ordered.forEach(({ reference, offset }) => {
            if (offset > cursor) editor.appendChild(document.createTextNode(value.slice(cursor, offset)));
            editor.appendChild(createReferenceChip(reference));
            cursor = offset;
        });
        if (cursor < value.length) editor.appendChild(document.createTextNode(value.slice(cursor)));

        const pendingReferenceId = pendingCaretReferenceIdRef.current;
        if (pendingReferenceId) {
            pendingCaretReferenceIdRef.current = null;
            const chips = editor.querySelectorAll('[data-video-reference-id]') as NodeListOf<HTMLElement>;
            let chip: HTMLElement | undefined;
            chips.forEach(item => {
                if (item.dataset.videoReferenceId === pendingReferenceId) chip = item;
            });
            if (chip) {
                const range = document.createRange();
                const selection = window.getSelection();
                range.setStartAfter(chip);
                range.collapse(true);
                selection?.removeAllRanges();
                selection?.addRange(range);
                editor.focus();
            }
        }
    };

    const desiredSignature = referenceSignature(value, visibleReferences, connectedIds, presentationSignature);
    useLayoutEffect(() => {
        if (lastRenderedSignatureRef.current === desiredSignature) return;
        renderEditor();
        lastRenderedSignatureRef.current = desiredSignature;
    }, [desiredSignature]);

    const getCaretOffset = () => {
        const editor = editorRef.current;
        const selection = window.getSelection();
        if (!editor || !selection?.rangeCount || !editor.contains(selection.anchorNode)) return value.length;
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.setEnd(selection.anchorNode!, selection.anchorOffset);
        return extractEditorState(range.cloneContents()).text.length;
    };

    const updateMention = (nextValue: string, caret: number) => {
        if (allowedTypes.size === 0) {
            closeMention();
            return;
        }
        const match = nextValue.slice(0, caret).match(/@([^\s@]*)$/);
        if (!match) {
            closeMention();
            return;
        }
        setMentionStart(caret - match[0].length);
        setMentionCaret(caret);
        setQuery(match[1]);
        setActiveIndex(0);
    };

    const commitEditorState = () => {
        const editor = editorRef.current;
        if (!editor) return;
        const extracted = extractEditorState(editor);
        const nextVisibleReferences = extracted.positions
            .map<VideoPromptReference | undefined>(position => {
                const reference = referenceById.get(position.id);
                return reference ? { ...reference, offset: position.offset } : undefined;
            })
            .filter((reference): reference is VideoPromptReference => reference !== undefined);
        const nextReferences = [...hiddenReferences, ...nextVisibleReferences];
        lastRenderedSignatureRef.current = referenceSignature(
            extracted.text,
            nextVisibleReferences,
            connectedIds,
            presentationSignature,
        );
        if (extracted.text !== value) onChange(extracted.text);
        if (JSON.stringify(nextReferences) !== JSON.stringify(allReferences)) onReferencesChange(nextReferences);
        updateMention(extracted.text, getCaretOffset());
    };

    const selectMedia = (item: InputMedia) => {
        if (mentionStart === null || mentionCaret === null) return;
        const nextValue = `${value.slice(0, mentionStart)}${value.slice(mentionCaret)}`;
        const removedLength = mentionCaret - mentionStart;
        const shiftedReferences = allReferences
            .filter(reference => reference.id !== getReferenceId(item))
            .map(reference => {
                const offset = reference.offset ?? value.length;
                return {
                    ...reference,
                    offset: offset > mentionCaret ? offset - removedLength : offset,
                };
            });
        const nextReference = toReference(item, mentionStart);
        const nextReferences = [...shiftedReferences, nextReference];
        pendingCaretReferenceIdRef.current = nextReference.id;
        onChange(nextValue);
        onReferencesChange(nextReferences);
        closeMention();
    };

    const groupedMedia = useMemo(() => {
        return (['image', 'video', 'audio'] as const)
            .map(type => ({ type, items: filteredMedia.filter(item => item.type === type) }))
            .filter(group => group.items.length > 0);
    }, [filteredMedia]);

    const border = isDark
        ? 'border-zinc-700/80 bg-gradient-to-b from-zinc-800/90 to-zinc-900/85 text-zinc-100 shadow-inner shadow-black/10'
        : 'border-gray-200 bg-gradient-to-b from-white to-gray-50 text-gray-900 shadow-inner shadow-gray-200/40';

    return (
        <div className={`relative cursor-default select-text ${allowExpand ? '' : 'h-full'}`}>
            <div className={`${allowExpand ? 'min-h-[126px]' : 'h-full min-h-[420px]'} cursor-text select-text rounded-[14px] border px-3.5 py-3 transition-all focus-within:border-[#4446CE]/80 focus-within:ring-2 focus-within:ring-[#4446CE]/15 ${border}`}>
                {allowExpand && (
                    <button
                        type="button"
                        className={`absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border ${
                            isDark ? 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white' : 'border-gray-200 bg-white text-gray-500 hover:text-gray-900'
                        }`}
                        title="展开编辑"
                        onClick={() => setIsExpanded(true)}
                    >
                        <Icons.Maximize2 size={12} />
                    </button>
                )}
                {headerContent && <div className="mb-2.5 pr-8">{headerContent}</div>}
                <div
                    ref={editorRef}
                    contentEditable
                    suppressContentEditableWarning
                    role="textbox"
                    aria-multiline="true"
                    data-placeholder={placeholder}
                    className={`${allowExpand ? 'min-h-[68px]' : 'min-h-[330px]'} cursor-text select-text whitespace-pre-wrap break-words bg-transparent pr-7 text-sm leading-8 outline-none empty:before:pointer-events-none empty:before:text-zinc-500 empty:before:content-[attr(data-placeholder)]`}
                    onInput={commitEditorState}
                    onKeyDown={event => {
                        event.stopPropagation();
                        if (!showMention) return;
                        if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            setActiveIndex(index => Math.min(Math.max(0, filteredMedia.length - 1), index + 1));
                        } else if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            setActiveIndex(index => Math.max(0, index - 1));
                        } else if (event.key === 'Enter' && filteredMedia[activeIndex]) {
                            event.preventDefault();
                            selectMedia(filteredMedia[activeIndex]);
                        } else if (event.key === 'Escape') {
                            event.preventDefault();
                            closeMention();
                        }
                    }}
                    onKeyUp={() => updateMention(extractEditorState(editorRef.current!).text, getCaretOffset())}
                    onMouseUp={() => updateMention(extractEditorState(editorRef.current!).text, getCaretOffset())}
                    onMouseDown={event => {
                        event.stopPropagation();
                        const target = event.target as HTMLElement;
                        const removeButton = target.closest<HTMLElement>('[data-remove-reference]');
                        if (removeButton?.dataset.removeReference) {
                            event.preventDefault();
                            onReferencesChange(allReferences.filter(reference => reference.id !== removeButton.dataset.removeReference));
                            closeMention();
                            return;
                        }
                        const chip = target.closest<HTMLElement>('[data-video-reference-id]');
                        const reference = allReferences.find(item => item.id === chip?.dataset.videoReferenceId);
                        if (!reference || (reference.type !== 'audio' && reference.type !== 'video')) return;
                        event.preventDefault();
                        onPreviewReference?.({
                            id: reference.id,
                            sourceNodeId: reference.sourceNodeId,
                            type: reference.type,
                            url: reference.url,
                            title: reference.title,
                        });
                    }}
                    onWheelCapture={event => event.stopPropagation()}
                    onPaste={event => {
                        event.preventDefault();
                        document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
                    }}
                />
                {allowedTypes.size > 0 && showReferenceHint && (
                    <div className={`mt-1 text-[10px] ${isDark ? 'text-zinc-500' : 'text-gray-400'}`}>
                        {referenceHint || `输入 @ 引用当前节点已连接的${mode === 'image' ? '图片' : '图片、视频或音频'}`}
                    </div>
                )}
            </div>

            {showMention && (
                <div
                    className={`absolute left-2 top-[calc(100%-8px)] z-[160] w-[330px] overflow-hidden rounded-xl border shadow-2xl ${
                        isDark ? 'border-zinc-700 bg-[#202020] text-zinc-100' : 'border-gray-200 bg-white text-gray-900'
                    }`}
                    onMouseDown={event => event.stopPropagation()}
                >
                    <div className={`flex items-center gap-2 border-b px-3 py-2 text-xs ${isDark ? 'border-zinc-800 text-zinc-400' : 'border-gray-100 text-gray-500'}`}>
                        <Icons.Search size={13} />
                        <span>{query ? `搜索“${query}”` : '选择当前节点已连接的素材'}</span>
                    </div>
                    <div className="custom-scrollbar max-h-[260px] overflow-y-auto p-1.5">
                        {groupedMedia.length === 0 ? (
                            <div className={`px-3 py-6 text-center text-xs ${isDark ? 'text-zinc-500' : 'text-gray-400'}`}>没有可引用的素材</div>
                        ) : groupedMedia.map(group => (
                            <div key={group.type}>
                                <div className={`px-2 py-1 text-[10px] font-bold ${isDark ? 'text-zinc-500' : 'text-gray-400'}`}>{MEDIA_LABELS[group.type]}</div>
                                {group.items.map(item => {
                                    const flatIndex = filteredMedia.indexOf(item);
                                    const reference = toReference(item);
                                    return (
                                        <button
                                            key={reference.id}
                                            type="button"
                                            className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
                                                flatIndex === activeIndex
                                                    ? 'bg-[#4446CE]/20 text-[#B9BAFF]'
                                                    : isDark ? 'hover:bg-zinc-800' : 'hover:bg-gray-100'
                                            }`}
                                            onMouseEnter={() => setActiveIndex(flatIndex)}
                                            onClick={() => selectMedia(item)}
                                        >
                                            <ReferencePreview reference={reference} />
                                            <span className="min-w-0 flex-1 truncate text-xs font-medium">{item.title || MEDIA_LABELS[group.type]}</span>
                                            {selectedIds.has(reference.id) && <Icons.Check size={13} className="text-[#8F91F4]" />}
                                        </button>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {allowExpand && isExpanded && createPortal(
                <div
                    className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
                    onMouseDown={() => setIsExpanded(false)}
                >
                    <div
                        className={`flex h-[min(680px,calc(100vh-48px))] w-[min(960px,calc(100vw-48px))] flex-col rounded-2xl border p-4 shadow-2xl ${
                            isDark ? 'border-zinc-700 bg-[#1b1b1b]' : 'border-gray-200 bg-white'
                        }`}
                        onMouseDown={event => event.stopPropagation()}
                    >
                        <div className="mb-3 flex items-center justify-between">
                            <span className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{expandedTitle}</span>
                            <button
                                type="button"
                                className={`flex h-8 w-8 items-center justify-center rounded-lg ${isDark ? 'text-zinc-400 hover:bg-zinc-800 hover:text-white' : 'text-gray-500 hover:bg-gray-100'}`}
                                onClick={() => setIsExpanded(false)}
                            >
                                <Icons.X size={16} />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1">
                            <VideoReferencePromptEditor
                                value={value}
                                onChange={onChange}
                                references={references}
                                onReferencesChange={onReferencesChange}
                                inputMedia={inputMedia}
                                mode={mode}
                                placeholder={placeholder}
                                isDark={isDark}
                                onPreviewReference={onPreviewReference}
                                allowExpand={false}
                                headerContent={headerContent}
                            />
                        </div>
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
};
