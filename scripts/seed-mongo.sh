#!/bin/bash
# scripts/seed-mongo.sh
# Populates the local MongoDB with test data for development.

set -euo pipefail

MONGO_URI="${MONGO_URI:-mongodb://localhost:27017/clickup_reporting}"

echo "=== Seeding MongoDB at $MONGO_URI ==="

mongosh "$MONGO_URI" <<'EOF'

// Clear existing seed data to allow re-runs
db.developers.deleteMany({});
db.teams.deleteMany({});
db.sla_config.deleteMany({});
db.task_snapshots.deleteMany({});
db.sync_cursors.deleteMany({});
db.report_snapshots.deleteMany({});

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
  { key: "open_task_days", value: 7 },
  { key: "rework_count_flag", value: 2 },
  { key: "backfill_concurrency", value: 2 },
  { key: "workload_imbalance_pct", value: 35 }
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
  },
  {
    clickup_task_id: "task-003",
    assignee_id: "dev-001",
    normalized_status: "open",
    story_points: 2,
    date_created: new Date("2025-01-02"),
    date_updated: new Date("2025-01-02"),
    task_name: "Add logging middleware"
  },
  {
    clickup_task_id: "task-004",
    assignee_id: "dev-002",
    normalized_status: "in_review",
    story_points: 8,
    date_created: new Date("2025-01-02"),
    date_updated: new Date("2025-01-03"),
    task_name: "Database migration script"
  }
]);

print("=== Seed data loaded successfully ===");
EOF

echo "=== MongoDB seeding complete ==="
