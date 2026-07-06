#!/bin/bash
# Fleet Tracking Platform - Post-Cleanup Script
# Removes orphaned resources that may remain after CDK stack deletion
# Run AFTER: npx cdk destroy --all --force
# Usage: ./scripts/post-cleanup.sh

set -e

# Load shared configuration (AWS_REGION, FLEET_VEHICLES, etc.)
source "$(dirname "$0")/lib/config.sh"

# CloudFront WAF resources are global and must be queried from us-east-1.
# This is an AWS constraint, not configurable.
CLOUDFRONT_WAF_REGION="us-east-1"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "unknown")

echo "Fleet Tracking Platform - Post-Cleanup"
echo "======================================="
echo "Region: $AWS_REGION"
echo "Account: $ACCOUNT_ID"
echo ""
echo "This script removes any orphaned resources after CDK destroy."
echo ""

# 1. IoT Certificates (delete any remaining)
echo "=== Cleaning Orphaned IoT Certificates ==="
for thing in "${FLEET_VEHICLES[@]}"; do
  cert_arns=$(aws iot list-thing-principals --thing-name "$thing" --region "$AWS_REGION" --query 'principals[*]' --output text 2>/dev/null || true)
  if [ -n "$cert_arns" ]; then
    for cert_arn in $cert_arns; do
      cert_id=$(echo "$cert_arn" | cut -d'/' -f2)
      echo "  Deleting orphaned certificate $cert_id..."
      aws iot detach-thing-principal --thing-name "$thing" --principal "$cert_arn" --region "$AWS_REGION" 2>/dev/null || true
      aws iot detach-policy --policy-name "$FLEET_VEHICLE_POLICY" --target "$cert_arn" --region "$AWS_REGION" 2>/dev/null || true
      aws iot update-certificate --certificate-id "$cert_id" --new-status INACTIVE --region "$AWS_REGION" 2>/dev/null || true
      aws iot delete-certificate --certificate-id "$cert_id" --region "$AWS_REGION" 2>/dev/null || true
    done
  fi
done

# 2. IoT Things (delete any remaining)
echo "=== Cleaning Orphaned IoT Things ==="
for thing in "${FLEET_VEHICLES[@]}"; do
  aws iot delete-thing --thing-name "$thing" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted $thing" || true
done

# 3. IoT Thing Group
echo "=== Cleaning IoT Thing Group ==="
aws iot delete-thing-group --thing-group-name "$FLEET_THING_GROUP" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted $FLEET_THING_GROUP" || true

# 4. IoT Thing Type
echo "=== Cleaning IoT Thing Type ==="
# Deprecate first, then delete
aws iot deprecate-thing-type --thing-type-name "FleetVehicle" --region "$AWS_REGION" 2>/dev/null || true
aws iot delete-thing-type --thing-type-name "FleetVehicle" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted FleetVehicle thing type" || true

# 5. IoT Policy
echo "=== Cleaning IoT Policy ==="
aws iot delete-policy --policy-name "$FLEET_VEHICLE_POLICY" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted $FLEET_VEHICLE_POLICY" || true

# 6. DynamoDB Tables (if any remain)
echo "=== Cleaning Orphaned DynamoDB Tables ==="
for table in gps-history vehicle-current-state websocket-connections dispatch-assignments tenants email-subscriptions analytics-daily; do
  aws dynamodb delete-table --table-name "$table" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted $table" || true
done

# 7. Kinesis Stream
echo "=== Cleaning Kinesis Stream ==="
aws kinesis delete-stream --stream-name "fleet-gps-stream" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted fleet-gps-stream" || true

# 8. SQS Queues
echo "=== Cleaning SQS Queues ==="
for queue_name in "fleet-gps-processor-dlq" "fleet-iot-rules-dlq" "fleet-notifications" "fleet-notification-dlq"; do
  queue_url=$(aws sqs get-queue-url --queue-name "$queue_name" --region "$AWS_REGION" --query "QueueUrl" --output text 2>/dev/null || true)
  if [ -n "$queue_url" ] && [ "$queue_url" != "None" ]; then
    aws sqs delete-queue --queue-url "$queue_url" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted $queue_name" || true
  fi
