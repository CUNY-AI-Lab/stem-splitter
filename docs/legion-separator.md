# Self-hosted GPU separator (the Legion)

This runbook puts Stem Splitter's 4- and 6-track Demucs splits on a dedicated
Lenovo Legion laptop (RTX 5090 laptop GPU, 24 GB) and keeps Replicate behind it
as an automatic fallback. It covers the host, the Cloudflare Tunnel, a Railway
staging environment, the acceptance checklist, and the production flip.

```text
Browser ──> Railway app (SEPARATION_BACKEND=failover)
              │  POST /v1/jobs (Bearer token, 10 s timeout)
              ├──────────────> https://separator.<domain>  (Cloudflare Tunnel)
              │                    └─> cloudflared ─> 127.0.0.1:8765 service.py ─> CUDA
              │  on any start failure, or a choice the Legion has no runner for
              └──────────────> Replicate (pinned ryan5453/demucs)
Legion ──> fetches the signed source URL from Railway, posts the webhook back,
           and serves stems that the app downloads into its own storage
```

What the app does (src/separation/failover.ts):

- Each job's `external_id` records the provider that accepted it: `as:<id>` for
  the Legion or `rep:<id>` for Replicate. Polls and webhooks follow that prefix,
  not the current `SEPARATION_BACKEND`, so a flip or a rollback never strands a
  job.
- Students see Replicate's catalogue unchanged. The 2-track split
  (`vocals_instrumental`) has no Legion runner yet and always runs on Replicate.
- A job whose service restarted fails on its next poll with "The separator
  restarted before this split finished." A job whose provider cannot be
  reached at all fails with a retry message once it is older than
  `SEPARATION_STALL_MINUTES` (default 60). A provider that still reports the
  job as running is never overruled.
- Webhook URLs carry a per-job token derived from `WEBHOOK_SECRET`, never the
  secret itself, so the Legion and Cloudflare never see it.

## Before you start

- [ ] The Legion, on wired Ethernet, with a measured upstream rate. Stems leave
      over the uplink, about 6 MB per stem for a 4-minute song.
- [ ] A domain on Cloudflare that you control, for `separator.<domain>`. Check
      whether a lab zone such as `ailab.gc.cuny.edu` is on Cloudflare before
      you choose a different one. Bot Fight Mode is per zone and must be off
      (step 3), so a dedicated zone is simplest.
- [ ] Railway access to the canonical project (IDs in `server/CLAUDE.md`).
- [ ] A funded Replicate account. It still runs fallback jobs, every 2-track
      split, and YouTube imports.
- [ ] A note to whoever records the class's retention and copyright review:
      uploaded songs now reach a lab-owned machine, where sources are deleted
      after each split and stems after 24 hours.

## 1. Host setup

### Operating system and driver

1. Install **Ubuntu Server 24.04.x** (latest point release, which ships the
   HWE kernel for new laptop hardware). Desktop also works if you turn off its
   automatic suspend. Skip passphrase disk encryption: an unattended reboot
   would hang at the prompt. The service deletes audio within a day.
2. In the BIOS, choose discrete-GPU (dGPU-only) mode if offered, and set the
   machine to power on after AC loss if offered.
3. Update, then install the NVIDIA **open** driver, **580 or newer**. Blackwell
   GPUs need the open kernel modules, and the CUDA 13 torch wheels need 580+.

   ```sh
   sudo apt update && sudo apt full-upgrade -y
   sudo ubuntu-drivers list            # pick the newest nvidia-driver-5xx-open
   sudo apt install -y nvidia-driver-580-open
   sudo reboot
   nvidia-smi                          # driver >= 580, "CUDA Version: 13.x"
   sudo systemctl enable --now nvidia-persistenced
   ```

   If Secure Boot is on, the install asks for a MOK password; enroll the key
   at the blue screen on the next boot.

### Always on

```sh
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo mkdir -p /etc/systemd/logind.conf.d
printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n' \
  | sudo tee /etc/systemd/logind.conf.d/stem-separator.conf
sudo systemctl restart systemd-logind
```

Battery conservation mode (holds the charge near 60 to 80 percent on Legion
models that expose it):

```sh
ls /sys/bus/platform/drivers/ideapad_acpi/*/conservation_mode && \
  echo 'w /sys/bus/platform/drivers/ideapad_acpi/*/conservation_mode - - - - 1' \
  | sudo tee /etc/tmpfiles.d/legion-battery.conf && sudo systemd-tmpfiles --create
```

Leave the lid open or the laptop on a stand with clear vents. Check
temperatures during the soak (`nvidia-smi -q -d TEMPERATURE`).

### Service user, code, and the CUDA environment

