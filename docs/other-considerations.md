# Other Considerations: Fleet Tracking Platform

This document compares the Fleet Tracking Platform demo with the [AWS Guidance for Connected Mobility](https://docs.aws.amazon.com/guidance/latest/connected-mobility-on-aws/solution-overview.html) and provides guidance on quotas, limitations, cost considerations, and potential enhancements.

## Table of Contents

- [Comparison with AWS Connected Mobility Guidance](#comparison-with-aws-connected-mobility-guidance)
- [Service Comparisons: This Demo vs. Production Alternatives](#service-comparisons-this-demo-vs-production-alternatives)
- [Cost Considerations](#cost-considerations)
- [Hidden Challenges and Pitfalls](#hidden-challenges-and-pitfalls)
- [AWS Service Quotas and Limits](#aws-service-quotas-and-limits)
- [Security Considerations](#security-considerations)
- [Additional Resources](#additional-resources)

---

## Comparison with AWS Connected Mobility Guidance

### Architecture Comparison

| Component | This Demo | AWS Connected Mobility Guidance |
|-----------|-----------|--------------------------------|
| **Telemetry Ingestion** | AWS IoT Core → Kinesis Data Streams | AWS IoT Core → Amazon MSK (Kafka) |
| **Stream Processing** | Lambda (Kinesis consumer) | Apache Flink (stateful) |
| **Geofencing** | Amazon Location Service API | Flink in-stream evaluation |
| **Data Storage** | DynamoDB (hot, 24h TTL); S3 archive bucket provisioned but not yet wired | DynamoDB + ElastiCache Redis + S3 |
| **Real-time Updates** | WebSocket API (API Gateway) | WebSocket API |
| **Vehicle Data Sources** | MQTT Direct only | MQTT Direct + FWE Edge Agent (open-source cloud components) + OEM APIs |
| **Deployment** | 7 CDK stacks (~25 min) | Phase-based CDK deployment (~33–50 min per AWS docs) |
| **Costs (20 trucks)** | ~$27/month (production) | N/A (designed for 100+) |
| **Costs (100 vehicles)** | ~$85/month (production) | ~$265/month |
| **Costs (1,000 vehicles)** | Not recommended | ~$400/month |

### The Key Difference: Geofencing Architecture

**This is the critical architectural difference that affects cost at scale.**

**This Demo**: Calls Amazon Location Service API for each GPS position to evaluate geofences. Location Service charges per position write ($0.05/1K) and per geofence evaluation ($0.16/1K). Even with proximity-based optimization (only evaluating positions near active job sites), this becomes expensive beyond 200 vehicles.

**Scaling Alternative**: Replace Location Service API calls with Apache Flink using geospatial libraries like [Apache Sedona](https://sedona.apache.org/latest/sedonaflink/). Geofence boundaries are loaded into Flink state, and each position is evaluated in-memory using functions like `ST_Contains(polygon, point)`—no per-position API calls. Location Service is then only used for map tile rendering.

Flink has a fixed infrastructure cost (~$150–200/month minimum) regardless of fleet size. This makes it expensive per-vehicle at small scale but very economical at large scale — the crossover point is around 200 vehicles.

### When to Use Each Approach

| Fleet Size | Recommendation |
|------------|----------------|
| 20-200 vehicles | ✅ This solution (serverless, pay-per-use) |
| 200-500 vehicles | Either works; evaluate based on growth plans |
| 500+ vehicles | ✅ Connected Mobility Guidance or Flink-based geofencing |

### Scaling Path: From This Demo to Flink-Based Geofencing

If you start with this demo and need to scale beyond 200 vehicles:

1. **Keep**: IoT Core, DynamoDB, API Gateway, WebSocket broadcast
2. **Add**: Amazon MSK + Apache Flink for stream processing
3. **Replace**: Location Service geofence API calls → Flink in-stream geofence evaluation (using Apache Sedona's `ST_Contains`/`ST_Within` functions)
4. **Keep**: Location Service for map rendering only

The Connected Mobility Guidance provides a reference implementation for this architecture.

---

## Service Comparisons: This Demo vs. Production Alternatives

This section explains why this demo uses certain services and when you should consider upgrading to production alternatives. All pricing is based on official AWS documentation for the us-east-1 region.

### 1. Stream Processing: Kinesis + Lambda vs. MSK + Flink

#### This Demo Uses: Kinesis Data Streams + Lambda

**Why Kinesis + Lambda works for small fleets:**

- **Batching**: Kinesis delivers 10 records per Lambda invocation instead of triggering 10 separate invocations
- **Buffering**: Kinesis absorbs traffic spikes and reduces Lambda throttling
- **Replay**: 24-hour retention by default, configurable up to 365 days
- **Multiple consumers**: You can attach an analytics consumer to the same stream later without touching the ingestion path
- **Partial batch failure**: A bad record is retried without replaying the whole batch, via `reportBatchItemFailures` on the event source mapping plus a handler that returns the failed sequence numbers
- **Simple operations**: No cluster management, patching, or broker configuration

**Capacity mode matters more than it looks.** This stack defaults to **one provisioned
shard**, not on-demand (`infra/lib/ingestion-stack.ts`). On-demand bills a flat
stream-hour charge regardless of how little you send — roughly **$29/month** versus
**~$11/month** for a single provisioned shard. On a tuned 20-vehicle deployment that one
line item would cost more than every other pipeline service combined.

One provisioned shard carries **1 MB/sec or 1,000 records/sec**. Twenty vehicles
reporting every 5 seconds is 4–20 records/sec, and 100 vehicles is about 20/sec, so a
single shard has substantial headroom:

```bash
# Add provisioned capacity
cd infra && npx cdk deploy --all --context kinesisShards=4

# Switch to on-demand — only worth it for genuinely spiky, unpredictable traffic
cd infra && npx cdk deploy --all --context kinesisOnDemand=true
```

**Cost example (20 vehicles, 5-second updates):**
- Kinesis, 1 provisioned shard: ~$10.99/month (fixed — does not scale with fleet size)
- Lambda (requests + compute): ~$0.42/month
- **Total: ~$11.41/month**, of which ~96% is the fixed shard charge

#### Production Alternative: Amazon MSK + Apache Flink

**Why upgrade to MSK + Flink at scale:**

- **Higher Throughput**: Per [MSK documentation](https://docs.aws.amazon.com/msk/latest/developerguide/what-is-msk.html), a single kafka.m5.large broker can handle hundreds of MB/s. Kinesis shards are limited to 1 MB/s write and 2 MB/s read per shard.
- **Multiple Consumers**: Kafka supports unlimited consumer groups reading the same data independently. Kinesis limits you to 5 GetRecords calls per shard per second (shared across all consumers) unless using Enhanced Fan-Out.
- **Stateful Processing**: Per [Managed Flink documentation](https://docs.aws.amazon.com/managed-flink/latest/java/how-pricing.html), Flink applications maintain state across events, enabling complex analytics like trip detection, windowed aggregations, and pattern matching that Lambda cannot efficiently perform.
- **Replay Capability**: Kafka retains messages for configurable periods (days to weeks), allowing reprocessing of historical data.

---

### 2. Data Storage: DynamoDB vs. DynamoDB + ElastiCache

#### This Demo Uses: DynamoDB Only

**Why DynamoDB alone works for small fleets:**

- **Single-Digit Millisecond Latency**: Per [DynamoDB documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html)
- **On-Demand Billing**: No capacity planning. 
- **Built-in Streams**: DynamoDB Streams trigger Lambda functions for real-time WebSocket broadcasts without additional infrastructure.

#### Production Alternative: DynamoDB + ElastiCache for Redis

**Cost Example (1,000 trucks, high-traffic dashboard):**
- ElastiCache: cache.t3.medium at $0.068/hour = ~$50/month (fixed)
- DynamoDB writes: ~$99/month (158,400 × 1,000 × $0.625/million)
- DynamoDB storage: ~$3/month (~12.5 GB × $0.25/GB)
- DynamoDB reads: ~$2/month (reduced 80-90% by caching)
- **Total with caching: ~$154/month**

**When to Add Redis:**
- Dashboard has 50+ concurrent users
- Read-to-write ratio exceeds 10:1
- P99 latency requirements under 5ms

**References:**
- [DynamoDB Pricing](https://aws.amazon.com/dynamodb/pricing/)
- [ElastiCache Pricing](https://aws.amazon.com/elasticache/pricing/)
- [DynamoDB Performance](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html)

---

### 3. Telemetry Sources: MQTT Direct vs. Connected Mobility Open-Source Data Collection

#### This Demo Uses: MQTT Direct Only

**Why MQTT Direct works for basic GPS tracking:**

- **Simple Integration**: GPS devices publish JSON directly to IoT Core topics. No additional AWS services required.
- **Low Latency**: Direct MQTT connection provides sub-second message delivery.
- **Flexible Payload**: Define your own JSON schema for GPS data.
- **No Per-Vehicle Fees**: IoT Core charges per message ($1.00 per million messages), not per vehicle.

#### Production Alternative: Connected Mobility on AWS (Open-Source)

> **Note:** AWS IoT FleetWise (the managed service) will no longer accept new customers after **April 30, 2026**. The Connected Mobility on AWS open-source solution replaces the managed service with open-source cloud-side components while retaining the same FleetWise Edge Agent (FWE).

**Why upgrade to Connected Mobility open-source data collection:**

- **Dynamic Data Collection**: Per the [Connected Mobility Guidance](https://docs.aws.amazon.com/guidance/latest/connected-mobility-on-aws/solution-overview.html), campaigns "control what data the edge agent collects and when...without touching the vehicle software."
- **Signal Catalogs**: Standardized vehicle signal definitions following COVESA Vehicle Signal Specification (VSS), managed via the open-source console.
- **Protobuf Encoding**: More compact than JSON, reducing cellular data costs by 50-70%.
- **CAN Bus Integration**: Collect raw vehicle diagnostics (engine codes, tire pressure, fuel level) not available via basic GPS.
- **No Per-Vehicle License Fees**: Unlike the former managed FleetWise service, the open-source approach has no per-vehicle fees. You pay for infrastructure (MSK + Flink).

**Cost Example (1,000 trucks with Connected Mobility open-source):**
- MSK (Serverless or Provisioned): ~$194-460/month depending on configuration
- Flink: ~$161-324/month depending on KPUs
- IoT Core messaging: still applies (reduced volume due to Protobuf)
- **Total infrastructure cost: ~$355-784/month** (scales with throughput, not vehicle count)

*The open-source approach eliminates the per-vehicle license fee ($0.60/vehicle/month) that the managed FleetWise service charged. Instead, costs are infrastructure-based (MSK + Flink) and scale with data throughput rather than fleet size. Protobuf encoding reduces cellular data usage, which may lower cellular bills for data-heavy fleets.*

**When to Use Connected Mobility Open-Source Data Collection:**
- Need vehicle diagnostics beyond GPS (OBD-II data)
- Want to dynamically change data collection without device updates
- Operating vehicles with CAN bus access
- Cellular data costs are significant
- Want to avoid per-vehicle license fees

**References:**
- [Connected Mobility on AWS - GitHub](https://github.com/aws-solutions-library-samples/guidance-for-connected-mobility-on-aws)
- [Connected Mobility on AWS - Docs](https://docs.aws.amazon.com/guidance/latest/connected-mobility-on-aws/solution-overview.html)
- [IoT Core Pricing](https://aws.amazon.com/iot-core/pricing/)

---

### 4. Storage tiers: let the query pattern decide

Pick a tier based on the question you're asking of the data, not on data volume. Three tiers cover the range:

| Storage | Use case | Retention | Access pattern |
|---|---|---|---|
| [**Amazon DynamoDB**](https://aws.amazon.com/dynamodb/) | Current state, recent history | Hours to days | Point lookups, real-time |
| [**Amazon Timestream for InfluxDB**](https://docs.aws.amazon.com/timestream/latest/developerguide/influxdb3.html) | Time-series analytics | Weeks to months | Aggregations, trends |
| [**Amazon S3**](https://aws.amazon.com/s3/) + [**Amazon Athena**](https://aws.amazon.com/athena/) | Archive, AI/ML training | Months to years | Batch queries, as needed |

**"Where is vehicle-001 right now?" / "What were its last few positions?"** — point lookups on recent data. This is what the stack deploys: DynamoDB gives [single-digit-millisecond reads](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html) by key, and the 24-hour TTL on `gps-history` expires rows automatically so you aren't paying to store history you don't query. For a small fleet this is frequently the only tier required.

- DynamoDB storage for 24-hour retention at 20 vehicles: well under 1 GB, ~$0.25/month
- No additional service to operate

**"What was average speed by route last week?" / "Show a heat map of stops this month."** — aggregations over time ranges, which DynamoDB does not specialize in at scale. That's the signal to add **Amazon Timestream for InfluxDB**, which is purpose-built for time-range aggregations and gives you SQL and InfluxQL over months of history without an ETL pipeline.

Note the trade-off: Timestream for InfluxDB runs on **provisioned DB instances**, which removes the serverless property of the rest of this stack. That may be acceptable overhead for the analytical benefit. If keeping the architecture serverless matters more, DynamoDB plus S3 and Athena delivers a similar analytical experience with per-query billing instead of an always-on instance.

**"Train an ML model on a year of trips." / "Retain raw data for compliance."** — infrequent, large-scale batch reads over long retention. Holding that in DynamoDB or a time-series database is expensive for data you rarely touch. Archive to S3 (~$0.023/GB/month) and query with Athena, where storage is cheap and you pay per query.

> The stack provisions an S3 archive bucket (`fleet-gps-archive-<account>`) with SSE-S3 encryption, versioning, and a lifecycle rule that transitions to Infrequent Access at 30 days — but **nothing writes to it yet**. Wire up a [DynamoDB export to S3](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/S3DataExport.HowItWorks.html) or a Firehose consumer on the Kinesis stream before treating it as a live archive tier.

**References:**
- [DynamoDB TTL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)
- [Amazon Timestream for InfluxDB](https://docs.aws.amazon.com/timestream/latest/developerguide/influxdb3.html)
- [Querying S3 data with Athena](https://docs.aws.amazon.com/athena/latest/ug/what-is.html)

---

### 5. Additional Services to Consider

#### AWS IoT Device Defender
**Why**: Security monitoring for IoT devices. Detects anomalous behavior and audits IoT policies.
- **Cost**: $0.0011/device/month (audit) + $0.25/1000 metrics (per-truck)
- **When to Add**: Production deployments with security compliance requirements

#### Amazon SageMaker
**Why**: Predictive analytics (ETA prediction, route optimization, predictive maintenance).
- **Cost**: Variable (training + inference endpoints, starting ~$0.05/hour for ml.t2.medium) (fixed)
- **When to Add**: After collecting 3-6 months of historical data for model training

#### AWS AppSync
**Why**: GraphQL API for flexible queries and real-time subscriptions.
- **Cost**: $4/million queries + $2/million real-time updates (per-truck)
- **When to Add**: Mobile app development or complex query requirements

**References:**
- [IoT Device Defender Pricing](https://aws.amazon.com/iot-device-defender/pricing/)
- [SageMaker Pricing](https://aws.amazon.com/sagemaker/pricing/)
- [AppSync Pricing](https://aws.amazon.com/appsync/pricing/)

---

## Cost Considerations

> **Pricing Note**: All costs are estimates based on official AWS pricing at time of writing for the us-east-1 region. AWS pricing changes over time—verify current rates via the [AWS Pricing Calculator](https://calculator.aws/) before budgeting. Amazon Location Service no longer publishes per-unit rates on their pricing page; use the Pricing Calculator or contact AWS for current rates. Costs shown here include a 200,000 position/month free tier for Location Service that may offset initial costs.

This section breaks down costs for both the **demo configuration** (sends all GPS positions to Location Service) and **production-optimized deployment** (uses proximity-based geofencing). The demo shows the art of the possible; production deployments would only evaluate geofences when vehicles are near active job sites.

Costs are organized into three categories:
1. **Per-Truck AWS Costs** — Scale linearly with fleet size (usage-based)
2. **Fixed AWS Costs** — Same regardless of fleet size (licenses, dashboards, base infrastructure)
3. **Non-AWS Costs** — Hardware, cellular, installation (not included in AWS totals)

---

### Calculation Basis (20 trucks)

| Metric | Calculation | Result |
|--------|-------------|--------|
| Updates per truck per day | 12/min × 60 min × 10 hours | 7,200 |
| Updates per truck per month | 7,200 × 22 days | 158,400 |
| Total fleet messages/month | 158,400 × 20 trucks | 3,168,000 |
| Message payload size | ~500 bytes JSON | ~1.5 GB/month |
| Connection time per truck | 10 hours × 22 days × 60 min | 13,200 min/month |
| Total connection minutes | 13,200 × 20 trucks | 264,000 min/month |

---

### Demo Configuration: AWS Costs

The demo, as deployed, reports every 5 seconds and sends every position to Location Service. Useful for demonstrating real-time arrival detection,
expensive to leave running.

Two clocks drive this bill. Devices publish on a timer for the whole 10-hour shift, which
sets the pipeline volume (3,168,000 messages/month at 20 vehicles). But `DistanceBased`
filtering discards movement under 30 m, so **Location Service only bills while a vehicle is
driving** — 4 of those 10 hours here, or 1,267,200 positions.

| Line item | Demo (5 s, no proximity filter) | Production (30 s, proximity filter) |
|---|---|---|
| IoT Core messaging (Basic Ingest) | $0.00 | $0.00 |
| IoT Core connectivity | $0.02 | $0.02 |
| IoT Core rules + actions (2 each per ping) | $1.90 | $0.32 |
| Kinesis Data Streams (1 provisioned shard) | $10.99 | $10.99 |
| Lambda (requests + compute) | $0.42 | $0.09 |
| DynamoDB writes | $5.94 | $0.99 |
| DynamoDB Streams reads | $0.13 | $0.00 |
| **Location tracker writes** | **$51.85** | **$2.11** |
| **Location geofence evaluations** | **$151.89** | **$6.76** |
| Location routes + geocodes (per job) | $2.64 | $2.64 |
| Location geofence create/delete | $0.18 | $0.18 |
| API Gateway WebSocket messages | $6.34 | $1.06 |
| API Gateway WebSocket connection-minutes | $0.01 | $0.01 |
| CloudWatch Logs (ingest + storage) | $0.67 | $0.11 |
| CloudWatch metrics + 6 alarms | $2.23 | $2.23 |
| **Total (20 vehicles)** | **~$235/mo** | **~$27/mo** |
| **Per vehicle** | **~$11.76** | **~$1.37** |

Basis: 20 vehicles, 10-hour connected shift, 4 hours driving, 4 jobs/vehicle/day, 22
days/month, 2 concurrent dashboards, us-east-1 on-demand rates. Excludes AWS WAF
(~$16/mo fixed), CloudFront, Cognito, Secrets Manager, X-Ray, DynamoDB PITR, and the
analytics and multi-tenancy stacks. Lambda duration, log volume, and the share of driving
spent near a job site are estimates.

*Location Service is ~88% of the demo bill because each position is charged twice, once as
a tracker write and again as a geofence evaluation. Once tuned it drops to ~43%, and the
Kinesis shard becomes ~40%.*

---

### Production-Optimized: two settings

The production column above comes from two simulator settings. Neither requires an
architectural change. Check the reporting interval before any architectural change — it
sets how many positions exist to be billed, so it moves the total further than anything
else.

**1. Reporting interval, 5 s to 30 s.** Sets how many positions exist to be billed, so it
moves the total further than anything else — about a 78% cut to Location Service. Dispatchers
rarely notice the difference on a map.

```bash
PUBLISH_INTERVAL=30000 ./scripts/start-simulator.sh
```

**2. Proximity filtering.** Only send positions to the tracker when a vehicle is near its
assigned job destination or home base. The decision is made **on the device**, which already
received the destination in its dispatch command — no server-side lookup and no Lambda in the
path. Doing it server-side would mean `get_dynamodb()` in the rule's `WHERE` clause, billed
per message like a rule action and limited to one call per statement.

```bash
LOCATION_PROXIMITY_FILTER=true ./scripts/start-simulator.sh
```

Keep the proximity radius (`LOCATION_PROXIMITY_RADIUS_M`, default 2000) comfortably wider
than your geofences. ENTER/EXIT events are derived from position updates, so filtering too
tightly suppresses the EXIT event as a vehicle drives away.

`npm run simulator:production` applies both settings together.

A third lever is not a simulator setting at all: confirm the Kinesis stream is on **one
provisioned shard** rather than on-demand. See [Stream Processing](#1-stream-processing-kinesis--lambda-vs-msk--flink)
above — on a tuned deployment, on-demand would cost more than every other pipeline
service combined.

### Fixed AWS Costs (Not Per-Truck)

These costs remain constant regardless of fleet size. They are license fees, dashboard costs, or base infrastructure.

| Service | Monthly Cost | Notes | Reference |
|---------|-------------|-------|-----------|
| **CloudWatch** | ~$3.60 | 1 dashboard + 6 alarms + ~5 GB log ingestion (mostly within free tier) | [CloudWatch Pricing](https://aws.amazon.com/cloudwatch/pricing/) |
| - Dashboard | $3.00 | 1 dashboard × $3/month | |
| - Alarms | $0.60 | 6 alarms × $0.10/alarm | |
| - Custom metrics | ~$0.60 | ~12 metric streams for a 5-vehicle demo (`JobsCompleted` carries per-vehicle dimensions); first 10 are free, then $0.30 each | |
| - Logs | $0.00 | Demo workload typically stays within the 5 GB ingestion free tier | |
| **Secrets Manager** | $0.40 | 1 secret (demo user password) × $0.40/month | [Secrets Manager Pricing](https://aws.amazon.com/secrets-manager/pricing/) |
| **S3** | $0.50 | Static dashboard hosting | [S3 Pricing](https://aws.amazon.com/s3/pricing/) |
| **CloudFront** | $1.00 | Dashboard CDN (minimal traffic) | [CloudFront Pricing](https://aws.amazon.com/cloudfront/pricing/) |
| **Cognito** | $0.00 | First 50,000 MAUs free | [Cognito Pricing](https://aws.amazon.com/cognito/pricing/) |
| **Fixed Subtotal (core)** | **~$5.50** | Same for 1 truck or 1,000 trucks. | |

---

### Total AWS costs summary

| Configuration | 20 Trucks | Per Truck | 100 Trucks | Per Truck |
|---|---|---|---|---|
| **Demo** — as deployed (5 s, all positions to Location Service) | ~$235 | ~$11.76 | ~$858 | ~$8.58 |
| **Production** — 30 s, proximity filtering | ~$27 | ~$1.37 | ~$85 | ~$0.85 |

Per-truck cost falls as the fleet grows because Location Service pricing is tiered and several charges are fixed. Note the composition shifts too: Location Service is ~88% of the demo bill but only ~43% once tuned, at which point the Kinesis shard is ~40%.

---

### Cost optimization strategies

**Per-truck cost reductions:**
1. **Proximity-based geofencing**: Only send positions to Location Service when near active job sites — 80–95% reduction in Location Service costs
2. **Location Service filtering**: Distance-based filtering (only update if device moved ≥30m) reduces position writes for parked vehicles
3. **Reduce update frequency**: 10-second updates instead of 5-second cuts per-truck telemetry costs roughly in half
4. **Lambda ARM64 (Graviton)**: ~20% cheaper than x86 with equivalent performance — switch by setting `architecture: lambda.Architecture.ARM_64` on Lambda functions
5. **Batch API calls**: Reduce API Gateway costs by batching vehicle queries client-side

**Fixed cost reductions:**
1. **Log retention**: Reduce CloudWatch log retention from 30 days to 7 days
2. **Alarm consolidation**: Combine related alarms via composite alarms to reduce alarm count
3. **Dashboard count**: Each CloudWatch dashboard beyond the first three costs $3/month. Consolidate rather than splitting by team.

**At scale (500+ trucks):**
1. **Reserved capacity**: 30–50% savings for predictable workloads (MSK, ElastiCache)
2. **S3 Intelligent-Tiering**: Automatic cost optimization for GPS archives
3. **Move stream processing to MSK + Flink**: Fixed Flink/MSK costs become more economical than per-message Kinesis + Lambda at scale

### Location Service filtering modes

Beyond proximity-based geofencing, Amazon Location Service offers built-in filtering modes that further reduce position write costs:

| Filtering Mode | Description | Best For |
|----------------|-------------|----------|
| `DistanceBased` | Movement under 30 m — **ignored updates are neither stored nor evaluated**, so both cost dimensions drop | Parked and slow-moving vehicles. This is what the stack deploys. |
| `AccuracyBased` | Movement under the device's reported accuracy | Hardware that reports an accuracy value. Not usable with the native Location rule action, which sends no accuracy. |
| `TimeBased` (service default) | Nothing | Only thins **stored** positions; every update is still evaluated against geofences and billed. Do not pick this expecting savings. |

Combining proximity-based geofencing with `DistanceBased` filtering provides the best cost optimization for production deployments.

### Scaling cost projections (production-optimized)

| Fleet Size | Messages/Month | Location Service | Other AWS | Fixed | Total AWS | Per Truck |
|------------|----------------|------------------|-----------|-------|-----------|-----------|
| 20 trucks  | 3.17M          | ~$21–42          | ~$17      | $5.50 | ~$45–65   | ~$2.25–3.25 |
| 50 trucks  | 7.92M          | ~$53–105         | ~$42      | $5.50 | ~$100–155 | ~$2.00–3.10 |
| 100 trucks | 15.84M         | ~$105–210        | ~$85      | $5.50 | ~$195–300 | ~$1.95–3.00 |
| 200 trucks | 31.68M         | ~$210–420        | ~$170     | $5.50 | ~$385–595 | ~$1.95–3.00 |
| 500 trucks | 79.2M          | ~$525–1,050      | ~$425     | $5.50 | ~$955–1,480 | ~$1.90–2.95 |

*Production-optimized costs assume 10–20% of positions are evaluated against geofences. Fixed costs assume the core platform only — any optional integration you layer on (Amazon Managed Grafana, ServiceNow, analytics services) is additional.*

---

## Hidden challenges and pitfalls

These challenges aren't visible from the demo configuration but become critical when running a real fleet at production scale. They're documented here so the trade-offs are clear before you scale up.

### 1. Data volume explosion

**Problem**: Without intelligent data collection, storage and transfer costs can spiral quickly. Fleets collecting 300+ data points per vehicle (engine diagnostics, accelerometer, video) can generate 100x more data than basic GPS tracking.

**Mitigation**:
- Use rules-based data collection (e.g., Connected Mobility campaigns) that only transmit when conditions are met
- Implement edge filtering to reduce cellular data transfer
- Set appropriate TTLs on historical data; archive cold data to S3 Glacier

**This demo**: Sends GPS only at 5-second intervals, so the data volume is bounded.

### 2. Protocol heterogeneity in mixed fleets

**Problem**: Different vehicle makes and models use different CAN bus protocols. Standardizing 300+ data points across a mixed fleet is a major upfront effort.

**Mitigation**:
- Invest early in signal catalogs and decoder manifests
- Use the COVESA Vehicle Signal Specification (VSS) for standardization
- Plan for ongoing maintenance as new vehicle models are added

**This demo**: Uses a simple JSON schema for GPS data — no decoder manifests required.

### 3. Non-linear cost scaling

**Problem**: Costs don't scale linearly with fleet size. Message frequency and data richness have outsized impact on costs.

| Factor | Cost Impact |
|--------|-------------|
| Fleet size 2x | Costs ~2x |
| Update frequency 2x | Costs ~2x |
| Data richness 2x | Costs ~4x (storage + processing + transfer) |

**Mitigation**:
- Model costs carefully before adding telemetry signals or increasing frequency
- Use adaptive reporting intervals (faster when moving, slower when parked)
- Implement data tiering (hot/warm/cold storage)

### 4. ELD/HoS compliance (US commercial vehicles)

**Problem**: FMCSA Electronic Logging Device (ELD) mandate and Hours of Service (HoS) rules add hard constraints. Ignoring them means fines up to $16,000 per violation.

**Requirements**:
- Automatic recording of driving time
- Driver identification and authentication
- Tamper-resistant data recording
- Data transfer to enforcement officials

**Mitigation**:
- Integrate ELD compliance into route optimization
- Account for mandatory rest periods in dispatch planning
- Ensure GPS hardware is ELD-certified if required

**This demo**: Does not include ELD compliance. Production systems for commercial trucking must address this. See [FMCSA ELD Requirements](https://www.fmcsa.dot.gov/hours-service/elds/electronic-logging-devices).

### 5. Connectivity gaps

**Problem**: Vehicles operate in areas with poor or no cellular coverage. Data loss during connectivity gaps can affect compliance and operations.

**Mitigation**:
- Design for disconnected operation with store-and-forward at the edge
- Use multi-channel connectivity (cellular + satellite + depot Wi-Fi)
- Implement idempotent systems with command TTLs to prevent stale commands from executing when vehicles reconnect

**This demo**: Assumes continuous connectivity. Production systems need offline resilience.

### 6. Edge deployment at scale

**Problem**: Managing firmware updates, rollbacks, and ML model drift across thousands of Telematics Control Units (TCUs) is operationally complex.

**Mitigation**:
- Use [AWS IoT Greengrass](https://docs.aws.amazon.com/greengrass/v2/developerguide/what-is-iot-greengrass.html) for edge deployment management
- Implement staged rollouts with automatic rollback
- Monitor edge device health and connectivity

### 7. Testing at scale

**Problem**: You can't test at scale with real trucks. Digital twin simulation is essential.

**Mitigation**:
- Build simulation infrastructure early — this demo includes a vehicle simulator
- Use [AWS IoT TwinMaker](https://docs.aws.amazon.com/iot-twinmaker/latest/guide/what-is-iot-twinmaker.html) for digital twin capabilities
- Test failure scenarios: connectivity loss, device failures, data corruption, clock drift

---


## AWS Service Quotas and Limits

### Critical Quotas for Fleet Tracking

#### AWS IoT Core

| Quota | Default | Adjustable | Impact |
|-------|---------|------------|--------|
| Maximum concurrent connections | 500,000 | Yes | Limits fleet size |
| Publish requests/second/connection | 100 | No | Limits update frequency |
| Inbound publish requests/second/account | 20,000 | Yes | Aggregate throughput |
| Thing groups per account | 10,000 | Yes | Fleet organization |
| Things per thing group | 100,000 | No | Group size limit |
| IoT rules per account | 1,000 | Yes | Routing rules |

**Recommendation**: For fleets > 10,000 vehicles, request quota increases before deployment.

#### Amazon Location Service

| Quota | Default | Adjustable | Impact |
|-------|---------|------------|--------|
| Geofence Collections per account | 1,500 | Yes | Multi-tenant isolation |
| Geofences per Collection | 50,000 | No | Job site limits |
| BatchUpdateDevicePosition requests/sec | 50 | Yes | Position update throughput |
| BatchEvaluateGeofences requests/sec | 50 | Yes | Geofence evaluation rate |
| CalculateRoute requests/sec | 10 | Yes | ETA calculation rate |
| Tracker resources per account | 200 | Yes | Multi-tenant trackers |

**Recommendation**: For 80 trucks at 5-second updates = 16 updates/second. Default quota (50/sec) is sufficient. Request increase for fleets > 250 vehicles.

#### Kinesis Data Streams

| Quota | Default | Adjustable | Impact |
|-------|---------|------------|--------|
| Shards per account per region | 500 | Yes | Stream capacity |
| Records per second per shard | 1,000 | No | Throughput limit |
| Data per second per shard | 1 MB | No | Payload limit |
| GetRecords per shard per second | 5 | No | Consumer throughput |

**Recommendation**: 1 shard handles ~1,000 records/second. For 80 trucks at 5-second intervals = 16 records/second. Current 1-shard configuration is sufficient up to ~300 trucks.

#### DynamoDB

| Quota | Default | Adjustable | Impact |
|-------|---------|------------|--------|
| Tables per account per region | 2,500 | Yes | Multi-tenant tables |
| Maximum item size | 400 KB | No | GPS payload limit |
| Partition throughput | 3,000 RCU / 1,000 WCU | No | Hot partition limit |
| GSIs per table | 20 | No | Query flexibility |

**Recommendation**: On-demand mode auto-scales. Monitor for hot partitions if single vehicle receives excessive updates.

#### Lambda

| Quota | Default | Adjustable | Impact |
|-------|---------|------------|--------|
| Concurrent executions | 1,000 | Yes | Processing capacity |
| Function timeout | 15 minutes | No | Long-running tasks |
| Deployment package size | 250 MB | No | Code + dependencies |
| Memory allocation | 10,240 MB | No | Processing power |

**Recommendation**: Default 1,000 concurrent executions is sufficient for most fleets. Request increase for > 5,000 vehicles.

### Requesting Quota Increases

```bash
# List current quotas
aws service-quotas list-service-quotas --service-code iot

# Request increase
aws service-quotas request-service-quota-increase \
  --service-code iot \
  --quota-code L-1234567890 \
  --desired-value 100000
```

Or use the [Service Quotas Console](https://console.aws.amazon.com/servicequotas/).

---

## Security considerations

Below are scaling-related security topics relevant to fleet operators considering production rollout. Items verified as deployed in this stack are marked ✅.

### Device security

1. **Certificate rotation**: Implement automated certificate rotation (recommended: annually). The demo uses static certificates from `provision-devices.sh`; production fleets need rotation infrastructure.
2. **Device attestation**: Use [AWS IoT Device Defender](https://docs.aws.amazon.com/iot-device-defender/latest/devguide/what-is-device-defender.html) to verify device identity and audit IoT policies.
3. **Secure boot**: Production GPS hardware should support secure boot to prevent tampering — not configurable from AWS.
4. **Firmware updates**: Only accept signed OTA updates. AWS IoT Jobs and Greengrass support this pattern.

### Data security

1. **Encryption at rest**: DynamoDB, S3, and Kinesis encrypt with AWS-managed keys by default ✅ (verified in this demo).
2. **Encryption in transit**: TLS 1.2+ for all connections. IoT Core requires it; API Gateway negotiates current TLS.
3. **Data residency**: Deploy to regions matching data residency requirements (e.g., GDPR for EU operations).
4. **PII handling**: GPS data may be considered PII in some jurisdictions. Review applicable regulations before storing identifiable vehicle/driver data.

### Access control

1. **Least privilege**: IoT policies use [thing policy variables](https://docs.aws.amazon.com/iot/latest/developerguide/thing-policy-variables.html) so each device can only publish to its own topic. The demo deploys this pattern ✅.
2. **Multi-tenant isolation**: For multi-tenant deployments, use the `tenantId` Cognito attribute (already in the demo's user pool) plus tenant-scoped DynamoDB queries via the GSIs deployed in `FleetPhase2TablesStack`.
3. **API authentication**: Cognito JWT tokens (1-hour expiration) enforced by API Gateway authorizer ✅.
4. **Audit logging**: CloudTrail at the account level captures all API calls. Verify it's enabled in your account before running this demo with real data.

---

## Additional resources

### AWS documentation

| Resource | Description |
|----------|-------------|
| [Connected Mobility on AWS](https://docs.aws.amazon.com/guidance/latest/connected-mobility-on-aws/solution-overview.html) | Enterprise reference architecture — Fleet Manager Console, real-time tracking, Flink-based geofencing, analytics |
| [Connected Mobility on AWS — GitHub](https://github.com/aws-solutions-library-samples/guidance-for-connected-mobility-on-aws) | Open-source CDK source for the Connected Mobility guidance |
| [Supply Chain Lens — Fleet Tracking](https://docs.aws.amazon.com/wellarchitected/latest/supply-chain-lens/transportation-visibility-and-fleet-tracking.html) | Route optimization, ELD compliance, HoS constraints, predictive maintenance |
| [Connected Mobility Well-Architected Lens](https://docs.aws.amazon.com/wellarchitected/latest/connected-mobility-lens/design-principles-ops.html) | Best practices across operational excellence, performance, reliability, security, sustainability |
| [Connected Vehicle Reference Architecture](https://docs.aws.amazon.com/architecture-diagrams/latest/aws-connected-vehicle/aws-connected-vehicle.html) | Architecture diagrams for vehicle modernization, data gathering, certificate lifecycle, mobile apps |

### Pricing and quotas

- [AWS IoT Core Quotas](https://docs.aws.amazon.com/general/latest/gr/iot-core.html#limits_iot)
- [Amazon Location Service Quotas](https://docs.aws.amazon.com/location/latest/developerguide/location-quotas.html)
- [AWS Service Quotas Console](https://console.aws.amazon.com/servicequotas/)
- [AWS Pricing Calculator](https://calculator.aws/)

### Compliance

- [FMCSA ELD Requirements](https://www.fmcsa.dot.gov/hours-service/elds/electronic-logging-devices) — US Electronic Logging Device mandate
- [ISO/SAE 21434](https://www.iso.org/standard/70918.html) — Road vehicles cybersecurity engineering
- [ISO 24089](https://www.iso.org/standard/77796.html) — Road vehicles software update engineering
