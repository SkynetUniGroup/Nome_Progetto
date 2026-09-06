import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TextBlockRenderer } from './TextBlockRenderer';
import { FindingBlockRenderer } from './FindingBlockRenderer';
import { PolicyViolationRenderer } from './PolicyViolationRenderer';
import { ProposalRenderer } from './ProposalRenderer';
import type { FindingBlock, PolicyViolationBlock, Proposal, Severity } from '../../types';

function finding(over: Partial<FindingBlock> = {}): FindingBlock {
  return {
    kind: 'finding',
    order: 1,
    owaspCategory: 'A03:2021 – Injection',
    severity: 'critical',
    filePath: 'app/data/user-dao.js',
    startLine: 42,
    endLine: 45,
    explanation: 'Query costruita per concatenazione di stringhe.',
    remediation: 'Usare query parametrizzate.',
    ...over,
  };
}

function violazione(over: Partial<PolicyViolationBlock> = {}): PolicyViolationBlock {
  return {
    kind: 'policy_violation',
    order: 1,
    ruleId: 'POL-007',
    ruleText: 'Vietato loggare dati personali',
    filePath: 'src/logger.ts',
    explanation: 'Il logger stampa l\'email utente.',
    remediation: 'Rimuovere il campo email dal log.',
    ...over,
  };
}

const PROPOSTA: Proposal = {
  targetPath: 'src/utils/date.ts',
  diffUnified: '--- a/src/utils/date.ts\n+++ b/src/utils/date.ts\n+/** Formatta una data. */',
  language: 'typescript',
};

describe('TextBlockRenderer', () => {
  it('mostra il contenuto testuale del blocco', () => {
    render(<TextBlockRenderer block={{ kind: 'text', order: 1, markdown: '## Sintesi' }} />);

    expect(screen.getByText('## Sintesi')).toBeInTheDocument();
  });

  it('preserva gli a capo del testo', () => {
    const markdown = 'Prima riga\nSeconda riga';
    const { container } = render(
      <TextBlockRenderer block={{ kind: 'text', order: 1, markdown }} />,
    );

    // Il testo, non il nome della classe CSS che lo impagina: asserire
    // 'whitespace-pre-wrap' si rompeva a ogni ritocco estetico e passava
    // comunque se gli a capo non fossero stati preservati.
    const pre = container.querySelector('pre')!;
    expect(pre.textContent).toBe(markdown);
  });
});

describe('FindingBlockRenderer', () => {
  it('mostra sempre categoria, gravita\' e posizione nel codice', () => {
    render(<FindingBlockRenderer block={finding()} />);

    expect(screen.getByText('A03:2021 – Injection')).toBeInTheDocument();
    expect(screen.getByText('Critico')).toBeInTheDocument();
    expect(screen.getByText('app/data/user-dao.js · righe 42–45')).toBeInTheDocument();
  });

  it('tiene chiusi i dettagli finche\' non vengono richiesti', () => {
    render(<FindingBlockRenderer block={finding()} />);

    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Query costruita per concatenazione di stringhe.')).not.toBeInTheDocument();
  });

  it('espande spiegazione e rimedio suggerito al click', async () => {
    render(<FindingBlockRenderer block={finding()} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button'));

    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Query costruita per concatenazione di stringhe.')).toBeInTheDocument();
    expect(screen.getByText('Usare query parametrizzate.')).toBeInTheDocument();
  });

  it('richiude i dettagli a un secondo click', async () => {
    render(<FindingBlockRenderer block={finding()} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('button'));

    expect(screen.queryByText('Usare query parametrizzate.')).not.toBeInTheDocument();
  });

  const GRAVITA: [Severity, string][] = [
    ['critical', 'Critico'],
    ['high', 'Alto'],
    ['medium', 'Medio'],
    ['low', 'Basso'],
    ['info', 'Info'],
  ];

  it.each(GRAVITA)('etichetta la gravita\' %s come "%s"', (severity, etichetta) => {
    render(<FindingBlockRenderer block={finding({ severity })} />);

    expect(screen.getByText(etichetta)).toBeInTheDocument();
  });
});

describe('PolicyViolationRenderer', () => {
  it('mostra regola infranta e file interessato', () => {
    render(<PolicyViolationRenderer block={violazione()} />);

    expect(screen.getByText('POL-007')).toBeInTheDocument();
    expect(screen.getByText('Vietato loggare dati personali')).toBeInTheDocument();
    expect(screen.getByText('src/logger.ts')).toBeInTheDocument();
  });

  it('espande spiegazione e rimedio al click', async () => {
    render(<PolicyViolationRenderer block={violazione()} />);
    const user = userEvent.setup();
    expect(screen.queryByText('Il logger stampa l\'email utente.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button'));

    expect(screen.getByText('Il logger stampa l\'email utente.')).toBeInTheDocument();
    expect(screen.getByText('Rimuovere il campo email dal log.')).toBeInTheDocument();
  });

  it('richiude i dettagli a un secondo click', async () => {
    render(<PolicyViolationRenderer block={violazione()} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('button'));

    expect(screen.queryByText('Rimuovere il campo email dal log.')).not.toBeInTheDocument();
  });
});

describe('ProposalRenderer', () => {
  it('mostra il file oggetto della proposta', () => {
    render(<ProposalRenderer proposal={PROPOSTA} />);

    expect(screen.getByText('src/utils/date.ts')).toBeInTheDocument();
  });

  it('tiene nascosto il diff finche\' non viene richiesto', () => {
    render(<ProposalRenderer proposal={PROPOSTA} />);

    expect(screen.getByRole('button', { name: /Mostra diff/ })).toBeInTheDocument();
    expect(screen.queryByText(/\+\/\*\* Formatta una data/)).not.toBeInTheDocument();
  });

  it('mostra e poi nasconde il diff, cambiando l\'etichetta del comando', async () => {
    render(<ProposalRenderer proposal={PROPOSTA} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Mostra diff/ }));
    expect(screen.getByText(/Formatta una data/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Nascondi diff/ }));
    expect(screen.queryByText(/Formatta una data/)).not.toBeInTheDocument();
  });

  it('espone il collegamento alla Pull Request quando l\'agente l\'ha aperta', () => {
    render(<ProposalRenderer proposal={{ ...PROPOSTA, prUrl: 'https://github.com/o/r/pull/7' }} />);

    const collegamento = screen.getByRole('link', { name: /Vedi PR/ });
    expect(collegamento).toHaveAttribute('href', 'https://github.com/o/r/pull/7');
    expect(collegamento).toHaveAttribute('target', '_blank');
    // rel=noreferrer: la pagina di destinazione non deve poter manipolare
    // la finestra di origine.
    expect(collegamento).toHaveAttribute('rel', 'noreferrer');
  });

  it('senza Pull Request aperta non mostra alcun collegamento', () => {
    render(<ProposalRenderer proposal={PROPOSTA} />);

    expect(screen.queryByRole('link', { name: /Vedi PR/ })).not.toBeInTheDocument();
  });
});
