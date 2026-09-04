"""Changelog Agent -- CHANGELOG_TECHNICAL operation.

Reads issues from GitHub, discards invalid ones, and generates a technical changelog.
"""

import re
from typing import Any, List, Optional, Tuple

from langgraph.types import interrupt

from ..github_toolset import GitHubToolset
from ..models import Block, ChangelogItemBlock, Proposal, TextBlock
from ..config import settings
from ._base import load_prompt_template, render_prompt


class ReadabilityTooLowError(Exception):
    """Specific exception mapped to ErrorKind.READABILITY_TOO_LOW."""

    def __init__(self, message: str):
        """Initializes the exception.

        Args:
            message (str): The error message.
        """
        self.error_type = 'READABILITY_TOO_LOW'
        super().__init__(message)


class ChangelogLoader:
    """Loads issues from GitHub, filters invalid ones, and prepares the changelog context."""

    def __init__(self, operation: str = 'CHANGELOG_TECHNICAL'):
        """Initializes the loader.

        Args:
            operation (str): The operation code. Defaults to 'CHANGELOG_TECHNICAL'.
        """
        self.operation = operation

    async def load(
        self, context_ref: Any, toolset: GitHubToolset, agent_payload: dict = None
    ) -> dict:
        """Loads the context for the changelog agent.

        Args:
            context_ref (Any): The context reference containing repo details.
            toolset (GitHubToolset): The toolset to interact with GitHub.
            agent_payload (dict, optional): The payload containing agent parameters.
                Defaults to None.

        Returns:
            dict: The loaded context containing sprint details and tasks.

        Raises:
            AgentCancelled: If the user cancels the operation during the interactive prompt.
        """
        if agent_payload is None:
            agent_payload = {}
        sprint_id = agent_payload.get('sprintId', 'Current Sprint')

        issues_response = await toolset.read_issues(
            context_ref.repoOwner, context_ref.repoName, {'state': 'closed'}
        )
        issues = issues_response.get('issues', [])

        kept_tasks, excluded_tasks, insufficient_ids = [], [], []

        for issue in issues:
            if sprint_id != 'Current Sprint' and issue.get('milestone') != sprint_id:
                continue

            issue_num = str(issue.get('number'))
            if not issue.get('hasSufficientMetadata', True):
                excluded_tasks.append(f'#{issue_num} {issue.get("title")}')
                insufficient_ids.append(issue_num)
            else:
                labels = issue.get('labels', '')
                url = (
                    f'https://github.com/{context_ref.repoOwner}/'
                    f'{context_ref.repoName}/issues/{issue_num}'
                )
                kept_tasks.append(
                    f'- [#{issue_num}]({url}) {issue.get("title")} (Labels: {labels})'
                )

        # Interactive suspension
        if insufficient_ids:
            action = interrupt({
                'kind': 'INCOMPLETE_TASKS',
                'taskIds': insufficient_ids
            })
            
            if action == 'CANCEL':
                # Imported here and not at module level: graph.py imports
                # ReadabilityTooLowError from this module, so a top-level import
                # of graph closes an import cycle that makes both modules
                # unimportable, whichever one is loaded first.
                from ..graph import AgentCancelled

                # NOTE: According to MVP specs, NestJS handles user cancellation
                # by terminating the task without resuming the graph. This branch is defensive
                # and guarantees graceful abortion during tests, debug, or manual API usage.
                raise AgentCancelled(stage='INCOMPLETE_TASKS')

        return {
            'sprint_id': sprint_id,
            'tasks_formatted': '\n'.join(kept_tasks) if kept_tasks else 'No valid issues.',
            'excluded_tasks': excluded_tasks,
            'phase': 'TECHNICAL'
        }


class ChangelogTechnicalProfile:
    """Handles the prompt generation and parsing for the Technical Changelog."""

    agent = 'changelog'
    operation = 'CHANGELOG_TECHNICAL'
    uses_tools = False

    def build_prompt(self, ctx: dict) -> Tuple[str, str]:
        """Builds the prompt using the context data.

        Args:
            ctx (dict): The context dictionary.

        Returns:
            Tuple[str, str]: The system and user prompts.
        """
        template_data = load_prompt_template('changelog', 'changelog_tech')
        return render_prompt(
            template_data,
            sprint_id=ctx['sprint_id'],
            tasks=ctx['tasks_formatted']
        )

    def parse_output(self, raw: str, ctx: dict) -> Tuple[List[Block], Optional[Proposal]]:
        """Parses the raw output from the model into structured blocks.

        Args:
            raw (str): The raw string output from the model.
            ctx (dict): The context dictionary.

        Returns:
            Tuple[List[Block], Optional[Proposal]]: A tuple containing the list of blocks
                and an optional proposal.
        """
        blocks: List[Block] = [TextBlock(order=0, markdown=raw.strip())]
        excluded = ctx.get('excluded_tasks', [])
        
        if excluded:
            for idx, exc in enumerate(excluded):
                issue_ref = exc.split()[0] if exc.startswith('#') else f'Task {idx}'
                blocks.append(
                    ChangelogItemBlock(
                        order=idx + 1,
                        issueRef=issue_ref,
                        title=exc,
                        detail='Excluded from changelog due to insufficient metadata.'
                    )
                )
        return blocks, None


