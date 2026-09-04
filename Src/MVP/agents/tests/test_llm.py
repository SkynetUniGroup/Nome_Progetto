"""Test della selezione del provider LLM e della traduzione dei suoi errori.

Nessun test contatta un modello reale: le classi di LangChain sono sostituite
da doppi che registrano gli argomenti ricevuti o sollevano l'errore voluto.
"""

import pytest
from types import SimpleNamespace

from src import llm as llm_module
from src.llm import BedrockProvider, ManagedAPIProvider, RateLimitError, get_llm_provider


class FakeChatModel:
    """Modello fittizio che registra la configurazione ricevuta."""

    ultima_configurazione: dict = {}

    def __init__(self, **kwargs):
        """Registra i parametri di costruzione."""
        FakeChatModel.ultima_configurazione = kwargs
        self.errore = None
        self.bound_tools = None

    def bind_tools(self, tools):
        """Registra gli strumenti collegati e restituisce se stesso."""
        self.bound_tools = tools
        return self

    async def ainvoke(self, messages, **kwargs):
        """Restituisce una risposta fittizia o solleva l'errore configurato."""
        if self.errore:
            raise self.errore
        return type('Risposta', (), {'content': 'risposta del modello'})()


class FakeSettings(SimpleNamespace):
    """Impostazioni mutabili.

    L'oggetto `Settings` reale e' congelato da pydantic e non e' quindi
    modificabile dai test: viene sostituito in blocco, non per attributo.
    """

    def require_llm_key(self):
        """Restituisce una chiave fittizia, senza leggere l'ambiente."""
        return 'chiave-di-prova'


IMPOSTAZIONI = FakeSettings()


@pytest.fixture(autouse=True)
def fake_models(monkeypatch):
    """Sostituisce le implementazioni di LangChain e le impostazioni globali."""
    global IMPOSTAZIONI
    IMPOSTAZIONI = FakeSettings(
        llm_provider='qwen',
        llm_base_url='https://esempio.invalid/v1',
        max_output_tokens=4096,
        aws_region='eu-south-1',
    )
    monkeypatch.setattr(llm_module, 'ChatOpenAI', FakeChatModel)
    monkeypatch.setattr(llm_module, 'ChatBedrockConverse', FakeChatModel)
    monkeypatch.setattr(llm_module, 'settings', IMPOSTAZIONI)


# --- Scelta del provider ----------------------------------------------------

def test_get_llm_provider_returns_bedrock_when_configured(monkeypatch):
    """Con provider 'bedrock' viene istanziata l'implementazione AWS."""
    IMPOSTAZIONI.llm_provider = 'bedrock'

    provider = get_llm_provider(model='claude')

    assert isinstance(provider, BedrockProvider)


def test_get_llm_provider_is_case_insensitive(monkeypatch):
    """Il nome del provider viene confrontato senza distinzione di maiuscole."""
    IMPOSTAZIONI.llm_provider = 'BEDROCK'

    provider = get_llm_provider(model='claude')

    assert isinstance(provider, BedrockProvider)


def test_get_llm_provider_falls_back_to_managed_api(monkeypatch):
    """Qualunque altro valore seleziona il provider su API gestita."""
    IMPOSTAZIONI.llm_provider = 'qwen'

    provider = get_llm_provider(model='qwen3-32b')

    assert isinstance(provider, ManagedAPIProvider)


# --- Configurazione del modello ---------------------------------------------

def test_managed_provider_passes_model_and_limits(monkeypatch):
    """Modello, chiave e tetto di token arrivano al client sottostante."""
    IMPOSTAZIONI.llm_provider = 'qwen'

    get_llm_provider(model='qwen3-32b', max_tokens=1234)

    config = FakeChatModel.ultima_configurazione
    assert config['model'] == 'qwen3-32b'
    assert config['max_tokens'] == 1234
    assert config['api_key'] == 'chiave-di-prova'


def test_managed_provider_omits_temperature_when_not_requested(monkeypatch):
    """Senza temperatura esplicita si lascia il valore predefinito del modello."""
    IMPOSTAZIONI.llm_provider = 'qwen'

    get_llm_provider(model='qwen3-32b')

    assert 'temperature' not in FakeChatModel.ultima_configurazione


def test_managed_provider_forwards_explicit_temperature(monkeypatch):
    """Una temperatura indicata viene inoltrata al modello."""
    IMPOSTAZIONI.llm_provider = 'qwen'

    get_llm_provider(model='qwen3-32b', temperature=0.1)

    assert FakeChatModel.ultima_configurazione['temperature'] == 0.1


def test_bedrock_provider_passes_region_and_model_id(monkeypatch):
    """Bedrock riceve la regione configurata e l'identificativo del modello."""
    IMPOSTAZIONI.llm_provider = 'bedrock'
    IMPOSTAZIONI.aws_region = 'eu-south-1'

    get_llm_provider(model='anthropic.claude-v2')

    config = FakeChatModel.ultima_configurazione
    assert config['region_name'] == 'eu-south-1'
    assert config['model_id'] == 'anthropic.claude-v2'


