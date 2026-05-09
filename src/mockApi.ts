const STORAGE_KEY = "grid-360-worlds";
const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_IMAGE_EDITS_URL = "https://api.openai.com/v1/images/edits";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_IMAGE_MODEL = "gpt-image-2";
const OPENAI_VISION_MODEL = "gpt-4.1-mini";
const IMAGE_DB_NAME = "grid-360-images";
const IMAGE_DB_STORE = "images";
const WORLD_DB_STORE = "worlds";
const IMAGE_DB_VERSION = 2;
const ORIGIN_NODE_ID = "origin";
const CLICK_QUANTUM_DEGREES = 5;
const GOAL_GENERATION_TIMEOUT_MS = 12000;

export const DEFAULT_PROMPT = "";

export type ClickTarget = {
  pitch: number;
  yaw: number;
};

export type TargetMetadata = {
  targetLabel: string;
  transitionSummary: string;
  quantizedPitch: number;
  quantizedYaw: number;
};

export type NodePayload = {
  worldId: string;
  nodeId: string;
  parentNodeId: string | null;
  imageUrl: string;
  cacheHit: boolean;
  promptUsed: string;
  contextDescription: string;
  contextLocation: string;
  entries: NodeEntry[];
  target: TargetMetadata | null;
};

export type NodeEntry = {
  nodeId: string;
  targetLabel: string;
  pitch: number;
  yaw: number;
};

export type HiddenTarget = {
  objectiveLabel: string;
  acceptanceCriteria: string;
};

export type HiddenTargetCheckResult = {
  matched: boolean;
  confidence: "low" | "medium" | "high";
  reason: string;
};

export type WorldSummary = {
  world_id: string;
  prompt: string;
  prompt_preview: string;
  created_at: string;
  node_count: number;
  origin_image_url: string | null;
};

export type WorldHistoryResponse = {
  worlds: WorldSummary[];
};

type LegacyWorldNode = {
  x?: number;
  y?: number;
  prompt: string;
  description?: string;
  location?: string;
  created_at: string;
  last_move?: string | null;
};

type WorldNode = {
  id: string;
  parent_id: string | null;
  prompt: string;
  description: string;
  location: string;
  created_at: string;
  target: TargetMetadata | null;
  legacy?: LegacyWorldNode;
};

type WorldEdge = {
  node_id: string;
  parent_id: string;
  pitch: number;
  yaw: number;
  target_label: string;
};

type World = {
  world_id: string;
  prompt: string;
  normalized_prompt: string;
  created_at: string;
  grid?: { movement: string };
  nodes: Record<string, WorldNode | LegacyWorldNode>;
  edges?: Record<string, string | WorldEdge>;
};

type OpenAIImageResponse = {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
};

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{ text?: string; type?: string }>;
  }>;
  error?: { message?: string };
};

type ClickAnalysis = {
  targetLabel: string;
  targetCropUrl: string;
};

// ── IndexedDB image store ──────────────────────────────────────────────────

let _db: IDBDatabase | null = null;
let localStorageMigrationPromise: Promise<void> | null = null;

function openImageDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IMAGE_DB_NAME, IMAGE_DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IMAGE_DB_STORE)) {
        req.result.createObjectStore(IMAGE_DB_STORE);
      }
      if (!req.result.objectStoreNames.contains(WORLD_DB_STORE)) {
        req.result.createObjectStore(WORLD_DB_STORE, { keyPath: "world_id" });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

async function getImage(key: string): Promise<string | null> {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IMAGE_DB_STORE, "readonly").objectStore(IMAGE_DB_STORE).get(key);
    req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function putImage(key: string, imageUrl: string): Promise<void> {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_DB_STORE, "readwrite");
    tx.objectStore(IMAGE_DB_STORE).put(imageUrl, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllWorldsFromDB(): Promise<World[]> {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(WORLD_DB_STORE, "readonly").objectStore(WORLD_DB_STORE).getAll();
    req.onsuccess = () => {
      const worlds = Array.isArray(req.result)
        ? (req.result as unknown[]).filter(isWorld).map(normalizeWorld)
        : [];
      resolve(worlds);
    };
    req.onerror = () => reject(req.error);
  });
}

