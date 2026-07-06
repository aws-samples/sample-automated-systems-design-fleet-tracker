# React Dashboard Guide

The React Dashboard is a demonstration interface for testing and validating the Fleet Tracking Platform. It provides live vehicle positions, job dispatch, and basic analytics — enough to verify the system end-to-end before integrating with your own dispatch software.

> **Note**: This dashboard is intended for demo and testing. For production use, integrate the platform's REST and WebSocket APIs with your existing dispatch system. See the [CLI & Developer Guide](./cli-developer.md) for API details.

---

## Access

```bash
# Get the CloudFront URL
aws cloudformation describe-stacks --stack-name FleetHostingStack \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" --output text

# Get the demo password
aws secretsmanager get-secret-value --secret-id fleet-tracking/demo-user-password \
  --query SecretString --output text | jq -r .password
```

Login with email `demo@fleet-tracking.local` and the password from Secrets Manager.

If your IP changes, the WAF allowlist will block you — run `./scripts/update-ip-allowlist.sh` to refresh it.

---

## What the dashboard shows

### Fleet map (main view)

The central map renders vehicle positions in real time using MapLibre GL JS over Amazon Location Service map tiles. Vehicles update via the WebSocket connection — the connection indicator in the header shows `● Live` when active or `○ Reconnecting...` when disconnected.

### Vehicle list

Left sidebar listing all vehicles with their status badge, current speed, and time since last update. Clicking a vehicle selects it and centers the map.

