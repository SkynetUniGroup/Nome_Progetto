"""Test dell'agente Security: caricamento del contesto e parsing dell'output."""

import json

import pytest

from src.agents.security import (
    ContextResourceInvalidError,
    ContextResourceMissingError,
    OwaspScanProfile,
    SecurityPolicyProfile,
    SecurityLoader,
)

from conftest import FakeContextRef, FakeToolset


def _file_node(path: str) -> dict:
    """Costruisce un nodo file dell'albero del repository."""
    return {'type': 'file', 'path': path}


def _owasp_output(findings: list) -> str:
    """Serializza dei riscontri come farebbe il modello, dentro un blocco di codice."""
    return '```json\n' + json.dumps({'findings': findings}) + '\n```'


# --- SecurityLoader ---------------------------------------------------------

@pytest.mark.asyncio
async def test_load_keeps_only_supported_source_files():
    """Nell'ambito finiscono solo i linguaggi che l'agente sa analizzare."""
    toolset = FakeToolset(nodes=[
        _file_node('app/server.js'),
        _file_node('src/main.py'),
        _file_node('src/app.ts'),
        _file_node('README.md'),
        _file_node('logo.png'),
    ])

    result = await SecurityLoader().load(FakeContextRef(), toolset)

    assert 'app/server.js' in result['files']
    assert 'src/main.py' in result['files']
    assert 'src/app.ts' in result['files']
    assert 'README.md' not in result['files']
    assert 'logo.png' not in result['files']


@pytest.mark.asyncio
async def test_load_ignores_directory_nodes():
    """Le directory non sono file da analizzare, anche se il nome inganna."""
    toolset = FakeToolset(nodes=[
        {'type': 'dir', 'path': 'src/utils.py'},
        _file_node('src/main.py'),
    ])

    result = await SecurityLoader().load(FakeContextRef(), toolset)

    assert 'src/utils.py' not in result['files']
    assert 'src/main.py' in result['files']


@pytest.mark.asyncio
async def test_load_restricts_files_to_selected_scope():
    """Con ambito ristretto restano solo i file sotto i percorsi indicati."""
    toolset = FakeToolset(nodes=[
        _file_node('app/routes/session.js'),
        _file_node('app/data/user-dao.js'),
        _file_node('test/unit.js'),
    ])
    context = FakeContextRef(scope_type='DIRECTORIES', paths=['app/routes'])

    result = await SecurityLoader().load(context, toolset)

    assert 'app/routes/session.js' in result['files']
    assert 'app/data/user-dao.js' not in result['files']
    assert 'test/unit.js' not in result['files']


@pytest.mark.asyncio
async def test_load_raises_when_scope_contains_no_analysable_file():
    """Un ambito senza codice analizzabile e' un errore, non una scansione vuota."""
    toolset = FakeToolset(nodes=[_file_node('README.md'), _file_node('logo.png')])

    with pytest.raises(ContextResourceInvalidError):
        await SecurityLoader().load(FakeContextRef(), toolset)


@pytest.mark.asyncio
async def test_load_raises_when_policy_scan_has_no_policy_file():
    """Senza POLICY.md la scansione delle policy non ha direttive: si ferma."""
    toolset = FakeToolset(nodes=[_file_node('src/main.py')])

    with pytest.raises(ContextResourceMissingError) as exc:
        await SecurityLoader(operation='SECURITY_POLICY').load(FakeContextRef(), toolset)

    assert 'POLICY.md' in str(exc.value)


@pytest.mark.asyncio
async def test_load_uses_policy_file_content_when_present():
    """Il contenuto di POLICY.md diventa il riferimento della scansione."""
    toolset = FakeToolset(
        nodes=[_file_node('src/main.py'), _file_node('POLICY.md')],
        files={'POLICY.md': 'Vietato loggare dati personali.'},
    )

    result = await SecurityLoader(operation='SECURITY_POLICY').load(FakeContextRef(), toolset)

    assert result['policy'] == 'Vietato loggare dati personali.'


@pytest.mark.asyncio
async def test_load_finds_policy_file_regardless_of_case():
    """Il file di policy va riconosciuto anche se scritto in minuscolo."""
    toolset = FakeToolset(
        nodes=[_file_node('src/main.py'), _file_node('policy.md')],
        files={'policy.md': 'Regole aziendali.'},
    )

    result = await SecurityLoader(operation='SECURITY_POLICY').load(FakeContextRef(), toolset)

    assert result['policy'] == 'Regole aziendali.'


