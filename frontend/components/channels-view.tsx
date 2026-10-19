"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Bot,
  CheckCircle2,
  Code2,
  Edit2,
  Loader2,
  Plus,
  Radio,
  Save,
  Send,
  Trash2,
  Tv,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  browserCreateChannel,
  browserDeleteChannel,
  browserGetChannelSettings,
  browserListChannels,
  browserTestChannelConnection,
  browserTestPasswordScript,
  browserUpdateChannel,
  browserUpdateChannelSettings,
} from "@/lib/api";
import type { TelegramChannelItem, TelegramSettings } from "@/lib/api";

const SAMPLE_PASSWORD_SCRIPT = `import re

def extract_password(message_content: str) -> str:
    """
    Template for Telegram message password extraction:
    👻 Password: None -> returns ""
    👻 Password: @HUNTER_CLOUDS -> returns "@HUNTER_CLOUDS"
    """
    m = re.search(r'(?:👻\\s*)?Password:\\s*([^\\r\\n]+)', message_content, re.IGNORECASE)
    if m:
        pwd = m.group(1).strip()
        if pwd.lower() in ("none", "null", "false", "no", ""):
            return ""
        return pwd
    return ""
`;

const SAMPLE_TEST_MESSAGE = `File: Logs_14_September.rar (3.8 GB)
👻 Password: @HUNTER_CLOUDS
🥺 Discord (https://discord.gg/9ySDCCU69J)
`;

