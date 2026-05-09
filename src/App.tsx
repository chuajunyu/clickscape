import { type PointerEvent, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PROMPT,
  checkHiddenTargetSatisfied,
  enterTarget,
  generateHiddenTarget,
  getWorldHistory,
  getWorldNode,
  type HiddenTarget,
  type HiddenTargetCheckResult,
  type NodeEntry,
  type NodePayload,
  startWorld as startWorldRequest,
  type WorldSummary,
} from "./mockApi";

type PannellumHotSpot = {
  id?: string;
  pitch: number;
  yaw: number;
  type?: "custom";
  cssClass?: string;
  createTooltipFunc?: (element: HTMLElement, args: unknown) => void;
  createTooltipArgs?: unknown;
  clickHandlerFunc?: (event: MouseEvent, args: unknown) => void;
  clickHandlerArgs?: unknown;
};

type PannellumViewer = {
  destroy: () => void;
  mouseEventToCoords: (event: MouseEvent) => [number, number];
  addHotSpot: (hotSpot: PannellumHotSpot) => void;
  removeHotSpot: (hotSpotId: string) => void;
  getPitch: () => number;
  getYaw: () => number;
};

declare global {
  interface Window {
    pannellum?: {
      viewer: (
        elementId: string,
        options: {
          type: "equirectangular";
          panorama: string;
          autoLoad: boolean;
          showZoomCtrl: boolean;
          showFullscreenCtrl: boolean;
          pitch: number;
          yaw: number;
          hfov: number;
          hotSpots?: PannellumHotSpot[];
        }
      ) => PannellumViewer;
    };
  }
}

const CLICK_MOVE_THRESHOLD_PX = 6;
const CLICK_TIME_THRESHOLD_MS = 350;

type PointerStart = {
  x: number;
  y: number;
  time: number;
  pointerId: number;
};

type ObjectiveSession = {
  target: HiddenTarget;
  solved: boolean;
  generatedFor: { worldId: string; nodeId: string };
  lastCheck: HiddenTargetCheckResult | null;
};