```sh
# build-essential and python3.12-dev: diffq (an Audio Separator dependency)
# has no Linux wheel and compiles a C extension.
sudo apt install -y git ffmpeg curl jq build-essential python3.12-dev
curl -LsSf https://astral.sh/uv/install.sh | sh     # uv for the admin user
sudo adduser --system --group --no-create-home --home /var/lib/stem-separator stemsep
sudo mkdir -p /opt/stem-separator && sudo chown "$USER": /opt/stem-separator
git clone https://github.com/CUNY-AI-Lab/stem-splitter /opt/stem-separator/app
cd /opt/stem-separator/app
```

The CUDA dependencies live in `local-separator/cuda/pyproject.toml`, a sibling
of the CPU project, so the Railway CPU image, CI and macOS dev keep their own
lock. It pins torch 2.13.0 from the `cu130` index: torch 2.13 ships cu126,
cu130 and cu132 wheels, and only cu130+ carries sm_120 kernels. Every other
package is constrained to its version in `local-separator/uv.lock`, and
`local-separator/test_cuda_constraints.py` fails if the two drift.

**First time only**, create the lock on the Legion (the PyTorch index must be
reachable) and commit it through a pull request. After it is merged, add
`uv lock --check --project local-separator/cuda` to CI next to the existing
separator sync.

```sh
uv lock --project local-separator/cuda
git add local-separator/cuda/uv.lock     # commit on a branch, open a PR
```

Build the venv with the system Python 3.12, so the interpreter lives outside
any home directory (the unit sets `ProtectHome=true`):

```sh
# --compile-bytecode: the service runs with a read-only venv and would
# otherwise recompile torch in memory on every start.
UV_PROJECT_ENVIRONMENT=/opt/stem-separator/venv UV_PYTHON_DOWNLOADS=never \
  uv sync --project local-separator/cuda --locked --compile-bytecode --python /usr/bin/python3.12
/opt/stem-separator/venv/bin/python -c \
  "import torch; print(torch.__version__, torch.version.cuda, 'sm_120' in torch.cuda.get_arch_list(), torch.cuda.get_device_name(0))"
# expect: 2.13.0+cu130 13.0 True NVIDIA GeForce RTX 5090 Laptop GPU
```

Never run `bun run separator:*` or `uv run` against this checkout with
`UV_PROJECT_ENVIRONMENT` pointing at the service venv: they sync the CPU
project and would replace the CUDA wheels.

### Configuration and systemd

```sh
sudo install -d -m 0750 -o root -g stemsep /etc/stem-separator
sudo install -m 0640 -o root -g stemsep local-separator/deploy/separator.env.example \
  /etc/stem-separator/separator.env
openssl rand -hex 32          # paste as AUDIO_SEPARATOR_TOKEN; keep it for Railway
sudoedit /etc/stem-separator/separator.env   # token and https://separator.<domain>
sudo cp local-separator/deploy/stem-separator.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now stem-separator
journalctl -u stem-separator -f              # "listening on ... (device cuda)"
```

The service refuses to start, and logs why, if the token is short or default,
if `AUDIO_SEPARATOR_PUBLIC_URL` is not the tunnel's `https://` hostname (the
unit sets `AUDIO_SEPARATOR_EXPOSED=1`), or if CUDA cannot run a kernel. If the
GPU fails during a split (a CUDA error other than out-of-memory), the service
fails that job, stops accepting work, reports `"device":"failed"`, and exits so
systemd restarts it and probes CUDA again.

Reboot once now and confirm the service comes back with `"device":"cuda"`
(`curl -s 127.0.0.1:8765/health`). Some device nodes only appear after boot,
and the 04:00 automatic reboot should not be the first test of that.

### Loopback smoke test (also downloads the model weights)

```sh
TOKEN=$(sudo grep '^AUDIO_SEPARATOR_TOKEN=' /etc/stem-separator/separator.env | cut -d= -f2)
mkdir -p ~/smoke && cp /path/to/song.mp3 ~/smoke/ && (cd ~/smoke && python3 -m http.server 9000 --bind 127.0.0.1 &)
for MODEL in htdemucs_ft htdemucs_6s; do
  ID=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"audio_url\":\"http://127.0.0.1:9000/song.mp3\",\"model\":\"$MODEL\"}" \
    http://127.0.0.1:8765/v1/jobs | jq -r .id)
  time (until curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/v1/jobs/$ID \
    | jq -e '.status=="succeeded" or .status=="failed"' >/dev/null; do sleep 2; done)
  curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/v1/jobs/$ID | jq '{status, error, stems: [.stems[].name]}'
done
```

Watch `nvidia-smi` in another terminal while it runs. Record the time for a
4-minute song on each profile. The first run of each profile includes the
weight download.

## 2. Cloudflare Tunnel

1. Install `cloudflared` from Cloudflare's apt repository.
2. In the Cloudflare dashboard (Zero Trust → Networks → Tunnels), create a
   tunnel named `stem-splitter-legion` and run the `cloudflared service install
   <token>` command it shows on the Legion.
