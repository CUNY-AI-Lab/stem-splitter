import { serve } from '@hono/node-server';
import { createAudioAnalysisService } from './app.ts';
import { audioAnalysisConfigFromEnv } from './config.ts';

const config = audioAnalysisConfigFromEnv();
const service = createAudioAnalysisService(config);

const server = serve(
  { fetch: service.fetch, port: config.port, hostname: '0.0.0.0' },
  (info) => {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'service_started',
        service: 'audio-analysis',
        port: info.port,
      })
    );
  }
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
