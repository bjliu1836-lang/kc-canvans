import { Circle, CornerDownLeft, Crosshair, LogOut, Pause, Play, RotateCcw, Save, Square } from "lucide-react";
import type { CameraPilotMode } from "../store/directorStore";

export function PilotHud({
  lockedTargetName,
  onExit,
  onRecord,
  onToggleRecording,
  pointedTargetName,
  recording,
  recordingSeconds,
}: {
  lockedTargetName: string | null;
  mode: Exclude<CameraPilotMode, "idle">;
  onExit: () => void;
  onRecord: () => void;
  onToggleRecording: () => void;
  pointedTargetName: string | null;
  recording: boolean;
  recordingSeconds: number;
}) {
  const targetName = lockedTargetName ?? pointedTargetName;
  const crosshairLabel = lockedTargetName
    ? `掌镜准星，已锁定${lockedTargetName}`
    : pointedTargetName
      ? `掌镜准星，当前对准${pointedTargetName}`
      : "掌镜准星，按 F 锁定当前空间点";

  return (
    <div className="pilot-hud" aria-label="第一人称掌镜控制层">
      <div className="pilot-status" role="status">
        <span className="pilot-status-dot" />
        {recording ? `拍摄中 ${recordingSeconds.toFixed(1)} 秒` : "准备掌镜"}
      </div>

      <div className={`pilot-crosshair${lockedTargetName ? " is-locked" : targetName ? " is-pointing" : ""}`} aria-label={crosshairLabel}>
        <span className="pilot-crosshair-line is-top" />
        <span className="pilot-crosshair-line is-right" />
        <span className="pilot-crosshair-line is-bottom" />
        <span className="pilot-crosshair-line is-left" />
        <span className="pilot-crosshair-center" />
        {targetName ? (
          <span className="pilot-target-name">
            <Crosshair aria-hidden="true" size={13} />
            {lockedTargetName ? `已锁定：${targetName}` : `${targetName} · 按 F 锁定`}
          </span>
        ) : (
          <span className="pilot-target-name">
            <Crosshair aria-hidden="true" size={13} />
            空白空间 · 按 F 锁定
          </span>
        )}
      </div>

      <div className="pilot-keyboard-help" aria-label="掌镜快捷键">
        <span><kbd>W A S D</kbd> 移动</span>
        <span>点击画面锁定鼠标</span>
        <span><kbd>E</kbd> 上升 · <kbd>Q</kbd> 下降</span>
        <span><kbd>空格</kbd> 播放/暂停</span>
        <span><kbd>R</kbd> {recording ? "结束拍摄" : "开始拍摄"}</span>
        <span><kbd>F</kbd> 锁定主体 / 空间点</span>
        <span><kbd>滚轮</kbd> 调整远近</span>
      </div>

      <div className="pilot-hud-actions">
        <button type="button" className="pilot-hud-secondary" onClick={onExit} aria-label="退出掌镜模式">
          <LogOut aria-hidden="true" size={15} />
          Esc 退出
        </button>
        <button type="button" className="pilot-hud-secondary" disabled={recording} onClick={onRecord} aria-label="记录当前轨迹点">
          <CornerDownLeft aria-hidden="true" size={15} />
          Enter 手动加点
        </button>
        <button type="button" className="pilot-hud-primary" onClick={onToggleRecording} aria-label={recording ? "结束拍摄" : "开始拍摄"}>
          {recording ? <Square aria-hidden="true" size={15} /> : <Circle aria-hidden="true" size={15} />}
          {recording ? "结束拍摄" : "开始拍摄"}
        </button>
      </div>
    </div>
  );
}

export function TakeReviewHud({
  duration,
  holdsLastFrame,
  onDiscard,
  onKeep,
  onRestartPlayback,
  onReshoot,
  onTogglePlayback,
  playbackSeconds,
  playing,
}: {
  duration: number;
  holdsLastFrame: boolean;
  onDiscard: () => void;
  onKeep: () => void;
  onRestartPlayback: () => void;
  onReshoot: () => void;
  onTogglePlayback: () => void;
  playbackSeconds: number;
  playing: boolean;
}) {
  return (
    <div className="pilot-hud pilot-take-review" aria-label="拍摄回放确认">
      <div className="pilot-status" role="status"><span className="pilot-status-dot" />临时回放 {playbackSeconds.toFixed(1)} / {duration.toFixed(1)} 秒</div>
      <div className="pilot-take-review__notes">
        <p>这次运镜尚未覆盖已保存路线。</p>
        {holdsLastFrame ? <p>保留后，相机将在剩余表演中保持最后机位。</p> : null}
      </div>
      <div className="pilot-hud-actions">
        <button type="button" className="pilot-hud-secondary" onClick={onRestartPlayback} aria-label="从头回放这次拍摄"><RotateCcw aria-hidden="true" size={15} />从头回放</button>
        <button type="button" className="pilot-hud-secondary" onClick={onTogglePlayback} aria-label={playing ? "暂停这次拍摄回放" : "继续这次拍摄回放"}>{playing ? <Pause aria-hidden="true" size={15} /> : <Play aria-hidden="true" size={15} />}{playing ? "暂停" : "继续"}</button>
        <button type="button" className="pilot-hud-secondary" onClick={onDiscard} aria-label="放弃这次拍摄"><LogOut aria-hidden="true" size={15} />放弃</button>
        <button type="button" className="pilot-hud-secondary" onClick={onReshoot} aria-label="重新拍摄"><RotateCcw aria-hidden="true" size={15} />重新拍摄</button>
        <button type="button" className="pilot-hud-primary" onClick={onKeep} aria-label="保留这次运镜"><Save aria-hidden="true" size={15} />保留这次运镜</button>
      </div>
    </div>
  );
}
