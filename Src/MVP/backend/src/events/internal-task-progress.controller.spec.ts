import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { NotFoundException } from '@nestjs/common';
import { InternalTaskProgressController } from './internal-task-progress.controller';
import { EventsGateway } from './events.gateway';
import { InternalAuthGuard } from '../common/guards/internal-auth.guard';
import { Task } from '../tasks/schemas/task.schema';

describe('InternalTaskProgressController', () => {
  let controller: InternalTaskProgressController;
  let model: { findByIdAndUpdate: jest.Mock };
  let events: { emitTaskProgress: jest.Mock };

  beforeEach(async () => {
    model = {
      findByIdAndUpdate: jest.fn().mockResolvedValue({ userId: 'user-1' }),
    };
    events = { emitTaskProgress: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InternalTaskProgressController],
      providers: [
        { provide: getModelToken(Task.name), useValue: model },
        { provide: EventsGateway, useValue: events },
      ],
    })
      // The HMAC guard has its own spec; here we exercise the handler.
      .overrideGuard(InternalAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<InternalTaskProgressController>(
      InternalTaskProgressController,
    );
  });

  it('records the progress reported by the agent on the task', async () => {
    await controller.progress('task-1', { stage: 'analisi_llm', percent: 65 });

    expect(model.findByIdAndUpdate).toHaveBeenCalledWith('task-1', {
      progressPercent: 65,
      currentStage: 'analisi_llm',
    });
  });

  it('forwards the update to the owner of the task, not to everyone', async () => {
    await controller.progress('task-1', { stage: 'analisi_llm', percent: 65 });

    expect(events.emitTaskProgress).toHaveBeenCalledWith(
      'user-1',
      'task-1',
      'analisi_llm',
      65,
    );
  });

  it('rejects a callback naming a task that does not exist', async () => {
    model.findByIdAndUpdate.mockResolvedValueOnce(null);

    await expect(
      controller.progress('task-sconosciuta', { stage: 'x', percent: 1 }),
    ).rejects.toThrow(NotFoundException);
  });

  it('emits nothing when the task is unknown', async () => {
    // Emitting on a room derived from a missing task would either throw or
    // leak the event to the wrong recipient.
    model.findByIdAndUpdate.mockResolvedValueOnce(null);

    await expect(
      controller.progress('task-sconosciuta', { stage: 'x', percent: 1 }),
    ).rejects.toThrow(NotFoundException);
    expect(events.emitTaskProgress).not.toHaveBeenCalled();
  });
});
