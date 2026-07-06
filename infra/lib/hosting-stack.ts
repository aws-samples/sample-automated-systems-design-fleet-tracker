import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { Construct } from "constructs";

export interface HostingStackProps extends cdk.StackProps {
  /**
   * Deployer IPv4 address (without CIDR suffix). When set, allowlists this address
   * for CloudFront access. Provide both deployerIpv4 and deployerIpv6 when the
   * client may reach CloudFront over either protocol — IPv6 in particular can
   * rotate (privacy extensions on macOS), so populating both sets is recommended.
   */
  deployerIpv4?: string;
  /**
   * Deployer IPv6 address (without CIDR suffix). When set, allowlists this address
   * for CloudFront access.
   */
  deployerIpv6?: string;
  /** REST API URL for dashboard configuration */
  restApiUrl?: string;
  /** WebSocket API URL for dashboard configuration */
  webSocketUrl?: string;
  /** Cognito User Pool ID */
  userPoolId?: string;
  /** Cognito User Pool Client ID */
  userPoolClientId?: string;
  /** Cognito Identity Pool ID for AWS credentials */
  identityPoolId?: string;
}

export class HostingStack extends cdk.Stack {
  public readonly webAcl: wafv2.CfnWebACL;
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: HostingStackProps) {
    super(scope, id, props);

    const { deployerIpv4, deployerIpv6 } = props;

    // Build CIDR addresses for each protocol. Both sets are always created so
    // the WAF rules wire up cleanly; populate whichever protocols were supplied.
    const ipv4Cidr = deployerIpv4 ? `${deployerIpv4}/32` : null;
    const ipv6Cidr = deployerIpv6 ? `${deployerIpv6}/128` : null;

    // IPv4 IP Set for deployer's IP address
    const ipv4Set = new wafv2.CfnIPSet(this, "DeployerIPv4Set", {
      name: "fleet-deployer-ipv4-set",
      scope: "CLOUDFRONT",
      ipAddressVersion: "IPV4",
      addresses: ipv4Cidr ? [ipv4Cidr] : [],
      description: "IPv4 allowlist for fleet tracking dashboard access",
    });

    // IPv6 IP Set for deployer's IP address
    const ipv6Set = new wafv2.CfnIPSet(this, "DeployerIPv6Set", {
      name: "fleet-deployer-ipv6-set",
      scope: "CLOUDFRONT",
      ipAddressVersion: "IPV6",
      addresses: ipv6Cidr ? [ipv6Cidr] : [],
      description: "IPv6 allowlist for fleet tracking dashboard access",
    });

    // WAF WebACL with IP restriction for CloudFront
    this.webAcl = new wafv2.CfnWebACL(this, "DashboardWebACL", {
      name: "fleet-dashboard-waf",
      scope: "CLOUDFRONT",
      defaultAction: { block: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "FleetDashboardWAF",
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "AllowDeployerIPv4",
          priority: 1,
          action: { allow: {} },
          statement: {
            ipSetReferenceStatement: {
              arn: ipv4Set.attrArn,
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AllowDeployerIPv4",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AllowDeployerIPv6",
          priority: 2,
          action: { allow: {} },
          statement: {
            ipSetReferenceStatement: {
              arn: ipv6Set.attrArn,
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AllowDeployerIPv6",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Output IP Set ARNs for easy updates
    new cdk.CfnOutput(this, "WebAclArn", {
      value: this.webAcl.attrArn,
      description: "WAF WebACL ARN",
    });

    new cdk.CfnOutput(this, "IPv4SetArn", {
      value: ipv4Set.attrArn,
      description: "IPv4 IP Set ARN - update with: aws wafv2 update-ip-set",
    });

    new cdk.CfnOutput(this, "IPv6SetArn", {
      value: ipv6Set.attrArn,
      description: "IPv6 IP Set ARN - update with: aws wafv2 update-ip-set",
    });

    // =========================================================================
    // S3 Bucket for Dashboard Static Files
    // =========================================================================

    this.bucket = new s3.Bucket(this, "DashboardBucket", {
      bucketName: `fleet-dashboard-${this.account}-${this.region}`,
      // Block all public access - CloudFront uses OAC
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // Encryption at rest
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Allow cleanup for demo
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // Enforce SSL
      enforceSSL: true,
    });

    // =========================================================================
    // CloudFront Distribution with S3 Origin
    // =========================================================================

    // Origin Access Control for secure S3 access
    const oac = new cloudfront.S3OriginAccessControl(this, "DashboardOAC", {
      originAccessControlName: "fleet-dashboard-oac",
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });

    // S3 origin with OAC
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
      originAccessControl: oac,
    });

    // CloudFront distribution
    this.distribution = new cloudfront.Distribution(this, "DashboardDistribution", {
      comment: "Fleet tracking dashboard",
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        // Security headers
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      // WAF protection
      webAclId: this.webAcl.attrArn,
      // HTTP/2 for performance
      httpVersion: cloudfront.HttpVersion.HTTP2,
      // Price class for demo
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      // SPA routing
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, "DashboardBucketName", {
      value: this.bucket.bucketName,
      description: "S3 bucket for dashboard files",
    });

    new cdk.CfnOutput(this, "CloudFrontDomain", {
      value: `https://${this.distribution.distributionDomainName}`,
      description: "Dashboard URL (WAF protected)",
    });

    new cdk.CfnOutput(this, "CloudFrontDistributionId", {
      value: this.distribution.distributionId,
      description: "CloudFront Distribution ID",
    });
  }
}
