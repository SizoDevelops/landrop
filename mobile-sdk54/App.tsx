import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Path, Rect } from "react-native-svg";
import {
  useFonts,
  JetBrainsMono_400Regular,
  JetBrainsMono_700Bold,
} from "@expo-google-fonts/jetbrains-mono";

const TOP_INSET = Platform.OS === "android" ? RNStatusBar.currentHeight ?? 24 : 47;
const BOTTOM_INSET = Platform.OS === "android" ? 10 : 24;
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import { File as FsFile } from "expo-file-system";
import * as Network from "expo-network";

const URL_KEY = "dropt.serverUrl";
const HISTORY_KEY = "dropt.history";

type Tab = "files" | "downloads" | "settings";
type XferStatus = "active" | "paused" | "error";
type XferDir = "up" | "down";

type Transfer = {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: XferStatus;
  dir: XferDir;
  speed?: number;
  chunked?: boolean;
};
type HistoryItem = {
  id: string;
  name: string;
  size: number;
  completedAt: number;
  dir: XferDir;
  uri?: string;
  failed?: boolean;
};
type RemoteFile = { name: string; size: number };

// Palette from the Dropt brand spec (brand-assets.html). The spec uses
// oklch tokens (hue 250 cool-gray surfaces, hue 145 green accent); these are
// the sRGB-hex equivalents since React Native can't parse oklch().
const c = {
  bg: "#0a0c0e",
  surface: "#121519",
  surface2: "#191d22",
  border: "#2b2f35",
  borderGreen: "#3a6542",
  text: "#e7eae7",
  muted: "#6a7079",
  faint: "#565b62",
  green: "#2faf5f",
  greenDim: "#143619",
  greenText: "#46c46f",
  err: "#d24b43",
};

// Technical text (IPs, file sizes, speeds, timestamps) uses JetBrains Mono per
// the brand spec; display/body text uses the platform system font (SF Pro on
// iOS, Roboto on Android), which is the spec's display stack.
const MONO = "JetBrainsMono_400Regular";
const MONO_BOLD = "JetBrainsMono_700Bold";

// The brand icon mark: file bars with a green download arrow on a rounded
// surface tile (the "icon only" lockup from the spec).
function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Rect x={6} y={6} width={88} height={88} rx={22} fill={c.surface} stroke={c.border} strokeWidth={1} />
      <Rect x={30} y={25} width={40} height={5} rx={2.5} fill={c.green} opacity={0.35} />
      <Rect x={34} y={35} width={32} height={5} rx={2.5} fill={c.green} opacity={0.5} />
      <Rect x={42} y={36} width={16} height={28} rx={4} fill={c.green} />
      <Path d="M22 56 L50 80 L78 56" stroke={c.green} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

function fmtBytes(n: number): string {
  if (!n || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fmtRemaining(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "calculating…";
  const m = Math.floor(sec / 60);
  const s = Math.ceil(sec % 60);
  if (m >= 60) return `${Math.floor(m / 60)} hr ${m % 60} min remaining`;
  if (m > 0) return `${m} min ${s} sec remaining`;
  return `${s} sec remaining`;
}
function timeAgo(ts: number): string {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return `${h} hour${h > 1 ? "s" : ""} ago`;
  }
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diff < 172800) return `yesterday at ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}
function normalizeUrl(raw: string): string | null {
  let u = raw.trim().replace(/\/+$/, "");
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = `http://${u.replace(/^\/+/, "")}`;
  try {
    const p = new URL(u);
    if (!p.hostname) return null;
    return u;
  } catch {
    return null;
  }
}
function hostLabel(u: string | null): string {
  if (!u) return "—";
  try {
    const p = new URL(u);
    return p.port ? `${p.hostname}:${p.port}` : p.hostname;
  } catch {
    return u;
  }
}

// The PC server listens on 8000 by default and answers GET /ping with a JSON
// signature. Auto-detect probes the local /24 subnet for that signature.
const SCAN_PORT = 8000;

// Probe one host. Resolves to its base URL on a Dropt /ping match, else null.
// Aborts on its own timeout, or when `outer` aborts (a peer already found the
// server) so the whole scan stops the instant there's a hit.
async function probeHost(ip: string, outer: AbortSignal): Promise<string | null> {
  if (outer.aborted) return null;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  outer.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`http://${ip}:${SCAN_PORT}/ping`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    // Accept the legacy "landrop" signature too so a current phone still finds
    // older desktop builds (and rebrands don't break discovery again).
    return j && (j.app === "dropt" || j.app === "landrop") ? `http://${ip}:${SCAN_PORT}` : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    outer.removeEventListener("abort", onAbort);
  }
}

