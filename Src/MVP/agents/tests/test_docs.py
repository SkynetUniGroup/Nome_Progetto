"""Test dell'agente Docs: rilevamento del codice non documentato e proposte di diff."""

import json

import pytest

from src.agents.docs import DocsInlineProfile, DocsLoader, DocsReadmeProfile

from conftest import FakeContextRef, FakeToolset


PYTHON_SOURCE = '''
def documentata(a, b):
    """Somma due numeri."""
    return a + b


def senza_docstring(a, b):
    return a - b


class ClasseDocumentata:
    """Una classe con docstring."""

    def metodo(self):
        return 1


class ClasseNuda:
    pass
'''

JS_SOURCE = '''
/**
 * Somma due numeri.
 */
function documentata(a, b) {
  return a + b;
}

function senzaJsdoc(a, b) {
  return a - b;
}

// Commento breve ma presente
const conCommento = (x) => x * 2;

const senzaNulla = (x) => x / 2;
'''


def _stato(targets: list, nome: str) -> str:
    """Restituisce la voce di rilevamento relativa all'unita' indicata.

    Args:
        targets (list): Le voci prodotte dal rilevatore.
        nome (str): Il nome dell'unita' cercata.

    Returns:
        str: La voce corrispondente.
    """
    return next(t for t in targets if f' {nome} ' in t)


# --- Rilevamento unita' da documentare (Python) -----------------------------

def test_find_target_units_flags_python_function_without_docstring():
    """Una funzione Python priva di docstring viene marcata come non documentata."""
    targets = DocsLoader()._find_target_units(PYTHON_SOURCE, 'src/calc.py')

    assert 'undocumented' in _stato(targets, 'senza_docstring')


def test_find_target_units_spares_documented_python_function():
    """Una funzione gia' documentata non va riscritta, solo verificata."""
    targets = DocsLoader()._find_target_units(PYTHON_SOURCE, 'src/calc.py')

    assert 'documented, verify alignment' in _stato(targets, 'documentata')


def test_find_target_units_covers_python_classes_too():
    """Il rilevamento riguarda anche le classi, non solo le funzioni."""
    targets = DocsLoader()._find_target_units(PYTHON_SOURCE, 'src/calc.py')

    assert 'documented, verify alignment' in _stato(targets, 'ClasseDocumentata')
    assert 'undocumented' in _stato(targets, 'ClasseNuda')


def test_find_target_units_reports_line_numbers():
    """Ogni unita' rilevata riporta la riga in cui si trova."""
    targets = DocsLoader()._find_target_units('def f():\n    return 1\n', 'src/a.py')

    assert targets[0].startswith('Line 1:')


def test_find_target_units_accepts_docstring_in_single_quotes():
    """La docstring delimitata da apici singoli tripli conta come documentazione."""
    source = "def f():\n    '''Documentata.'''\n    return 1\n"

    targets = DocsLoader()._find_target_units(source, 'src/a.py')

    assert 'documented, verify alignment' in targets[0]


def test_find_target_units_returns_nothing_for_a_file_without_code():
    """Un file senza funzioni ne' classi non produce candidati."""
    targets = DocsLoader()._find_target_units('# solo un commento\nX = 1\n', 'src/a.py')

    assert targets == []


# --- Rilevamento unita' da documentare (JavaScript/TypeScript) --------------

def test_find_target_units_flags_javascript_function_without_jsdoc():
    """Una funzione JavaScript priva di JSDoc viene marcata come non documentata."""
    targets = DocsLoader()._find_target_units(JS_SOURCE, 'app/util.js')

    assert 'undocumented' in _stato(targets, 'senzaJsdoc')


def test_find_target_units_spares_javascript_function_with_jsdoc():
    """Il blocco JSDoc che precede la funzione conta come documentazione."""
    targets = DocsLoader()._find_target_units(JS_SOURCE, 'app/util.js')

    assert 'documented, verify alignment' in _stato(targets, 'documentata')


def test_find_target_units_detects_arrow_function_constants():
    """Anche le costanti assegnate a funzioni freccia sono unita' documentabili."""
    targets = DocsLoader()._find_target_units(JS_SOURCE, 'app/util.js')

    assert 'undocumented' in _stato(targets, 'senzaNulla')