3. Add a public hostname `separator.<domain>` that points to the service type
   HTTP at `127.0.0.1:8765`.
4. Zone settings for that domain:
   - **Bot Fight Mode: off.** On the Free plan no rule can skip it, and its
     challenges break Railway's server-to-server calls, which would quietly
     send every split to Replicate.
   - A configuration rule for `separator.<domain>` that turns **Browser
     Integrity Check off**.
   - A cache rule for `separator.<domain>` that **bypasses cache**. The service
     already sends `Cache-Control: private`, and `.mp3` is a cached extension
     by default.
5. Verify from another network:

   ```sh
   curl -s https://separator.<domain>/health        # "device":"cuda","accepting":true
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://separator.<domain>/v1/jobs   # 401
   sudo systemctl stop stem-separator                # then, from outside:
   curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://separator.<domain>/health  # 502 fast
   sudo systemctl start stem-separator
   ```

## 3. Operations

- **Firewall.** Nothing listens publicly; the tunnel is outbound only.
  ```sh
  sudo ufw default deny incoming && sudo ufw default allow outgoing
  sudo ufw allow from 192.168.0.0/16 to any port 22 proto tcp   # adjust to your LAN, or use Tailscale
  sudo ufw enable
  ```
- **Updates.** `sudo dpkg-reconfigure -plow unattended-upgrades`, then add
  `/etc/apt/apt.conf.d/52stem-separator` with
  `Unattended-Upgrade::Automatic-Reboot "true";` and
  `Unattended-Upgrade::Automatic-Reboot-Time "04:00";`. If a kernel update
  breaks the driver, the service exits at startup and the app falls back.
- **Monitoring.** Add an external keyword monitor (for example UptimeRobot or
  Better Stack) on `https://separator.<domain>/health` that expects
  `"device":"cuda"`, with email alerts.
