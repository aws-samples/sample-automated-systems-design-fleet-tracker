# CLI & Developer Guide

This guide covers operating the deployed Fleet Tracking Platform from the command line — calling the REST API, testing the WebSocket, running the simulator, and inspecting platform resources. For underlying AWS service docs, follow links from the [project README](../README.md).

---

## Resolve deployment values

After deploying, the runtime endpoints, IDs, and IoT endpoint live in CloudFormation outputs. Pull them once:

```bash
# REST API URL
API_URL=$(aws cloudformation describe-stacks --stack-name FleetApiStack \
  --query "Stacks[0].Outputs[?OutputKey=='RestApiUrl'].OutputValue" --output text)

# WebSocket URL
WS_URL=$(aws cloudformation describe-stacks --stack-name FleetApiStack \
  --query "Stacks[0].Outputs[?OutputKey=='WebSocketApiUrl'].OutputValue" --output text)

# Cognito IDs (for token requests)
USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name FleetApiStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
USER_POOL_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name FleetApiStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" --output text)

# IoT endpoint (for device clients)
IOT_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS \
  --query 'endpointAddress' --output text)
```

---

## Authentication

Get an ID token for the demo user:

```bash
DEMO_PASSWORD=$(aws secretsmanager get-secret-value \
  --secret-id fleet-tracking/demo-user-password \
  --query SecretString --output text | jq -r .password)

TOKEN=$(aws cognito-idp initiate-auth \
  --client-id "$USER_POOL_CLIENT_ID" \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=demo@fleet-tracking.local,PASSWORD=$DEMO_PASSWORD" \
  --query 'AuthenticationResult.IdToken' --output text)
```

Use the token in REST API calls:

```bash
curl -H "Authorization: Bearer $TOKEN" "$API_URL/vehicles" | jq '.'
```

Tokens are valid for one hour.

---

## REST API

### Vehicles

| Endpoint | Description |
|----------|-------------|
| `GET /vehicles` | List all vehicles with current positions |
| `GET /vehicles/{id}` | Single vehicle detail |
| `GET /vehicles/{id}/history?hours=N` | GPS history. `hours` must be a positive integer, defaults to 24 and is capped at 24 — the `gps-history` table has a 24-hour TTL, so a wider window returns nothing extra. Non-numeric values return 400. |
| `GET /vehicles/{id}/eta?destination=...` | Calculate ETA to a destination |

### Jobs

| Endpoint | Description |
|----------|-------------|
| `GET /jobs` | List all jobs |
| `POST /jobs` | Dispatch a new job |
| `PUT /jobs/{id}` | Update job status |

**Dispatch a job:**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "$API_URL/jobs" \
  -d '{
    "vehicleId": "vehicle-001",
    "address": "123 Main St, Huntsville, AL 35805",
    "description": "Loading dock B"
  }' | jq '.'
```

The response includes the geocoded coordinates, calculated ETA, and the geofence ID created around the destination.

---

## WebSocket

```bash
npm install -g wscat
wscat -c "$WS_URL?token=$TOKEN"
```

The token is validated on `$connect`. After connecting, you'll receive position updates and job events as they happen.

**Message format — vehicle position update:**

```json
{
  "type": "VEHICLE_UPDATE",
  "data": {
    "vehicleId": "vehicle-001",
    "position": { "lat": 40.7128, "lng": -74.0060 },
    "heading": 180,
    "speed": 45,
    "status": "en-route",
    "ignition": true
  },
  "timestamp": "2026-03-25T14:30:00Z"
}
```

**Message format — job completed:**

```json
{
  "type": "JOB_COMPLETED",
  "data": {
    "jobId": "JOB-2026-0142",
    "vehicleId": "vehicle-001",
    "completedAt": "2026-03-25T14:30:00Z"
  },
  "timestamp": "2026-03-25T14:30:00Z"
}
```

---

## Simulator

```bash
# Start with default 5-second updates
./scripts/start-simulator.sh

# Faster updates for demos (2 seconds)
PUBLISH_INTERVAL=2000 ./scripts/start-simulator.sh

# Or via npm script (5-second interval — same as the default)
npm run simulator:demo