@pytest.mark.asyncio
async def test_load_falls_back_to_standard_rules_for_owasp_scan():
    """La scansione OWASP prosegue senza POLICY.md, con le regole standard."""
    toolset = FakeToolset(nodes=[_file_node('src/main.py')])

    result = await SecurityLoader(operation='SECURITY_OWASP').load(FakeContextRef(), toolset)

    assert 'OWASP' in result['policy']


@pytest.mark.asyncio
async def test_load_reports_progress_to_the_backend():
    """Il caricamento del contesto segnala il proprio avanzamento."""
    toolset = FakeToolset(nodes=[_file_node('src/main.py')])

    await SecurityLoader().load(FakeContextRef(), toolset)

    assert ('security_context_loaded', 30) in toolset.progress_calls


# --- OwaspScanProfile.parse_output ------------------------------------------

def test_parse_output_normalises_snippet_remediation():
    """Un rimedio fornito come frammento di codice conserva linguaggio e codice."""
    raw = _owasp_output([{
        'category': 'A03:2021 Injection',
        'severity': 'HIGH',
        'file': 'app/data/user-dao.js',
        'start_line': 42,
        'end_line': 45,
        'message': 'Query concatenata.',
        'remediation': {'kind': 'snippet', 'language': 'javascript', 'code': 'db.query(sql, [id])'},
    }])

    blocks, proposal = OwaspScanProfile().parse_output(raw)

    assert blocks[0].remediation.kind == 'SNIPPET'
    assert blocks[0].remediation.language == 'javascript'
    assert blocks[0].remediation.code == 'db.query(sql, [id])'
    assert proposal is None


def test_parse_output_normalises_markdown_remediation():
    """Un rimedio testuale in markdown viene ricondotto alla forma TEXT."""
    raw = _owasp_output([{
        'severity': 'HIGH',
        'remediation': {'kind': 'text', 'markdown': 'Usare **query parametrizzate**.'},
    }])

    blocks, _ = OwaspScanProfile().parse_output(raw)

    assert blocks[0].remediation.kind == 'TEXT'
    assert blocks[0].remediation.text == 'Usare **query parametrizzate**.'


def test_parse_output_falls_back_to_text_field_when_markdown_absent():
    """Se manca il campo markdown si usa il campo text."""
    raw = _owasp_output([{'severity': 'LOW', 'remediation': {'kind': 'text', 'text': 'Sanificare.'}}])

    blocks, _ = OwaspScanProfile().parse_output(raw)

    assert blocks[0].remediation.text == 'Sanificare.'


def test_parse_output_handles_plain_string_remediation():
    """Un rimedio inviato come stringa semplice resta comunque utilizzabile."""
    raw = _owasp_output([{'severity': 'LOW', 'remediation': 'Validare l\'input.'}])

    blocks, _ = OwaspScanProfile().parse_output(raw)

    assert blocks[0].remediation.kind == 'TEXT'
    assert blocks[0].remediation.text == 'Validare l\'input.'


def test_parse_output_handles_missing_remediation():
    """Un riscontro senza rimedio non fa cadere il parsing."""
    raw = _owasp_output([{'severity': 'LOW'}])

    blocks, _ = OwaspScanProfile().parse_output(raw)

    assert blocks[0].remediation.text == 'No remediation provided'


def test_parse_output_maps_info_severity_to_low():
    """La gravita' INFO non esiste nel modello dati: viene ricondotta a LOW."""
    raw = _owasp_output([{'severity': 'info'}])

    blocks, _ = OwaspScanProfile().parse_output(raw)

    assert blocks[0].severity == 'LOW'


def test_parse_output_uppercases_severity():
    """La gravita' viene normalizzata a maiuscolo, comunque il modello la scriva."""
    raw = _owasp_output([{'severity': 'critical'}])

    blocks, _ = OwaspScanProfile().parse_output(raw)

    assert blocks[0].severity == 'CRITICAL'


def test_parse_output_defaults_severity_to_medium():
    """Un riscontro senza gravita' dichiarata viene considerato MEDIUM."""
    raw = _owasp_output([{'category': 'Generica'}])

    blocks, _ = OwaspScanProfile().parse_output(raw)

    assert blocks[0].severity == 'MEDIUM'


def test_parse_output_leaves_end_line_empty_when_not_provided():
    """Senza riga finale il blocco resta con lineEnd nullo, non con uno zero."""
    raw = _owasp_output([{'severity': 'LOW', 'start_line': 10}])

    blocks, _ = OwaspScanProfile().parse_output(raw)

    assert blocks[0].lineStart == 10
    assert blocks[0].lineEnd is None


