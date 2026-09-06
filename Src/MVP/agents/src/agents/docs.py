"""Docs Agent -- DOCS_INLINE operation.

Finds undocumented code, queries the LLM, and produces a diff Proposal.
"""

import difflib
import re
from pathlib import Path
from typing import Any, List, Optional, Tuple

from ..config import settings
from ..github_toolset import GitHubToolset
from ..models import Block, ComplexityWarningBlock, Proposal, TextBlock
from ._base import extract_json, load_prompt_template, render_prompt


class DocsLoader:
    """Loads the initial context from GitHub via NestJS asynchronously."""

    def __init__(self, operation: str = 'DOCS_INLINE'):
        """Initializes the loader.

        Args:
            operation (str): The operation code. Defaults to 'DOCS_INLINE'.
        """
        self.operation = operation

    def _find_target_units(self, content: str, filepath: str) -> List[str]:
        """Local pre-analysis to identify functions/classes for documentation or alignment check.

        Args:
            content (str): The file content.
            filepath (str): The path of the file.

        Returns:
            List[str]: A list of strings describing target units and their current status.
        """
        lines = content.split('\n')
        targets = []

        if filepath.endswith('.py'):
            for i, line in enumerate(lines):
                stripped = line.strip()
                if stripped.startswith('def ') or stripped.startswith('class '):
                    has_doc = False
                    for j in range(i + 1, min(i + 4, len(lines))):
                        next_line = lines[j].strip()
                        if next_line:
                            if next_line.startswith('"""') or next_line.startswith("'''"):
                                has_doc = True
                            break

                    match = re.search(r'(def|class)\s+([a-zA-Z0-9_]+)', line)
                    if match:
                        status = 'documented, verify alignment' if has_doc else 'undocumented'
                        targets.append(f"Line {i+1}: {match.group(2)} ({status})")
        else:
            ts_pattern = (
                r'(function\s+[a-zA-Z0-9_]+|class\s+[a-zA-Z0-9_]+|'
                r'const\s+[a-zA-Z0-9_]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>)'
            )
            for i, line in enumerate(lines):
                if re.search(ts_pattern, line):
                    has_doc = False
                    for j in range(i - 1, max(i - 4, -1), -1):
                        prev_line = lines[j].strip()
                        if prev_line:
                            if prev_line.endswith('*/') or prev_line.startswith('//'):
                                has_doc = True
                            break

                    match = re.search(r'(?:function|class|const)\s+([a-zA-Z0-9_]+)', line)
                    if match:
                        status = 'documented, verify alignment' if has_doc else 'undocumented'
                        targets.append(f"Line {i+1}: {match.group(1)} ({status})")

        return targets

    def _find_undocumented_endpoints(self, content: str, filepath: str) -> List[str]:
        """Local pre-analysis to identify EXCLUSIVELY undocumented API routes/endpoints.

        Args:
            content (str): The file content.
            filepath (str): The path of the file.

        Returns:
            List[str]: A list of strings describing undocumented endpoints.
        """
        lines = content.split('\n')
        undocumented = []

        if filepath.endswith('.py'):
            # FastAPI / Flask decorators
            endpoint_pattern = re.compile(
                r'^\s*@([a-zA-Z0-9_]+\.)?(get|post|put|delete|patch|route)\b'
            )
        else:
            # NestJS or Express decorators/methods
            endpoint_pattern = re.compile(
                r'^\s*(@(Get|Post|Put|Delete|Patch|All)\b|'
                r'([a-zA-Z0-9_]+\.)?(get|post|put|delete|patch)\()'
            )

        for i, line in enumerate(lines):
            if endpoint_pattern.search(line):
                has_doc = False

                for j in range(max(0, i - 3), min(len(lines), i + 4)):
                    line_check = lines[j].strip()
                    if (line_check.startswith('/**') or 
                        line_check.startswith('"""') or 
                        line_check.startswith("'''")):
                        has_doc = True
                        break

                if not has_doc:
                    unit_name = f'Endpoint at line {i+1}: {line.strip()}'
                    for j in range(i, min(i + 4, len(lines))):
                        func_match = re.search(
                            r'(?:def|async def|function|const|class)\s+([a-zA-Z0-9_]+)', lines[j]
                        )
                        if func_match:
                            unit_name = f'Endpoint \'{func_match.group(1)}\' (line {i+1})'
                            break
                    undocumented.append(unit_name)

        return undocumented

    async def load(
        self, context_ref: Any, toolset: GitHubToolset, agent_payload: dict = None
    ) -> dict:
        """Loads the context based on the current operation type.

        Args:
            context_ref (Any): The context reference.
            toolset (GitHubToolset): The toolset to interact with GitHub.
            agent_payload (dict, optional): The payload from the agent. Defaults to None.

        Returns:
            dict: The loaded context details.
        """
        owner = context_ref.repoOwner
        repo = context_ref.repoName
        sha = context_ref.resolvedSha
        scope_type = getattr(context_ref, 'scopeType', 'FULL_REPOSITORY')
        paths = getattr(context_ref, 'paths', [])

        tree_response = await toolset.read_tree(owner, repo, sha)
        nodes = tree_response.get('nodes', [])

        package_json = 'Not found.'
        readme = 'Not found.'
        readme_path = 'README.md'

        for n in nodes:
            if n['path'].lower() == 'package.json':
                resp = await toolset.read_file(owner, repo, sha, n['path'])
                package_json = resp.get('content', 'Not found.')
            elif n['path'].lower() == 'readme.md':
                resp = await toolset.read_file(owner, repo, sha, n['path'])
                readme = resp.get('content', 'Not found.')
                readme_path = n['path']

        # Optimized path for DOCS_README
        if self.operation == 'DOCS_README':
            tree_str = 'Repository file tree:\n' + '\n'.join([n['path'] for n in nodes])
            await toolset.report_progress(stage='docs_context_loaded', percent=30)
            return {
                'language': 'markdown',
                'code_units': tree_str,
                'package_json': package_json,
                'readme': readme,
                'original_readme': readme,
                'readme_path': readme_path,
                # RF.79: il template personalizzato dell'utente, se ne ha
                # caricato uno. Arriva nel payload di avvio invece che da
                # GitHub perche' appartiene all'utente, non al repository:
                # lo stesso template vale per tutti i progetti che analizza.
                # Assente significa "usa il modello di default" (RF.81), che
                # e' esattamente cio' che build_prompt fa senza questo campo.
                'readme_template': (agent_payload or {}).get('readmeTemplate'),
            }

        # Original path for DOCS_INLINE and DOCS_API
        supported_exts = ('.ts', '.js', '.py')
        files_to_doc = []
        for n in nodes:
            if n['type'] == 'file' and n['path'].endswith(supported_exts):
                if scope_type == 'FULL_REPOSITORY' or any(n['path'].startswith(p) for p in paths):
                    files_to_doc.append(n['path'])

        undocumented_summary = []
        for path in files_to_doc:
            file_resp = await toolset.read_file(owner, repo, sha, path)
            content = file_resp.get('content', '')
            if content:
                if self.operation == 'DOCS_API':
                    units = self._find_undocumented_endpoints(content, path)
                else:
                    units = self._find_target_units(content, path)

                if units:
                    summary_text = (
                        f'### File: {path} ###\n```\n{content}\n```\n'
                        f'Units to process: {", ".join(units)}\n'
                    )
                    undocumented_summary.append(summary_text)

        if not undocumented_summary:
            tree_str = 'No units found to document or verify.'
        else:
            tree_str = (
                'Source code (IGNORE the read_file tool):\n\n' +
                '\n\n'.join(undocumented_summary)
            )

        await toolset.report_progress(stage='docs_context_loaded', percent=30)

        return {
            'code_units': tree_str,
            'package_json': package_json,
            'readme': readme
        }


