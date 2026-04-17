# LocalStack Development Server Plan

## Project Overview

This project is a **SAM-based serverless pipeline** (ClickUp Developer & Team Reporting System) that syncs ClickUp tasks to MongoDB, generates reports, and writes them to Google Sheets. The stack uses the following AWS services that need local emulation:

| AWS Service | Usage |
|---|---|
| **Lambda** (6 functions) | clickup-sync, daily-report, weekly-report, monthly-report, manual-trigger, backfill |
| **API Gateway** | REST API for manual-trigger and backfill endpoints |
| **Secrets Manager** | MongoDB URI, ClickUp API token, Google OAuth credentials, API keys |
| **CloudWatch** | Custom metrics (TasksFetched, ReportGenerationDurationMs, SheetsRowsWritten, ChartsCreated) |
| **SQS** | Dead-letter queues (6 DLQs, one per Lambda) |
| **EventBridge (Scheduler)** | Cron/rate triggers for sync and report Lambdas |
| **IAM** | Per-Lambda roles with least-privilege policies |

External (non-AWS) dependencies that are **not emulated** by LocalStack:
- MongoDB Atlas (use a local MongoDB container instead)
- ClickUp API (mock or use real API with a test workspace)
- Google Sheets/Drive API (mock or use a test service account)

---

## 1. Prerequisites

| Tool | Minimum Version | Purpose |
|---|---|---|
| Docker + Docker Compose | 24.x / 2.20+ | Run LocalStack and MongoDB containers |
| LocalStack CLI | 3.x | LocalStack management (or use Docker image directly) |
| AWS CLI v2 | 2.x | Interact with LocalStack endpoints |
| AWS SAM CLI | 1.100+ | Build and deploy SAM template to LocalStack |
| Node.js | 20.x | Lambda runtime |
| `awslocal` (optional) | latest | Wrapper that auto-targets LocalStack endpoint |

Install `awslocal`:
```bash
pip install awscli-local
```

---

## 2. Docker Compose Setup

```yaml
# docker-compose.localstack.yml
version: "3.8"

services:
  localstack:
    image: localstack/localstack:3
    container_name: clickup-reporting-localstack
    ports:
      - "4566:4566"           # LocalStack gateway
      - "4510-4559:4510-4559" # External service ports
    environment:
      - SERVICES=lambda,apigateway,secretsmanager,cloudwatch,sqs,events,iam,logs,s3
      - DEBUG=0
      - LAMBDA_EXECUTOR=docker-reuse
      - LAMBDA_DOCKER_NETWORK=clickup-reporting-net
      - DOCKER_HOST=unix:///var/run/docker.sock
      - DEFAULT_REGION=us-east-1
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock"
      - "./localstack-init:/etc/localstack/init/ready.d"
      - localstack-data:/var/lib/localstack
    networks:
      - clickup-reporting-net

  mongodb:
    image: mongo:7
    container_name: clickup-reporting-mongo
    ports:
      - "27017:27017"
    environment:
      MONGO_INITDB_DATABASE: clickup_reporting
    volumes:
      - mongo-data:/data/db
    networks:
      - clickup-reporting-net

volumes:
  localstack-data:
  mongo-data:

networks:
  clickup-reporting-net:
    driver: bridge
```

---

## 3. LocalStack Init Script

Create `localstack-init/setup.sh` — this runs automatically when LocalStack is ready.

