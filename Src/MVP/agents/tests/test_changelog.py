"""Test dell'agente Changelog: filtro delle issue, sospensione e leggibilita'."""

import pytest

from src.agents import changelog as changelog_module
from src.agents.changelog import (
    ChangelogBusinessProfile,
    ChangelogLoader,
    ChangelogTechnicalProfile,
    calculate_flesch_reading_ease,
)
from src.graph import AgentCancelled

from conftest import FakeContextRef, FakeToolset


def _issue(number: int, title: str = 'Titolo', milestone=None, sufficient: bool = True,
           labels: str = 'feat') -> dict:
    """Costruisce una issue nella forma restituita dal backend."""
    return {
        'number': number,
        'title': title,
        'milestone': milestone,
        'hasSufficientMetadata': sufficient,
        'labels': labels,
    }


@pytest.fixture(autouse=True)
def no_interrupt(monkeypatch):
    """Neutralizza la sospensione del grafo, che fuori da LangGraph non ha senso.

    Il valore restituito simula la risposta dell'utente: 'PROCEED' salvo
    diversa indicazione del singolo test.
    """
    monkeypatch.setattr(changelog_module, 'interrupt', lambda payload: 'PROCEED')


# --- Filtro delle issue -----------------------------------------------------

@pytest.mark.asyncio
async def test_load_requests_only_closed_issues():
    """Il changelog riguarda il lavoro concluso: le issue aperte non vengono chieste."""
    toolset = FakeToolset(issues=[_issue(1)])

    await ChangelogLoader().load(FakeContextRef(), toolset)

    assert toolset.issue_filters == [{'state': 'closed'}]


@pytest.mark.asyncio
async def test_load_keeps_issues_with_sufficient_metadata():
    """Le issue complete finiscono nel changelog, con riferimento ed etichette."""
    toolset = FakeToolset(issues=[_issue(42, 'Aggiunta esportazione PDF', labels='feat')])

    result = await ChangelogLoader().load(FakeContextRef(), toolset)

    assert '#42' in result['tasks_formatted']
    assert 'Aggiunta esportazione PDF' in result['tasks_formatted']
    assert 'feat' in result['tasks_formatted']


@pytest.mark.asyncio
async def test_load_builds_a_link_to_each_issue():
    """Ogni voce rimanda alla issue di origine sul repository analizzato."""
    toolset = FakeToolset(issues=[_issue(42)])

    result = await ChangelogLoader().load(FakeContextRef(), toolset)

    assert 'https://github.com/OWASP/NodeGoat/issues/42' in result['tasks_formatted']


@pytest.mark.asyncio
async def test_load_excludes_issues_with_insufficient_metadata():
    """Le issue troppo povere vengono scartate dal changelog e riportate a parte.

    E' il quality gate: una issue senza descrizione o criteri di accettazione
    non fornisce materiale sufficiente a generare una voce di changelog utile.
    """
    toolset = FakeToolset(issues=[
        _issue(1, 'Completa', sufficient=True),
        _issue(2, 'Povera', sufficient=False),
    ])

    result = await ChangelogLoader().load(FakeContextRef(), toolset)

    assert '#1' in result['tasks_formatted']
    assert '#2' not in result['tasks_formatted']
    assert result['excluded_tasks'] == ['#2 Povera']


@pytest.mark.asyncio
async def test_load_treats_missing_metadata_flag_as_sufficient():
    """Se il backend non si esprime, la issue non viene scartata d'ufficio."""
    issue = _issue(1)
    del issue['hasSufficientMetadata']
    toolset = FakeToolset(issues=[issue])

    result = await ChangelogLoader().load(FakeContextRef(), toolset)

    assert '#1' in result['tasks_formatted']
    assert result['excluded_tasks'] == []


@pytest.mark.asyncio
async def test_load_filters_issues_by_sprint():
    """Con uno Sprint indicato entrano solo le issue di quella milestone."""
    toolset = FakeToolset(issues=[
        _issue(1, 'Dello sprint', milestone='SPRINT-42'),
        _issue(2, 'Di un altro sprint', milestone='SPRINT-41'),
        _issue(3, 'Senza milestone', milestone=None),
    ])

    result = await ChangelogLoader().load(
        FakeContextRef(), toolset, {'sprintId': 'SPRINT-42'}
    )

    assert '#1' in result['tasks_formatted']
    assert '#2' not in result['tasks_formatted']
    assert '#3' not in result['tasks_formatted']
    assert result['sprint_id'] == 'SPRINT-42'


@pytest.mark.asyncio
async def test_load_without_sprint_considers_every_closed_issue():
    """Senza Sprint indicato non si filtra per milestone."""
    toolset = FakeToolset(issues=[
        _issue(1, milestone='SPRINT-42'),
        _issue(2, milestone=None),
    ])

    result = await ChangelogLoader().load(FakeContextRef(), toolset)

    assert '#1' in result['tasks_formatted']
    assert '#2' in result['tasks_formatted']


@pytest.mark.asyncio
async def test_load_reports_no_valid_issues_when_all_are_discarded():
    """Se non resta nulla il contesto lo dice invece di restare vuoto."""
    toolset = FakeToolset(issues=[_issue(1, sufficient=False)])

    result = await ChangelogLoader().load(FakeContextRef(), toolset)

    assert result['tasks_formatted'] == 'No valid issues.'


