import type { FastifyInstance } from "fastify";
import { replyWorkspaceError, type WorkspaceRouteDeps } from "./deps";
import {
  copyEntryPayloadSchema,
  createDirectoryPayloadSchema,
  deleteEntryPayloadSchema,
  moveEntryPayloadSchema,
  renameEntryPayloadSchema,
  workspaceParamsSchema,
  writeFilePayloadSchema
} from "../../domain/workspaceSchemas";

/**
 * The seven fixed workspace mutations. All are mutating methods, so the global
 * preHandler requires the bearer token when `AUTH_TOKEN` is configured and none
 * opts into `authorizedForRead`. Each one bounds and locks inside
 * `WorkspaceExplorer`; what lives here is the event and the response shape, plus
 * dropping the cached file index whenever the set of paths changed.
 * See `docs/safety/TRUST_AND_SAFETY.md` (*Workspace file mutation*).
 */
export async function registerWorkspaceFileMutationRoutes(
  app: FastifyInstance,
  deps: WorkspaceRouteDeps
): Promise<void> {
  app.put("/api/workspaces/:workspaceId/file", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = writeFilePayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace file write payload" });
    }
    try {
      const result = await deps.explorer.writeTextFile(workspaceId, parsed.data);
      // A create adds a path the cached file index has not seen; drop it so
      // quick-open and search observe the new file immediately.
      if (result.created) deps.explorer.invalidateFileIndex(workspaceId);
      deps.eventBus.publish("workspace_file_written", {
        workspaceId,
        workspacePath: result.workspacePath,
        path: result.preview.path,
        sizeBytes: result.preview.sizeBytes,
        created: result.created
      });
      return reply.code(result.created ? 201 : 200).send(result.preview);
    } catch (error) {
      return replyWorkspaceError(reply, error);
    }
  });

  // File-only deletion, optimistic-locked to the version the client rendered.
  app.delete("/api/workspaces/:workspaceId/file", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = deleteEntryPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace file delete payload" });
    }
    try {
      const result = await deps.explorer.deleteFile(workspaceId, parsed.data);
      deps.explorer.invalidateFileIndex(workspaceId);
      deps.eventBus.publish("workspace_file_deleted", {
        workspaceId,
        workspacePath: result.workspacePath,
        path: result.path,
        sizeBytes: result.sizeBytes
      });
      return reply.send({
        workspaceId: result.workspaceId,
        path: result.path,
        sizeBytes: result.sizeBytes,
        deleted: result.deleted
      });
    } catch (error) {
      return replyWorkspaceError(reply, error);
    }
  });

  // One directory under an existing parent — the container counterpart of the
  // file PUT's create branch, and the only mutation that takes no
  // optimistic-lock token, since it replaces nothing. Deliberately not
  // recursive: the parent must already exist, so this cannot become a
  // "materialize this whole path" call.
  //
  // No file-index invalidation: the index enumerates *files* (`git ls-files`,
  // else the bounded walk), and an empty directory contributes none. The first
  // write inside it is a create, which invalidates then.
  app.post("/api/workspaces/:workspaceId/directory", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = createDirectoryPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace directory create payload" });
    }
    try {
      const result = await deps.explorer.createDirectory(workspaceId, parsed.data);
      deps.eventBus.publish("workspace_directory_created", {
        workspaceId,
        workspacePath: result.workspacePath,
        path: result.path
      });
      return reply.code(201).send({
        workspaceId: result.workspaceId,
        path: result.path,
        modifiedAt: result.modifiedAt,
        created: result.created
      });
    } catch (error) {
      return replyWorkspaceError(reply, error);
    }
  });

  // Recursive directory deletion is distinct from file unlinking so callers
  // must opt into its wider effect explicitly. WorkspaceExplorer inventories
  // and bounds the complete subtree before removing it.
  app.delete("/api/workspaces/:workspaceId/directory", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = deleteEntryPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace directory delete payload" });
    }
    try {
      const result = await deps.explorer.deleteDirectory(workspaceId, parsed.data);
      deps.explorer.invalidateFileIndex(workspaceId);
      deps.eventBus.publish("workspace_directory_deleted", {
        workspaceId,
        workspacePath: result.workspacePath,
        path: result.path,
        fileCount: result.fileCount,
        directoryCount: result.directoryCount,
        sizeBytes: result.sizeBytes
      });
      return reply.send({
        workspaceId: result.workspaceId,
        path: result.path,
        fileCount: result.fileCount,
        directoryCount: result.directoryCount,
        sizeBytes: result.sizeBytes,
        deleted: result.deleted
      });
    } catch (error) {
      return replyWorkspaceError(reply, error);
    }
  });

  // Files and directories can be renamed within their current parent only. The
  // leaf-only `newName` contract keeps this route unable to express a second
  // directory; relocating to one is the sibling `entry/move` route below.
  app.post("/api/workspaces/:workspaceId/entry/rename", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = renameEntryPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace entry rename payload" });
    }
    try {
      const result = await deps.explorer.renameEntry(workspaceId, parsed.data);
      if (result.renamed) {
        deps.explorer.invalidateFileIndex(workspaceId);
        deps.eventBus.publish("workspace_entry_renamed", {
          workspaceId,
          workspacePath: result.workspacePath,
          oldPath: result.oldPath,
          path: result.path,
          entryType: result.entryType,
          ...(result.sizeBytes === undefined ? {} : { sizeBytes: result.sizeBytes })
        });
      }
      return reply.send({
        workspaceId: result.workspaceId,
        oldPath: result.oldPath,
        path: result.path,
        entryType: result.entryType,
        ...(result.sizeBytes === undefined ? {} : { sizeBytes: result.sizeBytes }),
        renamed: result.renamed
      });
    } catch (error) {
      return replyWorkspaceError(reply, error);
    }
  });

  // Move relocates one entry to another directory in the same workspace. It runs
  // the same optimistic-locked, no-overwrite relocation rename runs — one
  // implementation, two contracts — and bounds the destination parent the way
  // every other write bounds the parent it touches.
  app.post("/api/workspaces/:workspaceId/entry/move", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = moveEntryPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace entry move payload" });
    }
    try {
      const result = await deps.explorer.moveEntry(workspaceId, parsed.data);
      if (result.moved) {
        deps.explorer.invalidateFileIndex(workspaceId);
        deps.eventBus.publish("workspace_entry_moved", {
          workspaceId,
          workspacePath: result.workspacePath,
          oldPath: result.oldPath,
          path: result.path,
          entryType: result.entryType,
          ...(result.sizeBytes === undefined ? {} : { sizeBytes: result.sizeBytes })
        });
      }
      return reply.send({
        workspaceId: result.workspaceId,
        oldPath: result.oldPath,
        path: result.path,
        entryType: result.entryType,
        ...(result.sizeBytes === undefined ? {} : { sizeBytes: result.sizeBytes }),
        moved: result.moved
      });
    } catch (error) {
      return replyWorkspaceError(reply, error);
    }
  });

  // Copy duplicates one entry inside the same workspace. Unlike the PUT, its
  // bytes never transit the API, so the subtree caps bound it instead of the
  // 256 KB body cap; the explorer inventories before writing and publishes only
  // a complete result. A copy always adds a path the file index has not seen.
  app.post("/api/workspaces/:workspaceId/entry/copy", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = copyEntryPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace entry copy payload" });
    }
    try {
      const result = await deps.explorer.copyEntry(workspaceId, parsed.data);
      deps.explorer.invalidateFileIndex(workspaceId);
      deps.eventBus.publish("workspace_entry_copied", {
        workspaceId,
        workspacePath: result.workspacePath,
        sourcePath: result.sourcePath,
        path: result.path,
        entryType: result.entryType,
        fileCount: result.fileCount,
        directoryCount: result.directoryCount,
        sizeBytes: result.sizeBytes
      });
      return reply.code(201).send({
        workspaceId: result.workspaceId,
        sourcePath: result.sourcePath,
        path: result.path,
        entryType: result.entryType,
        fileCount: result.fileCount,
        directoryCount: result.directoryCount,
        sizeBytes: result.sizeBytes,
        copied: result.copied
      });
    } catch (error) {
      return replyWorkspaceError(reply, error);
    }
  });
}
