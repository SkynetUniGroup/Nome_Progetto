"""Test delle funzioni condivise dai profili agente: prompt e parsing JSON."""

import pytest

from src.agents._base import extract_json, load_prompt_template, render_prompt


# --- extract_json -----------------------------------------------------------

def test_extract_json_plain_object():
    """Un oggetto JSON nudo viene interpretato cosi' com'e'."""
    raw = '{"findings": []}'

    result = extract_json(raw)

    assert result == {'findings': []}


def test_extract_json_inside_markdown_fence():
    """Il JSON racchiuso in un blocco di codice viene comunque estratto."""
    raw = '```json\n{"findings": [{"severity": "HIGH"}]}\n```'

    result = extract_json(raw)

    assert result['findings'][0]['severity'] == 'HIGH'


def test_extract_json_ignores_surrounding_prose():
    """Il modello puo' anteporre e posporre testo: conta solo l'oggetto."""
    raw = 'Ecco il risultato dell\'analisi:\n{"findings": []}\nSpero sia utile.'

    result = extract_json(raw)

    assert result == {'findings': []}


def test_extract_json_recovers_from_literal_newlines():
    """Un a capo letterale dentro una stringa non deve far fallire il parsing."""
    raw = '{"summary": "prima riga\nseconda riga"}'

    result = extract_json(raw)

    assert 'prima riga' in result['summary']


def test_extract_json_raises_on_unparsable_output():
    """Un output non interpretabile produce un errore esplicito, non un dict vuoto."""
    with pytest.raises(ValueError) as exc:
        extract_json('il modello si e\' rifiutato di rispondere')

    assert 'JSON' in str(exc.value)


def test_extract_json_raises_on_truncated_object():
    """Una risposta troncata a meta' non deve essere scambiata per valida."""
    with pytest.raises(ValueError):
        extract_json('{"findings": [{"severity": "HIGH"')


# --- render_prompt ----------------------------------------------------------

def test_render_prompt_substitutes_required_variables():
    """Le variabili dichiarate vengono sostituite in system e user prompt."""
    template = {
        'system_prompt': 'Analizza il repository {repo}.',
        'user_prompt': 'Ambito: {scope}.',
        'required_vars': ['repo', 'scope'],
    }

    system, user = render_prompt(template, repo='NodeGoat', scope='intero')

    assert system == 'Analizza il repository NodeGoat.'
    assert user == 'Ambito: intero.'


def test_render_prompt_appends_output_contract():
    """Il contratto di output viene accodato al prompt di sistema."""
    template = {
        'system_prompt': 'Analizza.',
        'user_prompt': 'Procedi.',
        'output_contract': 'Rispondi in JSON.',
    }

    system, _ = render_prompt(template)

    assert 'Analizza.' in system
    assert 'Rispondi in JSON.' in system


def test_render_prompt_raises_on_missing_variable():
    """Una variabile dichiarata ma non fornita interrompe subito la costruzione.

    Meglio un errore qui che un prompt spedito al modello con un segnaposto
    non sostituito al posto del contesto.
    """
    template = {'system_prompt': 'Analizza {repo}.', 'required_vars': ['repo']}

    with pytest.raises(ValueError) as exc:
        render_prompt(template)

    assert 'repo' in str(exc.value)


def test_render_prompt_supports_single_body_templates():
    """Un template a corpo unico produce un prompt utente segnaposto."""
    template = {'body': 'Istruzioni complete.'}

    system, user = render_prompt(template)

    assert system == 'Istruzioni complete.'
    assert user == 'Proceed with the processing.'


def test_render_prompt_substitutes_variable_repeated_many_times():
    """Tutte le occorrenze della stessa variabile vengono sostituite."""
    template = {
        'system_prompt': '{repo} e ancora {repo}.',
        'user_prompt': '{repo}',
        'required_vars': ['repo'],
    }

    system, user = render_prompt(template, repo='NodeGoat')

    assert '{repo}' not in system
    assert user == 'NodeGoat'


def test_render_prompt_substitutes_inside_output_contract():
    """Anche il contratto di output accodato riceve le sostituzioni."""
    template = {
        'system_prompt': 'Analizza.',
        'output_contract': 'Cita sempre {repo}.',
        'required_vars': ['repo'],
    }

    system, _ = render_prompt(template, repo='NodeGoat')

    assert 'Cita sempre NodeGoat.' in system


# --- load_prompt_template ---------------------------------------------------

@pytest.mark.parametrize(
    'agent_name,template_id',
    [
        ('security', 'owasp_scan'),
        ('security', 'policy_scan'),
        ('docs', 'inline_docs'),
        ('docs', 'readme_docs'),
        ('docs', 'api_docs'),
        ('changelog', 'changelog_tech'),
        ('changelog', 'changelog_biz'),
    ],
)
def test_load_prompt_template_finds_every_shipped_prompt(agent_name, template_id):
    """Ogni prompt distribuito col servizio e' caricabile e non vuoto.

    Un template mancante o rinominato si manifesterebbe altrimenti solo a
    runtime, al primo utilizzo di quell'operazione.
    """
    template = load_prompt_template(agent_name, template_id)

    assert isinstance(template, dict)
    assert template.get('body') or template.get('system_prompt')


def test_load_prompt_template_raises_on_unknown_template():
    """Un template inesistente produce un errore che ne riporta il percorso."""
    with pytest.raises(FileNotFoundError) as exc:
        load_prompt_template('security', 'template_inesistente')

    assert 'template_inesistente' in str(exc.value)