async function getWorldFromDB(worldId: string): Promise<World | null> {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(WORLD_DB_STORE, "readonly").objectStore(WORLD_DB_STORE).get(worldId);
    req.onsuccess = () => resolve(isWorld(req.result) ? normalizeWorld(req.result) : null);
    req.onerror = () => reject(req.error);
  });
}

async function putWorldInDB(world: World): Promise<void> {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WORLD_DB_STORE, "readwrite");
    tx.objectStore(WORLD_DB_STORE).put(world);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function imageKey(worldId: string, nodeId: string): string {
  return `${worldId}/${nodeId}`;
}

function legacyImageKey(worldId: string, x: number, y: number): string {
  return `${worldId}/${x},${y}`;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function getApiKey(): string {
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY || import.meta.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing from .env");
  }
  return apiKey;
}

function normalizePrompt(prompt: string): string {
  return prompt.split(/\s+/).join(" ").trim().toLowerCase();
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function worldIdFromPrompt(prompt: string): string {
  const normalized = normalizePrompt(prompt || DEFAULT_PROMPT);
  return `${hashText(normalized)}${hashText(normalized.slice(0, 32))}`.slice(0, 16);
}

function quantizeAngle(value: number): number {
  return Math.round(value / CLICK_QUANTUM_DEGREES) * CLICK_QUANTUM_DEGREES;
}

function clickEdgeKey(parentNodeId: string, pitch: number, yaw: number): string {
  return `${parentNodeId}@${quantizeAngle(pitch)},${quantizeAngle(yaw)}`;
}

function nodeIdFromEdge(worldId: string, edgeKey: string): string {
  return hashText(`${worldId}:${edgeKey}`);
}

function promptPreview(prompt: string): string {
  return prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt;
}

function compactDescription(value: string): string {
  const normalized = value.split(/\s+/).join(" ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function compactLocation(value: string): string {
  const normalized = value.split(/\s+/).join(" ").trim();
  return normalized.length > 320 ? `${normalized.slice(0, 317)}...` : normalized;
}

function isWorld(value: unknown): value is World {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<World>;
  return (
    typeof candidate.world_id === "string" &&
    typeof candidate.prompt === "string" &&
    typeof candidate.created_at === "string" &&
    !!candidate.nodes &&
    typeof candidate.nodes === "object"
  );
}

function isGraphNode(node: WorldNode | LegacyWorldNode | undefined): node is WorldNode {
  return !!node && typeof (node as WorldNode).id === "string";
}

function isWorldEdge(edge: string | WorldEdge | undefined): edge is WorldEdge {
  return !!edge && typeof edge === "object" && typeof edge.node_id === "string";
}

function readWorldsFromLocalStorage(): World[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isWorld).map(normalizeWorld) : [];
  } catch {
    return [];
  }
}

async function migrateWorldsFromLocalStorage(): Promise<void> {
  if (localStorageMigrationPromise) return localStorageMigrationPromise;
  localStorageMigrationPromise = migrateWorldsFromLocalStorageOnce();
  return localStorageMigrationPromise;
}

async function migrateWorldsFromLocalStorageOnce(): Promise<void> {
  const worlds = readWorldsFromLocalStorage();
  if (!worlds.length) return;
  await Promise.all(worlds.map((world) => putWorldInDB(world)));
  window.localStorage.removeItem(STORAGE_KEY);
}

