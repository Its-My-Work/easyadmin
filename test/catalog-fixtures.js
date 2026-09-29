// Собственные примеры шаблонов в формате репозитория easypanel-io/templates: для тестов и демо (без выхода в интернет)
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export const HEAD = 'import { Output, randomPassword, randomString, Services } from "~templates-utils";\nimport { Input } from "./meta";\n\n';
export const FILES = {
  'list.json': JSON.stringify([
    { slug: 'demo', logo: 'logo.png', name: 'Demo', description: 'Demo app\n  with   a database', tags: ['Web', 'Demo'] },
    { slug: 'needs-input', logo: 'logo.png', name: 'Needs input', description: 'Has a required field', tags: ['Web'] },
    { slug: 'uses-fs', name: 'Uses fs', description: 'imports fs', tags: [] },
    { slug: 'uses-ecdh', name: 'Uses ecdh', description: 'needs EC keys', tags: [] },
    { slug: 'probe', name: 'Probe', description: 'looks around the sandbox', tags: ['Demo'] },
    { slug: 'shims', name: 'Shims', description: 'btoa / Buffer / crypto', tags: [] },
    { slug: '../etc', name: 'Bad slug', description: '', tags: [] },
  ]),
  'demo/assets/logo.png': PNG,
  'needs-input/assets/logo.png': PNG,
  'demo/meta.yaml': `name: Demo
description:
  Demo app that needs a database
  and some words.
instructions: Open the app after deploy.
links:
  - label: Site
    url: https://example.com
  - label: Evil
    url: javascript:alert(1)
tags:
  - Web
  - Demo
schema:
  type: object
  required:
    - appServiceName
    - appServiceImage
  properties:
    appServiceName:
      type: string
      title: App Service Name
      default: demo
    appServiceImage:
      type: string
      title: App Service Image
      default: nginx:1.27
    dbEnabled:
      type: boolean
      title: Enable database
      default: true
    port:
      type: integer
      title: Port
      default: 8080
      minimum: 1
      maximum: 65535
    mode:
      type: string
      title: Mode
      oneOf:
        - enum:
            - fast
          title: Fast mode
        - enum:
            - safe
          title: Safe mode
      default: safe
    adminToken:
      type: string
      title: Admin token
      format: password
      default: ""
      showIf:
        field: mode
        is: safe
`,
  'demo/index.ts': `${HEAD}export function generate(input: Input): Output {
  const services: Services = [];
  const dbPassword = randomPassword();
  services.push({
    type: "app",
    data: {
      serviceName: input.appServiceName,
      env: [
        \`DB_PASSWORD=\${dbPassword}\`,
        \`APP_KEY=base64:\${btoa(randomString(8))}\`,
        \`MODE=\${input.mode}\`,
        \`PORT=\${input.port}\`,
      ].join("\\n"),
      source: { type: "image", image: input.appServiceImage },
      domains: [{ host: "$(EASYPANEL_DOMAIN)", port: input.port }],
      mounts: [{ type: "volume", name: "data", mountPath: "/data" }],
    },
  });
  if (input.dbEnabled) {
    services.push({ type: "postgres", data: { serviceName: \`\${input.appServiceName}-db\`, password: dbPassword } });
  }
  return { services };
}
`,
  'needs-input/meta.yaml': `name: Needs input
description: Has a required field
instructions: x
links: []
schema:
  type: object
  required:
    - token
  properties:
    token:
      type: string
      title: API Token
`,
  'needs-input/index.ts': `${HEAD}export function generate(input: Input): Output {
  return { services: [{ type: "redis", data: { serviceName: "r-" + input.token.length, password: input.token } }] };
}
`,
  'uses-fs/meta.yaml': 'name: Uses fs\ndescription: x\ninstructions: x\nlinks: []\nschema:\n  type: object\n  properties: {}\n',
  'uses-fs/index.ts': 'import { readFileSync } from "fs";\nimport { Output } from "~templates-utils";\nexport function generate(input: any): Output { return { services: [] }; }\n',
  'uses-ecdh/meta.yaml': 'name: Uses ecdh\ndescription: x\ninstructions: x\nlinks: []\nschema:\n  type: object\n  properties: {}\n',
  'uses-ecdh/index.ts': `${HEAD}export function generate(input: Input): Output {\n  const crypto = require("crypto");\n  crypto.createECDH("prime256v1");\n  return { services: [] };\n}\n`,
  'probe/meta.yaml': 'name: Probe\ndescription: x\ninstructions: x\nlinks: []\nschema:\n  type: object\n  properties: {}\n',
  'probe/index.ts': `${HEAD}export function generate(input: Input): Output {
  const F = (() => 1).constructor;
  let escaped = "no";
  try { escaped = String(F("return typeof process")()); } catch (e) { escaped = "blocked"; }
  const seen = [typeof process, typeof fetch, typeof globalThis.process, typeof globalThis.fetch].join(" ");
  return { services: [{ type: "app", data: { serviceName: "probe", env: \`ESCAPED=\${escaped}\\nSEEN=\${seen}\` } }] };
}
`,
  'shims/meta.yaml': 'name: Shims\ndescription: x\ninstructions: x\nlinks: []\nschema:\n  type: object\n  properties: {}\n',
  'shims/index.ts': `import { randomBytes } from "crypto";\n${HEAD}export function generate(input: Input): Output {
  const s = randomString(11);
  const hex = randomBytes(16).toString("hex");
  return { services: [{ type: "app", data: { serviceName: "shims", env: [
    \`S=\${s}\`, \`A=\${btoa(s)}\`, \`B=\${Buffer.from(s).toString("base64")}\`, \`C=\${atob(btoa(s))}\`, \`D=\${Buffer.from(s).toString("hex")}\`, \`H=\${hex}\`,
  ].join("\\n") } }] };
}
`,
};

