import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import {
  ReadmeTemplate,
  ReadmeTemplateSchema,
} from './schemas/readme-template.schema';

/**
 * RF.79-RF.81. Esporta TemplatesService perché TasksModule ne ha bisogno:
 * all'avvio di un'operazione DOCS_README il template dell'utente va
 * allegato all'invocazione dell'agente.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReadmeTemplate.name, schema: ReadmeTemplateSchema },
    ]),
  ],
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
