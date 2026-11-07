/** The one-click deploy templates share one contract: the Dockerfile from the repository root,
 * port 3000, an HTTP health check on GET /health, exactly one instance (the server refuses a
 * second writer) and the public demo environment that MP_SEED_ON_EMPTY and the credential
 * notices rely on. Provider-specific shapes are checked against each host's documented keys.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf8");
const DEMO_ENV = {
  MP_ACCESS_TOKEN: "mpg-local-change-me",
  MP_BOOTSTRAP_KEY: "mpk-local-bootstrap-change-me",
  MP_ADMIN_PIN: "0000",
  MP_SEED_ON_EMPTY: "true",
  PORT: "3000",
};
const envMap = (entries: { key: string; value: string }[]) =>
  Object.fromEntries(entries.map(({ key, value }) => [key, value]));

describe("one-click deploy templates", () => {
  it("Render blueprint", () => {
    const blueprint = loadYaml(read("render.yaml")) as {
      services: {
        runtime: string;
        plan: string;
        dockerfilePath: string;
        dockerContext: string;
        healthCheckPath: string;
        numInstances: number;
        envVars: { key: string; value: string }[];
      }[];
    };
    const [service] = blueprint.services;
    expect(service).toMatchObject({
      runtime: "docker",
      plan: "free",
      dockerfilePath: "./infra/docker/Dockerfile",
      dockerContext: ".",
      healthCheckPath: "/health",
      numInstances: 1,
    });
    expect(envMap(service?.envVars ?? [])).toEqual(DEMO_ENV);
  });

  it("Koyeb button URL", () => {
    const url = read("README.md").match(/\(https:\/\/app\.koyeb\.com\/deploy\?[^)]+\)/)?.[0];
    expect(url).toBeDefined();
    const params = new URL(url!.slice(1, -1)).searchParams;
    expect(Object.fromEntries([...params].filter(([key]) => !key.startsWith("env[")))).toEqual({
      type: "git",
      repository: "github.com/diegomarino/marplanner",
      branch: "main",
      name: "marplanner",
      builder: "dockerfile",
      dockerfile: "infra/docker/Dockerfile",
      instance_type: "free",
      instances_max: "1",
      ports: "3000;http;/",
      "hc_protocol[3000]": "http",
      "hc_path[3000]": "/health",
      "hc_method[3000]": "get",
      "hc_grace_period[3000]": "30",
    });
    const env = Object.fromEntries(
      [...params]
        .filter(([key]) => key.startsWith("env["))
        .map(([key, value]) => [key.slice(4, -1), value])
    );
    expect(env).toEqual(DEMO_ENV);
  });

  it("Railway config as code", () => {
    const config = JSON.parse(read("railway.json")) as {
      build: Record<string, unknown>;
      deploy: Record<string, unknown>;
    };
    expect(config.build).toEqual({
      builder: "DOCKERFILE",
      dockerfilePath: "infra/docker/Dockerfile",
    });
    expect(config.deploy).toMatchObject({
      healthcheckPath: "/health",
      restartPolicyType: "ON_FAILURE",
    });
  });

  it("DigitalOcean App Platform template", () => {
    const template = loadYaml(read(".do/deploy.template.yaml")) as {
      spec: {
        services: {
          git: { repo_clone_url: string; branch: string };
          dockerfile_path: string;
          http_port: number;
          instance_count: number;
          health_check: { http_path: string };
          envs: { key: string; value: string }[];
        }[];
      };
    };
    const [service] = template.spec.services;
    expect(service).toMatchObject({
      git: {
        repo_clone_url: "https://github.com/diegomarino/marplanner.git",
        branch: "main",
      },
      dockerfile_path: "infra/docker/Dockerfile",
      http_port: 3000,
      instance_count: 1,
      health_check: { http_path: "/health" },
    });
    expect(envMap(service?.envs ?? [])).toEqual(DEMO_ENV);
  });

  it("README buttons point at this repository", () => {
    const readme = read("README.md");
    expect(readme).toContain(
      "https://render.com/deploy?repo=https://github.com/diegomarino/marplanner)"
    );
    expect(readme).toContain(
      "https://cloud.digitalocean.com/apps/new?repo=https://github.com/diegomarino/marplanner/tree/main)"
    );
    // Railway's button needs a published template: never advertise the placeholder code.
    const railway = readme.match(/\(https:\/\/railway\.com\/deploy\/([A-Za-z0-9_-]+)[?)]/);
    expect(railway?.[1]).not.toBe("RAILWAY_TEMPLATE_CODE");
  });
});