done

# 9. Cognito User Pool
echo "=== Cleaning Cognito User Pool ==="
pool_id=$(aws cognito-idp list-user-pools --max-results 20 --region "$AWS_REGION" --query "UserPools[?Name=='fleet-dispatch-users'].Id" --output text 2>/dev/null)
if [ -n "$pool_id" ] && [ "$pool_id" != "None" ]; then
  aws cognito-idp delete-user-pool --user-pool-id "$pool_id" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted fleet-dispatch-users" || true
fi

# 10. Cognito Identity Pool
echo "=== Cleaning Cognito Identity Pool ==="
identity_pool_id=$(aws cognito-identity list-identity-pools --max-results 20 --region "$AWS_REGION" --query "IdentityPools[?IdentityPoolName=='fleet_tracking_identity_pool'].IdentityPoolId" --output text 2>/dev/null)
if [ -n "$identity_pool_id" ] && [ "$identity_pool_id" != "None" ]; then
  aws cognito-identity delete-identity-pool --identity-pool-id "$identity_pool_id" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted fleet_tracking_identity_pool" || true
fi

# 11. Location Service
echo "=== Cleaning Location Service ==="
aws location delete-tracker --tracker-name "$FLEET_TRACKER" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted $FLEET_TRACKER" || true
aws location delete-geofence-collection --collection-name "$FLEET_GEOFENCE_COLLECTION" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted $FLEET_GEOFENCE_COLLECTION" || true
aws location delete-map --map-name "fleet-map" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted fleet-map" || true
aws location delete-route-calculator --calculator-name "fleet-routes" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted fleet-routes" || true
aws location delete-place-index --index-name "fleet-places" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted fleet-places" || true

# 12. S3 Buckets
echo "=== Cleaning S3 Buckets ==="
for bucket in $(aws s3 ls 2>/dev/null | grep -E "fleet-dashboard-|fleet-gps-archive-" | awk '{print $3}'); do
  echo "  Emptying and deleting $bucket..."
  aws s3 rm "s3://$bucket" --recursive --region "$AWS_REGION" 2>/dev/null || true
  aws s3 rb "s3://$bucket" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted $bucket" || true
done

# 13. Secrets Manager
echo "=== Cleaning Secrets Manager ==="
for secret in $(aws secretsmanager list-secrets --region "$AWS_REGION" --query "SecretList[?contains(Name, 'fleet')].Name" --output text 2>/dev/null); do
  aws secretsmanager delete-secret --secret-id "$secret" --force-delete-without-recovery --region "$AWS_REGION" 2>/dev/null && echo "  Deleted $secret" || true
done

# 14. SSM Parameters
echo "=== Cleaning SSM Parameters ==="
params=$(aws ssm describe-parameters --region "$AWS_REGION" --parameter-filters "Key=Name,Option=BeginsWith,Values=/fleet-tracking/" --query "Parameters[*].Name" --output text 2>/dev/null || true)
for param in $params; do
  aws ssm delete-parameter --name "$param" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted $param" || true
done

# 15. CloudWatch Log Groups
echo "=== Cleaning CloudWatch Log Groups ==="
for prefix in "/aws/lambda/Fleet" "/aws/apigateway/fleet"; do
  log_groups=$(aws logs describe-log-groups --log-group-name-prefix "$prefix" --region "$AWS_REGION" --query "logGroups[*].logGroupName" --output text 2>/dev/null || true)
  for lg in $log_groups; do
    aws logs delete-log-group --log-group-name "$lg" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted $lg" || true
  done
done

# 16. SNS Topics
echo "=== Cleaning SNS Topics ==="
sns_arn="arn:aws:sns:$AWS_REGION:$ACCOUNT_ID:fleet-ops-alerts"
aws sns delete-topic --topic-arn "$sns_arn" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted fleet-ops-alerts" || true

