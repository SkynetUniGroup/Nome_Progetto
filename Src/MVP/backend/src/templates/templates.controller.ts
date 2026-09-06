import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TemplatesService } from './templates.service';
import { SaveReadmeTemplateDto } from './dto/save-readme-template.dto';
import { ReadmeTemplateDto } from './dto/readme-template.dto';

/**
 * RF.79 / RF.80 / RF.81 — il template README dell'utente autenticato.
 *
 * Risorsa singola e non collezione: l'utente ne ha uno solo, quindi la
 * rotta non porta identificativo e non serve un RolesGuard — il template
 * appartiene a chi chiama, chiunque esso sia, e l'identità viene dal token
 * verificato tramite @CurrentUser, mai da un parametro.
 *
 * PUT e non POST perché salvare due volte lo stesso template deve lasciare
 * il sistema nello stesso stato: il caricamento sostituisce, non accumula.
 */
@Controller('templates/readme')
@UseGuards(JwtAuthGuard)
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Put()
  @HttpCode(HttpStatus.OK)
  save(
    @CurrentUser('userId') userId: string,
    @Body() dto: SaveReadmeTemplateDto,
  ): Promise<ReadmeTemplateDto> {
    return this.templatesService.save(userId, dto);
  }

  @Get()
  find(@CurrentUser('userId') userId: string): Promise<ReadmeTemplateDto> {
    return this.templatesService.find(userId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser('userId') userId: string): Promise<void> {
    return this.templatesService.remove(userId);
  }
}