@pytest.mark.asyncio
async def test_load_starts_in_technical_phase():
    """La generazione parte sempre dalla fase tecnica."""
    toolset = FakeToolset(issues=[_issue(1)])

    result = await ChangelogLoader().load(FakeContextRef(), toolset)

    assert result['phase'] == 'TECHNICAL'


# --- Sospensione per intervento umano ---------------------------------------

@pytest.mark.asyncio
async def test_load_suspends_when_some_issues_are_incomplete(monkeypatch):
    """Trovate issue incomplete, l'agente si ferma e chiede all'utente."""
    ricevuto = {}

    def finto_interrupt(payload):
        ricevuto.update(payload)
        return 'PROCEED'

    monkeypatch.setattr(changelog_module, 'interrupt', finto_interrupt)
    toolset = FakeToolset(issues=[_issue(7, sufficient=False)])

    await ChangelogLoader().load(FakeContextRef(), toolset)

    assert ricevuto['kind'] == 'INCOMPLETE_TASKS'
    assert ricevuto['taskIds'] == ['7']


@pytest.mark.asyncio
async def test_load_does_not_suspend_when_every_issue_is_complete(monkeypatch):
    """Se non c'e' nulla da decidere l'agente non interrompe l'utente."""
    def interrupt_vietato(payload):
        raise AssertionError('sospensione non necessaria')

    monkeypatch.setattr(changelog_module, 'interrupt', interrupt_vietato)
    toolset = FakeToolset(issues=[_issue(1)])

    result = await ChangelogLoader().load(FakeContextRef(), toolset)

    assert '#1' in result['tasks_formatted']


@pytest.mark.asyncio
async def test_load_aborts_when_the_user_cancels(monkeypatch):
    """Se l'utente annulla, l'operazione termina invece di proseguire."""
    monkeypatch.setattr(changelog_module, 'interrupt', lambda payload: 'CANCEL')
    toolset = FakeToolset(issues=[_issue(7, sufficient=False)])

    with pytest.raises(AgentCancelled):
        await ChangelogLoader().load(FakeContextRef(), toolset)


# --- Parsing dell'output ----------------------------------------------------

def test_technical_parse_output_wraps_the_model_text():
    """L'output tecnico diventa un blocco di testo del report."""
    blocks, proposal = ChangelogTechnicalProfile().parse_output(
        '## Novita\n- Aggiunta esportazione PDF\n', {}
    )

    assert blocks[0].markdown.startswith('## Novita')
    assert proposal is None


def test_business_parse_output_requests_the_second_phase():
    """Dopo la fase tecnica il profilo business ne richiede una seconda."""
    ctx = {'phase': 'TECHNICAL', 'excluded_tasks': []}

    _, _, next_phase = ChangelogBusinessProfile().parse_output('Testo tecnico.', ctx)

    assert next_phase is True
    assert ctx['phase'] == 'BUSINESS'
    assert ctx['technical_text'] == 'Testo tecnico.'


def test_business_parse_output_lists_the_discarded_issues():
    """Le issue scartate restano visibili nel report, con la motivazione."""
    ctx = {'phase': 'TECHNICAL', 'excluded_tasks': ['#2 Povera']}

    blocks, _, _ = ChangelogBusinessProfile().parse_output('Testo tecnico.', ctx)

    scartata = blocks[1]
    assert scartata.issueRef == '#2'
    assert 'insufficient metadata' in scartata.detail


def test_business_parse_output_rejects_hard_to_read_text():
    """Un changelog di business illeggibile viene rifiutato e rigenerato."""
    ctx = {'phase': 'BUSINESS'}
    testo_ostico = (
        'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
        'incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud '
        'exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute'
    )

    with pytest.raises(ValueError) as exc:
        ChangelogBusinessProfile().parse_output(testo_ostico, ctx)

    assert 'READABILITY_RETRY' in str(exc.value)


def test_business_parse_output_accepts_readable_text():
    """Un testo scorrevole conclude la generazione senza altre fasi."""
    ctx = {'phase': 'BUSINESS'}

    blocks, _, next_phase = ChangelogBusinessProfile().parse_output(
        'Il report si scarica. Si manda per mail. Tutto qui.', ctx
    )

    assert next_phase is False
    assert blocks[0].markdown.startswith('Il report')


# --- Indice di leggibilita' -------------------------------------------------

def test_calculate_flesch_reading_ease_returns_zero_for_empty_text():
    """Un testo vuoto non e' leggibile: punteggio nullo, non un errore."""
    assert calculate_flesch_reading_ease('   ') == 0.0


def test_calculate_flesch_reading_ease_prefers_simple_sentences():
    """Frasi brevi e parole comuni ottengono un punteggio piu' alto."""
    semplice = calculate_flesch_reading_ease('Il gatto e sul tetto. Il cane dorme.')
    complesso = calculate_flesch_reading_ease(
        'La riorganizzazione infrastrutturale dell architettura applicativa '
        'richiede una considerevole rielaborazione documentale preliminare.'
    )

    assert semplice > complesso


def test_calculate_flesch_reading_ease_ignores_markdown_syntax():
    """I simboli del markdown non devono falsare il conteggio delle parole."""
    con_markdown = calculate_flesch_reading_ease('## Il gatto e sul tetto.')
    senza_markdown = calculate_flesch_reading_ease('Il gatto e sul tetto.')

    assert con_markdown == pytest.approx(senza_markdown, abs=1.0)
