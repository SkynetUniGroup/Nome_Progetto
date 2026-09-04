import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),

  CORS_ORIGIN: Joi.string().uri().required(),

  MONGODB_URI: Joi.string().uri().required(),
  REDIS_URL: Joi.string().uri().required(),

  JWT_SECRET: Joi.string().min(16).required(),
  CREDENTIAL_MASTER_KEY: Joi.string().min(16).required(),
  INTERNAL_SHARED_SECRET: Joi.string().min(16).required(),

  // Anti-replay window (seconds) for HMAC-signed /internal/* requests: a
  // request whose X-Internal-Timestamp is further than this from "now" is
  // rejected, signature notwithstanding (PoC §6.3).
  HMAC_WINDOW_S: Joi.number().default(30),

  // RF.66: Tasks a single user may start per calendar month before
  // POST /tasks starts rejecting with 429 USAGE_LIMIT_EXCEEDED. Lives in
  // config, not the database, so raising it is a redeploy, not a migration.
  MONTHLY_TASK_LIMIT: Joi.number().default(50),

  // Base URL of the Python agent service (BE-15).
  AGENTS_SERVICE_URL: Joi.string().uri().default('http://agents:8000'),

  // BE-20: object storage for exported PDF artifacts. S3_ENDPOINT is
  // optional on purpose — set it to point at MinIO in dev/docker-compose;
  // omit it against real AWS S3, where the SDK resolves the regional
  // endpoint itself from S3_REGION. S3_FORCE_PATH_STYLE must be true for
  // MinIO (it doesn't support virtual-hosted-style addressing the way real
  // S3 does).
  REPORTS_BUCKET_NAME: Joi.string().default('code-guardian-reports'),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_ENDPOINT: Joi.string().uri().optional(),
  S3_FORCE_PATH_STYLE: Joi.boolean().default(false),
  S3_ACCESS_KEY_ID: Joi.string().required(),
  S3_SECRET_ACCESS_KEY: Joi.string().required(),
});
