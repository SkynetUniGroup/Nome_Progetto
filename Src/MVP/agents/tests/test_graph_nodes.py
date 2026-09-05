"""Test dei singoli nodi e degli instradamenti del grafo dell'agente.

Complementari a test_graph.py, che esercita il grafo dall'esterno: qui i nodi
e le funzioni di instradamento vengono invocati direttamente, per coprire i
rami che dall'esterno richiederebbero di orchestrare un modello reale.
"""

import json

import pytest
from langchain_core.messages import AIMessage

from src import graph as graph_module
from src.graph import AgentCancelled, AgentGraph, AgentState
from src.models import ErrorKind, Proposal, TextBlock

from conftest import FakeContextRef, FakeToolset
from test_graph import FakeLoader, FakeProfile, FakeProvider, FakeRedis


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch):
    """Sostituisce il client Redis usato per annullamento e timeout."""
    monkeypatch.setattr(graph_module.aioredis, 'from_url', lambda url: FakeRedis())


def build_graph(profile=None, timeout_s=90) -> AgentGraph:
    """Costruisce un grafo con doppi deterministici."""
    grafo = AgentGraph(
        loader=FakeLoader(),
        profile=profile or FakeProfile(),
        provider=FakeProvider(),
        timeout_s=timeout_s,
    )
    grafo._current_redis_client = FakeRedis()
    return grafo


def build_state(**over) -> AgentState:
    """Costruisce lo stato del grafo, sovrascrivendo i campi indicati."""
    state = AgentState(
        user_id='u1',
        task_id='task-1',
        context_ref=FakeContextRef(),
        toolset=FakeToolset(),
    )
    for key, value in over.items():
        setattr(state, key, value)
    return state


class MessaggioConTool:
    """Messaggio del modello che richiede l'uso di uno strumento."""

    def __init__(self, tool_calls=None):
        """Inizializza il messaggio.

        Args:
            tool_calls: Le chiamate a strumenti richieste.
        """
        self.tool_calls = tool_calls if tool_calls is not None else [{'name': 'read_file'}]
        self.content = ''


# --- Instradamento dopo l'invocazione del modello ---------------------------

def test_route_llm_output_diverts_to_the_error_node_on_failure():
    """Un errore gia' in stato manda direttamente al nodo d'errore."""
    grafo = build_graph()

    assert grafo._route_llm_output(build_state(error=RuntimeError('guasto'))) == 'errore'


def test_route_llm_output_diverts_to_tools_when_the_model_asks():
    """Se il modello chiede uno strumento il grafo lo esegue."""
    grafo = build_graph()
    state = build_state(messages=[MessaggioConTool()], tool_rounds=0)

    assert grafo._route_llm_output(state) == 'tools'


def test_route_llm_output_stops_after_the_last_allowed_tool_round():
    """Esaurito il numero di giri consentiti l'agente non ne chiede altri.

    Senza questo tetto un modello che continua a chiedere file girerebbe
    all'infinito, consumando token fino al timeout globale.
    """
    grafo = build_graph(profile=FakeProfile())
    state = build_state(messages=[MessaggioConTool()], tool_rounds=3)

    assert grafo._route_llm_output(state) == 'errore'


def test_route_llm_output_allows_the_round_just_below_the_ceiling():
    """Il tetto e' un limite superiore, non uno di meno."""
    grafo = build_graph()
    state = build_state(messages=[MessaggioConTool()], tool_rounds=2)

    assert grafo._route_llm_output(state) == 'tools'


def test_route_llm_output_continues_on_a_plain_answer():
    """Una risposta testuale prosegue verso la validazione."""
    grafo = build_graph()
    state = build_state(messages=[AIMessage(content='{"findings": []}')])

    assert grafo._route_llm_output(state) == 'continua'


# --- Instradamenti generici -------------------------------------------------

def test_route_sends_a_failed_state_to_the_error_node():
    """L'instradamento comune devia appena c'e' un errore."""
    assert AgentGraph._route(build_state(error=RuntimeError('x'))) == 'errore'


def test_route_continues_when_nothing_failed():
    """Senza errori si prosegue."""
    assert AgentGraph._route(build_state()) == 'continua'


def test_route_post_valida_prefers_the_error_over_everything_else():
    """Un errore ha la precedenza su ritentativi e fasi successive."""
    state = build_state(error=RuntimeError('x'), needs_retry=True, needs_next_phase=True)

    assert AgentGraph._route_post_valida(state) == 'errore'