export function ChannelsView() {
  const [channels, setChannels] = useState<TelegramChannelItem[]>([]);
  const [isLoadingChannels, setIsLoadingChannels] = useState(true);

  const [tgSettings, setTgSettings] = useState<TelegramSettings>({
    apiId: 0,
    apiHash: "",
    sessionString: "",
    isConfigured: false,
  });
  const [apiIdInput, setApiIdInput] = useState("");
  const [apiHashInput, setApiHashInput] = useState("");
  const [sessionInput, setSessionInput] = useState("");
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<string | null>(null);
  const [connectedUser, setConnectedUser] = useState<string | null>(null);
  const [isTestingConnection, startTestConnectionTransition] = useTransition();

  const [isChannelDialogOpen, setIsChannelDialogOpen] = useState(false);
  const [editingChannel, setEditingChannel] =
    useState<TelegramChannelItem | null>(null);
  const [channelName, setChannelName] = useState("");
  const [channelTargetId, setChannelTargetId] = useState("");
  const [channelScript, setChannelScript] = useState(SAMPLE_PASSWORD_SCRIPT);
  const [isSavingChannel, setIsSavingChannel] = useState(false);

  const [testMessageText, setTestMessageText] = useState(SAMPLE_TEST_MESSAGE);
  const [testScriptResult, setTestScriptResult] = useState<string | null>(null);
  const [isTestingScript, setIsTestingScript] = useState(false);

  async function loadData() {
    setIsLoadingChannels(true);
    const [cRes, sRes] = await Promise.all([
      browserListChannels(),
      browserGetChannelSettings(),
    ]);
    setIsLoadingChannels(false);
    if (cRes.ok) setChannels(cRes.data.channels);
    if (sRes.ok) {
      setTgSettings(sRes.data.settings);
      setApiIdInput(
        sRes.data.settings.apiId > 0 ? String(sRes.data.settings.apiId) : "",
      );
      setApiHashInput(sRes.data.settings.apiHash || "");
      setSessionInput("");
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void loadData();
    });
  }, []);

  async function handleSaveSettings() {
    setIsSavingSettings(true);
    const apiId = parseInt(apiIdInput.trim(), 10) || 0;
    const res = await browserUpdateChannelSettings({
      apiId,
      apiHash: apiHashInput.trim(),
      sessionString: sessionInput.trim(),
    });
    setIsSavingSettings(false);
    if (res.ok) {
      setTgSettings(res.data.settings);
      setSessionInput("");
      toast.success("Saved Telegram UserBot configuration.");
    } else {
      toast.error(res.error?.message ?? "Failed to save settings.");
    }
  }

  function handleTestConnection() {
    startTestConnectionTransition(async () => {
      setConnectionStatus(null);
      setConnectedUser(null);
      const res = await browserTestChannelConnection();
      if (res.ok && res.data.status === "ok") {
        const u = res.data.user;
        const info = u?.username
          ? `@${u.username} (ID: ${u.id})`
          : `ID ${u?.id} (${u?.firstName})`;
        setConnectionStatus("connected");
        setConnectedUser(info);
        toast.success(`Telethon connected as ${info}`);
      } else {
        setConnectionStatus("error");
        toast.error(
          !res.ok
            ? (res.error?.message ?? "Connection failed.")
            : (res.data?.message ?? "Connection failed."),
        );
      }
    });
  }

  function openCreateDialog() {
    setEditingChannel(null);
    setChannelName("");
    setChannelTargetId("");
    setChannelScript(SAMPLE_PASSWORD_SCRIPT);
    setTestScriptResult(null);
    setIsChannelDialogOpen(true);
  }

  function openEditDialog(c: TelegramChannelItem) {
    setEditingChannel(c);
    setChannelName(c.name);
    setChannelTargetId(c.channelId);
    setChannelScript(c.passwordScript || SAMPLE_PASSWORD_SCRIPT);
    setTestScriptResult(null);
    setIsChannelDialogOpen(true);
  }

  async function handleSaveChannel() {
    if (!channelName.trim() || !channelTargetId.trim()) {
      toast.error("Name and Channel ID are required.");
      return;
    }
    setIsSavingChannel(true);
    const res = editingChannel
      ? await browserUpdateChannel(editingChannel.id, {
          name: channelName.trim(),
          channelId: channelTargetId.trim(),
          passwordScript: channelScript,
        })
      : await browserCreateChannel({
          name: channelName.trim(),
          channelId: channelTargetId.trim(),
          passwordScript: channelScript,
        });
    setIsSavingChannel(false);
    if (res.ok) {
      toast.success(
        editingChannel
          ? `Updated channel "${channelName}".`
          : `Added channel "${channelName}".`,
      );
      setIsChannelDialogOpen(false);
      void loadData();
    } else {
      toast.error(res.error?.message ?? "Failed to save channel.");
    }
  }

  async function handleDeleteChannel(id: string) {
    const res = await browserDeleteChannel(id);
    if (res.ok) {
      toast.success("Channel removed.");
      setChannels((prev) => prev.filter((c) => c.id !== id));
    } else {
      toast.error(res.error?.message ?? "Failed to delete channel.");
    }
  }

  async function handleTestScriptLive() {
    setIsTestingScript(true);
    setTestScriptResult(null);
    const res = await browserTestPasswordScript({
      script: channelScript,
      messageContent: testMessageText,
    });
    setIsTestingScript(false);
    if (res.ok && res.data.status === "ok") {
      setTestScriptResult(res.data.resolvedPassword || "(none)");
    } else {
      toast.error(
        !res.ok
          ? (res.error?.message ?? "Script execution error.")
          : (res.data?.message ?? "Script execution error."),
      );
    }
  }

  return (
    <div className="flex min-w-0 w-full flex-1 flex-col gap-5">
      {/* Architectural Telemetry Ribbon */}
      <section className="obsidian-panel grid grid-cols-1 divide-y divide-white/[0.06] overflow-hidden sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Monitored Channels</span>
            <Radio className="size-3.5 text-[#5c606a]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
              {channels.length}
            </span>
            <span className="text-[11px] text-[#6b707b]">targets</span>
          </div>
        </div>

        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">UserBot Session</span>
            <Bot className="size-3.5 text-[#5c606a]" />
          </div>
          <div className="flex items-center gap-2">
            {connectionStatus === "connected" ? (
              <span className="obsidian-badge-active gap-1.5 text-xs">
                <span className="size-1.5 rounded-full bg-[#10b981]" />
                Online
              </span>
            ) : tgSettings.isConfigured ? (
              <span className="obsidian-badge-active gap-1.5 text-xs">
                <span className="size-1.5 rounded-full bg-[#f3f4f6]" />
                Configured
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-xs font-medium text-[#f43f5e]">
                Not Configured
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Password Resolver</span>
            <Code2 className="size-3.5 text-[#5c606a]" />
          </div>
          <span className="font-mono text-base font-semibold tracking-tight text-[#f3f4f6]">
            Python 3 Regex Engine
          </span>
        </div>
      </section>

      {/* Telethon UserBot Configuration Panel */}
      <section className="obsidian-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-3.5">
          <div>
            <h2 className="text-sm font-semibold text-[#f3f4f6]">
              MTProto UserBot Credentials
            </h2>
            <p className="mt-0.5 text-xs text-[#6b707b]">
              Obtain API ID and API Hash from my.telegram.org. StringSession enables non-interactive cross-DC downloads.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTestConnection}
              disabled={isTestingConnection || !tgSettings.isConfigured}
              className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-3 text-xs text-[#e5e7eb] hover:bg-white/[0.05]"
            >
              {isTestingConnection ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Radio className="size-3.5 text-[#10b981]" />
              )}
              {isTestingConnection ? "Testing…" : "Test Connection"}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleSaveSettings()}
              disabled={isSavingSettings}
              className="h-8 gap-1.5 rounded-lg bg-[#f3f4f6] px-3.5 text-xs font-medium text-[#050506] hover:bg-white"
            >
              <Save className="size-3.5" />
              {isSavingSettings ? "Saving…" : "Save Credentials"}
            </Button>
          </div>
        </div>

        {connectedUser ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-[#10b981]">
            <CheckCircle2 className="size-3.5 shrink-0" />
            <span>
              Authenticated as <strong>{connectedUser}</strong>
            </span>
          </div>
        ) : null}

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-[#8b909a]">
              API ID
            </label>
            <Input
              type="text"
              value={apiIdInput}
              onChange={(e) => setApiIdInput(e.target.value)}
              placeholder="e.g. 12345678"
              className="obsidian-input h-8.5 font-mono text-xs"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-[#8b909a]">
              API Hash
            </label>
            <Input
              type="text"
              value={apiHashInput}
              onChange={(e) => setApiHashInput(e.target.value)}
              placeholder="0123456789abcdef0123456789abcdef"
              className="obsidian-input h-8.5 font-mono text-xs"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-[#8b909a]">
              Telethon StringSession
            </label>
            <Input
              type="password"
              value={sessionInput}
              onChange={(e) => setSessionInput(e.target.value)}
              placeholder={
                tgSettings.isConfigured
                  ? "Configured (leave blank to retain)"
                  : "1BJWb... session string"
              }
              className="obsidian-input h-8.5 font-mono text-xs"
            />
          </div>
        </div>
      </section>

      {/* Configured Channels Ledger */}
      <section className="obsidian-panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Tv className="size-4 text-[#8b909a]" />
            <h2 className="text-sm font-semibold text-[#f3f4f6]">
              Target Channels
            </h2>
            <span className="obsidian-pill font-mono text-[10px]">
              {channels.length}
            </span>
          </div>

          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={openCreateDialog}
            className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-3 text-xs text-[#e5e7eb] hover:bg-white/[0.05]"
          >
            <Plus className="size-3.5" />
            Add Channel
          </Button>
        </div>

        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-white/[0.06] bg-[#101216]/70 text-[11px] font-medium text-[#8b909a]">
                <th className="py-2.5 px-4 font-medium">Channel Name</th>
                <th className="py-2.5 px-4 font-medium">
                  Channel ID / Handle
                </th>
                <th className="py-2.5 px-4 font-medium">Extractor</th>
                <th className="py-2.5 px-4 font-medium">Added</th>
                <th className="py-2.5 px-4 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {!isLoadingChannels &&
                channels.map((c) => (
                  <tr
                    key={c.id}
                    className="transition-colors hover:bg-white/[0.02]"
                  >
                    <td className="max-w-[240px] py-3 px-4 font-medium text-[#f3f4f6]">
                      <span className="block truncate" title={c.name}>
                        {c.name}
                      </span>
                    </td>
                    <td className="max-w-[240px] py-3 px-4 font-mono text-xs text-[#8b909a]">
                      <span className="block truncate" title={c.channelId}>
                        {c.channelId}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="obsidian-pill gap-1 font-mono text-[10px]">
                        <Code2 className="size-3" />
                        Python Script
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-[#6b707b]">
                      {new Date(c.createdAt).toISOString().slice(0, 10)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => openEditDialog(c)}
                          title="Edit channel & script"
                          className="h-7 w-7 p-0 text-[#8b909a] hover:text-white"
                        >
                          <Edit2 className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => void handleDeleteChannel(c.id)}
                          title="Delete channel"
                          className="h-7 w-7 p-0 text-[#8b909a] hover:text-[#f43f5e]"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>

          {isLoadingChannels ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-[#8b909a]">
              <Loader2 className="size-4 animate-spin" />
              Loading channels…
            </div>
          ) : channels.length === 0 ? (
            <div className="py-10 text-center text-xs text-[#6b707b]">
              No channels configured yet. Click &ldquo;Add Channel&rdquo; to register a source.
            </div>
          ) : null}
        </div>
      </section>

      <Dialog open={isChannelDialogOpen} onOpenChange={setIsChannelDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto rounded-xl border border-white/[0.08] bg-[#0b0c0e] p-5 text-[#f3f4f6] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold text-[#f3f4f6]">
              {editingChannel
                ? `Edit Channel: ${editingChannel.name}`
                : "Add Telegram Channel"}
            </DialogTitle>
            <DialogDescription className="text-xs text-[#8b909a]">
              Configure channel target and custom Python password extraction rules.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-1">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-[#8b909a]">
                  Channel Name
                </label>
                <Input
                  type="text"
                  value={channelName}
                  onChange={(e) => setChannelName(e.target.value)}
                  placeholder="e.g. Hunter Cloud Logs"
                  className="obsidian-input h-8 text-xs"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-[#8b909a]">
                  Channel ID (or @username / link)
                </label>
                <Input
                  type="text"
                  value={channelTargetId}
                  onChange={(e) => setChannelTargetId(e.target.value)}
                  placeholder="e.g. -1001234567890 or @channel_name"
                  className="obsidian-input h-8 font-mono text-xs"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1 text-[11px] font-medium text-[#8b909a]">
                  <Code2 className="size-3" /> Password Extraction Script (Python)
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setChannelScript(SAMPLE_PASSWORD_SCRIPT)}
                  className="h-6 text-[10px] text-[#6b707b] hover:text-[#e5e7eb]"
                >
                  Reset Template
                </Button>
              </div>
              <textarea
                rows={9}
                value={channelScript}
                onChange={(e) => setChannelScript(e.target.value)}
                className="obsidian-input w-full p-3 font-mono text-xs"
              />
            </div>

            <div className="obsidian-subpanel flex flex-col gap-2 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-[#8b909a]">
                  Live Script Sandbox
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void handleTestScriptLive()}
                  disabled={isTestingScript}
                  className="h-7 gap-1 rounded-md border-white/[0.08] bg-[#0b0c0e] text-[11px]"
                >
                  {isTestingScript ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Send className="size-3" />
                  )}
                  Run Test
                </Button>
              </div>

              <textarea
                rows={3}
                value={testMessageText}
                onChange={(e) => setTestMessageText(e.target.value)}
                placeholder="Paste Telegram message caption here…"
                className="obsidian-input w-full p-2 font-mono text-[11px]"
              />

              {testScriptResult !== null ? (
                <div className="flex items-center gap-2 pt-1 text-xs">
                  <span className="text-[#8b909a]">Resolved Password:</span>
                  <Badge
                    variant="secondary"
                    className="font-mono text-xs text-[#10b981]"
                  >
                    {testScriptResult}
                  </Badge>
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] pt-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIsChannelDialogOpen(false)}
                className="h-8 text-xs text-[#8b909a]"
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSaveChannel()}
                disabled={isSavingChannel}
                className="h-8 gap-1.5 bg-[#f3f4f6] text-xs font-medium text-[#050506] hover:bg-white"
              >
                <Save className="size-3.5" />
                {isSavingChannel ? "Saving…" : "Save Channel"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