def test_find_target_units_accepts_line_comment_as_documentation():
    """Un commento di riga immediatamente sopra vale come documentazione."""
    targets = DocsLoader()._find_target_units(JS_SOURCE, 'app/util.js')

    assert 'documented, verify alignment' in _stato(targets, 'conCommento')


# --- Rilevamento endpoint non documentati -----------------------------------

def test_find_undocumented_endpoints_detects_nestjs_route():
    """Una rotta NestJS priva di JSDoc viene segnalata.

    Il nome del metodo non viene estratto: il rilevatore cerca `function`,
    `const`, `def` o `class`, mentre nei controller NestJS gli handler sono
    metodi di classe. La rotta viene comunque segnalata, identificata dalla
    riga del decoratore.
    """
    source = '@Get(\':id\')\nasync findOne(id: string) {\n  return this.svc.find(id);\n}\n'

    endpoints = DocsLoader()._find_undocumented_endpoints(source, 'src/app.controller.ts')

    assert len(endpoints) == 1
    assert 'line 1' in endpoints[0]


def test_find_undocumented_endpoints_names_the_handler_when_it_is_a_function():
    """Quando l'handler e' una funzione il nome viene riportato nell'avviso."""
    source = '@Get()\nfunction listAll() {\n  return [];\n}\n'

    endpoints = DocsLoader()._find_undocumented_endpoints(source, 'src/app.controller.ts')

    assert 'listAll' in endpoints[0]


def test_find_undocumented_endpoints_skips_documented_route():
    """Una rotta gia' documentata non viene riproposta."""
    source = '/**\n * Trova un elemento.\n */\n@Get(\':id\')\nasync findOne(id: string) {}\n'

    endpoints = DocsLoader()._find_undocumented_endpoints(source, 'src/app.controller.ts')

    assert endpoints == []


def test_find_undocumented_endpoints_detects_python_decorator():
    """Una rotta FastAPI priva di docstring viene segnalata."""
    source = '@app.get(\'/health\')\nasync def health():\n    return {}\n'

    endpoints = DocsLoader()._find_undocumented_endpoints(source, 'src/main.py')

    assert len(endpoints) == 1
    assert 'health' in endpoints[0]


def test_find_undocumented_endpoints_ignores_plain_functions():
    """Le funzioni che non espongono rotte non riguardano il profilo API."""
    source = 'def helper():\n    return 1\n'

    endpoints = DocsLoader()._find_undocumented_endpoints(source, 'src/main.py')

    assert endpoints == []


# --- Proposta di modifica (diff) --------------------------------------------

def test_parse_output_builds_diff_that_only_adds_lines():
    """La proposta inserisce documentazione senza rimuovere codice esistente.

    Un diff che contenesse righe in rimozione riscriverebbe codice funzionante
    per il solo scopo di documentarlo.
    """
    raw = json.dumps({'docs': [
        {'file': 'src/calc.py', 'line': 6, 'doc': '    """Sottrae due numeri."""'},
    ]})

    _, proposal = DocsInlineProfile().parse_output(raw)

    righe = proposal.diffUnified.splitlines()
    assert not any(r.startswith('-') and not r.startswith('---') for r in righe)
    assert '+    """Sottrae due numeri."""' in righe


def test_parse_output_targets_the_single_file_involved():
    """Con un solo file toccato la proposta lo indica come destinazione."""
    raw = json.dumps({'docs': [{'file': 'src/calc.py', 'line': 1, 'doc': '"""Doc."""'}]})

    _, proposal = DocsInlineProfile().parse_output(raw)

    assert proposal.targetPath == 'src/calc.py'


def test_parse_output_marks_multi_file_proposals():
    """Toccando piu' file la destinazione diventa esplicitamente multipla."""
    raw = json.dumps({'docs': [
        {'file': 'src/a.py', 'line': 1, 'doc': '"""A."""'},
        {'file': 'src/b.py', 'line': 1, 'doc': '"""B."""'},
    ]})

    _, proposal = DocsInlineProfile().parse_output(raw)

    assert proposal.targetPath == 'Multi-file scope'
    assert '--- a/src/a.py' in proposal.diffUnified
    assert '--- a/src/b.py' in proposal.diffUnified


