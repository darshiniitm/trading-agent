# Production deploy over IAP SSH (Engine Production Plan, Phase 5). Config comes from the environment:
#   VM=<instance> ZONE=<zone> PROJECT=<gcp project> [DEPLOY_USER=deploy]
# Digests come from the CI run summary (the "Record digest" step).
VM ?=
ZONE ?=
PROJECT ?=
DEPLOY_USER ?= deploy
SSH_KEY ?=
KEYFLAG = $(if $(SSH_KEY),--ssh-key-file $(SSH_KEY),)
SSH = gcloud compute ssh $(DEPLOY_USER)@$(VM) --zone $(ZONE) --project $(PROJECT) --tunnel-through-iap $(KEYFLAG) --command

.PHONY: deploy rollback status
deploy:
	@test -n "$(ENGINE_DIGEST)" -a -n "$(JOBS_DIGEST)" -a -n "$(SHA)" || { echo "usage: make deploy ENGINE_DIGEST=sha256:.. JOBS_DIGEST=sha256:.. SHA=<git sha>"; exit 2; }
	$(SSH) "cd /srv/screener/repo && git fetch -q && git checkout -q $(SHA) && ./deploy/swarm/deploy-digest.sh $(ENGINE_DIGEST) $(JOBS_DIGEST) $(SHA)"

rollback:
	$(SSH) "docker service rollback screener_engine"

status:
	$(SSH) "docker service ls && docker service inspect screener_engine --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'"
