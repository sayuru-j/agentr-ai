export function renderEnvFile(opts: {
  appId: string;
  appSecret: string;
  workerToken: string;
  domain: string;
}): string {
  return `# AgentRelay relay configuration
MICROSOFT_APP_ID=${opts.appId}
MICROSOFT_APP_PASSWORD=${opts.appSecret}
MICROSOFT_APP_TENANT_ID=
WORKER_TOKEN=${opts.workerToken}
HTTP_PORT=3000
WS_PORT=8080
RELAY_DOMAIN=${opts.domain}
AGENTR_MOCK=0
`;
}

export function renderCaddyfile(opts: {
  domain: string;
  email: string;
}): string {
  return `{
	email ${opts.email}
}

${opts.domain} {
	encode gzip

	@bot path /api/* /health
	handle @bot {
		reverse_proxy 127.0.0.1:3000
	}

	handle /ws* {
		reverse_proxy 127.0.0.1:8080
	}

	handle {
		respond "AgentRelay" 200
	}
}
`;
}

export function renderSystemdUnit(opts: {
  envFile: string;
  execStart: string;
  workingDirectory: string;
}): string {
  return `[Unit]
Description=AgentRelay Teams + WebSocket relay server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${opts.envFile}
WorkingDirectory=${opts.workingDirectory}
ExecStart=${opts.execStart}
Restart=on-failure
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
`;
}
