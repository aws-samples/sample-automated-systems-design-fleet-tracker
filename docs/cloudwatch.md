# CloudWatch Monitoring Guide

The Fleet Tracking Platform deploys a CloudWatch dashboard and a set of alarms automatically as part of the core infrastructure. This document describes what's deployed, how each signal is calculated, and how to extend the monitoring.

## AWS documentation

- [Amazon CloudWatch User Guide](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/WhatIsCloudWatch.html)
- [CloudWatch Dashboards](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Dashboards.html)
- [CloudWatch Alarms](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html)
- [CloudWatch Metrics](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/working_with_metrics.html)
- [CloudWatch Anomaly Detection](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Anomaly_Detection.html)

## Dashboard URL

```bash
aws cloudformation describe-stacks --stack-name FleetMonitoringStack \
  --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue" --output text
```

The dashboard is named `fleet-tracking-operations`.

### Row 1: Key business metrics

| Widget | Metric | Purpose |
|--------|--------|---------|
| Jobs Completed (24h) | `FleetTracking/JobsCompleted` | Track delivery completions |
| Active Vehicles | `FleetTracking/ActiveVehicles` | Vehicles reporting GPS in the last 5 minutes |
| GPS Updates/min | `AWS/Kinesis/IncomingRecords` | Data ingestion rate |
| Alarm Status | Composite of all 6 alarms | Quick health check |

### Row 2: IoT and data ingestion

| Widget | Metrics | Purpose |
|--------|---------|---------|
| Kinesis Ingestion Rate | Kinesis IncomingRecords | GPS data volume |
| Kinesis Stream Health | IncomingRecords, GetRecords, IteratorAge | Stream processing health |
| Location Service Updates | AWS/Location CallCount | Position update frequency |

### Row 3: Lambda performance (Fleet-scoped via SEARCH)

These widgets use CloudWatch SEARCH expressions to scope to Lambdas whose names contain "Fleet" — automatically discovering all Fleet Lambda functions without enumerating them.

| Widget | Metrics | Purpose |
|--------|---------|---------|
| Lambda Invocations (Fleet Functions) | Per-function Invocations | Processing volume |
| Lambda Duration (Fleet Functions) | Per-function Duration (Average) | Performance monitoring |
| Lambda Errors & Throttles (Fleet Functions) | Aggregated Errors and Throttles | Error detection |

### Row 4: API Gateway & DynamoDB

| Widget | Metrics | Purpose |
|--------|---------|---------|
| API Gateway Requests & Latency | Count, Latency p50/p99 | API performance |
| API Gateway Errors | 4xx, 5xx errors | Error tracking |
| DynamoDB Capacity | WCU, RCU consumption | Database load (subset of tables) |

### Row 5: WebSocket & Notifications

| Widget | Metrics | Purpose |
|--------|---------|---------|
| WebSocket Connections | ConnectCount, MessageCount | Real-time client activity |
| SNS Notifications | MessagesPublished, Delivered | Job completion notifications |
| SQS Dead Letter Queues | Three DLQs (IoT Rules, GPS Processor, Job Completion) | Failed message tracking |

## Configured alarms

All alarms publish to the `fleet-ops-alerts` SNS topic. Subscribe an email address to that topic to receive notifications.

### 1. fleet-kinesis-consumer-lag

- **Metric:** `GetRecords.IteratorAgeMilliseconds` Maximum
- **Threshold:** > 60,000 ms (60 seconds)
- **Purpose:** Detect processing delays in GPS data
- **Note:** 60 seconds is loose for a real-time fleet system. Consider tightening to 10–20 seconds for production.

### 2. fleet-lambda-error-rate

- **Metric:** `AWS/Lambda/Errors` Sum (account-wide)
- **Threshold:** > 10 errors in 5 minutes
- **Purpose:** Detect Lambda function failures
- **Caveat:** CloudWatch Alarms do not support `SEARCH` expressions, so this aggregates across all Lambdas in the account. Dashboard widgets are properly scoped via SEARCH but the alarm cannot be. Acceptable for a demo with no other Lambdas.

### 3. fleet-api-5xx-errors

- **Metric:** `AWS/ApiGateway/5XXError` Sum, dimension `ApiName=fleet-tracking-api`
- **Threshold:** > 10 errors in 5 minutes
- **Purpose:** Detect REST API server errors

### 4. fleet-iot-rules-dlq-messages

- **Metric:** `ApproximateNumberOfMessagesVisible` Maximum on `fleet-iot-rules-dlq`
- **Threshold:** ≥ 1 message, 2 evaluation periods
- **Purpose:** Detect IoT-to-Kinesis routing failures

