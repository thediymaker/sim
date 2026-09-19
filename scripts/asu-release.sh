#!/usr/bin/env bash
# =============================================================================
# asu-release.sh — replay the ASU patch stack onto an upstream Sim release,
#                  build it, and roll it out to the `sim` namespace.
#
#   ./scripts/asu-release.sh v0.8.44            # full run, prompts before deploy
#   ./scripts/asu-release.sh v0.8.44 --dry-run  # everything except build+deploy
#   ./scripts/asu-release.sh v0.8.44 --no-build # reuse images already pushed
#
# The phases are ordered so that everything reversible happens before anything
# irreversible. The only irreversible step is `helm upgrade`, because the
# migrations init container runs DDL that no rollback undoes — see PREFLIGHT.
# =============================================================================
set -euo pipefail

TARGET_TAG="${1:-}"
shift || true
DRY_RUN=false
NO_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=true ;;
    --no-build) NO_BUILD=true ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY_HOST="dcx-registry.rc.asu.edu"
REGISTRY_PATH="simstudio"
REGISTRY="$REGISTRY_HOST/$REGISTRY_PATH"
NAMESPACE="sim"
RELEASE="sim"
BRANCH="asu-patches"
IMAGE_TAG="${TARGET_TAG}-$(date +%Y%m%d)"

# name:dockerfile. All three ship together: the migrations image runs DDL in an
# init container, so publishing it without the app image that matches would
# migrate the schema forward and then fail to start. See the GATE phase.
IMAGES=(
  "sim:docker/app.Dockerfile"
  "realtime:docker/realtime.Dockerfile"
  "migrations:docker/db.Dockerfile"
)

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
phase() { printf '\n%s=== %s ===%s\n' "$c_grn" "$1" "$c_off"; }
warn()  { printf '%s!! %s%s\n' "$c_ylw" "$1" "$c_off"; }
die()   { printf '%sXX %s%s\n' "$c_red" "$1" "$c_off" >&2; exit 1; }
note()  { printf '%s   %s%s\n' "$c_dim" "$1" "$c_off"; }

[[ -n "$TARGET_TAG" ]] || die "usage: $0 <upstream-tag> [--dry-run] [--no-build]"
cd "$REPO_ROOT"

# --- pod lookup ---------------------------------------------------------------
# Every DB query runs inside the running app pod: DATABASE_URL is already
# resolved there from the sim-external-db secret, so no credential is ever read
# out of the cluster or onto this machine.
app_pod() {
  kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=app \
    --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'
}
psql_json() { # $1 = JS body using `sql`
  kubectl exec -n "$NAMESPACE" "$(app_pod)" -c app -- bun -e "
    const sql = new Bun.SQL(process.env.DATABASE_URL);
    $1
    await sql.end();
  "
}

# =============================================================================
phase "PRECONDITIONS"
# =============================================================================
for t in git bun podman kubectl helm curl; do
  command -v "$t" >/dev/null || die "missing required tool: $t"
done
[[ -z "$(git status --porcelain)" ]] || die "working tree is dirty; commit or stash first"
kubectl get ns "$NAMESPACE" >/dev/null 2>&1 || die "namespace/$NAMESPACE not reachable"

# The build needs >32GB: next build forks ~9 workers and the Rust side of
# Turbopack is not bounded by --max-old-space-size, so the 8GB heap cap in the
# build script does not contain it. A smaller host OOM-kills partway through and
# reports a bare exit 137 rather than anything that explains itself.
mem_gb=$(free -g | awk '/^Mem:/{print $2}')
(( mem_gb >= 40 )) || warn "host has ${mem_gb}GB RAM; the Next.js build peaks >32GB and may OOM"

# Layers are large and `/` is only 70GB on this host. Podman storage belongs on
# /home (177GB, otherwise unused) — set graphroot in /etc/containers/storage.conf.
graph_root="$(podman info --format '{{.Store.GraphRoot}}' 2>/dev/null || echo /var/lib/containers/storage)"
disk_gb=$(df -BG --output=avail "$graph_root" 2>/dev/null | tail -1 | tr -dc '0-9')
(( ${disk_gb:-0} >= 30 )) || warn "only ${disk_gb}GB free at $graph_root; a full build needs ~30GB (try: podman system prune -a)"

git fetch upstream --tags --quiet
git rev-parse "$TARGET_TAG" >/dev/null 2>&1 || die "tag $TARGET_TAG not found after fetch"
CURRENT_BASE="$(git merge-base "$BRANCH" upstream/main 2>/dev/null || true)"
note "target      $TARGET_TAG"
note "image tag   $IMAGE_TAG"
note "branch      $BRANCH"

