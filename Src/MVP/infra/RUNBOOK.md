# RUNBOOK -- Attività manuali (non automatizzabili in CDK)

Queste attività non hanno un equivalente CloudFormation/CDK affidabile (richieste
soggette ad approvazione umana, generazione di chiavi fuori banda, conferme
via email) e vanno eseguite a mano, nell'ordine indicato. Ogni punto riporta
il riferimento al documento di progettazione.

## 1. Richiesta accesso modelli Bedrock (scadenza issue: 22/08)

Rif. §27.1, §32.1 Tabella 32.

Questa è la prima cosa da avviare: i tempi di approvazione AWS non sono
controllabili dal team.

1. Console AWS Bedrock -> regione **eu-south-1** (Milano) -> *Model access*.
2. Richiedere accesso a:
   - **Qwen3-32B** (dense) -- Docs, Changelog. Priorità alta.
   - **Qwen3-Coder-30B-A3B-Instruct** -- Security. Priorità alta.
   - **Qwen3-235B-A22B** -- fallback di scalata (§39.5). Priorità media, ma
     richiederla comunque subito: serve se il modello da 30B non supera il
     Piano di Qualifica sul golden set (RQ.5, accuratezza ≥ 85%).
3. Verificare in anticipo l'assenza di Service Control Policy (SCP)
   organizzative che blocchino Bedrock nell'account.
4. Verificare in console (sezione *Model access* / *Cross-region inference*)
   se i modelli Qwen3 richiedono un **Inference Profile ARN** invece
   dell'ARN diretto del foundation model per l'invocazione on-demand. Se sì,
   aggiornare `BEDROCK_MODEL_ARN_PATTERN` in `lib/config.ts` e la policy IAM
   in `lib/compute-stack.ts` (`InvokeQwenModelsOnly`) di conseguenza --
   l'errore tipico in caso di mismatch è `ValidationException: Invocation of
   model ID ... is not supported`.

## 2. MongoDB Atlas -- handshake manuale prima di `cdk deploy CodeGuardian-Atlas`

Rif. §27.4, §31.1.

Project e cluster M10 sono creati e gestiti a mano nella console Atlas
(nessuna API key con permessi di scrittura sul progetto è disponibile per il
team): `lib/atlas-stack.ts` crea solo il lato AWS del PrivateLink.

1. **Chi gestisce Atlas** (Alessandro) crea il Private Endpoint dal progetto
   Atlas esistente, regione AWS **eu-south-1**, e comunica il service name
   generato (`com.amazonaws.vpce-svc-...`).
2. Deployare passando quel service name:
   ```bash
   npx cdk deploy CodeGuardian-Atlas --context atlasPrivateEndpointServiceName=<SERVICE_NAME>
   ```
3. Recuperare l'output `AtlasPrivateEndpointId` e comunicarlo a chi gestisce
   Atlas: va incollato in console Atlas (Private Endpoint -> AWS) per
   completare il collegamento.
4. **Azione Dev post-collegamento (§27.4 punto 4, §31.1):** da console Atlas
   -> Connect -> Private Endpoint, recuperare la connection string generata e
   aggiornarla nel secret:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id codeguardian/mongo-uri \
     --secret-string '<connection-string-del-private-endpoint>'
   ```
   Verificare la connettività dal task backend prima di considerare questo
   punto completato. La Network Access List di Atlas non deve contenere
   alcuna entry pubblica (0.0.0.0/0 o IP): è l'assenza di entry pubbliche,
   combinata con la connettività PrivateLink attiva, a restringere l'accesso
   al solo VPC.

## 3. GitHub Actions -- secrets del repository

Rif. `.github/workflows/deploy.yml`.

Nel repository GitHub (Settings -> Secrets and variables -> Actions),
aggiungere:

| Secret                      | Valore                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `AWS_ACCOUNT_ID`             | ID account AWS (12 cifre) dove è deployata l'infrastruttura     |
| `FRONTEND_BUCKET_NAME`       | Output `FrontendBucketName` di `CodeGuardian-CloudFront`       |
| `CLOUDFRONT_DISTRIBUTION_ID` | Output `DistributionId` di `CodeGuardian-CloudFront`            |

