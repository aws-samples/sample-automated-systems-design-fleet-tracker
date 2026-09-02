import * as cdk from "aws-cdk-lib";
import * as path from "path";
import * as kinesis from "aws-cdk-lib/aws-kinesis";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as eventsources from "aws-cdk-lib/aws-lambda-event-sources";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as iot from "aws-cdk-lib/aws-iot";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

// Resolve paths from this file's location so CDK works regardless of cwd
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const lambdaEntry = (p: string) => path.join(REPO_ROOT, "src", "lambdas", p);

export interface IngestionStackProps extends cdk.StackProps {}

export class IngestionStack extends cdk.Stack {
  public readonly vehicleStateTable: dynamodb.Table;
  public readonly dispatchTable: dynamodb.Table;
  public readonly gpsHistoryTable: dynamodb.Table;
  public readonly websocketConnectionsTable: dynamodb.Table;
  public readonly gpsStream: kinesis.Stream;
  public readonly iotRulesDlq: sqs.Queue;
  public readonly gpsArchiveBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: IngestionStackProps) {
    super(scope, id, props);

    // Kinesis stream for GPS data fan-out.
    //
    // Defaults to ONE PROVISIONED SHARD. A shard carries 1 MB/sec or 1,000 records/sec for
    // ~$10.95/month, and a GPS fleet needs a rounding error of that: 20 vehicles reporting
    // every 5 seconds is 4 records/sec, under half a percent of a shard. Even 100 vehicles
    // at 5 seconds uses 2%.
    //
    // On-demand would bill a flat ~$29/month stream-hour charge regardless of volume, which
    // on a tuned 20-vehicle deployment costs more than every other pipeline service
    // combined. A fleet reporting on a fixed timer has none of the unpredictability
    // on-demand exists to absorb.
    //
    //   cdk deploy --all --context kinesisShards=4      # more provisioned capacity
    //   cdk deploy --all --context kinesisOnDemand=true # spiky/unpredictable traffic
    const onDemand = this.node.tryGetContext("kinesisOnDemand") === "true";
    const kinesisShards = this.node.tryGetContext("kinesisShards");
    const shardCount = kinesisShards === undefined ? 1 : Number(kinesisShards);

    if (!Number.isInteger(shardCount) || shardCount < 1) {
      throw new Error(
        `kinesisShards context must be a positive integer, got "${kinesisShards}"`
      );
    }

    this.gpsStream = new kinesis.Stream(this, "GpsStream", {
      streamName: "fleet-gps-stream",
      retentionPeriod: cdk.Duration.hours(24),
      ...(onDemand
        ? { streamMode: kinesis.StreamMode.ON_DEMAND }
        : { streamMode: kinesis.StreamMode.PROVISIONED, shardCount }),
    });

    // DynamoDB: current vehicle state
    this.vehicleStateTable = new dynamodb.Table(this, "VehicleState", {
      tableName: "vehicle-current-state",
      partitionKey: { name: "vehicleId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // DynamoDB: dispatch assignments
    this.dispatchTable = new dynamodb.Table(this, "DispatchAssignments", {
      tableName: "dispatch-assignments",
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "vehicleId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "ttl",
    });

    // DynamoDB: GPS history for 24h track playback
    // Requirements: 6.3, 6.7 - vehicleId PK, timestamp SK, TTL for auto-expiry
    this.gpsHistoryTable = new dynamodb.Table(this, "GpsHistory", {
      tableName: "gps-history",
      partitionKey: { name: "vehicleId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "ttl",
    });

    // DynamoDB: WebSocket connections for real-time updates
    // Requirements: 5.13 - connectionId PK, TTL for auto-cleanup
    this.websocketConnectionsTable = new dynamodb.Table(this, "WebSocketConnections", {
      tableName: "websocket-connections",
      partitionKey: { name: "connectionId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "ttl",
    });

    // S3: GPS archive bucket for data beyond 24h
    // Requirements: 6.6, 8.8 - SSE-S3 encryption, block public access, versioning, lifecycle policy, enforce SSL
    this.gpsArchiveBucket = new s3.Bucket(this, "GpsArchiveBucket", {
      bucketName: `fleet-gps-archive-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Demo only - allows bucket deletion on stack destroy
      autoDeleteObjects: true, // Demo only - auto-delete objects when bucket is destroyed
      lifecycleRules: [
        {
          id: "TransitionToInfrequentAccess",
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30), // AWS requires minimum 30 days for STANDARD_IA
            },
          ],
        },
        {
          id: "ExpireOldData",
          enabled: true,
          expiration: cdk.Duration.days(90), // Delete data after 90 days (demo cleanup)
        },
        {
          id: "DeleteNoncurrentVersions",
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(30), // Clean up old versions after 30 days
        },
      ],
    });

    // DLQ for failed processing
    const dlq = new sqs.Queue(this, "GpsProcessorDLQ", {
      queueName: "fleet-gps-processor-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    // Lambda: Kinesis GPS processor
    const gpsProcessor = new lambdaNode.NodejsFunction(this, "GpsProcessor", {
      entry: lambdaEntry("gps-processor/index.ts"),
      projectRoot: REPO_ROOT,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        VEHICLE_STATE_TABLE: this.vehicleStateTable.tableName,
        GPS_HISTORY_TABLE: this.gpsHistoryTable.tableName,
      },
    });

    this.vehicleStateTable.grantWriteData(gpsProcessor);
    this.gpsHistoryTable.grantWriteData(gpsProcessor);

    // Note: this Lambda no longer writes to the Location Service tracker. Positions
    // reach the tracker through the native `location` IoT rule action defined in
    // LocationStack, so no geo: permissions are needed here.

    // Requirements: 2.5, 2.6, 2.7, 6.4 - Configure batch size 10, 5s window
    gpsProcessor.addEventSource(
      new eventsources.KinesisEventSource(this.gpsStream, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        bisectBatchOnError: true,
        retryAttempts: 3,
        reportBatchItemFailures: true,
        onFailure: new eventsources.SqsDlq(dlq),
      })
    );

    // IoT Rules Engine - Route GPS messages to Kinesis and Location Service
    // Requirements: 2.3, 2.4, 2.8

    // DLQ for failed IoT Rule actions
    this.iotRulesDlq = new sqs.Queue(this, "IoTRulesDLQ", {
      queueName: "fleet-iot-rules-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    // IAM Role for IoT Rules to access Kinesis
    const iotKinesisRole = new iam.Role(this, "IoTKinesisRole", {
      assumedBy: new iam.ServicePrincipal("iot.amazonaws.com"),
      description: "Role for IoT Rules to write to Kinesis Data Streams",
    });

    this.gpsStream.grantWrite(iotKinesisRole);

    // IAM Role for IoT Rules to send to DLQ
    const iotDlqRole = new iam.Role(this, "IoTDlqRole", {
      assumedBy: new iam.ServicePrincipal("iot.amazonaws.com"),
      description: "Role for IoT Rules to send failed messages to DLQ",
    });

    this.iotRulesDlq.grantSendMessages(iotDlqRole);

    // IoT Rule: Route GPS messages to Kinesis Data Streams
    // Devices publish via Basic Ingest to
    //   $aws/rules/fleet_gps_to_kinesis/fleet/vehicles/<vehicleId>/gps
    // which invokes this rule directly and bypasses the pub/sub message broker.
    // IoT strips the $aws/rules/<rule-name> prefix before SQL evaluation, so the FROM
    // filter and topic(3) below still resolve against the fleet/vehicles/+/gps suffix.
    // The FROM clause is kept (rather than omitted, which Basic Ingest allows) so the
    // rule also still works if a message arrives over a standard broker topic.
    // Routes all GPS data to Kinesis for processing by Lambda consumer
    new iot.CfnTopicRule(this, "GpsToKinesisRule", {
      ruleName: "fleet_gps_to_kinesis",
      topicRulePayload: {
        description: "Route GPS messages from vehicles to Kinesis Data Streams",
        sql: "SELECT *, topic(3) as vehicleId, timestamp() as serverTimestamp FROM 'fleet/vehicles/+/gps'",
        awsIotSqlVersion: "2016-03-23",
        actions: [
          {
            kinesis: {
              streamName: this.gpsStream.streamName,
              partitionKey: "${topic(3)}",
              roleArn: iotKinesisRole.roleArn,
            },
          },
        ],
        errorAction: {
          sqs: {
            queueUrl: this.iotRulesDlq.queueUrl,
            roleArn: iotDlqRole.roleArn,
            useBase64: false,
          },
        },
        ruleDisabled: false,
      },
    });

    // Note: Position updates to the Location Service tracker are handled by the
    // native `location` IoT rule action (see GpsToLocationRule in LocationStack),
    // not by this rule and not by the GPS Processor Lambda. Devices publish to a
    // separate Basic Ingest topic for that rule, which keeps the Location path
    // independently filterable while this rule receives every position.

    // =========================================================================
    // Active Vehicles Counter
    // =========================================================================
    // Scans vehicle-current-state on a schedule and emits the count of vehicles
    // whose lastSeen is within the stale threshold as the FleetTracking/ActiveVehicles
    // CloudWatch metric. This replaces the per-batch counting that the GPS processor
    // previously did, which only reflected Kinesis batching, not actual fleet activity.
    const activeVehiclesCounter = new lambdaNode.NodejsFunction(this, "ActiveVehiclesCounter", {
      projectRoot: REPO_ROOT,
      entry: lambdaEntry("active-vehicles-counter/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        VEHICLE_STATE_TABLE: this.vehicleStateTable.tableName,
        STALE_THRESHOLD_MINUTES: "5",
      },
    });

    this.vehicleStateTable.grantReadData(activeVehiclesCounter);

    // Scoped CloudWatch metric publishing — only the FleetTracking namespace.
    // cloudwatch:PutMetricData does not support resource-level permissions.
    activeVehiclesCounter.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "cloudwatch:namespace": "FleetTracking",
          },
        },
      })
    );

    // Schedule: emit the metric every minute
    new events.Rule(this, "ActiveVehiclesCounterSchedule", {
      ruleName: "fleet-active-vehicles-counter",
      description: "Emits the FleetTracking/ActiveVehicles metric every minute",
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(activeVehiclesCounter)],
    });
  }
}