# =============================================================================
phase "REBASE"
# =============================================================================
PREV_BASE="$(git rev-parse "$BRANCH^")"   # the upstream commit the stack sits on
if [[ "$PREV_BASE" == "$(git rev-parse "$TARGET_TAG")" ]]; then
  note "already based on $TARGET_TAG, nothing to replay"
else
  note "replaying $BRANCH from $(git describe --tags --abbrev=0 "$PREV_BASE" 2>/dev/null || echo "$PREV_BASE") onto $TARGET_TAG"
  git checkout --quiet "$BRANCH"
  if ! git rebase --onto "$TARGET_TAG" "$PREV_BASE" "$BRANCH"; then
    git rebase --abort || true
    die "rebase hit conflicts — resolve by hand, then re-run with the same tag"
  fi
fi
git checkout --quiet "$BRANCH"

# =============================================================================
phase "VERIFY"
# =============================================================================
# Cheap relative to a 20-minute build, and catches the case where upstream moved
# an API the patches depend on. A clean rebase proves only that the text merged.
bun install --frozen-lockfile
bun run type-check || die "type-check failed against $TARGET_TAG"
( cd apps/sim && bunx vitest run \
    blocks/blocks.test.ts \
    lib/embeddings/providers/openai.test.ts \
    lib/uploads/upload-session/cleanup.test.ts ) \
  || die "patched-file tests failed against $TARGET_TAG"

# =============================================================================
phase "PREFLIGHT — migration safety"
# =============================================================================
# Two distinct hazards, both of which have bitten this deployment:
#
#  1. Destructive DDL. Upstream drops retired columns once the release that
#     stopped writing them has shipped. Nothing about a helm rollback restores
#     them, so anything still carrying data is snapshotted below.
#  2. Guarded migrations. Some drops RAISE EXCEPTION unless an earlier release's
#     *script* migration was recorded in `script_migrations`. That is a separate
#     mechanism from the SQL migration table, and it aborts the whole init
#     container — i.e. a failed rollout, mid-upgrade.
NEW_MIGRATIONS="$(git diff --name-only "$PREV_BASE" "$TARGET_TAG" -- 'packages/db/migrations/0*.sql' || true)"
if [[ -z "$NEW_MIGRATIONS" ]]; then
  note "no new migrations in this release"
else
  note "$(wc -l <<<"$NEW_MIGRATIONS") new migration(s)"
  DESTRUCTIVE="$(grep -ilE 'DROP (COLUMN|TABLE)|TRUNCATE' $NEW_MIGRATIONS 2>/dev/null || true)"
  [[ -n "$DESTRUCTIVE" ]] && warn "destructive DDL in:"$'\n'"$DESTRUCTIVE"

  # Surface any script_migrations guard so it fails here, not in the init container.
  GUARDS="$(grep -hoE "[0-9]{4}_[a-z_]+" $NEW_MIGRATIONS 2>/dev/null \
            | sort -u | grep -E '^[0-9]{4}_(backfill|repair|remap|reconcile)' || true)"
  if [[ -n "$GUARDS" ]]; then
    note "migration references script migrations; checking they are recorded"
    RECORDED="$(psql_json 'const r = await sql`SELECT name FROM script_migrations`; console.log(r.map(x=>x.name).join(" "));' 2>/dev/null || echo "")"
    for g in $GUARDS; do
      if [[ "$RECORDED" != *"$g"* ]]; then
        die "script migration '$g' is NOT recorded in the database.
     The upgrade would abort inside the migrations init container.
     Run that release's db:migrate first, then re-run this script."
      fi
    done
    note "all referenced script migrations are recorded"
  fi
fi