function normalizeWorld(world: World): World {
  const nextWorld: World = {
    ...world,
    nodes: { ...world.nodes },
    edges: { ...(world.edges ?? {}) },
  };

  const origin = nextWorld.nodes[ORIGIN_NODE_ID];
  if (!isGraphNode(origin)) {
    const legacyOrigin = nextWorld.nodes["0,0"] as LegacyWorldNode | undefined;
    if (legacyOrigin) {
      nextWorld.nodes[ORIGIN_NODE_ID] = {
        id: ORIGIN_NODE_ID,
        parent_id: null,
        prompt: legacyOrigin.prompt,
        description: legacyOrigin.description ?? world.prompt,
        location: legacyOrigin.location ?? buildOriginLocation(world.prompt),
        created_at: legacyOrigin.created_at,
        target: null,
        legacy: legacyOrigin,
      };
    }
  } else {
    origin.description ||= buildOriginDescription(world.prompt);
    origin.location ||= buildOriginLocation(world.prompt);
  }

  for (const node of Object.values(nextWorld.nodes)) {
    if (!isGraphNode(node)) continue;
    node.description ||= node.legacy?.description ?? world.prompt;
    node.location ||= node.legacy?.location ?? buildOriginLocation(world.prompt);
  }

  return nextWorld;
}

function edgeNodeId(edge: string | WorldEdge): string {
  return isWorldEdge(edge) ? edge.node_id : edge;
}

function entriesForNode(world: World, parentNodeId: string): NodeEntry[] {
  return Object.entries(world.edges ?? {}).flatMap(([edgeKey, edge]) => {
    const nodeId = edgeNodeId(edge);
    const node = world.nodes[nodeId];
    if (!isGraphNode(node)) return [];
    if (isWorldEdge(edge) && edge.parent_id !== parentNodeId) return [];

    const prefix = `${parentNodeId}@`;
    if (!isWorldEdge(edge) && !edgeKey.startsWith(prefix)) return [];

    const [pitchText, yawText] = edgeKey.slice(prefix.length).split(",");
    const pitch = isWorldEdge(edge) ? edge.pitch : Number(pitchText);
    const yaw = isWorldEdge(edge) ? edge.yaw : Number(yawText);
    if (!Number.isFinite(pitch) || !Number.isFinite(yaw)) return [];

    return [
      {
        nodeId,
        targetLabel: isWorldEdge(edge)
          ? edge.target_label
          : node.target?.targetLabel ?? "Saved entry",
        pitch,
        yaw,
      },
    ];
  });
}

async function readWorlds(): Promise<World[]> {
  await migrateWorldsFromLocalStorage();
  return getAllWorldsFromDB();
}

async function readWorld(worldId: string): Promise<World | null> {
  await migrateWorldsFromLocalStorage();
  return getWorldFromDB(worldId);
}

async function upsertWorld(nextWorld: World): Promise<void> {
  await putWorldInDB(normalizeWorld(nextWorld));
}

function buildOriginDescription(worldPrompt: string): string {
  return worldPrompt;
}

function buildOriginLocation(worldPrompt: string): string {
  return compactLocation(worldPrompt);
}

function buildOriginPrompt(worldPrompt: string): string {
  return [
    `World description: ${worldPrompt}`,
    "Generate a seamless full 360-degree equirectangular panorama, no text, no UI, no borders.",
  ].join("\n");
}

function buildVisionInstruction(currentContext: string, currentLocation: string, pitch: number, yaw: number): string {
  return [
    "You are provided a 360 panorama and a cropped view of the target area. Label the object or area at the center of the attached crop with its relevant position in the scene.",
    `Current view: ${currentContext}`,
    `Current physical location: ${currentLocation}`,
    "Return exactly one concise phrase.",
    "Do not return JSON, punctuation, explanations, full sentences, or alternatives.",
    "Examples: storage boxes below the bed, framed painting on the wall above the bed, wooden door at the end of the hallway, window above the desk facing the courtyard.",
  ].join("\n");
}

