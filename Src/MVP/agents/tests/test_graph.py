"""Test di integrazione del grafo dell'agente.

Verificano che i nodi collaborino secondo il contratto: sequenza nominale,
propagazione degli errori e classificazione degli errori nel report di
fallimento. Il provider LLM e il toolset GitHub sono sostituiti da doppi
deterministici, quindi nessun test apre connessioni di rete.
"""

import pytest

from src import graph as graph_module
from src.graph import AgentCancelled, AgentGraph, AgentState, AgentTimeout, ContextTooLargeError
from src.models import ErrorKind, TextBlock

from conftest import FakeContextRef, FakeToolset


class FakeRedis:
    """Redis fittizio: nessuna richiesta di annullamento in sospeso."""

    def __init__(self, cancel_flag=None):
        """Inizializza il client fittizio.

        Args:
            cancel_flag: Valore restituito da `get`; non nullo simula un annullamento.
        """
        self.cancel_flag = cancel_flag

    async def get(self, key):
        """Restituisce il flag di annullamento configurato."""
        return self.cancel_flag

    async def aclose(self):
        """Chiude il client fittizio."""


class FakeResponse:
    """Risposta del modello, senza chiamate a strumenti."""

    def __init__(self, content: str = '{"ok": true}', tool_calls=None, total_tokens: int = 120):
        """Inizializza la risposta.

        Args:
            content (str): Il testo prodotto dal modello.
            tool_calls: Eventuali chiamate a strumenti richieste.
            total_tokens (int): Token consumati dichiarati dal provider.
        """
        self.content = content
        self.tool_calls = tool_calls or []
        self.usage_metadata = {'total_tokens': total_tokens}


class FakeProvider:
    """Provider LLM deterministico."""

    def __init__(self, response=None, error: Exception = None):
        """Inizializza il provider.

        Args:
            response: Risposta da restituire.
            error (Exception): Errore da sollevare al posto della risposta.
        """
        self.response = response or FakeResponse()
        self.error = error
        self.calls = 0

    async def invoke_agent(self, messages, tools, timeout):
        """Restituisce la risposta configurata, o solleva l'errore configurato."""
        self.calls += 1
        if self.error:
            raise self.error
        return self.response


class FakeLoader:
    """Loader di contesto deterministico."""

    def __init__(self, context=None, error: Exception = None):
        """Inizializza il loader.

        Args:
            context: Contesto da restituire.
            error (Exception): Errore da sollevare al posto del contesto.
        """
        self.context = context if context is not None else {'files': 'src/main.py'}
        self.error = error

    async def load(self, context_ref, toolset, agent_payload=None):
        """Restituisce il contesto configurato, o solleva l'errore configurato."""
        if self.error:
            raise self.error
        return self.context


class FakeProfile:
    """Profilo agente deterministico, senza uso di strumenti."""

    agent = 'security'
    operation = 'SECURITY_OWASP'
    uses_tools = False
    max_tool_rounds = 3

    def __init__(self, blocks=None, parse_error: Exception = None):
        """Inizializza il profilo.

        Args:
            blocks: Blocchi restituiti dal parsing.
            parse_error (Exception): Errore da sollevare durante il parsing.
        """
        self.blocks = blocks if blocks is not None else [TextBlock(order=0, markdown='Esito.')]
        self.parse_error = parse_error

    def build_prompt(self, ctx):
        """Costruisce una coppia di prompt minima."""
        return 'Sei un analista.', 'Analizza il codice.'

    def parse_output(self, raw, ctx=None):
        """Restituisce i blocchi configurati, o solleva l'errore configurato."""
        if self.parse_error:
            raise self.parse_error
        return self.blocks, None


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    """Sostituisce il client Redis usato per annullamento e timeout."""
    monkeypatch.setattr(graph_module.aioredis, 'from_url', lambda url: FakeRedis())


def build_graph(loader=None, profile=None, provider=None, timeout_s=90) -> AgentGraph:
    """Costruisce un grafo con doppi deterministici.

    Args:
        loader: Loader di contesto.
        profile: Profilo agente.
        provider: Provider LLM.
        timeout_s (int): Timeout globale.

    Returns:
        AgentGraph: Il grafo pronto all'esecuzione.
    """
    return AgentGraph(
        loader=loader or FakeLoader(),
        profile=profile or FakeProfile(),
        provider=provider or FakeProvider(),
        timeout_s=timeout_s,
    )


