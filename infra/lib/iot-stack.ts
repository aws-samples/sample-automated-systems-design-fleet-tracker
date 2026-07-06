import * as cdk from "aws-cdk-lib";
import * as iot from "aws-cdk-lib/aws-iot";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

// Demo vehicle configuration
interface VehicleConfig {
  vehicleId: string;
  technician: string;
}

const DEMO_VEHICLES: VehicleConfig[] = [
  { vehicleId: "vehicle-001", technician: "John_Smith" },
  { vehicleId: "vehicle-002", technician: "Sarah_Jones" },
  { vehicleId: "vehicle-003", technician: "Mike_Wilson" },
  { vehicleId: "vehicle-004", technician: "Lisa_Chen" },
  { vehicleId: "vehicle-005", technician: "David_Brown" },
];

export class IoTStack extends cdk.Stack {
  public readonly thingGroup: iot.CfnThingGroup;
  public readonly vehiclePolicy: iot.CfnPolicy;
  public readonly vehicleThings: iot.CfnThing[];

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vehicleThings = [];

    // Thing Group for all fleet vehicles
    this.thingGroup = new iot.CfnThingGroup(this, "FleetVehicles", {
      thingGroupName: "fleet-vehicles",
      thingGroupProperties: {
        thingGroupDescription: "All GPS-tracked fleet vehicles",
      },
    });

