import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { FRANC } from './../src/contexts/franc.provider';

/**
 * Avvio dell'applicazione e superficie pubblica minima.
 *
 * Questo file conteneva il test generato dallo scaffolding di NestJS —
 * `GET /` che si aspettava "Hello World!" — per un AppController che in
 * questo progetto non esiste: falliva a ogni esecuzione di `test:e2e`.
 * Al suo posto verifica quello che l'applicazione espone davvero.
 */
describe('Avvio dell\'applicazione (e2e)', () => {
  let app: INestApplication<App>;
  let server: App;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // franc-min è ESM-only e viene risolto con un import() dinamico che
      // Jest non sa eseguire (vedi il commento in franc.provider.ts).
      .overrideProvider(FRANC)
      .useValue(() => 'eng')
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix('api/v1');
    await app.init();
    server = app.getHttpServer();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('risponde alla sonda di salute senza autenticazione', async () => {
    // È quello che interroga Docker per sapere se il processo è vivo, prima
    // che un qualsiasi utente abbia mai eseguito il login.
    const risposta = await request(server).get('/api/v1/auth/health').expect(200);

    expect(risposta.body).toEqual({ status: 'ok' });
  });

  it('espone le rotte sotto il prefisso di versione', async () => {
    // Senza prefisso il frontend, che chiama /api/v1, otterrebbe 404 su tutto.
    await request(server).get('/auth/health').expect(404);
  });

  it('rifiuta senza token una rotta protetta', async () => {
    await request(server).get('/api/v1/credentials').expect(401);
  });

  it('rifiuta un token non valido', async () => {
    await request(server)
      .get('/api/v1/credentials')
      .set('Authorization', 'Bearer non-e-un-token')
      .expect(401);
  });

  it('valida il corpo delle richieste secondo i DTO', async () => {
    // whitelist + forbidNonWhitelisted: un campo sconosciuto è un 400, non
    // un campo scartato in silenzio.
    const risposta = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'non-e-una-email', password: '' })
      .expect(400);

    expect(JSON.stringify(risposta.body)).toContain('email');
  });
});