function buildDestinationPrompt({
  currentContext,
  currentLocation,
  targetLabel,
}: {
  currentContext: string;
  currentLocation: string;
  targetLabel: string;
}): { prompt: string; description: string; location: string } {
  const currentView = compactDescription(currentContext);
  const location = buildChildLocation(currentLocation, targetLabel);
  const description = compactDescription(
    `A 360 view reached by moving into or through the ${targetLabel}. It continues from: ${currentView}`
  );
  const prompt = [
    `Current view: ${currentView}`,
    `Physical location: ${location}`,
    `Create the next immersive 360 view as if the camera moved into or through the ${targetLabel}.`,
    "Reference images provided: the full current panorama and a small crop centered on the clicked target.",
    "Preserve visual continuity with the previous panorama: same overall art direction, lighting temperature, material quality, camera height, lens feel, and environmental mood.",
    "Use the clicked crop as the strongest local reference for color, texture, object identity, and transition direction.",
    "If the clicked target is closed, such as a closed drawer, cabinet, or closet, keep the exact same view but now open the target object.",
    "If the clicked target is a portal-like object such as a window, doorway, open it and make a best-effort guess on what's behind it, then place the camera just beyond the target object.",
    "If the clicked target is an object with an implied universe, such as a specific book, poster, photograph, painting, a drain cover, place the camera inside that object's implied universe.",
    "In all other cases, if the clicked target is simply a point in an open space, or if the object is ambiguous, just move close enough that the new 360 view plausibly explores the object's immediate surrounding micro-environment.",
    "Use the provided full panorama and target crop as visual references.",
    "Keep style, lighting, materials, camera height, and mood consistent with the references.",
    "Output a seamless equirectangular 360 panorama. No text, UI, borders, or captions.",
  ].join("\n");
  return { prompt, description, location };
}

function buildChildLocation(currentLocation: string, targetLabel: string): string {
  const parentLocation = compactLocation(currentLocation);
  return compactLocation(`inside or beyond ${targetLabel}, within ${parentLocation}`);
}

function buildHiddenTargetInstruction({
  worldPrompt,
  currentContext,
  currentLocation,
}: {
  worldPrompt: string;
  currentContext: string;
  currentLocation: string;
}): string {
  return [
    "Generate a hidden objective for an exploratory 360 panorama game.",
    `World theme: ${compactDescription(worldPrompt)}`,
    `Current view: ${compactDescription(currentContext)}`,
    `Current location: ${compactLocation(currentLocation)}`,
    "The objective must be semantically reachable by exploring this world in a few steps.",
    "The objective must be visually identifiable from an image.",
    "Return strict JSON only with keys: objectiveLabel, acceptanceCriteria.",
    "objectiveLabel must be 3-10 words.",
    "acceptanceCriteria must describe what evidence should count as a match.",
  ].join("\n");
}

function presetHiddenTargetForWorld(worldPrompt: string): HiddenTarget | null {
  const normalized = normalizePrompt(worldPrompt || "");
  if (!normalized) return null;

  if (normalized.includes("harvard")) {
    return {
      objectiveLabel: "Find the John Harvard statue",
      acceptanceCriteria:
        "The scene clearly shows a bronze seated statue in a Harvard Yard style courtyard, or a close visual equivalent.",
    };
  }

  if (
    normalized.includes("dorm room") ||
    normalized.includes("dorm") ||
    normalized.includes("college room")
  ) {
    return {
      objectiveLabel: "Find a lit desk lamp",
      acceptanceCriteria:
        "The scene clearly shows a desk lamp turned on in a bedroom or study setup, or a close visual equivalent.",
    };
  }

  return null;
}

function buildTargetSatisfactionInstruction({
  hiddenTarget,
  currentContext,
  currentLocation,
}: {
  hiddenTarget: HiddenTarget;
  currentContext: string;
  currentLocation: string;
}): string {
  return [
    "You are validating whether a panorama image satisfies a hidden objective.",
    `Objective label: ${hiddenTarget.objectiveLabel}`,
    `Acceptance criteria: ${hiddenTarget.acceptanceCriteria}`,
    `Current context: ${compactDescription(currentContext)}`,
    `Current location: ${compactLocation(currentLocation)}`,
    "Evaluate the attached panorama image.",
    "Return strict JSON only with keys: matched, confidence, reason.",
    "matched must be boolean.",
    "confidence must be one of: low, medium, high.",
    "reason must be a concise explanation under 140 characters.",
  ].join("\n");
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return "";
  return text.slice(start, end + 1);
}