class ChangelogBusinessProfile:
    """Handles the prompt generation and parsing for the Business Changelog."""

    agent = 'changelog'
    operation = 'CHANGELOG_BUSINESS'
    uses_tools = False

    def build_prompt(self, ctx: dict) -> Tuple[str, str]:
        """Builds the prompt depending on the current phase (TECHNICAL or BUSINESS).

        Args:
            ctx (dict): The context dictionary.

        Returns:
            Tuple[str, str]: The system and user prompts.
        """
        phase = ctx.get('phase', 'TECHNICAL')

        if phase == 'TECHNICAL':
            template_data = load_prompt_template('changelog', 'changelog_tech')
            return render_prompt(
                template_data,
                sprint_id=ctx.get('sprint_id', 'Current Sprint'),
                tasks=ctx.get('tasks_formatted', 'No valid issues.')
            )
        else:
            template_data = load_prompt_template('changelog', 'changelog_biz')
            return render_prompt(
                template_data,
                technical_changelog=ctx.get('technical_text', ''),
            )

    def parse_output(
        self, raw: str, ctx: dict
    ) -> Tuple[List[Block], Optional[Proposal], bool]:
        """Parses the output and handles the multi-phase business changelog generation.

        Args:
            raw (str): The raw string output from the model.
            ctx (dict): The context dictionary.

        Returns:
            Tuple[List[Block], Optional[Proposal], bool]: A tuple containing the blocks,
                an optional proposal, and a boolean indicating if a next phase is needed.

        Raises:
            AgentCancelled: If the user cancels the confirmation phase.
            ValueError: If the readability score is too low, triggering a retry.
        """
        if ctx.get('phase', 'TECHNICAL') == 'TECHNICAL':
            # Phase 1: Parse the technical output
            blocks: List[Block] = [TextBlock(order=0, markdown=raw.strip())]

            excluded = ctx.get('excluded_tasks', [])
            if excluded:
                for idx, exc in enumerate(excluded):
                    issue_ref = exc.split()[0] if exc.startswith('#') else f'Task {idx}'
                    blocks.append(
                        ChangelogItemBlock(
                            order=idx + 1,
                            issueRef=issue_ref,
                            title=exc,
                            detail='Excluded from changelog due to insufficient metadata.'
                        )
                    )

            ctx['technical_text'] = raw.strip()
            ctx['phase'] = 'BUSINESS'

            # Phase 2: Return True to indicate the need for the next phase
            return blocks, None, True

        else:
            # BUSINESS PHASE: Flesch Reading Ease logic
            score = calculate_flesch_reading_ease(raw)
            TARGET_SCORE = settings.changelog_min_readability

            if score < TARGET_SCORE:
                raise ValueError(
                    f'READABILITY_RETRY: Score {score:.1f} is too low (Target: {TARGET_SCORE}).'
                )

            blocks = [TextBlock(order=1, markdown=raw.strip())]
            return blocks, None, False


def calculate_flesch_reading_ease(text: str) -> float:
    """Calculates the Flesch Reading Ease index.

    A value > 50.0 is generally considered acceptable for business comprehension.

    Args:
        text (str): The text to analyze.

    Returns:
        float: The calculated Flesch Reading Ease score.
    """
    if not text.strip():
        return 0.0

    # Clean Markdown to avoid altering the count
    clean_text = re.sub(r'[*_#`>\-\[\]()]+', ' ', text)

    # Sentence count (approximated by strong punctuation)
    sentences = len(re.split(r'[.!?]+', clean_text)) - 1
    sentences = max(1, sentences)

    # Word count
    words = clean_text.split()
    num_words = max(1, len(words))

    # Heuristic syllable count (based on vowel groups, flexible for ITA/ENG)
    vowels = 'aeiouyàèéìíòóùú'
    syllables = 0
    for word in words:
        word = word.lower()
        word_syllables = len(re.findall(f'[{vowels}]+', word))
        syllables += max(1, word_syllables)

    # Standard Flesch formula
    fre = 206.835 - 1.015 * (num_words / sentences) - 84.6 * (syllables / num_words)
    return fre