### 5. fleet-gps-processor-dlq-messages

- **Metric:** `ApproximateNumberOfMessagesVisible` Maximum on `fleet-gps-processor-dlq`
- **Threshold:** ≥ 1 message, 2 evaluation periods
- **Purpose:** Detect GPS Processor Lambda failures after retries

### 6. fleet-job-completion-dlq-messages

- **Metric:** `ApproximateNumberOfMessagesVisible` Maximum on `fleet-job-completion-dlq`
- **Threshold:** ≥ 1 message, 2 evaluation periods
- **Purpose:** Detect SNS-to-email-processor delivery failures

## Setup instructions

### Prerequisites

- AWS Console access with CloudWatch permissions
- Core platform deployed (`cd infra && npx cdk deploy --all`)

### Subscribe to alarm notifications

```bash
TOPIC_ARN=$(aws cloudformation describe-stacks --stack-name FleetMonitoringStack \
  --query "Stacks[0].Outputs[?OutputKey=='OpsTopicArn'].OutputValue" --output text)

aws sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol email \
  --notification-endpoint your-email@example.com
```

Confirm the subscription by clicking the link in the email AWS sends.

### Viewing the dashboard

1. Open the dashboard URL from the CDK output
2. Choose a time range (1h, 3h, 12h, 1d, 1w) or set a custom range
3. Enable **Auto refresh** for live monitoring

### Creating custom alarms

Example — alarm on high API p99 latency:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
TOPIC_ARN="arn:aws:sns:${AWS_REGION:-us-east-1}:${ACCOUNT_ID}:fleet-ops-alerts"

aws cloudwatch put-metric-alarm \
  --alarm-name "fleet-api-high-latency" \
  --metric-name "Latency" \
  --namespace "AWS/ApiGateway" \
  --dimensions Name=ApiName,Value=fleet-tracking-api \
  --extended-statistic p99 \
  --period 300 \
  --threshold 5000 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 \
  --alarm-actions "$TOPIC_ARN"
```

## Custom metrics

The platform emits custom metrics to the `FleetTracking` namespace:

| Metric | Description | Emitted by | Dimensions |
|--------|-------------|-----------|------------|
| `JobsCompleted` | Delivery job completions | `geofence-handler` Lambda on geofence ENTER | TenantId, VehicleId (and dimensionless aggregate) |
| `ActiveVehicles` | Vehicles reporting GPS in the last 5 minutes | `active-vehicles-counter` Lambda on a 1-minute schedule | None |
| `GeofenceEvents` | Entry/exit events | `geofence-handler` Lambda | EventType, GeofenceId |

A second namespace, `FleetTracking/Analytics`, is emitted by the `analytics-aggregator` Lambda for `JobsProcessed` and `AggregationDuration`.

### Querying custom metrics

```bash
# Get JobsCompleted for last 24 hours
aws cloudwatch get-metric-statistics \
  --namespace FleetTracking \
  --metric-name JobsCompleted \
  --start-time $(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 3600 \
  --statistics Sum
```

## Troubleshooting

### Dashboard shows no data

1. **Time range** — make sure the selected period actually has activity
2. **Verify metric exists** — `aws cloudwatch list-metrics --namespace FleetTracking`
3. **Check SEARCH expression results** — `aws cloudwatch get-metric-data` with the dashboard's expression

### Alarms not triggering

1. **Verify threshold** — check whether the metric actually exceeds the threshold via `get-metric-statistics`
2. **Check SNS subscription** — confirm email subscription is confirmed
3. **Review alarm state** — `aws cloudwatch describe-alarms --alarm-names fleet-kinesis-consumer-lag`

### Missing custom metrics

1. **Check Lambda logs** — verify the emitting Lambda is running and the `PutMetricData` call succeeds
2. **Verify IAM permissions** — emitting Lambdas need `cloudwatch:PutMetricData` (scoped to the `FleetTracking` namespace)
3. **Wait for propagation** — new metrics can take 1–2 minutes to appear in the dashboard

## Best practices

1. **Use Metric Math** for derived metrics (error rates, percentages, aggregates)
2. **Set appropriate periods** — 1 minute for real-time, 5 minutes for trends
3. **Configure anomaly detection** for baseline-dependent metrics (e.g., GPS update rate)
4. **Use composite alarms** to reduce alert fatigue when multiple alarms fire together
5. **Export logs to S3** for long-term retention and ad-hoc analysis with Athena
