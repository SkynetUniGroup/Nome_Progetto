import { IsNotEmpty, IsString } from 'class-validator';

/**
 * RF.79 — il template caricato dall'utente.
 *
 * Il file viene letto dal browser e inviato come testo, non come multipart:
 * il contenuto è Markdown di pochi kilobyte, e passare da JSON evita di
 * introdurre un parser di upload per un solo endpoint. Il nome originale
 * viaggia a parte perché è ciò su cui si applica la regola sull'estensione
 * (RF.80) ed è quello che l'interfaccia rimostra all'utente.
 *
 * Qui si controlla solo che i due campi ci siano e siano stringhe: le
 * regole di validità vere stanno in validaTemplateReadme, dove producono un
 * messaggio spiegabile all'utente invece dell'errore generico del
 * ValidationPipe.
 */
export class SaveReadmeTemplateDto {
  @IsString()
  @IsNotEmpty()
  filename: string;

  @IsString()
  @IsNotEmpty()
  content: string;
}