    // IoT Policy - device-scoped publish/subscribe with Device Shadow support
    // Consolidated to stay under 2048 byte limit
    this.vehiclePolicy = new iot.CfnPolicy(this, "VehiclePolicy", {
      policyName: "fleet-vehicle-policy",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "iot:Connect",
            Resource: `arn:aws:iot:${this.region}:${this.account}:client/\${iot:Connection.Thing.ThingName}`,
          },
          {
            Effect: "Allow",
            Action: "iot:Publish",
            Resource: [
              `arn:aws:iot:${this.region}:${this.account}:topic/fleet/vehicles/\${iot:Connection.Thing.ThingName}/*`,
              `arn:aws:iot:${this.region}:${this.account}:topic/$aws/things/\${iot:Connection.Thing.ThingName}/shadow/*`,
            ],
          },
          {
            Effect: "Allow",
            Action: "iot:Subscribe",
            Resource: [
              `arn:aws:iot:${this.region}:${this.account}:topicfilter/fleet/vehicles/\${iot:Connection.Thing.ThingName}/commands/*`,
              `arn:aws:iot:${this.region}:${this.account}:topicfilter/$aws/things/\${iot:Connection.Thing.ThingName}/shadow/*`,
            ],
          },
          {
            Effect: "Allow",
            Action: "iot:Receive",
            Resource: [
              `arn:aws:iot:${this.region}:${this.account}:topic/fleet/vehicles/\${iot:Connection.Thing.ThingName}/commands/*`,
              `arn:aws:iot:${this.region}:${this.account}:topic/$aws/things/\${iot:Connection.Thing.ThingName}/shadow/*`,
            ],
          },
        ],
      },
    });

    // Enable Fleet Indexing for device queries
    new cr.AwsCustomResource(this, "FleetIndexingConfig", {
      onCreate: {
        service: "Iot",
        action: "updateIndexingConfiguration",
        parameters: {
          thingIndexingConfiguration: {
            thingIndexingMode: "REGISTRY_AND_SHADOW",
            thingConnectivityIndexingMode: "STATUS",
            deviceDefenderIndexingMode: "OFF",
            namedShadowIndexingMode: "OFF",
            filter: { namedShadowNames: [] },
            customFields: [
              { name: "attributes.vehicleId", type: "String" },
              { name: "attributes.tenantId", type: "String" },
              { name: "attributes.status", type: "String" },
            ],
          },
          thingGroupIndexingConfiguration: {
            thingGroupIndexingMode: "ON",
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of("FleetIndexingConfig"),
      },
      onUpdate: {
        service: "Iot",
        action: "updateIndexingConfiguration",
        parameters: {
          thingIndexingConfiguration: {
            thingIndexingMode: "REGISTRY_AND_SHADOW",
            thingConnectivityIndexingMode: "STATUS",
            deviceDefenderIndexingMode: "OFF",
            namedShadowIndexingMode: "OFF",
            filter: { namedShadowNames: [] },
            customFields: [
              { name: "attributes.vehicleId", type: "String" },
              { name: "attributes.tenantId", type: "String" },
              { name: "attributes.status", type: "String" },
            ],
          },
          thingGroupIndexingConfiguration: {
            thingGroupIndexingMode: "ON",
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of("FleetIndexingConfig"),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new cdk.aws_iam.PolicyStatement({
          actions: ["iot:UpdateIndexingConfiguration", "iot:GetIndexingConfiguration"],
          resources: ["*"],
        }),
      ]),
    });

    // Provision demo vehicles
    this.provisionDemoVehicles();

    // Output IoT endpoint for simulator configuration
    const iotEndpoint = new cr.AwsCustomResource(this, "IoTEndpoint", {
      onCreate: {
        service: "Iot",
        action: "describeEndpoint",
        parameters: { endpointType: "iot:Data-ATS" },
        physicalResourceId: cr.PhysicalResourceId.of("IoTEndpoint"),
      },
      onUpdate: {
        service: "Iot",
        action: "describeEndpoint",
        parameters: { endpointType: "iot:Data-ATS" },
        physicalResourceId: cr.PhysicalResourceId.of("IoTEndpoint"),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new cdk.aws_iam.PolicyStatement({
          actions: ["iot:DescribeEndpoint"],
          resources: ["*"],
        }),
      ]),
    });

    new cdk.CfnOutput(this, "IoTEndpointAddress", {
      value: iotEndpoint.getResponseField("endpointAddress"),
      description: "IoT Core endpoint for MQTT connections",
      exportName: "fleet-iot-endpoint",
    });
  }

  /**
   * Provisions 5 demo vehicles as IoT Things with:
   * - 3 attributes (vehicleId, tenantId, status) - AWS limit without Thing Type
   * - Thing Group membership
   * 
   * Note: Certificates are created by ./scripts/provision-devices.sh
   * Technician info is stored in DynamoDB vehicle state table
   */
  private provisionDemoVehicles(): void {
    for (const vehicle of DEMO_VEHICLES) {
      // Create IoT Thing with max 3 attributes (AWS limit without Thing Type)
      const thing = new iot.CfnThing(this, `Thing-${vehicle.vehicleId}`, {
        thingName: vehicle.vehicleId,
        attributePayload: {
          attributes: {
            vehicleId: vehicle.vehicleId,
            tenantId: "demo-tenant",
            status: "available",
          },
        },
      });
      thing.addDependency(this.thingGroup);
      this.vehicleThings.push(thing);

      // Add Thing to Thing Group
      const thingGroupAttachment = new cr.AwsCustomResource(
        this,
        `ThingGroupAttachment-${vehicle.vehicleId}`,
        {
          onCreate: {
            service: "Iot",
            action: "addThingToThingGroup",
            parameters: {
              thingGroupName: this.thingGroup.thingGroupName,
              thingName: vehicle.vehicleId,
            },
            physicalResourceId: cr.PhysicalResourceId.of(`thing-group-${vehicle.vehicleId}`),
          },
          onDelete: {
            service: "Iot",
            action: "removeThingFromThingGroup",
            parameters: {
              thingGroupName: this.thingGroup.thingGroupName,
              thingName: vehicle.vehicleId,
            },
          },
          policy: cr.AwsCustomResourcePolicy.fromStatements([
            new cdk.aws_iam.PolicyStatement({
              actions: ["iot:AddThingToThingGroup", "iot:RemoveThingFromThingGroup"],
              resources: ["*"],
            }),
          ]),
        }
      );
      thingGroupAttachment.node.addDependency(thing);
      thingGroupAttachment.node.addDependency(this.thingGroup);
    }
  }
}