# 17. WAF WebACLs and IP Sets (Regional scope)
echo "=== Cleaning WAF Resources (Regional) ==="
for acl_name in "fleet-api-waf"; do
  acl_info=$(aws wafv2 list-web-acls --scope REGIONAL --region "$AWS_REGION" --query "WebACLs[?Name=='$acl_name'].[Id,LockToken]" --output text 2>/dev/null)
  if [ -n "$acl_info" ] && [ "$acl_info" != "None" ]; then
    acl_id=$(echo "$acl_info" | awk '{print $1}')
    lock_token=$(echo "$acl_info" | awk '{print $2}')
    aws wafv2 delete-web-acl --name "$acl_name" --scope REGIONAL --id "$acl_id" --lock-token "$lock_token" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted $acl_name" || true
  fi
done

for ip_set_name in "fleet-api-deployer-ip-set"; do
  ip_set_info=$(aws wafv2 list-ip-sets --scope REGIONAL --region "$AWS_REGION" --query "IPSets[?Name=='$ip_set_name'].[Id,LockToken]" --output text 2>/dev/null)
  if [ -n "$ip_set_info" ] && [ "$ip_set_info" != "None" ]; then
    ip_set_id=$(echo "$ip_set_info" | awk '{print $1}')
    lock_token=$(echo "$ip_set_info" | awk '{print $2}')
    aws wafv2 delete-ip-set --name "$ip_set_name" --scope REGIONAL --id "$ip_set_id" --lock-token "$lock_token" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted $ip_set_name" || true
  fi
done

# 18. WAF WebACLs and IP Sets (CloudFront scope)
# CloudFront WAF resources are global and queried via us-east-1 — this is an AWS constraint.
echo "=== Cleaning WAF Resources (CloudFront) ==="
for acl_name in "fleet-dashboard-waf"; do
  acl_info=$(aws wafv2 list-web-acls --scope CLOUDFRONT --region "$CLOUDFRONT_WAF_REGION" --query "WebACLs[?Name=='$acl_name'].[Id,LockToken]" --output text 2>/dev/null)
  if [ -n "$acl_info" ] && [ "$acl_info" != "None" ]; then
    acl_id=$(echo "$acl_info" | awk '{print $1}')
    lock_token=$(echo "$acl_info" | awk '{print $2}')
    aws wafv2 delete-web-acl --name "$acl_name" --scope CLOUDFRONT --id "$acl_id" --lock-token "$lock_token" --region "$CLOUDFRONT_WAF_REGION" 2>/dev/null && echo "  Deleted $acl_name" || true
  fi
done

for ip_set_name in "fleet-deployer-ipv4-set" "fleet-deployer-ipv6-set"; do
  ip_set_info=$(aws wafv2 list-ip-sets --scope CLOUDFRONT --region "$CLOUDFRONT_WAF_REGION" --query "IPSets[?Name=='$ip_set_name'].[Id,LockToken]" --output text 2>/dev/null)
  if [ -n "$ip_set_info" ] && [ "$ip_set_info" != "None" ]; then
    ip_set_id=$(echo "$ip_set_info" | awk '{print $1}')
    lock_token=$(echo "$ip_set_info" | awk '{print $2}')
    aws wafv2 delete-ip-set --name "$ip_set_name" --scope CLOUDFRONT --id "$ip_set_id" --lock-token "$lock_token" --region "$CLOUDFRONT_WAF_REGION" 2>/dev/null && echo "  Deleted $ip_set_name" || true
  fi
done

# 19. Force delete stuck CloudFormation stacks
echo "=== Cleaning Stuck CloudFormation Stacks ==="
for stack in FleetMonitoringStack FleetHostingStack FleetApiStack FleetLocationStack FleetIngestionStack FleetIoTStack FleetPhase2TablesStack; do
  status=$(aws cloudformation describe-stacks --stack-name "$stack" --region "$AWS_REGION" --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "NOT_FOUND")
  if [[ "$status" != "NOT_FOUND" ]] && [[ "$status" != "DELETE_COMPLETE" ]]; then
    echo "  Force deleting $stack (status: $status)..."
    aws cloudformation delete-stack --stack-name "$stack" --region "$AWS_REGION" 2>/dev/null || true
  fi
