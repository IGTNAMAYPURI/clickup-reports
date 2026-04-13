# Requirements Document

## Introduction

The ClickUp Developer & Team Reporting System is a fully serverless, automated reporting pipeline that pulls task and productivity data from ClickUp, aggregates it per developer and per team, and publishes comprehensive structured daily, weekly, and monthly reports — with embedded charts — to Google Sheets. The system is backed by MongoDB Atlas for data persistence, caching, and historical analysis. It targets a team of 17 developers and provides zero-manual-effort visibility into developer output for engineering managers and team leads.

## Glossary

- **Reporting_System**: The complete serverless application comprising Lambda functions, shared layers, and supporting infrastructure that fetches ClickUp data, computes metrics, and publishes reports to Google Sheets.
- **ClickUp_Client**: The shared service module responsible for all HTTP communication with the ClickUp REST API v2, including authentication, rate limiting, retries, and pagination.
- **Sheets_Client**: The shared service module responsible for all communication with Google Sheets API v4 and Google Drive API v3, including OAuth2 token management, spreadsheet creation, data writing, formatting, and chart embedding.
- **Sync_Lambda**: The AWS Lambda function (`clickup-sync`) that runs every 30 minutes to incrementally fetch updated tasks from ClickUp and persist them to MongoDB.
- **Daily_Report_Lambda**: The AWS Lambda function (`report-daily`) triggered by EventBridge at 00:05 UTC to generate daily developer and team reports.
- **Weekly_Report_Lambda**: The AWS Lambda function (`report-weekly`) triggered by EventBridge at 00:10 UTC on Mondays to generate weekly developer and team reports.
- **Monthly_Report_Lambda**: The AWS Lambda function (`report-monthly`) triggered by EventBridge at 00:15 UTC on the 1st of each month to generate monthly developer and team reports.
- **Manual_Trigger_Lambda**: The AWS Lambda function (`report-manual`) invoked via API Gateway POST `/reports/generate` to generate reports on demand.
- **Backfill_Lambda**: The AWS Lambda function (`backfill`) invoked via API Gateway POST `/reports/backfill` to generate historical reports for past periods.
- **Task_Snapshot**: A normalized, enriched task record stored in the `task_snapshots` MongoDB collection, serving as the source of truth for all report generation.
- **Raw_Task**: The unprocessed ClickUp task data stored in the `raw_tasks` MongoDB collection.
- **Report_Snapshot**: A metadata record stored in the `report_snapshots` MongoDB collection capturing report generation status, metrics, and the Google Sheets URL.
- **Sync_Cursor**: A record in the `sync_cursors` MongoDB collection tracking the last sync timestamp per ClickUp list for incremental fetching.
- **At_Risk_Task**: A task flagged based on configurable SLA rules: overdue (past due date, not closed), inactive (no activity for configurable threshold, default 3 days), open too long (configurable threshold, default 7 days), or high rework (rework count at or above configurable threshold, default 2).
- **Rework_Count**: A ClickUp custom field tracking how many times a task has been sent back for rework.
- **Developer_Report**: A per-developer report section containing KPIs, task breakdown, status flow analysis, priority distribution, rework analysis, trend comparison, at-risk tasks, and embedded charts.
- **Team_Report**: An aggregated report across all developers containing team KPIs, per-developer comparison, full task list, bottleneck analysis, rework analysis, trend comparison, workload distribution, at-risk tasks, and embedded charts.
- **SLA_Config**: Configurable rules stored in the `sla_config` MongoDB collection and `sla.config.json` defining thresholds for at-risk and overdue task flagging.
- **Spaces_Config**: A JSON configuration file (`spaces.config.json`) defining which ClickUp spaces and lists to include or exclude from data fetching.
- **Status_Classification**: The mapping of ClickUp task statuses to normalized categories: not_started (TO DO, BUG FOUND), active (IN PROGRESS, PULL REQUEST), done/In QA (COMPLETE, TESTING), closed/Completed (DONE).

## Requirements

### Requirement 1: Incremental ClickUp Data Synchronization

**User Story:** As an engineering manager, I want ClickUp task data to be automatically synced every 30 minutes, so that reports always reflect near-real-time project status.

#### Acceptance Criteria

