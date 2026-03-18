# Default Configuration

These are the built-in defaults that ship with guardrails. They are always active unless explicitly overridden by user configuration.

Source: [`src/config.ts`](../src/config.ts)

## Default Policy Rules

### `secret-files` — Files containing secrets

Blocks access to dotenv files and similar secret-bearing files.

| Protection | Only if exists |
|------------|---------------|
| `noAccess` | yes           |

**Patterns:**

| Pattern            | Type |
|--------------------|------|
| `.env`             | glob |
| `.env.local`       | glob |
| `.env.production`  | glob |
| `.env.prod`        | glob |
| `.dev.vars`        | glob |

**Allowed exceptions:**

| Pattern            | Type |
|--------------------|------|
| `*.example.env`    | glob |
| `*.sample.env`     | glob |
| `*.test.env`       | glob |
| `.env.example`     | glob |
| `.env.sample`      | glob |
| `.env.test`        | glob |

---

### `home-ssh` — SSH directory and keys

Blocks access to SSH configuration, private keys, and related files.

| Protection | Only if exists |
|------------|---------------|
| `noAccess` | yes           |

**Patterns:**

| Pattern               | Type |
|-----------------------|------|
| `.ssh/**`             | glob |
| `.ssh/config`         | glob |
| `.ssh/known_hosts`    | glob |
| `.ssh/authorized_keys`| glob |
| `*_rsa`               | glob |
| `*_ed25519`           | glob |
| `*.pem`               | glob |

**Allowed exceptions:**

| Pattern  | Type |
|----------|------|
| `*.pub`  | glob |

---

### `home-config` — User configuration directory

Blocks access to the user's `.config` directory, which may contain sensitive settings or credentials for various tools.

| Protection | Only if exists |
|------------|---------------|
| `noAccess` | yes           |

**Patterns:**

| Pattern       | Type |
|---------------|------|
| `.config/**`  | glob |

---

### `home-gpg` — GPG keys and configuration

Blocks access to GPG/GnuPG private keys, keyrings, and configuration.

| Protection | Only if exists |
|------------|---------------|
| `noAccess` | yes           |

**Patterns:**

| Pattern            | Type |
|--------------------|------|
| `.gnupg/**`        | glob |
| `.gpg`             | glob |
| `*.gpg`            | glob |
| `.gpg-agent.conf`  | glob |

---

## Default Permission Gate Patterns

These commands are detected using AST-based structural matching for accuracy.

| Pattern         | Description                    |
|-----------------|--------------------------------|
| `rm -rf`        | Recursive force delete         |
| `sudo`          | Superuser command              |
| `dd if=`        | Disk write operation           |
| `mkfs.`         | Filesystem format              |
| `chmod -R 777`  | Insecure recursive permissions |
| `chown -R`      | Recursive ownership change     |
