import { WorkspaceExplorerError, maxWriteBytes, type WorkspaceExplorer } from "../workspace/WorkspaceExplorer";
import { composeSpatialScene, composedSceneVersion } from "./geometry/compose";
import {
  humanPathForBasePath,
  isSpatialSceneBasePath,
  spatialSceneDocumentSchema,
  spatialSceneHumanDocumentSchema,
  type ComposedSpatialSceneDocument,
  type SpatialSceneDocument,
  type SpatialSceneHumanDocument
} from "./geometry/schemas";
import {
  composeDiagram,
  composedDiagramVersion,
  type DiagramRenderDocument,
  type DiagramValidationIssue
} from "./diagram/compose";
import {
  diagramDocumentSchema,
  diagramHumanDocumentSchema,
  diagramHumanPathForBasePath,
  isDiagramBasePath,
  type DiagramDocument,
  type DiagramHumanDocument
} from "./diagram/schemas";

// Deliberately thin (spatial-solution-diagrams plan, V1 Simplifications): the
// service composes on read and keeps no state — no watcher, no tracked-scene
// registry, no change events, no prompt seam. Change signals reuse surfaces
// that already exist (human override PUTs emit `workspace_file_written`; agent
// writes surface through turn settle and diff events), and clients re-read the
// composed route when those fire. Everything served here is reconstructed from
// the selected scene/diagram base and its sibling human layer on every GET.

export class SpatialSceneError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

export interface SpatialSceneFileInfo {
  path: string;
  modifiedAt: string;
  sizeBytes: number;
}

export interface SpatialSceneSnapshot {
  workspaceId: string;
  path: string;
  version: string;
  document: ComposedSpatialSceneDocument;
  base: SpatialSceneFileInfo;
  human: SpatialSceneFileInfo | null;
  humanDocument: SpatialSceneHumanDocument | null;
}

export interface SpatialDiagramSnapshot {
  workspaceId: string;
  path: string;
  version: string;
  document: DiagramRenderDocument;
  base: SpatialSceneFileInfo;
  human: SpatialSceneFileInfo | null;
  humanDocument: DiagramHumanDocument | null;
}

export type SpatialRenderSnapshot = SpatialSceneSnapshot | SpatialDiagramSnapshot;

export interface SpatialSceneServiceDeps {
  explorer: Pick<WorkspaceExplorer, "filePreview">;
}

export class SpatialSceneService {
  constructor(private readonly deps: SpatialSceneServiceDeps) {}

  // Reads, validates, and composes a geometry scene or semantic diagram. Both layers go through the
  // explorer's bounded preview read (lexical bounding, symlink containment,
  // secret/generated filtering, byte cap) — the service adds no filesystem
  // access of its own. A malformed document maps to a structured 4xx error
  // state, never a crash: the client renders the message and the user can feed
  // it back to the agent.
  async getScene(workspaceId: string, basePath: string): Promise<SpatialRenderSnapshot> {
    if (isDiagramBasePath(basePath)) {
      return this.getDiagram(workspaceId, basePath);
    }
    if (!isSpatialSceneBasePath(basePath)) {
      throw new SpatialSceneError("Scene path must end with .scene.json or .diagram.json", 400);
    }
    const basePreview = await this.deps.explorer.filePreview(workspaceId, {
      path: basePath,
      maxBytes: maxWriteBytes
    });
    if (basePreview.truncated) {
      throw new SpatialSceneError("Scene file exceeds the 256 KB cap", 413);
    }
    const baseDocument = parseBaseDocument(basePreview.content);

    const humanPath = humanPathForBasePath(basePath);
    let human: SpatialSceneFileInfo | null = null;
    let humanDocument: SpatialSceneHumanDocument | null = null;
    try {
      const humanPreview = await this.deps.explorer.filePreview(workspaceId, {
        path: humanPath,
        maxBytes: maxWriteBytes
      });
      if (humanPreview.truncated) {
        throw new SpatialSceneError("Scene override file exceeds the 256 KB cap", 413);
      }
      humanDocument = parseHumanDocument(humanPreview.content);
      human = { path: humanPath, modifiedAt: humanPreview.modifiedAt, sizeBytes: humanPreview.sizeBytes };
    } catch (error) {
      // A missing override layer is the normal cold-start state, not an error.
      if (!(error instanceof WorkspaceExplorerError && error.statusCode === 404)) {
        throw error;
      }
    }

    const document = composeSpatialScene(baseDocument, humanDocument ?? undefined);
    return {
      workspaceId,
      path: basePath,
      version: composedSceneVersion(document),
      document,
      base: { path: basePath, modifiedAt: basePreview.modifiedAt, sizeBytes: basePreview.sizeBytes },
      human,
      humanDocument
    };
  }

