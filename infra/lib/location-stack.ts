import * as cdk from "aws-cdk-lib";
import * as path from "path";
import * as location from "aws-cdk-lib/aws-location";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

// Resolve paths from this file's location so CDK works regardless of cwd
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const lambdaEntry = (p: string) => path.join(REPO_ROOT, "src", "lambdas", p);

// Constant for tracker name - must match IngestionStack
const FLEET_TRACKER_NAME = "fleet-tracker";

// Task 11.11: Home base positions for demo vehicles (50-meter radius geofences)
// Requirements: 4.1, 4.2, 4.3 - Create home base geofence at vehicle starting position
const HOME_BASE_POSITIONS: { vehicleId: string; lat: number; lng: number }[] = [
  { vehicleId: "vehicle-001", lat: 37.7749, lng: -122.4194 }, // Union Square, SF
  { vehicleId: "vehicle-002", lat: 37.5585, lng: -122.2711 }, // San Mateo
  { vehicleId: "vehicle-003", lat: 37.3861, lng: -122.0839 }, // Mountain View
  { vehicleId: "vehicle-004", lat: 37.8024, lng: -122.4058 }, // North Beach, SF
  { vehicleId: "vehicle-005", lat: 37.4419, lng: -122.1430 }, // Palo Alto
];

export interface LocationStackProps extends cdk.StackProps {
  /**
   * DynamoDB table for dispatch assignments
   */
  dispatchTable: dynamodb.ITable;
  /**
   * DynamoDB table for vehicle current state
   */
  vehicleStateTable: dynamodb.ITable;
  /**
   * DynamoDB table for WebSocket connections (optional)
   */
  connectionsTable?: dynamodb.ITable;
  /**
   * WebSocket API endpoint for broadcasting updates (optional)
   */
  websocketEndpoint?: string;
  /**
   * DynamoDB table for email subscriptions (optional, for Phase 2)
   */
  emailSubscriptionsTable?: dynamodb.ITable;
  /**
   * SES verified email address for sending notifications (optional, for Phase 2)
   */
  sesFromEmail?: string;
}

export class LocationStack extends cdk.Stack {
  public readonly tracker: location.CfnTracker;
  public readonly trackerName: string;
  public readonly geofenceCollection: location.CfnGeofenceCollection;
  public readonly geofenceCollectionName: string;
  public readonly map: location.CfnMap;
  public readonly mapName: string;
  public readonly routeCalculator: location.CfnRouteCalculator;
  public readonly routeCalculatorName: string;
  public readonly placeIndex: location.CfnPlaceIndex;
  public readonly placeIndexName: string;
  public readonly geofenceHandler: lambdaNode.NodejsFunction;
  public readonly jobCompletionTopic: sns.Topic;
  public readonly jobCompletionDlq: sqs.Queue;
  public readonly emailProcessor?: lambdaNode.NodejsFunction;