def test_parse_output_numbers_findings_contiguously():
    """Il campo order rispecchia la posizione finale, senza buchi.

    Prima questo test asseriva che l'ordine di arrivo venisse conservato:
    e' proprio cio' che RF.61 chiede di NON fare (vedi i test TU_11 sotto).
    Resta valida la parte che conta ancora, cioe' che order sia una
    numerazione contigua a partire da zero.
    """
    raw = _owasp_output([
        {'severity': 'HIGH', 'category': 'Primo'},
        {'severity': 'HIGH', 'category': 'Secondo'},
        {'severity': 'HIGH', 'category': 'Terzo'},
    ])

    blocks, _ = OwaspScanProfile().parse_output(raw)

    assert [b.order for b in blocks] == [0, 1, 2]
    assert [b.category for b in blocks] == ['Primo', 'Secondo', 'Terzo']


# --- TU_11 (RF.61): riordino per gravita' -----------------------------------

def test_tu11_findings_are_sorted_from_most_to_least_critical():
    """I riscontri escono dal piu' al meno critico, non nell'ordine del modello."""
    raw = _owasp_output([
        {'severity': 'LOW', 'category': 'Basso'},
        {'severity': 'CRITICAL', 'category': 'Critico'},
        {'severity': 'MEDIUM', 'category': 'Medio'},
        {'severity': 'HIGH', 'category': 'Alto'},
    ])

    blocks, _ = OwaspScanProfile().parse_output(raw)

    assert [b.severity for b in blocks] == ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
    assert [b.category for b in blocks] == ['Critico', 'Alto', 'Medio', 'Basso']
    # order rinumerato sulla posizione finale, non su quella di arrivo.
    assert [b.order for b in blocks] == [0, 1, 2, 3]


def test_tu11_findings_of_equal_severity_keep_the_model_order():
    """A parita' di gravita' l'ordinamento e' stabile: non rimescola."""
    raw = _owasp_output([
        {'severity': 'HIGH', 'category': 'Primo alto'},
        {'severity': 'LOW', 'category': 'Basso'},
        {'severity': 'HIGH', 'category': 'Secondo alto'},
    ])

    blocks, _ = OwaspScanProfile().parse_output(raw)

    assert [b.category for b in blocks] == ['Primo alto', 'Secondo alto', 'Basso']


def test_tu11_info_severity_is_ranked_as_low():
    """INFO viene ricondotto a LOW e ordinato di conseguenza, non scartato."""
    raw = _owasp_output([
        {'severity': 'INFO', 'category': 'Informativo'},
        {'severity': 'MEDIUM', 'category': 'Medio'},
    ])

    blocks, _ = OwaspScanProfile().parse_output(raw)

    assert [b.severity for b in blocks] == ['MEDIUM', 'LOW']


# --- TU_10 (RF.30): riscontri fuori ambito ----------------------------------

def _ctx(*percorsi: str) -> dict:
    """Contesto caricato, con il solo campo che parse_output usa per l'ambito."""
    return {'scope_files': list(percorsi)}


def test_tu10_discards_findings_on_files_outside_the_requested_scope():
    """Una vulnerabilita' su un file fuori ambito non finisce nel report."""
    raw = _owasp_output([
        {'severity': 'HIGH', 'category': 'Dentro', 'file': 'src/example.js'},
        {'severity': 'CRITICAL', 'category': 'Fuori', 'file': 'altro/segreto.js'},
    ])

    blocks, _ = OwaspScanProfile().parse_output(raw, _ctx('src/example.js'))

    assert [b.category for b in blocks] == ['Dentro']


def test_tu10_discards_hallucinated_paths_that_do_not_exist():
    """Un percorso mai fornito al modello viene scartato anche se plausibile."""
    raw = _owasp_output([
        {'severity': 'CRITICAL', 'category': 'Inventato', 'file': 'src/utils/auth.js'},
    ])

    blocks, _ = OwaspScanProfile().parse_output(raw, _ctx('src/example.js'))

    assert blocks == []


def test_tu10_keeps_the_finding_when_the_model_decorates_the_path():
    """'./src/a.js' e 'src/a.js' sono lo stesso file: scartarlo sarebbe un falso negativo."""
    raw = _owasp_output([
        {'severity': 'HIGH', 'category': 'Punto barra', 'file': './src/example.js'},
        {'severity': 'HIGH', 'category': 'Barre rovesce', 'file': 'src\\altro.js'},
    ])

    blocks, _ = OwaspScanProfile().parse_output(
        raw, _ctx('src/example.js', 'src/altro.js')
    )

    assert [b.category for b in blocks] == ['Punto barra', 'Barre rovesce']


