import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Model, Types } from 'mongoose';
import { Queue } from 'bullmq';
import { Task, TaskDocument } from './schemas/task.schema';
import {
  AnalysisContext,
  AnalysisContextDocument,
} from '../contexts/schemas/analysis-context.schema';
import { CredentialsService } from '../credentials/credentials.service';
import { AgentRegistry } from '../operations/agent-registry.service';
import { EventsGateway } from '../events/events.gateway';
import { UsageLimitService } from './usage-limit.service';
import { AuthenticatedUser } from '../common/authenticated-user';
import { CreateTaskBatchDto } from './dto/create-task-batch.dto';
import { SubmitInputDto } from './dto/submit-input.dto';
import { TaskDto, toTaskDto } from './dto/task.dto';
import { RunTaskJobData } from './task-processor';

export interface CreateTaskBatchResult {
  taskIds: string[];
  batchId: string;
}

@Injectable()
export class TasksService {
  constructor(
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
    @InjectModel(AnalysisContext.name)
    private readonly contextModel: Model<AnalysisContextDocument>,
    private readonly credentials: CredentialsService,
    private readonly agentRegistry: AgentRegistry,
    private readonly events: EventsGateway,
    private readonly usageLimit: UsageLimitService,
    @InjectQueue('tasks') private readonly queue: Queue<RunTaskJobData>,
  ) {}

  // Four pre-accept checks: whole batch rejected on the first failure,
  // nothing partially queued. Order goes cheapest/local first, database
  // reads next, and the usage-limit check (RF.66, BE-14) last — it's the
  // only one that writes (and might have to roll its own write back), so it
  // only runs once everything else about the request is already known
  // valid, rather than spending quota on a request that would've failed
  // anyway.
  async createBatch(
    user: AuthenticatedUser,
    dto: CreateTaskBatchDto,
  ): Promise<CreateTaskBatchResult> {
    const operations = [...new Set(dto.operations)];
    if (operations.length === 0) {
      throw new BadRequestException(
        'operations must contain at least one operation code',
      );
    }

    const context = await this.contextModel.findOne({
      _id: dto.contextId,
      userId: user.userId,
    });
    if (!context) {
      throw new NotFoundException(`Context ${dto.contextId} not found`);
    }

    const hasCredential = await this.credentials.hasCredential(
      user.userId,
      'GITHUB',
    );
    if (!hasCredential) {
      throw new NotFoundException('No GITHUB credential configured');
    }

    const allowed = new Set(
      this.agentRegistry.getForRole(user.role).map((entry) => entry.code),
    );
    const disallowed = operations.filter((op) => !allowed.has(op));
    if (disallowed.length > 0) {
      throw new ForbiddenException(
        `Operation(s) not permitted for role ${user.role}: ${disallowed.join(', ')}`,
      );
    }

    await this.usageLimit.checkAndIncrement(user.userId, operations.length);

    const batchId = new Types.ObjectId().toString();
    const tasks = await this.taskModel.insertMany(
      operations.map((operation) => ({
        userId: user.userId,
        batchId,
        contextId: context._id,
        operation,
        status: 'PENDING',
      })),
    );

    await this.queue.addBulk(
      tasks.map((task) => ({
        name: 'run-task',
        data: { taskId: task.id },
      })),
    );

    return { taskIds: tasks.map((task) => task.id), batchId };
  }

  async findAllForUser(userId: string): Promise<TaskDto[]> {
    const tasks = await this.taskModel.find({ userId }).sort({ createdAt: -1 });
    return tasks.map(toTaskDto);
  }

  async findOneForUser(userId: string, id: string): Promise<TaskDto> {
    const task = await this.taskModel.findOne({ _id: id, userId });
    if (!task) {
      throw new NotFoundException(`Task ${id} not found`);
    }
    return toTaskDto(task);
  }

