# IBKR Gateway Broker

A self-hosted multi-tenant proxy in front of Interactive Brokers'
[Client Portal Gateway][cpg]. Each connected IBKR account gets its own
isolated [IBeam][ibeam]-wrapped Gateway process; a single uniform HTTPS API
in front of them is authenticated with per-connection bearer keys.

> **See [`SPEC.md`](./SPEC.md)** for the full design, the IBKR-side
> constraints that motivate it, and the rationale for every non-obvious
> choice (credential custody, Firestore, Firebase Auth, etc.). This README
> is the *how* (deploy + run), not the *why*.

[cpg]: https://www.interactivebrokers.com/en/trading/ib-api.php#client-portal-api
[ibeam]: https://github.com/Voyz/ibeam

---

## Hard prerequisites

These are not negotiable — they come from IBKR's platform, see SPEC §2.

1. **IBKR Pro account.** The Web API does not work with IBKR Lite.
2. **A 2FA-free IBKR username per connected account.** Headless login cannot
   answer a 2FA push. Create a dedicated *secondary* username in IBKR Client
   Portal (Settings → User Settings → Users & Access Rights); keep your
   primary login's 2FA enabled for the mobile app. See SPEC §9.1 — the
   first failed spawn surfaces the full remediation steps automatically.
3. **A paper trading account for testing.** Never test order placement
   against a live account.

## What you need on your machine