1. THE Sync_Lambda SHALL fetch tasks from all ClickUp lists defined in the Spaces_Config using the ClickUp REST API v2 `/list/{listId}/task` endpoint.
2. WHEN the Sync_Lambda runs, THE Sync_Lambda SHALL use the `date_updated_gt` parameter from the corresponding Sync_Cursor to fetch only tasks updated since the last successful sync.
3. WHEN the Sync_Lambda completes a successful fetch for a list, THE Sync_Lambda SHALL update the Sync_Cursor for that list with the current timestamp.
4. THE Sync_Lambda SHALL store fetched task data in the `raw_tasks` MongoDB collection using `clickup_task_id` as the unique index, upserting on conflict.
5. WHEN a raw task is stored or updated, THE Sync_Lambda SHALL create or update a corresponding Task_Snapshot with normalized status classification, enriched custom fields (Rework_Count, story points), subtask references, and time-in-status data.
6. THE Sync_Lambda SHALL fetch subtasks independently via the ClickUp API and store each subtask as a standalone Task_Snapshot with a reference to the parent task.
7. WHEN the Sync_Lambda encounters a ClickUp API 429 response, THE ClickUp_Client SHALL apply exponential backoff with jitter starting at 2 seconds, up to a maximum of 5 retries.
8. THE ClickUp_Client SHALL track `X-RateLimit-Remaining` and `X-RateLimit-Reset` response headers and pause requests when the remaining limit reaches zero until the reset time.
9. THE ClickUp_Client SHALL limit concurrent API requests to a maximum of 5 parallel requests.
10. IF the Sync_Lambda fails to fetch data for a specific list after 5 retries, THEN THE Sync_Lambda SHALL log the failure with structured JSON via Pino and continue processing remaining lists.
11. WHEN the Sync_Lambda is invoked for the first time for a list with no existing Sync_Cursor, THE Sync_Lambda SHALL perform a full historical fetch of all tasks in that list.

---

### Requirement 2: Daily Report Generation

**User Story:** As an engineering manager, I want a daily report generated automatically each morning, so that I can review yesterday's developer and team activity without manual effort.

#### Acceptance Criteria

1. THE Daily_Report_Lambda SHALL be triggered by an EventBridge cron rule at 00:05 UTC every day.
2. WHEN triggered, THE Daily_Report_Lambda SHALL generate a Developer_Report for each of the 17 developers covering the period from yesterday 00:00 UTC to yesterday 23:59 UTC.
3. WHEN triggered, THE Daily_Report_Lambda SHALL generate a Team_Report aggregating data across all 17 developers for the same daily period.
4. THE Daily_Report_Lambda SHALL source all task data exclusively from the `task_snapshots` MongoDB collection.
5. THE Daily_Report_Lambda SHALL write each daily report to a sheet named `Daily_YYYY-MM-DD` in the team's Google Sheets spreadsheet.
6. THE Daily_Report_Lambda SHALL create a Report_Snapshot record in MongoDB with report type, period, generation status, metrics summary, and the Google Sheets URL.
7. IF the Daily_Report_Lambda fails to generate a report for a specific developer, THEN THE Daily_Report_Lambda SHALL log the error, record the failure in the Report_Snapshot, and continue processing remaining developers.
8. THE Daily_Report_Lambda SHALL complete execution within 5 minutes.

---

### Requirement 3: Weekly Report Generation

**User Story:** As an engineering manager, I want a weekly report generated every Monday, so that I can assess the team's progress over the past week.

#### Acceptance Criteria

1. THE Weekly_Report_Lambda SHALL be triggered by an EventBridge cron rule at 00:10 UTC every Monday.
2. WHEN triggered, THE Weekly_Report_Lambda SHALL generate a Developer_Report for each developer covering the period from last Monday 00:00 UTC to last Sunday 23:59 UTC.
3. WHEN triggered, THE Weekly_Report_Lambda SHALL generate a Team_Report aggregating data across all developers for the same weekly period.
4. THE Weekly_Report_Lambda SHALL write each weekly report to a sheet named `Weekly_YYYY-WXX` in the team's Google Sheets spreadsheet.
5. THE Weekly_Report_Lambda SHALL create a Report_Snapshot record in MongoDB with report type, period, generation status, metrics summary, and the Google Sheets URL.
6. IF the Weekly_Report_Lambda fails to generate a report for a specific developer, THEN THE Weekly_Report_Lambda SHALL log the error, record the failure in the Report_Snapshot, and continue processing remaining developers.
7. THE Weekly_Report_Lambda SHALL complete execution within 10 minutes.