```bash
#!/bin/bash
# localstack-init/setup.sh
# Runs inside the LocalStack container on startup.

set -euo pipefail

REGION="us-east-1"
ENDPOINT="http://localhost:4566"

echo "=== Seeding Secrets Manager ==="

# MongoDB connection string (points to the sibling container)
awslocal secretsmanager create-secret \
  --name "clickup-reporting/mongodb-uri" \
  --secret-string "mongodb://mongodb:27017/clickup_reporting" \
  --region "$REGION" || true

# ClickUp API token (use a real test token or a dummy for offline dev)
awslocal secretsmanager create-secret \
  --name "clickup-api-token" \
  --secret-string "pk_test_REPLACE_WITH_YOUR_TOKEN" \
  --region "$REGION" || true

# Google OAuth credentials (dummy for local dev — replace for integration testing)
awslocal secretsmanager create-secret \
  --name "google-oauth-credentials" \
  --secret-string '{"client_id":"test-client-id","client_secret":"test-client-secret","refresh_token":"test-refresh-token"}' \
  --region "$REGION" || true

# API key for manual-trigger / backfill endpoints
awslocal secretsmanager create-secret \
  --name "clickup-reporting/api-key" \
  --secret-string "local-dev-api-key-12345" \
  --region "$REGION" || true

echo "=== Creating SQS Dead-Letter Queues ==="

for QUEUE in clickup-sync-dlq daily-report-dlq weekly-report-dlq monthly-report-dlq manual-trigger-dlq backfill-dlq; do
  awslocal sqs create-queue \
    --queue-name "${QUEUE}-staging" \
    --region "$REGION" || true
done

echo "=== LocalStack init complete ==="
```

Make it executable:
```bash
chmod +x localstack-init/setup.sh
```

---

## 4. Environment Configuration

Create a `.env.local` file for local development overrides:

```env
# .env.local — loaded when NODE_ENV=local
NODE_ENV=local
AWS_ENDPOINT_URL=http://localhost:4566
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test

# Secrets Manager secret names (match init script)
MONGODB_SECRET_NAME=clickup-reporting/mongodb-uri
CLICKUP_SECRET_ID=clickup-api-token
GOOGLE_OAUTH_SECRET_ID=google-oauth-credentials
API_KEY_SECRET_NAME=clickup-reporting/api-key

# Direct MongoDB fallback (bypass Secrets Manager for faster iteration)
MONGODB_URI=mongodb://localhost:27017/clickup_reporting
MONGODB_DB_NAME=clickup_reporting
```

---

## 5. AWS SDK Client Configuration Changes

The AWS SDK clients need to point to LocalStack when running locally. Add an endpoint override utility:

```typescript
// src/utils/aws-client.config.ts

interface LocalEndpointConfig {
  endpoint?: string;
  region?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/**
 * Returns AWS SDK client config that targets LocalStack when
 * AWS_ENDPOINT_URL is set (local dev), or uses default resolution
 * in deployed environments.
 */
export function getAwsClientConfig(): LocalEndpointConfig {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (!endpoint) return {};

  return {
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  };
}
```

Then update each SDK client instantiation to spread this config:

| File | Client | Change |
|---|---|---|
| `src/services/db/connection.ts` | `SecretsManagerClient` | `new SecretsManagerClient(getAwsClientConfig())` |
| `src/services/clickup/client.ts` | `SecretsManagerClient` | `new SecretsManagerClient(getAwsClientConfig())` |
| `src/services/sheets/client.ts` | `SecretsManagerClient` | `new SecretsManagerClient(getAwsClientConfig())` |
| `src/lambdas/manual-trigger/handler.ts` | `CloudWatchClient`, `SecretsManagerClient` | Both use `getAwsClientConfig()` |
| `src/lambdas/clickup-sync/handler.ts` | `CloudWatchClient` | `new CloudWatchClient(getAwsClientConfig())` |
| `src/utils/metrics.ts` | `CloudWatchClient` | `new CloudWatchClient(getAwsClientConfig())` |

> **No production impact**: `AWS_ENDPOINT_URL` is never set in deployed environments, so `getAwsClientConfig()` returns `{}` and the SDK uses its default credential chain.

---

## 6. SAM Local Invocation

### Option A: `sam local invoke` (single function)

```bash
# Build first
sam build

# Invoke the sync function with a test event
sam local invoke SyncFunction \
  --docker-network clickup-reporting-net \
  --env-vars env.local.json \
  --event events/sync-event.json

# Invoke manual-trigger with an API Gateway event
sam local invoke ManualTriggerFunction \
  --docker-network clickup-reporting-net \
  --env-vars env.local.json \
  --event events/manual-trigger-event.json
```

### Option B: `sam local start-api` (API Gateway emulation)

