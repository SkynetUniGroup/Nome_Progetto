import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { GithubClientService } from './../src/github/github-client.service';
import { FRANC } from './../src/contexts/franc.provider';
import { AgentInvocationService } from './../src/tasks/agent-invocation.service';
import { Task, TaskDocument } from './../src/tasks/schemas/task.schema';
import { Report, ReportDocument } from './../src/reports/schemas/report.schema';

/**
 * TI_05 (Piano di Qualifica) — ciclo di vita completo di una task contro lo
 * stack applicativo reale.
 *
 * Gira il vero AppModule contro un vero MongoDB e un vero Redis (quelli di
 * `docker compose up -d mongodb redis`). Sono sostituiti solo i due confini
 * effettivamente esterni al sistema: GitHub e il servizio agenti Python.
 * Tutto il resto — validazione, guardie, persistenza, instradamento
 * dell'Orchestratore, assemblaggio del Report — è il codice di produzione.
 *
 * Percorso verificato: registrazione → credenziale → contesto → task →
 * instradamento all'agente → esecuzione → Report persistito e leggibile.
 */

const REPO_URL = 'https://github.com/OWASP/NodeGoat';

/** Alberatura minima che il resolver del contesto si aspetta da GitHub. */
const ALBERO = [
  { path: 'app/data/user-dao.js', type: 'file' as const, sizeBytes: 2048 },
  { path: 'app/routes/session.js', type: 'file' as const, sizeBytes: 1024 },
];

