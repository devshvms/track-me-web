import { PostHog } from 'posthog-node';

export async function captureTelemetryEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, any>
) {
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) {
    return;
  }

  try {
    const client = new PostHog(apiKey, {
      host: process.env.POSTHOG_HOST || 'https://eu.i.posthog.com',
      flushAt: 1, // Immediately flush for serverless functions
      flushInterval: 0,
    });

    client.capture({
      distinctId,
      event,
      properties,
    });

    await client.shutdown();
  } catch (error) {
    console.error('PostHog Telemetry Error:', error);
  }
}
