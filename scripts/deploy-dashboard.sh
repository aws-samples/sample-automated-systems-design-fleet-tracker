#!/bin/bash
# Deploy Fleet Tracking Dashboard to S3 + CloudFront
# Usage: ./scripts/deploy-dashboard.sh

set -e

# Load shared configuration (AWS_REGION, etc.)
source "$(dirname "$0")/lib/config.sh"

echo "Fleet Dashboard Deployment"
echo "=========================="
echo ""

# Refresh WAF allowlists for the current IPv4/IPv6 before uploading. macOS IPv6
# addresses rotate on a privacy timer, so the address baked in at `cdk deploy`
# time may already be stale by the time the browser tries to load the dashboard.
# When the allowlist is stale, every request hits WAF's 403, CloudFront's SPA
# error rule serves /index.html for *all* paths, and the browser refuses CSS/JS
# with strict MIME errors. This call keeps that from recurring.
echo "Refreshing WAF allowlists for current IP..."
"$(dirname "$0")/update-ip-allowlist.sh" || {
  echo "Warning: failed to refresh WAF allowlists. Dashboard upload will continue,"
  echo "but you may need to run scripts/update-ip-allowlist.sh manually."
}
echo ""

# Get S3 bucket name from CloudFormation
BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name FleetHostingStack \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DashboardBucketName'].OutputValue" \
  --output text 2>/dev/null)

if [ -z "$BUCKET_NAME" ] || [ "$BUCKET_NAME" == "None" ]; then
  echo "Error: Could not find S3 bucket. Make sure FleetHostingStack is deployed."
  exit 1
fi

DISTRIBUTION_ID=$(aws cloudformation describe-stacks \
  --stack-name FleetHostingStack \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDistributionId'].OutputValue" \
  --output text 2>/dev/null)

echo "S3 Bucket: $BUCKET_NAME"
echo "CloudFront Distribution: $DISTRIBUTION_ID"
echo ""

# Get API configuration from CloudFormation
echo "Fetching API configuration..."
API_URL=$(aws cloudformation describe-stacks \
  --stack-name FleetApiStack \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='RestApiUrl'].OutputValue" \
  --output text 2>/dev/null || echo "")

WS_URL=$(aws cloudformation describe-stacks \
  --stack-name FleetApiStack \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='WebSocketApiUrl'].OutputValue" \
  --output text 2>/dev/null || echo "")

USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name FleetApiStack \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text 2>/dev/null || echo "")

USER_POOL_CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name FleetApiStack \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" \
  --output text 2>/dev/null || echo "")

IDENTITY_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name FleetApiStack \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='IdentityPoolId'].OutputValue" \
  --output text 2>/dev/null || echo "")

echo "API URL: $API_URL"
echo "WebSocket URL: $WS_URL"
echo "User Pool ID: $USER_POOL_ID"
echo "Identity Pool ID: $IDENTITY_POOL_ID"
echo ""

# Build the dashboard
echo "Building dashboard..."
pushd dashboard > /dev/null

# Create .env file with API configuration
cat > .env << EOF
VITE_API_URL=$API_URL
VITE_WS_URL=$WS_URL
VITE_USER_POOL_ID=$USER_POOL_ID
VITE_USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID
VITE_IDENTITY_POOL_ID=$IDENTITY_POOL_ID
VITE_AWS_REGION=$AWS_REGION
EOF

npm run build

popd > /dev/null

# Sync to S3
echo "Uploading to S3..."
aws s3 sync dashboard/dist/ "s3://$BUCKET_NAME" \
  --delete \
  --region "$AWS_REGION"

# Invalidate CloudFront cache
echo "Invalidating CloudFront cache..."
INVALIDATION_ID=$(aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths "/*" \
  --query "Invalidation.Id" \
  --output text)

echo "Invalidation started: $INVALIDATION_ID"
echo "Note: Invalidation runs in background (typically 5-15 min). Dashboard is already deployed."

# Get CloudFront URL
CF_URL=$(aws cloudformation describe-stacks \
  --stack-name FleetHostingStack \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" \
  --output text)

echo ""
echo "=========================="
echo "Dashboard deployed!"
echo "URL: $CF_URL"
echo ""

# Note: The CloudWatch dashboard's WebSocket metrics are now wired natively via the CDK
# cross-stack reference between FleetApiStack and FleetMonitoringStack. No post-deploy
# patching is needed.

echo "Login credentials:"
echo "  Email: demo@fleet-tracking.local"
echo "  Password: (run this command to get it)"
echo "    aws secretsmanager get-secret-value --secret-id fleet-tracking/demo-user-password --query SecretString --output text | jq -r .password"
