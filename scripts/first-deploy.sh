#!/usr/bin/env bash
# First deploy of a stage (docs/DEPLOY.md "First deploy"). APP_URL is read from SSM at deploy time but the CloudFront
# domain exists only after the first deploy, so: placeholder → deploy → read the domain → write it → redeploy → web → smoke.
#   scripts/first-deploy.sh staging [admin-email-for-smoke]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/stage-env.sh" "${1:-staging}"; SMOKE_EMAIL="${2:-}"
P="${SSM_PREFIX}"
need() { aws ssm get-parameter --name "$1" --with-decryption >/dev/null 2>&1 || { echo "missing SSM parameter $1 — see docs/DEPLOY.md"; exit 1; }; }
need "${P}/mongodb-uri"; need "${P}/app-secret"; need "${P}/origin-secret"
aws ssm get-parameter --name "${P}/origin-secret-previous" >/dev/null 2>&1 \
  || aws ssm put-parameter --name "${P}/origin-secret-previous" --type SecureString --value "" --overwrite >/dev/null
if ! aws ssm get-parameter --name "${P}/app-url" >/dev/null 2>&1; then
  echo "app-url missing → placeholder until the distribution exists"
  aws ssm put-parameter --name "${P}/app-url" --type String --value "https://placeholder.invalid" >/dev/null
fi
npx serverless deploy --stage "${STAGE}" --region "${REGION}"
# WebUrl is https://<web-domain> when /eayni/<stage>/web-domain is set, else the *.cloudfront.net domain
WEB_URL=$(stack_output WebUrl)
GW=$(stack_output HttpApiUrl)
echo "web: ${WEB_URL}  api gateway: ${GW}"
CURRENT=$(aws ssm get-parameter --name "${P}/app-url" --query Parameter.Value --output text)
if [ "${CURRENT}" != "${WEB_URL}" ]; then
  aws ssm put-parameter --name "${P}/app-url" --type String --value "${WEB_URL}" --overwrite >/dev/null
  echo "app-url set → redeploy so CORS, cookies and the files-bucket CORS use it"
  npx serverless deploy --stage "${STAGE}" --region "${REGION}"
fi
"$HERE/deploy-web.sh" "${STAGE}"
"$HERE/smoke-staging.sh" "${WEB_URL}" "${GW}" ${SMOKE_EMAIL:+"${SMOKE_EMAIL}"}
echo "next: npx serverless invoke -f bootstrap --stage ${STAGE} --data '{\"adminEmail\":\"you@eayni.local\"}'"