function formatCreatedAt(value: string): string {
  if (!value) return "unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return date.toLocaleString();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export default function App() {
  const viewerRef = useRef<PannellumViewer | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [status, setStatus] = useState("Ready.");
  const [busy, setBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [history, setHistory] = useState<WorldSummary[]>([]);
  const [worldState, setWorldState] = useState<{
    worldId: string | null;
    nodeId: string | null;
  }>({
    worldId: null,
    nodeId: null,
  });
  const [cacheState, setCacheState] = useState("-");
  const [targetState, setTargetState] = useState("-");
  const [activeNode, setActiveNode] = useState<NodePayload | null>(null);
  const [viewerPanDragging, setViewerPanDragging] = useState(false);
  const [objectiveSession, setObjectiveSession] = useState<ObjectiveSession | null>(null);
  const [objectiveLoading, setObjectiveLoading] = useState(false);
  const [objectiveError, setObjectiveError] = useState("");
  const lastAutoCheckKeyRef = useRef<string | null>(null);
  const [loadingHotspot, setLoadingHotspot] = useState<{
    id: string;
    pitch: number;
    yaw: number;
  } | null>(null);
  const viewOrientationRef = useRef({ pitch: 0, yaw: 0 });
  /** True once this pointer session moved past the click threshold (pan / look drag). */
  const panGripRef = useRef(false);
  const pointerStartRef = useRef<PointerStart | null>(null);

  function renderPanorama(payload: NodePayload) {
    setActiveNode(payload);
    setWorldState({ worldId: payload.worldId, nodeId: payload.nodeId });
    setCacheState(payload.cacheHit ? "hit" : "miss");
    setTargetState(payload.target?.targetLabel ?? "-");
  }

  async function loadHistory() {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const data = await getWorldHistory();
      setHistory(data.worlds);
    } catch (error) {
      setHistoryError(getErrorMessage(error));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function startWorld() {
    setBusy(true);
    setStatus("Starting world and loading origin node...");
    try {
      const data = await startWorldRequest(prompt);
      renderPanorama(data);
      await generateObjectiveForNode(data, prompt);
      setStatus("World ready. Drag to look around, click a target to enter it.");
      await loadHistory();
    } catch (error) {
      setStatus(`Error: ${getErrorMessage(error)}`);
    } finally {
      setLoadingHotspot(null);
      setBusy(false);
    }
  }

  async function openWorld(worldId: string, worldPrompt: string) {
    if (!worldId) return;
    setBusy(true);
    setStatus("Opening cached world...");
    try {
      const data = await getWorldNode(worldId);
      renderPanorama(data);
      if (worldPrompt) setPrompt(worldPrompt);
      await generateObjectiveForNode(data, worldPrompt || prompt);
      setStatus("World loaded. Drag to look around, click a target to enter it.");
    } catch (error) {
      setStatus(`Error: ${getErrorMessage(error)}`);
    } finally {
      setLoadingHotspot(null);
      setBusy(false);
    }
  }

  async function openNode(worldId: string, nodeId: string, label?: string) {
    rememberCurrentOrientation();
    setBusy(true);
    setStatus(label ? `Opening ${label}...` : "Opening saved entry...");
    try {
      const data = await getWorldNode(worldId, nodeId);
      renderPanorama(data);
      setStatus(label ? `Entered ${label}.` : "Saved entry loaded.");
    } catch (error) {
      setStatus(`Error: ${getErrorMessage(error)}`);
    } finally {
      setLoadingHotspot(null);
      setBusy(false);
    }
  }

  async function goBackToParent() {
    if (!worldState.worldId || !activeNode?.parentNodeId) return;
    await openNode(worldState.worldId, activeNode.parentNodeId, "previous view");
  }

  async function enterClickedTarget(pitch: number, yaw: number) {
    if (!worldState.worldId || !worldState.nodeId || !activeNode) {
      setStatus("Start or open a world first.");
      return;
    }

    rememberCurrentOrientation();
    setBusy(true);
    setStatus("Inspecting target...");
    try {
      const data = await enterTarget({
        worldId: worldState.worldId,
        parentNodeId: worldState.nodeId,
        sourceImageUrl: activeNode.imageUrl,
        pitch,
        yaw,
        onProgress: (progress) => {
          setStatus(progress === "inspect" ? "Inspecting target..." : "Generating next view...");
        },
      });
      renderPanorama(data);
      setStatus(
        data.target?.targetLabel
          ? `Entered ${data.target.targetLabel}.`
          : "Entered the clicked target."
      );
      await loadHistory();
    } catch (error) {
      setStatus(`Error: ${getErrorMessage(error)}`);
    } finally {
      setLoadingHotspot(null);
      setBusy(false);
    }
  }

  async function generateObjectiveForNode(node: NodePayload, worldPrompt: string) {
    setObjectiveLoading(true);
    setObjectiveError("");
    try {
      const target = await generateHiddenTarget({
        worldPrompt,
        currentContext: node.contextDescription || node.promptUsed || worldPrompt,
        currentLocation: node.contextLocation || worldPrompt,
      });
      setObjectiveSession({
        target,
        solved: false,
        generatedFor: { worldId: node.worldId, nodeId: node.nodeId },
        lastCheck: null,
      });
      lastAutoCheckKeyRef.current = null;
    } catch (error) {
      setObjectiveError(getErrorMessage(error));
    } finally {
      setObjectiveLoading(false);
    }
  }

  async function checkObjective(options?: { auto?: boolean; checkKey?: string }) {
    const isAuto = options?.auto ?? false;
    if (!objectiveSession) {
      if (!isAuto) setObjectiveError("Generate a hidden target first.");
      return;
    }
    if (!activeNode) {
      if (!isAuto) setObjectiveError("Start or open a world first.");
      return;
    }
    setObjectiveLoading(true);
    setObjectiveError("");
    if (options?.checkKey) {
      lastAutoCheckKeyRef.current = options.checkKey;
    }
    try {
      const result = await checkHiddenTargetSatisfied({
        hiddenTarget: objectiveSession.target,
        sourceImageUrl: activeNode.imageUrl,
        currentContext: activeNode.contextDescription || activeNode.promptUsed || prompt,
        currentLocation: activeNode.contextLocation || prompt,
      });
      setObjectiveSession((previous) =>
        previous
          ? {
              ...previous,
              solved: previous.solved || result.matched,
              lastCheck: result,
            }
          : previous
      );
    } catch (error) {
      setObjectiveError(getErrorMessage(error));
      if (options?.checkKey) {
        // Allow retry for this node if the previous auto-check failed.
        lastAutoCheckKeyRef.current = null;
      }
    } finally {
      setObjectiveLoading(false);
    }
  }

  useEffect(() => {
    void loadHistory();
  }, []);

  useEffect(() => {
    if (!activeNode) return undefined;

    if (viewerRef.current) {
      viewerRef.current.destroy();
      viewerRef.current = null;
    }

    if (!window.pannellum) {
      setStatus("Error: Pannellum failed to load.");
      return undefined;
    }

    const entryHotSpots: PannellumHotSpot[] = activeNode.entries.map((entry) => ({
      id: `entry-${entry.nodeId}`,
      pitch: entry.pitch,
      yaw: entry.yaw,
      type: "custom",
      cssClass: "entry-hotspot",
      createTooltipFunc: (element, args) => {
        const hotspotEntry = args as NodeEntry;
        element.setAttribute("aria-label", hotspotEntry.targetLabel);
        const marker = document.createElement("span");
        marker.className = "entry-hotspot-marker";
        marker.tabIndex = 0;
        const label = document.createElement("span");
        label.className = "entry-hotspot-label";
        label.textContent = hotspotEntry.targetLabel;
        marker.appendChild(label);
        element.appendChild(marker);
      },
      createTooltipArgs: entry,
      clickHandlerFunc: (event, args) => {
        event.stopPropagation();
        const hotspotEntry = args as NodeEntry;
        void openNode(activeNode.worldId, hotspotEntry.nodeId, hotspotEntry.targetLabel);
      },
      clickHandlerArgs: entry,
    }));

    viewerRef.current = window.pannellum.viewer("panorama", {
      type: "equirectangular",
      panorama: activeNode.imageUrl,
      autoLoad: true,
      showZoomCtrl: true,
      showFullscreenCtrl: true,
      pitch: viewOrientationRef.current.pitch,
      yaw: viewOrientationRef.current.yaw,
      hfov: 100,
      hotSpots: entryHotSpots,
    });

    return () => {
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
  }, [activeNode]);

  function rememberCurrentOrientation() {
    if (!viewerRef.current) return;
    viewOrientationRef.current = {
      pitch: viewerRef.current.getPitch(),
      yaw: viewerRef.current.getYaw(),
    };
  }

  useEffect(() => {
    if (!viewerRef.current || !loadingHotspot) return undefined;

    viewerRef.current.addHotSpot({
      id: loadingHotspot.id,
      pitch: loadingHotspot.pitch,
      yaw: loadingHotspot.yaw,
      type: "custom",
      cssClass: "loading-hotspot",
      createTooltipFunc: (element) => {
        const spinner = document.createElement("span");
        spinner.className = "loading-hotspot-spinner";
        element.appendChild(spinner);
      },
    });

    return () => {
      try {
        viewerRef.current?.removeHotSpot(loadingHotspot.id);
      } catch {
        // Pannellum may already have destroyed the hotspot with the viewer.
      }
    };
  }, [loadingHotspot]);

  useEffect(() => {
    if (busy || !worldState.worldId) {
      panGripRef.current = false;
      setViewerPanDragging(false);
    }
  }, [busy, worldState.worldId]);

  useEffect(() => {
    if (!objectiveSession || objectiveSession.solved || !activeNode || objectiveLoading) return;
    const checkKey = `${activeNode.worldId}:${activeNode.nodeId}:${objectiveSession.target.objectiveLabel}`;
    if (lastAutoCheckKeyRef.current === checkKey) return;
    void checkObjective({ auto: true, checkKey });
  }, [activeNode, objectiveLoading, objectiveSession]);

  function shouldIgnorePointerTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest(
        "button, a, textarea, input, select, .pnlm-controls, .pnlm-load-button, .entry-hotspot, .loading-hotspot"
      )
    );
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || busy || !worldState.worldId || shouldIgnorePointerTarget(event.target)) {
      pointerStartRef.current = null;
      panGripRef.current = false;
      setViewerPanDragging(false);
      return;
    }
    panGripRef.current = false;
    setViewerPanDragging(false);
    pointerStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      time: window.performance.now(),
      pointerId: event.pointerId,
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const pointerStart = pointerStartRef.current;
    if (!pointerStart || event.pointerId !== pointerStart.pointerId || busy || !worldState.worldId) return;
    if (panGripRef.current) return;
    const dx = event.clientX - pointerStart.x;
    const dy = event.clientY - pointerStart.y;
    if (Math.hypot(dx, dy) > CLICK_MOVE_THRESHOLD_PX) {
      panGripRef.current = true;
      setViewerPanDragging(true);
    }
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    panGripRef.current = false;
    setViewerPanDragging(false);
    const pointerStart = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!pointerStart || pointerStart.pointerId !== event.pointerId) return;
    if (busy || !viewerRef.current || shouldIgnorePointerTarget(event.target)) return;

    const dx = event.clientX - pointerStart.x;
    const dy = event.clientY - pointerStart.y;
    const distance = Math.hypot(dx, dy);
    const elapsed = window.performance.now() - pointerStart.time;
    if (distance > CLICK_MOVE_THRESHOLD_PX || elapsed > CLICK_TIME_THRESHOLD_MS) return;

    const mouseEvent = new MouseEvent("mouseup", {
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      bubbles: true,
    });
    const [pitch, yaw] = viewerRef.current.mouseEventToCoords(mouseEvent);
    setLoadingHotspot({
      id: `loading-${window.crypto.randomUUID()}`,
      pitch,
      yaw,
    });
    void enterClickedTarget(pitch, yaw);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>Grid Street-View 360 Explorer</h1>
      </header>

      <div className="layout">
        <aside className="sidebar panel">
          <section>
            <h2 className="section-title">World Prompt</h2>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
            <div className="button-row">
              <button disabled={busy} onClick={startWorld}>
                Start World
              </button>
            </div>
          </section>

          <div className="status">{status}</div>

          <section>
            <h2 className="section-title">Objective</h2>
            {!objectiveSession && (
              <div className="placeholder">
                Objective will be generated automatically when a world is started or opened.
              </div>
            )}
            {objectiveSession && (
              <div className="objective-card">
                <div>
                  <strong>Target:</strong> {objectiveSession.target.objectiveLabel}
                </div>
                <div className="meta">
                  <span>{objectiveSession.solved ? "Solved" : "Unsolved"}</span>
                  <span>
                    Generated at node {objectiveSession.generatedFor.nodeId}
                  </span>
                </div>
                {objectiveSession.lastCheck && (
                  <div className="objective-check-result">
                    Last check:{" "}
                    {objectiveSession.lastCheck.matched ? "match" : "no match"} (
                    {objectiveSession.lastCheck.confidence}) - {objectiveSession.lastCheck.reason}
                  </div>
                )}
              </div>
            )}
            {objectiveLoading && <div className="placeholder">Objective request in progress...</div>}
            {!!objectiveError && <div className="placeholder">Objective error: {objectiveError}</div>}
          </section>

          <section>
            <div className="history-head">
              <h2 className="section-title">World History</h2>
              <button className="secondary compact" disabled={busy} onClick={loadHistory}>
                Refresh
              </button>
            </div>
            <div className="history-list">
              {historyLoading && <div className="placeholder">Loading cached worlds...</div>}
              {!historyLoading && historyError && (
                <div className="placeholder">Failed to load history: {historyError}</div>
              )}
              {!historyLoading && !historyError && history.length === 0 && (
                <div className="placeholder">No cached worlds yet. Start your first world.</div>
              )}
              {!historyLoading &&
                !historyError &&
                history.map((world) => (
                  <button
                    className={`history-item ${
                      world.world_id === worldState.worldId ? "active" : ""
                    }`}
                    key={world.world_id}
                    onClick={() => openWorld(world.world_id, world.prompt)}
                  >
                    {world.origin_image_url && (
                      <img
                        className="history-thumb"
                        src={world.origin_image_url}
                        alt="World preview"
                        loading="lazy"
                      />
                    )}
                    <strong>{world.prompt_preview || "Untitled world"}</strong>
                    <div className="meta">
                      <span>{formatCreatedAt(world.created_at)}</span>
                      <span>{world.node_count || 0} nodes</span>
                    </div>
                  </button>
                ))}
            </div>
          </section>
        </aside>

        <main className="viewer-panel panel">
          <div
            className={`panorama-wrap ${worldState.worldId && !busy ? "clickable" : ""} ${
              viewerPanDragging ? "viewer-pan-dragging" : ""
            }`}
            onPointerDown={handlePointerDown}
            onPointerMoveCapture={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => {
              panGripRef.current = false;
              setViewerPanDragging(false);
              pointerStartRef.current = null;
            }}
          >
            <div id="panorama" className={!worldState.worldId ? "empty" : ""} />
            {!worldState.worldId && <div className="empty-message">Start or open a world.</div>}
            {activeNode?.parentNodeId && (
              <button className="viewer-back-button" disabled={busy} onClick={goBackToParent}>
                Back
              </button>
            )}
          </div>

          <div className="hud">
            <div>World: {worldState.worldId ?? "-"}</div>
            <div>Node: {worldState.nodeId ?? "-"}</div>
            <div>Cache: {cacheState}</div>
            <div>Target: {targetState}</div>
          </div>
        </main>
      </div>
    </div>
  );
}
