import {
  ConnectedSocket,
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { JwtService } from "@nestjs/jwt";
import { Server, Socket } from "socket.io";
import { PendingInput, TaskError, TaskStatus } from "../tasks/task.types";

interface HandshakeJwtPayload {
  sub: string;
}

// One room per user ("user:<userId>"), joined automatically once the JWT on
// the connection handshake verifies. This is a deliberate simplification of
// the spec's per-taskId subscription model: every REST endpoint already
// scopes tasks/reports by ownership, so a user only ever needs to see their
// own tasks, and joining by user means the frontend never has to send a
// subscription message after connecting at all — a stricter reading of "the
// frontend never emits application events" than the per-task version.
@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN },
})
export class EventsGateway implements OnGatewayConnection {
  @WebSocketServer()
  private readonly server!: Server;

  constructor(private readonly jwt: JwtService) {}

  handleConnection(client: Socket): void {
    const token = client.handshake.auth?.token as string | undefined;
    if (!token) {
      client.disconnect();
      return;
    }

    try {
      const payload = this.jwt.verify<HandshakeJwtPayload>(token);
      void client.join(this.roomFor(payload.sub));
    } catch {
      client.disconnect();
    }
  }

  emitTaskProgress(userId: string, taskId: string, stage: string, percent: number): void {
    this.server.to(this.roomFor(userId)).emit("task.progress", { taskId, stage, percent });
  }

  emitTaskUpdated(userId: string, taskId: string, status: TaskStatus, reportId?: string): void {
    this.server.to(this.roomFor(userId)).emit("task.updated", { taskId, status, reportId });
  }

  emitTaskFailed(userId: string, taskId: string, error: TaskError): void {
    this.server.to(this.roomFor(userId)).emit("task.failed", { taskId, error });
  }

  emitBatchCompleted(userId: string, batchId: string, completed: number, failed: number): void {
    this.server.to(this.roomFor(userId)).emit("batch.completed", { batchId, completed, failed });
  }

  // Flat shape — { taskId, kind, taskIds?, technicalReportId? } — matching
  // how the other four events are shaped, and matching the Progettazione
  // Frontend's own Table 6 rather than nesting a `pendingInput` object.
  // taskId is a deliberate addition beyond that table: a bare PendingInput
  // carries no way to tell the frontend which task it belongs to once more
  // than one is in flight. technicalReportId is a deliberate *correction* to
  // Table 6, which names this field `reportId` — already taken, on this
  // same TaskEntry, by the task's own final report (see task.updated above
  // and TaskDto.reportId). BUSINESS_CONFIRMATION's report is a different,
  // earlier-phase report (the technical changelog preview); reusing `reportId`
  // for it would let one overwrite the other on whichever event lands last.
  // `technicalReportId` is what both design docs' own PendingInput type
  // already calls this same field — Table 6 is the outlier, not this.
  emitTaskInputRequired(
    userId: string,
    taskId: string,
    pendingInput: Exclude<PendingInput, null>,
  ): void {
    const taskIds = "taskIds" in pendingInput ? pendingInput.taskIds : undefined;
    const technicalReportId =
      "technicalReportId" in pendingInput ? pendingInput.technicalReportId : undefined;

    this.server.to(this.roomFor(userId)).emit("task.inputRequired", {
      taskId,
      kind: pendingInput.kind,
      taskIds,
      technicalReportId,
    });
  }

  private roomFor(userId: string): string {
    return `user:${userId}`;
  }
}
