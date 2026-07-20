#!/usr/bin/env bash
# scripts/dev-webhook.sh

if [ ! -f ".dev.vars" ]; then
  echo "Error: .dev.vars not found."
  echo "Please create .dev.vars and add your DEV bot token: TELEGRAM_BOT_TOKEN=..."
  exit 1
fi

# Try to get ngrok URL from local API
TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o '"public_url":"https://[^"]*' | head -1 | cut -d'"' -f4)

if [ -z "$TUNNEL_URL" ]; then
  echo "Error: Could not find an active ngrok tunnel."
  echo "Please start ngrok first: ngrok http 8787"
  exit 1
fi

# Extract dev token and secret from .dev.vars
BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN' .dev.vars | cut -d '=' -f2- | tr -d ' "' | tr -d "\r")
SECRET=$(grep '^TELEGRAM_WEBHOOK_SECRET' .dev.vars | cut -d '=' -f2- | tr -d ' "' | tr -d "\r")

if [ -z "$BOT_TOKEN" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN not found in .dev.vars"
  exit 1
fi

if [ -z "$SECRET" ]; then
  echo "Error: TELEGRAM_WEBHOOK_SECRET not found in .dev.vars"
  exit 1
fi

echo "Found ngrok tunnel: $TUNNEL_URL"
echo "Registering webhook for dev bot to $TUNNEL_URL/webhook/telegram..."
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${TUNNEL_URL}/webhook/telegram&secret_token=${SECRET}"

echo ""
echo "Done! Your local dev server is now receiving updates from your dev bot."