# =============================================================================
phase "SNAPSHOT"
# =============================================================================
# Copies anything about to be dropped into a side table. Additive only: creates
# asu_pre_<tag>_* tables and touches nothing existing. Cheap insurance that is
# far faster to consult than restoring a CNPG backup.
if [[ -n "${DESTRUCTIVE:-}" && "$DRY_RUN" == false ]]; then
  SNAP_SUFFIX="$(tr -d '.' <<<"${TARGET_TAG#v}")"
  warn "snapshotting columns scheduled for drop into asu_pre_${SNAP_SUFFIX}_* tables"
  # Extend per release; the generic form cannot know which columns still matter.
  psql_json "
    await sql.unsafe(\`CREATE TABLE IF NOT EXISTS asu_pre_${SNAP_SUFFIX}_user_stats AS SELECT * FROM user_stats\`);
    console.log('user_stats snapshotted');
  " || warn "snapshot step reported an error; review before continuing"
fi

# =============================================================================
phase "BUILD"
# =============================================================================
if [[ "$NO_BUILD" == true ]]; then
  note "--no-build: skipping"
elif [[ "$DRY_RUN" == true ]]; then
  note "--dry-run: skipping"
else
  for spec in "${IMAGES[@]}"; do
    name="${spec%%:*}"; dockerfile="${spec#*:}"
    note "building $name"
    podman build --pull=newer -f "$dockerfile" -t "$REGISTRY/$name:$IMAGE_TAG" . \
      || die "build failed: $name (exit 137 means OOM — this host needs >32GB)"
  done
  for spec in "${IMAGES[@]}"; do
    name="${spec%%:*}"
    podman push "$REGISTRY/$name:$IMAGE_TAG" || die "push failed: $name"
  done
fi

# =============================================================================
phase "GATE — all three tags must exist"
# =============================================================================
# The partial-push hazard: migrations present + app absent means the schema
# migrates forward and the app then cannot start. Refuse to deploy unless the
# registry has all three.
missing=()
for spec in "${IMAGES[@]}"; do
  name="${spec%%:*}"
  if curl -sSf "https://$REGISTRY_HOST/v2/$REGISTRY_PATH/$name/tags/list" 2>/dev/null \
       | grep -q "\"$IMAGE_TAG\""; then
    note "$name:$IMAGE_TAG present"
  else
    missing+=("$name")
  fi
done
(( ${#missing[@]} == 0 )) || die "missing from registry: ${missing[*]} — refusing to deploy a partial set"

# =============================================================================
phase "DEPLOY"
# =============================================================================
# Helm drift check. Out-of-band `kubectl` edits (a rollout restart, a patched
# env) are silently reverted by an upgrade, so surface it before it happens.
HELM_REV="$(helm list -n "$NAMESPACE" -o json | python3 -c 'import json,sys;print([r["revision"] for r in json.load(sys.stdin) if r["name"]=="'"$RELEASE"'"][0])')"
DEPLOY_REV="$(kubectl get deploy sim-app -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')"
[[ "$HELM_REV" == "$DEPLOY_REV" ]] || \
  warn "helm revision $HELM_REV != deployment revision $DEPLOY_REV — out-of-band changes WILL be reverted"

helm upgrade "$RELEASE" ./helm/sim -n "$NAMESPACE" --reuse-values \
  --set app.image.tag="$IMAGE_TAG" \
  --set migrations.image.tag="$IMAGE_TAG" \
  --set realtime.image.tag="$IMAGE_TAG" \
  --dry-run >/dev/null || die "helm dry-run failed"

if [[ "$DRY_RUN" == true ]]; then
  note "--dry-run: stopping before the irreversible step"
  exit 0
fi

cat <<PROMPT

  About to upgrade release '$RELEASE' in namespace '$NAMESPACE'
      images   -> $IMAGE_TAG
      rollback -> helm rollback $RELEASE $HELM_REV -n $NAMESPACE
                  (restores images ONLY — dropped columns do not come back)

PROMPT
read -r -p "  Type the image tag to confirm: " reply
[[ "$reply" == "$IMAGE_TAG" ]] || die "confirmation did not match; nothing was changed"

helm upgrade "$RELEASE" ./helm/sim -n "$NAMESPACE" --reuse-values \
  --set app.image.tag="$IMAGE_TAG" \
  --set migrations.image.tag="$IMAGE_TAG" \
  --set realtime.image.tag="$IMAGE_TAG" \
  --wait --timeout 15m || die "helm upgrade failed — check: kubectl logs -n $NAMESPACE deploy/sim-app -c migrations"

# =============================================================================
phase "POST-DEPLOY VERIFY"
# =============================================================================
kubectl rollout status deploy/sim-app      -n "$NAMESPACE" --timeout=10m
kubectl rollout status deploy/sim-realtime -n "$NAMESPACE" --timeout=10m

note "migrations applied:"
psql_json 'const r = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`; console.log("  " + r[0].n);'

# ASU patch smoke checks — these are the things upstream does not test for us.
note "ASU AIR provider returns asuair/-prefixed models:"
kubectl exec -n "$NAMESPACE" "$(app_pod)" -c app -- \
  sh -c 'curl -sS http://localhost:3000/api/providers/litellm/models | head -c 200' || warn "provider probe failed"
echo

note "app responds:"
kubectl exec -n "$NAMESPACE" "$(app_pod)" -c app -- \
  sh -c 'curl -sS -o /dev/null -w "  GET / -> %{http_code}\n" http://localhost:3000/'

printf '\n%sReleased %s as %s%s\n' "$c_grn" "$TARGET_TAG" "$IMAGE_TAG" "$c_off"
note "rollback: helm rollback $RELEASE $HELM_REV -n $NAMESPACE"