def test_route_post_valida_moves_to_the_next_phase_when_requested():
    """La seconda fase del changelog viene richiesta dal profilo."""
    assert AgentGraph._route_post_valida(build_state(needs_next_phase=True)) == 'next_phase'


def test_route_post_valida_retries_when_the_output_was_unusable():
    """Un output da rigenerare torna al modello."""
    assert AgentGraph._route_post_valida(build_state(needs_retry=True)) == 'retry'


def test_route_post_valida_continues_on_a_good_parse():
    """Un parsing riuscito prosegue verso l'assemblaggio del report."""
    assert AgentGraph._route_post_valida(build_state()) == 'continua'


# --- Nodo di validazione e parsing ------------------------------------------

@pytest.mark.asyncio
async def test_valida_accepts_a_profile_that_returns_two_values():
    """I profili senza fasi restituiscono blocchi e proposta."""
    grafo = build_graph()

    result = await grafo._node_valida_e_parsa(build_state(raw_output='{}'))

    assert result['needs_next_phase'] is False
    assert result['needs_retry'] is False
    assert len(result['blocks']) == 1


@pytest.mark.asyncio
async def test_valida_accepts_a_profile_that_also_asks_for_a_next_phase():
    """Il profilo changelog restituisce un terzo valore: serve un'altra fase."""
    class ProfileTreFasi(FakeProfile):
        def parse_output(self, raw, ctx=None):
            return [TextBlock(order=0, markdown='tecnico')], None, True

    grafo = build_graph(profile=ProfileTreFasi())

    result = await grafo._node_valida_e_parsa(build_state(raw_output='{}'))

    assert result['needs_next_phase'] is True


@pytest.mark.asyncio
async def test_valida_accumulates_blocks_across_phases():
    """I blocchi della seconda fase si aggiungono a quelli della prima."""
    grafo = build_graph()
    precedenti = [TextBlock(order=0, markdown='prima fase')]

    result = await grafo._node_valida_e_parsa(build_state(raw_output='{}', blocks=precedenti))

    assert len(result['blocks']) == 2
    assert result['blocks'][0].markdown == 'prima fase'


@pytest.mark.asyncio
async def test_valida_asks_the_model_to_simplify_unreadable_output():
    """Un changelog troppo ostico viene rimandato al modello con istruzioni."""
    profile = FakeProfile(parse_error=ValueError('READABILITY_RETRY: Score 30.0 is too low'))
    grafo = build_graph(profile=profile)

    result = await grafo._node_valida_e_parsa(build_state(raw_output='testo ostico'))

    assert result['needs_retry'] is True
    assert result['parse_retries'] == 1
    assert 'simplify' in result['messages'][1].content


@pytest.mark.asyncio
async def test_valida_gives_up_on_readability_after_two_attempts():
    """Dopo due tentativi si smette di insistere e si dichiara il fallimento."""
    profile = FakeProfile(parse_error=ValueError('READABILITY_RETRY: Score 30.0 is too low'))
    grafo = build_graph(profile=profile)

    result = await grafo._node_valida_e_parsa(build_state(raw_output='x', parse_retries=2))

    assert result['needs_retry'] is False
    assert result['error'].error_type == 'READABILITY_TOO_LOW'


@pytest.mark.asyncio
async def test_valida_asks_the_model_to_fix_malformed_json():
    """Un JSON rotto viene rimandato al modello con il dettaglio dell'errore."""
    profile = FakeProfile(parse_error=ValueError('Unable to parse as valid JSON: truncated'))
    grafo = build_graph(profile=profile)

    result = await grafo._node_valida_e_parsa(build_state(raw_output='{ rotto'))

    assert result['needs_retry'] is True
    assert 'JSON' in result['messages'][1].content


@pytest.mark.asyncio
async def test_valida_recognises_a_real_json_decode_error():
    """Anche l'eccezione nativa di json viene trattata come errore di formato."""
    profile = FakeProfile(parse_error=json.JSONDecodeError('bad', '{}', 0))
    grafo = build_graph(profile=profile)

    result = await grafo._node_valida_e_parsa(build_state(raw_output='{ rotto'))

    assert result['needs_retry'] is True


@pytest.mark.asyncio
async def test_valida_classifies_the_failure_as_parsing_after_two_attempts():
    """Esauriti i ritentativi l'errore viene marcato come problema di formato."""
    profile = FakeProfile(parse_error=ValueError('Unable to parse as valid JSON'))
    grafo = build_graph(profile=profile)

    result = await grafo._node_valida_e_parsa(build_state(raw_output='{ rotto', parse_retries=2))

    assert result['needs_retry'] is False
    assert result['error'].error_type == 'PARSING'


