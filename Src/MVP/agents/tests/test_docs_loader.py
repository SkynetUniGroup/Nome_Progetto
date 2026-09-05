"""Test del caricamento di contesto dell'agente Docs.

Il loader ha tre percorsi distinti a seconda dell'operazione: DOCS_README
guarda l'albero e i file di progetto, DOCS_INLINE e DOCS_API leggono il
codice e ne estraggono le unita' da documentare.
"""

import pytest

from src.agents.docs import DocsLoader

from conftest import FakeContextRef, FakeToolset


PY_NON_DOCUMENTATO = 'def calcola(a, b):\n    return a + b\n'
PY_DOCUMENTATO = 'def calcola(a, b):\n    """Somma."""\n    return a + b\n'
ENDPOINT_NON_DOCUMENTATO = "@app.get('/health')\nasync def health():\n    return {}\n"


def _file(path: str) -> dict:
    """Costruisce un nodo file dell'albero del repository."""
    return {'type': 'file', 'path': path}


# --- DOCS_README ------------------------------------------------------------

@pytest.mark.asyncio
async def test_load_readme_returns_the_whole_file_tree():
    """Per il README serve la mappa del progetto, non il contenuto dei file."""
    toolset = FakeToolset(nodes=[_file('src/main.py'), _file('docs/guida.md')])

    result = await DocsLoader(operation='DOCS_README').load(FakeContextRef(), toolset)

    assert 'src/main.py' in result['code_units']
    assert 'docs/guida.md' in result['code_units']
    assert result['language'] == 'markdown'


@pytest.mark.asyncio
async def test_load_readme_picks_up_the_existing_readme():
    """Il README attuale viene letto: serve come base del confronto."""
    toolset = FakeToolset(
        nodes=[_file('README.md')],
        files={'README.md': '# Progetto\n'},
    )

    result = await DocsLoader(operation='DOCS_README').load(FakeContextRef(), toolset)

    assert result['original_readme'] == '# Progetto\n'
    assert result['readme_path'] == 'README.md'


@pytest.mark.asyncio
async def test_load_readme_finds_the_file_regardless_of_case():
    """Un README scritto in minuscolo viene comunque riconosciuto."""
    toolset = FakeToolset(
        nodes=[_file('readme.md')],
        files={'readme.md': '# Progetto\n'},
    )

    result = await DocsLoader(operation='DOCS_README').load(FakeContextRef(), toolset)

    assert result['readme_path'] == 'readme.md'


@pytest.mark.asyncio
async def test_load_readme_reports_absence_instead_of_an_empty_string():
    """Senza README il contesto lo dichiara, cosi' il diff parte da zero."""
    toolset = FakeToolset(nodes=[_file('src/main.py')])

    result = await DocsLoader(operation='DOCS_README').load(FakeContextRef(), toolset)

    assert result['original_readme'] == 'Not found.'
    assert result['readme_path'] == 'README.md'


@pytest.mark.asyncio
async def test_load_readme_includes_the_package_manifest():
    """Il package.json descrive il progetto meglio dell'albero da solo."""
    toolset = FakeToolset(
        nodes=[_file('package.json')],
        files={'package.json': '{"name": "code-guardian"}'},
    )

    result = await DocsLoader(operation='DOCS_README').load(FakeContextRef(), toolset)

    assert result['package_json'] == '{"name": "code-guardian"}'


# --- DOCS_INLINE ------------------------------------------------------------

@pytest.mark.asyncio
async def test_load_inline_includes_only_files_with_units_to_document():
    """Un file gia' interamente documentato non viene mandato al modello."""
    toolset = FakeToolset(
        nodes=[_file('src/nudo.py'), _file('src/vuoto.py')],
        files={'src/nudo.py': PY_NON_DOCUMENTATO, 'src/vuoto.py': '# nessuna funzione\n'},
    )

    result = await DocsLoader(operation='DOCS_INLINE').load(FakeContextRef(), toolset)

    assert 'src/nudo.py' in result['code_units']
    assert 'src/vuoto.py' not in result['code_units']


@pytest.mark.asyncio
async def test_load_inline_carries_both_the_source_and_the_unit_list():
    """Il contesto contiene il codice e l'elenco puntuale delle unita'."""
    toolset = FakeToolset(
        nodes=[_file('src/calc.py')],
        files={'src/calc.py': PY_NON_DOCUMENTATO},
    )

    result = await DocsLoader(operation='DOCS_INLINE').load(FakeContextRef(), toolset)

    assert 'def calcola(a, b)' in result['code_units']
    assert 'Units to process' in result['code_units']
    assert 'calcola' in result['code_units']


