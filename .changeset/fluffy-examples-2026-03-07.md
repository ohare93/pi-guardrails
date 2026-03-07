---
"@aliou/pi-guardrails": patch
---

Add more policy and command examples in settings UI

File policy presets:
- SSH keys (*.pem, *_rsa, *_ed25519)
- AWS credentials (.aws/credentials, .aws/config)
- Database files (*.db, *.sqlite, *.sqlite3) - read-only
- Kubernetes secrets (.kube/config, *kubeconfig*)
- Certificates (*.crt, *.key, *.p12)

Dangerous command presets:
- terraform apply/destroy
- kubectl delete
- docker system prune
- git push --force
- npm/yarn/pnpm publish
- DROP DATABASE/TABLE