# Production-style cost optimization: only send positions to the Location Service
# tracker when a vehicle is near its job destination or home base
LOCATION_PROXIMITY_FILTER=true ./scripts/start-simulator.sh
```

`start-simulator.sh` resolves the IoT endpoint with `aws iot describe-endpoint --endpoint-type iot:Data-ATS` unless you export `IOT_ENDPOINT` yourself, downloads the Amazon root CA if it's missing, finds per-vehicle certificates in `./certs/<vehicleId>/`, and publishes GPS updates on behalf of each demo vehicle. It reads no CloudFormation outputs.

Each vehicle publishes to two Basic Ingest topics: the ingestion rule always receives every
position, and the Location Service rule receives either every position (default) or only
nearby ones when proximity filtering is enabled.

| Variable | Default | Description |
|----------|---------|-------------|
| `PUBLISH_INTERVAL` | `5000` | Milliseconds between position updates |
| `GPS_INGEST_RULE_NAME` | `fleet_gps_to_kinesis` | IoT rule that feeds the Kinesis/DynamoDB pipeline |
| `GPS_LOCATION_RULE_NAME` | `fleet_gps_to_location` | IoT rule that writes to the Location Service tracker |
| `LOCATION_PROXIMITY_FILTER` | `false` | When `true`, only publish to the tracker rule near a point of interest |
| `LOCATION_PROXIMITY_RADIUS_M` | `2000` | Proximity radius in metres. Keep it well above your geofence radius so EXIT events still fire |

This device-side filter is the *second* layer of Location Service cost control. The first is
the tracker's own `positionFiltering`, set to `DistanceBased` in `LocationStack`, which makes
Amazon Location ignore updates under 30 m so they are neither stored nor evaluated against
geofences. To inspect it:

```bash
aws location describe-tracker --tracker-name fleet-tracker \
  --query 'PositionFiltering' --region "${AWS_REGION:-us-east-1}"
```

Do not switch it to `TimeBased` (the service default) expecting savings — that mode only
thins stored positions, and every update is still evaluated and billed. `AccuracyBased` will
not work here either, because the native Location rule action sends no accuracy value.

### Add or modify vehicles

Vehicles are defined in `src/simulator/vehicle-config.ts`. Routes are defined in `src/simulator/routes/demo-routes.json`:

| Route | Description |
|-------|-------------|
| `downtown-loop` | Urban loop with frequent turns |
| `suburban-route` | Mixed residential and commercial roads |
| `highway-route` | High-speed highway segment |

To add more vehicles:

1. Add the new vehicle ID to `FLEET_VEHICLES` in `scripts/lib/config.sh`
2. Add a matching entry in `src/simulator/vehicle-config.ts`
3. Run `./scripts/provision-devices.sh` to create their IoT certificates

### Manual GPS publish

To publish a single GPS message without the simulator:

The topic uses the [Basic Ingest](https://docs.aws.amazon.com/iot/latest/developerguide/iot-basic-ingest.html)
reserved prefix `$aws/rules/<rule-name>`, which delivers the message straight to the
`fleet_gps_to_kinesis` rule and bypasses the pub/sub message broker. Because the broker is
skipped, you can't subscribe to this topic to observe the message — check the Kinesis stream,
the GPS processor Lambda logs, or the dashboard instead.

There is a second topic for the Amazon Location Service tracker, handled by the
`fleet_gps_to_location` rule's native Location action. Publish the same payload there to
see the position land on the tracker and trigger geofence evaluation:

```bash
aws iot-data publish \
  --topic "\$aws/rules/fleet_gps_to_location/fleet/vehicles/vehicle-001/gps" \
  --payload '{"vehicleId":"vehicle-001","lat":40.7128,"lng":-74.0060,"timestampMs":'"$(date +%s)"'000}' \
  --region "${AWS_REGION:-us-east-1}"

# Confirm the tracker received it
aws location batch-get-device-position \
  --tracker-name fleet-tracker --device-ids vehicle-001 \
  --region "${AWS_REGION:-us-east-1}"
```

The Location action reads `timestampMs` (epoch milliseconds) from the payload. Trackers
ignore sample times older than 30 days.

```bash
aws iot-data publish \
  --topic "\$aws/rules/fleet_gps_to_kinesis/fleet/vehicles/vehicle-001/gps" \
  --payload "$(cat <<EOF
{
  "vehicleId": "vehicle-001",
  "lat": 40.7128,
  "lng": -74.0060,
  "speed": 35.5,
  "heading": 180,
  "ignition": true,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)" \
  --region "${AWS_REGION:-us-east-1}"