done

# 20. Orphaned Lambda Functions (CDK custom resource handlers)
echo "=== Cleaning Orphaned Lambda Functions ==="
orphan_lambdas=$(aws lambda list-functions --region "$AWS_REGION" --query "Functions[?starts_with(FunctionName, 'FleetIoTStack-') || starts_with(FunctionName, 'FleetApiStack-') || starts_with(FunctionName, 'FleetLocationStack-') || starts_with(FunctionName, 'FleetIngestionStack-') || starts_with(FunctionName, 'FleetHostingStack-') || starts_with(FunctionName, 'FleetMonitoringStack-')].FunctionName" --output text 2>/dev/null || true)
for fn in $orphan_lambdas; do
  aws lambda delete-function --function-name "$fn" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted $fn" || true
done

# 21. Orphaned IAM Roles (CDK-created roles that may remain)
echo "=== Cleaning Orphaned IAM Roles ==="
orphan_roles=$(aws iam list-roles --query "Roles[?starts_with(RoleName, 'FleetIoTStack-') || starts_with(RoleName, 'FleetApiStack-') || starts_with(RoleName, 'FleetLocationStack-') || starts_with(RoleName, 'FleetIngestionStack-') || starts_with(RoleName, 'FleetHostingStack-') || starts_with(RoleName, 'FleetMonitoringStack-')].RoleName" --output text 2>/dev/null || true)
for role in $orphan_roles; do
  # First detach all managed policies
  attached_policies=$(aws iam list-attached-role-policies --role-name "$role" --query "AttachedPolicies[].PolicyArn" --output text 2>/dev/null || true)
  for policy_arn in $attached_policies; do
    aws iam detach-role-policy --role-name "$role" --policy-arn "$policy_arn" 2>/dev/null || true
  done
  # Delete inline policies
  inline_policies=$(aws iam list-role-policies --role-name "$role" --query "PolicyNames[]" --output text 2>/dev/null || true)
  for policy_name in $inline_policies; do
    aws iam delete-role-policy --role-name "$role" --policy-name "$policy_name" 2>/dev/null || true
  done
  # Delete the role
  aws iam delete-role --role-name "$role" 2>/dev/null && echo "  Deleted role $role" || true
done

# 22. Orphaned IoT Certificates (not attached to things)
echo "=== Cleaning Orphaned IoT Certificates ==="
all_certs=$(aws iot list-certificates --region "$AWS_REGION" --query "certificates[].certificateId" --output text 2>/dev/null || true)
for cert_id in $all_certs; do
  cert_arn="arn:aws:iot:$AWS_REGION:$ACCOUNT_ID:cert/$cert_id"
  # Check if attached to any things
  attached_things=$(aws iot list-principal-things --principal "$cert_arn" --region "$AWS_REGION" --query "things[]" --output text 2>/dev/null || true)
  if [ -z "$attached_things" ]; then
    # Detach any policies
    attached_policies=$(aws iot list-attached-policies --target "$cert_arn" --region "$AWS_REGION" --query "policies[].policyName" --output text 2>/dev/null || true)
    for policy in $attached_policies; do
      aws iot detach-policy --policy-name "$policy" --target "$cert_arn" --region "$AWS_REGION" 2>/dev/null || true
    done
    # Deactivate and delete
    aws iot update-certificate --certificate-id "$cert_id" --new-status INACTIVE --region "$AWS_REGION" 2>/dev/null || true
    aws iot delete-certificate --certificate-id "$cert_id" --region "$AWS_REGION" 2>/dev/null && echo "  Deleted orphaned certificate $cert_id" || true
  fi
done

# 23. Local certificates
echo "=== Cleaning Local Certificates ==="
if [ -d "./certs" ]; then
  rm -rf ./certs/vehicle-*
  echo "  Removed local certificate files"
fi

echo ""
echo "======================================="
echo "Post-cleanup complete!"