  // No attempt to pull an already-enqueued job back out of the queue: if the
  // worker picks it up after this runs, TaskProcessor's claim filter only
  // matches PENDING/RUNNING Tasks and skips a cancelled one silently. That
  // guard has to exist there anyway for the race to be handled correctly,
  // so a second removal path here would be redundant, not safer.
  async cancel(userId: string, id: string): Promise<void> {
    const task = await this.taskModel.findOne({ _id: id, userId });
    if (!task) {
      throw new NotFoundException(`Task ${id} not found`);
    }
    if (!task.canTransitionTo('CANCELLED')) {
      throw new ConflictException(
        `Task ${id} cannot be cancelled from status ${task.status}`,
      );
    }

    if (!(await this.markCancelled(id, userId))) {
      throw new ConflictException(
        `Task ${id} reached a terminal state before it could be cancelled`,
      );
    }
    this.events.emitTaskUpdated(userId, id, 'CANCELLED');
  }

  // The cancellation itself, conditioned on the Task still being
  // cancellable at the moment of the write. The canTransitionTo() check at
  // the call sites reads a document fetched moments earlier: good enough to
  // produce a precise 409 message, useless for deciding the race against
  // TaskProcessor, since a RUNNING Task can finish in between — and a plain
  // task.save() would then $set CANCELLED over a Task the agent had already
  // completed, resurrecting a terminal Task. False here means exactly that
  // happened, and the caller turns it into a 409 rather than announcing a
  // cancellation that never took effect.
  private async markCancelled(
    id: string,
    userId: string,
    changes: Record<string, unknown> = {},
  ): Promise<boolean> {
    const { matchedCount } = await this.taskModel.updateOne(
      { _id: id, userId, status: { $in: ['PENDING', 'RUNNING'] } },
      { $set: { status: 'CANCELLED', ...changes } },
    );
    return matchedCount === 1;
  }

  // BE-17: the counterpart to whichever pendingInput TaskProcessor set.
  // SPRINT_ID carries a real value the agent needs to even start; the other
  // two are a plain PROCEED-or-CANCEL confirmation of a run already in
  // progress. Re-enqueueing onto the same 'tasks' queue TaskProcessor
  // already drains — rather than resuming the agent from here directly —
  // keeps this method a thin state transition, symmetric with how
  // createBatch never calls the agent gateway itself either.
  async submitInput(
    userId: string,
    id: string,
    dto: SubmitInputDto,
  ): Promise<void> {
    const task = await this.taskModel.findOne({ _id: id, userId });
    if (!task) {
      throw new NotFoundException(`Task ${id} not found`);
    }

    const pending = task.pendingInput;
    if (!pending) {
      throw new ConflictException(`Task ${id} has no pending input`);
    }
    if (pending.kind !== dto.kind) {
      throw new ConflictException(
        `Task ${id} is waiting for ${pending.kind}, not ${dto.kind}`,
      );
    }

    if (dto.kind === 'SPRINT_ID') {
      task.sprintId = dto.sprintId;
      task.pendingInput = null;
      await task.save();
      // Same job name/shape POST /tasks itself enqueues — the Task is
      // already RUNNING (never left it to get here), so TaskProcessor skips
      // the PENDING transition and goes straight to invoking the agent
      // now that sprintId is set.
      const jobData: RunTaskJobData = { taskId: task.id };
      await this.queue.add('run-task', jobData);
      return;
    }

    // INCOMPLETE_TASKS / BUSINESS_CONFIRMATION: CANCEL never reaches the
    // agent at all — it's the same Task-level transition
    // POST /tasks/:id/cancel performs, just entered from a paused Task
    // instead of a running one.
    if (dto.action === 'CANCEL') {
      if (!task.canTransitionTo('CANCELLED')) {
        throw new ConflictException(
          `Task ${id} cannot be cancelled from status ${task.status}`,
        );
      }
      // Same conditional write as POST /tasks/:id/cancel — it is the same
      // transition, entered from a paused Task instead of a running one, so
      // it gets the same protection against a TaskProcessor invocation
      // finishing in between.
      if (!(await this.markCancelled(id, userId, { pendingInput: null }))) {
        throw new ConflictException(
          `Task ${id} reached a terminal state before it could be cancelled`,
        );
      }
      this.events.emitTaskUpdated(userId, id, 'CANCELLED');
      return;
    }

    task.pendingInput = null;
    await task.save();
    const jobData: RunTaskJobData = {
      taskId: task.id,
      inputValue: { action: 'PROCEED' },
    };
    await this.queue.add('resume-task', jobData);
  }
}
