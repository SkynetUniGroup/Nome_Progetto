// Costanti condivise tra gli stack.

export const REGION = "eu-south-1"; // Milano, data residency

export const PROJECT_TAGS = {
  Project: "CodeGuardian",
  Environment: "mvp",
};

export const VPC_CIDR = "10.0.0.0/16";
export const AZ_COUNT = 2;

export const ECS_SIZING = {
  backend: { cpu: 512, memoryLimitMiB: 1024, desiredCount: 1, port: 3000 },
  agents: { cpu: 1024, memoryLimitMiB: 2048, desiredCount: 1, port: 8000 },
};

export const HEALTH_CHECK_GRACE_PERIOD_SECONDS = 60; // evita restart-loop in avvio

export const ALB_IDLE_TIMEOUT_SECONDS = 3600; // necessario per WebSocket
export const ALB_STICKINESS_DURATION_SECONDS = 3600;
export const ALB_DEREGISTRATION_DELAY_SECONDS = 30;
export const HEALTH_CHECK_PATH = "/health";

export const CLOUD_MAP_NAMESPACE = "codeguardian.local";
export const CLOUD_MAP_DNS_TTL_SECONDS = 10;

export const ECR_REPOS = {
  backend: "codeguardian/backend",
  agents: "codeguardian/agents",
};
export const ECR_MAX_TAGGED_IMAGES = 20;
export const ECR_UNTAGGED_MAX_AGE_DAYS = 1;

export const BEDROCK_MODEL_ARN_PATTERN = `arn:aws:bedrock:${REGION}::foundation-model/qwen.*`;

export const REDIS_PORT = 6379;

export const ATLAS_MONGO_PORT = 27017;

export const ARTIFACTS_LIFECYCLE_EXPIRATION_DAYS = 30;

export const BUDGET_THRESHOLDS_PERCENT = [50, 80, 100];

export const RATE_LIMIT_GITHUB_RPM = 60; // rate limiter applicativo su Redis

export const SNS_ALERTS_TOPIC_NAME = "codeguardian-alerts";