def build_state(task_id: str = 'task-1') -> AgentState:
    """Costruisce lo stato iniziale del grafo."""
    return AgentState(
        user_id='u1',
        task_id=task_id,
        context_ref=FakeContextRef(),
        toolset=FakeToolset(),
    )


# --- Percorso nominale ------------------------------------------------------

@pytest.mark.asyncio
async def test_execute_step_completes_the_nominal_path():
    """Contesto, prompt, provider e parsing si concatenano fino al report."""
    grafo = build_graph()

    result = await grafo.execute_step(build_state())

    assert result['status'] == 'completed'
    report = result['result']['report']
    assert report['status'] == 'COMPLETED'
    assert report['operation'] == 'SECURITY_OWASP'
    assert report['agentId'] == 'security'


@pytest.mark.asyncio
async def test_execute_step_invokes_the_provider_exactly_once():
    """Senza chiamate a strumenti il modello viene interpellato una sola volta."""
    provider = FakeProvider()
    grafo = build_graph(provider=provider)

    await grafo.execute_step(build_state())

    assert provider.calls == 1


@pytest.mark.asyncio
async def test_execute_step_carries_the_parsed_blocks_into_the_report():
    """I blocchi prodotti dal profilo finiscono nel corpo del report."""
    profile = FakeProfile(blocks=[TextBlock(order=0, markdown='Nessuna vulnerabilita.')])
    grafo = build_graph(profile=profile)

    result = await grafo.execute_step(build_state())

    body = result['result']['report']['body']
    assert len(body) == 1
    assert body[0]['markdown'] == 'Nessuna vulnerabilita.'


@pytest.mark.asyncio
async def test_execute_step_records_the_tokens_consumed():
    """Il consumo dichiarato dal provider viene riportato nel report."""
    grafo = build_graph(provider=FakeProvider(FakeResponse(total_tokens=350)))

    result = await grafo.execute_step(build_state())

    assert result['result']['report']['tokensConsumed'] == 350


@pytest.mark.asyncio
async def test_execute_step_summarises_a_security_scan():
    """Il riepilogo del report riflette il tipo di operazione eseguita."""
    grafo = build_graph()

    result = await grafo.execute_step(build_state())

    assert 'Scan completed' in result['result']['report']['summary']


# --- Propagazione degli errori ----------------------------------------------

@pytest.mark.asyncio
async def test_execute_step_reports_a_failure_when_the_context_cannot_be_loaded():
    """Un errore del loader diventa un report FAILED, non un'eccezione."""
    grafo = build_graph(loader=FakeLoader(error=RuntimeError('repository irraggiungibile')))

    result = await grafo.execute_step(build_state())

    assert result['status'] == 'completed'
    assert result['result']['report']['status'] == 'FAILED'


@pytest.mark.asyncio
async def test_execute_step_does_not_crash_when_the_provider_fails():
    """Un guasto del provider viene catturato dal grafo e codificato nel report."""
    grafo = build_graph(provider=FakeProvider(error=RuntimeError('upstream 503')))

    result = await grafo.execute_step(build_state())

    report = result['result']['report']
    assert report['status'] == 'FAILED'
    assert 'upstream 503' in report['error']['message']


@pytest.mark.asyncio
async def test_execute_step_does_not_crash_when_parsing_fails():
    """Un output non interpretabile produce un esito controllato."""
    grafo = build_graph(profile=FakeProfile(parse_error=ValueError('JSON malformato')))

    result = await grafo.execute_step(build_state())

    assert result['result']['report']['status'] == 'FAILED'


@pytest.mark.asyncio
async def test_execute_step_encodes_a_provider_timeout():
    """Un timeout del provider viene classificato come tale nel report."""
    grafo = build_graph(provider=FakeProvider(error=TimeoutError('request timeout')))

    result = await grafo.execute_step(build_state())

    assert result['result']['report']['error']['kind'] == 'TIMEOUT'


@pytest.mark.asyncio
async def test_execute_step_stops_on_the_global_timeout():
    """Superato il tempo massimo l'esecuzione si ferma con un errore di timeout."""
    # timeout gia' scaduto al primo controllo: il grafo non deve proseguire.
    grafo = build_graph(timeout_s=0)

    result = await grafo.execute_step(build_state())

    assert result['result']['report']['error']['kind'] == 'TIMEOUT'


