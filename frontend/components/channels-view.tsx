"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Code2,
  Edit2,
  Key,
  Loader2,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Send,
  Trash2,
  Tv,
} from "lucide-react";
import { Icon3D, SpringCounter } from "@/components/kinetics-ui";
import { MotionSurface } from "@/components/motion-surface";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { cn } from "@/lib/utils";

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

  // UserBot settings state
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

  // Channel Add/Edit dialog state
  const [isChannelDialogOpen, setIsChannelDialogOpen] = useState(false);
  const [editingChannel, setEditingChannel] =
    useState<TelegramChannelItem | null>(null);
  const [channelName, setChannelName] = useState("");
  const [channelTargetId, setChannelTargetId] = useState("");
  const [channelScript, setChannelScript] = useState(SAMPLE_PASSWORD_SCRIPT);
  const [isSavingChannel, setIsSavingChannel] = useState(false);

  // Script test state
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
    void loadData();
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
        toast.error(!res.ok ? (res.error?.message ?? "Connection failed.") : (res.data?.message ?? "Connection failed."));
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
    let res;
    if (editingChannel) {
      res = await browserUpdateChannel(editingChannel.id, {
        name: channelName.trim(),
        channelId: channelTargetId.trim(),
        passwordScript: channelScript,
      });
    } else {
      res = await browserCreateChannel({
        name: channelName.trim(),
        channelId: channelTargetId.trim(),
        passwordScript: channelScript,
      });
    }
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
      toast.error(!res.ok ? (res.error?.message ?? "Script execution error.") : (res.data?.message ?? "Script execution error."));
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-6 spring-enter">
      {/* SpinupMail 3-Card Telemetry Strip */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MotionSurface busy={isSavingSettings || isTestingConnection}>
          <div className="spinup-card flex flex-col justify-between p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-neutral-400">
                <Radio className="size-4 text-neutral-400" />
                <span>Monitored Channels</span>
              </div>
              <span className="spinup-pill">MTProto 2.0</span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums tracking-tight text-white">
                <SpringCounter value={channels.length} />
              </span>
              <span className="text-xs text-neutral-500">targets</span>
            </div>
          </div>
        </MotionSurface>

        <MotionSurface>
          <div className="spinup-card flex flex-col justify-between p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-neutral-400">
                <Bot className="size-4 text-neutral-400" />
                <span>UserBot Status</span>
              </div>
              <span className="spinup-pill">Telethon</span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              {connectionStatus === "connected" ? (
                <span className="spinup-badge-active inline-flex items-center gap-1.5 text-sm">
                  <span className="size-2 rounded-full bg-[#00ba7c]" />
                  Online
                </span>
              ) : tgSettings.isConfigured ? (
                <span className="spinup-badge-active inline-flex items-center gap-1.5 text-sm">
                  <Bot className="size-3.5 text-neutral-400" />
                  Configured
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#f91880]/30 bg-[#f91880]/10 px-3 py-1 text-xs font-medium text-[#f91880]">
                  Not Configured
                </span>
              )}
            </div>
          </div>
        </MotionSurface>

        <MotionSurface>
          <div className="spinup-card flex flex-col justify-between p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-neutral-400">
                <Code2 className="size-4 text-neutral-400" />
                <span>Password Resolver</span>
              </div>
              <span className="spinup-pill">Auto-Unlock</span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="font-mono text-xl font-semibold tracking-tight text-white">
                Custom Python
              </span>
            </div>
          </div>
        </MotionSurface>
      </section>

      {/* Global Telethon UserBot Credentials Card */}
      <section className="spinup-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] pb-3.5">
          <div className="flex min-w-0 items-start gap-2.5">
            <Bot className="mt-0.5 size-4 shrink-0 text-neutral-400" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white">
                Telethon UserBot Credentials
              </p>
              <p className="mt-0.5 text-xs text-neutral-500">
                Obtain API ID and API Hash from my.telegram.org. Session string connects without interactive prompts.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleTestConnection}
              disabled={isTestingConnection || !tgSettings.isConfigured}
              className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#0e0f11] text-neutral-200 hover:bg-white/[0.04]"
            >
              {isTestingConnection ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Radio className="size-3.5 text-[#00ba7c]" />
              )}
              {isTestingConnection ? "Checking…" : "Check Connection"}
            </Button>
            <Button
              type="button"
              variant="default"
              size="xs"
              onClick={handleSaveSettings}
              disabled={isSavingSettings}
              className="motion-sheen h-8 gap-1.5 rounded-lg"
            >
              <Save className="size-3.5" />
              {isSavingSettings ? "Saving…" : "Save Credentials"}
            </Button>
          </div>
        </div>

        {connectedUser ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-[rgba(0,186,124,0.3)] bg-[rgba(0,186,124,0.06)] px-3 py-2 text-xs text-[#00ba7c]">
            <CheckCircle2 className="size-4 shrink-0" />
            <span>Successfully connected as <strong>{connectedUser}</strong></span>
          </div>
        ) : null}

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-neutral-400">
              API ID (Integer)
            </label>
            <Input
              type="text"
              value={apiIdInput}
              onChange={(e) => setApiIdInput(e.target.value)}
              placeholder="e.g. 12345678"
              className="spinup-input h-9 font-mono text-xs"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-neutral-400">
              API Hash (String)
            </label>
            <Input
              type="text"
              value={apiHashInput}
              onChange={(e) => setApiHashInput(e.target.value)}
              placeholder="e.g. 0123456789abcdef0123456789abcdef"
              className="spinup-input h-9 font-mono text-xs"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-neutral-400">
              Telethon StringSession (User account)
            </label>
            <Input
              type="password"
              value={sessionInput}
              onChange={(e) => setSessionInput(e.target.value)}
              placeholder={
                tgSettings.isConfigured
                  ? "Configured (leave blank to keep current)"
                  : "1BJWb... string session"
              }
              className="spinup-input h-9 font-mono text-xs"
            />
          </div>
        </div>
      </section>

      {/* Channels List Section */}
      <section className="spinup-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Tv className="size-4 shrink-0 text-neutral-400" />
            <h2 className="text-sm font-semibold tracking-tight text-white">
              Configured Target Channels
            </h2>
            <span className="spinup-pill">{channels.length}</span>
          </div>

          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={openCreateDialog}
            className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#0e0f11] text-neutral-200 hover:bg-white/[0.04]"
          >
            <Plus className="size-3.5" />
            Add Channel
          </Button>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-white/[0.06] bg-[#0e0f11]/60 hover:bg-transparent">
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400">Channel Name</TableHead>
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400">Channel ID / Username</TableHead>
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400">Password Script</TableHead>
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400">Added Date</TableHead>
                <TableHead className="py-3 px-4 text-right text-xs font-medium text-neutral-400">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!isLoadingChannels && channels.map((c) => (
                <TableRow key={c.id} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                  <TableCell className="py-3.5 px-4 max-w-[240px] font-medium text-xs text-white">
                    <span className="block truncate" title={c.name}>{c.name}</span>
                  </TableCell>
                  <TableCell className="py-3.5 px-4 max-w-[240px] font-mono text-xs text-neutral-400">
                    <span className="block truncate" title={c.channelId}>{c.channelId}</span>
                  </TableCell>
                  <TableCell className="py-3.5 px-4">
                    <span className="spinup-pill inline-flex items-center gap-1 font-mono text-[10px]">
                      <Code2 className="size-3" />
                      Custom Script
                    </span>
                  </TableCell>
                  <TableCell className="py-3.5 px-4 font-mono text-xs text-neutral-500">
                    {new Date(c.createdAt).toISOString().slice(0, 10)}
                  </TableCell>
                  <TableCell className="py-3.5 px-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => openEditDialog(c)}
                        title="Edit channel & script"
                        className="text-neutral-400 hover:text-white"
                      >
                        <Edit2 className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => void handleDeleteChannel(c.id)}
                        title="Delete channel"
                        className="text-neutral-400 hover:text-[#f91880]"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {isLoadingChannels ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-center text-xs text-neutral-400">
              <Loader2 className="size-4 animate-spin" />
              Loading channels…
            </div>
          ) : channels.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-neutral-500">
              No channels added yet. Click &quot;Add Channel&quot; above to configure one.
            </div>
          ) : null}
        </div>
      </section>
      <Dialog open={isChannelDialogOpen} onOpenChange={setIsChannelDialogOpen}>
        <DialogContent className="border-[rgba(255,255,255,0.08)] bg-[#0f1011] text-[#f7f8f8] sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="break-words pr-6 text-base text-[#ffffff]">
              {editingChannel ? `Edit Channel: ${editingChannel.name}` : "Add Telegram Channel"}
            </DialogTitle>
            <DialogDescription className="text-xs text-[#8a8f98]">
              Configure channel target and custom Python password extraction script.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-[#8a8f98]">
                  Channel Name
                </label>
                <Input
                  type="text"
                  value={channelName}
                  onChange={(e) => setChannelName(e.target.value)}
                  placeholder="e.g. Hunter Cloud Logs"
                  className="h-8 text-xs"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-[#8a8f98]">
                  Channel ID (or @username / link)
                </label>
                <Input
                  type="text"
                  value={channelTargetId}
                  onChange={(e) => setChannelTargetId(e.target.value)}
                  placeholder="e.g. -1001234567890 or @channel_name"
                  className="h-8 font-mono text-xs"
                />
              </div>
            </div>

            {/* Password script editor */}
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-[11px] font-medium text-[#8a8f98] flex items-center gap-1">
                  <Code2 className="size-3 shrink-0" /> Password Script (Python Implementation)
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setChannelScript(SAMPLE_PASSWORD_SCRIPT)}
                  className="text-[10px] text-[#62666d] hover:text-[#d0d6e0]"
                >
                  Reset to Template
                </Button>
              </div>
              <textarea
                rows={9}
                value={channelScript}
                onChange={(e) => setChannelScript(e.target.value)}
                className="w-full rounded-[6px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] p-3 font-mono text-xs text-[#d0d6e0] outline-none focus:border-[rgba(255,255,255,0.2)]"
              />
            </div>

            {/* Interactive Test Script Panel */}
            <div className="rounded-[6px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] p-3 flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-[#8a8f98]">
                  Test Script on Sample Message Content
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={handleTestScriptLive}
                  disabled={isTestingScript}
                  className="gap-1 text-[11px]"
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
                className="w-full rounded-[4px] border border-[rgba(255,255,255,0.06)] bg-[#08090a] p-2 font-mono text-[11px] text-[#d0d6e0] outline-none"
              />

              {testScriptResult !== null ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1 text-xs">
                  <span className="text-[#8a8f98]">Resolved Password:</span>
                  <Badge variant="secondary" className="max-w-full whitespace-normal break-all font-mono text-xs text-[#00ba7c]">
                    {testScriptResult}
                  </Badge>
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-[rgba(255,255,255,0.05)]">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIsChannelDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={handleSaveChannel}
                disabled={isSavingChannel}
                className="gap-1.5"
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