- **Logs.** `journalctl -u stem-separator`. Request logs redact the per-job
  file token, and webhook URLs (which carry the app's secret) are never logged.
  On Railway, `[separation] job <id> -> Replicate (<reason>)` records every
  fallback.
- **Maintenance without failing jobs.** Drain, wait, update, restart, undrain:

  ```sh
  sudo -u stemsep touch /var/lib/stem-separator/jobs/DRAIN   # new jobs now go to Replicate
  watch -n5 'curl -s 127.0.0.1:8765/health'                   # wait for "pending":0, then a minute more
  cd /opt/stem-separator/app && git pull --ff-only
  UV_PROJECT_ENVIRONMENT=/opt/stem-separator/venv UV_PYTHON_DOWNLOADS=never \
    uv sync --project local-separator/cuda --locked --compile-bytecode --python /usr/bin/python3.12
  sudo systemctl restart stem-separator
  sudo -u stemsep rm /var/lib/stem-separator/jobs/DRAIN       # the file survives restarts
  ```

  A restart forgets every job and deletes its folder. The extra minute lets
  the app download the stems of jobs that just finished.

## 4. Railway staging

Production stays on `SEPARATION_BACKEND=replicate` throughout this section.

1. In the canonical project, create an environment named `staging`. If you
   duplicate production, immediately replace `WEBHOOK_SECRET` and `CLASS_CODE`
   with fresh values (`openssl rand -hex 32`): `server/CLAUDE.md` forbids
   reusing production's. Confirm the staging service has its own volume at
   `/data`, `DATA_DIR=/data`, and a generated domain. Record the environment ID
   in `server/CLAUDE.md`.
2. Set the staging variables with `--skip-deploys` (or in the dashboard). Never
   print variable output.

   | Variable | Value |
   |---|---|
   | `SEPARATION_BACKEND` | `failover` |
   | `AUDIO_SEPARATOR_URL` | `https://separator.<domain>` |
   | `AUDIO_SEPARATOR_TOKEN` | the Legion's token |
   | `REPLICATE_API_TOKEN`, `REPLICATE_MODEL_VERSION` | same pin as production |
   | `SEPARATION_STALL_MINUTES` | `5` during acceptance, then `60` |
   | `ASSISTANT_MODEL` | unset, unless you are testing the Listening Guide |

3. Deploy the reviewed main SHA to staging with `railway up --detach` and the
   explicit project, staging environment and service IDs.

### Acceptance checklist

Record results, timings and log excerpts (no secrets) under
`docs/acceptance/<date>-legion-staging/`.

- [ ] **(a) Configuration.** `curl -s https://<staging>/healthz | jq .configuration`
      shows `separationBackend: failover`, `audioSeparator: configured`,
      `replicateSeparation: configured`.
- [ ] **(b) Legion path.** A 4-track and a 6-track upload reach `done`. Railway
      logs show no fallback line for them; the Legion journal shows each job;
      stems pass the MP3 and distinct-hash checks in `server/CLAUDE.md`. For one
      job, close the tab after submitting: Railway logs show
      `POST /api/webhooks/separation 200` before any poll.
- [ ] **(c) 2-track.** Logs show `-> Replicate (no self-hosted runner for
      vocals_instrumental)` and the job reaches `done`.
- [ ] **(d) Legion down.** `sudo systemctl stop stem-separator`, submit a
      4-track job: it falls back within seconds and reaches `done`. Start the
      service again.
- [ ] **(e) Busy.** Set `AUDIO_SEPARATOR_MAX_PENDING=1`, restart, submit three
      jobs quickly: one runs on the Legion, the others log `separator busy`
      and run on Replicate. Restore `4`.
- [ ] **(f) Restart mid-job.** Submit a 6-track job and restart the service
      while it runs. The next poll shows `failed` with "The separator restarted
      before this split finished," not a spinner.
- [ ] **(g) Stop mid-job.** Submit a job and stop the service while it runs.
      The job fails about 5 minutes after it was created with the stall
      message. Start the service.
- [ ] **(h) Rollback drill.** Submit a Legion job, then set staging to
      `SEPARATION_BACKEND=replicate`. The in-flight job still completes on the
      Legion; new jobs go to Replicate. Set `failover` again.
- [ ] **(i) Retention.** Right after a job finishes, its folder under
      `/var/lib/stem-separator/jobs/` has no `source.*`. With
      `AUDIO_SEPARATOR_RETENTION_HOURS=0.05`, the folder is gone within a few
      minutes. Restore `24`.
- [ ] **(j) Parity.** Run the same 2 or 3 songs through the Legion and through
      Replicate (stop the service to force fallback). Compare per-stem levels
      with `bun run eval:stems -- --source song.mp3 --stem vocals=... ...`
      (within about 1 dB), and listen. Exact matches are impossible: Demucs
      shifts use a random offset.

Then set `SEPARATION_STALL_MINUTES=60` and let staging soak for a few days.

## 5. Production flip and rollback

1. Capture the Replicate rollback baseline (`scripts/capture-railway-baseline.mjs`
   is Replicate-only by design).
2. Release the same SHA to production with `SEPARATION_BACKEND=replicate`
   unchanged. Run one Replicate job and check `/healthz`.
3. Stage `AUDIO_SEPARATOR_URL` and `AUDIO_SEPARATOR_TOKEN` with
   `--skip-deploys`, then set `SEPARATION_BACKEND=failover`, which redeploys.
   Run one 4-track canary and check `/healthz.configuration`.
4. On day one, count fallback reasons in the Railway logs.

Run destructive tests only before the flip: afterwards staging and production
share the Legion.

**Rollback:** set `SEPARATION_BACKEND=replicate`. Keep the `AUDIO_SEPARATOR_*`
pair until no `as:` job is in flight; those jobs still finish on the Legion,
or fail through the restart rule or the stall deadline.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every split logs `-> Replicate (Audio Separator start failed (403)...)` | Bot Fight Mode or another Cloudflare challenge on the zone |
| `-> Replicate (Audio Separator start failed (401)...)` | Token differs between Railway and `/etc/stem-separator/separator.env` |
| `-> Replicate (... (502)` or `(530)` | Service down or restart-looping (`journalctl -u stem-separator`), or cloudflared down |
| Service log: `refusing to start: CUDA is present but unusable` | Driver or kernel update; reinstall the `-open` driver, reboot |
| Service log: `the GPU failed during a split; exiting...`, monitor sees `"device":"failed"` | A CUDA runtime fault; systemd restarts the service. If it keeps failing, check `nvidia-smi` and `journalctl -k` for Xid errors |
| Service log: `refusing to start: AUDIO_SEPARATOR_TOKEN must be...` | Token missing, default, or under 32 characters |
| Service log: `refusing to start: AUDIO_SEPARATOR_PUBLIC_URL must be...` | The env file lacks the tunnel's `https://` hostname |
| Service log: `refusing to start: cannot listen on 127.0.0.1:8765` | Another copy is already running (for example one started by hand) |
| Jobs fail with "The separator restarted..." | The service restarted with that job in flight; drain before restarting |
| Ingest retries or slow `done` on large files | Upstream bandwidth; check the uplink and stem sizes |
| A 6-track job fails with "did not produce the piano track" | Audio Separator skips writing a stem that is digitally silent; retry on Replicate or pick 4 tracks |

## Later

- A Legion runner for the 2-track split (Demucs float output, summed drums,
  bass and other, rescaled, encoded once).
- Re-dispatching lost Legion jobs to Replicate instead of failing them.
- A short cooldown that skips the Legion for a minute after a failure.
- A profile allowlist that keeps the BS-RoFormer checkpoint off production
  until its licence review.
