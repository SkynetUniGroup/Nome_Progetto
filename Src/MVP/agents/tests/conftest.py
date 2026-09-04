"""Configurazione condivisa della suite di test del servizio agenti.

Le impostazioni di `src.config` sono congelate e lette all'import, quindi le
variabili d'ambiente vanno impostate *prima* che qualunque modulo di `src`
venga importato: da qui, non dai singoli test.
"""

import os
from pathlib import Path

import pytest

_AGENTS_ROOT = Path(__file__).resolve().parent.parent

# In esecuzione dentro il container i prompt stanno in /app/prompts; in locale
# stanno accanto al codice. Senza questo, ogni test che carica un template
# fallirebbe con FileNotFoundError.
os.environ.setdefault('PROMPTS_DIR', str(_AGENTS_ROOT / 'prompts'))


class FakeContextRef:
    """Riferimento di contesto minimo, con i soli campi letti dai loader."""

    def __init__(
        self,
        repo_owner: str = 'OWASP',
        repo_name: str = 'NodeGoat',
        resolved_sha: str = 'abc1234',
        scope_type: str = 'FULL_REPOSITORY',
        paths: list | None = None,
    ):
        """Inizializza il riferimento di contesto.

        Args:
            repo_owner (str): Proprietario del repository.
            repo_name (str): Nome del repository.
            resolved_sha (str): SHA del commit risolto.
            scope_type (str): Ambito di analisi.
            paths (list | None): Percorsi selezionati quando l'ambito e' ristretto.
        """
        self.repoOwner = repo_owner
        self.repoName = repo_name
        self.resolvedSha = resolved_sha
        self.scopeType = scope_type
        self.paths = paths if paths is not None else []


class FakeToolset:
    """Sostituto del GitHubToolset che risponde da dati in memoria.

    Registra le chiamate ricevute, cosi' i test possono verificare *cosa* e'
    stato chiesto a GitHub senza aprire nessuna connessione di rete.
    """

    def __init__(self, nodes: list | None = None, files: dict | None = None,
                 issues: list | None = None):
        """Inizializza il toolset fittizio.

        Args:
            nodes (list | None): Nodi dell'albero del repository.
            files (dict | None): Contenuto dei file, indicizzato per percorso.
            issues (list | None): Issue restituite dal sistema di ticketing.
        """
        self.nodes = nodes if nodes is not None else []
        self.files = files if files is not None else {}
        self.issues = issues if issues is not None else []
        self.progress_calls = []
        self.issue_filters = []

    async def read_tree(self, owner, repo, sha):
        """Restituisce l'albero dei file configurato."""
        return {'nodes': self.nodes}

    async def read_file(self, owner, repo, sha, path):
        """Restituisce il contenuto del file richiesto."""
        return {'content': self.files.get(path, '')}

    async def read_issues(self, owner, repo, filters=None):
        """Restituisce le issue configurate, registrando i filtri richiesti."""
        self.issue_filters.append(filters)
        return {'issues': self.issues}

    async def report_progress(self, stage, percent):
        """Registra un avanzamento segnalato al backend."""
        self.progress_calls.append((stage, percent))


@pytest.fixture
def context_ref():
    """Riferimento di contesto sull'intero repository."""
    return FakeContextRef()


@pytest.fixture
def toolset():
    """Toolset fittizio vuoto, da popolare nel singolo test."""
    return FakeToolset()
