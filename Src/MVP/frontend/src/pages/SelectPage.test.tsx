import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSelectionStore } from '../stores/selectionStore';

const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock('../api/client', () => ({
  apiClient: {
    get: (...args: any[]) => getMock(...args),
    post: (...args: any[]) => postMock(...args),
  },
}));

const { SelectPage } = await import('./SelectPage');

const initialSelection = useSelectionStore.getState();

const REPOS = [
  { owner: 'SkynetUniGroup', name: 'Code_Guardian', defaultBranch: 'develop', private: false },
  { owner: 'OWASP', name: 'NodeGoat', defaultBranch: 'master', private: true },
];

/** Contesto nella forma restituita da POST /contexts. */
const CONTESTO_CREATO = {
  data: {
    id: 'ctx-1',
    repoOwner: 'OWASP',
    repoName: 'NodeGoat',
    isPrivate: true,
    resolvedSha: 'abc1234',
    scopeType: 'FULL_REPOSITORY',
    paths: [],
    detectedLanguages: ['JavaScript'],
    estimatedFileCount: 42,
  },
};

/** Monta la pagina e attende che l'elenco dei repository sia caricato. */
async function renderCaricata() {
  render(<SelectPage />);
  await screen.findByLabelText('Repository');
  return userEvent.setup();
}

const BOTTONE = /Salva contesto e vai ad Avvia/;

beforeEach(() => {
  useSelectionStore.setState(initialSelection, true);
  navigateMock.mockReset();
  postMock.mockReset();
  getMock.mockReset().mockResolvedValue({ data: { repositories: REPOS } });
});