// Find the PC server on the current wifi subnet. Assumes a /24 mask (true for
// virtually all home/office wifi). Scans .1–.254 in batches and returns the
// first host that answers the Dropt signature.
async function scanForServer(): Promise<string | null> {
  const ip = await Network.getIpAddressAsync();
  const parts = ip?.split(".");
  if (!parts || parts.length !== 4 || ip === "0.0.0.0") return null;
  const base = `${parts[0]}.${parts[1]}.${parts[2]}.`;
  const self = parseInt(parts[3], 10);
  const hosts: number[] = [];
  for (let i = 1; i <= 254; i++) if (i !== self) hosts.push(i);
  const outer = new AbortController();
  const BATCH = 40;
  try {
    for (let b = 0; b < hosts.length; b += BATCH) {
      const slice = hosts.slice(b, b + BATCH);
      const results = await Promise.all(slice.map((i) => probeHost(`${base}${i}`, outer.signal)));
      const hit = results.find((r): r is string => !!r);
      if (hit) return hit;
    }
    return null;
  } finally {
    outer.abort();
  }
}

export default function App() {
  const [fontsLoaded] = useFonts({ JetBrainsMono_400Regular, JetBrainsMono_700Bold });
  const [tab, setTab] = useState<Tab>("files");
  const [inputUrl, setInputUrl] = useState("");
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const resumables = useRef<Map<string, any>>(new Map());
  const finished = useRef<Set<string>>(new Set());
  const busyNames = useRef<Set<string>>(new Set());
  const pausedIds = useRef<Set<string>>(new Set());
  const transfersRef = useRef<Transfer[]>([]);

  // Auto-detect the PC on the LAN, fill in the URL, and persist it. Returns
  // true on success. Used on first launch and from the manual "Auto-detect"
  // buttons; `silent` suppresses the not-found alert (for the launch attempt).
  async function handleAutoDetect(silent = false): Promise<boolean> {
    if (scanning) return false;
    setScanning(true);
    try {
      const found = await scanForServer();
      if (found) {
        await AsyncStorage.setItem(URL_KEY, found);
        setServerUrl(found);
        setInputUrl(found);
        setEditing(false);
        setTab("files");
        return true;
      }
      if (!silent) {
        Alert.alert(
          "No server found",
          "Couldn't find a Dropt PC on this wifi. Make sure the desktop app is running and your phone is on the same network — or enter the address manually."
        );
      }
      return false;
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    AsyncStorage.getItem(URL_KEY).then((u) => {
      if (u) {
        setServerUrl(u);
        setInputUrl(u);
      } else {
        setInputUrl("http://");
        setTab("settings");
        setEditing(true);
        // First launch with no saved server: try to find it automatically.
        handleAutoDetect(true);
      }
    });
    AsyncStorage.getItem(HISTORY_KEY).then((j) => {
      if (j) {
        try {
          setHistory(JSON.parse(j));
        } catch {}
      }
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!serverUrl) return;
    setRefreshing(true);
    try {
      const res = await fetch(`${serverUrl}/files`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFiles((await res.json()) as RemoteFile[]);
      setConnected(true);
    } catch {
      setConnected(false);
    } finally {
      setRefreshing(false);
    }
  }, [serverUrl]);

  useEffect(() => {
    if (serverUrl) refresh();
  }, [serverUrl, refresh]);

  useEffect(() => {
    transfersRef.current = transfers;
  }, [transfers]);

  const patch = useCallback(
    (id: string, p: Partial<Transfer>) =>
      setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, ...p } : t))),
    []
  );

  const pushHistory = useCallback((item: HistoryItem) => {
    setHistory((prev) => {
      const next = [item, ...prev].slice(0, 100);
      AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  function clearHistory() {
    setHistory([]);
    AsyncStorage.removeItem(HISTORY_KEY).catch(() => {});
  }
  function removeHistory(id: string) {
    setHistory((prev) => {
      const next = prev.filter((h) => h.id !== id);
      AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }
  // A transfer ended badly → drop it from "in progress" and log it in History
  // as FAILED so it's visible and clearable.
  function failTransfer(id: string, name: string, dir: XferDir) {
    if (finished.current.has(id)) return;
    finished.current.add(id);
    busyNames.current.delete(name);
    resumables.current.delete(id);
    pausedIds.current.delete(id);
    const t = transfersRef.current.find((x) => x.id === id);
    pushHistory({ id, name, size: t?.size ?? 0, completedAt: Date.now(), dir, failed: true });
    setTransfers((prev) => prev.filter((x) => x.id !== id));
  }

  async function saveServerUrl() {
    const u = normalizeUrl(inputUrl);
    if (!u) {
      Alert.alert("Invalid URL", "Use something like http://192.168.1.5:8000");
      return;
    }
    await AsyncStorage.setItem(URL_KEY, u);
    setServerUrl(u);
    setInputUrl(u);
    setEditing(false);
    setTab("files");
  }

  // ---- Uploads (phone -> PC) ----
  async function pickAndUpload() {
    if (!serverUrl) return;
    const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (r.canceled) return;
    setTab("downloads");
    for (const asset of r.assets) uploadAsset(asset);
  }

  function uploadAsset(asset: DocumentPicker.DocumentPickerAsset) {
    if (!serverUrl) return;
    const id = `up-${Date.now()}-${asset.name}`;
    setTransfers((prev) => [
      { id, name: asset.name, size: asset.size ?? 0, progress: 0, status: "active", dir: "up" },
      ...prev,
    ]);
    const startedAt = Date.now();
    let lastUi = 0;
    const task = FileSystem.createUploadTask(
      `${serverUrl}/upload`,
      asset.uri,
      {
        httpMethod: "POST",
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { "X-Filename": encodeURIComponent(asset.name) },
      },
      ({ totalBytesSent, totalBytesExpectedToSend }) => {
        if (totalBytesExpectedToSend <= 0) return;
        const now = Date.now();
        const done = totalBytesSent >= totalBytesExpectedToSend;
        if (!done && now - lastUi < 200) return;
        lastUi = now;
        const elapsed = (now - startedAt) / 1000;
        patch(id, {
          progress: totalBytesSent / totalBytesExpectedToSend,
          size: totalBytesExpectedToSend,
          speed: elapsed > 0.3 ? totalBytesSent / elapsed : undefined,
        });
      }
    );
    task
      .uploadAsync()
      .then((res) => {
        const ok = !!res && res.status >= 200 && res.status < 300;
        if (ok) {
          if (finished.current.has(id)) return;
          finished.current.add(id);
          const t = transfersRef.current.find((x) => x.id === id);
          pushHistory({ id, name: asset.name, size: t?.size ?? asset.size ?? 0, completedAt: Date.now(), dir: "up" });
          setTransfers((prev) => prev.filter((x) => x.id !== id));
          refresh();
        } else {
          failTransfer(id, asset.name, "up");
        }
      })
      .catch(() => failTransfer(id, asset.name, "up"));
  }

  // ---- Downloads (PC -> phone) ----
  const CHUNK_THRESHOLD = 16 * 1024 * 1024; // chunk files larger than this
  const CHUNKS = 8;
  // Parallel chunking helps on lossy/high-latency links but hurts on a slow,
  // constrained AP (streams contend + OkHttp queuing + reassembly overhead).
  // Single stream is faster here, so chunking is disabled.
  const CHUNKING_ENABLED = false;

  function startDownload(name: string, size: number) {
    if (!serverUrl || busyNames.current.has(name)) return;
    busyNames.current.add(name);
    const id = `dl-${Date.now()}-${name}`;
    const chunked = CHUNKING_ENABLED && size > CHUNK_THRESHOLD;
    setTransfers((prev) => [{ id, name, size, progress: 0, status: "active", dir: "down", chunked }, ...prev]);
    setTab("downloads");
    const cacheDir = `${FileSystem.cacheDirectory ?? ""}dropt/`;
    const finalUri = cacheDir + name;
    if (chunked) chunkedDownload(id, name, size, cacheDir, finalUri);
    else singleDownload(id, name, cacheDir, finalUri);
  }

  // Small files: one streaming download (pausable).
  function singleDownload(id: string, name: string, cacheDir: string, finalUri: string) {
    const startedAt = Date.now();
    let lastUi = 0;
    (async () => {
      await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true }).catch(() => {});
      await FileSystem.deleteAsync(finalUri, { idempotent: true }).catch(() => {});
      const dl = FileSystem.createDownloadResumable(
        `${serverUrl}/files/${encodeURIComponent(name)}`,
        finalUri,
        {},
        (p) => {
          if (p.totalBytesExpectedToWrite <= 0) return;
          const now = Date.now();
          const done = p.totalBytesWritten >= p.totalBytesExpectedToWrite;
          if (!done && now - lastUi < 200) return;
          lastUi = now;
          const elapsed = (now - startedAt) / 1000;
          patch(id, {
            progress: p.totalBytesWritten / p.totalBytesExpectedToWrite,
            size: p.totalBytesExpectedToWrite,
            speed: elapsed > 0.3 ? p.totalBytesWritten / elapsed : undefined,
          });
        }
      );
      resumables.current.set(id, dl);
      dl.downloadAsync()
        .then((res) => onDownloadDone(id, name, res))
        .catch(() => {
          if (!pausedIds.current.has(id)) failTransfer(id, name, "down");
        });
    })();
  }

  // Large files: N parallel ranged downloads → reassemble. Much faster on wifi.
  async function chunkedDownload(id: string, name: string, size: number, cacheDir: string, finalUri: string) {
    const N = CHUNKS;
    const startedAt = Date.now();
    let lastUi = 0;
    const chunkWritten = new Array(N).fill(0);
    const partUris: string[] = [];
    try {
      await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true }).catch(() => {});
      const chunkSize = Math.ceil(size / N);
      const tasks: Promise<any>[] = [];
      for (let i = 0; i < N; i++) {
        const start = i * chunkSize;
        if (start >= size) break;
        const end = Math.min(size - 1, start + chunkSize - 1);
        const partUri = `${cacheDir}${name}.part${i}`;
        partUris.push(partUri);
        await FileSystem.deleteAsync(partUri, { idempotent: true }).catch(() => {});
        const idx = i;
        const dl = FileSystem.createDownloadResumable(
          `${serverUrl}/files/${encodeURIComponent(name)}`,
          partUri,
          { headers: { Range: `bytes=${start}-${end}` } },
          (p) => {
            chunkWritten[idx] = p.totalBytesWritten;
            const now = Date.now();
            if (now - lastUi < 150) return;
            lastUi = now;
            const written = chunkWritten.reduce((a, b) => a + b, 0);
            const elapsed = (now - startedAt) / 1000;
            patch(id, {
              progress: Math.min(written / size, 0.999),
              size,
              speed: elapsed > 0.3 ? written / elapsed : undefined,
            });
          }
        );
        tasks.push(dl.downloadAsync());
      }
      const results = await Promise.all(tasks);
      if (!results.every((r) => r && r.status >= 200 && r.status < 300)) throw new Error("chunk failed");
      patch(id, { progress: 1, speed: undefined });
      // Stitch parts into the final file in 4MB blocks (never holds a whole chunk in memory).
      reassembleParts(partUris, finalUri);
      let finalSize = 0;
      try {
        const info = await FileSystem.getInfoAsync(finalUri);
        if (info.exists) finalSize = (info as any).size ?? 0;
      } catch {}
      if (finalSize !== size) throw new Error("size mismatch");
      if (finished.current.has(id)) return;
      finished.current.add(id);
      busyNames.current.delete(name);
      pushHistory({ id, name, size: finalSize, completedAt: Date.now(), dir: "down", uri: finalUri });
      setTransfers((prev) => prev.filter((t) => t.id !== id));
    } catch {
      for (const pu of partUris) await FileSystem.deleteAsync(pu, { idempotent: true }).catch(() => {});
      failTransfer(id, name, "down");
    }
  }

  function reassembleParts(partUris: string[], finalUri: string) {
    const final = new FsFile(finalUri);
    try {
      if (final.exists) final.delete();
    } catch {}
    final.create();
    const out = final.open();
    try {
      const BLOCK = 4 * 1024 * 1024;
      for (const pu of partUris) {
        const pf = new FsFile(pu);
        const h = pf.open();
        try {
          h.offset = 0;
          while (true) {
            const b = h.readBytes(BLOCK);
            if (!b || b.length === 0) break;
            out.writeBytes(b);
          }
        } finally {
          h.close();
        }
        try {
          pf.delete();
        } catch {}
      }
    } finally {
      out.close();
    }
  }

  async function onDownloadDone(id: string, name: string, res: any) {
    if (finished.current.has(id)) return;
    if (!res || res.status < 200 || res.status >= 300) {
      failTransfer(id, name, "down");
      return;
    }
    finished.current.add(id);
    resumables.current.delete(id);
    busyNames.current.delete(name);
    pausedIds.current.delete(id);
    let size = 0;
    try {
      const info = await FileSystem.getInfoAsync(res.uri);
      if (info.exists) size = (info as any).size ?? 0;
    } catch {}
    pushHistory({ id, name, size, completedAt: Date.now(), dir: "down", uri: res.uri });
    setTransfers((prev) => prev.filter((t) => t.id !== id));
  }

  function pauseDownload(id: string) {
    const dl = resumables.current.get(id);
    if (!dl) return;
    pausedIds.current.add(id);
    dl.pauseAsync().catch(() => {});
    patch(id, { status: "paused" });
  }
  function resumeDownload(id: string, name: string) {
    const dl = resumables.current.get(id);
    if (!dl) return;
    pausedIds.current.delete(id);
    patch(id, { status: "active" });
    dl.resumeAsync()
      .then((res: any) => onDownloadDone(id, name, res))
      .catch(() => {
        if (!pausedIds.current.has(id)) failTransfer(id, name, "down");
      });
  }

  async function openHistoryItem(item: HistoryItem) {
    if (item.dir !== "down" || !item.uri) return;
    try {
      const info = await FileSystem.getInfoAsync(item.uri);
      if (info.exists && (await Sharing.isAvailableAsync())) {
        await Sharing.shareAsync(item.uri, { dialogTitle: item.name });
      } else {
        startDownload(item.name, item.size);
      }
    } catch {
      startDownload(item.name, item.size);
    }
  }

  function confirmDelete(name: string) {
    Alert.alert("Delete?", `Remove "${name}" from the PC?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          if (!serverUrl) return;
          try {
            const res = await fetch(`${serverUrl}/files/${encodeURIComponent(name)}`, { method: "DELETE" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            refresh();
          } catch (e) {
            Alert.alert("Delete failed", e instanceof Error ? e.message : String(e));
          }
        },
      },
    ]);
  }

  const inProgress = transfers;
  const filtered = files.filter((f) => f.name.toLowerCase().includes(search.toLowerCase()));
  const downloadsCount = inProgress.length + history.length;

  // Hold on the dark background until JetBrains Mono is ready so technical text
  // doesn't flash in a fallback face.
  if (!fontsLoaded) return <View style={s.safe} />;

  return (
    <View style={s.safe}>
      <StatusBar style="light" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          contentContainerStyle={[s.scroll, { paddingTop: TOP_INSET + 14 }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            tab !== "settings" ? (
              <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.text} colors={[c.green]} />
            ) : undefined
          }
        >
          {/* Header */}
          <View style={s.header}>
            <View style={s.brandRow}>
              <LogoMark size={30} />
              <Text style={s.title}>
                <Text style={s.titleAccent}>Drop</Text>t Mobile
              </Text>
            </View>
            <View style={s.row}>
              <View style={[s.statusDot, { backgroundColor: connected ? c.green : c.faint }]} />
              <Text style={[s.statusTxt, { color: connected ? c.greenText : c.faint }]}>
                {connected === null ? "…" : connected ? "Connected" : "Offline"}
              </Text>
            </View>
          </View>

          {tab !== "settings" && (
            <>
              {/* Server card */}
              <View style={s.serverCard}>
                <View style={{ flex: 1 }}>
                  <Text style={s.serverIp}>{hostLabel(serverUrl)}</Text>
                  <Text style={s.serverSub}>Shared files over wifi</Text>
                </View>
                <View style={[s.pill, connected ? s.pillOn : s.pillOff]}>
                  <Text style={[s.pillTxt, { color: connected ? c.greenText : c.faint }]}>
                    {connected ? "Online" : "Offline"}
                  </Text>
                </View>
              </View>

              {/* Search */}
              <View style={s.searchBox}>
                <Ionicons name="search" size={16} color={c.faint} />
                <TextInput
                  style={s.searchInput}
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search files…"
                  placeholderTextColor={c.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              {/* Sub-tabs */}
              <View style={s.subTabs}>
                <Pressable style={s.subTab} onPress={() => setTab("files")}>
                  <Text style={[s.subTabTxt, tab === "files" && s.subTabActive]}>Files</Text>
                  <View style={s.badge}><Text style={s.badgeTxt}>{files.length}</Text></View>
                  {tab === "files" && <View style={s.subTabUnderline} />}
                </Pressable>
                <Pressable style={s.subTab} onPress={() => setTab("downloads")}>
                  <Text style={[s.subTabTxt, tab === "downloads" && s.subTabActive]}>Downloads</Text>
                  <View style={s.badge}><Text style={s.badgeTxt}>{downloadsCount}</Text></View>
                  {tab === "downloads" && <View style={s.subTabUnderline} />}
                </Pressable>
              </View>
            </>
          )}

          {/* FILES TAB */}
          {tab === "files" && (
            <View style={{ marginTop: 6 }}>
              <Pressable
                onPress={pickAndUpload}
                disabled={!serverUrl}
                style={({ pressed }) => [s.sendBtn, !serverUrl && { opacity: 0.5 }, pressed && s.pressed]}
              >
                <Ionicons name="arrow-up-circle-outline" size={18} color={c.greenText} />
                <Text style={s.sendBtnTxt}>Send files to PC</Text>
              </Pressable>

              {!serverUrl ? (
                <Text style={s.empty}>Set the server URL in Settings to begin.</Text>
              ) : connected === false ? (
                <View>
                  <Text style={s.empty}>Can’t reach the server. Same wifi & server running?</Text>
                  <Pressable
                    onPress={() => handleAutoDetect()}
                    disabled={scanning}
                    style={({ pressed }) => [s.detectBtn, scanning && { opacity: 0.6 }, pressed && s.pressed]}
                  >
                    {scanning ? (
                      <ActivityIndicator size="small" color={c.greenText} />
                    ) : (
                      <Ionicons name="wifi" size={18} color={c.greenText} />
                    )}
                    <Text style={s.detectTxt}>{scanning ? "Scanning network…" : "Auto-detect PC"}</Text>
                  </Pressable>
                </View>
              ) : filtered.length === 0 ? (
                <Text style={s.empty}>{search ? "No matches." : "No files on the PC yet."}</Text>
              ) : (
                filtered.map((f) => (
                  <View key={f.name} style={s.fileRow}>
                    <View style={s.fileIcon}><Ionicons name="document-outline" size={18} color={c.muted} /></View>
                    <View style={{ flex: 1, marginHorizontal: 10 }}>
                      <Text style={s.fileName} numberOfLines={1}>{f.name}</Text>
                      <Text style={s.fileSub}>{fmtBytes(f.size)}</Text>
                    </View>
                    <Pressable onPress={() => startDownload(f.name, f.size)} style={({ pressed }) => [s.openBtn, pressed && s.pressed]}>
                      <Text style={s.openBtnTxt}>Get</Text>
                    </Pressable>
                    <Pressable onPress={() => confirmDelete(f.name)} hitSlop={6} style={s.trash}>
                      <Ionicons name="trash-outline" size={17} color={c.faint} />
                    </Pressable>
                  </View>
                ))
              )}
            </View>
          )}

          {/* DOWNLOADS TAB */}
          {tab === "downloads" && (
            <View style={{ marginTop: 6 }}>
              {inProgress.length > 0 && (
                <>
                  <Text style={s.sectionLbl}>IN PROGRESS</Text>
                  {inProgress.map((t) => {
                    const written = t.size * t.progress;
                    const pct = Math.round(t.progress * 100);
                    const remain = t.speed && t.speed > 0 ? (t.size - written) / t.speed : NaN;
                    return (
                      <View key={t.id} style={s.progCard}>
                        <View style={s.progTop}>
                          <View style={s.iconSq}>
                            <Ionicons name={t.dir === "up" ? "arrow-up" : "folder-outline"} size={20} color={c.greenText} />
                          </View>
                          <View style={{ flex: 1, marginHorizontal: 12 }}>
                            <Text style={s.progName} numberOfLines={1}>{t.name}</Text>
                            <Text style={s.progSub}>{fmtBytes(written)} of {fmtBytes(t.size)}</Text>
                          </View>
                          <Text style={s.progPct}>{t.status === "error" ? "!" : `${pct}%`}</Text>
                        </View>
                        <View style={s.track}>
                          <View style={[s.fill, { width: `${pct}%`, backgroundColor: t.status === "error" ? c.err : c.green }]} />
                        </View>
                        <View style={s.progBottom}>
                          <Text style={s.progMeta}>
                            {t.status === "error" ? "Failed" : t.status === "paused" ? "Paused" : fmtRemaining(remain)}
                          </Text>
                          <Text style={s.progMeta}>{t.speed ? `${fmtBytes(t.speed)}/s` : ""}</Text>
                        </View>
                        {t.dir === "down" && t.status !== "error" && !t.chunked && (
                          <Pressable
                            style={s.pauseBtn}
                            onPress={() => (t.status === "paused" ? resumeDownload(t.id, t.name) : pauseDownload(t.id))}
                          >
                            <Ionicons name={t.status === "paused" ? "play" : "pause"} size={16} color={c.text} />
                          </Pressable>
                        )}
                      </View>
                    );
                  })}
                </>
              )}

              <View style={s.historyHead}>
                <Text style={s.sectionLbl}>HISTORY</Text>
                {history.length > 0 && (
                  <Pressable onPress={clearHistory} style={({ pressed }) => [s.clearBtn, pressed && s.pressed]}>
                    <Text style={s.clearTxt}>Clear All</Text>
                  </Pressable>
                )}
              </View>

              {history.length === 0 && inProgress.length === 0 ? (
                <Text style={s.empty}>No transfers yet.</Text>
              ) : (
                history.map((h) => (
                  <View key={h.id} style={s.fileRow}>
                    <View style={s.fileIcon}>
                      <Ionicons
                        name={h.failed ? "alert-circle-outline" : h.dir === "up" ? "arrow-up" : "folder-outline"}
                        size={18}
                        color={h.failed ? c.err : c.muted}
                      />
                    </View>
                    <View style={{ flex: 1, marginHorizontal: 10 }}>
                      <View style={s.row}>
                        <Text style={[s.fileName, { marginRight: 8 }]} numberOfLines={1}>{h.name}</Text>
                        <Text style={[s.completedTag, h.failed && { color: c.err }]}>
                          {h.failed ? "FAILED" : h.dir === "up" ? "SENT" : "COMPLETED"}
                        </Text>
                      </View>
                      <Text style={s.fileSub}>{fmtBytes(h.size)} · {timeAgo(h.completedAt)}</Text>
                    </View>
                    {h.failed && h.dir === "down" ? (
                      <Pressable
                        onPress={() => { removeHistory(h.id); startDownload(h.name, h.size); }}
                        style={({ pressed }) => [s.retryBtn, pressed && s.pressed]}
                      >
                        <Text style={s.retryTxt}>Retry</Text>
                      </Pressable>
                    ) : !h.failed && h.dir === "down" ? (
                      <Pressable onPress={() => openHistoryItem(h)} style={({ pressed }) => [s.openBtn, pressed && s.pressed]}>
                        <Text style={s.openBtnTxt}>Open</Text>
                      </Pressable>
                    ) : null}
                    <Pressable onPress={() => removeHistory(h.id)} hitSlop={6} style={s.trash}>
                      <Ionicons name="close" size={16} color={c.faint} />
                    </Pressable>
                  </View>
                ))
              )}
            </View>
          )}

          {/* SETTINGS TAB */}
          {tab === "settings" && (
            <View style={{ marginTop: 10 }}>
              <Text style={s.sectionLbl}>PC SERVER</Text>
              <View style={s.settingsCard}>
                <Pressable
                  onPress={() => handleAutoDetect()}
                  disabled={scanning}
                  style={({ pressed }) => [s.detectBtn, scanning && { opacity: 0.6 }, pressed && s.pressed]}
                >
                  {scanning ? (
                    <ActivityIndicator size="small" color={c.greenText} />
                  ) : (
                    <Ionicons name="wifi" size={18} color={c.greenText} />
                  )}
                  <Text style={s.detectTxt}>{scanning ? "Scanning network…" : "Auto-detect PC"}</Text>
                </Pressable>
                <View style={s.divider} />
                {editing ? (
                  <>
                    <TextInput
                      style={s.urlInput}
                      value={inputUrl}
                      onChangeText={setInputUrl}
                      placeholder="http://192.168.1.5:8000"
                      placeholderTextColor={c.faint}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                    />
                    <View style={s.row}>
                      <Pressable onPress={saveServerUrl} style={({ pressed }) => [s.primary, pressed && s.pressed]}>
                        <Text style={s.primaryTxt}>Save</Text>
                      </Pressable>
                      {serverUrl && (
                        <Pressable onPress={() => { setInputUrl(serverUrl); setEditing(false); }} style={({ pressed }) => [s.ghost, pressed && s.pressed]}>
                          <Text style={s.ghostTxt}>Cancel</Text>
                        </Pressable>
                      )}
                    </View>
                  </>
                ) : (
                  <>
                    <Text style={s.serverIp}>{serverUrl ?? "Not set"}</Text>
                    <View style={[s.row, { marginTop: 8, flexWrap: "wrap" }]}>
                      <View style={[s.statusDot, { backgroundColor: connected ? c.green : c.faint }]} />
                      <Text style={[s.statusTxt, { color: connected ? c.greenText : c.faint, marginRight: 16 }]}>
                        {connected ? "Connected" : "Offline"}
                      </Text>
                      <Pressable onPress={() => setEditing(true)} style={({ pressed }) => [s.ghost, pressed && s.pressed]}>
                        <Text style={s.ghostTxt}>Change</Text>
                      </Pressable>
                      <Pressable onPress={refresh} style={({ pressed }) => [s.ghost, { marginLeft: 8 }, pressed && s.pressed]}>
                        <Text style={s.ghostTxt}>Test</Text>
                      </Pressable>
                    </View>
                  </>
                )}
              </View>
              <Text style={s.hint}>
                Downloads save to the app, then open the share sheet so you can keep them anywhere.
              </Text>
            </View>
          )}
        </ScrollView>

        {/* BOTTOM NAV */}
        <View style={[s.nav, { paddingBottom: BOTTOM_INSET + 8 }]}>
          {([
            { k: "files", label: "Files", icon: "folder-outline", on: "folder" },
            { k: "downloads", label: "Downloads", icon: "arrow-down-circle-outline", on: "arrow-down-circle" },
            { k: "settings", label: "Settings", icon: "settings-outline", on: "settings" },
          ] as const).map((n) => {
            const active = tab === n.k;
            return (
              <Pressable key={n.k} style={s.navItem} onPress={() => setTab(n.k)}>
                <Ionicons name={(active ? n.on : n.icon) as any} size={22} color={active ? c.greenText : c.faint} />
                <Text style={[s.navTxt, { color: active ? c.greenText : c.faint }]}>{n.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  scroll: { paddingHorizontal: 18, paddingBottom: 28 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { color: c.text, fontSize: 22, fontWeight: "600", letterSpacing: -0.3 },
  titleAccent: { color: c.green, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "center" },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusTxt: { fontSize: 13, fontWeight: "600" },

  serverCard: { flexDirection: "row", alignItems: "center", backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 12 },
  serverIp: { color: c.text, fontSize: 18, fontFamily: MONO_BOLD },
  serverSub: { color: c.muted, fontSize: 12, marginTop: 3 },
  pill: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, borderWidth: 1 },
  pillOn: { backgroundColor: c.greenDim, borderColor: c.borderGreen },
  pillOff: { backgroundColor: "transparent", borderColor: c.border },
  pillTxt: { fontSize: 12, fontWeight: "700" },

  searchBox: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, marginBottom: 14 },
  searchInput: { flex: 1, color: c.text, paddingVertical: 11, fontSize: 15 },

  subTabs: { flexDirection: "row", gap: 24, borderBottomColor: c.border, borderBottomWidth: 1, marginBottom: 6 },
  subTab: { flexDirection: "row", alignItems: "center", paddingVertical: 10, position: "relative" },
  subTabTxt: { color: c.muted, fontSize: 15, fontWeight: "600", marginRight: 7 },
  subTabActive: { color: c.text },
  subTabUnderline: { position: "absolute", left: 0, right: 18, bottom: -1, height: 2, backgroundColor: c.green, borderRadius: 2 },
  badge: { backgroundColor: c.surface2, borderRadius: 9, minWidth: 18, paddingHorizontal: 5, paddingVertical: 1, alignItems: "center" },
  badgeTxt: { color: c.muted, fontSize: 11, fontWeight: "700" },

  sectionLbl: { color: c.muted, fontSize: 11, fontWeight: "800", letterSpacing: 1, marginTop: 18, marginBottom: 10 },

  progCard: { backgroundColor: c.surface, borderColor: c.borderGreen, borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 12 },
  progTop: { flexDirection: "row", alignItems: "center" },
  iconSq: { width: 40, height: 40, borderRadius: 11, backgroundColor: c.greenDim, alignItems: "center", justifyContent: "center" },
  progName: { color: c.text, fontSize: 15, fontWeight: "700" },
  progSub: { color: c.muted, fontSize: 12, marginTop: 2, fontFamily: MONO },
  progPct: { color: c.greenText, fontSize: 16, fontWeight: "800" },
  track: { height: 6, backgroundColor: "#0c100e", borderRadius: 3, overflow: "hidden", marginTop: 14 },
  fill: { height: "100%", backgroundColor: c.green, borderRadius: 3 },
  progBottom: { flexDirection: "row", justifyContent: "space-between", marginTop: 10 },
  progMeta: { color: c.faint, fontSize: 12, fontFamily: MONO },
  pauseBtn: { width: 38, height: 34, borderRadius: 9, backgroundColor: c.surface2, borderColor: c.border, borderWidth: 1, alignItems: "center", justifyContent: "center", marginTop: 12 },

  historyHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  clearBtn: { backgroundColor: c.surface2, borderColor: c.border, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 9, marginTop: 8 },
  clearTxt: { color: c.text, fontSize: 12, fontWeight: "600" },

  fileRow: { flexDirection: "row", alignItems: "center", backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: 12, padding: 10, marginBottom: 8 },
  fileIcon: { width: 38, height: 38, borderRadius: 10, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center" },
  fileName: { color: c.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  fileSub: { color: c.muted, fontSize: 12, marginTop: 2, fontFamily: MONO },
  completedTag: { color: c.greenText, fontSize: 10, fontWeight: "800", letterSpacing: 0.5 },
  openBtn: { backgroundColor: c.green, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 9 },
  openBtnTxt: { color: "#05210f", fontSize: 13, fontWeight: "800" },
  retryBtn: { backgroundColor: c.surface2, borderColor: c.border, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 9 },
  retryTxt: { color: c.text, fontSize: 13, fontWeight: "700" },
  trash: { paddingHorizontal: 8, paddingVertical: 8, marginLeft: 2 },

  sendBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: c.greenDim, borderColor: c.borderGreen, borderWidth: 1, borderRadius: 12, paddingVertical: 13, marginBottom: 14 },
  sendBtnTxt: { color: c.greenText, fontSize: 15, fontWeight: "700" },

  settingsCard: { backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: 14, padding: 14 },
  detectBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: c.greenDim, borderColor: c.borderGreen, borderWidth: 1, borderRadius: 10, paddingVertical: 12 },
  detectTxt: { color: c.greenText, fontSize: 14, fontWeight: "700" },
  divider: { height: 1, backgroundColor: c.border, marginVertical: 14 },
  urlInput: { backgroundColor: c.bg, color: c.text, borderColor: c.border, borderWidth: 1, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15, marginBottom: 12 },
  primary: { backgroundColor: c.green, paddingVertical: 10, paddingHorizontal: 20, borderRadius: 9, marginRight: 8 },
  primaryTxt: { color: "#05210f", fontWeight: "800" },
  ghost: { backgroundColor: c.surface2, borderColor: c.border, borderWidth: 1, paddingVertical: 9, paddingHorizontal: 15, borderRadius: 9 },
  ghostTxt: { color: c.text, fontWeight: "600" },
  hint: { color: c.faint, fontSize: 12, lineHeight: 18, marginTop: 14 },

  empty: { color: c.faint, fontSize: 14, textAlign: "center", paddingVertical: 26 },
  pressed: { opacity: 0.7 },

  nav: { flexDirection: "row", borderTopColor: c.border, borderTopWidth: 1, backgroundColor: c.bg, paddingTop: 8 },
  navItem: { flex: 1, alignItems: "center", gap: 3 },
  navTxt: { fontSize: 11, fontWeight: "600" },
});