function parseHiddenTarget(rawText: string): HiddenTarget {
  const normalizedText = rawText.trim();
  const jsonText = extractJsonObject(normalizedText) || normalizedText;
  const parsed = JSON.parse(jsonText) as Partial<HiddenTarget>;
  const objectiveLabel = String(parsed.objectiveLabel ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
  const acceptanceCriteria = String(parsed.acceptanceCriteria ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 220);
  if (!objectiveLabel) {
    throw new Error("Hidden target generation returned an empty objective");
  }
  return {
    objectiveLabel,
    acceptanceCriteria:
      acceptanceCriteria || "The image should clearly depict the objective or a direct visual equivalent.",
  };
}

function parseHiddenTargetCheckResult(rawText: string): HiddenTargetCheckResult {
  const normalizedText = rawText.trim();
  const jsonText = extractJsonObject(normalizedText) || normalizedText;
  const parsed = JSON.parse(jsonText) as Partial<HiddenTargetCheckResult>;
  const matched = Boolean(parsed.matched);
  const confidenceRaw = String(parsed.confidence ?? "low").trim().toLowerCase();
  const confidence: HiddenTargetCheckResult["confidence"] =
    confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low"
      ? confidenceRaw
      : "low";
  const reason = String(parsed.reason ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return {
    matched,
    confidence,
    reason: reason || (matched ? "Scene appears to satisfy the objective." : "Scene does not yet satisfy the objective."),
  };
}

function extractResponseText(data: OpenAIResponse): string {
  if (data.output_text) return data.output_text;
  const text = data.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text ?? "")
    .join("\n")
    .trim();
  return text ?? "";
}

function loadImage(sourceImageUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load source panorama for crop"));
    image.src = sourceImageUrl;
  });
}

function normalizeYaw(yaw: number): number {
  return ((((yaw + 180) % 360) + 360) % 360) - 180;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function cropClickTargetImage({
  sourceImageUrl,
  pitch,
  yaw,
}: {
  sourceImageUrl: string;
  pitch: number;
  yaw: number;
}): Promise<string> {
  const image = await loadImage(sourceImageUrl);
  const outputSize = 320;
  const sourceCropSize = Math.round(Math.min(image.width / 8, image.height / 3, 420));
  const centerX = ((normalizeYaw(yaw) + 180) / 360) * image.width;
  const centerY = ((90 - clamp(pitch, -90, 90)) / 180) * image.height;
  const sourceY = clamp(centerY - sourceCropSize / 2, 0, image.height - sourceCropSize);

  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Failed to create image crop context");

  const sourceX = centerX - sourceCropSize / 2;
  if (sourceX < 0) {
    const leftWidth = -sourceX;
    const rightWidth = sourceCropSize - leftWidth;
    context.drawImage(
      image,
      image.width - leftWidth,
      sourceY,
      leftWidth,
      sourceCropSize,
      0,
      0,
      (leftWidth / sourceCropSize) * outputSize,
      outputSize
    );
    context.drawImage(
      image,
      0,
      sourceY,
      rightWidth,
      sourceCropSize,
      (leftWidth / sourceCropSize) * outputSize,
      0,
      (rightWidth / sourceCropSize) * outputSize,
      outputSize
    );
  } else if (sourceX + sourceCropSize > image.width) {
    const rightWidth = image.width - sourceX;
    const leftWidth = sourceCropSize - rightWidth;
    context.drawImage(
      image,
      sourceX,
      sourceY,
      rightWidth,
      sourceCropSize,
      0,
      0,
      (rightWidth / sourceCropSize) * outputSize,
      outputSize
    );
    context.drawImage(
      image,
      0,
      sourceY,
      leftWidth,
      sourceCropSize,
      (rightWidth / sourceCropSize) * outputSize,
      0,
      (leftWidth / sourceCropSize) * outputSize,
      outputSize
    );
  } else {
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceCropSize,
      sourceCropSize,
      0,
      0,
      outputSize,
      outputSize
    );
  }

  return canvas.toDataURL("image/png");
}