  constructor(scope: Construct, id: string, props: LocationStackProps) {
    super(scope, id, props);

    const { dispatchTable, vehicleStateTable, connectionsTable, websocketEndpoint, emailSubscriptionsTable, sesFromEmail } = props;

    // Tracker for vehicle position updates with 5s time-based filtering
    this.tracker = new location.CfnTracker(this, "FleetTracker", {
      trackerName: FLEET_TRACKER_NAME,
      positionFiltering: "TimeBased",
    });
    this.trackerName = FLEET_TRACKER_NAME;

    // Geofence collection for job site boundaries
    // EventBridge must be enabled for geofence events to trigger the handler
    this.geofenceCollection = new location.CfnGeofenceCollection(this, "JobSites", {
      collectionName: "job-sites",
    });
    this.geofenceCollectionName = "job-sites";

    // Enable EventBridge integration on the geofence collection
    // This is required for Location Service to emit ENTER/EXIT events
    new cr.AwsCustomResource(this, "EnableGeofenceEventBridge", {
      onCreate: {
        service: "Location",
        action: "updateGeofenceCollection",
        parameters: {
          CollectionName: this.geofenceCollectionName,
          EventBridgeEnabled: true,
          Description: "Job site geofences with EventBridge integration",
        },
        physicalResourceId: cr.PhysicalResourceId.of("geofence-eventbridge-enabled"),
      },
      onUpdate: {
        service: "Location",
        action: "updateGeofenceCollection",
        parameters: {
          CollectionName: this.geofenceCollectionName,
          EventBridgeEnabled: true,
          Description: "Job site geofences with EventBridge integration",
        },
        physicalResourceId: cr.PhysicalResourceId.of("geofence-eventbridge-enabled"),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["geo:UpdateGeofenceCollection"],
          resources: [
            `arn:aws:geo:${this.region}:${this.account}:geofence-collection/${this.geofenceCollectionName}`,
          ],
        }),
      ]),
    }).node.addDependency(this.geofenceCollection);

    // Map resource for dispatch dashboard rendering
    this.map = new location.CfnMap(this, "FleetMap", {
      mapName: "fleet-map",
      configuration: { style: "VectorEsriNavigation" },
    });
    this.mapName = "fleet-map";

    // Route calculator for ETA calculations
    this.routeCalculator = new location.CfnRouteCalculator(this, "FleetRoutes", {
      calculatorName: "fleet-routes",
      dataSource: "Esri",
    });
    this.routeCalculatorName = "fleet-routes";

    // Place index for geocoding job addresses to coordinates
    this.placeIndex = new location.CfnPlaceIndex(this, "FleetPlaceIndex", {
      indexName: "fleet-places",
      dataSource: "Esri",
    });
    this.placeIndexName = "fleet-places";

    // Link tracker to geofence collection for automatic evaluation
    const trackerConsumer = new location.CfnTrackerConsumer(this, "TrackerToGeofences", {
      trackerName: this.tracker.trackerName!,
      consumerArn: `arn:aws:geo:${this.region}:${this.account}:geofence-collection/${this.geofenceCollection.collectionName}`,
    });

    // Ensure TrackerConsumer is created after both tracker and geofence collection
    trackerConsumer.addDependency(this.tracker);
    trackerConsumer.addDependency(this.geofenceCollection);

    // SQS Dead Letter Queue for failed SNS deliveries (Requirement 3.1)
    this.jobCompletionDlq = new sqs.Queue(this, "JobCompletionDLQ", {
      queueName: "fleet-job-completion-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    // SNS Topic for job completion notifications (Requirement 3.1)
    this.jobCompletionTopic = new sns.Topic(this, "JobCompletionTopic", {
      topicName: "fleet-job-completions",
      displayName: "Fleet Job Completion Notifications",
    });

    // Lambda: Geofence handler for ENTER events
    // Requirements: 3.7, 3.8, 3.9 - Auto-arrival detection
    // Phase 2: 1.1-1.5, 2.2-2.5, 3.1-3.2, 4.4-4.6, 6.1-6.5
    this.geofenceHandler = new lambdaNode.NodejsFunction(this, "GeofenceHandler", {
      projectRoot: REPO_ROOT,
      entry: lambdaEntry("geofence-handler/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        DISPATCH_TABLE: dispatchTable.tableName,
        VEHICLE_STATE_TABLE: vehicleStateTable.tableName,
        GEOFENCE_COLLECTION_NAME: this.geofenceCollectionName,
        JOB_COMPLETION_TOPIC_ARN: this.jobCompletionTopic.topicArn,
        ...(websocketEndpoint && { WEBSOCKET_ENDPOINT: websocketEndpoint }),
        ...(connectionsTable && { CONNECTIONS_TABLE: connectionsTable.tableName }),
      },
    });

    // Grant DynamoDB permissions
    dispatchTable.grantReadWriteData(this.geofenceHandler);
    vehicleStateTable.grantReadWriteData(this.geofenceHandler);
    if (connectionsTable) {
      connectionsTable.grantReadData(this.geofenceHandler);
    }

    // Grant SNS publish permissions for job completion notifications (Requirement 3.1)
    this.jobCompletionTopic.grantPublish(this.geofenceHandler);

    // Grant Location Service permissions to delete geofences
    this.geofenceHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["geo:BatchDeleteGeofence"],
        resources: [
          `arn:aws:geo:${this.region}:${this.account}:geofence-collection/${this.geofenceCollectionName}`,
        ],
      })
    );

    // Grant CloudWatch permissions for custom metrics (Requirement 6.5)
    this.geofenceHandler.addToRolePolicy(
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

    // Grant API Gateway Management permissions for WebSocket broadcast (if configured)
    if (websocketEndpoint) {
      this.geofenceHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["execute-api:ManageConnections"],
          resources: [`arn:aws:execute-api:${this.region}:${this.account}:*/*/@connections/*`],
        })
      );
    }

    // EventBridge rule: Trigger geofence handler on ENTER events
    // Requirements: 3.8 - Geofence ENTER event triggers job completion via EventBridge
    // Note: We filter by source and event type; the Lambda validates the geofence collection
    const geofenceEnterRule = new events.Rule(this, "GeofenceEnterRule", {
      ruleName: "fleet-geofence-enter",
      description: "Triggers geofence handler Lambda when vehicles enter geofences",
      eventPattern: {
        source: ["aws.geo"],
        detailType: ["Location Geofence Event"],
        detail: {
          EventType: ["ENTER"],
        },
      },
    });

    // Add Lambda as target for the EventBridge rule
    geofenceEnterRule.addTarget(new targets.LambdaFunction(this.geofenceHandler, {
      retryAttempts: 2,
    }));

    // =========================================================================
    // Email Processor Lambda (Task 5.4)
    // Requirements: 3.3, 3.4, 3.6 - Process SNS notifications and send emails via SES
    // =========================================================================
    if (emailSubscriptionsTable) {
      this.emailProcessor = new lambdaNode.NodejsFunction(this, "EmailProcessor", {
        projectRoot: REPO_ROOT,
        entry: lambdaEntry("email-processor/index.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: cdk.Duration.seconds(60),
        memorySize: 256,
        environment: {
          EMAIL_SUBSCRIPTIONS_TABLE: emailSubscriptionsTable.tableName,
          SES_FROM_EMAIL: sesFromEmail || "noreply@fleet-tracking.local",
        },
      });

      // Grant DynamoDB read permissions for email subscriptions
      emailSubscriptionsTable.grantReadData(this.emailProcessor);

      // Grant SES send email permissions
      this.emailProcessor.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ses:SendEmail", "ses:SendRawEmail"],
          resources: ["*"],
        })
      );

      // Subscribe Email Processor Lambda to SNS topic with DLQ for failed deliveries
      this.jobCompletionTopic.addSubscription(
        new snsSubscriptions.LambdaSubscription(this.emailProcessor, {
          deadLetterQueue: this.jobCompletionDlq,
        })
      );
    }

    // =========================================================================
    // Task 11.11: Create home base geofences for demo vehicles
    // Requirements: 4.1, 4.2, 4.3 - Create 50-meter radius geofence at vehicle starting position
    // Named using pattern "home-{vehicleId}"
    // =========================================================================
    this.createHomeBaseGeofences();
  }

  /**
   * Task 11.11: Create home base geofences for all demo vehicles
   * Requirements: 4.1, 4.2, 4.3
   * - Create 50-meter radius geofence at vehicle starting position
   * - Name geofence using pattern "home-{vehicleId}"
   */
  private createHomeBaseGeofences(): void {
    for (const vehicle of HOME_BASE_POSITIONS) {
      const geofenceId = `home-${vehicle.vehicleId}`;
      
      // Create home base geofence using custom resource
      // 50-meter radius circle around the starting position
      const homeGeofence = new cr.AwsCustomResource(this, `HomeGeofence-${vehicle.vehicleId}`, {
        onCreate: {
          service: "Location",
          action: "putGeofence",
          parameters: {
            CollectionName: this.geofenceCollectionName,
            GeofenceId: geofenceId,
            Geometry: {
              Circle: {
                Center: [vehicle.lng, vehicle.lat], // [longitude, latitude]
                Radius: 50, // 50 meters
              },
            },
          },
          physicalResourceId: cr.PhysicalResourceId.of(`home-geofence-${vehicle.vehicleId}`),
        },
        onDelete: {
          service: "Location",
          action: "batchDeleteGeofence",
          parameters: {
            CollectionName: this.geofenceCollectionName,
            GeofenceIds: [geofenceId],
          },
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["geo:PutGeofence", "geo:BatchDeleteGeofence"],
            resources: [
              `arn:aws:geo:${this.region}:${this.account}:geofence-collection/${this.geofenceCollectionName}`,
            ],
          }),
        ]),
      });

      // Ensure geofence is created after the collection
      homeGeofence.node.addDependency(this.geofenceCollection);
    }
  }
}
