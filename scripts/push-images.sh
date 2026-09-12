#!/usr/bin/env bash
# =============================================================================
# Build and push the api/web images to GHCR — with the annotations that make
# GitHub link them to this repository.
# =============================================================================
# WHY THIS EXISTS: `LABEL org.opencontainers.image.source` in a Dockerfile is a
# CONFIG label on the child image. buildx pushes an OCI image INDEX (the image
# plus its provenance attestation), and GHCR reads the source from an
# ANNOTATION on that index — it never descends into the child config. So the
# Dockerfile label looks correct, shows up in `docker inspect`, and links
# nothing. The `index:` prefix below is the load-bearing part: without it the
# annotation lands on the child manifest and the package stays unlinked.
#
# THIS SCRIPT CANNOT REACH PRODUCTION. Production runs from ECR: ecs.tf pulls
# aws_ecr_repository.this["api"|"web"] at var.image_tag, .github/workflows/
# deploy.yml sets that to the git SHA, and the ECR repos are tag-IMMUTABLE.
# Nothing in the stack pulls ghcr.io. The registry is hard-coded and guarded
# below so a stray REGISTRY= in the environment cannot redirect a push there.
#
#   ./scripts/push-images.sh                      # amd64, :latest + :<sha>
#   PLATFORMS=linux/amd64,linux/arm64 ./scripts/push-images.sh
#   DRY_RUN=1 ./scripts/push-images.sh            # print, build nothing
# =============================================================================
set -euo pipefail

readonly REGISTRY="ghcr.io"
readonly OWNER="${GHCR_OWNER:-nwosumajor}"
readonly SOURCE_URL="https://github.com/nwosumajor/maestro-sms"
readonly PLATFORMS="${PLATFORMS:-linux/amd64}"
readonly DRY_RUN="${DRY_RUN:-0}"

cd "$(dirname "$0")/.."
readonly ROOT="$PWD"

# --- guard: this script pushes to GHCR and nowhere else ----------------------
# A belt-and-braces check. The registry is a readonly constant above, so this
# can only fire if someone edits it — which is exactly when you want to be told.
case "$REGISTRY" in
  *ecr*|*amazonaws*) echo "refusing: $REGISTRY is a production registry" >&2; exit 1 ;;
esac

# --- version: what actually goes in the annotation ---------------------------
sha="$(git rev-parse --short=12 HEAD)"
if ! git diff --quiet HEAD 2>/dev/null; then
  sha="${sha}-dirty"
  echo "WARNING: working tree is dirty — tagging ${sha}" >&2
  echo "         the image will not correspond to any commit." >&2
fi
readonly sha
readonly created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "registry   $REGISTRY/$OWNER"
echo "platforms  $PLATFORMS"
echo "revision   $sha"
echo

for svc in api web; do
  image="$REGISTRY/$OWNER/maestro-sms-$svc"
  case "$svc" in
    api) desc="MAESTRO-SMS — API (NestJS)" ;;
    web) desc="MAESTRO-SMS — web (Next.js)" ;;
  esac

  # Annotations go on the INDEX (what GHCR reads) and on the MANIFEST (what
  # `docker buildx imagetools inspect` shows per-platform). Both, because a
  # reader checking one and finding it bare learns the wrong thing.
  args=(
    buildx build
    --file "apps/$svc/Dockerfile"
    --platform "$PLATFORMS"
    --tag "$image:latest"
    --tag "$image:$sha"
    # Build-time egress to the npm registry, matching docker-compose.yml.
    --network=host
    --push
  )
  for scope in index manifest; do
    args+=(
      --annotation "$scope:org.opencontainers.image.source=$SOURCE_URL"
      --annotation "$scope:org.opencontainers.image.description=$desc"
      --annotation "$scope:org.opencontainers.image.revision=$sha"
      --annotation "$scope:org.opencontainers.image.created=$created"
      --annotation "$scope:org.opencontainers.image.licenses=UNLICENSED"
    )
  done
  args+=("$ROOT")

  echo "==> $image"
  if [ "$DRY_RUN" = "1" ]; then
    printf '    docker'; printf ' %q' "${args[@]}"; echo
    continue
  fi
  docker "${args[@]}"
done

[ "$DRY_RUN" = "1" ] && exit 0

# --- verify: the annotation is on the index, or this script did nothing ------
# Pushing successfully is not the same as pushing something GHCR can link. The
# defect this script exists for was invisible to every `docker push` that ever
# ran, so the check belongs here rather than in a reader's memory.
echo
fail=0
for svc in api web; do
  image="$REGISTRY/$OWNER/maestro-sms-$svc"
  got="$(docker buildx imagetools inspect "$image:latest" --raw \
    | python3 -c 'import json,sys; print((json.load(sys.stdin).get("annotations") or {}).get("org.opencontainers.image.source",""))')"
  if [ "$got" = "$SOURCE_URL" ]; then
    echo "OK   $image  index source=$got"
  else
    echo "FAIL $image  index source=${got:-<none>}" >&2
    fail=1
  fi
done
exit "$fail"