async function analyzeClickTargetWithCrop({
  currentContext,
  currentLocation,
  sourceImageUrl,
  pitch,
  yaw,
}: {
  currentContext: string;
  currentLocation: string;
  sourceImageUrl: string;
  pitch: number;
  yaw: number;
}): Promise<ClickAnalysis> {
  const targetCropUrl = await cropClickTargetImage({ sourceImageUrl, pitch, yaw });
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: buildVisionInstruction(currentContext, currentLocation, pitch, yaw) },
            { type: "input_image", image_url: targetCropUrl, detail: "low" },
            { type: "input_image", image_url: sourceImageUrl, detail: "low" },
          ],
        },
      ],
    }),
  });

  const data = (await response.json().catch(() => ({}))) as OpenAIResponse;
  if (!response.ok) {
    throw new Error(data.error?.message || "OpenAI target analysis failed");
  }

  const targetLabel =
    extractResponseText(data)
      .replace(/^["'`]+|["'`.]+$/g, "")
      .split("\n")[0]
      .trim()
      .slice(0, 80) || "clicked target";

  return { targetLabel, targetCropUrl };
}

async function generateImage(prompt: string): Promise<string> {
  const response = await fetch(OPENAI_IMAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      n: 1,
      size: "1024x640",
      quality: "low",
      output_format: "png",
    }),
  });

  const data = (await response.json().catch(() => ({}))) as OpenAIImageResponse;
  if (!response.ok) {
    throw new Error(data.error?.message || "OpenAI image generation failed");
  }

  const image = data.data?.[0];
  if (image?.b64_json) return `data:image/png;base64,${image.b64_json}`;
  if (image?.url) return image.url;
  throw new Error("OpenAI response did not include an image");
}

async function generateImageFromReferences({
  prompt,
  sourceImageUrl,
  targetCropUrl,
}: {
  prompt: string;
  sourceImageUrl: string;
  targetCropUrl: string;
}): Promise<string> {
  const response = await fetch(OPENAI_IMAGE_EDITS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      images: [{ image_url: sourceImageUrl }, { image_url: targetCropUrl }],
      prompt,
      n: 1,
      size: "1024x640",
      quality: "high",
      output_format: "png"
    }),
  });

  const data = (await response.json().catch(() => ({}))) as OpenAIImageResponse;
  if (!response.ok) {
    throw new Error(data.error?.message || "OpenAI referenced image generation failed");
  }

  const image = data.data?.[0];
  if (image?.b64_json) return `data:image/png;base64,${image.b64_json}`;
  if (image?.url) return image.url;
  throw new Error("OpenAI response did not include an image");
}

async function nodePayload(world: World, nodeId: string, cacheHit: boolean): Promise<NodePayload> {
  const node = world.nodes[nodeId];
  if (!isGraphNode(node)) throw new Error("Node not found");

  let imageUrl = await getImage(imageKey(world.world_id, nodeId));
  if (!imageUrl && node.legacy?.x !== undefined && node.legacy?.y !== undefined) {
    imageUrl = await getImage(legacyImageKey(world.world_id, node.legacy.x, node.legacy.y));
    if (imageUrl) await putImage(imageKey(world.world_id, nodeId), imageUrl);
  }
  if (!imageUrl) {
    imageUrl = await generateImage(node.prompt);
    await putImage(imageKey(world.world_id, nodeId), imageUrl);
  }

  return {
    worldId: world.world_id,
    nodeId,
    parentNodeId: node.parent_id,
    imageUrl,
    cacheHit,
    promptUsed: node.prompt,
    contextDescription: node.description,
    contextLocation: node.location,
    entries: entriesForNode(world, nodeId),
    target: node.target,
  };
}