def test_parse_output_counts_lines_of_multiline_docstring():
    """L'intestazione del diff dichiara quante righe vengono aggiunte."""
    raw = json.dumps({'docs': [
        {'file': 'src/a.py', 'line': 3, 'doc': '"""Prima riga.\n\nSeconda riga.\n"""'},
    ]})

    _, proposal = DocsInlineProfile().parse_output(raw)

    assert '@@ -3,0 +3,4 @@' in proposal.diffUnified


def test_parse_output_without_docs_produces_no_proposal():
    """Se non c'e' nulla da documentare non viene proposta alcuna modifica."""
    blocks, proposal = DocsInlineProfile().parse_output(json.dumps({'docs': []}))

    assert proposal is None
    assert blocks == []


def test_parse_output_reports_complexity_warnings():
    """Le porzioni troppo complesse vengono segnalate invece di essere documentate."""
    raw = json.dumps({
        'docs': [],
        'warnings': [{'file': 'src/legacy.py', 'line': 120, 'message': 'Funzione troppo complessa'}],
    })

    blocks, proposal = DocsInlineProfile().parse_output(raw)

    assert len(blocks) == 1
    assert blocks[0].filePath == 'src/legacy.py'
    assert blocks[0].lineStart == 120
    assert blocks[0].reason == 'Funzione troppo complessa'
    assert proposal is None


def test_parse_output_keeps_warnings_alongside_a_proposal():
    """Avvisi e proposta convivono: alcune unita' documentate, altre escluse."""
    raw = json.dumps({
        'docs': [{'file': 'src/a.py', 'line': 1, 'doc': '"""A."""'}],
        'warnings': [{'file': 'src/b.py', 'line': 5, 'message': 'Troppo complessa'}],
    })

    blocks, proposal = DocsInlineProfile().parse_output(raw)

    assert len(blocks) == 1
    assert proposal is not None


# --- Profilo README ---------------------------------------------------------


# RF.79 / RF.81 -- template README personalizzato.
#
# Il template appartiene all'utente, non al repository: arriva nel payload
# di avvio (il backend ce lo mette leggendolo da TemplatesService) e non
# viene letto da GitHub. Assente, l'agente ricade sul proprio modello di
# default: e' cosi' che RF.81 realizza il "ripristino" senza un'operazione
# dedicata.

@pytest.mark.asyncio
async def test_readme_loader_carries_the_user_template_into_the_context():
    """Il template caricato dall'utente arriva fino al contesto dell'agente."""
    toolset = FakeToolset(nodes=[{'type': 'file', 'path': 'README.md'}],
                          files={'README.md': '# Attuale\n'})

    ctx = await DocsLoader('DOCS_README').load(
        FakeContextRef(), toolset, {'readmeTemplate': '# Il mio template\n'}
    )

    assert ctx['readme_template'] == '# Il mio template\n'


@pytest.mark.asyncio
async def test_readme_loader_leaves_the_template_empty_without_a_payload():
    """Senza template caricato il campo resta vuoto: nessun valore inventato."""
    toolset = FakeToolset(nodes=[{'type': 'file', 'path': 'README.md'}],
                          files={'README.md': '# Attuale\n'})

    ctx = await DocsLoader('DOCS_README').load(FakeContextRef(), toolset, {})

    assert ctx['readme_template'] is None


def test_readme_build_prompt_uses_the_user_template_when_present():
    """Il template dell'utente finisce nel prompt al posto del default."""
    profile = DocsReadmeProfile()

    system_prompt, _ = profile.build_prompt({
        'code_units': 'albero',
        'readme': '# Attuale',
        'readme_template': '# TEMPLATE PERSONALIZZATO\n\n## Sezione mia\n',
    })

    assert 'TEMPLATE PERSONALIZZATO' in system_prompt
    assert 'Sezione mia' in system_prompt


