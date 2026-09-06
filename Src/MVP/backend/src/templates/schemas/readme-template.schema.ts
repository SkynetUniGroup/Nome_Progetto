import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ReadmeTemplateDocument = HydratedDocument<ReadmeTemplate>;

/**
 * RF.79: il template README personalizzato di un utente.
 *
 * Uno per utente, non uno per repository: il template descrive come
 * l'utente vuole che siano fatti i propri README, non com'è fatto un
 * progetto specifico. Da qui l'indice unico su userId — salvare di nuovo
 * sostituisce, non accumula versioni, perché RF.79 parla di "caricamento e
 * salvataggio", non di uno storico.
 *
 * Il contenuto sta qui e non nello storage a oggetti (dove finiscono i PDF
 * esportati): è testo di pochi kilobyte che serve a ogni avvio dell'Agente
 * Docs, e tenerlo accanto all'utente evita una chiamata di rete su un
 * percorso già sincrono.
 */
@Schema({ timestamps: true })
export class ReadmeTemplate {
  @Prop({ required: true })
  userId: string;

  // Conservato per poterlo rimostrare nell'interfaccia ("template attivo:
  // <nome>"): l'estensione è già stata validata al confine, qui è
  // un'etichetta.
  @Prop({ required: true })
  filename: string;

  @Prop({ required: true })
  content: string;
}

export const ReadmeTemplateSchema =
  SchemaFactory.createForClass(ReadmeTemplate);

ReadmeTemplateSchema.index({ userId: 1 }, { unique: true });
