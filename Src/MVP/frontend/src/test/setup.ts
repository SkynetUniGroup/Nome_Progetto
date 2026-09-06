import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom non implementa Blob.prototype.text(), che invece esiste in tutti i
// browser che l'applicazione supporta ed e' come TemplatePage legge il file
// scelto dall'utente (RF.79). Senza questa aggiunta i test di quella pagina
// fallirebbero per una lacuna dell'ambiente, non del codice.
// Da rimuovere quando jsdom lo fornira' da se'.
if (typeof Blob !== 'undefined' && typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function leggiComeTesto(this: Blob): Promise<string> {
    return new Promise((risolvi, rifiuta) => {
      const lettore = new FileReader();
      lettore.onload = () => risolvi(String(lettore.result));
      lettore.onerror = () => rifiuta(lettore.error);
      lettore.readAsText(this);
    });
  };
}

// Smonta i componenti renderizzati e pulisce sessionStorage dopo ogni test,
// cosi' che lo stato (es. jwt_token) non trapeli da un test al successivo.
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
