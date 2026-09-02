import * as cdk from "aws-cdk-lib";
import * as path from "path";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { Construct } from "constructs";

// Resolve paths from this file's location so CDK works regardless of cwd
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const lambdaEntry = (p: string) => path.join(REPO_ROOT, "src", "lambdas", p);

/**
 * Props for ApiStack
 * Accepts DynamoDB tables from IngestionStack and Phase2TablesStack
 */
export interface ApiStackProps extends cdk.StackProps {
  /** DynamoDB table for vehicle current state */
  vehicleStateTable: dynamodb.ITable;
  /** DynamoDB table for dispatch assignments */
  dispatchTable: dynamodb.ITable;
  /** DynamoDB table for GPS history */
  gpsHistoryTable: dynamodb.ITable;
  /** DynamoDB table for WebSocket connections */
  websocketConnectionsTable: dynamodb.ITable;
  /** Place Index name for geocoding */
  placeIndexName: string;
  /** Route Calculator name for ETA */
  routeCalculatorName: string;
  /** Geofence Collection name for job sites */
  geofenceCollectionName: string;
  /** Map name for dashboard rendering */
  mapName: string;
  /**
   * Deployer IPv4 address (without CIDR suffix). When set, allowlists this address
   * for direct (unauthenticated) API Gateway access. Note: WAF rules also allow
   * any request bearing an Authorization header, so dashboard traffic via Cognito
   * is unaffected by IP rotation; this allowlist only matters for ad-hoc
   * developer-tool access from the deployer's machine.
   */
  deployerIpv4?: string;
  /**
   * Deployer IPv6 address (without CIDR suffix). When set, allowlists this address
   * for direct (unauthenticated) API Gateway access.
   */
  deployerIpv6?: string;
  // Phase 2 tables
  /** DynamoDB table for email subscriptions */
  emailSubscriptionsTable?: dynamodb.ITable;
  /** DynamoDB table for tenants */
  tenantsTable?: dynamodb.ITable;
  /** DynamoDB table for analytics daily metrics */
  analyticsDailyTable?: dynamodb.ITable;
}

