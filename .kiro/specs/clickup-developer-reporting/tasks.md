# Implementation Plan: ClickUp Developer Reporting

## Overview

Incremental implementation of the ClickUp Developer & Team Reporting System — a serverless pipeline on AWS that syncs ClickUp task data to MongoDB, computes developer/team KPIs, and publishes formatted reports with embedded charts to Google Sheets. Built with TypeScript, AWS SAM, MongoDB Atlas, and the Google Sheets API.

## Tasks

- [x] 1. Project scaffolding, types, and shared utilities
  - [x] 1.1 Initialize project structure with TypeScript, ESLint, Prettier, Jest, and fast-check
    - Create `package.json`, `tsconfig.json`, `.eslintrc.json`, `.prettierrc`
    - Set up `src/` directory structure: `lambdas/`, `services/`, `types/`, `utils/`, `config/`
    - Set up `tests/` directory structure: `unit/`, `property/`, `integration/`
    - Configure Jest with ts-jest for unit and property test suites
    - _Requirements: 19.5, 21.1_

  - [x] 1.2 Define all TypeScript types and interfaces
    - Create `src/types/clickup.ts` with `ClickUpTask`, `ClickUpCustomField`, `TimeInStatusResponse`
    - Create `src/types/report.ts` with `ReportPeriod`, `DeveloperKPIs`, `TeamKPIs`, `DeveloperReport`, `TeamReport`, `TaskBreakdownRow`, `FlaggedTask`, `ReworkAnalysis`, `TrendComparison`, `StatusFlowEntry`, `BottleneckEntry`, `WorkloadEntry`
    - Create `src/types/sheets.ts` with `SheetFormat`, `ChartSpec`
    - Create `src/types/db.ts` with `RawTask`, `TaskSnapshot`, `Developer`, `Team`, `ReportSnapshot`, `SyncCursor`, `SlaConfig`
    - _Requirements: 7.1, 7.2, 8.1, 9.1, 9.2, 10.3, 14.1_

  - [x] 1.3 Implement Logger utility
    - Create `src/utils/logger.ts` using Pino with structured JSON output
    - Support correlation ID and lambda name context
    - Ensure no PII in log output
    - _Requirements: 17.1, 18.1, 18.4_

  - [x] 1.4 Implement Retry utility with exponential backoff and jitter
    - Create `src/utils/retry.ts` with `withRetry<T>` function
    - Support configurable `maxRetries`, `baseDelayMs`, `maxDelayMs`, and `jitter`
    - _Requirements: 1.7, 17.4, 17.5_

  - [ ]* 1.5 Write property test for Retry utility
    - **Property 2: Exponential Backoff Delay Bounds**
    - **Validates: Requirements 1.7, 17.4**

  - [x] 1.6 Implement Date utilities
    - Create `src/utils/date.utils.ts` using date-fns
    - Implement `getDailyPeriod`, `getWeeklyPeriod`, `getMonthlyPeriod`, `getPriorPeriod`, `formatSheetName`, `enumeratePeriods`
    - _Requirements: 2.2, 3.2, 4.2, 6.2_

  - [ ]* 1.7 Write property tests for Date utilities
    - **Property 5: Sheet Name Formatting**
    - **Validates: Requirements 2.5, 3.4, 4.4**
    - **Property 6: Period Enumeration Completeness**
    - **Validates: Requirements 6.2**

  - [x] 1.8 Implement Configuration loader
    - Create `src/config/config.ts` to load `spaces.config.json` and `sla.config.json`
    - Implement MongoDB `sla_config` collection read with precedence over file values
    - Apply documented defaults for missing keys
    - _Requirements: 20.1, 20.2, 20.3, 20.4_

  - [ ]* 1.9 Write property test for Configuration precedence
    - **Property 21: Configuration Precedence**
    - **Validates: Requirements 20.3, 20.4**