@pytest.mark.asyncio
async def test_execute_step_aborts_when_the_task_is_cancelled(monkeypatch):
    """Un annullamento richiesto dall'utente interrompe l'esecuzione."""
    monkeypatch.setattr(graph_module.aioredis, 'from_url', lambda url: FakeRedis(cancel_flag=b'1'))
    grafo = build_graph()

    result = await grafo.execute_step(build_state())

    assert result['status'] == 'failed'


# --- Classificazione degli errori nel report di fallimento -------------------

@pytest.mark.asyncio
@pytest.mark.parametrize(
    'errore,atteso',
    [
        (ValueError('Unable to parse model response as valid JSON'), ErrorKind.PARSING),
        (RuntimeError('request timeout after 90s'), ErrorKind.TIMEOUT),
        (RuntimeError('maximum context length exceeded'), ErrorKind.CONTEXT_TOO_LARGE),
        (RuntimeError('token limit reached'), ErrorKind.CONTEXT_TOO_LARGE),
        (RuntimeError('connessione rifiutata dal provider'), ErrorKind.UPSTREAM),
    ],
)
async def test_error_node_classifies_generic_errors_by_message(errore, atteso):
    """Gli errori senza tipo esplicito vengono classificati dal messaggio."""
    grafo = build_graph()
    state = build_state()
    state.error = errore

    result = await grafo._node_gestisci_errore(state)

    assert result['report'].error.kind == atteso


@pytest.mark.asyncio
async def test_error_node_honours_the_explicit_error_type():
    """Un'eccezione che dichiara il proprio tipo non viene reinterpretata."""
    grafo = build_graph()
    state = build_state()
    state.error = ContextTooLargeError('contesto troppo grande')
    state.error.error_type = 'CONTEXT_TOO_LARGE'

    result = await grafo._node_gestisci_errore(state)

    assert result['report'].error.kind == ErrorKind.CONTEXT_TOO_LARGE


@pytest.mark.asyncio
async def test_error_node_falls_back_when_the_declared_type_is_unknown():
    """Un tipo dichiarato ma sconosciuto non deve far fallire la costruzione."""
    grafo = build_graph()
    state = build_state()
    errore = RuntimeError('guasto misterioso')
    errore.error_type = 'TIPO_INESISTENTE'
    state.error = errore

    result = await grafo._node_gestisci_errore(state)

    assert result['report'].error.kind == ErrorKind.UPSTREAM


@pytest.mark.asyncio
async def test_error_node_attributes_exhausted_tool_rounds_to_a_timeout():
    """Esaurito il numero di giri di strumenti l'esito e' un timeout esplicito."""
    grafo = build_graph()
    state = build_state()
    state.error = None

    result = await grafo._node_gestisci_errore(state)

    assert result['report'].error.kind == ErrorKind.TIMEOUT
    assert 'tool interaction limit' in result['report'].error.message


@pytest.mark.asyncio
async def test_error_node_preserves_the_repository_context():
    """Il report di fallimento conserva il contesto analizzato."""
    grafo = build_graph()
    state = build_state()
    state.error = RuntimeError('guasto')

    result = await grafo._node_gestisci_errore(state)

    assert result['report'].context.repoOwner == 'OWASP'
    assert result['report'].context.repoName == 'NodeGoat'


@pytest.mark.asyncio
async def test_error_node_marks_the_stage_of_the_failure():
    """Il report indica in quale fase l'esecuzione si e' interrotta."""
    grafo = build_graph()
    state = build_state()
    state.error = RuntimeError('guasto')

    result = await grafo._node_gestisci_errore(state)

    assert result['report'].error.stage == 'agent_execution'


# --- Eccezioni dedicate -----------------------------------------------------

def test_agent_timeout_records_the_stage():
    """AgentTimeout conserva la fase in cui e' scattato."""
    errore = AgentTimeout(stage='invoca_llm')

    assert 'invoca_llm' in str(errore)


def test_agent_cancelled_records_the_stage():
    """AgentCancelled conserva la fase in cui l'utente ha annullato."""
    errore = AgentCancelled(stage='carica_contesto')

    assert 'carica_contesto' in str(errore)
