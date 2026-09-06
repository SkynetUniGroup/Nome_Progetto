import {
  MAX_TEMPLATE_BYTES,
  validaTemplateReadme,
} from './readme-template.validation';

/**
 * RF.80 — il file caricato viene giudicato prima di essere salvato.
 *
 * Ogni caso negativo asserisce anche *cosa* viene detto all'utente: RF.80
 * chiede un messaggio d'errore, e un rifiuto muto lo soddisfarebbe solo
 * all'apparenza.
 */
describe('validaTemplateReadme', () => {
  const contenutoValido = '# {{project_name}}\n\n## Installazione\n';

  /** I byte iniziali di un PNG, scritti per codice: un file binario vero. */
  const intestazionePng =
    String.fromCharCode(0x89) +
    'PNG' +
    String.fromCharCode(0x0d, 0x0a, 0x1a, 0x0a);

  it('accepts a Markdown file with an .md extension', () => {
    expect(validaTemplateReadme('README.template.md', contenutoValido)).toEqual({
      valido: true,
    });
  });

  it('accepts an uppercase extension — .MD is still Markdown', () => {
    expect(validaTemplateReadme('TEMPLATE.MD', contenutoValido).valido).toBe(
      true,
    );
  });

  it('rejects a file whose extension is not .md', () => {
    const esito = validaTemplateReadme('template.txt', contenutoValido);

    expect(esito.valido).toBe(false);
    expect(esito.errore).toContain('.md');
  });

  it('rejects a file with no extension at all', () => {
    expect(validaTemplateReadme('template', contenutoValido).valido).toBe(false);
  });

  it('rejects a name that merely contains .md without ending in it', () => {
    // 'template.md.exe' passerebbe un controllo scritto con includes().
    expect(validaTemplateReadme('template.md.exe', contenutoValido).valido).toBe(
      false,
    );
  });

  it('rejects a missing or blank filename', () => {
    expect(validaTemplateReadme('', contenutoValido).valido).toBe(false);
    expect(validaTemplateReadme('   ', contenutoValido).valido).toBe(false);
  });

  it('rejects a filename carrying a path rather than a name', () => {
    const esito = validaTemplateReadme('../../etc/passwd.md', contenutoValido);

    expect(esito.valido).toBe(false);
    expect(esito.errore).toContain('percorsi');
  });

  it('rejects a Windows-style path too', () => {
    expect(
      validaTemplateReadme('cartella\\template.md', contenutoValido).valido,
    ).toBe(false);
  });

  it('rejects an empty template', () => {
    const esito = validaTemplateReadme('template.md', '   \n\t  ');

    expect(esito.valido).toBe(false);
    expect(esito.errore).toContain('vuoto');
  });

  it('rejects a binary file renamed .md', () => {
    // Il caso concreto: un PNG a cui è stata cambiata l'estensione.
    const esito = validaTemplateReadme(
      'template.md',
      `${intestazionePng}testo`,
    );

    expect(esito.valido).toBe(false);
    expect(esito.errore).toContain('testo');
  });

  it('keeps accepting tabs and newlines, which are legitimate in Markdown', () => {
    expect(
      validaTemplateReadme('t.md', '# Titolo\r\n\t- voce\n\n## Altro\n').valido,
    ).toBe(true);
  });

  it('rejects a template past the size cap', () => {
    const esito = validaTemplateReadme(
      't.md',
      'a'.repeat(MAX_TEMPLATE_BYTES + 1),
    );

    expect(esito.valido).toBe(false);
    expect(esito.errore).toContain('dimensione massima');
  });

  it('accepts a template exactly on the size cap', () => {
    expect(
      validaTemplateReadme('t.md', 'a'.repeat(MAX_TEMPLATE_BYTES)).valido,
    ).toBe(true);
  });

  it('measures the cap in bytes, not characters', () => {
    // Ogni emoji occupa 4 byte: la lunghezza in caratteri sarebbe un quarto
    // del limite, e un controllo su .length lascerebbe passare il file.
    const emoji = '\u{1F600}'.repeat(MAX_TEMPLATE_BYTES / 4 + 1);

    expect(emoji.length).toBeLessThan(MAX_TEMPLATE_BYTES);
    expect(validaTemplateReadme('t.md', emoji).valido).toBe(false);
  });
});