**Status values** (matching the platform's vehicle state lifecycle):

| Status | Meaning | Badge color |
|--------|---------|-------------|
| `available` | Idle, ready for dispatch | Blue |
| `moving` | En route or actively driving | Green |
| `stopped` | Parked / not moving | Orange |
| `offline` | No GPS update for >5 minutes | Red |

### Vehicle detail panel

Opens when a vehicle is selected. Shows current position, speed, heading, last-update timestamp, and assigned technician (if any). If the vehicle has an active job, the destination and ETA appear here.

### Dispatch panel

Create new delivery jobs. The form expects:

- **Vehicle**: Selected from the dropdown of available vehicles
- **Address**: Destination address (will be geocoded by Amazon Location Service)

The platform creates a geofence around the destination, calculates an ETA using the Routes API, and updates the vehicle status to `en-route`. When the vehicle enters the geofence, the status flips automatically based on geofence ENTER events.

> The current dispatch form does not include priority, notes, or driver fields. The underlying `/jobs POST` API accepts an optional `description` field — extend the dispatch panel to expose it if needed.

### Analytics panel

Pulls aggregate metrics from `/analytics/jobs`, `/analytics/utilization`, and `/analytics/routes`. Returns whatever the daily aggregation Lambda has rolled up. Empty if no analytics aggregations have run yet (the aggregator Lambda runs on a daily schedule at midnight UTC).

### Historical track

Replay a vehicle's GPS history. Calls `/vehicles/{id}/history` and renders the path as a polyline on the map.

---

## Authentication

The dashboard uses Cognito (User Pool + Identity Pool) via AWS Amplify:

- **User Pool** authenticates the demo user (`demo@fleet-tracking.local`)
- **Identity Pool** issues temporary AWS credentials so the browser can sign Location Service map tile requests directly

Tokens are valid for 1 hour. The dashboard uses `fetchAuthSession()` from `aws-amplify/auth` to get fresh tokens for both REST and WebSocket calls.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     CloudFront CDN                          │
│              (dynamic — see CDK outputs)                    │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      S3 Static Hosting                      │
│                    (React Build Assets)                     │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   REST API      │ │  WebSocket API  │ │    Cognito      │
│  (Vehicle Data) │ │ (Real-time GPS) │ │ (Authentication)│
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

CloudFront is fronted by AWS WAF with an IP allowlist (your deployer IP, plus any added via `update-ip-allowlist.sh`). HTTPS is provided by the default `*.cloudfront.net` certificate (no custom domain).

### API endpoints used

| Endpoint | Method | Component |
|----------|--------|-----------|
| `/vehicles` | GET | Vehicle list, fleet map |
| `/vehicles/{id}` | GET | Vehicle detail panel |
| `/vehicles/{id}/history` | GET | Historical track replay |
| `/vehicles/{id}/eta?destination=...` | GET | Dispatch panel ETA preview |
| `/jobs` | POST | Dispatch panel — create job |
| `/analytics/jobs` | GET | Analytics panel |
| `/analytics/utilization` | GET | Analytics panel |
| `/analytics/routes` | GET | Analytics panel |

### WebSocket connection

The dashboard connects with the Cognito ID token in the query string:

```javascript
const ws = new WebSocket(`${WS_URL}?token=${idToken}`);
```

The `$connect` Lambda validates the token. After connecting, vehicle updates arrive as messages:

```json
{
  "type": "VEHICLE_UPDATE",
  "data": {
    "vehicleId": "vehicle-001",
    "position": { "lat": 40.7128, "lng": -74.0060 },
    "heading": 180,
    "speed": 45,
    "status": "moving",
    "ignition": true
  },
  "timestamp": "2026-03-25T14:30:00Z"
}
```

---

## Local development

```bash
cd dashboard
npm install
npm run dev
```

Vite serves the dev server on `http://localhost:5173`. The dev server reads the same `dashboard/.env` file that `deploy-dashboard.sh` writes — so deploy at least once before running `npm run dev` so the env file exists.

### Environment variables

`deploy-dashboard.sh` writes these from CloudFormation outputs:

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | REST API endpoint |
| `VITE_WS_URL` | WebSocket API endpoint |
| `VITE_USER_POOL_ID` | Cognito user pool ID |
| `VITE_USER_POOL_CLIENT_ID` | Cognito app client ID |
| `VITE_IDENTITY_POOL_ID` | Cognito identity pool ID (for Location Service map credentials) |
| `VITE_AWS_REGION` | AWS region |

---

## Production build & deployment

```bash
./scripts/deploy-dashboard.sh
```

The script:
1. Pulls API and Cognito values from CloudFormation outputs
2. Writes them to `dashboard/.env`
3. Runs `npm run build` (Vite production build)
4. Syncs `dashboard/dist/` to the S3 bucket
5. Invalidates the CloudFront cache (`/*`)

Invalidation takes 5–15 minutes to complete in the background, but the dashboard files are uploaded immediately.

---

## Troubleshooting

### Dashboard won't load

- **WAF blocking your IP**: Run `./scripts/update-ip-allowlist.sh`
- **CloudFront still propagating**: First-time deploys take a few minutes
- **Cached old build**: Hard refresh with `Cmd+Shift+R` (macOS) or `Ctrl+Shift+R`

### Vehicles missing from the map

- **Simulator not running**: Vehicles only appear when GPS data is flowing
- **WebSocket disconnected**: Check the connection indicator in the header
- **REST API failed initial fetch**: Open browser devtools → Network → look for the `/vehicles` request

### Map tiles not loading

- **Identity Pool credentials missing**: The Cognito Identity Pool must grant `geo:GetMapTile` and related permissions for the `fleet-map` resource. The CDK stack handles this — if you see permission errors, redeploy `FleetApiStack`.
- **Wrong region**: `VITE_AWS_REGION` must match the region where Location Service is deployed.

### Authentication errors

- **Token expired**: Sign out and sign in again (1-hour validity)
- **Invalid credentials**: Pull the password again from Secrets Manager
- **MFA prompt unexpected**: The demo user pool has MFA set to `OPTIONAL` — first login may prompt you to skip or set up MFA

### Real-time updates stop arriving

- The WebSocket connection retries automatically on disconnect
- If the indicator stays on `○ Reconnecting...`, refresh the page
- Check `WsBroadcastLambda` logs — it should be invoked on every DynamoDB stream record from `vehicle-current-state`

---

## Browser support

The dashboard uses modern web APIs (WebSocket, ES2020, MapLibre GL JS) and was tested against:

- Chrome / Edge 90+
- Firefox 88+
- Safari 14+
