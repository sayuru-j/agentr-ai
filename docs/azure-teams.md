# Azure Bot & Microsoft Teams

## Create the bot

1. Azure Portal → **Azure Bot** → Create.
2. Choose **Single Tenant** (not User Assigned Managed Identity).
3. Note the bot’s **Microsoft App ID** from the bot **Configuration** blade (`msaAppId`).
4. Open the linked **App registration** → **Certificates & secrets** → create a client secret → copy the **Value**.
5. Copy **Directory (tenant) ID** from the App registration Overview.

These three go into VM `config.env`:

```env
MICROSOFT_APP_ID=<msaAppId from the Azure Bot>
MICROSOFT_APP_PASSWORD=<client secret Value>
MICROSOFT_APP_TENANT_ID=<Directory tenant ID>
```

The App ID in `config.env`, the Teams zip (`botId`), and the Azure Bot `msaAppId` **must all match**.

## Messaging endpoint

After DNS + Caddy are live:

1. Bot → **Configuration**
2. Messaging endpoint: `https://YOUR_DOMAIN/api/messages`
3. Save

## Enable Teams channel

Bot → **Channels** → **Microsoft Teams** → enable.

Verify with Azure CLI:

```bash
az bot show -n AgentR -g <resource-group> --query "properties.{endpoint:endpoint,enabled:enabledChannels,appId:msaAppId}"
az bot msteams show -n AgentR -g <resource-group>
```

## Sideload the Teams app

1. Download the package (easiest): open  
   `https://YOUR_DOMAIN/api/agentr-teams.zip`  
   (also printed by `npm run cli:status` on the VM as **Download**).
2. Or copy from the VM: `/etc/agent-relay/agentr-teams.zip` (scp).
3. Teams → Apps → Manage your apps → **Upload a custom app** → upload the zip.
4. Open a **1:1 chat** with **AgentR**.

If you regenerate the zip after changing App ID or icons, remove the old app and upload again (manifest version bumps help). Redeploy/restart the relay so `/api/agentr-teams.zip` serves the new file.

### scp example (Windows PowerShell)

```powershell
# On VM first if needed:
# sudo cp /etc/agent-relay/agentr-teams.zip /home/azureuser/ && sudo chown azureuser:azureuser /home/azureuser/agentr-teams.zip

scp azureuser@YOUR_VM_IP:~/agentr-teams.zip "$env:USERPROFILE\Downloads\agentr-teams.zip"
```

Next: [Desktop tray](./desktop-tray.md) → [After adding the bot](./after-teams.md)