def test_tu10_renumbers_order_after_dropping_out_of_scope_findings():
    """Scartando un riscontro la numerazione resta contigua, senza buchi."""
    raw = _owasp_output([
        {'severity': 'HIGH', 'category': 'Fuori', 'file': 'altro/x.js'},
        {'severity': 'HIGH', 'category': 'Dentro A', 'file': 'src/a.js'},
        {'severity': 'HIGH', 'category': 'Dentro B', 'file': 'src/b.js'},
    ])

    blocks, _ = OwaspScanProfile().parse_output(raw, _ctx('src/a.js', 'src/b.js'))

    assert [b.order for b in blocks] == [0, 1]
    assert [b.category for b in blocks] == ['Dentro A', 'Dentro B']


def test_tu10_without_scope_information_nothing_is_discarded():
    """Un ctx privo di scope_files non ha con cosa confrontare: nessun filtro."""
    raw = _owasp_output([
        {'severity': 'HIGH', 'category': 'Qualsiasi', 'file': 'src/example.js'},
    ])

    assert len(OwaspScanProfile().parse_output(raw, {})[0]) == 1
    assert len(OwaspScanProfile().parse_output(raw)[0]) == 1


@pytest.mark.asyncio
async def test_tu10_loader_publishes_the_scope_for_the_parser():
    """Il filtro di TU_10 regge solo se il loader espone l'ambito: qui si salda."""
    toolset = FakeToolset(nodes=[
        _file_node('src/dentro.js'),
        _file_node('fuori/escluso.js'),
    ])

    ctx = await SecurityLoader().load(
        FakeContextRef(scope_type='FILES', paths=['src/']), toolset
    )

    assert ctx['scope_files'] == ['src/dentro.js']


def test_parse_output_returns_nothing_for_a_clean_scan():
    """Una scansione senza riscontri produce zero blocchi, non un errore."""
    blocks, proposal = OwaspScanProfile().parse_output('{"findings": []}')

    assert blocks == []
    assert proposal is None


def test_parse_output_raises_on_unparsable_model_output():
    """Un output non interpretabile viene segnalato, non silenziosamente ignorato."""
    with pytest.raises(ValueError):
        OwaspScanProfile().parse_output('il modello ha risposto a parole')


# --- SecurityPolicyProfile.parse_output -------------------------------------

def test_policy_parse_output_builds_violation_blocks():
    """Le violazioni di policy conservano regola, file e spiegazione."""
    raw = json.dumps({'findings': [{
        'ruleId': 'POL-007',
        'ruleText': 'Vietato loggare dati personali',
        'filePath': 'src/logger.ts',
        'start_line': 12,
        'end_line': 12,
        'severity': 'high',
        'explanation': 'Il logger stampa l\'email utente.',
        'remediation': {'kind': 'text', 'markdown': 'Rimuovere il campo.'},
    }]})

    blocks, proposal = SecurityPolicyProfile().parse_output(raw)

    assert blocks[0].ruleId == 'POL-007'
    assert blocks[0].ruleText == 'Vietato loggare dati personali'
    assert blocks[0].filePath == 'src/logger.ts'
    assert blocks[0].severity == 'HIGH'
    assert blocks[0].lineStart == 12
    assert proposal is None


def test_policy_parse_output_tolerates_violation_without_line_numbers():
    """Una violazione che riguarda l'intero file non ha righe: e' ammesso."""
    raw = json.dumps({'findings': [{'ruleId': 'POL-001', 'severity': 'LOW'}]})

    blocks, _ = SecurityPolicyProfile().parse_output(raw)

    assert blocks[0].lineStart is None
    assert blocks[0].lineEnd is None


def test_policy_parse_output_normalises_snippet_remediation():
    """Anche per le policy il rimedio a frammento conserva la sua forma."""
    raw = json.dumps({'findings': [{
        'ruleId': 'POL-002',
        'severity': 'MEDIUM',
        'remediation': {'kind': 'SNIPPET', 'language': 'typescript', 'code': 'redact(email)'},
    }]})

    blocks, _ = SecurityPolicyProfile().parse_output(raw)

    assert blocks[0].remediation.kind == 'SNIPPET'
    assert blocks[0].remediation.code == 'redact(email)'


def test_policy_parse_output_uses_placeholder_for_unnamed_rule():
    """Una violazione senza identificativo di regola resta comunque leggibile."""
    raw = json.dumps({'findings': [{'severity': 'LOW'}]})

    blocks, _ = SecurityPolicyProfile().parse_output(raw)

    assert blocks[0].ruleId == 'unknown'
    assert blocks[0].filePath == 'unknown'
