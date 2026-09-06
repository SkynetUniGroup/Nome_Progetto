import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException } from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { ReadmeTemplate } from './schemas/readme-template.schema';

describe('TemplatesService', () => {
  let service: TemplatesService;
  let model: {
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
    deleteOne: jest.Mock;
  };

  const contenuto = '# {{project_name}}\n\n## Uso\n';

  function salvato(over: Record<string, unknown> = {}) {
    return {
      userId: 'user1',
      filename: 'template.md',
      content: contenuto,
      updatedAt: new Date('2026-03-01T10:00:00.000Z'),
      ...over,
    };
  }

  beforeEach(async () => {
    model = {
      findOne: jest.fn().mockResolvedValue(null),
      findOneAndUpdate: jest.fn().mockResolvedValue(salvato()),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TemplatesService,
        { provide: getModelToken(ReadmeTemplate.name), useValue: model },
      ],
    }).compile();

    service = module.get(TemplatesService);
  });

  // --- RF.79: caricamento e salvataggio ------------------------------------

  describe('save', () => {
    it('stores the template against the caller, and reports it as active', async () => {
      const dto = { filename: 'template.md', content: contenuto };

      const risultato = await service.save('user1', dto);

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        { userId: 'user1' },
        { $set: { filename: 'template.md', content: contenuto } },
        expect.objectContaining({ upsert: true, new: true }),
      );
      expect(risultato).toEqual({
        active: true,
        filename: 'template.md',
        content: contenuto,
        updatedAt: '2026-03-01T10:00:00.000Z',
      });
    });

    it('replaces the previous template instead of accumulating versions', async () => {
      // upsert: ricaricare è un salvataggio, non uno storico (RF.79).
      await service.save('user1', { filename: 'a.md', content: contenuto });

      const [, , opzioni] = model.findOneAndUpdate.mock.calls[0] as [
        unknown,
        unknown,
        { upsert: boolean },
      ];
      expect(opzioni.upsert).toBe(true);
    });

    it('trims the filename before storing it', async () => {
      await service.save('user1', {
        filename: '  template.md  ',
        content: contenuto,
      });

      const [, aggiornamento] = model.findOneAndUpdate.mock.calls[0] as [
        unknown,
        { $set: { filename: string } },
      ];
      expect(aggiornamento.$set.filename).toBe('template.md');
    });

    // --- RF.80: il file non valido non arriva al database ------------------

    it('rejects a non-.md file with 400 and never touches the database', async () => {
      await expect(
        service.save('user1', { filename: 'template.txt', content: contenuto }),
      ).rejects.toThrow(BadRequestException);

      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('surfaces the reason for the rejection, not just the failure', async () => {
      // RF.80 chiede un messaggio d'errore: un 400 muto non lo soddisfa.
      await expect(
        service.save('user1', { filename: 'template.txt', content: contenuto }),
      ).rejects.toMatchObject({ message: expect.stringContaining('.md') });
    });

    it('rejects an empty template before writing', async () => {
      await expect(
        service.save('user1', { filename: 'template.md', content: '  ' }),
      ).rejects.toThrow(BadRequestException);

      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  // --- lettura -------------------------------------------------------------

  describe('find', () => {
    it('scopes the lookup to the caller', async () => {
      await service.find('user1');

      expect(model.findOne).toHaveBeenCalledWith({ userId: 'user1' });
    });

    it('reports "no template" rather than failing when the user never uploaded one', async () => {
      model.findOne.mockResolvedValue(null);

      expect(await service.find('user1')).toEqual({
        active: false,
        filename: null,
        content: null,
        updatedAt: null,
      });
    });

    it('returns the stored template when there is one', async () => {
      model.findOne.mockResolvedValue(salvato());

      expect(await service.find('user1')).toMatchObject({
        active: true,
        filename: 'template.md',
        content: contenuto,
      });
    });
  });

  // --- RF.81: rimozione e ripristino del default ---------------------------

  describe('remove', () => {
    it('deletes only the caller own template', async () => {
      await service.remove('user1');

      expect(model.deleteOne).toHaveBeenCalledWith({ userId: 'user1' });
    });

    it('is a no-op rather than an error when there is nothing to remove', async () => {
      // Lo stato richiesto — nessun template personalizzato — è già quello.
      model.deleteOne.mockResolvedValue({ deletedCount: 0 });

      await expect(service.remove('user1')).resolves.toBeUndefined();
    });

    it('leaves the user back on the agent default, which is the absence of a template', async () => {
      model.findOne.mockResolvedValue(null);

      await service.remove('user1');

      expect(await service.contentForUser('user1')).toBeNull();
    });
  });

  // --- ciò che viene passato all'agente ------------------------------------

  describe('contentForUser', () => {
    it('returns the raw content when the caller has a template', async () => {
      model.findOne.mockResolvedValue(salvato());

      expect(await service.contentForUser('user1')).toBe(contenuto);
    });

    it('returns null when they have none', async () => {
      model.findOne.mockResolvedValue(null);

      expect(await service.contentForUser('user1')).toBeNull();
    });

    it('never reads another user template', async () => {
      await service.contentForUser('user2');

      expect(model.findOne).toHaveBeenCalledWith({ userId: 'user2' });
    });
  });
});
