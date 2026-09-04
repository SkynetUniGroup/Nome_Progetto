"""Test della facciata GitHub: firma HMAC delle richieste interne e instradamento.

Nessun test apre una connessione: il client HTTP e' sostituito da un doppio
che cattura la richiesta e restituisce la risposta configurata.
"""

import hashlib
import hmac
import json

import pytest

from src import github_toolset as toolset_module
from src.github_toolset import GitHubToolset


SEGRETO = 'segreto-condiviso'


class FakeResponse:
    """Risposta HTTP fittizia."""

    def __init__(self, status_code: int = 200, payload=None, errore: Exception = None):
        """Inizializza la risposta.

        Args:
            status_code (int): Codice di stato restituito.
            payload: Corpo JSON della risposta.
            errore (Exception): Errore sollevato da raise_for_status.
        """
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self._errore = errore

    def raise_for_status(self):
        """Solleva l'errore configurato, se presente."""
        if self._errore:
            raise self._errore

    def json(self):
        """Restituisce il corpo JSON configurato."""
        return self._payload


class FakeClient:
    """Client HTTP fittizio che registra l'ultima richiesta inviata."""

    ultima_richiesta: dict = {}
    risposta = FakeResponse()

    async def __aenter__(self):
        """Entra nel contesto asincrono."""
        return self

    async def __aexit__(self, *args):
        """Esce dal contesto asincrono."""
        return False

    async def post(self, url, content, headers, timeout):
        """Registra la richiesta e restituisce la risposta configurata."""
        FakeClient.ultima_richiesta = {
            'url': url,
            'content': content,
            'headers': headers,
            'timeout': timeout,
        }
        return FakeClient.risposta


@pytest.fixture(autouse=True)
def fake_http(monkeypatch):
    """Sostituisce il client HTTP e le impostazioni di collegamento al backend."""
    FakeClient.ultima_richiesta = {}
    FakeClient.risposta = FakeResponse(payload={'ok': True})
    monkeypatch.setattr(toolset_module.httpx, 'AsyncClient', FakeClient)


@pytest.fixture
def strumenti(monkeypatch):
    """Toolset configurato con un segreto noto e un backend fittizio."""
    monkeypatch.setattr(
        toolset_module,
        'settings',
        type('S', (), {
            'backend_base_url': 'http://backend:3000/',
            'internal_shared_secret': SEGRETO,
        })(),
    )
    return GitHubToolset(user_id='u1', task_id='task-1')


def _firma_attesa(endpoint: str, corpo: str, timestamp: str) -> str:
    """Ricalcola la firma attesa secondo il contratto con il backend."""
    body_hash = hashlib.sha256(corpo.encode('utf-8')).hexdigest()
    messaggio = f'{timestamp}:POST:{endpoint}:{body_hash}'.encode('utf-8')
    return hmac.new(SEGRETO.encode('utf-8'), messaggio, hashlib.sha256).hexdigest()


# --- Firma delle richieste --------------------------------------------------

@pytest.mark.asyncio
async def test_request_signs_the_body_with_the_shared_secret(strumenti):
    """La firma copre corpo, metodo, percorso e istante della richiesta.

    E' il controllo che impedisce a chiunque non conosca il segreto di
    chiamare gli endpoint interni del backend.
    """
    await strumenti.read_tree('OWASP', 'NodeGoat', 'abc1234')

    richiesta = FakeClient.ultima_richiesta
    timestamp = richiesta['headers']['X-Internal-Timestamp']
    attesa = _firma_attesa('/internal/github/tree', richiesta['content'], timestamp)
    assert richiesta['headers']['X-Internal-Signature'] == attesa


@pytest.mark.asyncio
async def test_request_signature_changes_with_the_body(strumenti):
    """Corpi diversi producono firme diverse: il corpo non e' alterabile."""
    await strumenti.read_file('OWASP', 'NodeGoat', 'abc', 'a.js')
    prima = FakeClient.ultima_richiesta['headers']['X-Internal-Signature']

    await strumenti.read_file('OWASP', 'NodeGoat', 'abc', 'b.js')
    seconda = FakeClient.ultima_richiesta['headers']['X-Internal-Signature']

    assert prima != seconda


@pytest.mark.asyncio
async def test_request_sends_the_exact_body_that_was_signed(strumenti):
    """Il corpo trasmesso e' identico a quello su cui si e' calcolato l'hash.

    Se il client riserializzasse il JSON (anche solo cambiando gli spazi) la
    verifica lato backend fallirebbe.
    """
    await strumenti.read_tree('OWASP', 'NodeGoat', 'abc1234')

    corpo = FakeClient.ultima_richiesta['content']
    assert corpo == json.dumps(json.loads(corpo), separators=(',', ':'))


