import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ReadmeTemplate,
  ReadmeTemplateDocument,
} from './schemas/readme-template.schema';
import { SaveReadmeTemplateDto } from './dto/save-readme-template.dto';
import { ReadmeTemplateDto } from './dto/readme-template.dto';
import { validaTemplateReadme } from './readme-template.validation';

/**
 * RF.79 / RF.80 / RF.81 — gestione del template README personalizzato.
 *
 * Ogni operazione è vincolata a `userId`: il template è personale, e come
 * per i Report un utente non deve poter vedere né toccare quello di un
 * altro. Il filtro porta sempre userId, mai il solo identificativo.
 */
@Injectable()
export class TemplatesService {
  constructor(
    @InjectModel(ReadmeTemplate.name)
    private readonly templateModel: Model<ReadmeTemplateDocument>,
  ) {}

  /** RF.79: carica o sostituisce il template dell'utente. */
  async save(
    userId: string,
    dto: SaveReadmeTemplateDto,
  ): Promise<ReadmeTemplateDto> {
    // RF.80: il file viene giudicato prima di toccare il database, e il
    // motivo del rifiuto arriva all'utente per esteso.
    const esito = validaTemplateReadme(dto.filename, dto.content);
    if (!esito.valido) {
      throw new BadRequestException(esito.errore);
    }

    // Upsert e non insert: RF.79 parla di "salvataggio", quindi ricaricare
    // sostituisce. L'indice unico su userId renderebbe comunque un insert
    // un conflitto al secondo caricamento.
    const salvato = await this.templateModel.findOneAndUpdate(
      { userId },
      { $set: { filename: dto.filename.trim(), content: dto.content } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return toDto(salvato);
  }

  /** Stato corrente, per l'interfaccia e per l'avvio dell'Agente Docs. */
  async find(userId: string): Promise<ReadmeTemplateDto> {
    const trovato = await this.templateModel.findOne({ userId });
    return trovato ? toDto(trovato) : assente();
  }

  /**
   * RF.81: rimuove il template personalizzato.
   *
   * Non c'è nulla da ripristinare esplicitamente: il modello di default
   * dell'Agente Docs è quello che l'agente usa quando non gli viene passato
   * alcun template, quindi cancellare *è* il ripristino. Rimuovere un
   * template che non c'è non è un errore — lo stato richiesto (nessun
   * template) è già quello.
   */
  async remove(userId: string): Promise<void> {
    await this.templateModel.deleteOne({ userId });
  }

  /**
   * Il contenuto da passare all'agente, o null se l'utente non ne ha uno.
   *
   * Separato da find() perché il chiamante (AgentInvocationService) non ha
   * bisogno del DTO dell'interfaccia e non deve dipendere dalla sua forma.
   */
  async contentForUser(userId: string): Promise<string | null> {
    const trovato = await this.templateModel.findOne({ userId });
    return trovato?.content ?? null;
  }
}

function assente(): ReadmeTemplateDto {
  return { active: false, filename: null, content: null, updatedAt: null };
}

function toDto(doc: ReadmeTemplateDocument): ReadmeTemplateDto {
  const conTimestamp = doc as ReadmeTemplateDocument & { updatedAt?: Date };
  return {
    active: true,
    filename: doc.filename,
    content: doc.content,
    updatedAt: conTimestamp.updatedAt?.toISOString() ?? null,
  };
}