---

### Requirement 4: Monthly Report Generation

**User Story:** As an engineering manager, I want a monthly report generated on the 1st of each month, so that I can evaluate long-term productivity trends.

#### Acceptance Criteria

1. THE Monthly_Report_Lambda SHALL be triggered by an EventBridge cron rule at 00:15 UTC on the 1st of each month.
2. WHEN triggered, THE Monthly_Report_Lambda SHALL generate a Developer_Report for each developer covering the period from the 1st to the last day of the previous month (00:00 UTC to 23:59 UTC).
3. WHEN triggered, THE Monthly_Report_Lambda SHALL generate a Team_Report aggregating data across all developers for the same monthly period.
4. THE Monthly_Report_Lambda SHALL write each monthly report to a sheet named `Monthly_YYYY-MM` in the team's Google Sheets spreadsheet.
5. THE Monthly_Report_Lambda SHALL create a Report_Snapshot record in MongoDB with report type, period, generation status, metrics summary, and the Google Sheets URL.
6. IF the Monthly_Report_Lambda fails to generate a report for a specific developer, THEN THE Monthly_Report_Lambda SHALL log the error, record the failure in the Report_Snapshot, and continue processing remaining developers.
7. THE Monthly_Report_Lambda SHALL complete execution within 15 minutes.

---

### Requirement 5: Manual Report Trigger

**User Story:** As an engineering manager, I want to trigger report generation on demand via an API endpoint, so that I can get fresh reports outside the scheduled cadence.

#### Acceptance Criteria

1. WHEN a POST request is received at `/reports/generate`, THE Manual_Trigger_Lambda SHALL accept a JSON body specifying `report_type` (daily, weekly, or monthly), `period_start`, and `period_end`.
2. WHEN a valid request is received, THE Manual_Trigger_Lambda SHALL generate the specified report type for the given period using the same logic as the corresponding scheduled Lambda.
3. THE Manual_Trigger_Lambda SHALL require a valid API key in the request header for authentication.
4. IF the request body is missing required fields or contains invalid values, THEN THE Manual_Trigger_Lambda SHALL return an HTTP 400 response with a descriptive error message.
5. IF the API key is missing or invalid, THEN THE Manual_Trigger_Lambda SHALL return an HTTP 401 response.
6. THE Manual_Trigger_Lambda SHALL complete execution within 15 minutes.

---

### Requirement 6: Historical Backfill

**User Story:** As an engineering manager, I want to backfill reports for historical periods before the system went live, so that I have a complete reporting history from the beginning of the project.

#### Acceptance Criteria

1. WHEN a POST request is received at `/reports/backfill`, THE Backfill_Lambda SHALL accept a JSON body specifying `from_date` and `to_date`.
2. WHEN a valid backfill request is received, THE Backfill_Lambda SHALL generate daily, weekly, and monthly reports for all periods falling within the specified date range.
3. THE Backfill_Lambda SHALL process periods with a controlled concurrency of 2 periods in parallel by default.
4. THE Backfill_Lambda SHALL require a valid API key in the request header for authentication.
5. IF the request body is missing required fields or contains invalid dates, THEN THE Backfill_Lambda SHALL return an HTTP 400 response with a descriptive error message.
6. IF the API key is missing or invalid, THEN THE Backfill_Lambda SHALL return an HTTP 401 response.
7. IF a report for a specific period already exists in the Report_Snapshot collection, THEN THE Backfill_Lambda SHALL skip that period and log a message indicating the period was already generated.
8. THE Backfill_Lambda SHALL complete execution within 15 minutes.

---

### Requirement 7: Developer Report Content

**User Story:** As an engineering manager, I want each developer's report to contain detailed KPIs, task breakdowns, status flow analysis, rework analysis, and trend comparisons, so that I can assess individual performance comprehensively.

#### Acceptance Criteria