```

---

## CDK commands

```bash
cd infra

# Deploy all stacks (with deployer IP for WAF allowlist)
npx cdk deploy --all --context deployerIp=$(curl -s ifconfig.me)

# Deploy a single stack without dependencies
npx cdk deploy FleetMonitoringStack --exclusively

# View pending changes
npx cdk diff

# Destroy resources
npx cdk destroy --all
```

### Stack dependency order

```
IoTStack
  └── IngestionStack
        └── Phase2TablesStack
              └── LocationStack
                    └── ApiStack
                          ├── MonitoringStack
                          └── HostingStack
```

`MonitoringStack` depends on `ApiStack` to receive the WebSocket API for connection metrics. `HostingStack` depends on `ApiStack` for the REST API URL.

---

## Inspecting deployed resources

```bash
# List Fleet IoT Things
aws iot list-things --query 'things[?starts_with(thingName, `vehicle-`)]'

# Kinesis stream details
aws kinesis describe-stream --stream-name fleet-gps-stream

# Get a vehicle's current state
aws dynamodb get-item \
  --table-name vehicle-current-state \
  --key '{"vehicleId": {"S": "vehicle-001"}}'

# Query GPS history (most recent first)
aws dynamodb query \
  --table-name gps-history \
  --key-condition-expression "vehicleId = :v" \
  --expression-attribute-values '{":v": {"S": "vehicle-001"}}' \
  --limit 10 \
  --scan-index-forward false

# Tail a Lambda's logs (find the function name first)
GPS_FN=$(aws lambda list-functions \
  --query "Functions[?contains(FunctionName, 'GpsProcessor')].FunctionName" \
  --output text)
aws logs tail "/aws/lambda/$GPS_FN" --follow
```

---

## Scripts reference

| Script | Purpose |
|--------|---------|
| `provision-devices.sh` | Create IoT certificates for all demo vehicles |
| `start-simulator.sh` | Run the simulator |
| `deploy-dashboard.sh` | Build the React dashboard and upload to S3 + invalidate CloudFront |
| `update-ip-allowlist.sh` | Update WAF IP allowlist for the current public IP (re-run if your IP changes) |
| `pre-cleanup.sh` | Detach resources that block CDK stack deletion. Run **before** `cdk destroy --all` |
| `post-cleanup.sh` | Remove orphaned resources after CDK destroy |

All scripts source `scripts/lib/config.sh` for shared configuration (`AWS_REGION`, `FLEET_VEHICLES`, etc.).

---

## Lambda environment variables

| Variable | Description |
|----------|-------------|
| `VEHICLE_STATE_TABLE` | DynamoDB table for vehicle current state |
| `GPS_HISTORY_TABLE` | DynamoDB table for GPS history (24h TTL) |
| `DISPATCH_TABLE` | DynamoDB table for job assignments |
| `GEOFENCE_COLLECTION_NAME` | Location Service geofence collection name |
| `JOB_COMPLETION_TOPIC_ARN` | SNS topic for job completion notifications |
| `WEBSOCKET_ENDPOINT` | API Gateway Management API endpoint for WebSocket broadcasts |
| `STALE_THRESHOLD_MINUTES` | Active vehicles counter freshness threshold (default: 5) |

---

## Dashboard environment variables

`deploy-dashboard.sh` writes these to `dashboard/.env` from CloudFormation outputs:

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | REST API endpoint |
| `VITE_WS_URL` | WebSocket API endpoint |
| `VITE_USER_POOL_ID` | Cognito user pool ID |
| `VITE_USER_POOL_CLIENT_ID` | Cognito app client ID |
| `VITE_IDENTITY_POOL_ID` | Cognito identity pool ID for AWS credentials (Location Service map access) |
| `VITE_AWS_REGION` | AWS region |

---

## Common issues

### "Access Denied" on API calls

- Token expired (1-hour validity) — request a new one
- Missing `Authorization: Bearer` header
- WAF blocking your IP — run `./scripts/update-ip-allowlist.sh`

### Simulator not sending data

- Certificates missing — run `./scripts/provision-devices.sh`
- IoT endpoint changed (rare) — restart the simulator to pick up the new value
- Simulator process crashed silently — check terminal output for errors

### Dashboard shows stale data

- WebSocket disconnected — refresh the page
- Simulator stopped — check it's still running
- Browser console errors — check developer tools for connection issues
