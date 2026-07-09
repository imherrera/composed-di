#!/usr/bin/env node
/**
 * Standalone dashboard server:
 *
 *   composed-di-dashboard [--port 4321] [--host 127.0.0.1]
 *
 * Applications export their service events to it with DashboardClient.
 */
import { ServiceDashboard } from './dashboardServer';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const port = Number(argValue('--port') ?? process.env.PORT ?? 4321);
  const host = argValue('--host') ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${argValue('--port') ?? process.env.PORT}`);
    process.exit(1);
  }

  const dashboard = new ServiceDashboard();
  const url = await dashboard.listen(port, host);
  console.log(`composed-di dashboard listening at ${url}`);
  console.log(
    'Waiting for an application to connect (see DashboardClient in @composed-di/observability).',
  );

  const shutdown = async () => {
    await dashboard.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