1. THE Reporting_System SHALL compute the following KPIs for each Developer_Report: Tasks Closed, Tasks In Progress, Tasks In QA, Tasks Opened, Subtasks Closed, Overdue Tasks, At-Risk Tasks, Story Points completed, Time Logged, Estimated vs Logged time ratio, Completion Rate, Average Task Age, Average Time in PR status, Average Time in QA status, Total Rework Count, High-Rework Task count, and Velocity compared to the prior equivalent period.
2. THE Reporting_System SHALL generate a Task Breakdown Table for each Developer_Report containing: Task ID (hyperlinked to ClickUp), Task Name, Parent Task reference, Is Subtask flag, List/Folder, Status, Priority, Story Points, Rework_Count, Time Estimated, Time Logged, Due Date, Date Closed, On Time flag, Days Open, Last Activity date, At-Risk Flag, and Tags.
3. THE Reporting_System SHALL generate a Status Flow Analysis section showing time spent in each status for each task in the Developer_Report.
4. THE Reporting_System SHALL generate a Priority Distribution section with data suitable for a pie chart in the Developer_Report.
5. THE Reporting_System SHALL generate a Rework Analysis section containing total rework count, list of flagged tasks (Rework_Count at or above the configured threshold), and the top 5 most-reworked tasks in the Developer_Report.
6. THE Reporting_System SHALL generate a Trend Comparison section comparing the current period metrics against the prior equivalent period (day vs prior day, week vs prior week, month vs prior month) in the Developer_Report.
7. THE Reporting_System SHALL generate an At-Risk and Overdue Task List section in the Developer_Report listing all tasks matching At_Risk_Task criteria.

---

### Requirement 8: Team Report Content

**User Story:** As an engineering manager, I want a team-level report aggregating data across all developers, so that I can assess overall team health, identify bottlenecks, and spot workload imbalances.

#### Acceptance Criteria

1. THE Reporting_System SHALL compute aggregated Team Summary KPIs across all 17 developers for each Team_Report, using the same metric categories as the Developer_Report.
2. THE Reporting_System SHALL generate a Per-Developer Comparison Table in the Team_Report showing each developer's key metrics side by side.
3. THE Reporting_System SHALL generate a Full Team Task List in the Team_Report containing all tasks across all developers for the report period.
4. THE Reporting_System SHALL generate a Status and Bottleneck Analysis section in the Team_Report identifying statuses where tasks accumulate disproportionately.
5. THE Reporting_System SHALL generate a Team Rework Analysis section in the Team_Report aggregating rework metrics across all developers.
6. THE Reporting_System SHALL generate a Trend Comparison section in the Team_Report comparing current period team metrics against the prior equivalent period.
7. WHEN any single developer accounts for more than 35% of any team-level metric, THE Reporting_System SHALL flag that developer in the Workload Distribution section of the Team_Report.
8. THE Reporting_System SHALL generate an At-Risk and Overdue Tasks section in the Team_Report listing all team tasks matching At_Risk_Task criteria.

---

### Requirement 9: Embedded Chart Generation

**User Story:** As an engineering manager, I want charts embedded directly in the Google Sheets reports, so that I can visually assess trends and distributions without switching tools.

#### Acceptance Criteria

1. THE Sheets_Client SHALL create the following embedded charts in each Developer_Report sheet: a Bar chart showing tasks by status, a Line chart showing the daily closed-task trend, a Pie chart showing priority distribution, and a Bar chart showing estimated vs logged time.
2. THE Sheets_Client SHALL create the following embedded charts in each Team_Report sheet: a Stacked Bar chart showing tasks per developer by status, a Line chart showing team velocity trend, a Bar chart showing rework count per developer, a Pie chart showing workload distribution, a Bar chart showing average PR review time per developer, and a Bar chart showing average QA time per developer.
3. THE Sheets_Client SHALL size each embedded chart at 600 pixels wide by 371 pixels tall.
4. THE Sheets_Client SHALL position each chart to the right of the corresponding data table in the sheet.
5. WHEN a report sheet is updated, THE Sheets_Client SHALL delete all existing charts in that sheet before creating new charts.

---

### Requirement 10: Google Sheets Output Structure and Formatting

**User Story:** As an engineering manager, I want reports organized in a well-structured, consistently formatted Google Sheets spreadsheet per team, so that I can navigate and read reports efficiently.

#### Acceptance Criteria

