/**
 * Lo stato del template README di un utente, come lo vede l'interfaccia.
 *
 * `active: false` non è un errore: è il caso normale di chi non ha mai
 * caricato nulla e sta usando il modello di default dell'Agente Docs
 * (RF.81 lo definisce anche come lo stato in cui si torna dopo una
 * rimozione). Rispondere 200 con questo oggetto invece di 404 permette
 * all'interfaccia di distinguere "nessun template" da "richiesta fallita".
 */
export class ReadmeTemplateDto {
  active: boolean;
  filename: string | null;
  content: string | null;
  updatedAt: string | null;
}