describe('TI_05 — ciclo di vita della task (stack reale)', () => {
  let app: INestApplication<App>;
  let server: App;
  let taskModel: Model<TaskDocument>;
  let reportModel: Model<ReportDocument>;

  /** Doppio del servizio agenti: risponde come farebbe un agente riuscito. */
  const agente = {
    invoke: jest.fn(),
    resume: jest.fn(),
  };

  /** Doppio di GitHub: nessuna chiamata di rete, risposte deterministiche. */
  const github = {
    verifyToken: jest.fn().mockResolvedValue({ scopes: ['repo'], login: 'utente-di-prova' }),
    listRepositories: jest.fn().mockResolvedValue([
      {
        owner: 'OWASP',
        name: 'NodeGoat',
        isPrivate: false,
        defaultBranch: 'master',
        primaryLanguage: 'JavaScript',
      },
    ]),
    getRepository: jest.fn().mockResolvedValue({
      owner: 'OWASP',
      name: 'NodeGoat',
      isPrivate: false,
      defaultBranch: 'master',
      primaryLanguage: 'JavaScript',
    }),
    resolveRefToSha: jest.fn().mockResolvedValue('abc1234567890'),
    getTree: jest.fn().mockResolvedValue(ALBERO),
    getFileContent: jest.fn().mockResolvedValue({
      path: 'app/data/user-dao.js',
      content: 'function login() {}',
      sha: 'file-sha',
      language: 'JavaScript',
    }),
    getReadme: jest.fn().mockResolvedValue(null),
    listRefs: jest.fn().mockResolvedValue({
      branches: [{ name: 'master', sha: 'abc1234567890' }],
      tags: [],
    }),
    listIssues: jest.fn().mockResolvedValue([]),
    getIssueDetail: jest.fn(),
  };

  /** Registra un utente e apre una sessione, restituendo il token. */
  async function utenteAutenticato(role = 'SECURITY_AUDITOR') {
    const email = `ti05-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@esempio.invalid`;
    const password = 'password-di-prova-123';
    await request(server)
      .post('/api/v1/auth/register')
      .send({ firstName: 'Ada', lastName: 'Lovelace', email, password, role })
      .expect(201);

    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    return login.body.accessToken as string;
  }

  /**
   * Attende che la task raggiunga uno stato terminale.
   *
   * Il worker BullMQ registrato dall'AppModule consuma la coda da solo: il
   * test non deve invocare il processore a mano — lo farebbe in corsa con
   * lui — ma osservare l'esito del percorso reale.
   */
  async function attendiEsito(taskId: string, timeoutMs = 20_000) {
    const scadenza = Date.now() + timeoutMs;
    while (Date.now() < scadenza) {
      const task = await taskModel.findById(taskId);
      if (task && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`La task ${taskId} non ha raggiunto uno stato terminale in ${timeoutMs}ms`);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GithubClientService)
      .useValue(github)
      .overrideProvider(AgentInvocationService)
      .useValue(agente)
      // franc-min è ESM-only e viene risolto con un import() dinamico, che
      // Jest non sa eseguire senza --experimental-vm-modules (lo dichiara il
      // commento in franc.provider.ts). È una libreria di terze parti per il
      // riconoscimento della lingua: sostituirla non tocca la logica in esame.
      .overrideProvider(FRANC)
      .useValue(() => 'eng')
      .compile();

    app = moduleFixture.createNestApplication();
    // Le stesse impostazioni di main.ts: senza, i DTO non verrebbero
    // validati e il test non eserciterebbe il contratto reale.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix('api/v1');
    await app.init();

    server = app.getHttpServer();
    taskModel = app.get<Model<TaskDocument>>(getModelToken(Task.name));
    reportModel = app.get<Model<ReportDocument>>(getModelToken(Report.name));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    agente.invoke.mockReset();
    agente.resume.mockReset();
  });

  it('porta una task da creazione a Report persistito', async () => {
    const token = await utenteAutenticato();

    // 1. Credenziale: il backend la verifica contro GitHub prima di salvarla.
    await request(server)
      .post('/api/v1/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'GITHUB', token: 'ghp_token_di_prova_0123456789' })
      .expect(201);

    // 2. Contesto di analisi.
    const contesto = await request(server)
      .post('/api/v1/contexts')
      .set('Authorization', `Bearer ${token}`)
      .send({ repoUrl: REPO_URL, branch: 'master', scopeType: 'FULL_REPOSITORY' })
      .expect(201);

    expect(contesto.body.id).toBeDefined();
    expect(contesto.body.resolvedSha).toBe('abc1234567890');

    // 3. Avvio della task: l'Orchestratore instrada l'operazione.
    // La forma è quella di AgentInvocationResult, il contratto che il
    // servizio espone al processore, non la risposta HTTP grezza
    // dell'agente che il servizio stesso traduce.
    agente.invoke.mockResolvedValue({
      status: 'COMPLETED',
      payload: {
        body: [
          {
            kind: 'FINDING',
            category: 'A03:2021 Injection',
            severity: 'HIGH',
            filePath: 'app/data/user-dao.js',
            startLine: 12,
            endLine: 14,
            explanation: 'Query costruita per concatenazione di stringhe.',
            remediationKind: 'TEXT',
            remediation: 'Usare query parametrizzate.',
          },
        ],
        summary: 'Trovata 1 vulnerabilità.',
        tokensConsumed: 350,
      },
    });

    const avvio = await request(server)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ contextId: contesto.body.id, operations: ['SECURITY_OWASP'] })
      .expect(202);

    const [taskId] = avvio.body.taskIds;
    expect(taskId).toBeDefined();

    // 4. La task è persistita su Mongo, associata all'operazione richiesta.
    const salvata = await taskModel.findById(taskId);
    expect(salvata).not.toBeNull();
    expect(salvata!.operation).toBe('SECURITY_OWASP');

    // 5. Esecuzione: il worker della coda prende in carico la task.
    const conclusa = await attendiEsito(taskId);

    // 6. L'agente è stato interpellato una volta sola, per quella task.
    expect(agente.invoke).toHaveBeenCalledTimes(1);

    // 7. La task è conclusa e il Report è persistito.
    // L'errore viene incluso nel confronto: un fallimento qui è molto più
    // rapido da diagnosticare sapendo *cosa* è andato storto.
    expect({ status: conclusa.status, error: conclusa.error }).toMatchObject({
      status: 'COMPLETED',
    });
    expect(conclusa.reportId).toBeDefined();

    const salvato = await reportModel.findById(conclusa.reportId);
    expect(salvato).not.toBeNull();

    // 8. Il Report è leggibile dalle API, dal suo proprietario.
    const letto = await request(server)
      .get(`/api/v1/reports/${conclusa.reportId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(letto.body.operation).toBe('SECURITY_OWASP');
    expect(letto.body.status).toBe('COMPLETED');
    expect(letto.body.body).toHaveLength(1);
  }, 120_000);

  it('un fallimento dell\'agente produce un Report FAILED, non un errore muto', async () => {
    const token = await utenteAutenticato();
    await request(server)
      .post('/api/v1/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'GITHUB', token: 'ghp_token_di_prova_0123456789' })
      .expect(201);
    const contesto = await request(server)
      .post('/api/v1/contexts')
      .set('Authorization', `Bearer ${token}`)
      .send({ repoUrl: REPO_URL, branch: 'master', scopeType: 'FULL_REPOSITORY' })
      .expect(201);

    agente.invoke.mockResolvedValue({
      status: 'FAILED',
      error: { code: 'TIMEOUT', message: 'nessuna risposta dal modello', stage: 'invoca_llm' },
    });

    const avvio = await request(server)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ contextId: contesto.body.id, operations: ['SECURITY_OWASP'] })
      .expect(202);
    const [taskId] = avvio.body.taskIds;

    const conclusa = await attendiEsito(taskId);

    expect(conclusa.status).toBe('FAILED');
    expect(conclusa.error).toBeDefined();
  }, 120_000);

  it('un report di un altro utente non è leggibile', async () => {
    const proprietario = await utenteAutenticato();
    const estraneo = await utenteAutenticato();
    await request(server)
      .post('/api/v1/credentials')
      .set('Authorization', `Bearer ${proprietario}`)
      .send({ provider: 'GITHUB', token: 'ghp_token_di_prova_0123456789' })
      .expect(201);
    const contesto = await request(server)
      .post('/api/v1/contexts')
      .set('Authorization', `Bearer ${proprietario}`)
      .send({ repoUrl: REPO_URL, branch: 'master', scopeType: 'FULL_REPOSITORY' })
      .expect(201);
    agente.invoke.mockResolvedValue({
      status: 'COMPLETED',
      payload: { body: [], summary: 'ok' },
    });
    const avvio = await request(server)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${proprietario}`)
      .send({ contextId: contesto.body.id, operations: ['SECURITY_OWASP'] })
      .expect(202);
    const conclusa = await attendiEsito(avvio.body.taskIds[0]);

    await request(server)
      .get(`/api/v1/reports/${conclusa.reportId}`)
      .set('Authorization', `Bearer ${estraneo}`)
      .expect(404);
  }, 120_000);
});