1. THE Sheets_Client SHALL create one Google Sheets spreadsheet per team, named `[TeamName] Engineering Reports`.
2. THE Sheets_Client SHALL create the following sheets within each spreadsheet: README, Team_Summary, `Daily_YYYY-MM-DD`, `Weekly_YYYY-WXX`, `Monthly_YYYY-MM`, and `Dev_{FirstName}_{LastName}` for each developer.
3. THE Sheets_Client SHALL format header rows as bold, frozen, with background color #1A73E8 and white text.
4. THE Sheets_Client SHALL apply alternating row colors for data rows in all report sheets.
5. THE Sheets_Client SHALL right-align all numeric values in data tables.
6. THE Sheets_Client SHALL render Task ID values as hyperlinks pointing to the corresponding ClickUp task URL.
7. THE Sheets_Client SHALL apply color-coded formatting to At-Risk Flag cells: red (#FF0000) for overdue, orange (#FF9900) for inactive or high rework, and yellow (#FFFF00) for open too long.
8. WHEN a report for a past period is written, THE Sheets_Client SHALL apply sheet protection to prevent accidental edits.
9. WHEN the Team_Summary sheet is updated, THE Sheets_Client SHALL overwrite the existing content with the latest data.
10. WHEN a `Dev_{FirstName}_{LastName}` sheet is updated, THE Sheets_Client SHALL append new rows to the existing data.

---

### Requirement 11: At-Risk and SLA Task Flagging

**User Story:** As an engineering manager, I want tasks flagged automatically based on configurable SLA rules, so that I can quickly identify tasks that need attention.

#### Acceptance Criteria

1. THE Reporting_System SHALL flag a task as overdue with a red indicator (🔴) WHEN the task has a due date in the past and the task status is not classified as closed/Completed.
2. THE Reporting_System SHALL flag a task as inactive with an orange indicator (🟠) WHEN the task has had no activity for a number of days equal to or exceeding the configured inactivity threshold (default 3 days).
3. THE Reporting_System SHALL flag a task as open too long with a yellow indicator (🟡) WHEN the task has been in a non-closed status for a number of days equal to or exceeding the configured open-task threshold (default 7 days).
4. THE Reporting_System SHALL flag a task as high rework with an orange indicator (🟠) WHEN the task Rework_Count is equal to or greater than the configured rework threshold (default 2).
5. THE Reporting_System SHALL read all flagging thresholds from the SLA_Config (MongoDB `sla_config` collection and `sla.config.json` file).
6. WHEN a task matches multiple At_Risk_Task criteria, THE Reporting_System SHALL apply the highest severity flag (red > orange > yellow).

---

### Requirement 12: Status Classification and Normalization

**User Story:** As an engineering manager, I want ClickUp task statuses mapped to normalized categories, so that reports use consistent terminology regardless of ClickUp status naming.

#### Acceptance Criteria

1. THE Reporting_System SHALL classify ClickUp statuses "TO DO" and "BUG FOUND" as `not_started`.
2. THE Reporting_System SHALL classify ClickUp statuses "IN PROGRESS" and "PULL REQUEST" as `active`.
3. THE Reporting_System SHALL classify ClickUp statuses "COMPLETE" and "TESTING" as `done/In QA`.
4. THE Reporting_System SHALL classify ClickUp status "DONE" as `closed/Completed`.
5. IF a ClickUp task has a status not present in the Status_Classification mapping, THEN THE Reporting_System SHALL log a warning and classify the task as `not_started` by default.

---

### Requirement 13: Subtask Handling

**User Story:** As an engineering manager, I want subtasks tracked as standalone items with parent task references, so that I get granular visibility without double-counting metrics.

#### Acceptance Criteria

1. THE Sync_Lambda SHALL fetch subtasks independently from the ClickUp API and store each subtask as a separate Task_Snapshot.
2. THE Reporting_System SHALL include a Parent Task reference field in each subtask Task_Snapshot linking to the parent task's `clickup_task_id`.
3. THE Reporting_System SHALL include an `is_subtask` boolean flag in each Task_Snapshot.
4. THE Reporting_System SHALL count subtasks as standalone items in all report metrics and not double-count metrics from both the parent task and the subtask.

---

### Requirement 14: MongoDB Data Persistence

**User Story:** As an engineering manager, I want all task data and report metadata persisted in MongoDB Atlas, so that the system has a reliable data store for historical analysis and report generation.

#### Acceptance Criteria

1. THE Reporting_System SHALL maintain the following MongoDB collections: `raw_tasks`, `task_snapshots`, `developers`, `teams`, `report_snapshots`, `sync_cursors`, and `sla_config`.
2. THE Reporting_System SHALL create a unique index on `clickup_task_id` in the `raw_tasks` collection.
3. THE Reporting_System SHALL create a unique index on `clickup_user_id` in the `developers` collection.
4. THE Reporting_System SHALL use a shared MongoDB connection pool across all Lambda invocations within the shared Lambda Layer.
5. THE Reporting_System SHALL store the MongoDB connection string in AWS Secrets Manager and retrieve it at Lambda cold start.

---

### Requirement 15: Google Sheets Authentication

**User Story:** As an engineering manager, I want the system to authenticate with Google APIs using my delegated OAuth2 credentials, so that spreadsheets are owned by my account and accessible to me directly.

#### Acceptance Criteria

1. THE Sheets_Client SHALL authenticate with Google Sheets API v4 and Google Drive API v3 using OAuth2 credentials delegated to the manager's Google account.
2. THE Sheets_Client SHALL store the OAuth2 refresh token in AWS Secrets Manager.
3. WHEN the OAuth2 access token expires, THE Sheets_Client SHALL use the stored refresh token to obtain a new access token automatically.
4. THE Sheets_Client SHALL grant Editor access to the automation service account on all created spreadsheets via the Google Drive API.
5. WHEN the Sheets_Client encounters a Google API 429 response, THE Sheets_Client SHALL apply exponential backoff with a maximum of 3 retries.

---

### Requirement 16: Security and Secrets Management

**User Story:** As an engineering manager, I want all credentials and secrets managed securely, so that the system follows security best practices and protects sensitive data.

#### Acceptance Criteria

1. THE Reporting_System SHALL store all secrets (ClickUp API token, MongoDB connection string, Google OAuth2 refresh token, API Gateway API keys) in AWS Secrets Manager.
2. THE Reporting_System SHALL assign a dedicated IAM role to each Lambda function following the principle of least privilege.
3. THE Reporting_System SHALL enforce HTTPS with TLS 1.2 or higher for all external API communication.
4. THE Reporting_System SHALL exclude all Personally Identifiable Information from structured log output.
5. THE Reporting_System SHALL protect the API Gateway endpoints (`/reports/generate` and `/reports/backfill`) with API key authentication.
6. THE Reporting_System SHALL configure MongoDB Atlas IP allowlisting restricted to the Lambda NAT Gateway Elastic IP addresses.

---

### Requirement 17: Error Handling and Resilience

**User Story:** As an engineering manager, I want the system to handle errors gracefully and continue processing where possible, so that a single failure does not block the entire reporting pipeline.

#### Acceptance Criteria

1. THE Reporting_System SHALL wrap all Lambda handler logic in try/catch blocks and log errors as structured JSON via Pino.
2. IF a report generation fails for a specific developer, THEN THE Reporting_System SHALL log the failure, record it in the Report_Snapshot, and continue processing remaining developers.
3. THE Reporting_System SHALL configure an SQS Dead Letter Queue for each Lambda function to capture failed invocations.
4. WHEN the ClickUp_Client encounters a 429 response, THE ClickUp_Client SHALL retry with exponential backoff and jitter, starting at 2 seconds, for a maximum of 5 retries.
5. WHEN the Sheets_Client encounters a 429 response, THE Sheets_Client SHALL retry with exponential backoff for a maximum of 3 retries.
6. THE Reporting_System SHALL persist failed report run metadata (error message, stack trace, timestamp) to the `report_snapshots` collection with a `failed` status.

---

### Requirement 18: Observability and Monitoring

**User Story:** As an engineering manager, I want structured logging, custom metrics, and CloudWatch alarms, so that I can monitor system health and diagnose issues quickly.

#### Acceptance Criteria

1. THE Reporting_System SHALL use Pino for all logging, outputting structured JSON logs with no PII.
2. THE Reporting_System SHALL emit the following custom CloudWatch metrics: `ReportGenerationDurationMs`, `TasksFetched`, `SheetsRowsWritten`, and `ChartsCreated`.
3. THE Reporting_System SHALL configure CloudWatch alarms for: Lambda error rate exceeding a defined threshold, Lambda duration exceeding 80% of the configured timeout, DLQ message count exceeding zero, and sync staleness exceeding 60 minutes.
4. THE Reporting_System SHALL include a correlation ID in all log entries for a single report generation invocation to enable end-to-end tracing.

---

### Requirement 19: Infrastructure as Code and Deployment

**User Story:** As an engineering manager, I want the entire infrastructure defined as code and deployed via CI/CD, so that deployments are repeatable, auditable, and automated.

#### Acceptance Criteria

1. THE Reporting_System SHALL define all AWS resources (Lambda functions, Lambda Layers, EventBridge rules, API Gateway, SQS DLQs, IAM roles) using AWS SAM templates.
2. THE Reporting_System SHALL support two deployment environments: staging (deployed from the `develop` branch) and production (deployed from the `main` branch).
3. WHEN code is pushed to the `develop` branch, THE CI/CD pipeline SHALL automatically deploy to the staging environment via GitHub Actions.
4. WHEN code is merged to the `main` branch, THE CI/CD pipeline SHALL automatically deploy to the production environment via GitHub Actions.
5. THE CI/CD pipeline SHALL run linting (ESLint), formatting checks (Prettier), and unit tests (Jest) before deployment.
6. THE Reporting_System SHALL configure each Lambda function with the specified memory and timeout: Daily_Report_Lambda (512 MB, 5 min), Weekly_Report_Lambda (512 MB, 10 min), Monthly_Report_Lambda (1024 MB, 15 min), Manual_Trigger_Lambda (1024 MB, 15 min), Backfill_Lambda (1024 MB, 15 min), Sync_Lambda (512 MB, 10 min).

---

### Requirement 20: Configuration Management

**User Story:** As an engineering manager, I want system behavior configurable via external files and database records, so that thresholds and settings can be adjusted without code changes.

#### Acceptance Criteria

1. THE Reporting_System SHALL read ClickUp space and list inclusion/exclusion rules from a `spaces.config.json` file.
2. THE Reporting_System SHALL read SLA and at-risk flagging thresholds from a `sla.config.json` file and the `sla_config` MongoDB collection.
3. WHEN both `sla.config.json` and the `sla_config` MongoDB collection contain a value for the same threshold, THE Reporting_System SHALL use the MongoDB value as the authoritative source.
4. THE Reporting_System SHALL support the following configurable thresholds: inactivity days (default 3), open-task days (default 7), rework count flag (default 2), backfill concurrency (default 2), and workload imbalance percentage (default 35%).

---

### Requirement 21: Shared Lambda Layer

**User Story:** As a developer, I want shared code packaged in a Lambda Layer, so that all Lambda functions reuse common logic without duplication.

#### Acceptance Criteria

1. THE Reporting_System SHALL package the following modules in a shared Lambda Layer: MongoDB connection pool manager, ClickUp_Client, Sheets_Client, report builder, chart builder, common TypeScript types, date utilities (using date-fns), and Pino logger configuration.
2. THE Reporting_System SHALL version the Lambda Layer and reference the layer version in each Lambda function's SAM configuration.
3. WHEN the shared layer code is updated, THE CI/CD pipeline SHALL publish a new layer version and update all Lambda function references.

---

### Requirement 22: ClickUp API Authentication and Configuration

**User Story:** As a developer, I want ClickUp API authentication handled centrally with configurable workspace settings, so that all API calls are authenticated consistently.

#### Acceptance Criteria

1. THE ClickUp_Client SHALL authenticate all requests to the ClickUp REST API v2 using a Personal API token sent in the `Authorization` header.
2. THE ClickUp_Client SHALL retrieve the ClickUp API token from AWS Secrets Manager at Lambda cold start and cache it for the duration of the invocation.
3. THE ClickUp_Client SHALL use `https://api.clickup.com/api/v2` as the base URL for all API requests.
4. THE ClickUp_Client SHALL support the following ClickUp API endpoints: `/team`, `/team/{teamId}/space`, `/space/{spaceId}/folder`, `/folder/{folderId}/list`, `/space/{spaceId}/list`, `/list/{listId}/task`, `/task/{taskId}`, `/task/{taskId}/time_in_status`, `/team/{teamId}/time_entries`, and `/team/{teamId}/member`.
