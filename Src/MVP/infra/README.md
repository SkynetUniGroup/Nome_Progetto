# Code Guardian -- Infrastruttura AWS (MVP)

Infrastruttura AWS come codice (AWS CDK v2, TypeScript) per l'MVP di Code
Guardian, regione **eu-south-1** (Milano). Implementa la Parte IV-V del
documento di progettazione: stessa topologia di rete, stessi Security Group,
stesso dimensionamento ECS, stesse decisioni architetturali.

Le immagini Docker di `backend` e `agents` sono quelle validate nel PoC:
questa infrastruttura non richiede modifiche al codice applicativo, solo
variabili d'ambiente e permessi IAM al posto delle chiavi statiche del PoC.

Due particolarità di questa infrastruttura, per chi la legge per la prima
volta:

- Il bucket frontend statico nasce in `cloudfront-stack.ts`, non in
  `storage-stack.ts` insieme a quello degli artefatti -- tenerlo separato
  dalla distribuzione CloudFront che lo serve creerebbe una dipendenza
  circolare nota tra i due stack.
- `CodeGuardian-Budget` è l'unico stack che deploya in **us-east-1** anziché
  eu-south-1: `AWS::Budgets::Budget` esiste come risorsa CloudFormation solo
  lì, essendo AWS Budgets un servizio globale.

## Prerequisiti

1. Node.js ≥ 20, AWS CLI configurato con credenziali sull'account target.
2. Attività manuali propedeutiche: vedi **`RUNBOOK.md`** (richiesta accesso
   Bedrock, chiavi Atlas, secrets GitHub Actions, conferma SNS).
3. Aggiornare `cdk.json` (`context`) con i valori reali del progetto:
   `atlasPrivateEndpointServiceName`, `alertEmail`, `githubOrg`/`githubRepo`,
   `monthlyBudgetUsd`.

## Quick start

```bash
npm install
npx cdk bootstrap aws://<ACCOUNT_ID>/eu-south-1
npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1  # solo per CodeGuardian-Budget
npm run synth      # verifica che tutti gli stack sintetizzino correttamente
npm run deploy:all # oppure uno stack alla volta, vedi package.json "scripts"
```

Deploy incrementale nell'ordine di dipendenza tecnica (equivalente a
`deploy:all`, utile per isolare un errore in una fase specifica):

```bash
npm run deploy:network
npm run deploy:cicd-identity
npm run deploy:secrets
npm run deploy:storage
npm run deploy:security-groups
npm run deploy:vpc-endpoints
npm run deploy:data
npm run deploy:atlas          # richiede --context atlasPrivateEndpointServiceName=<...>, vedi RUNBOOK.md
npm run deploy:compute
npm run deploy:cloudfront
npm run deploy:observability
npm run deploy:budget         # deploya in us-east-1, richiede il bootstrap lì
```

Dopo il primo deploy completo, seguire i punti 4 e 5 del `RUNBOOK.md`
(conferma sottoscrizione email SNS, primo push immagini ECR) prima di
considerare l'ambiente operativo.

## Struttura

```
bin/codeguardian.ts          -- entry point CDK, wiring tra gli stack
lib/config.ts                -- costanti condivise (CIDR, porte, sizing...)
lib/network-stack.ts          -- VPC, subnet, IGW, NAT
lib/security-groups-stack.ts  -- Security Group (pattern anti-ciclo)
lib/vpc-endpoints-stack.ts    -- VPC Endpoints Gateway + Interface
lib/kms-secrets-stack.ts      -- KMS, Secrets Manager, Parameter Store
lib/storage-stack.ts          -- Bucket S3 artefatti
lib/data-stack.ts             -- ElastiCache Redis
lib/atlas-stack.ts            -- MongoDB Atlas, lato AWS del PrivateLink (project/cluster gestiti a mano)
lib/cicd-identity-stack.ts    -- ECR + ruolo CI/CD (GitHub OIDC)
lib/compute-stack.ts          -- ECS Fargate, Task Def, IAM, Cloud Map, ALB
lib/cloudfront-stack.ts       -- Bucket S3 frontend + CloudFront + OAC + routing SPA
lib/observability-stack.ts    -- SNS, allarmi CloudWatch
lib/budget-stack.ts           -- AWS Budgets (us-east-1)
.github/workflows/deploy.yml  -- pipeline CI/CD
RUNBOOK.md                    -- attività manuali (Bedrock, Atlas, SNS...)
```

## Pipeline CI/CD

`.github/workflows/deploy.yml` gira in due modalità:

- **Pull request**: solo typecheck del codice CDK (`tsc --noEmit`) e build
  Docker locale delle due immagini, come smoke test. Nessuna credenziale AWS
  coinvolta.
- **Push su `main`**: build + push immagini su ECR, `cdk synth` come gate
  pre-deploy, poi deploy dello stack Compute e del frontend.

Il trust policy OIDC del ruolo `codeguardian-ci-role` accetta token da
qualunque branch/ref del repository; è il workflow stesso, con delle
condizioni `if` sui singoli step, a restringere l'uso delle credenziali AWS
al solo push su `main`. Volendo un limite anche a livello di trust policy, si
può aggiungere una condizione `StringLike` sul claim `sub` in
`cicd-identity-stack.ts`.

## Debug (ECS Exec)

I servizi `backend` e `agents` hanno `enableExecuteCommand: true`: l'accesso
shell ai container per il debug passa da AWS Systems Manager Session
Manager, senza bastion host né chiavi SSH:

```bash
aws ecs execute-command --cluster codeguardian-cluster --task <TASK_ID> \
  --container backend --interactive --command "/bin/sh"
```

## Integrazione con frontend/backend/agenti

- **Frontend**: build Vite con `VITE_API_BASE_URL=/api/v1` (path relativo,
  Same-Origin dietro CloudFront -- nessuna configurazione CORS), sync sul
  bucket frontend (output `FrontendBucketName` di `CodeGuardian-CloudFront`),
  invalidazione via lo stesso stack (output `DistributionId`).
- **Backend**: legge `MONGO_URI`, `JWT_SECRET`, `CREDENTIAL_MASTER_KEY`,
  `INTERNAL_SHARED_SECRET`, `REDIS_URL` da variabili d'ambiente (iniettate da
  ECS via Secrets Manager/Parameter Store) -- nessun cambio di codice
  richiesto rispetto al PoC.
- **Agenti**: legge `INTERNAL_SHARED_SECRET`, `BACKEND_BASE_URL`
  (`http://backend.codeguardian.local:3000`), `LLM_PROVIDER=bedrock`;
  invoca Bedrock tramite il Task Role (nessuna chiave API), scope limitato
  alla famiglia Qwen3 in eu-south-1.
