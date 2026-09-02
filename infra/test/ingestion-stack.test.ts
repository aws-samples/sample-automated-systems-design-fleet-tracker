import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { IngestionStack } from "../lib/ingestion-stack";

const ENV = { account: "123456789012", region: "us-east-1" };

function synth(context?: Record<string, unknown>) {
  const app = new cdk.App({ context });
  return Template.fromStack(new IngestionStack(app, "TestIngestionStack", { env: ENV }));
}

describe("IngestionStack", () => {
  describe("Kinesis capacity mode", () => {
    // One provisioned shard is the default: 1,000 records/sec for ~$10.95/month, versus a
    // flat ~$29/month for on-demand. 100 vehicles at 5 s is 20 records/sec, or 2% of a shard.
    test("defaults to one provisioned shard", () => {
      synth().hasResourceProperties("AWS::Kinesis::Stream", {
        Name: "fleet-gps-stream",
        StreamModeDetails: { StreamMode: "PROVISIONED" },
        ShardCount: 1,
        RetentionPeriodHours: 24,
      });
    });

    test("accepts a higher shard count", () => {
      synth({ kinesisShards: "4" }).hasResourceProperties("AWS::Kinesis::Stream", {
        StreamModeDetails: { StreamMode: "PROVISIONED" },
        ShardCount: 4,
      });
    });

    // On-demand remains available for genuinely spiky traffic.
    test("switches to on-demand when kinesisOnDemand=true", () => {
      const t = synth({ kinesisOnDemand: "true" });
      t.hasResourceProperties("AWS::Kinesis::Stream", {
        StreamModeDetails: { StreamMode: "ON_DEMAND" },
      });
      const stream = Object.values(t.findResources("AWS::Kinesis::Stream"))[0];
      expect(stream.Properties.ShardCount).toBeUndefined();
    });

    test.each(["0", "-1", "abc", "1.5"])(
      "rejects invalid shard count %s",
      (value) => {
        expect(() => synth({ kinesisShards: value })).toThrow(/positive integer/);
      }
    );
  });

  describe("GPS ingestion rule", () => {
    // Devices reach this rule over Basic Ingest, so the FROM clause must match the
    // topic suffix left after the $aws/rules/<rule-name> prefix is stripped.
    test("routes GPS messages to Kinesis with a DLQ error action", () => {
      synth().hasResourceProperties("AWS::IoT::TopicRule", {
        RuleName: "fleet_gps_to_kinesis",
        TopicRulePayload: Match.objectLike({
          Sql: "SELECT *, topic(3) as vehicleId, timestamp() as serverTimestamp FROM 'fleet/vehicles/+/gps'",
          RuleDisabled: false,
          Actions: Match.arrayWith([Match.objectLike({ Kinesis: Match.anyValue() })]),
          ErrorAction: Match.objectLike({ Sqs: Match.anyValue() }),
        }),
      });
    });

    // Partial batch responses need BOTH the event source setting and a handler that
    // returns failed sequence numbers; without the setting Lambda retries the whole batch.
    test("Kinesis event source reports batch item failures", () => {
      synth().hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        BatchSize: 10,
        FunctionResponseTypes: ["ReportBatchItemFailures"],
        BisectBatchOnFunctionError: true,
      });
    });
  });

  // Positions reach Amazon Location Service via the native `location` rule action in
  // LocationStack, so this stack grants the processor no geo: permissions.
  test("GPS processor has no Location Service permissions", () => {
    const policies = synth().findResources("AWS::IAM::Policy");
    const actions = JSON.stringify(policies);
    expect(actions).not.toMatch(/geo:BatchUpdateDevicePosition/);
  });
});
