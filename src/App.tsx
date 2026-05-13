import { type PointerEvent, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PROMPT,
  checkHiddenTargetSatisfied,
  enterTarget,
  generateGoalSet,
  type GoalSet,
  getWorldHistory,
  getWorldNode,
  type GoalDifficulty,
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

type SolvedInfo = { worldId: string; nodeId: string };

type ObjectiveSession = {
  goals: GoalSet;
  solvedMap: Map<string, SolvedInfo>;
  lastCheck: HiddenTargetCheckResult | null;
  allSolved: boolean;
};

const DIFFICULTY_ORDER: GoalDifficulty[] = ["easy", "medium", "hard"];

function difficultyBadge(d: GoalDifficulty): string {
  if (d === "easy") return "Easy";
  if (d === "medium") return "Medium";
  return "Hard";
}

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
  const [activeNode, setActiveNode] = useState<NodePayload | null>(null);
  const [viewerPanDragging, setViewerPanDragging] = useState(false);
  const [objectiveSession, setObjectiveSession] = useState<ObjectiveSession | null>(null);
  const [objectiveGenerating, setObjectiveGenerating] = useState(false);
  const [objectiveChecking, setObjectiveChecking] = useState(false);
  const [objectiveError, setObjectiveError] = useState("");
  const [goalOverlayOpen, setGoalOverlayOpen] = useState(false);
  const [solvedFlash, setSolvedFlash] = useState(false);
  const solvedFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoCheckKeyRef = useRef<string | null>(null);
  const objectiveRequestIdRef = useRef(0);
  const enterRequestIdRef = useRef(0);
  const [enterInFlight, setEnterInFlight] = useState(false);
  const [loadingHotspot, setLoadingHotspot] = useState<{ id: string; pitch: number; yaw: number } | null>(
    null
  );
  const viewOrientationRef = useRef({ pitch: 0, yaw: 0 });
  const panGripRef = useRef(false);
  const pointerStartRef = useRef<PointerStart | null>(null);

  const isWorldPage = Boolean(routeWorldId);
  const solvedGoals = objectiveSession?.goals.filter(
    (g) => objectiveSession.solvedMap.has(g.objectiveLabel)
  ) ?? [];
  const unsolvedGoals = objectiveSession?.goals.filter(
    (g) => !objectiveSession.solvedMap.has(g.objectiveLabel)
  ) ?? [];

  function renderPanorama(payload: NodePayload) {
    // Treat each loaded panorama as a fresh scene entry for auto goal checks.
    lastAutoCheckKeyRef.current = null;
    setActiveNode(payload);
    setWorldState({ worldId: payload.worldId, nodeId: payload.nodeId });
  }

  function navigateToWorld(worldId: string) {
    window.history.pushState({}, "", `/${worldId}`);
    setRouteWorldId(worldId);
  }

  function navigateHome() {
    enterRequestIdRef.current++;
    window.history.pushState({}, "", "/");
    setRouteWorldId(null);
    setActiveNode(null);
    setWorldState({ worldId: null, nodeId: null });
    setObjectiveSession(null);
    setGoalOverlayOpen(false);
    setSolvedFlash(false);
    setObjectiveGenerating(false);
    setObjectiveChecking(false);
    setObjectiveError("");
    setLoadingHotspot(null);
    setEnterInFlight(false);
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
      setGoalOverlayOpen(false);
      setSolvedFlash(false);
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
    setGoalOverlayOpen(false);
    setSolvedFlash(false);
    navigateToWorld(worldId);
  }

  async function goBackToParent() {
    if (!worldState.worldId || !activeNode?.parentNodeId) return;
    enterRequestIdRef.current++;
    setLoadingHotspot(null);
    await openNode(worldState.worldId, activeNode.parentNodeId, "previous view");
  }

  async function enterClickedTarget(pitch: number, yaw: number) {
    if (enterInFlight) return;
    if (!worldState.worldId || !worldState.nodeId || !activeNode) {
      setStatus("Start or open a world first.");
      return;
    }

    const requestId = ++enterRequestIdRef.current;
    rememberCurrentOrientation();
    setEnterInFlight(true);
    setStatus("Inspecting target...");
    try {
      const data = await enterTarget({
        worldId: worldState.worldId,
        parentNodeId: worldState.nodeId,
        sourceImageUrl: activeNode.imageUrl,
        pitch,
        yaw,
        onProgress: (progress) => {
          if (requestId !== enterRequestIdRef.current) return;
          setStatus(progress === "inspect" ? "Inspecting target..." : "Generating next view...");
        },
      });
      if (requestId !== enterRequestIdRef.current) return;
      renderPanorama(data);
      setStatus(
        data.target?.targetLabel ? `Entered ${data.target.targetLabel}.` : "Entered the clicked target."
      );
    } catch (error) {
      if (requestId !== enterRequestIdRef.current) return;
      setStatus(`Error: ${getErrorMessage(error)}`);
    } finally {
      if (requestId === enterRequestIdRef.current) {
        setLoadingHotspot(null);
      }
      setEnterInFlight(false);
    }
  }

  async function checkObjective(options?: { checkKey?: string }) {
    if (!objectiveSession || objectiveSession.allSolved || !activeNode) return;
    setObjectiveChecking(true);
    setObjectiveError("");
    if (options?.checkKey) {
      lastAutoCheckKeyRef.current = options.checkKey;
    }

    const goalsToCheck = objectiveSession.goals
      .filter((g) => !objectiveSession.solvedMap.has(g.objectiveLabel))
      .sort((a, b) => DIFFICULTY_ORDER.indexOf(a.difficulty) - DIFFICULTY_ORDER.indexOf(b.difficulty));

    try {
      for (const goal of goalsToCheck) {
        const result = await checkHiddenTargetSatisfied({
          hiddenTarget: goal,
          sourceImageUrl: activeNode.imageUrl,
          currentContext: activeNode.contextDescription || activeNode.promptUsed || prompt,
          currentLocation: activeNode.contextLocation || prompt,
        });
        if (result.matched) {
          const solvedAt = { worldId: activeNode.worldId, nodeId: activeNode.nodeId };
          setObjectiveSession((prev) => {
            if (!prev) return prev;
            const nextSolved = new Map(prev.solvedMap);
            nextSolved.set(goal.objectiveLabel, solvedAt);
            const allSolved = prev.goals.every((g) => nextSolved.has(g.objectiveLabel));
            return { ...prev, solvedMap: nextSolved, lastCheck: result, allSolved };
          });
          setStatus(`Goal solved: ${goal.objectiveLabel}`);
          setGoalOverlayOpen(true);
          setSolvedFlash(true);
          if (solvedFlashTimerRef.current) clearTimeout(solvedFlashTimerRef.current);
          solvedFlashTimerRef.current = setTimeout(() => {
            setSolvedFlash(false);
            setObjectiveSession((prev) => {
              if (prev && !prev.allSolved) setGoalOverlayOpen(false);
              return prev;
            });
          }, 4000);
          break;
        } else {
          setObjectiveSession((prev) =>
            prev ? { ...prev, lastCheck: result } : prev
          );
        }
      }
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
    generateGoalSet({
      worldPrompt: prompt,
      currentContext: activeNode.contextDescription || activeNode.promptUsed || prompt,
      currentLocation: activeNode.contextLocation || prompt,
    })
      .then((goals) => {
        if (requestId !== objectiveRequestIdRef.current) return;
        setObjectiveSession({ goals, solvedMap: new Map(), lastCheck: null, allSolved: false });
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
    if (!objectiveSession || objectiveSession.allSolved || !activeNode || objectiveChecking) return;
    const unsolvedKey = unsolvedGoals.map((g) => g.objectiveLabel).join("|");
    const checkKey = `${activeNode.worldId}:${activeNode.nodeId}:${unsolvedKey}`;
    if (lastAutoCheckKeyRef.current === checkKey) return;
    void checkObjective({ checkKey });
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
    if (event.button !== 0 || busy || enterInFlight || !worldState.worldId || shouldIgnorePointerTarget(event.target)) {
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
    if (!pointerStart || event.pointerId !== pointerStart.pointerId || busy || enterInFlight || !worldState.worldId) return;
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
    if (busy || enterInFlight || !viewerRef.current || shouldIgnorePointerTarget(event.target)) return;

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

  const goalOverlayVisible = objectiveSession && !objectiveGenerating;
  const goalOverlayClasses = [
    "goal-overlay",
    goalOverlayOpen ? "open" : "",
    solvedFlash ? "flash" : "",
    objectiveSession?.allSolved ? "all-solved" : "",
  ].filter(Boolean).join(" ");

  return (
    <main className="world-page">
      <div className="world-topbar">
        <button className="secondary compact" onClick={navigateHome}>
          Worlds
        </button>
        <span className="world-status-text">
          {status}
          {objectiveGenerating && " | Generating goals..."}
          {objectiveChecking && " | Checking goals..."}
        </span>
      </div>

      <div
        className={`panorama-wrap ${worldState.worldId && !busy && !enterInFlight ? "clickable" : ""} ${
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
          <button className="viewer-back-button" onClick={goBackToParent}>
            Back
          </button>
        )}
        {goalOverlayVisible && (
          <div className={goalOverlayClasses} aria-live="polite">
            <button
              type="button"
              className="goal-overlay-bar"
              onClick={() => setGoalOverlayOpen((prev) => !prev)}
            >
              <span className="goal-overlay-progress">
                {objectiveSession.allSolved
                  ? "All Complete!"
                  : `Goals ${solvedGoals.length}/${objectiveSession.goals.length}`}
              </span>
              <span className={`goal-overlay-chevron ${goalOverlayOpen ? "up" : ""}`}>&#9660;</span>
            </button>
            {goalOverlayOpen && (
              <div className="goal-overlay-list">
                {objectiveSession.goals.map((goal) => {
                  const solvedInfo = objectiveSession.solvedMap.get(goal.objectiveLabel);
                  return (
                    <button
                      type="button"
                      key={goal.objectiveLabel}
                      className={`goal-item ${solvedInfo ? "goal-solved" : ""}`}
                      disabled={!solvedInfo}
                      onClick={() => {
                        if (solvedInfo && worldState.worldId) {
                          void openNode(solvedInfo.worldId, solvedInfo.nodeId, goal.objectiveLabel);
                        }
                      }}
                    >
                      <span className={`goal-difficulty goal-difficulty-${goal.difficulty}`}>
                        {difficultyBadge(goal.difficulty)}
                      </span>
                      <span className="goal-label">{goal.objectiveLabel}</span>
                      {solvedInfo && <span className="goal-check" aria-label="Solved">&#10003;</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
} 
