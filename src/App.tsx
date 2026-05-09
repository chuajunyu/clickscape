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
  type WorldSummary,
  startWorld as startWorldRequest,
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

function getRouteWorldId() {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, "");
  return path || null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export default function App() {
  const viewerRef = useRef<PannellumViewer | null>(null);
  const [routeWorldId, setRouteWorldId] = useState<string | null>(() => getRouteWorldId());
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [galleryWorlds, setGalleryWorlds] = useState<WorldSummary[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [worldState, setWorldState] = useState<{ worldId: string | null; nodeId: string | null }>({
    worldId: null,
    nodeId: null,
  });
  const [targetState, setTargetState] = useState("-");
  const [activeNode, setActiveNode] = useState<NodePayload | null>(null);
  const [viewerPanDragging, setViewerPanDragging] = useState(false);
  const [objectiveSession, setObjectiveSession] = useState<ObjectiveSession | null>(null);
  const [objectiveGenerating, setObjectiveGenerating] = useState(false);
  const [objectiveChecking, setObjectiveChecking] = useState(false);
  const [objectiveError, setObjectiveError] = useState("");
  const lastAutoCheckKeyRef = useRef<string | null>(null);
  const objectiveRequestIdRef = useRef(0);
  const [loadingHotspot, setLoadingHotspot] = useState<{ id: string; pitch: number; yaw: number } | null>(
    null
  );
  const viewOrientationRef = useRef({ pitch: 0, yaw: 0 });
  const panGripRef = useRef(false);
  const pointerStartRef = useRef<PointerStart | null>(null);

  const isWorldPage = Boolean(routeWorldId);

  function renderPanorama(payload: NodePayload) {
    setActiveNode(payload);
    setWorldState({ worldId: payload.worldId, nodeId: payload.nodeId });
    setTargetState(payload.target?.targetLabel ?? "-");
  }

  function navigateToWorld(worldId: string) {
    window.history.pushState({}, "", `/${worldId}`);
    setRouteWorldId(worldId);
  }

  function navigateHome() {
    window.history.pushState({}, "", "/");
    setRouteWorldId(null);
    setActiveNode(null);
    setWorldState({ worldId: null, nodeId: null });
    setObjectiveSession(null);
    setObjectiveGenerating(false);
    setObjectiveChecking(false);
    setObjectiveError("");
    setStatus("Ready.");
  }

  async function loadGallery() {
    setGalleryLoading(true);
    try {
      const history = await getWorldHistory();
      setGalleryWorlds(
        history.worlds.filter((world) => world.node_count > 0 && Boolean(world.origin_image_url))
      );
    } catch (error) {
      setStatus(`Error loading worlds: ${getErrorMessage(error)}`);
    } finally {
      setGalleryLoading(false);
    }
  }

  async function createWorld(worldPrompt: string) {
    setBusy(true);
    setStatus("Starting world...");
    try {
      const data = await startWorldRequest(worldPrompt);
      setPrompt(worldPrompt);
      setObjectiveSession(null);
      renderPanorama(data);
      navigateToWorld(data.worldId);
      setStatus("World ready. Drag to look around, click a target to enter it.");
    } catch (error) {
      setStatus(`Error: ${getErrorMessage(error)}`);
    } finally {
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
      setBusy(false);
    }
  }

  async function openStoredWorld(worldId: string) {
    setObjectiveSession(null);
    navigateToWorld(worldId);
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
        data.target?.targetLabel ? `Entered ${data.target.targetLabel}.` : "Entered the clicked target."
      );
    } catch (error) {
      setStatus(`Error: ${getErrorMessage(error)}`);
    } finally {
      setLoadingHotspot(null);
      setBusy(false);
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
    setObjectiveChecking(true);
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
          ? { ...previous, solved: previous.solved || result.matched, lastCheck: result }
          : previous
      );
    } catch (error) {
      setObjectiveError(getErrorMessage(error));
      if (options?.checkKey) {
        lastAutoCheckKeyRef.current = null;
      }
    } finally {
      setObjectiveChecking(false);
    }
  }

  useEffect(() => {
    const onPopState = () => setRouteWorldId(getRouteWorldId());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!isWorldPage) void loadGallery();
  }, [isWorldPage]);

  useEffect(() => {
    if (!routeWorldId) {
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
      setActiveNode(null);
      return;
    }

    let cancelled = false;
    setBusy(true);
    setStatus("Opening world...");
    getWorldNode(routeWorldId)
      .then((data) => {
        if (cancelled) return;
        renderPanorama(data);
        setStatus("World loaded. Drag to look around, click a target to enter it.");
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatus(`Error: ${getErrorMessage(error)}`);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [routeWorldId]);

  useEffect(() => {
    if (!activeNode || !isWorldPage || objectiveSession) return;
    const requestId = objectiveRequestIdRef.current + 1;
    objectiveRequestIdRef.current = requestId;
    setObjectiveGenerating(true);
    setObjectiveError("");
    generateHiddenTarget({
      worldPrompt: prompt,
      currentContext: activeNode.contextDescription || activeNode.promptUsed || prompt,
      currentLocation: activeNode.contextLocation || prompt,
    })
      .then((target) => {
        if (requestId !== objectiveRequestIdRef.current) return;
        setObjectiveSession({
          target,
          solved: false,
          generatedFor: { worldId: activeNode.worldId, nodeId: activeNode.nodeId },
          lastCheck: null,
        });
        lastAutoCheckKeyRef.current = null;
      })
      .catch((error: unknown) => {
        if (requestId !== objectiveRequestIdRef.current) return;
        setObjectiveError(getErrorMessage(error));
      })
      .finally(() => {
        if (requestId === objectiveRequestIdRef.current) {
          setObjectiveGenerating(false);
        }
      });
  }, [activeNode, isWorldPage, objectiveSession, prompt]);

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
    if (!objectiveSession || objectiveSession.solved || !activeNode || objectiveChecking) return;
    const checkKey = `${activeNode.worldId}:${activeNode.nodeId}:${objectiveSession.target.objectiveLabel}`;
    if (lastAutoCheckKeyRef.current === checkKey) return;
    void checkObjective({ auto: true, checkKey });
  }, [activeNode, objectiveChecking, objectiveSession]);

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
    setLoadingHotspot({ id: `loading-${window.crypto.randomUUID()}`, pitch, yaw });
    void enterClickedTarget(pitch, yaw);
  }

  if (!isWorldPage) {
    return (
      <main className="home-page">
        <section className="home-hero">
          <div className="hero-card hero-card-left" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="hero-card hero-card-right" aria-hidden="true">
            <span />
            <span />
          </div>
          <div className="hero-card hero-card-bottom" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h1>
            <span>Clickscape</span>
            generate, click,
            <br />
            and explore
          </h1>
          <form
            className="prompt-bar"
            onSubmit={(event) => {
              event.preventDefault();
              void createWorld(prompt);
            }}
          >
            <input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe a world to explore..."
            />
            <button disabled={busy} type="submit">
              Generate
            </button>
            <button
              className="secondary"
              disabled={busy || galleryWorlds.length === 0}
              type="button"
              onClick={() => {
                const choice = galleryWorlds[Math.floor(Math.random() * galleryWorlds.length)];
                void openStoredWorld(choice.world_id);
              }}
            >
              Surprise Me
            </button>
          </form>
          {status && <div className="status">{status}</div>}
        </section>

        <section className="world-gallery">
          <h2>Preset Games</h2>
          <div className="gallery-grid">
            {galleryWorlds.map((world) => (
              <button
                className="world-card"
                disabled={busy}
                key={world.world_id}
                onClick={() => void openStoredWorld(world.world_id)}
              >
                {world.origin_image_url && <img alt="" src={world.origin_image_url} />}
                <span className="world-card-overlay">
                  <strong>{world.prompt_preview}</strong>
                  <small>
                    {world.node_count} {world.node_count === 1 ? "node" : "nodes"}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {!galleryLoading && galleryWorlds.length === 0 && (
            <div className="placeholder">Generate a world to add it to the gallery.</div>
          )}
          {galleryLoading && <div className="placeholder">Loading saved worlds...</div>}
        </section>
      </main>
    );
  }

  return (
    <main className="world-page">
      <div className="world-topbar">
        <button className="secondary compact" disabled={busy} onClick={navigateHome}>
          Worlds
        </button>
        <div className="goal-pill">
          {objectiveGenerating && "Generating goal..."}
          {objectiveError && `Goal error: ${objectiveError}`}
          {objectiveSession && !objectiveGenerating && (
            <>
              <strong>Goal:</strong> {objectiveSession.target.objectiveLabel}
              {objectiveSession.solved && <span> Solved</span>}
              {objectiveChecking && <span> (checking...)</span>}
            </>
          )}
          {!objectiveGenerating && !objectiveError && !objectiveSession && "Goal pending..."}
        </div>
        <button
          className="secondary compact"
          disabled={busy || objectiveGenerating || !objectiveSession || !activeNode}
          onClick={() => void checkObjective()}
        >
          Check Goal
        </button>
      </div>

      <section className="world-viewer-shell">
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
          {!worldState.worldId && <div className="empty-message">Loading world...</div>}
          {activeNode?.parentNodeId && (
            <button className="viewer-back-button" disabled={busy} onClick={goBackToParent}>
              Back
            </button>
          )}
        </div>
        <div className="world-status">
          <span>{status}</span>
          <span>Target: {targetState}</span>
        </div>
      </section>
    </main>
  );
} 
