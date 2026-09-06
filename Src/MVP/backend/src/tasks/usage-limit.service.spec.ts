import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { UsageLimitService } from './usage-limit.service';
import { UsageCounter } from './schemas/usage-counter.schema';

describe('UsageLimitService', () => {
  let service: UsageLimitService;
  let model: { findOneAndUpdate: jest.Mock; updateOne: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(async () => {
    model = { findOneAndUpdate: jest.fn(), updateOne: jest.fn() };
    config = { get: jest.fn().mockReturnValue(50) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsageLimitService,
        { provide: getModelToken(UsageCounter.name), useValue: model },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get(UsageLimitService);
  });

  it('increments atomically via $inc + upsert, scoped to the current calendar month', async () => {
    model.findOneAndUpdate.mockResolvedValue({ count: 5 });

    await service.checkAndIncrement('user1', 3);

    const [filter, update, options] = model.findOneAndUpdate.mock.calls[0] as [
      { userId: string; yearMonth: string },
      { $inc: { count: number } },
      { upsert: boolean; new: boolean },
    ];
    expect(filter.userId).toBe('user1');
    // Il mese vero, non la sua forma: con /^\d{4}-\d{2}$/ anche un
    // currentYearMonth() bloccato su '1970-01' passava, e il contatore di
    // RF.66 non si sarebbe più azzerato — il tetto mensile diventava un
    // tetto a vita.
    expect(filter.yearMonth).toBe(new Date().toISOString().slice(0, 7));
    expect(update).toEqual({ $inc: { count: 3 } });
    expect(options).toEqual({ upsert: true, new: true });
    expect(model.updateOne).not.toHaveBeenCalled();
  });

  it('allows a request that lands exactly on the limit', async () => {
    model.findOneAndUpdate.mockResolvedValue({ count: 50 });

    await expect(
      service.checkAndIncrement('user1', 10),
    ).resolves.toBeUndefined();
    expect(model.updateOne).not.toHaveBeenCalled();
  });

  it('rejects with USAGE_LIMIT_EXCEEDED and rolls back its own increment when the cap is exceeded', async () => {
    model.findOneAndUpdate.mockResolvedValue({ count: 51 });

    await expect(service.checkAndIncrement('user1', 10)).rejects.toMatchObject({
      code: 'USAGE_LIMIT_EXCEEDED',
    });

    expect(model.updateOne).toHaveBeenCalledWith(
      {
        userId: 'user1',
        yearMonth: new Date().toISOString().slice(0, 7),
      },
      { $inc: { count: -10 } },
    );
  });

  it('rejects a brand-new user whose very first batch alone exceeds the cap', async () => {
    // No prior document for this user this month — findOneAndUpdate's
    // upsert creates one, and $inc from nothing still produces the full
    // batch size as the new count. This is exactly the case a plain
    // conditional-filter approach (count <= cap - batchSize) would miss.
    config.get.mockReturnValue(5);
    model.findOneAndUpdate.mockResolvedValue({ count: 10 });

    await expect(
      service.checkAndIncrement('newUser', 10),
    ).rejects.toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' });
    expect(model.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'newUser' }),
      { $inc: { count: -10 } },
    );
  });
});