- `gcloud` CLI ([installed and authed][gcloud-install])
- Node.js ≥ 20
- DNS control of a domain you can point at the VM
- A Cloudflare account if you want the same proxied-TLS posture this repo
  uses (you can also go bare with Let's Encrypt — see "TLS alternatives").

[gcloud-install]: https://cloud.google.com/sdk/docs/install

---

## Deployment — concrete walkthrough

This is the sequence used to bring the reference deployment up. Substitute
your own project id, domain, region, etc. throughout.

Reference values used below:

| Placeholder | This deployment |
|---|---|
| `$PROJECT` | `auto-trader-493814` |
| `$REGION` / `$ZONE` | `europe-west3` / `europe-west3-a` |
| `$VM_NAME` | `ibkr-gateway` |
| `$DOMAIN` | `ibkr-gateway.bogdanripa.com` |

### 1. GCP project + APIs

```bash
gcloud config set project "$PROJECT"
gcloud services enable \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  compute.googleapis.com \
  iam.googleapis.com
```

### 2. Firestore (Native mode, regional)

One Firestore database per project, choose the region close to the VM.

```bash
gcloud firestore databases create --location="$REGION"
```

If a `(default)` database already exists in another region, you cannot move
it — use it as-is or create the project from scratch.

Collections are prefixed `ibkr_` so this system can co-exist with other
apps in the same project (SPEC §6).

### 3. Service account

A single least-privilege service account is used by all components.

```bash
SA_EMAIL="ibkr-gateway@${PROJECT}.iam.gserviceaccount.com"

gcloud iam service-accounts create ibkr-gateway \
  --display-name="IBKR Gateway service"

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/datastore.user" --condition=None

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/secretmanager.admin" --condition=None
```

### 4. Static IP + VM

```bash
gcloud compute addresses create ibkr-gateway-ip --region="$REGION"

gcloud compute instances create "$VM_NAME" \
  --zone="$ZONE" \
  --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --address=ibkr-gateway-ip \
  --service-account="$SA_EMAIL" \
  --scopes=cloud-platform \
  --tags=https-server,http-server
```

`e2-small` is enough for v1 (handful of connected accounts; ~300 MB
per IBeam container). Scale up before the first heavy user.

### 5. Firewall (HTTP + HTTPS only)

```bash
gcloud compute firewall-rules create allow-https-http \
  --allow=tcp:443,tcp:80 --target-tags=https-server \
  --description="API + ACME challenge"
```

SSH is already allowed by the default GCP firewall (`default-allow-ssh`).

### 6. DNS

Point an A record for `$DOMAIN` at the static IP from step 4.

```bash
gcloud compute addresses describe ibkr-gateway-ip --region="$REGION" \
  --format='value(address)'
```

If you proxy through Cloudflare (recommended), see step 7. Otherwise
the record can be a normal A record and TLS is handled with Caddy +
Let's Encrypt (see "TLS alternatives" below).

### 7. TLS — Cloudflare Origin Cert + "Full (strict)"

Two things in the Cloudflare dashboard for the zone:

1. **SSL/TLS → Origin Server → Create Certificate.** Defaults are fine
   (RSA 2048, 15 years). List `$DOMAIN` (or `*.example.com, example.com`
   for reuse). You get two PEM blobs — **save them; the private key is
   shown only once**.
2. **SSL/TLS → Overview → encryption mode = Full (strict).**

Cloudflare protects the front; the cert above secures Cloudflare ↔ VM.
The origin IP stays hidden behind Cloudflare.

Install the cert under Caddy on the VM (next step).

### 8. Caddy on the VM

```bash
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --command='
  sudo apt-get -qq update
  sudo apt-get -qq install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | \
    sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | \
    sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get -qq update
  sudo apt-get -qq install -y caddy
'
```

Copy the Cloudflare Origin Cert + private key onto the VM:

```bash
# locally, having saved the PEM blocks to /tmp/origin.crt and /tmp/origin.key:
gcloud compute scp /tmp/origin.crt /tmp/origin.key "${VM_NAME}:/tmp/" --zone="$ZONE"
rm -f /tmp/origin.crt /tmp/origin.key   # don't keep local copies
```

```bash
# on the VM:
sudo mkdir -p /etc/caddy/certs
sudo mv /tmp/origin.crt /etc/caddy/certs/ibkr-gateway.crt
sudo mv /tmp/origin.key /etc/caddy/certs/ibkr-gateway.key
sudo chown -R root:caddy /etc/caddy/certs
sudo chmod 750 /etc/caddy/certs
sudo chmod 640 /etc/caddy/certs/*

sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
ibkr-gateway.bogdanripa.com {
    tls /etc/caddy/certs/ibkr-gateway.crt /etc/caddy/certs/ibkr-gateway.key
    encode zstd gzip

    # /healthz: served by Caddy directly, no backend needed.
    handle /healthz {
        respond "ibkr-gateway: ok" 200
    }

    # Everything else: proxy to the Node app on :8080.
    handle {
        reverse_proxy 127.0.0.1:8080 {
            transport http {
                dial_timeout 2s
            }
        }
    }

    # Graceful page when the backend isn't running yet (bootstrap phase).
    # Once the app is deployed, this never fires.
    handle_errors {
        @bootstrap expression {http.error.status_code} == 502
        respond @bootstrap "ibkr-gateway app not deployed yet. Try /healthz for liveness." 503
    }
}
EOF

sudo systemctl reload caddy || sudo systemctl restart caddy
```

Verify end-to-end:

```bash
curl -i "https://$DOMAIN/healthz"
# HTTP/2 200
# ibkr-gateway: ok
```

If you see an HTTPS→HTTPS 308 redirect loop, your Cloudflare SSL mode is
still "Flexible" — flip it to **Full (strict)** as in step 7.

### 9. Docker + IBeam on the VM

The Gateway pool runs as Docker containers — one per connection, exposed
only on `127.0.0.1` to a unique high port.

```bash
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --command='
  sudo apt-get -qq update
  sudo apt-get -qq install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg | \
    sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/debian \
    $(. /etc/os-release && echo \$VERSION_CODENAME) stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get -qq update
  sudo apt-get -qq install -y docker-ce docker-ce-cli containerd.io
  sudo docker pull voyz/ibeam:latest
'
```

### 10. Firebase Auth (for the console UI)

1. <https://console.firebase.google.com> → **Add project** → **Add Firebase
   to Google Cloud project** → pick the project from step 1.
2. **Build → Authentication → Get started** → **Sign-in method** →
   enable **Google** → set support email → Save.
3. **Authentication → Settings → Authorized domains** → add `$DOMAIN`.
4. **Project settings → Your apps** → add a Web app → copy the
   `firebaseConfig` object (`apiKey`, `authDomain`, `projectId`, `appId`).
   This is **client-side config** and safe to commit (per Firebase docs).

### 11. Deploy the app

```bash
git clone <this repo> && cd ibkr-gateway
npm install
cp .env.example .env
# edit .env: GCP_PROJECT_ID=$PROJECT
```

For now the app is run from source on the VM via `npm run start` /
`tsx`. A Dockerised deploy will follow.

### Firebase config — out of source code

The Firebase web app `apiKey` is a public client identifier per
Firebase's own docs, but GitHub's secret scanner flags it on sight.
To keep the repo clean and portable:

- The values are NOT in source. `src/console/firebase-config.ts` reads
  them from `process.env`.
- Local dev: copy `.env.example` to `.env` and fill in the six
  `FIREBASE_*` values from Firebase Console → Project Settings.
- CI/deploy: set them as GitHub repo **Secrets** (Settings → Secrets
  and variables → Actions → **Secrets** tab):
  `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`,
  `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`,
  `FIREBASE_APP_ID`. The deploy workflow reads them from `secrets.*`
  and writes them into `/etc/ibkr-gateway.env` on the VM. They're
  treated as Secrets (redacted in logs) even though Firebase's docs
  classify the apiKey as public — the redaction is harmless and keeps
  the values out of build logs.

If a previous commit ever leaked the key into source, **rotate it** in
Firebase Console (Project Settings → General → reset the web app's
config). The leaked value becomes invalid; the new one lives only in
GitHub Variables + the VM's env file.

---

## Local development

Required env (also in `.env.example`):

```
GCP_PROJECT_ID=auto-trader-493814   # your project id
PORT=8080                            # what Caddy reverse-proxies to
```

Authenticate locally so the Firestore and Secret Manager clients work:

```bash
gcloud auth application-default login
```

Then:

```bash
npm install
npm run typecheck         # tsc --noEmit
npm run scan              # secret scan over working tree
```

Useful scripts:

```bash
# --- run locally before pushing ---
npm test                                  # typecheck + scan + smoke + smoke:http
npm run smoke                             # Firestore queries + Secret Manager round-trip
npm run smoke:http                        # boots the app on :8082 and curls key endpoints
npm run typecheck
npm run scan                              # secret scan over working tree

# --- one-off operational scripts ---
npm run seed                              # create one account + connection + API key
npm run upload-credential <connectionId>  # write IBKR creds to Secret Manager
npm run test:secrets                      # round-trip Secret Manager + no-log assertion
npm run test:gateway <connectionId>       # full spawn → auth-status, with friendly errors
npm run reap <connectionId>               # tear down the gateway container
```

`npm test` writes throwaway documents (and one secret) to the real
Firestore/Secret Manager under tags like `smoke-<random>` and cleans
them up at the end. It exercises the exact queries the production
console uses, so missing composite indexes / IAM gaps fail locally
instead of at deploy time.

`upload-credential` and `test:gateway` must run *on the VM* (because IBeam
runs in Docker on the VM, and the VM has its service account attached).
For local development without IBeam, the Firestore / Secret Manager
scripts work fine.

---

## Deployment — GitHub Actions

Pushing to `main` triggers `.github/workflows/deploy.yml`, which:

1. Typechecks and secret-scans the working tree.
2. Builds a tarball excluding `node_modules`, `.git`, `dist`, `.github`.
3. Authenticates to GCP via **Workload Identity Federation** (no
   long-lived service-account keys in GitHub secrets).
4. `scp`s the tarball to the VM **via IAP tunnel** (no public SSH).
5. SSHs to the VM and runs `deploy/deploy-on-vm.sh`, which:
   - bootstraps Node.js 20 if absent,
   - extracts to `/opt/ibkr-gateway-new`,
   - `npm ci`,
   - atomically swaps `/opt/ibkr-gateway`,
   - (re)installs the systemd unit `deploy/ibkr-gateway.service`,
   - writes `/etc/ibkr-gateway.env` on first deploy only (preserves on
     subsequent deploys),
   - restarts the service and waits for `127.0.0.1:8080/healthz`.
6. Verifies the public endpoint at `https://$DOMAIN/healthz` from the
   GitHub runner.

### One-time WIF setup (reference)

The reference deployment binds the GitHub repo `bogdanripa/ibkr-gateway`
to a dedicated deployer service account via Workload Identity Federation.
If you're cloning this repo for your own deployment, repeat the
equivalent setup once:

```bash
PROJECT=$YOUR_PROJECT
DEPLOYER="ibkr-gateway-deployer@${PROJECT}.iam.gserviceaccount.com"
REPO="<your-github-org>/<your-repo>"

# 1. Deployer SA.
gcloud iam service-accounts create ibkr-gateway-deployer \
  --display-name="IBKR Gateway GitHub Actions deployer"

# 2. Permissions (compute admin + IAP tunnel + impersonate VM SA).
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$DEPLOYER" \
  --role="roles/compute.instanceAdmin.v1" --condition=None
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$DEPLOYER" \
  --role="roles/iap.tunnelResourceAccessor" --condition=None
gcloud iam service-accounts add-iam-policy-binding \
  "ibkr-gateway@${PROJECT}.iam.gserviceaccount.com" \
  --member="serviceAccount:$DEPLOYER" \
  --role="roles/iam.serviceAccountUser"

# 3. WIF pool + provider for GitHub Actions.
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com

gcloud iam workload-identity-pools create github-actions \
  --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github \
  --workload-identity-pool=github-actions --location=global \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref' \
  --attribute-condition="assertion.repository == \"$REPO\""

# 4. Allow this repo to impersonate the deployer SA.
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-actions/attribute.repository/${REPO}"
```

Then update the `env:` block at the top of
`.github/workflows/deploy.yml` with your project id, zone, VM name,
provider resource name, and deployer SA email.

### Manual deploy (bypass CI)

If you need to push code without GitHub Actions:

```bash
tar --exclude=node_modules --exclude=.git --exclude=dist -czf /tmp/ibkr-gateway.tar.gz .
gcloud compute scp /tmp/ibkr-gateway.tar.gz "${VM_NAME}:/tmp/" \
  --zone="$ZONE" --tunnel-through-iap
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --tunnel-through-iap --command='
  tmpdir=$(mktemp -d)
  tar -xzf /tmp/ibkr-gateway.tar.gz -C "$tmpdir" deploy/deploy-on-vm.sh
  bash "$tmpdir/deploy/deploy-on-vm.sh"
'
```

---

## First-run test (the "fail nicely on 2FA" path)

This is the canonical first end-to-end test. We expect it to fail with
the friendly remediation, then we re-do it with a 2FA-free account.

```bash
# on a workstation with `gcloud` authed, in this repo:
npm run seed
# → records account, connection, api key ids in stdout

# upload the credentials of the 2FA-enabled (real) account first,
# to validate the friendly error path:
gcloud compute ssh "$VM_NAME" --zone="$ZONE"
# on the VM:
cd ~/ibkr-gateway
npm run upload-credential <connectionId>
# username:  <your 2FA-enabled IBKR username>
# password:  <typed silently; never echoed>

npm run test:gateway <connectionId>
# → waits ~60s, then:
#   TWO_FACTOR_REQUIRED: IBKR login timed out — username likely has 2FA enabled, …
#   <step-by-step remediation>
```

After creating the 2FA-free paper/secondary username per the printed
remediation:

```bash
npm run upload-credential <connectionId>    # overwrites the bad creds
npm run test:gateway <connectionId>         # should now reach AUTHENTICATED
```

Tear down:

```bash
npm run reap <connectionId>
```

---

## TLS alternatives

This deployment uses Cloudflare-proxied DNS + a Cloudflare Origin Cert.
Two alternatives if you don't want Cloudflare:

- **DNS-only (grey-cloud) + Caddy's Let's Encrypt.** Drop the cert lines
  from the Caddyfile; Caddy will automatically obtain a Let's Encrypt
  cert via HTTP-01 on port 80. Trade-off: origin IP is publicly known.
- **GCP HTTPS Load Balancer.** Managed cert, easier multi-VM later. About
  $18/month baseline even with a single backend.

---

## Secrets policy

- `.gitignore` blocks `.env*` (except `.env.example`), all PEM/key files,
  and any GCP / Firebase service-account JSON.
- `npm run scan` greps the working tree for PEM blocks, GCP SA JSON, our
  `ibkr_<…>` API keys, generic Google `AIzaSy…` keys, and Slack/GitHub
  tokens. Run it before commits if you don't have a pre-commit hook yet.
- IBKR credentials only ever live in **GCP Secret Manager**. They are
  never written to Firestore, never to logs, never to disk on the VM.
  `npm run test:secrets` enforces this (asserts the credential value
  never appears in captured console output across a full
  create/fetch/rotate/destroy cycle).
- The Firebase `apiKey` *looks* like a secret but is a client identifier
  per Firebase's own docs — it can be committed (the `scan` script
  matches it, but you can whitelist the specific file).
