import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/authenticated-user';
import { TasksService, CreateTaskBatchResult } from './tasks.service';
import { CreateTaskBatchDto } from './dto/create-task-batch.dto';
import { SubmitInputDto } from './dto/submit-input.dto';
import { TaskDto } from './dto/task.dto';

@Controller('tasks')
@UseGuards(JwtAuthGuard)
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  // No @Roles() restriction here — a batch can mix operations from
  // different agents, so the permission check is per-operation, inside
  // TasksService, not a single role gate on the whole endpoint.
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTaskBatchDto,
  ): Promise<CreateTaskBatchResult> {
    return this.tasksService.createBatch(user, dto);
  }

  @Get()
  findAll(@CurrentUser('userId') userId: string): Promise<TaskDto[]> {
    return this.tasksService.findAllForUser(userId);
  }

  @Get(':id')
  findOne(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<TaskDto> {
    return this.tasksService.findOneForUser(userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  cancel(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<void> {
    return this.tasksService.cancel(userId, id);
  }

  // BE-17: the counterpart to whatever pendingInput TaskProcessor last set —
  // one endpoint for all three kinds, since the frontend already models
  // them as a single discriminated union (PendingInput/SubmitInputDto),
  // rather than three near-duplicate routes.
  @Post(':id/input')
  @HttpCode(HttpStatus.NO_CONTENT)
  submitInput(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: SubmitInputDto,
  ): Promise<void> {
    return this.tasksService.submitInput(userId, id, dto);
  }
}
