/**
 * Entry point: load catalog, start bot + webhook server.
 */

import { Catalog } from "./catalog.js";
import { initAI } from "./ai.js";
import { ValidanceClient } from "./validance.js";
import { createWebhookServer } from "./webhook.js";
import { createBot } from "./bot.js";

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

async function main(): Promise<void> {
  const telegramToken = required("TELEGRAM_BOT_TOKEN");
  const validanceUrl = process.env.VALIDANCE_URL ?? "http://localhost:8001";
  const webhookPort = parseInt(process.env.WEBHOOK_PORT ?? "3000", 10);
  const webhookHost = process.env.WEBHOOK_HOST ?? "172.18.0.1";

  // ANTHROPIC_API_KEY is read by the SDK from env automatically
  required("ANTHROPIC_API_KEY");

  // Load catalog and initialize AI layer
  const catalog = Catalog.load();
  console.log(
    `[ok] Catalog loaded: ${catalog.actions.length} actions (${catalog.actions.join(", ")})`
  );
  initAI(catalog);

  // Validance health check
  const validance = new ValidanceClient(validanceUrl);
  const healthy = await validance.healthCheck();
  if (!healthy) {
    console.warn(
      `[warn] Validance at ${validanceUrl} is not reachable. Bot will start but proposals will fail.`
    );
  } else {
    console.log(`[ok] Validance healthy at ${validanceUrl}`);
  }

  // Create bot with handlers
  const { bot, onApprovalReady } = createBot(
    telegramToken,
    validance,
    webhookHost,
    webhookPort,
    catalog
  );

  // Start webhook server
  const webhookServer = createWebhookServer(onApprovalReady);
  webhookServer.listen(webhookPort, () => {
    console.log(`[ok] Webhook server listening on :${webhookPort}`);
  });

  // Start bot (long polling)
  bot.start({
    onStart: (me) => {
      console.log(`[ok] Bot started as @${me.username}`);
    },
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("[info] Shutting down...");
    bot.stop();
    webhookServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