Aggiornare inoltre `githubOrg`/`githubRepo` in `cdk.json` (o via
`--context`) con i valori reali PRIMA di deployare `CodeGuardian-CicdIdentity`,
altrimenti il trust policy del ruolo OIDC punterà a un repository segnaposto.

Il trust policy del ruolo accetta token OIDC da qualunque branch/ref del
repository indicato. Le pull request possono quindi tecnicamente assumere il
ruolo, ma nella pipeline (`.github/workflows/deploy.yml`) non lo fanno mai:
gli step che richiedono AWS sono condizionati a `push` su `main`. Sulle PR
girano solo typecheck e build Docker locale.

## 4. Conferma sottoscrizione email SNS (scadenza issue: 30/08)

Rif. §27.9 punto 3.

Dopo `cdk deploy CodeGuardian-Observability`, l'indirizzo email indicato in
`alertEmail` (`cdk.json` o `--context alertEmail=...`) riceve una mail di
conferma da AWS SNS. **Se nessuno clicca il link, gli allarmi non verranno
mai recapitati** e il problema resta invisibile finché non serve davvero.
Verificare lo stato `Confirmed` in console SNS -> Subscriptions.

## 5. Primo push manuale immagini ECR (scadenza issue: 24/08)

Rif. §27.5 punto 4. Prima che la pipeline CI/CD esista, per validare il
flusso:

```bash
aws ecr get-login-password --region eu-south-1 | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.eu-south-1.amazonaws.com

docker build -t <ACCOUNT_ID>.dkr.ecr.eu-south-1.amazonaws.com/codeguardian/backend:latest backend/
docker push <ACCOUNT_ID>.dkr.ecr.eu-south-1.amazonaws.com/codeguardian/backend:latest

docker build -t <ACCOUNT_ID>.dkr.ecr.eu-south-1.amazonaws.com/codeguardian/agents:latest agents/
docker push <ACCOUNT_ID>.dkr.ecr.eu-south-1.amazonaws.com/codeguardian/agents:latest
```

## 6. Bootstrap di us-east-1 (prerequisito per `CodeGuardian-Budget`)

`AWS::Budgets::Budget` esiste come risorsa CloudFormation solo nella regione
us-east-1 (AWS Budgets è un servizio globale, come IAM o CloudFront) --
`lib/budget-stack.ts` deploya lì a prescindere da dove vive il resto
dell'infrastruttura. Prima del primo `cdk deploy CodeGuardian-Budget`,
bootstrappare anche quella regione:

```bash
npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
```

## 7. Attivazione del cost allocation tag (prerequisito per AWS Budgets)

Rif. §36.2. Il budget CDK (`budget-stack.ts`) filtra i costi con
`costFilters: { TagKeyValue: ["user:Project$CodeGuardian"] }`. Perché questo
filtro funzioni, il tag `Project` deve prima essere **attivato come Cost
Allocation Tag** in Billing and Cost Management -> Cost Allocation Tags
(operazione manuale, non esiste un'API/risorsa CloudFormation per attivarlo).
Impiega fino a 24 ore per riflettersi nei dati di costo. Finché non è
attivato, il budget mostrerà una spesa pari a zero anche con risorse
correttamente taggate.

## 8. Stima costi e AWS Budgets (scadenza issue: 30/08)

Rif. §36.2. Usare **AWS Pricing Calculator** con i parametri di questo
documento: 1 NAT Gateway, 1 nodo ElastiCache, 8 VPC Endpoint Interface (+
Atlas PrivateLink), Compute ECS (Tabella 26). Il costo del cluster MongoDB
Atlas M10 è **fatturato separatamente da MongoDB** (non compare in AWS Cost
Explorer/Budgets): sommarlo manualmente alla stima e monitorarlo a parte in
console Atlas. Aggiornare `monthlyBudgetUsd` in `cdk.json` con la cifra
concordata dal team prima di deployare `CodeGuardian-Budget`.