def test_readme_build_prompt_falls_back_to_the_default_template():
    """Senza template personalizzato si usa il modello di default (RF.81)."""
    profile = DocsReadmeProfile()

    senza, _ = profile.build_prompt({
        'code_units': 'albero',
        'readme': '# Attuale',
        'readme_template': None,
    })
    con, _ = profile.build_prompt({
        'code_units': 'albero',
        'readme': '# Attuale',
        'readme_template': '# TEMPLATE PERSONALIZZATO\n',
    })

    assert 'TEMPLATE PERSONALIZZATO' not in senza
    assert senza != con


def test_readme_build_prompt_treats_a_blank_template_as_absent():
    """Un template di soli spazi non deve svuotare il prompt: vale come assente."""
    profile = DocsReadmeProfile()

    vuoto, _ = profile.build_prompt({
        'code_units': 'albero',
        'readme': '# Attuale',
        'readme_template': '   \n\t \n',
    })
    assente, _ = profile.build_prompt({
        'code_units': 'albero',
        'readme': '# Attuale',
    })

    assert vuoto == assente


def test_readme_parse_output_diffs_against_the_existing_file():
    """Il README proposto viene confrontato con quello attuale."""
    profile = DocsReadmeProfile()
    profile._ctx = {'original_readme': '# Vecchio\n', 'readme_path': 'README.md'}

    _, proposal = profile.parse_output('# Nuovo\n')

    assert proposal.targetPath == 'README.md'
    assert '-# Vecchio' in proposal.diffUnified
    assert '+# Nuovo' in proposal.diffUnified


def test_readme_parse_output_strips_markdown_fence():
    """Il modello puo' incapsulare il README in un blocco di codice: va tolto."""
    profile = DocsReadmeProfile()
    profile._ctx = {'original_readme': '', 'readme_path': 'README.md'}

    _, proposal = profile.parse_output('```markdown\n# Titolo\n```')

    assert '+# Titolo' in proposal.diffUnified
    assert '```' not in proposal.diffUnified


def test_readme_parse_output_treats_missing_readme_as_new_file():
    """Se il README non esiste il diff parte da /dev/null."""
    profile = DocsReadmeProfile()
    profile._ctx = {'original_readme': 'Not found.', 'readme_path': 'README.md'}

    _, proposal = profile.parse_output('# Nuovo progetto\n')

    assert '/dev/null' in proposal.diffUnified


@pytest.mark.xfail(
    reason="DIFETTO APERTO: raw.strip() toglie l'a capo finale, quindi il confronto "
           'con il README originale produce sempre un diff spurio',
    strict=True,
)
def test_readme_parse_output_proposes_nothing_when_already_optimal():
    """Se il README proposto coincide con quello attuale non si apre una PR inutile.

    Il ramo "already optimal" esiste nel codice ma non e' raggiungibile quando
    il README di partenza termina con un a capo, cioe' praticamente sempre:
    `parse_output` applica `raw.strip()` all'output del modello mentre
    `original_readme` conserva l'a capo finale, quindi `splitlines(keepends=True)`
    confronta 'Contenuto.\\n' con 'Contenuto.' e difflib li vede diversi.
    """
    profile = DocsReadmeProfile()
    profile._ctx = {'original_readme': '# Titolo\n', 'readme_path': 'README.md'}

    blocks, proposal = profile.parse_output('# Titolo\n')

    assert proposal is None
    assert 'already optimal' in blocks[0].markdown


@pytest.mark.xfail(
    reason='DIFETTO APERTO: a ogni esecuzione viene proposta una PR il cui unico '
           "contenuto e' la rimozione dell'a capo finale del README",
    strict=True,
)
def test_readme_parse_output_diff_is_not_spurious_on_identical_content():
    """Un README gia' corretto non deve generare una proposta di modifica.

    DIFETTO APERTO: l'agente propone comunque un diff il cui unico contenuto e'
    la rimozione dell'a capo finale del file, e apre quindi una Pull Request
    a ogni esecuzione anche quando non c'e' nulla da cambiare.
    Vedi la docstring del test precedente per la causa.
    """
    profile = DocsReadmeProfile()
    profile._ctx = {'original_readme': '# Titolo\n\nContenuto.\n', 'readme_path': 'README.md'}

    _, proposal = profile.parse_output('# Titolo\n\nContenuto.\n')

    assert proposal is None