```bash
sam local start-api \
  --docker-network clickup-reporting-net \
  --env-vars env.local.json \
  --port 3000
```

Then test:
```bash
curl -X POST http://localhost:3000/reports/generate \
  -H "Content-Type: application/json" \
  -H "x-api-key: local-dev-api-key-12345" \
  -d '{
    "report_type": "daily",
    "period_start": "2025-01-01T00:00:00Z",
    "period_end": "2025-01-01T23:59:59Z"
  }'
```

### Option C: Deploy to LocalStack with `samlocal`

```bash
pip install aws-sam-cli-local

samlocal build
samlocal deploy \
  --stack-name clickup-reporting-local \
  --parameter-overrides \
    Environment=staging \
    SecretsArn=arn:aws:secretsmanager:us-east-1:000000000000:secret:clickup-reporting \
  --resolve-s3 \
  --no-confirm-changeset
```

This deploys the full stack (Lambdas, API Gateway, SQS, EventBridge schedules) into LocalStack.

### `env.local.json` for SAM local

```json
{
  "Parameters": {
    "AWS_ENDPOINT_URL": "http://localstack:4566",
    "AWS_REGION": "us-east-1",
    "AWS_ACCESS_KEY_ID": "test",
    "AWS_SECRET_ACCESS_KEY": "test",
    "NODE_ENV": "local",
    "MONGODB_SECRET_NAME": "clickup-reporting/mongodb-uri",
    "CLICKUP_SECRET_ID": "clickup-api-token",
    "GOOGLE_OAUTH_SECRET_ID": "google-oauth-credentials",
    "API_KEY_SECRET_NAME": "clickup-reporting/api-key"
  }
}
```

---

## 7. Test Events

Create sample event payloads under an `events/` directory:

```
events/
├── sync-event.json              # Empty object {} (EventBridge scheduled)
├── manual-trigger-event.json    # API Gateway proxy event with POST body
├── backfill-event.json          # API Gateway proxy event for backfill
├── daily-report-event.json      # Empty object {} (EventBridge scheduled)
├── weekly-report-event.json     # Empty object {} (EventBridge scheduled)
└── monthly-report-event.json    # Empty object {} (EventBridge scheduled)
```

Generate a starter API Gateway event:
```bash
sam local generate-event apigateway aws-proxy \
  --method POST \
  --path /reports/generate \
  --body '{"report_type":"daily","period_start":"2025-01-01","period_end":"2025-01-01"}' \
  > events/manual-trigger-event.json
```

---

## 8. MongoDB Seed Data

Create a seed script to populate the local MongoDB with test data:

```bash
# scripts/seed-mongo.sh
mongosh mongodb://localhost:27017/clickup_reporting <<'EOF'

// Developers
db.developers.insertMany([
  {
    clickup_user_id: "dev-001",
    first_name: "Alice",
    last_name: "Smith",
    email: "alice@example.com",
    team_id: "team-001",
    active: true
  },
  {
    clickup_user_id: "dev-002",
    first_name: "Bob",
    last_name: "Jones",
    email: "bob@example.com",
    team_id: "team-001",
    active: true
  }
]);

// Teams
db.teams.insertOne({
  team_id: "team-001",
  name: "Platform",
  members: ["dev-001", "dev-002"]
});

// SLA config overrides
db.sla_config.insertMany([
  { key: "inactivity_days", value: 3 },
  { key: "open_task_days", value: 7 }
]);

// Sample task snapshots
db.task_snapshots.insertMany([
  {
    clickup_task_id: "task-001",
    assignee_id: "dev-001",
    normalized_status: "in_progress",
    story_points: 3,
    date_created: new Date("2025-01-01"),
    date_updated: new Date("2025-01-01"),
    task_name: "Implement auth flow"
  },
  {
    clickup_task_id: "task-002",
    assignee_id: "dev-002",
    normalized_status: "closed_completed",
    story_points: 5,
    date_created: new Date("2025-01-01"),
    date_updated: new Date("2025-01-01"),
    task_name: "Fix payment bug"
  }
]);

print("Seed data loaded.");
EOF
```

