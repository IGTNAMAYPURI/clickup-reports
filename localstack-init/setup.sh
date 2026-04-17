#!/bin/bash
# localstack-init/setup.sh
# Runs inside the LocalStack container on startup.

set -euo pipefail

REGION="us-east-1"

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
