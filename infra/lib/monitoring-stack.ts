import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as sns from "aws-cdk-lib/aws-sns";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import { Construct } from "constructs";

export interface MonitoringStackProps extends cdk.StackProps {
  /** Email address for alarm notifications (optional) */
  alarmEmail?: string;
  /** WebSocket API for connection metrics (cross-stack reference from ApiStack) */
  webSocketApi?: apigatewayv2.CfnApi;
}

export class MonitoringStack extends cdk.Stack {
  public readonly opsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props?: MonitoringStackProps) {
    super(scope, id, props);

    // SNS Topic for operational alerts
    this.opsTopic = new sns.Topic(this, "OpsAlerts", { 
      topicName: "fleet-ops-alerts",
      displayName: "Fleet Tracking Operations Alerts",
    });

    if (props?.alarmEmail) {
      new sns.Subscription(this, "EmailSubscription", {
        topic: this.opsTopic,
        protocol: sns.SubscriptionProtocol.EMAIL,
        endpoint: props.alarmEmail,
      });
    }

    // =========================================================================
    // Enhanced CloudWatch Dashboard
    // =========================================================================
    const dashboard = new cloudwatch.Dashboard(this, "FleetDashboard", {
      dashboardName: "fleet-tracking-operations",
    });

    // Header
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: "# 🚚 Fleet Tracking Operations Dashboard\nReal-time monitoring for fleet tracking platform",
        width: 24,
        height: 1
      })
    );

    // =========================================================================
    // CloudWatch Alarms
    // =========================================================================
    const kinesisLagAlarm = new cloudwatch.Alarm(this, "KinesisLagAlarm", {
      alarmName: "fleet-kinesis-consumer-lag",
      metric: new cloudwatch.Metric({
        namespace: "AWS/Kinesis",
        metricName: "GetRecords.IteratorAgeMilliseconds",
        dimensionsMap: { StreamName: "fleet-gps-stream" },
        statistic: "Maximum",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 60000,
      evaluationPeriods: 1,
      alarmDescription: "Kinesis consumer lag exceeds 60 seconds",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    kinesisLagAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(this.opsTopic));

    // Lambda error alarm.
    // Note: CloudWatch Alarms do not support SEARCH expressions (only dashboard widgets do).
    // For a cross-account-friendly version, list each Fleet Lambda function name explicitly
    // and combine them with a MathExpression sum, or use composite alarms. For this demo,
    // we use the account-wide aggregate. The dashboard widgets above DO use SEARCH to
    // properly scope visibility to Fleet Lambdas.
    const lambdaErrorAlarm = new cloudwatch.Alarm(this, "LambdaErrorRateAlarm", {
      alarmName: "fleet-lambda-error-rate",
      metric: new cloudwatch.Metric({
        namespace: "AWS/Lambda",
        metricName: "Errors",
        statistic: "Sum",
        period: cdk.Duration.minutes(5),
        // No FunctionName dimension — this aggregates across all Lambdas in the account.
        // Acceptable for a demo. For production, scope to specific function names.
      }),
      threshold: 10,
      evaluationPeriods: 1,
      alarmDescription: "Total Lambda errors exceed 10 in 5 minutes (account-wide). For Fleet-only visibility, use the dashboard widget which uses SEARCH.",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    lambdaErrorAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(this.opsTopic));

    const api5xxAlarm = new cloudwatch.Alarm(this, "Api5xxErrorAlarm", {
      alarmName: "fleet-api-5xx-errors",
      metric: new cloudwatch.Metric({
        namespace: "AWS/ApiGateway",
        metricName: "5XXError",
        dimensionsMap: { ApiName: "fleet-tracking-api" },
        statistic: "Sum",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      alarmDescription: "API Gateway 5xx errors exceed 10 in 5 minutes",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    api5xxAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(this.opsTopic));

    // DLQ alarms — any messages on a DLQ indicate failures. Threshold of 1 with
    // 2 evaluation periods filters out single-message blips while still catching
    // genuine issues quickly.
    const iotDlqAlarm = new cloudwatch.Alarm(this, "IoTRulesDlqAlarm", {
      alarmName: "fleet-iot-rules-dlq-messages",
      metric: new cloudwatch.Metric({
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensionsMap: { QueueName: "fleet-iot-rules-dlq" },
        statistic: "Maximum",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      alarmDescription: "IoT Rules DLQ has unprocessed messages — IoT-to-Kinesis routing failures",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    iotDlqAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(this.opsTopic));

    const gpsProcessorDlqAlarm = new cloudwatch.Alarm(this, "GpsProcessorDlqAlarm", {
      alarmName: "fleet-gps-processor-dlq-messages",
      metric: new cloudwatch.Metric({
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensionsMap: { QueueName: "fleet-gps-processor-dlq" },
        statistic: "Maximum",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      alarmDescription: "GPS Processor Lambda DLQ has unprocessed messages — Lambda failures after retries",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    gpsProcessorDlqAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(this.opsTopic));

    const jobCompletionDlqAlarm = new cloudwatch.Alarm(this, "JobCompletionDlqAlarm", {
      alarmName: "fleet-job-completion-dlq-messages",
      metric: new cloudwatch.Metric({
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensionsMap: { QueueName: "fleet-job-completion-dlq" },
        statistic: "Maximum",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      alarmDescription: "Job Completion DLQ has unprocessed messages — SNS-to-email-processor failures",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    jobCompletionDlqAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(this.opsTopic));

    // =========================================================================
    // Row 1: Key Business Metrics
    // =========================================================================
    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: "Jobs Completed (24h)",
        metrics: [
          new cloudwatch.Metric({
            namespace: "FleetTracking",
            metricName: "JobsCompleted",
            statistic: "Sum",
            period: cdk.Duration.hours(24),
          }),
        ],
        width: 6,
        height: 4,
        setPeriodToTimeRange: true,
      }),
      new cloudwatch.SingleValueWidget({
        title: "Active Vehicles",
        metrics: [
          new cloudwatch.Metric({
            namespace: "FleetTracking",
            metricName: "ActiveVehicles",
            statistic: "Maximum",
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 6,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: "GPS Updates/min",
        metrics: [
          new cloudwatch.Metric({
            namespace: "AWS/Kinesis",
            metricName: "IncomingRecords",
            dimensionsMap: { StreamName: "fleet-gps-stream" },
            statistic: "Sum",
            period: cdk.Duration.minutes(1),
          }),
        ],
        width: 6,
        height: 4,
      }),
      new cloudwatch.AlarmStatusWidget({
        title: "Alarm Status",
        alarms: [kinesisLagAlarm, lambdaErrorAlarm, api5xxAlarm, iotDlqAlarm, gpsProcessorDlqAlarm, jobCompletionDlqAlarm],
        width: 6,
        height: 4,
      })
    );

    // =========================================================================
    // Row 2: IoT and Data Ingestion
    // =========================================================================
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Kinesis Ingestion Rate",
        left: [
          new cloudwatch.Metric({ 
            namespace: "AWS/Kinesis", 
            metricName: "IncomingRecords", 
            dimensionsMap: { StreamName: "fleet-gps-stream" }, 
            statistic: "Sum", 
            period: cdk.Duration.minutes(1),
            label: "GPS Records Ingested",
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "Kinesis Stream Health",
        left: [
          new cloudwatch.Metric({ 
            namespace: "AWS/Kinesis", 
            metricName: "IncomingRecords", 
            dimensionsMap: { StreamName: "fleet-gps-stream" }, 
            statistic: "Sum", 
            period: cdk.Duration.minutes(1),
            label: "Incoming Records",
          }),
          new cloudwatch.Metric({ 
            namespace: "AWS/Kinesis", 
            metricName: "GetRecords.Records", 
            dimensionsMap: { StreamName: "fleet-gps-stream" }, 
            statistic: "Sum", 
            period: cdk.Duration.minutes(1),
            label: "Processed Records",
          }),
        ],
        right: [
          new cloudwatch.Metric({ 
            namespace: "AWS/Kinesis", 
            metricName: "GetRecords.IteratorAgeMilliseconds", 
            dimensionsMap: { StreamName: "fleet-gps-stream" }, 
            statistic: "Maximum", 
            period: cdk.Duration.minutes(1),
            label: "Iterator Age (ms)",
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "Location Service Updates",
        left: [
          new cloudwatch.Metric({ 
            namespace: "AWS/Location", 
            metricName: "CallCount", 
            dimensionsMap: { 
              OperationName: "BatchUpdateDevicePosition",
              ResourceName: "fleet-tracker",
            }, 
            statistic: "Sum", 
            period: cdk.Duration.minutes(1),
            label: "Position Updates",
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // =========================================================================
    // Row 3: Lambda Performance (scoped to Fleet Lambdas via SEARCH expression)
    //
    // CloudWatch SEARCH automatically discovers Lambdas whose names contain "Fleet"
    // (CDK generates names like "FleetIngestionStack-GpsProcessor..."). This avoids
    // false signals from unrelated Lambdas in the same AWS account.
    //
    // SEARCH syntax note: a bare term (e.g., `Fleet`) does a substring match on
    // dimension values. There is no `^=` prefix operator — that would silently
    // return no results.
    // =========================================================================
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Lambda Invocations (Fleet Functions)",
        left: [
          new cloudwatch.MathExpression({
            expression: "SEARCH('{AWS/Lambda,FunctionName} Fleet MetricName=\"Invocations\"', 'Sum', 60)",
            label: "",
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "Lambda Duration (Fleet Functions)",
        left: [
          new cloudwatch.MathExpression({
            expression: "SEARCH('{AWS/Lambda,FunctionName} Fleet MetricName=\"Duration\"', 'Average', 60)",
            label: "",
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "Lambda Errors & Throttles (Fleet Functions)",
        left: [
          new cloudwatch.MathExpression({
            expression: "SUM(SEARCH('{AWS/Lambda,FunctionName} Fleet MetricName=\"Errors\"', 'Sum', 60))",
            label: "Errors",
          }),
          new cloudwatch.MathExpression({
            expression: "SUM(SEARCH('{AWS/Lambda,FunctionName} Fleet MetricName=\"Throttles\"', 'Sum', 60))",
            label: "Throttles",
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // =========================================================================
    // Row 4: API Gateway & DynamoDB
    // =========================================================================
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "API Gateway Requests & Latency",
        left: [
          new cloudwatch.Metric({ 
            namespace: "AWS/ApiGateway", 
            metricName: "Count", 
            dimensionsMap: { ApiName: "fleet-tracking-api" }, 
            statistic: "Sum", 
            period: cdk.Duration.minutes(1),
            label: "Request Count",
          }),
        ],
        right: [
          new cloudwatch.Metric({ 
            namespace: "AWS/ApiGateway", 
            metricName: "Latency", 
            dimensionsMap: { ApiName: "fleet-tracking-api" }, 
            statistic: "p50", 
            period: cdk.Duration.minutes(1),
            label: "Latency p50",
          }),
          new cloudwatch.Metric({ 
            namespace: "AWS/ApiGateway", 
            metricName: "Latency", 
            dimensionsMap: { ApiName: "fleet-tracking-api" }, 
            statistic: "p99", 
            period: cdk.Duration.minutes(1),
            label: "Latency p99",
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "API Gateway Errors",
        left: [
          new cloudwatch.Metric({ 
            namespace: "AWS/ApiGateway", 
            metricName: "4XXError", 
            dimensionsMap: { ApiName: "fleet-tracking-api" }, 
            statistic: "Sum", 
            period: cdk.Duration.minutes(1),
            label: "4xx Errors",
          }),
          new cloudwatch.Metric({ 
            namespace: "AWS/ApiGateway", 
            metricName: "5XXError", 
            dimensionsMap: { ApiName: "fleet-tracking-api" }, 
            statistic: "Sum", 
            period: cdk.Duration.minutes(1),
            label: "5xx Errors",
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "DynamoDB Capacity",
        left: [
          new cloudwatch.Metric({ 
            namespace: "AWS/DynamoDB", 
            metricName: "ConsumedWriteCapacityUnits", 
            dimensionsMap: { TableName: "vehicle-current-state" }, 
            statistic: "Sum", 
            period: cdk.Duration.minutes(1),
            label: "Vehicle State WCU",
          }),
          new cloudwatch.Metric({ 
            namespace: "AWS/DynamoDB", 
            metricName: "ConsumedWriteCapacityUnits", 
            dimensionsMap: { TableName: "gps-history" }, 
            statistic: "Sum", 
            period: cdk.Duration.minutes(1),
            label: "GPS History WCU",
          }),
        ],
        right: [
          new cloudwatch.Metric({ 
            namespace: "AWS/DynamoDB", 
            metricName: "ConsumedReadCapacityUnits", 
            dimensionsMap: { TableName: "vehicle-current-state" }, 
            statistic: "Sum", 
            period: cdk.Duration.minutes(1),
            label: "Vehicle State RCU",
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // =========================================================================
    // Row 5: WebSocket & Notifications
    // =========================================================================
    
    // WebSocket widget — uses the cross-stack reference if provided.
    // Falls back to a placeholder text widget if MonitoringStack is deployed before ApiStack.
    const websocketWidget = props?.webSocketApi 
      ? new cloudwatch.GraphWidget({
          title: "WebSocket Connections",
          left: [
            new cloudwatch.Metric({
              namespace: "AWS/ApiGateway",
              metricName: "ConnectCount",
              dimensionsMap: { ApiId: props.webSocketApi.ref },
              statistic: "Sum",
              period: cdk.Duration.minutes(1),
              label: "New Connections",
            }),
            new cloudwatch.Metric({
              namespace: "AWS/ApiGateway",
              metricName: "MessageCount",
              dimensionsMap: { ApiId: props.webSocketApi.ref },
              statistic: "Sum",
              period: cdk.Duration.minutes(1),
              label: "Messages Sent",
            }),
          ],
          width: 8,
          height: 6,
        })
      : new cloudwatch.TextWidget({
          markdown: "### WebSocket Connections\n*WebSocket API not wired — pass `webSocketApi` prop from ApiStack*",
          width: 8,
          height: 6,
        });

    dashboard.addWidgets(
      websocketWidget,
      new cloudwatch.GraphWidget({
        title: "SNS Notifications",
        left: [
          new cloudwatch.Metric({ 
            namespace: "AWS/SNS", 
            metricName: "NumberOfMessagesPublished", 
            dimensionsMap: { TopicName: "fleet-job-completions" }, 
            statistic: "Sum", 
            period: cdk.Duration.minutes(1),
            label: "Job Completions",
          }),
          new cloudwatch.Metric({ 
            namespace: "AWS/SNS", 
            metricName: "NumberOfNotificationsDelivered", 
            dimensionsMap: { TopicName: "fleet-job-completions" }, 
            statistic: "Sum", 
            period: cdk.Duration.minutes(1),
            label: "Delivered",
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "SQS Dead Letter Queues",
        left: [
          new cloudwatch.Metric({ 
            namespace: "AWS/SQS", 
            metricName: "ApproximateNumberOfMessagesVisible", 
            dimensionsMap: { QueueName: "fleet-iot-rules-dlq" }, 
            statistic: "Maximum", 
            period: cdk.Duration.minutes(1),
            label: "IoT Rules DLQ",
          }),
          new cloudwatch.Metric({ 
            namespace: "AWS/SQS", 
            metricName: "ApproximateNumberOfMessagesVisible", 
            dimensionsMap: { QueueName: "fleet-gps-processor-dlq" }, 
            statistic: "Maximum", 
            period: cdk.Duration.minutes(1),
            label: "GPS Processor DLQ",
          }),
          new cloudwatch.Metric({ 
            namespace: "AWS/SQS", 
            metricName: "ApproximateNumberOfMessagesVisible", 
            dimensionsMap: { QueueName: "fleet-job-completion-dlq" }, 
            statistic: "Maximum", 
            period: cdk.Duration.minutes(1),
            label: "Job Completion DLQ",
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, "DashboardUrl", {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=fleet-tracking-operations`,
      description: "CloudWatch Dashboard URL",
    });

    new cdk.CfnOutput(this, "OpsTopicArn", {
      value: this.opsTopic.topicArn,
      description: "SNS Topic ARN for operational alerts",
      exportName: "FleetOpsTopicArn",
    });
  }
}