class BaseDocsDiffProfile:
    """Base profile for Docs agents generating diff proposals."""

    agent = 'docs'
    uses_tools = False

    def __init__(self):
        """Initializes the profile."""
        self._ctx = {}

    def parse_output(self, raw: str, ctx: dict = None) -> Tuple[List[Block], Optional[Proposal]]:
        """Parses the raw model output.

        Args:
            raw (str): The raw string output from the model.

        Returns:
            Tuple[List[Block], Optional[Proposal]]: The parsed blocks and diff proposal.
        """
        return self._shared_docs_parser(raw)

    def _shared_docs_parser(self, raw: str) -> Tuple[List[Block], Optional[Proposal]]:
        """Shared parser for Proposal (unified diff) and Warning generation.

        Args:
            raw (str): The raw string output from the model.

        Returns:
            Tuple[List[Block], Optional[Proposal]]: The parsed blocks and diff proposal.
        """
        data = extract_json(raw)
        blocks: List[Block] = []
        order = 0

        for w in data.get('warnings', []):
            file_path = w.get('file', 'unknown')
            line_num = w.get('line', 1)
            message = w.get('message', 'Excessive complexity')

            blocks.append(
                ComplexityWarningBlock(
                    order=order,
                    filePath=file_path,
                    lineStart=line_num,
                    lineEnd=line_num,
                    reason=message
                )
            )
            order += 1

        docs_list = data.get('docs', [])

        if not docs_list:
            return blocks, None

        docs_by_file = {}
        for d in docs_list:
            f = d.get('file', 'unknown_file')
            if f not in docs_by_file:
                docs_by_file[f] = []
            docs_by_file[f].append(d)

        diff_unified = ''
        for f, items in docs_by_file.items():
            diff_unified += f'--- a/{f}\n+++ b/{f}\n'
            for item in items:
                line = item.get('line', 1)
                doc_text = item.get('doc', '')
                doc_lines = doc_text.splitlines()
                num_lines = len(doc_lines)

                diff_unified += f'@@ -{line},0 +{line},{num_lines} @@\n'
                for doc_line in doc_lines:
                    diff_unified += f'+{doc_line}\n'

        files_involved = list(docs_by_file.keys())
        target_path = files_involved[0] if len(files_involved) == 1 else 'Multi-file scope'

        proposal = Proposal(
            targetPath=target_path,
            diffUnified=diff_unified,
            language='auto'
        )

        return blocks, proposal


