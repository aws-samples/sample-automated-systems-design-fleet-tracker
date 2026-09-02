import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { LocationStack } from "../lib/location-stack";

describe("LocationStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();

    // Imported tables keep this test focused on LocationStack's own resources
    const depsStack = new cdk.Stack(app, "TestDepsStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const dispatchTable = dynamodb.Table.fromTableName(
      depsStack,
      "DispatchTable",
      "dispatch-assignments"
    );
    const vehicleStateTable = dynamodb.Table.fromTableName(
      depsStack,
      "VehicleStateTable",
      "vehicle-current-state"
    );

    const stack = new LocationStack(app, "TestLocationStack", {
      env: { account: "123456789012", region: "us-east-1" },
      dispatchTable,
      vehicleStateTable,
    });

    template = Template.fromStack(stack);
  });

  describe("Tracker and geofences", () => {
    test("creates the fleet tracker", () => {
      template.hasResourceProperties("AWS::Location::Tracker", {
        TrackerName: "fleet-tracker",
      });
    });

    // DistanceBased is the primary cost control: ignored updates are neither stored nor
    // evaluated against geofences. TimeBased (the service default) only reduces storage,
    // so every update would still be billed and still evaluated.
    test("tracker uses DistanceBased position filtering", () => {
      template.hasResourceProperties("AWS::Location::Tracker", {
        TrackerName: "fleet-tracker",
        PositionFiltering: "DistanceBased",
      });
    });

    test("links the tracker to the geofence collection", () => {
      template.resourceCountIs("AWS::Location::TrackerConsumer", 1);
    });
  });

  // Positions reach Amazon Location Service through this rule's native `location`
  // action rather than through the GPS processor Lambda.
  describe("GPS to Location Service IoT rule", () => {
    test("creates the fleet_gps_to_location topic rule", () => {
      template.hasResourceProperties("AWS::IoT::TopicRule", {
        RuleName: "fleet_gps_to_location",
      });
    });

    test("rule uses a native Location action pointed at the fleet tracker", () => {
      template.hasResourceProperties("AWS::IoT::TopicRule", {
        RuleName: "fleet_gps_to_location",
        TopicRulePayload: Match.objectLike({
          RuleDisabled: false,
          Actions: Match.arrayWith([
            Match.objectLike({
              Location: Match.objectLike({
                TrackerName: "fleet-tracker",
                DeviceId: "${vehicleId}",
                Latitude: "${lat}",
                Longitude: "${lng}",
              }),
            }),
          ]),
        }),
      });
    });

    test("rule reads epoch millis from the payload so no date parsing is needed", () => {
      template.hasResourceProperties("AWS::IoT::TopicRule", {
        RuleName: "fleet_gps_to_location",
        TopicRulePayload: Match.objectLike({
          Actions: Match.arrayWith([
            Match.objectLike({
              Location: Match.objectLike({
                Timestamp: {
                  Value: "${timestampMs}",
                  Unit: "MILLISECONDS",
                },
              }),
            }),
          ]),
        }),
      });
    });

    // The $aws/rules/<rule-name> prefix is stripped before SQL evaluation, so the
    // FROM filter must match the remaining fleet/vehicles/<vehicleId>/gps suffix.
    test("rule SQL matches the Basic Ingest topic suffix", () => {
      template.hasResourceProperties("AWS::IoT::TopicRule", {
        RuleName: "fleet_gps_to_location",
        TopicRulePayload: Match.objectLike({
          Sql: "SELECT * FROM 'fleet/vehicles/+/gps'",
        }),
      });
    });

    test("grants the rule only BatchUpdateDevicePosition on the fleet tracker", () => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "geo:BatchUpdateDevicePosition",
              Resource: Match.stringLikeRegexp(
                "arn:aws:geo:.*:.*:tracker/fleet-tracker"
              ),
            }),
          ]),
        }),
      });
    });

    test("rule role is assumable by the IoT service", () => {
      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "sts:AssumeRole",
              Principal: Match.objectLike({ Service: "iot.amazonaws.com" }),
            }),
          ]),
        }),
      });
    });
  });
});
