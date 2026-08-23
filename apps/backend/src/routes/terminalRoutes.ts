import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import type { ServiceConfig } from "../domain/models";
import type { EventBus } from "../events/EventBus";
import type {
  TerminalSessionClosedPayload,
  TerminalSessionStartedPayload
} from "../events/eventTypes";
import { authorizedForRead } from "./readAuthorization";
import {
  TerminalSessionError,
  type TerminalSessionHandle,
  type TerminalSessionService
} from "../terminal/TerminalSessionService";

// Bidirectional terminal channel. This route is registered ONLY when
// `terminalEnabled` is set, so the surface is absent entirely when the operator has
// not opted in. It is the one place a client drives a real shell, so it does its own
// bearer check (the global preHandler only gates mutating HTTP methods, and a WS
// upgrade is a GET). Frames are JSON text; shell bytes ride node-pty's own UTF-8
// string model. The route never logs frame contents — see TRUST_AND_SAFETY.md.

// Route params and query are validated with zod like every other route.
const paramsSchema = z.object({ workspaceId: z.string().min(1) });
const querySchema = z.object({
  cols: z.coerce.number().int().positive().optional(),
  rows: z.coerce.number().int().positive().optional()
});

// Client -> server frames.
const clientFrameSchema = z.union([
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
  })
]);

// Cap a single inbound frame. Keystrokes/paste are tiny; anything past this is abuse
// (each frame is buffered and JSON-parsed synchronously on the event loop).
const MAX_INBOUND_FRAME_BYTES = 1024 * 1024;

// PTY output flow control: pause the shell when the socket's user-space send buffer
// grows past the high-water mark (slow/stalled client), resume once it drains below
// the low-water mark. Without this a fast producer (`yes`, `cat huge.log`) buffers
// unbounded in memory until the backend OOMs.
const SEND_BUFFER_HIGH_WATER_BYTES = 1024 * 1024;
const SEND_BUFFER_LOW_WATER_BYTES = 256 * 1024;
const SEND_BUFFER_POLL_MS = 50;

// Server -> client frames.
type ServerFrame =
  | { type: "ready"; sessionId: string }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number }
  | { type: "error"; message: string };

// Minimal outbound surface of the @fastify/websocket socket that the route needs,
// so the helpers do not depend on the transitive `ws` type.
interface OutboundSocket {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export async function registerTerminalRoutes(
  app: FastifyInstance,
  deps: { terminalSessions: TerminalSessionService; eventBus: EventBus; config: ServiceConfig }
): Promise<void> {
  // @fastify/websocket decorates `websocketServer` once; another route module may
  // have already registered it. Guard so registration order does not matter.
  if (!app.hasDecorator("websocketServer")) {
    await app.register(websocket);
  }

  app.get(
    "/api/workspaces/:workspaceId/terminal",
    { websocket: true },
    (socket, request) => {
      if (!authorizedForRead(request.headers.authorization, deps.config)) {
        sendFrame(socket, { type: "error", message: "Unauthorized" });
        socket.close(1008, "Unauthorized");
        return;
      }

      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        sendFrame(socket, { type: "error", message: "Invalid workspace" });
        socket.close(1008, "Invalid workspace");
        return;
      }
      const { workspaceId } = params.data;
      const parsedQuery = querySchema.safeParse(request.query);
      const { cols, rows } = parsedQuery.success ? parsedQuery.data : {};
      const startedAt = Date.now();

      let handle: TerminalSessionHandle | undefined;
      let socketClosed = false;
      let startPublished = false;
      let closePublished = false;

      // PTY output backpressure state.
      let flowPaused = false;
      let resumePoll: NodeJS.Timeout | undefined;
      const stopResumePoll = (): void => {
        if (resumePoll) {
          clearInterval(resumePoll);
          resumePoll = undefined;
        }
      };
      const applyBackpressure = (): void => {
        if (!handle || flowPaused) return;
        if (socket.bufferedAmount <= SEND_BUFFER_HIGH_WATER_BYTES) return;
        flowPaused = true;
        handle.pause();
        resumePoll = setInterval(() => {
          if (!handle || socket.readyState !== socket.OPEN) {
            stopResumePoll();
            return;
          }
          if (socket.bufferedAmount <= SEND_BUFFER_LOW_WATER_BYTES) {
            flowPaused = false;
            stopResumePoll();
            handle.resume();
          }
        }, SEND_BUFFER_POLL_MS);
        resumePoll.unref?.();
      };

      // Only pairs with a published `started`; a session aborted before `ready` (client
      // gone during spawn) publishes neither, so audit never sees an orphan close.
      const publishClosed = (exitCode?: number): void => {
        if (closePublished || !startPublished || !handle) return;
        closePublished = true;
        const payload: TerminalSessionClosedPayload = {
          sessionId: handle.id,
          workspaceId,
          workspacePath: handle.workspacePath,
          audit: { ...(exitCode === undefined ? {} : { exitCode }), durationMs: Date.now() - startedAt }
        };
        deps.eventBus.publish("terminal_session_closed", payload);
      };

      void deps.terminalSessions
        .createSession({
          workspaceId,
          cols,
          rows,
          onData: (data) => {
            sendFrame(socket, { type: "output", data });
            applyBackpressure();
          },
          onExit: ({ exitCode }) => {
            // The shell exited on its own; the service already disposed the session.
            stopResumePoll();
            sendFrame(socket, { type: "exit", exitCode });
            publishClosed(exitCode);
            if (socket.readyState === socket.OPEN) socket.close(1000);
          }
        })
        .then((created) => {
          handle = created;
          if (socketClosed) {
            // The client disconnected while the shell was still spawning. Kill it; no
            // `started` was published, so publish no `closed` either.
            created.close();
            return;
          }
          sendFrame(socket, { type: "ready", sessionId: created.id });
          const startPayload: TerminalSessionStartedPayload = {
            sessionId: created.id,
            workspaceId,
            workspacePath: created.workspacePath
          };
          deps.eventBus.publish("terminal_session_started", startPayload);
          startPublished = true;
        })
        .catch((error) => {
          const message =
            error instanceof TerminalSessionError ? error.message : "Failed to start terminal";
          sendFrame(socket, { type: "error", message });
          if (socket.readyState === socket.OPEN) socket.close(1011);
        });

      socket.on("message", (raw: Buffer) => {
        if (!handle) return;
        if (raw.length > MAX_INBOUND_FRAME_BYTES) {
          socket.close(1009, "Frame too large");
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        const frame = clientFrameSchema.safeParse(parsed);
        if (!frame.success) return;
        if (frame.data.type === "input") {
          handle.write(frame.data.data);
        } else {
          handle.resize(frame.data.cols, frame.data.rows);
        }
      });

      socket.on("close", () => {
        socketClosed = true;
        stopResumePoll();
        // Kill the shell if the client went away while it was still running.
        handle?.close();
        publishClosed();
      });
    }
  );
}

function sendFrame(socket: OutboundSocket, frame: ServerFrame): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(frame));
}
