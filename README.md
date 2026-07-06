# Fleet Tracking Platform — Implementation Guide

A real-time GPS fleet tracking backend built on AWS serverless services, designed for small to medium fleets (20–200 vehicles). This repository contains the complete infrastructure-as-code, Lambda handlers, vehicle simulator, and demo dashboard.

---

## Prerequisites

Before you begin, make sure you have the following installed and configured:

| Requirement | Notes |
|-------------|-------|
| **AWS account** | With permissions to deploy IoT Core, Kinesis, DynamoDB, Lambda, Location Service, Cognito, API Gateway, CloudFront, S3, WAF, CloudWatch, SNS, and Secrets Manager. |
| **AWS CLI v2** | Configured with credentials for target AWS account |
| **Node.js 20.x or later** | Includes `npm`. |
| **AWS CDK** | Invoked via `npx cdk`. The account/region must be bootstrapped once  |
| **jq** | Used by the provisioning and cleanup scripts. |
| **curl** | Used to detect your public IP for WAF allowlisting. |

> **Note:** This is a deployed AWS application, not a local-only app. Running it provisions real AWS resources that incur cost. Tear everything down with the [Cleanup](#cleanup) steps when you're done.

---

## Quick start

```bash
# 1. Install dependencies
npm install
cd infra && npm install && cd ..
cd src && npm install && cd ..
cd dashboard && npm install && cd ..

# 2. Set your deployment region (defaults to us-east-1)
export AWS_REGION="${AWS_REGION:-us-east-1}"

# 3. Bootstrap CDK (first time only)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap aws://${ACCOUNT_ID}/${AWS_REGION}

# 4. Deploy all stacks
# Gather both IPv4 and IPv6 — clients may reach CloudFront over either, and
# IPv6 addresses rotate on macOS (privacy extensions). Either may be empty.
cd infra
IPV4=$(curl -4 -s --max-time 5 ifconfig.me || true)
IPV6=$(curl -6 -s --max-time 5 ifconfig.me || true)
npx cdk deploy --all \
  --context deployerIpv4=$IPV4 \
  --context deployerIpv6=$IPV6 \
  --require-approval never
cd ..

# 5. Provision device certificates and deploy dashboard
./scripts/provision-devices.sh
./scripts/deploy-dashboard.sh

# 6. Start the simulator
./scripts/start-simulator.sh
```

> **Seeing a white page or MIME-type errors in the browser?** Your IP has likely changed since the last deploy. Run `./scripts/update-ip-allowlist.sh` to refresh the WAF allowlists for both IPv4 and IPv6, then hard-refresh the dashboard (Cmd+Shift+R).

---

## Table of contents

- [What gets deployed](#what-gets-deployed)
- [Architecture](#architecture)
- [Dispatch system integration](#dispatch-system-integration)
- [Monitoring and alerting](#monitoring-and-alerting)
- [Cost summary](#cost-summary)
- [Cleanup](#cleanup)
- [Optional extensions](#optional-extensions)
- [Documentation deep dives](#documentation-deep-dives)

---

## What gets deployed

The `cdk deploy --all` command deploys seven stacks:

| Stack | What it creates |
|-------|-----------------|
| **FleetIoTStack** | IoT Core thing groups, device policies, topic rules |
| **FleetIngestionStack** | Kinesis Data Stream, DynamoDB tables (vehicle state, GPS history, dispatch), GPS Processor Lambda |
| **FleetPhase2TablesStack** | Multi-tenant tables, analytics aggregation, GSIs on core tables |
| **FleetLocationStack** | Amazon Location Service tracker, geofence collection, geofence handler Lambda |
| **FleetMonitoringStack** | CloudWatch dashboard, alarms, SNS alerting topic |
| **FleetApiStack** | REST API, WebSocket API, Cognito user pool, vehicle/tenant/analytics Lambdas |
| **FleetHostingStack** | S3 bucket, CloudFront distribution, WAF rules for the demo dashboard |

### Post-deployment access

**Demo dashboard:**
```bash
aws cloudformation describe-stacks --stack-name FleetHostingStack \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" --output text
```

**Demo credentials:**
```bash
# Email: demo@fleet-tracking.local
# Password:
aws secretsmanager get-secret-value --secret-id fleet-tracking/demo-user-password \
  --query SecretString --output text | jq -r .password
```

**CloudWatch dashboard:**
```bash
aws cloudformation describe-stacks --stack-name FleetMonitoringStack \
  --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue" --output text
```

---

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  GPS Device     │────▶│  IoT Core    │────▶│  Kinesis Stream │────▶│  GPS Processor  │
│  (per truck)    │MQTT │  MQTT Broker │Rule │  (buffering)    │Batch│  Lambda         │
└─────────────────┘     └──────┬───────┘     └─────────────────┘     └────────┬────────┘
                               │                                              │
                               │ MQTT (job commands)                          │ writes
                               │                                              ▼
┌─────────────────┐     ┌──────┴───────┐                            ┌─────────────────┐
│ Dispatch Board  │◀────│  WebSocket   │◀───────────────────────────│     DynamoDB    │
│  (your system)  │push │  Broadcast   │        DynamoDB Stream     │(vehicle & state)│
└────────┬────────┘     └──────────────┘                            └─────────────────┘
         │
         │ REST API
         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Vehicle API    │────▶│ Location Service│────▶│    Geofence     │
│  (Lambda)       │     │ (tracker)       │     │   Detection     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

The GPS Processor Lambda performs three operations per message: upsert vehicle state, write position history, and send to Location Service for geofence evaluation. Location Service failures are isolated, DynamoDB writes always succeed regardless of tracker availability.

> **Why Kinesis between IoT Rule and Lambda?** Batching efficiency (10 records per invocation vs. 10 separate invocations), traffic spike buffering, 24-hour replay capability, partial batch failure handling, metrics captured, and support for multiple consumers on the same stream.

---

## Dispatch system integration

The platform provides two integration patterns. For complete API reference and code examples, see the [CLI & Developer Guide](./docs/cli-developer.md).

### REST API

```bash
GET  /vehicles                    # All vehicles with current positions
GET  /vehicles/{id}               # Single vehicle detail
GET  /vehicles/{id}/history       # Historical track (24h)
POST /jobs                        # Dispatch a job
```

**Example — dispatch a job:**
```bash
POST /jobs
{
  "address": "123 Technology Dr, Huntsville, AL 35805",
  "vehicleId": "vehicle-001",
  "description": "Loading dock B, call on arrival"
}

# Response:
{
  "jobId": "JOB-2026-0142",
  "vehicleId": "vehicle-001",
  "coordinates": { "lat": 34.7304, "lng": -86.5861 },
  "eta": "2026-03-25T15:45:00Z",
  "geofenceId": "job-JOB-2026-0142"
}
```

### WebSocket (real-time push)

The WebSocket endpoint requires a Cognito ID token in the query string:

```javascript
const ws = new WebSocket(`wss://{ws-api-id}.execute-api.{region}.amazonaws.com/v1?token=${idToken}`);

ws.onmessage = (event) => {
  const update = JSON.parse(event.data);
  updateVehicleOnMap(update.data.vehicleId, update.data.position.lat, update.data.position.lng);
  updateVehicleStatus(update.data.vehicleId, update.data.status);
};
```

### Vehicle status lifecycle

The platform tracks vehicles through a status lifecycle with automatic transitions on geofence events:

```
available → en-route → on-site → returning → available
                          ▲                     ▲
                          │                     │
                     Geofence ENTER       Geofence EXIT
                     (automatic)          (automatic)
```

The dashboard shows simplified status badges (`available`, `moving`, `stopped`, `offline`) computed from this lifecycle plus the GPS update freshness. Dispatchers see arrival in real time without manual check-in from drivers.

---

## Monitoring and alerting

The `FleetMonitoringStack` creates a CloudWatch dashboard (`fleet-tracking-operations`) with:
- GPS message throughput and processing latency
- Kinesis stream health and consumer lag
- API Gateway response times and error rates
- Lambda invocations, duration (p50/p99), errors, and throttles
- DynamoDB capacity consumption
- WebSocket connection counts
- SNS notification delivery
- SQS dead letter queue depth

### Alarms

Six alarms are deployed, all publishing to the `fleet-ops-alerts` SNS topic:

- **Kinesis consumer lag** — iterator age > 60 seconds
- **Lambda error rate** — > 10 errors in 5 minutes
- **API Gateway 5xx errors** — > 10 in 5 minutes
- **IoT Rules DLQ** — ≥ 1 message (2 evaluation periods)
- **GPS Processor DLQ** — ≥ 1 message (2 evaluation periods)
- **Job Completion DLQ** — ≥ 1 message (2 evaluation periods)

See [CloudWatch Monitoring Guide](./docs/cloudwatch.md) for thresholds, custom metrics, and how to subscribe an email to the SNS topic.

---

## Cost summary

> All estimates based on us-east-1 pricing. Verify current rates via the [AWS Pricing Calculator](https://calculator.aws/).

**Basis:** 5-second GPS updates, 10-hour days, 22 days/month (~158K messages/vehicle/month).

| Configuration | 20 vehicles | 100 vehicles | Per vehicle |
|---------------|-------------|--------------|-------------|
| **Demo** (all positions to Location Service) | ~$236/mo | ~$1,140/mo | ~$11.40–11.80 |
| **Production** (proximity-based geofencing) | ~$45–63/mo | ~$155–235/mo | ~$1.55–3.15 |

The demo configuration sends every GPS position to Amazon Location Service, which useful for showcasing real-time arrival detection, but Location Service ends up being ~87% of the bill. Production deployments only evaluate geofences when vehicles are near active job sites, reducing Location Service costs by 80–95%.

**Additional non-AWS costs** (not included): GPS hardware (~$60–150/unit), cellular data (~$5–15/vehicle/month), professional installation if hardwired.

> For detailed per-service breakdowns and optimization strategies, see [Other Considerations](./docs/other-considerations.md).

---
 
## Cleanup

```bash
# 1. Stop the simulator (Ctrl+C if running)

# 2. Detach IoT resources that block CDK deletion
./scripts/pre-cleanup.sh

# 3. Destroy all CDK stacks
cd infra && npx cdk destroy --all --force && cd ..

# 4. Remove orphaned resources (certificates, log groups, S3 buckets)
./scripts/post-cleanup.sh
```

> **Note:** If your IP changes and the dashboard becomes inaccessible or shows a white screen, run `./scripts/update-ip-allowlist.sh` to refresh the WAF allowlists for both protocols. `deploy-dashboard.sh` also calls this script automatically before each upload.

---

## Optional extensions

The core platform exposes the integration points (CloudWatch metrics and alarms, the `fleet-ops-alerts` SNS topic, raw GPS data in DynamoDB and Kinesis) so you can layer on additional tools without modifying the core stacks. Each option below points to AWS-supported guidance rather than custom setup steps.

| Extension | What it adds | How to set it up |
|-----------|-------------|------------------|
| **Amazon Managed Grafana** | Advanced visualization over CloudWatch metrics | Follow the [AWS getting-started guide](https://docs.aws.amazon.com/grafana/latest/userguide/getting-started-with-AMG.html) to create a workspace and add [CloudWatch as a data source](https://docs.aws.amazon.com/grafana/latest/userguide/using-amazon-cloudwatch-in-AMG.html)|
| **ServiceNow incident management** | Auto-create incidents from CloudWatch alarms | Two AWS-supported patterns: [SNS → Lambda → ServiceNow REST API](https://aws.amazon.com/blogs/mt/how-to-automatically-create-an-incident-in-servicenow-from-an-amazon-cloudwatch-alarm/) (custom Lambda) or the [AWS Service Management Connector for ServiceNow](https://aws.amazon.com/blogs/mt/create-servicenow-incidents-for-amazon-cloudwatch-alarms-using-aws-service-management-connector-for-servicenow/) |
| **AI/ML and analytics** | Predictive maintenance, route optimization, dashboards, generative AI queries | The fleet platform's data flows (DynamoDB tables, Kinesis stream, S3 archive) feed the standard AWS analytics services. See [AI/ML & Analytics](./docs/ai-ml-analytics.md) for a routing guide to the right AWS pattern based on your use case |
| **Connected Mobility on AWS** | Enterprise telemetry (CAN bus, signal catalogs, OEM data) | Switch to the full [AWS Connected Mobility Guidance](https://docs.aws.amazon.com/guidance/latest/connected-mobility-on-aws/solution-overview.html) when you need richer vehicle data than GPS alone. |

---

## Documentation deep dives

| Guide | What it covers |
|-------|----------------|
| [CLI & Developer Guide](./docs/cli-developer.md) | Full API reference, authentication, integration code examples |
| [CloudWatch Monitoring](./docs/cloudwatch.md) | Operational dashboards, alarms, metric definitions |
| [React Dashboard](./docs/react-dashboard.md) | Demo web interface for testing and validation |
| [Other Considerations](./docs/other-considerations.md) | Cost optimization, scaling strategies, alternatives |

---

## Related AWS resources

- [AWS IoT for Automotive Workshop](https://catalog.workshops.aws/awsiotforautomotive/en-US) — Hands-on automotive IoT patterns
- [Connected Mobility on AWS](https://docs.aws.amazon.com/guidance/latest/connected-mobility-on-aws/solution-overview.html) — Enterprise-scale connected vehicle guidance (recommended for 200+ vehicles)
- [Connected Mobility GitHub](https://github.com/aws-solutions-library-samples/guidance-for-connected-mobility-on-aws) — Open-source reference implementation
