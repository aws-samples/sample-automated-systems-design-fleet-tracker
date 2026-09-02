import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { IoTStack } from "../lib/iot-stack";

describe("IoTStack", () => {
  let app: cdk.App;
  let stack: IoTStack;
  let template: Template;

  beforeAll(() => {
    app = new cdk.App();
    stack = new IoTStack(app, "TestIoTStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  describe("Thing Group", () => {
    test("creates fleet-vehicles Thing Group", () => {
      template.hasResourceProperties("AWS::IoT::ThingGroup", {
        ThingGroupName: "fleet-vehicles",
        ThingGroupProperties: {
          ThingGroupDescription: "All GPS-tracked fleet vehicles",
        },
      });
    });

    test("creates exactly one Thing Group", () => {
      template.resourceCountIs("AWS::IoT::ThingGroup", 1);
    });
  });

  describe("IoT Policy", () => {
    test("creates fleet-vehicle-policy with correct name", () => {
      template.hasResourceProperties("AWS::IoT::Policy", {
        PolicyName: "fleet-vehicle-policy",
      });
    });

    test("policy allows Connect action with thing-scoped client ID", () => {
      template.hasResourceProperties("AWS::IoT::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "iot:Connect",
              Resource: Match.stringLikeRegexp(
                "arn:aws:iot:.*:.*:client/\\$\\{iot:Connection\\.Thing\\.ThingName\\}"
              ),
            }),
          ]),
        }),
      });
    });

    test("policy allows Publish to device-scoped Device Shadow topic", () => {
      template.hasResourceProperties("AWS::IoT::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "iot:Publish",
              Resource: Match.arrayWith([
                Match.stringLikeRegexp(
                  "arn:aws:iot:.*:.*:topic/\\$aws/things/\\$\\{iot:Connection\\.Thing\\.ThingName\\}/shadow/\\*"
                ),
              ]),
            }),
          ]),
        }),
      });
    });

    // GPS publishes over Basic Ingest only, so the broad brokered fleet/vehicles/*
    // publish grant was removed. Guard against it being reintroduced.
    test("policy does not grant brokered publish on fleet/vehicles topics", () => {
      const policies = template.findResources("AWS::IoT::Policy");
      const statements = Object.values(policies)[0].Properties.PolicyDocument.Statement;
      const publishResources = statements
        .filter((s: { Action: string }) => s.Action === "iot:Publish")
        .flatMap((s: { Resource: string | string[] }) =>
          Array.isArray(s.Resource) ? s.Resource : [s.Resource]
        );

      const brokeredGpsGrants = publishResources.filter((r: string) =>
        /:topic\/fleet\/vehicles\//.test(r)
      );
      expect(brokeredGpsGrants).toEqual([]);
      expect(
        publishResources.some((r: string) =>
          r.includes("topic/$aws/rules/fleet_gps_to_kinesis/fleet/vehicles/")
        )
      ).toBe(true);
    });

    // Basic Ingest: GPS telemetry publishes to the reserved $aws/rules/<rule-name> prefix,
    // scoped to this thing's own topic rather than the whole $aws/rules/* namespace.
    test("policy allows Publish to device-scoped Basic Ingest topic", () => {
      template.hasResourceProperties("AWS::IoT::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "iot:Publish",
              Resource: Match.arrayWith([
                Match.stringLikeRegexp(
                  "arn:aws:iot:.*:.*:topic/\\$aws/rules/fleet_gps_to_kinesis/fleet/vehicles/\\$\\{iot:Connection\\.Thing\\.ThingName\\}/gps"
                ),
              ]),
            }),
          ]),
        }),
      });
    });

    test("policy allows Subscribe to commands topic filter", () => {
      template.hasResourceProperties("AWS::IoT::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "iot:Subscribe",
              Resource: Match.arrayWith([
                Match.stringLikeRegexp(
                  "arn:aws:iot:.*:.*:topicfilter/fleet/vehicles/\\$\\{iot:Connection\\.Thing\\.ThingName\\}/commands/\\*"
                ),
              ]),
            }),
          ]),
        }),
      });
    });

    test("policy allows Receive on commands topic", () => {
      template.hasResourceProperties("AWS::IoT::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "iot:Receive",
              Resource: Match.arrayWith([
                Match.stringLikeRegexp(
                  "arn:aws:iot:.*:.*:topic/fleet/vehicles/\\$\\{iot:Connection\\.Thing\\.ThingName\\}/commands/\\*"
                ),
              ]),
            }),
          ]),
        }),
      });
    });

    test("creates exactly one IoT Policy", () => {
      template.resourceCountIs("AWS::IoT::Policy", 1);
    });
  });

  describe("Demo Vehicle Things", () => {
    const vehicleIds = [
      "vehicle-001",
      "vehicle-002",
      "vehicle-003",
      "vehicle-004",
      "vehicle-005",
    ];

    test("creates 5 IoT Things for demo vehicles", () => {
      template.resourceCountIs("AWS::IoT::Thing", 5);
    });

    test.each(vehicleIds)("creates Thing for %s", (vehicleId) => {
      template.hasResourceProperties("AWS::IoT::Thing", {
        ThingName: vehicleId,
        AttributePayload: Match.objectLike({
          Attributes: Match.objectLike({
            vehicleId: vehicleId,
            status: "available",
          }),
        }),
      });
    });

    test("vehicle-001 has correct attributes (3 max without Thing Type)", () => {
      template.hasResourceProperties("AWS::IoT::Thing", {
        ThingName: "vehicle-001",
        AttributePayload: {
          Attributes: {
            vehicleId: "vehicle-001",
            tenantId: "demo-tenant",
            status: "available",
          },
        },
      });
    });

    test("vehicle-005 has correct attributes (3 max without Thing Type)", () => {
      template.hasResourceProperties("AWS::IoT::Thing", {
        ThingName: "vehicle-005",
        AttributePayload: {
          Attributes: {
            vehicleId: "vehicle-005",
            tenantId: "demo-tenant",
            status: "available",
          },
        },
      });
    });
  });

  describe("Certificate and Policy Attachments", () => {
    test("does not create certificate custom resources (handled by provision-devices.sh)", () => {
      const customResources = template.findResources("AWS::CloudFormation::CustomResource");
      expect(Object.keys(customResources).length).toBe(0);
    });
  });

  describe("Custom Resources", () => {
    const findCustomResourcesByAction = (service: string, action: string) => {
      const allResources = template.findResources("Custom::AWS");
      return Object.entries(allResources).filter(([, resource]) => {
        const createProp = (resource as any).Properties?.Create;
        
        if (typeof createProp === "string") {
          try {
            const create = JSON.parse(createProp);
            return create.service === service && create.action === action;
          } catch {
            return false;
          }
        }
        
        if (typeof createProp === "object" && createProp["Fn::Join"]) {
          const joinParts = createProp["Fn::Join"][1];
          if (Array.isArray(joinParts) && joinParts.length > 0) {
            const firstPart = joinParts[0];
            if (typeof firstPart === "string") {
              return firstPart.includes(`"service":"${service}"`) && 
                     firstPart.includes(`"action":"${action}"`);
            }
          }
        }
        
        return false;
      });
    };

    test("creates custom resource for Fleet Indexing configuration", () => {
      const resources = findCustomResourcesByAction("Iot", "updateIndexingConfiguration");
      expect(resources.length).toBe(1);
    });

    test("Fleet Indexing enables REGISTRY_AND_SHADOW mode", () => {
      const resources = findCustomResourcesByAction("Iot", "updateIndexingConfiguration");
      expect(resources.length).toBe(1);
      
      const createStr = (resources[0][1] as any).Properties.Create;
      const create = JSON.parse(createStr);
      expect(create.parameters.thingIndexingConfiguration.thingIndexingMode).toBe("REGISTRY_AND_SHADOW");
      expect(create.parameters.thingIndexingConfiguration.thingConnectivityIndexingMode).toBe("STATUS");
    });

    test("creates custom resources for Thing Group attachments (5 vehicles)", () => {
      const resources = findCustomResourcesByAction("Iot", "addThingToThingGroup");
      expect(resources.length).toBe(5);
      
      resources.forEach(([, resource]) => {
        const createStr = (resource as any).Properties.Create;
        const create = JSON.parse(createStr);
        expect(create.parameters.thingGroupName).toBe("fleet-vehicles");
      });
    });

    test("creates custom resource for IoT endpoint discovery", () => {
      const resources = findCustomResourcesByAction("Iot", "describeEndpoint");
      expect(resources.length).toBe(1);
    });
  });

  describe("Stack Outputs", () => {
    test("exports IoT endpoint address", () => {
      template.hasOutput("IoTEndpointAddress", {
        Export: { Name: "fleet-iot-endpoint" },
      });
    });
  });

  describe("Stack Properties", () => {
    test("exposes thingGroup property", () => {
      expect(stack.thingGroup).toBeDefined();
    });

    test("exposes vehiclePolicy property", () => {
      expect(stack.vehiclePolicy).toBeDefined();
    });

    test("exposes vehicleThings array with 5 things", () => {
      expect(stack.vehicleThings).toBeDefined();
      expect(stack.vehicleThings.length).toBe(5);
    });
  });
});
