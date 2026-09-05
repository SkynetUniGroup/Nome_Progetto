import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useSessionStore } from '../stores/sessionStore';
import { useTasksStore } from '../stores/tasksStore';
import type {
  TaskUpdatedEvent,
  TaskProgressEvent,
  TaskFailedEvent,
  BatchCompletedEvent,
  TaskInputRequiredEvent,
} from '../types';
import { apiClient } from '../api/client';

/**
 * WebSocket connection URL.
 * Uses the same relative-path pattern as the REST API: a leading '/' targets
 * the current origin, which means CloudFront routes the upgrade request to the
 * correct backend. Never hardcode a domain here.
 */
const WS_URL = '/';

/**
 * useWebSocket — singleton Socket.IO connection hook.
 *
 * Responsibilities:
 *  1. Opens a Socket.IO connection authenticated with the in-memory JWT.
 *  2. Registers handlers for all task-related server events.
 *  3. On reconnect, calls GET /tasks to resync any events that were emitted
 *     while the socket was disconnected (Socket.IO does not buffer missed events).
 *  4. Closes the socket on component unmount or when the user logs out.
 *
 * This hook should be called exactly once, at the root of the authenticated
 * layout (AppShell). Calling it in multiple components would open duplicate
 * connections.
 */
export function useWebSocket(): void {
  const socketRef = useRef<Socket | null>(null);

  // Zustand store selectors — stable references across renders.
  const token = useSessionStore((s) => s.token);
  const markCredentialsInvalid = useSessionStore((s) => s.markCredentialsInvalid);
  const { upsertFromUpdated, upsertFromProgress, applyFailed, applyInputRequired, loadTasks } =
    useTasksStore();

  useEffect(() => {
    // Do not open a connection when the user is not authenticated.
    if (!token) return;

    /**
     * Resyncs all tasks from the REST API.
     * Called on successful WebSocket reconnect to recover events that were
     * emitted by the server while the client was disconnected.
     */
    async function resync_tasks(): Promise<void> {
      try {
        const response = await apiClient.get<any[]>('/tasks');
        // Map the raw backend DTO to the local TaskEntry shape.
        const tasks = response.data.map((t: any) => ({
          id: t.id,
          operation: t.operation,
          status: t.status,
          progressPercent: t.progressPercent ?? 0,
          currentStage: t.currentStage ?? null,
          reportId: t.reportId ?? null,
          error: t.error ?? null,
          pendingInput: null, // pendingInput is ephemeral; re-emitted via WS if still active
        }));
        loadTasks(tasks);
      } catch {
        // Non-critical; the user will still see stale state rather than crashing.
        console.warn('[WS] Resync failed — task list may be out of date');
      }
    }

    // Open the Socket.IO connection.
    const socket: Socket = io(WS_URL, {
      // Pass the JWT as a handshake query parameter; the backend reads it in
      // the 'auth' namespace middleware instead of HTTP headers (Socket.IO
      // does not support custom headers during the upgrade handshake).
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    socketRef.current = socket;

    // ---- Event handlers ----

    socket.on('connect', () => {
      console.info('[WS] Connected:', socket.id);
    });

    socket.on('disconnect', (reason) => {
      console.info('[WS] Disconnected:', reason);
    });

    /**
     * task.updated — top-level status change.
     * Fired when a task moves between PENDING / RUNNING / COMPLETED / CANCELLED.
     */
    socket.on('task.updated', (event: TaskUpdatedEvent) => {
      upsertFromUpdated(event);
    });

    /**
     * task.progress — execution progress update.
     * Fired periodically by the agent with the current stage name and %.
     */
    socket.on('task.progress', (event: TaskProgressEvent) => {
      upsertFromProgress(event);
    });

    /**
     * task.failed — terminal failure.
     * When the error code is CREDENTIAL_INVALID we also mark the global
     * credentials status so the banner and route guards activate immediately.
     */
    socket.on('task.failed', (event: TaskFailedEvent) => {
      applyFailed(event);
      if (event.error?.code === 'CREDENTIAL_INVALID') {
        markCredentialsInvalid();
      }
    });

    /**
     * batch.completed — all tasks in a batch have finished.
     * Currently used only for logging; individual task.updated events carry
     * the authoritative final status.
     */
    socket.on('batch.completed', (event: BatchCompletedEvent) => {
      console.info('[WS] Batch completed:', event.batchId);
    });

    /**
     * task.inputRequired — the agent is paused and needs user input.
     * The tasksStore attaches the pendingInput payload to the relevant task,
     * and the Tasks dashboard renders the appropriate modal.
     */
    socket.on('task.inputRequired', (event: TaskInputRequiredEvent) => {
      applyInputRequired(event);
    });

    /**
     * On reconnect, fetch fresh task state from the REST API.
     * Socket.IO does not replay events that were missed while disconnected,
     * so a manual resync is necessary to restore correct UI state.
     */
    socket.io.on('reconnect', () => {
      console.info('[WS] Reconnected — resyncing tasks');
      resync_tasks();
    });

    // ---- Cleanup ----
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token]); // Re-run when the token changes (login / logout).
}
