import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getMock = vi.fn();
const putMock = vi.fn();
const deleteMock = vi.fn();
vi.mock('../api/client', () => ({
  apiClient: {
    get: (...args: any[]) => getMock(...args),
    put: (...args: any[]) => putMock(...args),
    delete: (...args: any[]) => deleteMock(...args),
  },
  AxiosError: class AxiosError extends Error {},
}));

const { TemplatePage } = await import('./TemplatePage');

const CONTENUTO = '# {{project_name}}\n\n## Installazione\n';

function attivo(filename = 'mio-template.md') {
  return {
    data: {
      active: true,
      filename,
      content: CONTENUTO,
      updatedAt: '2026-03-01T10:00:00.000Z',
    },
  };
}

const assente = {
  data: { active: false, filename: null, content: null, updatedAt: null },
};

/**
 * Errore come lo produce davvero il backend quando rifiuta il file (RF.80).
 *
 * AllExceptionsFilter normalizza ogni 400 a `message: 'Validation failed.'`
 * e sposta la spiegazione in `details`: una pagina che leggesse solo
 * `message` mostrerebbe una frase inutile all'utente.
 */
function erroreBackend(motivo: string) {
  return {
    response: {
      status: 400,
      data: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed.',
        details: [motivo],
      },
    },
  };
}

function fileMarkdown(nome: string, testo = CONTENUTO) {
  return new File([testo], nome, { type: 'text/markdown' });
}

/** Monta la pagina attendendo la fine della lettura iniziale. */
async function renderCaricata() {
  render(<TemplatePage />);
  await screen.findByRole('heading', { name: 'Template README' });
  return userEvent.setup();
}

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue(assente);
});

describe('TemplatePage', () => {
  it('legge lo stato del template all\'apertura', async () => {
    await renderCaricata();

    expect(getMock).toHaveBeenCalledWith('/templates/readme');
  });

  it('senza template personalizzato dichiara che è in uso il default', async () => {
    await renderCaricata();

    expect(
      screen.getByText(/Nessun template personalizzato/),
    ).toBeInTheDocument();
  });

  it('con un template attivo ne mostra nome e contenuto', async () => {
    getMock.mockResolvedValue(attivo());

    await renderCaricata();

    expect(screen.getByText('mio-template.md')).toBeInTheDocument();
    expect(screen.getByText(/{{project_name}}/)).toBeInTheDocument();
  });

  // --- RF.79: caricamento e salvataggio ------------------------------------

  it('carica il file scelto inviando nome e contenuto', async () => {
    putMock.mockResolvedValue(attivo('nuovo.md'));
    const user = await renderCaricata();

    await user.upload(
      screen.getByLabelText(/Carica un template/),
      fileMarkdown('nuovo.md'),
    );

    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith('/templates/readme', {
        filename: 'nuovo.md',
        content: CONTENUTO,
      }),
    );
  });

  it('dopo il salvataggio mostra il template appena caricato', async () => {
    putMock.mockResolvedValue(attivo('nuovo.md'));
    const user = await renderCaricata();

    await user.upload(
      screen.getByLabelText(/Carica un template/),
      fileMarkdown('nuovo.md'),
    );

    expect(await screen.findByText('nuovo.md')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Template salvato');
  });

  // --- RF.80: file non valido ----------------------------------------------

  it('mostra il motivo per cui il backend ha rifiutato il file', async () => {
    // Il messaggio è quello del backend, non uno generico: RF.80 chiede che
    // l'utente sappia perché il file non va bene.
    putMock.mockRejectedValue(
      erroreBackend('Il template deve essere un file Markdown con estensione .md.'),
    );
    const user = await renderCaricata();

    await user.upload(
      screen.getByLabelText(/Carica un template/),
      fileMarkdown('note.txt'),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'estensione .md',
    );
  });

  it('ricade su message quando la risposta non porta details', async () => {
    // Non tutti i 400 passano dal filtro con details valorizzato: la pagina
    // deve restare comprensibile anche in quel caso.
    putMock.mockRejectedValue({
      response: { status: 400, data: { message: ['Il template è vuoto.'] } },
    });
    const user = await renderCaricata();

    await user.upload(
      screen.getByLabelText(/Carica un template/),
      fileMarkdown('vuoto.md', ''),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('vuoto');
  });

  it('dopo un rifiuto lascia lo stato precedente invariato', async () => {
    getMock.mockResolvedValue(attivo('originale.md'));
    putMock.mockRejectedValue(erroreBackend('Formato non valido.'));
    const user = await renderCaricata();

    await user.upload(
      screen.getByLabelText(/Carica un template/),
      fileMarkdown('rotto.txt'),
    );

    await screen.findByRole('alert');
    expect(screen.getByText('originale.md')).toBeInTheDocument();
  });

  it('permette di ritentare con lo stesso file dopo un errore', async () => {
    // Senza azzerare il campo, riselezionare lo stesso file non emette un
    // nuovo evento change e l'utente resta bloccato.
    putMock.mockRejectedValue(erroreBackend('Formato non valido.'));
    const user = await renderCaricata();
    const campo = screen.getByLabelText(/Carica un template/) as HTMLInputElement;

    await user.upload(campo, fileMarkdown('rotto.txt'));
    await screen.findByRole('alert');

    expect(campo.value).toBe('');
  });

  // --- RF.81: rimozione e ripristino del default ---------------------------

  it('rimuove il template e dichiara il ritorno al modello di default', async () => {
    getMock.mockResolvedValue(attivo());
    deleteMock.mockResolvedValue({});
    const user = await renderCaricata();

    await user.click(screen.getByRole('button', { name: /Rimuovi template/ }));

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith('/templates/readme'),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('default');
    expect(
      screen.getByText(/Nessun template personalizzato/),
    ).toBeInTheDocument();
  });

  it('non offre la rimozione quando non c\'è nulla da rimuovere', async () => {
    await renderCaricata();

    expect(
      screen.queryByRole('button', { name: /Rimuovi template/ }),
    ).not.toBeInTheDocument();
  });

  it('segnala una rimozione fallita senza fingere che sia andata a buon fine', async () => {
    getMock.mockResolvedValue(attivo());
    deleteMock.mockRejectedValue(new Error('rete'));
    const user = await renderCaricata();

    await user.click(screen.getByRole('button', { name: /Rimuovi template/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('non riuscita');
    expect(screen.getByText('mio-template.md')).toBeInTheDocument();
  });

  it('una lettura iniziale fallita non blocca il caricamento di un template', async () => {
    getMock.mockRejectedValue(new Error('rete'));

    await renderCaricata();

    expect(screen.getByLabelText(/Carica un template/)).toBeEnabled();
  });
});