@pytest.mark.asyncio
async def test_request_declares_a_json_content_type(strumenti):
    """La richiesta si dichiara come JSON."""
    await strumenti.read_tree('OWASP', 'NodeGoat', 'abc1234')

    assert FakeClient.ultima_richiesta['headers']['Content-Type'] == 'application/json'


@pytest.mark.asyncio
async def test_request_sets_a_finite_timeout(strumenti):
    """La chiamata al backend non puo' restare appesa a tempo indefinito."""
    await strumenti.read_tree('OWASP', 'NodeGoat', 'abc1234')

    assert FakeClient.ultima_richiesta['timeout'] == 30.0


# --- Instradamento e payload ------------------------------------------------

@pytest.mark.asyncio
async def test_read_tree_targets_the_tree_endpoint(strumenti):
    """La lettura dell'albero raggiunge l'endpoint dedicato con i suoi parametri."""
    await strumenti.read_tree('OWASP', 'NodeGoat', 'abc1234')

    richiesta = FakeClient.ultima_richiesta
    assert richiesta['url'] == 'http://backend:3000/internal/github/tree'
    assert json.loads(richiesta['content']) == {
        'taskId': 'task-1',
        'userId': 'u1',
        'owner': 'OWASP',
        'repo': 'NodeGoat',
        'sha': 'abc1234',
    }


@pytest.mark.asyncio
async def test_read_file_includes_the_requested_path(strumenti):
    """La lettura di un file trasporta il percorso richiesto."""
    await strumenti.read_file('OWASP', 'NodeGoat', 'abc1234', 'app/server.js')

    richiesta = FakeClient.ultima_richiesta
    assert richiesta['url'].endswith('/internal/github/file')
    assert json.loads(richiesta['content'])['path'] == 'app/server.js'


@pytest.mark.asyncio
async def test_read_issues_forwards_the_filters(strumenti):
    """I filtri sulle issue vengono inoltrati al backend."""
    await strumenti.read_issues('OWASP', 'NodeGoat', {'state': 'closed'})

    assert json.loads(FakeClient.ultima_richiesta['content'])['filter'] == {'state': 'closed'}


@pytest.mark.asyncio
async def test_read_issues_defaults_to_no_filter(strumenti):
    """Senza filtri viene inviato un oggetto vuoto, non un valore nullo."""
    await strumenti.read_issues('OWASP', 'NodeGoat')

    assert json.loads(FakeClient.ultima_richiesta['content'])['filter'] == {}


@pytest.mark.asyncio
async def test_report_progress_targets_the_task_progress_endpoint(strumenti):
    """L'avanzamento viene inviato all'endpoint della specifica task."""
    await strumenti.report_progress(stage='analisi', percent=40)

    richiesta = FakeClient.ultima_richiesta
    assert richiesta['url'].endswith('/internal/tasks/task-1/progress')
    assert json.loads(richiesta['content']) == {'stage': 'analisi', 'percent': 40}


@pytest.mark.asyncio
async def test_base_url_trailing_slash_does_not_double_up(strumenti):
    """Uno slash finale nella configurazione non produce un doppio slash."""
    await strumenti.read_tree('OWASP', 'NodeGoat', 'abc')

    assert '//internal' not in FakeClient.ultima_richiesta['url']


# --- Risposte del backend ---------------------------------------------------

@pytest.mark.asyncio
async def test_request_returns_the_decoded_payload(strumenti):
    """Il corpo della risposta viene restituito al chiamante."""
    FakeClient.risposta = FakeResponse(payload={'nodes': [{'path': 'a.js'}]})

    risultato = await strumenti.read_tree('OWASP', 'NodeGoat', 'abc')

    assert risultato == {'nodes': [{'path': 'a.js'}]}


@pytest.mark.asyncio
async def test_request_returns_empty_dict_on_no_content(strumenti):
    """Una risposta 204 non ha corpo: si restituisce un oggetto vuoto."""
    FakeClient.risposta = FakeResponse(status_code=204)

    risultato = await strumenti.report_progress(stage='fine', percent=100)

    assert risultato is None


@pytest.mark.asyncio
async def test_request_propagates_backend_errors(strumenti):
    """Un errore del backend non viene mascherato da una risposta vuota."""
    FakeClient.risposta = FakeResponse(errore=RuntimeError('403 Forbidden'))

    with pytest.raises(RuntimeError):
        await strumenti.read_tree('OWASP', 'NodeGoat', 'abc')
