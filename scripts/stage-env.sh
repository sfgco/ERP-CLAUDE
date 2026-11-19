#!/usr/bin/env bash
# Shared names for the deploy scripts. Source it: `. "$(dirname "$0")/stage-env.sh" "$STAGE"`.
# SERVICE must equal `service:` in serverless.yml; the region defaults to the one in serverless.yml and is overridden
# with AWS_REGION (the GitHub workflow passes vars.AWS_REGION).
SERVICE="eayni-system"
STAGE="${1:-staging}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-me-south-1}}"
STACK="${SERVICE}-${STAGE}"
WEB_BUCKET="${SERVICE}-${STAGE}-web"
SSM_PREFIX="/eayni/${STAGE}"
export AWS_REGION="${REGION}" AWS_DEFAULT_REGION="${REGION}"
stack_output() { aws cloudformation describe-stacks --stack-name "${STACK}" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