- [x] 2. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Status classification and SLA flagging
  - [x] 3.1 Implement Status Classifier
    - Create `src/services/status/classifier.ts`
    - Map known ClickUp statuses to `NormalizedStatus` values
    - Default unknown statuses to `not_started` with a warning log
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

  - [ ]* 3.2 Write property test for Status Classifier
    - **Property 19: Unknown Status Defaults to not_started**
    - **Validates: Requirements 12.5**

  - [x] 3.3 Implement SLA Flag Service
    - Create `src/services/status/sla-flag.service.ts`
    - Implement `flagTask`, `flagTasks`, and `getHighestSeverity`
    - Apply overdue (🔴), inactive (🟠), open too long (🟡), high rework (🟠) rules
    - Use highest severity when multiple flags apply (red > orange > yellow)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [ ]* 3.4 Write property tests for SLA Flag Service
    - **Property 17: SLA Flag Predicate Correctness**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4**
    - **Property 18: Highest Severity Flag Selection**
    - **Validates: Requirements 11.6**

- [x] 4. ClickUp Client and Sync Lambda
  - [x] 4.1 Implement ClickUp Client
    - Create `src/services/clickup/client.ts`
    - Implement `fetchTasks`, `fetchSubtasks`, `fetchTimeInStatus`, `fetchTeamMembers`
    - Add rate limiter tracking `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers
    - Add concurrency semaphore limiting to 5 parallel requests
    - Add 429 retry with exponential backoff (base 2s, max 5 retries)
    - Retrieve API token from Secrets Manager and cache for invocation lifetime
    - _Requirements: 1.7, 1.8, 1.9, 22.1, 22.2, 22.3, 22.4_

  - [ ]* 4.2 Write property tests for Rate Limiter and Concurrency
    - **Property 3: Rate Limiter Pauses at Zero Remaining**
    - **Validates: Requirements 1.8**
    - **Property 4: Concurrency Semaphore Limits Parallel Requests**
    - **Validates: Requirements 1.9**

  - [x] 4.3 Implement Task Snapshot enrichment/normalization
    - Create `src/services/sync/task-normalizer.ts`
    - Transform raw ClickUp tasks into TaskSnapshot records
    - Extract custom fields (Rework_Count, story points), set `is_subtask`, `parent_task_id`, `normalized_status`, `time_in_status`
    - _Requirements: 1.5, 13.1, 13.2, 13.3_

  - [ ]* 4.4 Write property test for Task Snapshot enrichment
    - **Property 1: Task Snapshot Enrichment Preserves Source Data**
    - **Validates: Requirements 1.5, 13.2, 13.3**

  - [x] 4.5 Implement MongoDB connection pool manager
    - Create `src/services/db/connection.ts`
    - Shared connection pool reused across Lambda invocations
    - Retrieve connection string from Secrets Manager at cold start
    - Retry connection 3 times on failure
    - _Requirements: 14.4, 14.5_

  - [x] 4.6 Implement Sync Lambda handler
    - Create `src/lambdas/clickup-sync/handler.ts`
    - Load spaces config, iterate lists, read sync cursors, fetch tasks + subtasks
    - Upsert `raw_tasks` and `task_snapshots`, update `sync_cursors`
    - Full historical fetch when no cursor exists for a list
    - Log failures per list and continue processing remaining lists
    - Emit `TasksFetched` CloudWatch metric
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.10, 1.11, 18.2_

  - [ ]* 4.7 Write unit tests for Sync Lambda
    - Test incremental sync with cursor, full fetch without cursor, partial list failure, subtask fetching
    - _Requirements: 1.1, 1.2, 1.10, 1.11_

- [x] 5. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Metrics Calculator and Report Builder
  - [x] 6.1 Implement Metrics Calculator
    - Create `src/services/reports/metrics.ts`
    - Implement `computeKPIs` for all 17 developer KPIs
    - Implement `computeTeamKPIs` aggregating across developers
    - Implement `computeCompletionRate`, `computeAverageTaskAge`, `computeAverageTimeInStatus`, `computeVelocityDelta`
    - _Requirements: 7.1, 8.1_

  - [ ]* 6.2 Write property tests for Metrics Calculator
    - **Property 8: KPI Computation Invariants**
    - **Validates: Requirements 7.1**
    - **Property 10: Priority Distribution Sums to Task Count**
    - **Validates: Requirements 7.4**
    - **Property 11: Rework Analysis Consistency**
    - **Validates: Requirements 7.5, 8.5**
    - **Property 12: Trend Delta Computation**
    - **Validates: Requirements 7.6, 8.6**
    - **Property 13: Team KPI Aggregation**
    - **Validates: Requirements 8.1, 8.5**
    - **Property 15: Bottleneck Analysis Percentages Sum to 100%**
    - **Validates: Requirements 8.4**
    - **Property 20: No Double-Counting Subtasks in Metrics**
    - **Validates: Requirements 13.4**

  - [x] 6.3 Implement Report Builder
    - Create `src/services/reports/builder.ts`
    - Implement `buildDeveloperReport` assembling KPIs, task breakdown, status flow, priority distribution, rework analysis, trend comparison, at-risk tasks
    - Implement `buildTeamReport` assembling team KPIs, developer comparison, full task list, bottleneck analysis, team rework, trend comparison, workload distribution with 35% flagging, at-risk tasks
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

  - [ ]* 6.4 Write property tests for Task Breakdown and Workload
    - **Property 9: Task Breakdown Row Field Completeness**
    - **Validates: Requirements 7.2**
    - **Property 14: Team Task List Union Without Duplicates**
    - **Validates: Requirements 8.3**
    - **Property 16: Workload Distribution Flagging**
    - **Validates: Requirements 8.7**

- [x] 7. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Google Sheets Client and Chart Builder
  - [x] 8.1 Implement Sheets Client
    - Create `src/services/sheets/client.ts`
    - Implement `getOrCreateSpreadsheet`, `createSheet`, `writeData`, `applyFormatting`, `createChart`, `deleteCharts`, `protectSheet`, `grantEditorAccess`
    - OAuth2 token management: refresh token from Secrets Manager, auto-refresh on expiry
    - 429 retry with exponential backoff (max 3 retries)
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 15.1, 15.2, 15.3, 15.4, 15.5_

  - [x] 8.2 Implement Chart Builder
    - Create `src/services/reports/chart-builder.ts`
    - Implement `buildDeveloperCharts`: Bar (tasks by status), Line (daily closed trend), Pie (priority distribution), Bar (estimated vs logged time)
    - Implement `buildTeamCharts`: Stacked Bar (tasks per dev by status), Line (velocity trend), Bar (rework per dev), Pie (workload distribution), Bar (avg PR time per dev), Bar (avg QA time per dev)
    - All charts sized 600×371 pixels, positioned right of data tables
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 8.3 Implement Sheet formatting logic
    - Create `src/services/sheets/formatter.ts`
    - Header formatting: bold, frozen, #1A73E8 background, white text
    - Alternating row colors, right-aligned numerics
    - Task ID hyperlinks to ClickUp URLs
    - At-risk color coding: red (#FF0000), orange (#FF9900), yellow (#FFFF00)
    - Delete existing charts before creating new ones
    - _Requirements: 10.3, 10.4, 10.5, 10.6, 10.7, 9.5_

  - [ ]* 8.4 Write unit tests for Sheets Client and Chart Builder
    - Test OAuth2 token refresh, chart spec generation, formatting payloads, sheet protection
    - _Requirements: 9.1, 9.2, 15.3, 15.5_

- [x] 9. Report Lambda handlers
  - [x] 9.1 Implement Daily Report Lambda
    - Create `src/lambdas/daily-report/handler.ts`
    - Compute daily period (yesterday 00:00–23:59 UTC)
    - Generate developer reports and team report via Report Builder
    - Write to `Daily_YYYY-MM-DD` sheet, save Report_Snapshot
    - Partial failure tolerance: log per-developer failures, continue processing
    - Emit `ReportGenerationDurationMs`, `SheetsRowsWritten`, `ChartsCreated` metrics
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 18.2_

  - [x] 9.2 Implement Weekly Report Lambda
    - Create `src/lambdas/weekly-report/handler.ts`
    - Compute weekly period (last Mon–Sun UTC)
    - Write to `Weekly_YYYY-WXX` sheet, save Report_Snapshot
    - Same partial failure and metrics pattern as daily
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x] 9.3 Implement Monthly Report Lambda
    - Create `src/lambdas/monthly-report/handler.ts`
    - Compute monthly period (1st–last day of previous month UTC)
    - Write to `Monthly_YYYY-MM` sheet, save Report_Snapshot
    - Same partial failure and metrics pattern as daily
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [x] 9.4 Implement Manual Trigger Lambda
    - Create `src/lambdas/manual-trigger/handler.ts`
    - Validate request body (`report_type`, `period_start`, `period_end`)
    - Validate API key authentication
    - Return HTTP 400 for invalid input, HTTP 401 for missing/invalid API key
    - Delegate to the same report generation logic as scheduled Lambdas
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ]* 9.5 Write property test for Request Validation
    - **Property 7: Request Validation Rejects Invalid Input**
    - **Validates: Requirements 5.4, 6.5**

  - [x] 9.6 Implement Backfill Lambda
    - Create `src/lambdas/backfill/handler.ts`
    - Validate request body (`from_date`, `to_date`) and API key
    - Enumerate all daily/weekly/monthly periods in range
    - Skip periods with existing Report_Snapshots
    - Process with controlled concurrency (default 2)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

  - [ ]* 9.7 Write unit tests for Lambda handlers
    - Test daily/weekly/monthly period computation, manual trigger validation, backfill period enumeration and skip logic, partial failure handling
    - _Requirements: 2.7, 3.6, 4.6, 5.4, 6.5, 6.7_

- [x] 10. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. MongoDB indexes, DLQs, and observability
  - [x] 11.1 Create MongoDB index setup script
    - Create `src/services/db/indexes.ts`
    - Unique index on `raw_tasks.clickup_task_id`
    - Unique index on `developers.clickup_user_id`
    - Unique index on `sync_cursors.list_id`
    - Unique index on `sla_config.key`
    - Compound unique index on `report_snapshots.{report_type, period_start, team_id}`
    - Compound index on `task_snapshots.{assignee_id, date_updated}` and `task_snapshots.{normalized_status}`
    - _Requirements: 14.1, 14.2, 14.3_

  - [x] 11.2 Implement CloudWatch metrics emission
    - Create `src/utils/metrics.ts`
    - Emit `ReportGenerationDurationMs`, `TasksFetched`, `SheetsRowsWritten`, `ChartsCreated`
    - _Requirements: 18.2_

  - [ ]* 11.3 Write unit tests for metrics emission and index setup
    - Verify correct metric names and dimensions
    - _Requirements: 18.2, 14.2_

- [ ] 12. AWS SAM template and CI/CD
  - [x] 12.1 Create AWS SAM template
    - Create `template.yaml` defining all Lambda functions with specified memory/timeout
    - Define EventBridge rules: Sync (every 30 min), Daily (00:05 UTC), Weekly (Mon 00:10 UTC), Monthly (1st 00:15 UTC)
    - Define API Gateway with `/reports/generate` and `/reports/backfill` endpoints with API key auth
    - Define SQS DLQ for each Lambda
    - Define IAM roles per Lambda with least privilege
    - Define shared Lambda Layer referencing common modules
    - _Requirements: 19.1, 19.6, 17.3, 16.2, 16.5, 21.1, 21.2_

  - [x] 12.2 Create configuration files
    - Create `config/spaces.config.json` with space/list inclusion/exclusion structure
    - Create `config/sla.config.json` with default thresholds
    - _Requirements: 20.1, 20.2, 20.4_

  - [x] 12.3 Create GitHub Actions CI/CD pipeline
    - Create `.github/workflows/deploy.yml`
    - Staging deployment on push to `develop`, production on merge to `main`
    - Run ESLint, Prettier check, and Jest tests before deployment
    - Publish new Lambda Layer version and update function references on shared layer changes
    - _Requirements: 19.2, 19.3, 19.4, 19.5, 21.3_

  - [x] 12.4 Define CloudWatch alarms
    - Add alarms to SAM template: Lambda error rate, duration > 80% timeout, DLQ count > 0, sync staleness > 60 min
    - _Requirements: 18.3_

- [x] 13. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate the 21 universal correctness properties from the design
- Unit tests validate specific examples and edge cases
- All code is TypeScript, tested with Jest + fast-check
