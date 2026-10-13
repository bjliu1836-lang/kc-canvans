import { Sparkles } from "lucide-react";
import { useDirectorStore } from "../store/directorStore";
import { selectRightPanelKind } from "../store/directorSelectors";
import { useLayoutDraftPreviewStore } from "../store/layoutDraftPreviewStore";
import { CameraPanel } from "./CameraPanel";
import { CharacterPanel } from "./CharacterPanel";
import { PropPanel } from "./PropPanel";
import { ScenePanel } from "./ScenePanel";

export function RightPanel() {
  const panelKind = useDirectorStore(selectRightPanelKind);
  const openSceneInspector = useDirectorStore((state) => state.openSceneInspector);
  const draft = useLayoutDraftPreviewStore((state) => state.draft);

  const panel = panelKind === "character"
    ? <CharacterPanel />
    : panelKind === "prop"
      ? <PropPanel />
      : panelKind === "camera"
        ? <CameraPanel />
        : <ScenePanel />;

  return (
    <div className="right-panel-stack">
      {draft && panelKind !== "scene" ? (
        <button
          aria-label="返回待应用布景"
          className="pending-layout-resume-button"
          type="button"
          onClick={openSceneInspector}
        >
          <Sparkles aria-hidden="true" size={14} />
          <span>待应用布景</span>
          <small>{draft.components.length} 组件 / {draft.characters.length} 人物</small>
        </button>
      ) : null}
      {panel}
    </div>
  );
}