# --- Invocazione ------------------------------------------------------------

@pytest.mark.asyncio
async def test_managed_provider_binds_the_tools_it_is_given(monkeypatch):
    """Gli strumenti passati vengono collegati al modello prima dell'invocazione."""
    IMPOSTAZIONI.llm_provider = 'qwen'
    provider = get_llm_provider(model='qwen3-32b')
    strumenti = ['read_file']

    await provider.invoke_agent([], strumenti, timeout_s=30)

    assert provider.llm.bound_tools == strumenti


@pytest.mark.asyncio
async def test_managed_provider_completes_a_plain_prompt(monkeypatch):
    """Il completamento restituisce il testo prodotto dal modello."""
    IMPOSTAZIONI.llm_provider = 'qwen'
    provider = get_llm_provider(model='qwen3-32b')

    risposta = await provider.complete('Riassumi.', timeout_s=30)

    assert risposta == 'risposta del modello'


@pytest.mark.asyncio
async def test_bedrock_provider_invokes_without_tools(monkeypatch):
    """Senza strumenti il modello viene invocato direttamente."""
    IMPOSTAZIONI.llm_provider = 'bedrock'
    provider = get_llm_provider(model='claude')

    await provider.invoke_agent([], [], timeout_s=30)

    assert provider.llm.bound_tools is None


# --- Traduzione degli errori ------------------------------------------------

@pytest.mark.asyncio
async def test_managed_provider_translates_rate_limit_by_status_code(monkeypatch):
    """Un 429 diventa un errore di rate limit riconoscibile dal chiamante."""
    IMPOSTAZIONI.llm_provider = 'qwen'
    provider = get_llm_provider(model='qwen3-32b')
    provider.llm.errore = RuntimeError('richiesta rifiutata: 429 Too Many Requests')

    with pytest.raises(RateLimitError):
        await provider.invoke_agent([], [], timeout_s=30)


@pytest.mark.asyncio
async def test_managed_provider_reraises_other_errors_untouched(monkeypatch):
    """Un guasto diverso dal rate limit non viene mascherato."""
    IMPOSTAZIONI.llm_provider = 'qwen'
    provider = get_llm_provider(model='qwen3-32b')
    provider.llm.errore = RuntimeError('connessione interrotta')

    with pytest.raises(RuntimeError) as exc:
        await provider.invoke_agent([], [], timeout_s=30)

    assert not isinstance(exc.value, RateLimitError)


@pytest.mark.asyncio
async def test_managed_provider_translates_rate_limit_on_completion(monkeypatch):
    """Anche il completamento semplice riconosce il rate limit."""
    IMPOSTAZIONI.llm_provider = 'qwen'
    provider = get_llm_provider(model='qwen3-32b')
    provider.llm.errore = RuntimeError('429')

    with pytest.raises(RateLimitError):
        await provider.complete('Riassumi.', timeout_s=30)


@pytest.mark.asyncio
async def test_bedrock_provider_translates_throttling_to_rate_limit(monkeypatch):
    """Il ThrottlingException di AWS diventa lo stesso errore di rate limit."""
    IMPOSTAZIONI.llm_provider = 'bedrock'
    provider = get_llm_provider(model='claude')
    errore = llm_module.botocore.exceptions.ClientError(
        {'Error': {'Code': 'ThrottlingException', 'Message': 'troppe richieste'}}, 'Converse'
    )
    provider.llm.errore = errore

    with pytest.raises(RateLimitError):
        await provider.invoke_agent([], [], timeout_s=30)


@pytest.mark.asyncio
async def test_bedrock_provider_wraps_generic_failures(monkeypatch):
    """Un guasto generico di Bedrock viene riportato con un messaggio chiaro."""
    IMPOSTAZIONI.llm_provider = 'bedrock'
    provider = get_llm_provider(model='claude')
    provider.llm.errore = RuntimeError('endpoint irraggiungibile')

    with pytest.raises(RuntimeError) as exc:
        await provider.invoke_agent([], [], timeout_s=30)

    assert 'AWS Bedrock invocation failed' in str(exc.value)


@pytest.mark.asyncio
async def test_bedrock_provider_wraps_failures_on_completion(monkeypatch):
    """La stessa traduzione vale per il completamento semplice."""
    IMPOSTAZIONI.llm_provider = 'bedrock'
    provider = get_llm_provider(model='claude')
    provider.llm.errore = RuntimeError('endpoint irraggiungibile')

    with pytest.raises(RuntimeError) as exc:
        await provider.complete('Riassumi.', timeout_s=30)

    assert 'AWS Bedrock invocation failed' in str(exc.value)