---

## 9. NPM Scripts

Add convenience scripts to `package.json`:

```json
{
  "scripts": {
    "local:up": "docker compose -f docker-compose.localstack.yml up -d",
    "local:down": "docker compose -f docker-compose.localstack.yml down",
    "local:logs": "docker compose -f docker-compose.localstack.yml logs -f",
    "local:seed": "bash scripts/seed-mongo.sh",
    "local:api": "sam local start-api --docker-network clickup-reporting-net --env-vars env.local.json --port 3000",
    "local:invoke:sync": "sam local invoke SyncFunction --docker-network clickup-reporting-net --env-vars env.local.json --event events/sync-event.json",
    "local:invoke:daily": "sam local invoke DailyReportFunction --docker-network clickup-reporting-net --env-vars env.local.json --event events/daily-report-event.json",
    "local:invoke:manual": "sam local invoke ManualTriggerFunction --docker-network clickup-reporting-net --env-vars env.local.json --event events/manual-trigger-event.json",
    "local:reset": "docker compose -f docker-compose.localstack.yml down -v && docker compose -f docker-compose.localstack.yml up -d"
  }
}
```

---

## 10. Startup Workflow

```
1.  npm run local:up          # Start LocalStack + MongoDB containers
2.  npm run local:seed        # Populate MongoDB with test data
3.  sam build                 # Build Lambda artifacts
4.  npm run local:api         # Start API Gateway on port 3000
    — or —
    npm run local:invoke:sync # Invoke a single function
```

---

## 11. Verifying the Stack

```bash
# Check Secrets Manager
awslocal secretsmanager list-secrets --region us-east-1

# Check SQS queues
awslocal sqs list-queues --region us-east-1

# Check CloudWatch metrics (after invoking a Lambda)
awslocal cloudwatch list-metrics --namespace ClickUpReporting --region us-east-1

# Check MongoDB
mongosh mongodb://localhost:27017/clickup_reporting --eval "db.task_snapshots.countDocuments()"
```

---

## 12. Limitations & Workarounds

| Concern | Approach |
|---|---|
| **Google Sheets API** | Not emulated. For local dev, stub the Sheets client or use a dedicated test Google service account. Consider a `SHEETS_DRY_RUN=true` env var that logs output instead of calling the API. |
| **ClickUp API** | Not emulated. Use a real test workspace token in the secret, or create a mock HTTP server (e.g., with `msw` or `json-server`) and override `CLICKUP_BASE_URL`. |
| **EventBridge schedules** | LocalStack supports EventBridge rules, but `samlocal deploy` handles this. For manual testing, invoke Lambdas directly. |
| **Lambda Layers** | `sam local invoke` resolves layers from the build output. If issues arise, use `--skip-pull-image` and ensure `sam build` completed. |
| **Hot reload** | Use `sam local start-api --warm-containers EAGER` or `sam sync --watch --stack-name clickup-reporting-local` for faster iteration. |
| **MongoDB Atlas IP allowlisting** | Not relevant locally — the local MongoDB container has no IP restrictions. |

---

## 13. Directory Structure After Setup

```
project-root/
├── docker-compose.localstack.yml
├── localstack-init/
│   └── setup.sh
├── scripts/
│   └── seed-mongo.sh
├── events/
│   ├── sync-event.json
│   ├── manual-trigger-event.json
│   ├── backfill-event.json
│   ├── daily-report-event.json
│   ├── weekly-report-event.json
│   └── monthly-report-event.json
├── env.local.json
├── .env.local
├── src/
│   └── utils/
│       └── aws-client.config.ts   ← new
└── ...existing files
```

---

## 14. Integration Test Support

The same LocalStack + MongoDB stack can back integration tests:

```bash
# In jest.integration.config.ts, set:
# globalSetup: starts docker-compose
# globalTeardown: stops docker-compose

npm run test:integration
```

Environment variables for the test runner can be loaded from `.env.local` using `dotenv` in the Jest setup file, ensuring tests hit LocalStack instead of real AWS.