class DocsInlineProfile(BaseDocsDiffProfile):
    """Handles prompt and output parsing for the Docs agent (Inline Documentation)."""

    operation = 'DOCS_INLINE'

    def build_prompt(self, ctx: dict) -> Tuple[str, str]:
        """Builds the system and user prompts.

        Args:
            ctx (dict): The context containing languages and code units.

        Returns:
            Tuple[str, str]: The generated prompts.
        """
        self._ctx = ctx
        template_data = load_prompt_template('docs', 'inline_docs')

        return render_prompt(
            template_data,
            code_units=ctx['code_units'],
            package_json=ctx.get('package_json', 'Not found.'),
            readme=ctx.get('readme', 'Not found.')
        )


class DocsApiProfile(BaseDocsDiffProfile):
    """Handles prompt and parsing for the Docs agent (API Endpoints Documentation)."""

    operation = 'DOCS_API'

    def build_prompt(self, ctx: dict) -> Tuple[str, str]:
        """Builds the system and user prompts using the API-specific template.

        Args:
            ctx (dict): The context containing languages and code units.

        Returns:
            Tuple[str, str]: The generated prompts.
        """
        self._ctx = ctx
        template_data = load_prompt_template('docs', 'api_docs')

        return render_prompt(
            template_data,
            code_units=ctx['code_units'],
            package_json=ctx.get('package_json', 'Not found.'),
            readme=ctx.get('readme', 'Not found.')
        )


class DocsReadmeProfile:
    """Handles prompt and diff calculation for the Docs agent (DOCS_README)."""

    agent = 'docs'
    operation = 'DOCS_README'
    uses_tools = False

    def __init__(self):
        """Initializes the profile."""
        self._ctx = {}

    def build_prompt(self, ctx: dict) -> Tuple[str, str]:
        """Builds the system and user prompts incorporating the existing README.

        Args:
            ctx (dict): The context containing languages and code units.

        Returns:
            Tuple[str, str]: The generated prompts.
        """
        self._ctx = ctx
        template_data = load_prompt_template('docs', 'readme_docs')

        # RF.79/RF.81: vince il template caricato dall'utente; senza, si
        # ricade sul modello di default dell'agente. Il ripristino previsto
        # da RF.81 non e' quindi un'operazione a se': togliere il template
        # personalizzato riporta l'agente su questo ramo.
        readme_template = (ctx.get('readme_template') or '').strip()

        if not readme_template:
            template_path = (
                Path(settings.prompts_dir) / 'docs' / 'default_readme_template.md'
            )
            if template_path.exists():
                with open(template_path, 'r', encoding='utf-8') as f:
                    readme_template = f.read()
            else:
                readme_template = '# README\n\nNo default template found.'

        return render_prompt(
            template_data,
            tree=ctx['code_units'],
            package_json=ctx.get('package_json', 'Not found.'),
            readme=ctx.get('readme', 'Not found.'),
            template=readme_template
        )

    def parse_output(self, raw: str, ctx: dict = None) -> Tuple[List[Block], Optional[Proposal]]:
        """Parses the raw output and calculates the unified diff against the original README.

        Args:
            raw (str): The raw string output from the model.
            ctx (dict, optional): The context containing additional information.

        Returns:
            Tuple[List[Block], Optional[Proposal]]: The parsed blocks and diff proposal.
        """
        new_readme = raw.strip()
        match = re.search(r'^```(?:markdown|md)?\s*(.*?)\s*```$', new_readme, re.DOTALL)
        if match:
            new_readme = match.group(1).strip()

        original_readme = self._ctx.get('original_readme', 'Not found.')
        if original_readme == 'Not found.':
            original_readme = ''

        readme_path = self._ctx.get('readme_path', 'README.md')

        original_lines = original_readme.splitlines(keepends=True)
        new_lines = new_readme.splitlines(keepends=True)

        from_file = f'a/{readme_path}' if original_readme else '/dev/null'
        to_file = f'b/{readme_path}'

        diff = ''.join(difflib.unified_diff(
            original_lines,
            new_lines,
            fromfile=from_file,
            tofile=to_file,
            n=3
        ))

        if not diff:
            blocks = [
                TextBlock(
                    order=0,
                    markdown='The analyzed README is already optimal. No changes proposed.'
                )
            ]
            return blocks, None

        proposal = Proposal(
            targetPath=readme_path,
            diffUnified=diff,
            language='markdown'
        )

        blocks = [
            TextBlock(
                order=0,
                markdown='README successfully generated or updated. Check the attached diff proposal.'
            )
        ]
        return blocks, proposal