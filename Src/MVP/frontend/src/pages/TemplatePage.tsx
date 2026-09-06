import { useState, useEffect, type ChangeEvent } from 'react';
import { apiClient, AxiosError } from '../api/client';
import { Spinner } from '../components/shared/Spinner';
import type { ReadmeTemplateDto } from '../types';

/**
 * TemplatePage — /template
 *
 * RF.79: caricamento e salvataggio di un template Markdown personalizzato
 * per il README.
 * RF.80: il file viene rifiutato con un messaggio esplicito se non è un .md
 * valido.
 * RF.81: la rimozione riporta l'Agente Docs al proprio modello di default.
 *
 * Il file viene letto dal browser e inviato come testo: il contenuto è
 * Markdown di pochi kilobyte, e passare da JSON evita un endpoint multipart
 * per un solo caso d'uso.
 *
 * Il controllo sull'estensione non viene fatto qui: l'`accept=".md"` del
 * campo file è un aiuto all'utente, non una garanzia (si aggira scegliendo
 * "tutti i file"), quindi l'autorità resta il backend e questa pagina si
 * limita a mostrare il motivo del rifiuto che le arriva.
 */
/** Corpo d'errore uniforme del backend (AllExceptionsFilter). */
interface CorpoErrore {
  code?: string;
  message?: string | string[];
  details?: string[];
}

/**
 * RF.80: il motivo per cui il file è stato rifiutato, come lo dice il backend.
 *
 * Su un 400 il filtro delle eccezioni normalizza sempre `message` a
 * "Validation failed." e sposta la spiegazione vera in `details`: leggere
 * solo `message` mostrerebbe all'utente una frase che non gli dice nulla su
 * cosa correggere.
 */
function motivoDelRifiuto(err: unknown): string {
  const dati = (err as AxiosError<CorpoErrore>).response?.data;

  const dettaglio = dati?.details?.[0];
  if (dettaglio) return dettaglio;

  const messaggio = dati?.message;
  const testo = Array.isArray(messaggio) ? messaggio[0] : messaggio;

  return testo ?? 'Caricamento del template non riuscito.';
}

export function TemplatePage() {
  const [template, setTemplate] = useState<ReadmeTemplateDto | null>(null);
  const [caricamento, setCaricamento] = useState(true);
  const [salvataggio, setSalvataggio] = useState(false);
  const [rimozione, setRimozione] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const [conferma, setConferma] = useState<string | null>(null);

  async function leggiStato(): Promise<void> {
    try {
      const { data } = await apiClient.get<ReadmeTemplateDto>('/templates/readme');
      setTemplate(data);
    } catch {
      // Una lettura fallita e "nessun template" portano allo stesso passo
      // successivo: caricarne uno.
      setTemplate(null);
    }
  }

  useEffect(() => {
    void leggiStato().finally(() => setCaricamento(false));
  }, []);

  async function onFileScelto(evento: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = evento.target.files?.[0];
    if (!file) return;

    setErrore(null);
    setConferma(null);
    setSalvataggio(true);

    try {
      const content = await file.text();
      const { data } = await apiClient.put<ReadmeTemplateDto>('/templates/readme', {
        filename: file.name,
        content,
      });
      setTemplate(data);
      setConferma('Template salvato.');
    } catch (err) {
      setErrore(motivoDelRifiuto(err));
    } finally {
      setSalvataggio(false);
      // Azzera il campo: senza, riselezionare lo stesso file non genera un
      // nuovo evento change e l'utente non può ritentare dopo un errore.
      evento.target.value = '';
    }
  }

  async function onRimuovi(): Promise<void> {
    setErrore(null);
    setConferma(null);
    setRimozione(true);

    try {
      await apiClient.delete('/templates/readme');
      setTemplate({ active: false, filename: null, content: null, updatedAt: null });
      setConferma('Template rimosso: l’Agente Docs userà il modello di default.');
    } catch {
      setErrore('Rimozione del template non riuscita.');
    } finally {
      setRimozione(false);
    }
  }

  if (caricamento) {
    return <Spinner />;
  }

  const attivo = template?.active === true;

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-[#2a2a2a]">Template README</h1>
        <p className="text-sm text-gray-500">
          Il modello che l&apos;Agente Docs segue quando genera o aggiorna un
          README. Senza un template personalizzato viene usato quello di
          default.
        </p>
      </header>

      <section
        className="rounded border border-[#cccccc] bg-white p-4"
        aria-label="Template attivo"
      >
        {attivo ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[#2a2a2a]">
              Template personalizzato attivo:{' '}
              <span className="font-mono font-medium">{template?.filename}</span>
            </p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 font-sans text-sm text-[#2a2a2a]">
              {template?.content}
            </pre>
            <div>
              <button
                type="button"
                onClick={() => void onRimuovi()}
                disabled={rimozione}
                className="rounded bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {rimozione ? 'Rimozione…' : 'Rimuovi template'}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            Nessun template personalizzato: è in uso il modello di default.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <label
          htmlFor="file-template"
          className="text-sm font-medium text-[#2a2a2a]"
        >
          Carica un template (.md)
        </label>
        <input
          id="file-template"
          type="file"
          accept=".md,text/markdown"
          disabled={salvataggio}
          onChange={(e) => void onFileScelto(e)}
          className="text-sm"
        />
        {salvataggio && <p className="text-sm text-gray-500">Caricamento…</p>}
      </section>

      {errore && (
        <p role="alert" className="text-sm font-medium text-red-700">
          {errore}
        </p>
      )}
      {conferma && (
        <p role="status" className="text-sm font-medium text-green-700">
          {conferma}
        </p>
      )}
    </div>
  );
}