@pytest.mark.asyncio
async def test_load_inline_ignores_unsupported_languages():
    """Solo i linguaggi che l'agente sa leggere entrano nel contesto."""
    toolset = FakeToolset(
        nodes=[_file('src/calc.py'), _file('src/stile.css'), _file('immagine.png')],
        files={'src/calc.py': PY_NON_DOCUMENTATO, 'src/stile.css': 'body{}'},
    )

    result = await DocsLoader(operation='DOCS_INLINE').load(FakeContextRef(), toolset)

    assert 'src/stile.css' not in result['code_units']
    assert 'immagine.png' not in result['code_units']


@pytest.mark.asyncio
async def test_load_inline_respects_a_restricted_scope():
    """Con ambito ristretto restano solo i file sotto i percorsi scelti."""
    toolset = FakeToolset(
        nodes=[_file('app/servizio.py'), _file('test/prova.py')],
        files={'app/servizio.py': PY_NON_DOCUMENTATO, 'test/prova.py': PY_NON_DOCUMENTATO},
    )
    context = FakeContextRef(scope_type='DIRECTORIES', paths=['app'])

    result = await DocsLoader(operation='DOCS_INLINE').load(context, toolset)

    assert 'app/servizio.py' in result['code_units']
    assert 'test/prova.py' not in result['code_units']


@pytest.mark.asyncio
async def test_load_inline_skips_files_that_come_back_empty():
    """Un file vuoto non produce una sezione di contesto senza contenuto."""
    toolset = FakeToolset(nodes=[_file('src/vuoto.py')], files={'src/vuoto.py': ''})

    result = await DocsLoader(operation='DOCS_INLINE').load(FakeContextRef(), toolset)

    assert result['code_units'] == 'No units found to document or verify.'


@pytest.mark.asyncio
async def test_load_inline_says_so_when_everything_is_already_documented():
    """Niente da fare e' un esito legittimo, dichiarato esplicitamente."""
    toolset = FakeToolset(
        nodes=[_file('src/calc.py')],
        files={'src/calc.py': PY_DOCUMENTATO},
    )

    result = await DocsLoader(operation='DOCS_INLINE').load(FakeContextRef(), toolset)

    # Il file resta comunque incluso: e' documentato ma va verificato
    # l'allineamento fra docstring e codice.
    assert 'verify alignment' in result['code_units']


# --- DOCS_API ---------------------------------------------------------------

@pytest.mark.asyncio
async def test_load_api_looks_for_endpoints_not_for_functions():
    """Il profilo API si occupa delle rotte, non di ogni funzione del file."""
    toolset = FakeToolset(
        nodes=[_file('src/main.py'), _file('src/utils.py')],
        files={'src/main.py': ENDPOINT_NON_DOCUMENTATO, 'src/utils.py': PY_NON_DOCUMENTATO},
    )

    result = await DocsLoader(operation='DOCS_API').load(FakeContextRef(), toolset)

    assert 'src/main.py' in result['code_units']
    # utils.py ha una funzione non documentata ma nessuna rotta: fuori ambito.
    assert 'src/utils.py' not in result['code_units']


@pytest.mark.asyncio
async def test_load_api_reports_nothing_when_there_are_no_routes():
    """Un progetto senza endpoint non produce lavoro per questo profilo."""
    toolset = FakeToolset(
        nodes=[_file('src/utils.py')],
        files={'src/utils.py': PY_NON_DOCUMENTATO},
    )

    result = await DocsLoader(operation='DOCS_API').load(FakeContextRef(), toolset)

    assert result['code_units'] == 'No units found to document or verify.'


# --- Comune -----------------------------------------------------------------

@pytest.mark.asyncio
async def test_load_reports_progress_to_the_backend():
    """Il caricamento segnala il proprio avanzamento all'interfaccia."""
    toolset = FakeToolset(nodes=[_file('src/calc.py')], files={'src/calc.py': PY_NON_DOCUMENTATO})

    await DocsLoader(operation='DOCS_INLINE').load(FakeContextRef(), toolset)

    assert ('docs_context_loaded', 30) in toolset.progress_calls


@pytest.mark.asyncio
async def test_load_readme_reports_progress_too():
    """Anche il percorso README segnala l'avanzamento."""
    toolset = FakeToolset(nodes=[_file('README.md')], files={'README.md': '# X\n'})

    await DocsLoader(operation='DOCS_README').load(FakeContextRef(), toolset)

    assert ('docs_context_loaded', 30) in toolset.progress_calls


@pytest.mark.asyncio
async def test_load_tolerates_an_empty_repository():
    """Un repository senza file non fa cadere il caricamento."""
    toolset = FakeToolset(nodes=[])

    result = await DocsLoader(operation='DOCS_INLINE').load(FakeContextRef(), toolset)

    assert result['code_units'] == 'No units found to document or verify.'
    assert result['package_json'] == 'Not found.'