describe('SelectPage', () => {
  it('mostra uno stato di caricamento finche\' i repository non sono arrivati', () => {
    getMock.mockReturnValueOnce(new Promise(() => {}));

    render(<SelectPage />);

    expect(screen.getByText(/Caricamento repository/)).toBeInTheDocument();
  });

  it('elenca i repository accessibili segnalando quelli privati', async () => {
    await renderCaricata();

    const opzioni = screen.getAllByRole('option').map((o) => o.textContent);
    expect(opzioni).toContain('SkynetUniGroup/Code_Guardian ');
    expect(opzioni).toContain('OWASP/NodeGoat 🔒');
  });

  it('se i repository non si caricano lo attribuisce alle credenziali e offre di riprovare', async () => {
    getMock.mockRejectedValueOnce(new Error('401'));

    render(<SelectPage />);

    expect(await screen.findByText(/Impossibile caricare i repository/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeInTheDocument();
  });

  it('scegliendo un repository propone il suo branch di default come riferimento', async () => {
    const user = await renderCaricata();

    await user.selectOptions(screen.getByLabelText('Repository'), 'OWASP/NodeGoat');

    expect(screen.getByLabelText('Branch o Commit SHA')).toHaveValue('master');
  });

  it('crea il contesto sull\'intero repository e prosegue verso l\'avvio', async () => {
    const user = await renderCaricata();
    postMock.mockResolvedValueOnce(CONTESTO_CREATO);
    await user.selectOptions(screen.getByLabelText('Repository'), 'OWASP/NodeGoat');

    await user.click(screen.getByRole('button', { name: BOTTONE }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/run' }));
    expect(postMock).toHaveBeenCalledWith('/contexts', {
      repoOwner: 'OWASP',
      repoName: 'NodeGoat',
      ref: 'master',
      scopeType: 'FULL_REPOSITORY',
    });
  });

  it('memorizza il contesto creato, cosi\' la pagina di avvio non deve richiederlo', async () => {
    const user = await renderCaricata();
    postMock.mockResolvedValueOnce(CONTESTO_CREATO);
    await user.selectOptions(screen.getByLabelText('Repository'), 'OWASP/NodeGoat');

    await user.click(screen.getByRole('button', { name: BOTTONE }));

    await waitFor(() => expect(useSelectionStore.getState().contextId).toBe('ctx-1'));
    expect(useSelectionStore.getState().context).toEqual(CONTESTO_CREATO.data);
  });

  it('accetta un commit specifico al posto del branch', async () => {
    const user = await renderCaricata();
    postMock.mockResolvedValueOnce(CONTESTO_CREATO);
    await user.selectOptions(screen.getByLabelText('Repository'), 'OWASP/NodeGoat');
    const campoRef = screen.getByLabelText('Branch o Commit SHA');
    await user.clear(campoRef);
    await user.type(campoRef, 'a1b2c3d4e5f6');

    await user.click(screen.getByRole('button', { name: BOTTONE }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0][1].ref).toBe('a1b2c3d4e5f6');
  });

  it('restringe l\'ambito a singoli file, uno per riga', async () => {
    const user = await renderCaricata();
    postMock.mockResolvedValueOnce(CONTESTO_CREATO);
    await user.selectOptions(screen.getByLabelText('Repository'), 'OWASP/NodeGoat');
    await user.selectOptions(screen.getByLabelText('Tipo di scope'), 'FILES');
    await user.type(
      screen.getByLabelText('File da analizzare'),
      'app/routes/session.js\napp/data/user-dao.js',
    );

    await user.click(screen.getByRole('button', { name: BOTTONE }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0][1]).toMatchObject({
      scopeType: 'FILES',
      paths: ['app/routes/session.js', 'app/data/user-dao.js'],
    });
  });

  it('restringe l\'ambito a directory, cambiando anche l\'etichetta del campo', async () => {
    const user = await renderCaricata();
    postMock.mockResolvedValueOnce(CONTESTO_CREATO);
    await user.selectOptions(screen.getByLabelText('Repository'), 'OWASP/NodeGoat');
    await user.selectOptions(screen.getByLabelText('Tipo di scope'), 'DIRECTORIES');
    await user.type(screen.getByLabelText('Directory da analizzare'), 'app/routes');

    await user.click(screen.getByRole('button', { name: BOTTONE }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0][1]).toMatchObject({
      scopeType: 'DIRECTORIES',
      paths: ['app/routes'],
    });
  });

  it('ignora righe vuote e spazi nell\'elenco dei percorsi', async () => {
    const user = await renderCaricata();
    postMock.mockResolvedValueOnce(CONTESTO_CREATO);
    await user.selectOptions(screen.getByLabelText('Repository'), 'OWASP/NodeGoat');
    await user.selectOptions(screen.getByLabelText('Tipo di scope'), 'FILES');
    await user.type(screen.getByLabelText('File da analizzare'), '  app/a.js  \n\n\napp/b.js\n');

    await user.click(screen.getByRole('button', { name: BOTTONE }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0][1].paths).toEqual(['app/a.js', 'app/b.js']);
  });

  it('sull\'intero repository non chiede percorsi e non ne invia', async () => {
    const user = await renderCaricata();
    postMock.mockResolvedValueOnce(CONTESTO_CREATO);
    await user.selectOptions(screen.getByLabelText('Repository'), 'OWASP/NodeGoat');

    expect(screen.queryByLabelText('File da analizzare')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: BOTTONE }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0][1]).not.toHaveProperty('paths');
  });

  it('cambiando tipo di scope azzera i percorsi gia\' inseriti', async () => {
    const user = await renderCaricata();
    await user.selectOptions(screen.getByLabelText('Repository'), 'OWASP/NodeGoat');
    await user.selectOptions(screen.getByLabelText('Tipo di scope'), 'FILES');
    await user.type(screen.getByLabelText('File da analizzare'), 'app/a.js');

    await user.selectOptions(screen.getByLabelText('Tipo di scope'), 'DIRECTORIES');

    // I percorsi dei file non hanno senso come directory: vanno reinseriti.
    expect(screen.getByLabelText('Directory da analizzare')).toHaveValue('');
  });

  it('blocca l\'invio se non e\' stato scelto alcun repository', async () => {
    const user = await renderCaricata();

    await user.click(screen.getByRole('button', { name: BOTTONE }));

    expect(await screen.findByText('Seleziona un repository')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('blocca l\'invio se il riferimento e\' stato svuotato', async () => {
    const user = await renderCaricata();
    await user.selectOptions(screen.getByLabelText('Repository'), 'OWASP/NodeGoat');
    await user.clear(screen.getByLabelText('Branch o Commit SHA'));

    await user.click(screen.getByRole('button', { name: BOTTONE }));

    expect(await screen.findByText('Inserisci il branch o il commit SHA')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('blocca l\'invio se l\'ambito ristretto non elenca alcun percorso', async () => {
    const user = await renderCaricata();
    await user.selectOptions(screen.getByLabelText('Repository'), 'OWASP/NodeGoat');
    await user.selectOptions(screen.getByLabelText('Tipo di scope'), 'FILES');

    await user.click(screen.getByRole('button', { name: BOTTONE }));

    expect(await screen.findByText('Inserisci almeno un percorso')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('se il server rifiuta il contesto lo segnala e resta sulla pagina', async () => {
    // Copre gli scarti lato server: branch inesistente, percorsi assenti,
    // repository irraggiungibile, ambito oltre i limiti dimensionali.
    const user = await renderCaricata();
    postMock.mockRejectedValueOnce(new Error('422'));
    await user.selectOptions(screen.getByLabelText('Repository'), 'OWASP/NodeGoat');

    await user.click(screen.getByRole('button', { name: BOTTONE }));

    expect(await screen.findByText(/Impossibile salvare il contesto/)).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(useSelectionStore.getState().contextId).toBeNull();
  });

  it('disabilita il pulsante mentre il contesto viene creato', async () => {
    const user = await renderCaricata();
    let concludi: (v: unknown) => void = () => {};
    postMock.mockImplementationOnce(() => new Promise((resolve) => { concludi = resolve; }));
    await user.selectOptions(screen.getByLabelText('Repository'), 'OWASP/NodeGoat');
    const bottone = screen.getByRole('button', { name: BOTTONE });

    await user.click(bottone);

    await waitFor(() => expect(bottone).toBeDisabled());
    concludi(CONTESTO_CREATO);
    await waitFor(() => expect(navigateMock).toHaveBeenCalled());
  });
});
