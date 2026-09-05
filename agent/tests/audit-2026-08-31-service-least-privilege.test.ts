/** Runtime units must not execute application code as root. */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const units = [
  ["deploy", "agent-team.service"],
  ["deploy", "agent-team-blue.service"],
  ["deploy", "agent-team-green.service"],
  ["deploy", "systemd", "delabs-daily-draft.service"],
  ["deploy", "systemd", "delabs-approve-poll.service"],
  ["deploy", "systemd", "delabs-weekly-draft.service"],
];

for (const path of units) {
  test(`${path.at(-1)} uses the restricted runtime account`, () => {
    const src = readFileSync(join(ROOT, ...path), "utf8");
    expect(src).toMatch(/^User=agent-team$/m);
    expect(src).toMatch(/^Group=agent-team$/m);
    expect(src).not.toMatch(/^User=root$/m);
    expect(src).not.toContain("/root/.bun/bin/bun");
    expect(src).toContain("/usr/local/bin/bun");
    expect(src).toMatch(/^NoNewPrivileges=true$/m);
    expect(src).toMatch(/^UMask=0077$/m);
  });
}

test("host setup creates only the runtime-owned writable directories", () => {
  const src = readFileSync(join(ROOT, "deploy", "setup-agent-runtime-user.sh"), "utf8");
  expect(src).toContain("useradd --system");
  expect(src).toContain("/opt/web3-puls/drafts");
  expect(src).toContain('chmod 0640 "$APP_DIR/.env"');
  expect(src).toContain('chown -R "$RUNTIME_USER:$RUNTIME_GROUP"');
  expect(src).toContain('DEPLOY_USER="${DEPLOY_USER:-agent-deploy}"');
  expect(src).toContain("/usr/local/sbin/agent-team-deploy");
  expect(src).toContain("agent-team.service");
});

test("content timer units have a strict filesystem boundary", () => {
  for (const file of [
    "delabs-daily-draft.service",
    "delabs-approve-poll.service",
    "delabs-weekly-draft.service",
  ]) {
    const src = readFileSync(join(ROOT, "deploy", "systemd", file), "utf8");
    expect(src).toMatch(/^ProtectSystem=strict$/m);
    expect(src).toMatch(/^ProtectHome=true$/m);
    expect(src).toMatch(/^PrivateTmp=true$/m);
    expect(src).toMatch(/^ReadWritePaths=\/opt\/web3-puls\/drafts$/m);
  }
});

// deploy.yml удалён при публичном релизе 2026-09-01: CI-половину проверки
// сверять не с чем. Вернётся воркфлоу — тест включится сам.
const DEPLOY_YML = join(ROOT, ".github", "workflows", "deploy.yml");

test.skipIf(!existsSync(DEPLOY_YML))("CI deploy accepts only the hardened canonical unit", () => {
  const src = readFileSync(DEPLOY_YML, "utf8");
  expect(src).toContain("DEPLOY_SERVICE must be the hardened canonical agent-team unit");
  expect(src).toContain("sudo -n /usr/local/sbin/agent-team-deploy restart");
  expect(src).toContain("sudo -n /usr/local/sbin/agent-team-deploy restore-session");
});