  private async getDiagram(workspaceId: string, basePath: string): Promise<SpatialDiagramSnapshot> {
    const basePreview = await this.deps.explorer.filePreview(workspaceId, {
      path: basePath,
      maxBytes: maxWriteBytes
    });
    if (basePreview.truncated) {
      throw new SpatialSceneError("Diagram file exceeds the 256 KB cap", 413);
    }

    const humanPath = diagramHumanPathForBasePath(basePath);
    let human: SpatialSceneFileInfo | null = null;
    let humanContent: string | undefined;
    try {
      const humanPreview = await this.deps.explorer.filePreview(workspaceId, {
        path: humanPath,
        maxBytes: maxWriteBytes
      });
      if (humanPreview.truncated) {
        throw new SpatialSceneError("Diagram override file exceeds the 256 KB cap", 413);
      }
      human = { path: humanPath, modifiedAt: humanPreview.modifiedAt, sizeBytes: humanPreview.sizeBytes };
      humanContent = humanPreview.content;
    } catch (error) {
      if (!(error instanceof WorkspaceExplorerError && error.statusCode === 404)) throw error;
    }

    const baseResult = parseDiagramBaseDocument(basePreview.content);
    const humanResult = humanContent === undefined
      ? { document: null, issues: [] }
      : parseDiagramHumanDocument(humanContent);
    const issues = [...baseResult.issues, ...humanResult.issues].slice(0, 50);
    const document: DiagramRenderDocument = issues.length > 0 || !baseResult.document
      ? { errors: issues }
      : composeDiagram(baseResult.document, humanResult.document ?? undefined);

    return {
      workspaceId,
      path: basePath,
      version: composedDiagramVersion(document),
      document,
      base: { path: basePath, modifiedAt: basePreview.modifiedAt, sizeBytes: basePreview.sizeBytes },
      human,
      humanDocument: humanResult.document
    };
  }
}

function parseBaseDocument(content: string): SpatialSceneDocument {
  const parsed = spatialSceneDocumentSchema.safeParse(parseJson(content, "Scene file"));
  if (!parsed.success) {
    throw new SpatialSceneError(`Scene file is invalid: ${firstIssue(parsed.error)}`, 422);
  }
  return parsed.data;
}

function parseHumanDocument(content: string): SpatialSceneHumanDocument {
  const parsed = spatialSceneHumanDocumentSchema.safeParse(parseJson(content, "Scene override file"));
  if (!parsed.success) {
    throw new SpatialSceneError(`Scene override file is invalid: ${firstIssue(parsed.error)}`, 422);
  }
  return parsed.data;
}

function parseDiagramBaseDocument(content: string): {
  document: DiagramDocument | null;
  issues: DiagramValidationIssue[];
} {
  const json = parseDiagramJson(content, "base");
  if (json.issues.length > 0) return { document: null, issues: json.issues };
  const parsed = diagramDocumentSchema.safeParse(json.value);
  return parsed.success
    ? { document: parsed.data, issues: [] }
    : { document: null, issues: diagramIssues("base", parsed.error) };
}

function parseDiagramHumanDocument(content: string): {
  document: DiagramHumanDocument | null;
  issues: DiagramValidationIssue[];
} {
  const json = parseDiagramJson(content, "human");
  if (json.issues.length > 0) return { document: null, issues: json.issues };
  const parsed = diagramHumanDocumentSchema.safeParse(json.value);
  return parsed.success
    ? { document: parsed.data, issues: [] }
    : { document: null, issues: diagramIssues("human", parsed.error) };
}

function parseDiagramJson(content: string, layer: "base" | "human"): {
  value?: unknown;
  issues: DiagramValidationIssue[];
} {
  try {
    return { value: JSON.parse(content) as unknown, issues: [] };
  } catch {
    return { issues: [{ path: layer, message: "File is not valid JSON" }] };
  }
}

function diagramIssues(
  layer: "base" | "human",
  error: { issues: Array<{ path: Array<string | number>; message: string }> }
): DiagramValidationIssue[] {
  return error.issues.slice(0, 50).map((issue) => ({
    path: [layer, ...issue.path].join("."),
    message: issue.message
  }));
}

function parseJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new SpatialSceneError(`${label} is not valid JSON`, 422);
  }
}

function firstIssue(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  const issue = error.issues[0];
  if (!issue) return "unknown validation error";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