export class ApiStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly identityPool: cognito.CfnIdentityPool;
  public readonly restApi: apigateway.RestApi;
  public readonly webSocketApi: apigatewayv2.CfnApi;
  public readonly webSocketEndpoint: string;
  public readonly cognitoAuthorizer: apigateway.CognitoUserPoolsAuthorizer;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const {
      vehicleStateTable,
      dispatchTable,
      gpsHistoryTable,
      websocketConnectionsTable,
      placeIndexName,
      routeCalculatorName,
      geofenceCollectionName,
      mapName,
      deployerIpv4,
      deployerIpv6,
      emailSubscriptionsTable,
      tenantsTable,
      analyticsDailyTable,
    } = props;

    // Demo user configuration
    const demoUserEmail = "demo@fleet-tracking.local";
    
    // Store demo password in Secrets Manager for secure access
    // Requirements: 8.7 - Secrets stored securely, not hardcoded
    const demoUserSecret = new secretsmanager.Secret(this, "DemoUserSecret", {
      secretName: "fleet-tracking/demo-user-password",
      description: "Demo user password for fleet tracking dashboard",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ email: demoUserEmail }),
        generateStringKey: "password",
        excludePunctuation: false,
        includeSpace: false,
        passwordLength: 16,
        requireEachIncludedType: true,
      },
    });

    // Cognito for dashboard auth
    // Task 14.1: Added custom:tenantId attribute for multi-tenant support
    // Requirements: 13.1, 13.2 - Custom tenantId attribute in JWT claims
    this.userPool = new cognito.UserPool(this, "FleetUserPool", {
      userPoolName: "fleet-dispatch-users",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.OPTIONAL,
      passwordPolicy: { minLength: 12, requireSymbols: true, requireDigits: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
      },
      customAttributes: {
        tenantId: new cognito.StringAttribute({
          mutable: true,
          minLen: 1,
          maxLen: 64,
        }),
      },
    });

    // User Pool Client for dashboard
    this.userPoolClient = new cognito.UserPoolClient(this, "DashboardClient", {
      userPool: this.userPool,
      userPoolClientName: "fleet-dashboard-client",
      authFlows: { 
        userSrp: true,
        userPassword: true, // Enable for demo user login
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE, cognito.OAuthScope.EMAIL],
      },
      preventUserExistenceErrors: true,
    });

    // =========================================================================
    // Cognito Identity Pool for AWS credentials (Location Service map access)
    // =========================================================================
    this.identityPool = new cognito.CfnIdentityPool(this, "FleetIdentityPool", {
      identityPoolName: "fleet_tracking_identity_pool",
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: this.userPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
        },
      ],
    });

    // IAM role for authenticated users
    const authenticatedRole = new iam.Role(this, "CognitoAuthenticatedRole", {
      assumedBy: new iam.FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: {
            "cognito-identity.amazonaws.com:aud": this.identityPool.ref,
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "authenticated",
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
      description: "Role for authenticated fleet tracking dashboard users",
    });

    // Grant Location Service map access to authenticated users
    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "geo:GetMapStyleDescriptor",
          "geo:GetMapGlyphs",
          "geo:GetMapSprites",
          "geo:GetMapTile",
        ],
        resources: [`arn:aws:geo:${this.region}:${this.account}:map/${mapName}`],
      })
    );

    // Attach role to Identity Pool
    new cognito.CfnIdentityPoolRoleAttachment(this, "IdentityPoolRoleAttachment", {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: authenticatedRole.roleArn,
      },
    });

    // Output Identity Pool ID
    new cdk.CfnOutput(this, "IdentityPoolId", {
      value: this.identityPool.ref,
      description: "Cognito Identity Pool ID for AWS credentials",
    });

    // Custom resource to create demo user
    const createDemoUserProvider = new cr.Provider(this, "CreateDemoUserProvider", {
      onEventHandler: new lambda.Function(this, "CreateDemoUserFunction", {
        // Node 18 was deprecated 2025-09-01; creation is disabled from 2027-02-01.
        // The inline handler below uses only AWS SDK v3 and plain JS, so it runs
        // unchanged on 22.x — matching every other function in this app.
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        timeout: cdk.Duration.seconds(30),
        code: lambda.Code.fromInline(`
const { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand, AdminGetUserCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const cognitoClient = new CognitoIdentityProviderClient({});
  const secretsClient = new SecretsManagerClient({});
  const userPoolId = event.ResourceProperties.UserPoolId;
  const email = event.ResourceProperties.Email;
  const secretArn = event.ResourceProperties.SecretArn;
  
  if (event.RequestType === 'Delete') {
    // Don't delete user on stack deletion for demo purposes
    return { PhysicalResourceId: email };
  }
  
  try {
    // Get password from Secrets Manager
    const secretResponse = await secretsClient.send(new GetSecretValueCommand({
      SecretId: secretArn,
    }));
    const secretValue = JSON.parse(secretResponse.SecretString);
    const password = secretValue.password;
    
    // Check if user already exists
    try {
      await cognitoClient.send(new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: email,
      }));
      console.log('User already exists, setting password');
    } catch (e) {
      if (e.name === 'UserNotFoundException') {
        // Create the user
        console.log('Creating new user');
        await cognitoClient.send(new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: email,
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
          MessageAction: 'SUPPRESS', // Don't send welcome email
        }));
      } else {
        throw e;
      }
    }
    
    // Set permanent password (bypasses temporary password requirement)
    await cognitoClient.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }));
    
    console.log('Demo user created/updated successfully');
    return { PhysicalResourceId: email };
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};
        `),
        initialPolicy: [
          new iam.PolicyStatement({
            actions: [
              "cognito-idp:AdminCreateUser",
              "cognito-idp:AdminSetUserPassword",
              "cognito-idp:AdminGetUser",
            ],
            resources: [this.userPool.userPoolArn],
          }),
          new iam.PolicyStatement({
            actions: ["secretsmanager:GetSecretValue"],
            resources: [demoUserSecret.secretArn],
          }),
        ],
      }),
    });

    // Create the demo user using custom resource
    new cdk.CustomResource(this, "DemoUser", {
      serviceToken: createDemoUserProvider.serviceToken,
      properties: {
        UserPoolId: this.userPool.userPoolId,
        Email: demoUserEmail,
        SecretArn: demoUserSecret.secretArn,
      },
    });

    // CloudFormation outputs for demo credentials
    new cdk.CfnOutput(this, "UserPoolId", {
      value: this.userPool.userPoolId,
      description: "Cognito User Pool ID",
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: this.userPoolClient.userPoolClientId,
      description: "Cognito User Pool Client ID for dashboard",
    });

    new cdk.CfnOutput(this, "DemoUserEmail", {
      value: demoUserEmail,
      description: "Demo user email for dashboard login",
    });

    new cdk.CfnOutput(this, "DemoUserSecretArn", {
      value: demoUserSecret.secretArn,
      description: "Secrets Manager ARN containing demo user password",
    });

    new cdk.CfnOutput(this, "DemoLoginInstructions", {
      value: `Login with email: ${demoUserEmail}. Get password from Secrets Manager: aws secretsmanager get-secret-value --secret-id ${demoUserSecret.secretName} --query SecretString --output text | jq -r .password`,
      description: "Instructions for demo user login",
    });

    // REST API for vehicle data and geofence management
    // Requirements: 5.3, 5.9, 8.9
    this.restApi = new apigateway.RestApi(this, "FleetRestApi", {
      restApiName: "fleet-tracking-api",
      description: "Fleet tracking REST API for dispatch dashboard",
      deployOptions: { stageName: "v1", tracingEnabled: true },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });

    // Add Gateway Responses to include CORS headers on error responses
    // This ensures 4xx/5xx responses also have CORS headers so browsers can read them
    this.restApi.addGatewayResponse("Default4xx", {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: {
        "Access-Control-Allow-Origin": "'*'",
        "Access-Control-Allow-Headers": "'Content-Type,Authorization'",
      },
    });

    this.restApi.addGatewayResponse("Default5xx", {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: {
        "Access-Control-Allow-Origin": "'*'",
        "Access-Control-Allow-Headers": "'Content-Type,Authorization'",
      },
    });

    // =========================================================================
    // WAF WebACL for API Gateway (REGIONAL scope)
    // Requirements: 8.1, 8.4 - WAF WebACL with IP allowlist restricts API access
    // =========================================================================

    // Build CIDR addresses for each protocol. Both sets are always created so
    // the WAF rules wire up cleanly; populate whichever protocols were supplied.
    const ipv4Cidr = deployerIpv4 ? `${deployerIpv4}/32` : null;
    const ipv6Cidr = deployerIpv6 ? `${deployerIpv6}/128` : null;

    // IPv4 IP Set for deployer's IP address (REGIONAL scope for API Gateway)
    const apiIpv4Set = new wafv2.CfnIPSet(this, "ApiDeployerIPv4Set", {
      name: "fleet-api-deployer-ipv4-set",
      scope: "REGIONAL",
      ipAddressVersion: "IPV4",
      addresses: ipv4Cidr ? [ipv4Cidr] : [],
      description: "IPv4 allowlist for fleet tracking API access",
    });

    // IPv6 IP Set for deployer's IP address (REGIONAL scope for API Gateway)
    const apiIpv6Set = new wafv2.CfnIPSet(this, "ApiDeployerIPv6Set", {
      name: "fleet-api-deployer-ipv6-set",
      scope: "REGIONAL",
      ipAddressVersion: "IPV6",
      addresses: ipv6Cidr ? [ipv6Cidr] : [],
      description: "IPv6 allowlist for fleet tracking API access",
    });

    // WAF WebACL with IP restriction for API Gateway
    // Allows: OPTIONS (CORS), requests with Authorization header (authenticated), deployer IP
    const apiWebAcl = new wafv2.CfnWebACL(this, "ApiWebACL", {
      name: "fleet-api-waf",
      scope: "REGIONAL",
      defaultAction: { block: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "FleetApiWAF",
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          // Allow CORS preflight OPTIONS requests from any origin
          name: "AllowCORSPreflight",
          priority: 0,
          action: { allow: {} },
          statement: {
            byteMatchStatement: {
              fieldToMatch: { method: {} },
              positionalConstraint: "EXACTLY",
              searchString: "OPTIONS",
              textTransformations: [{ priority: 0, type: "NONE" }],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "ApiAllowCORSPreflight",
            sampledRequestsEnabled: true,
          },
        },
        {
          // Allow requests with Authorization header (authenticated via Cognito)
          // These requests will still be validated by the Cognito authorizer
          name: "AllowAuthenticatedRequests",
          priority: 1,
          action: { allow: {} },
          statement: {
            sizeConstraintStatement: {
              // `singleHeader` is typed `any` in CfnWebACL, i.e. a raw CloudFormation
              // passthrough. CDK's camelCase-to-PascalCase conversion does not descend
              // into `any` properties, so this object must already be PascalCase.
              // Writing `{ name: ... }` emits an invalid template that CloudFormation
              // happens to tolerate today; `cdk synth` flags it as F3002/F3003.
              fieldToMatch: {
                singleHeader: { Name: "authorization" },
              },
              comparisonOperator: "GT",
              size: 0,
              textTransformations: [{ priority: 0, type: "NONE" }],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "ApiAllowAuthenticated",
            sampledRequestsEnabled: true,
          },
        },
        {
          // Allow deployer IPv4 for direct API access (testing, CLI)
          name: "AllowDeployerIPv4",
          priority: 2,
          action: { allow: {} },
          statement: {
            ipSetReferenceStatement: {
              arn: apiIpv4Set.attrArn,
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "ApiAllowDeployerIPv4",
            sampledRequestsEnabled: true,
          },
        },
        {
          // Allow deployer IPv6 for direct API access (testing, CLI)
          name: "AllowDeployerIPv6",
          priority: 3,
          action: { allow: {} },
          statement: {
            ipSetReferenceStatement: {
              arn: apiIpv6Set.attrArn,
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "ApiAllowDeployerIPv6",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Associate WAF WebACL with REST API
    // The ARN format for API Gateway stage is: arn:aws:apigateway:{region}::/restapis/{api-id}/stages/{stage-name}
    const wafAssociation = new wafv2.CfnWebACLAssociation(this, "ApiWafAssociation", {
      resourceArn: this.restApi.deploymentStage.stageArn,
      webAclArn: apiWebAcl.attrArn,
    });

    // Output the WAF WebACL ARN for reference
    new cdk.CfnOutput(this, "ApiWebAclArn", {
      value: apiWebAcl.attrArn,
      description: "WAF WebACL ARN for API Gateway",
    });

    // Cognito JWT Authorizer for REST API
    // Requirements: 8.9 - API Gateway endpoints require Cognito JWT authorization
    this.cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "CognitoAuthorizer",
      {
        cognitoUserPools: [this.userPool],
        authorizerName: "fleet-cognito-authorizer",
        identitySource: "method.request.header.Authorization",
      }
    );

    const cognitoAuthorizer = this.cognitoAuthorizer;

    // Vehicle API Lambda handler
    // Requirements: 5.3 - REST API serves vehicle list, vehicle detail, job assignments, historical positions
    const vehicleApiLambda = new lambdaNode.NodejsFunction(this, "VehicleApiLambda", {
      projectRoot: REPO_ROOT,
      entry: lambdaEntry("vehicle-api/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        VEHICLE_STATE_TABLE: vehicleStateTable.tableName,
        DISPATCH_TABLE: dispatchTable.tableName,
        GPS_HISTORY_TABLE: gpsHistoryTable.tableName,
        PLACE_INDEX_NAME: placeIndexName,
        ROUTE_CALCULATOR_NAME: routeCalculatorName,
        GEOFENCE_COLLECTION_NAME: geofenceCollectionName,
        ...(emailSubscriptionsTable && { EMAIL_SUBSCRIPTIONS_TABLE: emailSubscriptionsTable.tableName }),
      },
    });

    // Grant DynamoDB permissions to Vehicle API Lambda
    vehicleStateTable.grantReadWriteData(vehicleApiLambda);
    dispatchTable.grantReadWriteData(vehicleApiLambda);
    gpsHistoryTable.grantReadData(vehicleApiLambda);
    if (emailSubscriptionsTable) {
      emailSubscriptionsTable.grantReadWriteData(vehicleApiLambda);
    }

    // Grant Location Service permissions to Vehicle API Lambda
    vehicleApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["geo:SearchPlaceIndexForText"],
        resources: [`arn:aws:geo:${this.region}:${this.account}:place-index/${placeIndexName}`],
      })
    );

    vehicleApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["geo:CalculateRoute"],
        resources: [`arn:aws:geo:${this.region}:${this.account}:route-calculator/${routeCalculatorName}`],
      })
    );

    vehicleApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["geo:PutGeofence"],
        resources: [`arn:aws:geo:${this.region}:${this.account}:geofence-collection/${geofenceCollectionName}`],
      })
    );

    // Grant IoT publish permission for sending job commands to vehicles
    vehicleApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iot:Publish"],
        resources: [`arn:aws:iot:${this.region}:${this.account}:topic/fleet/vehicles/*/commands/*`],
      })
    );

    // Lambda integration for REST API
    const vehicleApiIntegration = new apigateway.LambdaIntegration(vehicleApiLambda);

    // Authorization options for protected endpoints
    const authOptions: apigateway.MethodOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // REST API Routes
    // /vehicles
    const vehiclesResource = this.restApi.root.addResource("vehicles");
    vehiclesResource.addMethod("GET", vehicleApiIntegration, authOptions);

    // /vehicles/{id}
    const vehicleByIdResource = vehiclesResource.addResource("{id}");
    vehicleByIdResource.addMethod("GET", vehicleApiIntegration, authOptions);

    // /vehicles/{id}/history
    const vehicleHistoryResource = vehicleByIdResource.addResource("history");
    vehicleHistoryResource.addMethod("GET", vehicleApiIntegration, authOptions);

    // /vehicles/{id}/eta
    // Requirements: 3.4, 3.5, 5.7, 5.10 - Calculate ETA to destination address
    const vehicleEtaResource = vehicleByIdResource.addResource("eta");
    vehicleEtaResource.addMethod("GET", vehicleApiIntegration, authOptions);

    // /jobs
    const jobsResource = this.restApi.root.addResource("jobs");
    jobsResource.addMethod("GET", vehicleApiIntegration, authOptions);
    jobsResource.addMethod("POST", vehicleApiIntegration, authOptions);

    // /jobs/{id}
    const jobByIdResource = jobsResource.addResource("{id}");
    jobByIdResource.addMethod("PUT", vehicleApiIntegration, authOptions);

    // /subscriptions/email - Email notification subscriptions (Phase 2)
    const subscriptionsResource = this.restApi.root.addResource("subscriptions");
    const emailSubscriptionResource = subscriptionsResource.addResource("email");
    emailSubscriptionResource.addMethod("POST", vehicleApiIntegration, authOptions);
    emailSubscriptionResource.addMethod("DELETE", vehicleApiIntegration, authOptions);

    // =========================================================================
    // WebSocket API for real-time position updates
    // Requirements: 5.2, 5.12, 5.13, 8.10
    // =========================================================================

    // Create WebSocket API
    this.webSocketApi = new apigatewayv2.CfnApi(this, "FleetWebSocketApi", {
      name: "fleet-tracking-ws",
      protocolType: "WEBSOCKET",
      routeSelectionExpression: "$request.body.action",
    });

    // WebSocket stage
    const webSocketStage = new apigatewayv2.CfnStage(this, "WebSocketStage", {
      apiId: this.webSocketApi.ref,
      stageName: "v1",
      autoDeploy: true,
    });

    // Construct WebSocket endpoint URL for API Gateway Management API
    this.webSocketEndpoint = `https://${this.webSocketApi.ref}.execute-api.${this.region}.amazonaws.com/${webSocketStage.stageName}`;

    // WebSocket Connect Lambda
    // Requirements: 5.13, 8.10 - Validates Cognito token on $connect
    const wsConnectLambda = new lambdaNode.NodejsFunction(this, "WsConnectLambda", {
      projectRoot: REPO_ROOT,
      entry: lambdaEntry("websocket-connect/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        CONNECTIONS_TABLE: websocketConnectionsTable.tableName,
        USER_POOL_ID: this.userPool.userPoolId,
        CLIENT_ID: this.userPoolClient.userPoolClientId,
      },
      bundling: {
        // Include aws-jwt-verify for Cognito token validation
        nodeModules: ["aws-jwt-verify"],
      },
    });

    // Grant DynamoDB permissions to connect Lambda
    websocketConnectionsTable.grantWriteData(wsConnectLambda);

    // WebSocket Disconnect Lambda
    // Requirements: 5.13 - Removes connection from DynamoDB
    const wsDisconnectLambda = new lambdaNode.NodejsFunction(this, "WsDisconnectLambda", {
      projectRoot: REPO_ROOT,
      entry: lambdaEntry("websocket-disconnect/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        CONNECTIONS_TABLE: websocketConnectionsTable.tableName,
      },
    });

    // Grant DynamoDB permissions to disconnect Lambda
    websocketConnectionsTable.grantWriteData(wsDisconnectLambda);

    // WebSocket Broadcast Lambda (triggered by DynamoDB Streams)
    // Requirements: 5.2, 5.12 - Broadcasts vehicle updates to all connected clients
    const wsBroadcastLambda = new lambdaNode.NodejsFunction(this, "WsBroadcastLambda", {
      projectRoot: REPO_ROOT,
      entry: lambdaEntry("websocket-broadcast/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        CONNECTIONS_TABLE: websocketConnectionsTable.tableName,
        WEBSOCKET_ENDPOINT: this.webSocketEndpoint,
      },
    });

    // Grant DynamoDB permissions to broadcast Lambda
    websocketConnectionsTable.grantReadWriteData(wsBroadcastLambda);

    // Grant permission to post to WebSocket connections
    wsBroadcastLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:ManageConnections"],
        resources: [
          `arn:aws:execute-api:${this.region}:${this.account}:${this.webSocketApi.ref}/${webSocketStage.stageName}/POST/@connections/*`,
        ],
      })
    );

    // Wire DynamoDB Streams from vehicle-current-state table to broadcast Lambda
    // Requirements: 5.2, 5.12 - Real-time position updates
    wsBroadcastLambda.addEventSource(
      new lambdaEventSources.DynamoEventSource(vehicleStateTable as dynamodb.Table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(1),
        retryAttempts: 3,
      })
    );

    // Create Lambda integrations for WebSocket routes
    const wsConnectIntegration = new apigatewayv2.CfnIntegration(this, "WsConnectIntegration", {
      apiId: this.webSocketApi.ref,
      integrationType: "AWS_PROXY",
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${wsConnectLambda.functionArn}/invocations`,
    });

    const wsDisconnectIntegration = new apigatewayv2.CfnIntegration(this, "WsDisconnectIntegration", {
      apiId: this.webSocketApi.ref,
      integrationType: "AWS_PROXY",
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${wsDisconnectLambda.functionArn}/invocations`,
    });

    // Create WebSocket routes
    const connectRoute = new apigatewayv2.CfnRoute(this, "WsConnectRoute", {
      apiId: this.webSocketApi.ref,
      routeKey: "$connect",
      authorizationType: "NONE", // Auth handled in Lambda via token query param
      target: `integrations/${wsConnectIntegration.ref}`,
    });

    const disconnectRoute = new apigatewayv2.CfnRoute(this, "WsDisconnectRoute", {
      apiId: this.webSocketApi.ref,
      routeKey: "$disconnect",
      authorizationType: "NONE",
      target: `integrations/${wsDisconnectIntegration.ref}`,
    });

    // Default route (optional - for handling unknown actions)
    const defaultRoute = new apigatewayv2.CfnRoute(this, "WsDefaultRoute", {
      apiId: this.webSocketApi.ref,
      routeKey: "$default",
      authorizationType: "NONE",
      target: `integrations/${wsConnectIntegration.ref}`, // Reuse connect Lambda for default
    });

    // Grant API Gateway permission to invoke Lambda functions
    wsConnectLambda.addPermission("WsConnectPermission", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.webSocketApi.ref}/*/$connect`,
    });

    wsDisconnectLambda.addPermission("WsDisconnectPermission", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.webSocketApi.ref}/*/$disconnect`,
    });

    wsConnectLambda.addPermission("WsDefaultPermission", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.webSocketApi.ref}/*/$default`,
    });

    // Ensure routes are created after integrations
    connectRoute.addResourceDependency(wsConnectIntegration);
    disconnectRoute.addResourceDependency(wsDisconnectIntegration);
    defaultRoute.addResourceDependency(wsConnectIntegration);

    // =========================================================================
    // Phase 2: Tenant API, Analytics API
    // =========================================================================

    // Tenant API Lambda (only if tenantsTable provided)
    if (tenantsTable) {
      const tenantApiLambda = new lambdaNode.NodejsFunction(this, "TenantApiLambda", {
        projectRoot: REPO_ROOT,
        entry: lambdaEntry("tenant-api/index.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: {
          TENANTS_TABLE: tenantsTable.tableName,
        },
      });

      tenantsTable.grantReadWriteData(tenantApiLambda);

      // Tenant API routes: /admin/tenants
      const adminResource = this.restApi.root.addResource("admin");
      const tenantsResource = adminResource.addResource("tenants");
      const tenantApiIntegration = new apigateway.LambdaIntegration(tenantApiLambda);

      tenantsResource.addMethod("GET", tenantApiIntegration, authOptions);
      tenantsResource.addMethod("POST", tenantApiIntegration, authOptions);

      const tenantByIdResource = tenantsResource.addResource("{tenantId}");
      tenantByIdResource.addMethod("GET", tenantApiIntegration, authOptions);
      tenantByIdResource.addMethod("PUT", tenantApiIntegration, authOptions);
    }

    // Analytics API Lambda (only if analyticsDailyTable provided)
    if (analyticsDailyTable) {
      const analyticsApiLambda = new lambdaNode.NodejsFunction(this, "AnalyticsApiLambda", {
        projectRoot: REPO_ROOT,
        entry: lambdaEntry("analytics-api/index.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: {
          ANALYTICS_TABLE: analyticsDailyTable.tableName,
          DISPATCH_TABLE: dispatchTable.tableName,
        },
      });

      analyticsDailyTable.grantReadData(analyticsApiLambda);
      dispatchTable.grantReadData(analyticsApiLambda);

      // Analytics API routes: /analytics/*
      const analyticsResource = this.restApi.root.addResource("analytics");
      const analyticsApiIntegration = new apigateway.LambdaIntegration(analyticsApiLambda);

      const jobsAnalyticsResource = analyticsResource.addResource("jobs");
      jobsAnalyticsResource.addMethod("GET", analyticsApiIntegration, authOptions);

      const utilizationResource = analyticsResource.addResource("utilization");
      utilizationResource.addMethod("GET", analyticsApiIntegration, authOptions);

      const routesResource = analyticsResource.addResource("routes");
      routesResource.addMethod("GET", analyticsApiIntegration, authOptions);

      // Analytics Aggregator Lambda (Scheduled daily)
      const analyticsAggregatorLambda = new lambdaNode.NodejsFunction(this, "AnalyticsAggregatorLambda", {
        projectRoot: REPO_ROOT,
        entry: lambdaEntry("analytics-aggregator/index.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: cdk.Duration.minutes(5),
        memorySize: 512,
        environment: {
          DISPATCH_TABLE: dispatchTable.tableName,
          VEHICLE_STATE_TABLE: vehicleStateTable.tableName,
          ANALYTICS_TABLE: analyticsDailyTable.tableName,
        },
      });

      dispatchTable.grantReadData(analyticsAggregatorLambda);
      vehicleStateTable.grantReadData(analyticsAggregatorLambda);
      analyticsDailyTable.grantWriteData(analyticsAggregatorLambda);

      // Grant CloudWatch metrics permission
      analyticsAggregatorLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
        })
      );

      // Schedule: Run daily at midnight UTC
      new events.Rule(this, "AnalyticsAggregatorSchedule", {
        ruleName: "fleet-analytics-aggregator",
        description: "Triggers analytics aggregation daily at midnight UTC",
        schedule: events.Schedule.cron({ minute: "0", hour: "0" }),
        targets: [new targets.LambdaFunction(analyticsAggregatorLambda)],
      });
    }

    // =========================================================================
    // Outputs
    // =========================================================================

    // REST API URL output
    new cdk.CfnOutput(this, "RestApiUrl", {
      value: this.restApi.url,
      description: "Fleet Tracking REST API URL",
    });

    // WebSocket API URL output
    new cdk.CfnOutput(this, "WebSocketApiUrl", {
      value: `wss://${this.webSocketApi.ref}.execute-api.${this.region}.amazonaws.com/${webSocketStage.stageName}`,
      description: "Fleet Tracking WebSocket API URL",
    });

    new cdk.CfnOutput(this, "WebSocketEndpoint", {
      value: this.webSocketEndpoint,
      description: "WebSocket Management API Endpoint (for Lambda broadcast)",
    });
  }
}
