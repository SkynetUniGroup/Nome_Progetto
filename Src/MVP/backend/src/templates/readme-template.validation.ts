/**
 * RF.80 — regole di validità di un template README caricato.
 *
 * Funzione pura, separata dal servizio, per due ragioni: è l'unica parte
 * con una logica vera da verificare caso per caso, e il messaggio d'errore
 * che produce finisce a schermo (RF.80 chiede che l'utente sappia *perché*
 * il file è stato rifiutato, non solo che lo è stato).
 */

/** Oltre questa soglia non è più un template ma un documento. */
export const MAX_TEMPLATE_BYTES = 64 * 1024;

export interface EsitoValidazione {
  valido: boolean;
  errore?: string;
}

/**
 * I caratteri di controllo ammessi in un file di testo: tabulazione, a
 * capo e ritorno a capo. Qualunque altro byte di controllo — NUL in testa —
 * indica un file binario a cui è stata cambiata l'estensione.
 */
const CONTROLLI_NON_AMMESSI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

export function validaTemplateReadme(
  filename: string,
  content: string,
): EsitoValidazione {
  const nome = (filename ?? '').trim();

  if (!nome) {
    return { valido: false, errore: 'Il nome del file è obbligatorio.' };
  }

  // Un nome con separatori non è un nome di file: è un percorso, e non
  // deve poter descrivere una posizione sul server.
  if (nome.includes('/') || nome.includes('\\')) {
    return {
      valido: false,
      errore: 'Il nome del file non può contenere percorsi.',
    };
  }

  if (!nome.toLowerCase().endsWith('.md')) {
    return {
      valido: false,
      errore:
        'Il template deve essere un file Markdown con estensione .md.',
    };
  }

  if (!content || !content.trim()) {
    return { valido: false, errore: 'Il template è vuoto.' };
  }

  if (CONTROLLI_NON_AMMESSI.test(content)) {
    return {
      valido: false,
      errore:
        'Il file non è un documento di testo: contiene caratteri non stampabili.',
    };
  }

  // Misurato in byte e non in caratteri: il limite protegge lo spazio
  // occupato, e un template pieno di accenti o emoji pesa più della sua
  // lunghezza.
  if (Buffer.byteLength(content, 'utf8') > MAX_TEMPLATE_BYTES) {
    return {
      valido: false,
      errore: `Il template supera la dimensione massima di ${
        MAX_TEMPLATE_BYTES / 1024
      } KB.`,
    };
  }

  return { valido: true };
}
