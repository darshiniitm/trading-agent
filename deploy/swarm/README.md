# Engine on Docker Swarm (single VM)

Files for running the screening engine on one Linux VM with a free Docker Engine + Swarm stack.
Design and decisions: [`docs/engine-swarm-deploy-plan.md`](../../docs/engine-swarm-deploy-plan.md).
Day-to-day commands (deploy, roll back, rotate secrets, logs, restore): [`docs/runbook-production.md`](../../docs/runbook-production.md).

| File | Purpose |
|---|---|
| `stack.yml` | engine (1 replica, stop-first updates), Caddy (TLS), jobs (replicas 0) |
| `Caddyfile` | HTTPS reverse proxy to `engine:8080` |
| `bootstrap-host.sh` | one-time VM setup (Docker, Swarm, ufw, SSH, data dirs, timer) |
| `deploy.sh` | build images on the VM and `docker stack deploy` |
| `run-weekly-jobs.sh`, `systemd/` | host timer that runs the weekly job |
| `secrets.example`, `stack.env.example` | secret names / non-secret stack variables |
