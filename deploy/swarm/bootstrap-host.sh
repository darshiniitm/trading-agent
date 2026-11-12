#!/usr/bin/env bash
# One-time (idempotent) setup of a fresh Ubuntu 24.04 LTS or Debian 12/13 VM for the single-node Swarm. Run as root.
#   sudo ./deploy/swarm/bootstrap-host.sh [--ssh-allow-ip A.B.C.D] [--no-swap]
# docs/engine-swarm-deploy-plan.md §4.5.
set -euo pipefail

SSH_ALLOW_IP=""
SWAP=1
while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-allow-ip) SSH_ALLOW_IP="${2:?--ssh-allow-ip needs an address}"; shift 2 ;;
    --no-swap) SWAP=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive

echo "== timezone + OS updates"
timedatectl set-timezone Asia/Kolkata
apt-get update -y
apt-get upgrade -y
apt-get install -y unattended-upgrades ca-certificates curl gnupg ufw git
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== Docker Engine (free CE; no Docker Desktop, no paid plan)"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  # shellcheck source=/dev/null
  . /etc/os-release
  case "$ID" in ubuntu|debian) ;; *) echo "unsupported distro: $ID" >&2; exit 1 ;; esac
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io
fi
cat > /etc/docker/daemon.json <<'JSON'
{"log-driver":"json-file","log-opts":{"max-size":"20m","max-file":"5"},"live-restore":false}
JSON
systemctl enable --now docker
systemctl restart docker

echo "== Swarm (single node; management/overlay ports 2377/7946/4789 are never exposed)"
if [ "$(docker info --format '{{.Swarm.LocalNodeState}}')" != "active" ]; then
  docker swarm init --advertise-addr 127.0.0.1
fi

echo "== deploy user + SSH hardening"
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
if [ ! -s /home/deploy/.ssh/authorized_keys ]; then
  echo "WARNING: /home/deploy/.ssh/authorized_keys is empty. Add your public key BEFORE hardening SSH, or you will lock yourself out." >&2
  echo "         Skipping sshd hardening this run." >&2
else
  cat > /etc/ssh/sshd_config.d/99-screener.conf <<'SSH'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
SSH
  systemctl reload ssh
fi

echo "== firewall (Docker-published ports bypass ufw, but only Caddy publishes anything)"
ufw default deny incoming
ufw default allow outgoing
if [ -n "$SSH_ALLOW_IP" ]; then ufw allow from "$SSH_ALLOW_IP" to any port 22 proto tcp; else ufw allow 22/tcp; fi
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "== data + log directories (engine runs as uid 10001)"
mkdir -p /srv/screener/data/data_cache /srv/screener/data/data_cache_literal /srv/screener/data/results/prompt_arms
chown -R 10001:10001 /srv/screener/data
mkdir -p /srv/screener/logs
chown deploy:deploy /srv/screener /srv/screener/logs

if [ "$SWAP" -eq 1 ] && ! swapon --show | grep -q /swapfile; then
  echo "== 2 GB swapfile (safety net against OOM kills during warm-up)"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== weekly-jobs systemd timer (edit OnCalendar in the timer file first: decision D-S3)"
install -m 0644 "$HERE/systemd/screener-jobs.service" /etc/systemd/system/screener-jobs.service
install -m 0644 "$HERE/systemd/screener-jobs.timer" /etc/systemd/system/screener-jobs.timer
systemctl daemon-reload
systemctl enable --now screener-jobs.timer
for u in screener-disk screener-backup; do
  install -m 0644 "$HERE/systemd/$u.service" "/etc/systemd/system/$u.service"
  install -m 0644 "$HERE/systemd/$u.timer" "/etc/systemd/system/$u.timer"
done
systemctl daemon-reload
systemctl enable --now screener-disk.timer screener-backup.timer

echo "done. Next: create the Swarm secrets (see secrets.example), write /srv/screener/stack.env, clone the repo to /srv/screener/repo, run deploy.sh."