@pytest.mark.asyncio
async def test_valida_does_not_retry_an_unrelated_failure():
    """Un guasto che non riguarda il formato non si risolve rigenerando."""
    profile = FakeProfile(parse_error=RuntimeError('disco pieno'))
    grafo = build_graph(profile=profile)

    result = await grafo._node_valida_e_parsa(build_state(raw_output='{}'))

    assert result['needs_retry'] is False
    assert 'disco pieno' in str(result['error'])


# --- Nodo di esecuzione degli strumenti -------------------------------------

@pytest.mark.asyncio
async def test_esegui_tools_captures_failures_instead_of_crashing():
    """Un guasto durante l'uso degli strumenti diventa un errore in stato."""
    grafo = build_graph()
    # Nessun messaggio con tool_calls: ToolNode solleva, il nodo deve reggere.
    result = await grafo._node_esegui_tools(build_state(messages=[]))

    assert 'error' in result


# --- Nodo di attesa conferma ------------------------------------------------

@pytest.mark.asyncio
async def test_await_confirmation_proceeds_when_the_user_approves(monkeypatch):
    """Approvata la conferma, il grafo prosegue senza modificare lo stato."""
    monkeypatch.setattr(graph_module, 'interrupt', lambda payload: 'PROCEED')
    grafo = build_graph()

    assert await grafo._node_await_confirmation(build_state()) == {}


@pytest.mark.asyncio
async def test_await_confirmation_aborts_when_the_user_refuses(monkeypatch):
    """Rifiutata la conferma, l'operazione termina."""
    monkeypatch.setattr(graph_module, 'interrupt', lambda payload: 'CANCEL')
    grafo = build_graph()

    with pytest.raises(AgentCancelled):
        await grafo._node_await_confirmation(build_state())


@pytest.mark.asyncio
async def test_await_confirmation_asks_for_a_business_confirmation(monkeypatch):
    """La sospensione dichiara di che tipo di intervento ha bisogno."""
    ricevuto = {}
    monkeypatch.setattr(
        graph_module, 'interrupt', lambda payload: ricevuto.update(payload) or 'PROCEED'
    )
    grafo = build_graph()

    await grafo._node_await_confirmation(build_state())

    assert ricevuto['kind'] == 'BUSINESS_CONFIRMATION'


# --- Riepiloghi del report --------------------------------------------------

@pytest.mark.asyncio
async def test_report_summary_counts_the_ignored_issues_for_a_changelog():
    """Il riepilogo del changelog dichiara quante issue sono state scartate."""
    class ProfileChangelog(FakeProfile):
        agent = 'changelog'
        operation = 'CHANGELOG_TECHNICAL'

    grafo = build_graph(profile=ProfileChangelog())
    blocchi = [TextBlock(order=i, markdown=f'b{i}') for i in range(3)]

    result = await grafo._node_assembla_report(build_state(blocks=blocchi))

    assert '2 issues were ignored' in result['report'].summary


@pytest.mark.asyncio
async def test_report_summary_mentions_a_docs_proposal_when_there_is_one():
    """Se l'agente Docs ha prodotto una proposta il riepilogo lo dice."""
    class ProfileDocs(FakeProfile):
        agent = 'docs'
        operation = 'DOCS_INLINE'

    grafo = build_graph(profile=ProfileDocs())
    proposta = Proposal(targetPath='a.py', diffUnified='--- a\n+++ b\n', language='python')

    result = await grafo._node_assembla_report(build_state(proposal=proposta))

    assert 'modification proposal' in result['report'].summary


@pytest.mark.asyncio
async def test_report_refuses_an_operation_outside_the_shared_contract():
    """Un codice operazione non previsto non produce un report malformato.

    Il campo `operation` del Report e' un Literal dei sette codici concordati
    con il backend: un valore fuori elenco viene respinto dal modello e
    diventa un errore controllato, non un report che il backend non saprebbe
    interpretare. Di conseguenza il ramo di riepilogo generico in
    `_node_assembla_report` non e' raggiungibile.
    """
    class ProfileIgnoto(FakeProfile):
        agent = 'altro'
        operation = 'OPERAZIONE_IGNOTA'

    grafo = build_graph(profile=ProfileIgnoto())

    result = await grafo._node_assembla_report(build_state(blocks=[]))

    assert 'report' not in result
    assert 'error' in result