async function getOrCreateOrigin(world: World): Promise<NodePayload> {
  const existingOrigin = world.nodes[ORIGIN_NODE_ID];
  if (isGraphNode(existingOrigin)) {
    if (!existingOrigin.description || !existingOrigin.location) {
      existingOrigin.description = buildOriginDescription(world.prompt);
      existingOrigin.location = buildOriginLocation(world.prompt);
      await upsertWorld(world);
    }
    return nodePayload(world, ORIGIN_NODE_ID, true);
  }

  const prompt = buildOriginPrompt(world.prompt);
  const imageUrl = await generateImage(prompt);
  await putImage(imageKey(world.world_id, ORIGIN_NODE_ID), imageUrl);
  world.nodes[ORIGIN_NODE_ID] = {
    id: ORIGIN_NODE_ID,
    parent_id: null,
    prompt,
    description: buildOriginDescription(world.prompt),
    location: buildOriginLocation(world.prompt),
    created_at: new Date().toISOString(),
    target: null,
  };
  await upsertWorld(world);
  return nodePayload(world, ORIGIN_NODE_ID, false);
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function startWorld(prompt: string): Promise<NodePayload> {
  const worldPrompt = prompt.trim() || DEFAULT_PROMPT;
  const worldId = worldIdFromPrompt(worldPrompt);
  const worlds = await readWorlds();
  const existingWorld = worlds.find((world) => world.world_id === worldId);
  const world: World = existingWorld ?? {
    world_id: worldId,
    prompt: worldPrompt,
    normalized_prompt: normalizePrompt(worldPrompt),
    created_at: new Date().toISOString(),
    grid: { movement: "free_click_graph" },
    nodes: {},
    edges: {},
  };

  await upsertWorld(world);
  return getOrCreateOrigin(world);
}

export async function getWorldNode(worldId: string, nodeId = ORIGIN_NODE_ID): Promise<NodePayload> {
  const world = await readWorld(worldId);
  if (!world) throw new Error("World not found");
  if (nodeId === ORIGIN_NODE_ID) return getOrCreateOrigin(world);
  return nodePayload(world, nodeId, true);
}

export async function enterTarget({
  worldId,
  parentNodeId,
  sourceImageUrl,
  pitch,
  yaw,
  onProgress,
}: {
  worldId: string;
  parentNodeId: string;
  sourceImageUrl: string;
  pitch: number;
  yaw: number;
  onProgress?: (status: "inspect" | "generate") => void;
}): Promise<NodePayload> {
  const world = await readWorld(worldId);
  if (!world) throw new Error("World not found");

  const edgeKey = clickEdgeKey(parentNodeId, pitch, yaw);
  const existingEdge = world.edges?.[edgeKey];
  if (existingEdge && isGraphNode(world.nodes[edgeNodeId(existingEdge)])) {
    return nodePayload(world, edgeNodeId(existingEdge), true);
  }

  const currentNode = world.nodes[parentNodeId];
  if (!isGraphNode(currentNode)) throw new Error("Current node not found");

  const quantizedPitch = quantizeAngle(pitch);
  const quantizedYaw = quantizeAngle(yaw);
  onProgress?.("inspect");
  const { targetLabel, targetCropUrl } = await analyzeClickTargetWithCrop({
    currentContext: currentNode.description || world.prompt,
    currentLocation: currentNode.location || buildOriginLocation(world.prompt),
    sourceImageUrl,
    pitch,
    yaw,
  });
  const destination = buildDestinationPrompt({
    currentContext: currentNode.description || world.prompt,
    currentLocation: currentNode.location || buildOriginLocation(world.prompt),
    targetLabel,
  });
  const nodeId = nodeIdFromEdge(world.world_id, edgeKey);
  onProgress?.("generate");
  const imageUrl = await generateImageFromReferences({
    prompt: destination.prompt,
    sourceImageUrl,
    targetCropUrl,
  });

  world.nodes[nodeId] = {
    id: nodeId,
    parent_id: parentNodeId,
    prompt: destination.prompt,
    description: destination.description,
    location: destination.location,
    created_at: new Date().toISOString(),
    target: {
      targetLabel,
      transitionSummary: `Entered ${targetLabel}.`,
      quantizedPitch,
      quantizedYaw,
    },
  };
  world.edges = {
    ...(world.edges ?? {}),
    [edgeKey]: {
      node_id: nodeId,
      parent_id: parentNodeId,
      pitch: quantizedPitch,
      yaw: quantizedYaw,
      target_label: targetLabel,
    },
  };
  await putImage(imageKey(world.world_id, nodeId), imageUrl);
  await upsertWorld(world);

  return {
    worldId: world.world_id,
    nodeId,
    parentNodeId,
    imageUrl,
    cacheHit: false,
    promptUsed: destination.prompt,
    contextDescription: destination.description,
    contextLocation: destination.location,
    entries: entriesForNode(world, nodeId),
    target: world.nodes[nodeId].target ?? null,
  };
}

export async function generateHiddenTarget({
  worldPrompt,
  currentContext,
  currentLocation,
  signal,
}: {
  worldPrompt: string;
  currentContext: string;
  currentLocation: string;
  signal?: AbortSignal;
}): Promise<HiddenTarget> {
  const preset = presetHiddenTargetForWorld(worldPrompt);
  if (preset) return preset;

  const timeoutController = new AbortController();
  const timeoutId = window.setTimeout(() => timeoutController.abort(), GOAL_GENERATION_TIMEOUT_MS);
  const abortFromCaller = () => timeoutController.abort();

  if (signal) {
    if (signal.aborted) timeoutController.abort();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify({
        model: OPENAI_VISION_MODEL,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildHiddenTargetInstruction({ worldPrompt, currentContext, currentLocation }),
              },
            ],
          },
        ],
      }),
      signal: timeoutController.signal,
    });
  } catch (error) {
    if (timeoutController.signal.aborted) {
      throw new Error("Goal generation timed out. Try another scene or prompt.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromCaller);
  }

  const data = (await response.json().catch(() => ({}))) as OpenAIResponse;
  if (!response.ok) {
    throw new Error(data.error?.message || "OpenAI hidden target generation failed");
  }
  const text = extractResponseText(data);
  return parseHiddenTarget(text);
}

export async function checkHiddenTargetSatisfied({
  hiddenTarget,
  sourceImageUrl,
  currentContext,
  currentLocation,
}: {
  hiddenTarget: HiddenTarget;
  sourceImageUrl: string;
  currentContext: string;
  currentLocation: string;
}): Promise<HiddenTargetCheckResult> {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildTargetSatisfactionInstruction({ hiddenTarget, currentContext, currentLocation }),
            },
            { type: "input_image", image_url: sourceImageUrl, detail: "low" },
          ],
        },
      ],
    }),
  });

  const data = (await response.json().catch(() => ({}))) as OpenAIResponse;
  if (!response.ok) {
    throw new Error(data.error?.message || "OpenAI hidden target verification failed");
  }
  const text = extractResponseText(data);
  return parseHiddenTargetCheckResult(text);
}

export async function getWorldHistory(): Promise<WorldHistoryResponse> {
  const worlds = (await readWorlds()).sort(
    (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  );

  const summaries = await Promise.all(
    worlds.map(async (world): Promise<WorldSummary> => {
      const originNode = world.nodes[ORIGIN_NODE_ID];
      let originImage = originNode ? await getImage(imageKey(world.world_id, ORIGIN_NODE_ID)) : null;
      if (!originImage && isGraphNode(originNode) && originNode.legacy?.x !== undefined && originNode.legacy?.y !== undefined) {
        originImage = await getImage(legacyImageKey(world.world_id, originNode.legacy.x, originNode.legacy.y));
      }
      return {
        world_id: world.world_id,
        prompt: world.prompt,
        prompt_preview: promptPreview(world.prompt),
        created_at: world.created_at,
        node_count: Object.keys(world.nodes).length,
        origin_image_url: originImage,
      };
    })
  );

  return { worlds: summaries };
}
