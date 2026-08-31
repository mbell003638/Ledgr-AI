import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

import { useTheme, useThemeMode, useAnimations } from "@/src/context/ThemeContext";
import { useOnboardingGate } from "@/src/context/OnboardingContext";
import { api, getAIConfig, setAIConfig } from "@/src/api";
import { PROVIDERS, type ProviderId } from "@/src/db/ai";
import { ScreenHeader } from "@/src/components/UI";
import { GlowPressable } from "@/src/components/GlowPressable";
import { deviceHasLock, requireAuth } from "@/src/utils/lock";
import { PERSONAS, type PersonaId } from "@/src/accountingV2/config";
import { isValidDateString, normalizeDateInput } from "@/src/utils/dateValidation";
import { deriveHostingMode } from "@/src/utils/hostingMode";
import { SETTINGS_SCREEN_HEADER_BOTTOM } from "@/src/utils/settingsScreenLayout";

const AccordionRow = ({ title, subtitle, isLast, expandedKey, setExpandedKey, children, theme }: any) => {
  const isExpanded = expandedKey === title;
  return (
    <View style={{ borderBottomWidth: isLast && !isExpanded ? 0 : 1, borderBottomColor: theme.color.border, backgroundColor: "transparent" }}>
      <GlowPressable
        shadowEnabled={false}
        topHighlight={false}
        haptic
        animateBorder={false}
        restingBorderColor="transparent"
        hoverBorderColor={theme.color.brandPrimary}
        pressScale={0.97}
        hoverScale={1.008}
        hoverLift={-2}
        onPress={() => setExpandedKey(isExpanded ? null : title)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: 60,
          paddingVertical: 16,
          paddingHorizontal: 10,
          marginHorizontal: -10,
          borderWidth: 0,
          borderRadius: 14,
          ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as any) : {}),
        }}
      >
        <View style={{ flex: 1, paddingRight: 16 }}>
          <Text style={{ fontSize: 15, fontWeight: "500", color: theme.color.onSurface }}>{title}</Text>
          {subtitle && <Text style={{ fontSize: 12, color: theme.color.muted, marginTop: 4 }}>{subtitle}</Text>}
        </View>
        <Ionicons name={isExpanded ? "chevron-down" : "chevron-forward"} size={20} color={theme.color.muted} />
      </GlowPressable>
      {isExpanded && <View style={{ paddingBottom: 8, paddingTop: 12, backgroundColor: "transparent" }}>{children}</View>}
    </View>
  );
};

export default function AdvancedSettingsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { mode, setMode } = useThemeMode();
  const { setAnimationsEnabled } = useAnimations();
  const { requireOnboarding } = useOnboardingGate();
  const [provider, setProvider] = useState<ProviderId>("gemini");
  const [key, setKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [visionModelName, setVisionModelName] = useState("");
  const [transcriptionModelName, setTranscriptionModelName] = useState("whisper-1");
  const [transcriptionBaseUrl, setTranscriptionBaseUrl] = useState("");
  const [transcriptionKey, setTranscriptionKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // Members = the owners/investors who put in capital and share profit.
  // Each: { name, amount (investment), profitSharePct (optional) }.
  const [members, setMembers] = useState<{ name: string; amount: string; profitSharePct: string }[]>([]);
  const [lockEnabled, setLockEnabled] = useState(false);
  // Books = separate isolated accounts (e.g. Shop, Technician).
  const [books, setBooks] = useState<{ id: string; name: string; businessType?: string }[]>([]);
  const [activeBook, setActiveBookState] = useState("default");
  const [newBookName, setNewBookName] = useState("");
  const [addingBook, setAddingBook] = useState(false);
  const [newBookPersona, setNewBookPersona] = useState<PersonaId>("custom");
  const [loading, setLoading] = useState(true);
  const [accountingBasis, setAccountingBasis] = useState<"cash" | "accrual">("cash");
  const [accountingStyle, setAccountingStyle] = useState<"retail_partnership" | "standard">("standard");
  const [periodMode, setPeriodMode] = useState<"flexible" | "fixed">("flexible");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [selectedPersonas, setSelectedPersonas] = useState<PersonaId[]>(["custom"]);
  const [activePersona, setActivePersona] = useState<PersonaId>("custom");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [hostingState, setHostingState] = useState(() => deriveHostingMode({ enabled: false, configured: false, pending: 0, retryable: 0, conflicts: 0 }));
  const [confirmFactoryReset, setConfirmFactoryReset] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const chooseProvider = (nextProvider: ProviderId) => {
    const meta = PROVIDERS.find((item) => item.id === nextProvider)!;
    setProvider(nextProvider);
    setModelName(meta.defaultModel);
    setBaseUrl(meta.defaultBaseUrl);
    setTestResult(null);
  };

  const updateAccountingStyle = async (style: "retail_partnership" | "standard") => {
    setAccountingStyle(style);
    try {
      const v2 = await api.getV2BookConfig();
      if (v2) {
        await api.updateV2BookConfig({
          style,
          basis: v2.basis,
          periodPolicy: v2.periodPolicy,
          selectedPersonas: v2.selectedPersonas,
          activePersona: v2.activePersona,
          retailPartnership: {
            ...v2.retailPartnership,
            enabled: style === "retail_partnership",
          },
        });
      }
    } catch (error: any) {
      setStatus({ ok: false, msg: error?.message || "Could not update Accounting Style." });
    }
  };

  const load = useCallback(async () => {
    try {
      const [s, cfg, syncStatus] = await Promise.all([api.getSettings(), getAIConfig(), api.getSyncStatus()]);
      setHostingState(deriveHostingMode(syncStatus));
      setProvider(cfg.provider);
      setKey(cfg.apiKey || "");
      setModelName(cfg.model || "");
      setVisionModelName(cfg.visionModel || "");
      setTranscriptionModelName(cfg.transcriptionModel || "whisper-1");
      setTranscriptionBaseUrl(cfg.transcriptionBaseUrl || "");
      setTranscriptionKey(cfg.transcriptionApiKey || "");
      setBaseUrl(cfg.baseUrl || "");
      setAccountingBasis(s.accountingBasis === "accrual" ? "accrual" : "cash");
      const configuredPersonas: PersonaId[] = Array.isArray(s.selectedPersonas) && s.selectedPersonas.length ? s.selectedPersonas as PersonaId[] : ["custom"];
      setSelectedPersonas(configuredPersonas);
      setActivePersona((s.activePersona as PersonaId) || configuredPersonas[0]);
      try {
        const v2 = await api.getV2BookConfig();
        if (v2) {
          setAccountingStyle(v2.style === "retail_partnership" ? "retail_partnership" : "standard");
          setAccountingBasis(v2.basis);
          setPeriodMode(v2.periodPolicy?.mode === "fixed" ? "fixed" : "flexible");
          setPeriodStart(v2.periodPolicy?.startDate || "");
          setPeriodEnd(v2.periodPolicy?.endDate || "");
          setSelectedPersonas(v2.selectedPersonas);
          setActivePersona(v2.activePersona);
          setMembers(v2.retailPartnership.members.map((m) => ({ name: m.name, amount: m.openingContribution ? String(m.openingContribution) : "", profitSharePct: m.profitSharePct ? String(m.profitSharePct) : "" })));
        }
      } catch { /* the V2 configuration remains unavailable until storage is ready */ }
      setLockEnabled(!!s.lockEnabled);
      // Load the list of books (accounts) + which one is active.
      try {
        const bks = await api.listBooks();
        setBooks(bks);
        setActiveBookState(api.activeBookId());
      } catch { /* books optional */ }
      if (s.themeMode && (s.themeMode === 'light' || s.themeMode === 'dark' || s.themeMode === 'navy_gold' || s.themeMode === 'amoled_blue' || s.themeMode === 'system')) {
        setMode(s.themeMode);
      }
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, [setMode]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      let normalizedPeriodStart = "";
      let normalizedPeriodEnd = "";
      if (periodMode === "fixed") {
        normalizedPeriodStart = normalizeDateInput(periodStart);
        normalizedPeriodEnd = normalizeDateInput(periodEnd);
        if (!isValidDateString(normalizedPeriodStart) || !isValidDateString(normalizedPeriodEnd)) {
          throw new Error("Fixed periods require valid start and end dates in YYYY-MM-DD format.");
        }
        if (normalizedPeriodStart > normalizedPeriodEnd) throw new Error("The fixed period end date must be on or after its start date.");
        setPeriodStart(normalizedPeriodStart);
        setPeriodEnd(normalizedPeriodEnd);
      }
      if (lockEnabled && !(await deviceHasLock())) {
        throw new Error("Set up a device PIN, fingerprint, or face unlock before enabling App Lock.");
      }
      const meta = PROVIDERS.find((p) => p.id === provider)!;
      await setAIConfig({
        provider,
        apiKey: key.trim(),
        model: modelName.trim() || meta.defaultModel,
        visionModel: visionModelName.trim(),
        transcriptionModel: transcriptionModelName.trim() || "whisper-1",
        transcriptionBaseUrl: transcriptionBaseUrl.trim(),
        transcriptionApiKey: transcriptionKey.trim(),
        baseUrl: baseUrl.trim(),
      });
      try {
        const currentCfg = await api.getV2BookConfig().catch(() => null);
        await api.updateV2BookConfig({
          basis: accountingBasis,
          style: accountingStyle,
          periodPolicy: periodMode === "fixed"
            ? { mode: "fixed", startDate: normalizedPeriodStart, endDate: normalizedPeriodEnd }
            : { mode: "flexible" },
          selectedPersonas,
          activePersona,
          retailPartnership: {
            enabled: accountingStyle === "retail_partnership",
            commissionPct: currentCfg?.retailPartnership?.commissionPct ?? 0,
            inventoryCadence: currentCfg?.retailPartnership?.inventoryCadence ?? "irregular",
            members: members.map((m) => ({ name: m.name.trim(), openingContribution: m.amount.trim() ? parseFloat(m.amount) : 0, profitSharePct: m.profitSharePct.trim() ? parseFloat(m.profitSharePct) : 0 })).filter((m) => m.name),
          },
        });
      } catch (e: any) {
        if (!/V2 accounting requires SQLite|No active versioned V2 book/i.test(e?.message || "")) throw e;
      }
      await api.updateSettings({
        lockEnabled,
        themeMode: mode,
      });
      setStatus({ ok: true, msg: "Settings saved." });
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Failed" });
    } finally {
      setSaving(false);
    }
  };

  const testKey = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const meta = PROVIDERS.find((p) => p.id === provider)!;
      const draftConfig = {
        provider,
        apiKey: key.trim(),
        model: modelName.trim() || meta.defaultModel,
        visionModel: visionModelName.trim(),
        transcriptionModel: transcriptionModelName.trim() || "whisper-1",
        transcriptionBaseUrl: transcriptionBaseUrl.trim(),
        transcriptionApiKey: transcriptionKey.trim(),
        baseUrl: baseUrl.trim(),
      };
      await api.testKey(draftConfig);
      setTestResult({ ok: true, msg: `âœ“ Chat connected` });
    } catch (e: any) {
      setTestResult({ ok: false, msg: `âœ— ${e.message || "Failed"}` });
    } finally {
      setTesting(false);
    }
  };

  const doReset = async () => {
    const ok = await requireAuth("Confirm to reset all accounting data");
    if (!ok) {
      setConfirmReset(false);
      return;
    }
    setResetting(true); setStatus(null);
    try {
      await api.clearAccountingData();
      setStatus({ ok: true, msg: "Accounting data cleared. Preferences and AI configuration were preserved." });
      setConfirmReset(false);
      await load();
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Reset failed" });
    } finally { setResetting(false); }
  };

  const doFactoryReset = async () => {
    const ok = await requireAuth("Confirm full device factory reset");
    if (!ok) { setConfirmFactoryReset(false); return; }
    setResetting(true); setStatus(null);
    try {
      await api.factoryReset();
      // Flip the protected-route guard immediately. Expo Router removes every
      // accounting screen from navigation history before we show onboarding.
      requireOnboarding();
      // factoryReset wipes the persisted theme/animation prefs, but the live
      // ThemeContext only hydrates on mount â€” reset it in memory too so the app
      // returns to its pristine system-default look immediately (not the user's
      // old theme lingering until the next cold start).
      setMode('system');
      setAnimationsEnabled(false);
      router.replace('/onboarding' as any);
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Factory reset failed" });
    } finally { setResetting(false); setConfirmFactoryReset(false); }
  };
  const updateMember = (i: number, field: "name" | "amount" | "profitSharePct", v: string) =>
    setMembers((prev) => prev.map((m, idx) => (idx === i ? { ...m, [field]: v } : m)));
  const addMember = () => setMembers((prev) => [...prev, { name: "", amount: "", profitSharePct: "" }]);
  const removeMember = (i: number) => setMembers((prev) => prev.filter((_, idx) => idx !== i));

  const switchBook = async (id: string) => {
    if (id === activeBook) return;
    await api.setActiveBook(id);
    setActiveBookState(id);
    const targetBook = books.find((b) => b.id === id);
    const s = await api.getSettings();
    const bookTheme = s.themeMode || (id === "default" ? "light" : id.charCodeAt(id.length - 1) % 2 === 0 ? "amoled_blue" : "navy_gold");
    setMode(bookTheme as any);
    await api.updateSettingó~ö¶‰žËkºwµç}±½È¹µÕÑ•‘ô4(€€€€€€€€€€€€€€€€€€€€€€€…ÕÑ½…Á¥Ñ…±¥é”ô‰¹½¹”ˆ4(€€€€€€€€€€€€€€€€€€€€€€€…ÕÑ½½ÉÉ•Ðõí™…±Í•ô4(€€€€€€€€€€€€€€€€€€€€€€€ÍÑå±”õíÍÑå±•Ì¹¥¹ÁÕÑô4(€€€€€€€€€€€€€€€€€€€€€€¼ø4(€€€€€€€€€€€€€€€€€€€€ð¼ø4(€€€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€€€€ñY¥•ÜÍÑå±”õíì™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°…ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹Í´õôø4(€€€€€€€€€€€€€€€€€€€€ñAÉ•ÍÍ…‰±”½¹AÉ•ÍÌõíÑ•ÍÑ-•åô‘¥Í…‰±•õíÑ•ÍÑ¥¹œñð€…­•åôÍÑå±”õì¡ìÁÉ•ÍÍ•ô¤€ôømÍÑå±•Ì¹Í•½¹‘…Éå	Ñ¸°ì…±¥¹M•±˜è€™±•àµÍÑ…ÉÐœ°Á…‘‘¥¹!½É¥é½¹Ñ…°è€ÄØô°€¡ÁÉ•ÍÍ•ñðÑ•ÍÑ¥¹œ¤€˜˜ì½Á…¥Ñäè€À¸ÜõuôùíÑ•ÍÑ¥¹œ€ü€ñÑ¥Ù¥Ñå%¹‘¥…Ñ½È½±½ÈõíÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éåô€¼ø€è€ñQ•áÐÍÑå±”õíÍÑå±•Ì¹Í•½¹‘…ÉåQ•áÑôùQ•ÍÐ¡…Ð½¹¹•Ñ¥½¸ð½Q•áÐùôð½AÉ•ÍÍ…‰±”ø4(€€€€€€€€€€€€€€€€€€€íÑ•ÍÑI•ÍÕ±Ð€˜˜€ñQ•áÐÍÑå±”õíì™½¹ÑM¥é”è€ÄÌ°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆ°½±½ÈèÑ•ÍÑI•ÍÕ±Ð¹½¬€üÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éä€èÑ¡•µ”¹½±½È¹•ÉÉ½È°™±•áM¡É¥¹¬è€ÄõôùíÑ•ÍÑI•ÍÕ±Ð¹µÍôð½Q•áÐùô4(€€€€€€€€€€€€€€€€€€ð½Y¥•Üø4(€€€€€€€€€€€€€€€€ð½Y¥•Üø4(€€€€€€€€€€€€€€ð½½É‘¥½¹I½Üø4(€€€€€€€€€€€€ð½Y¥•Üø4(4(€€€€€€€€€€€€ñY¥•ÜÍÑå±”õíì‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹ÍÕÉ™…•M•½¹‘…Éä°‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°‰½É‘•É]¥‘Ñ è€Ä°‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰½É‘•È°µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹±œ°Á…‘‘¥¹œè€ÈÀõôø(€€€€€€€€€€€€€€ñQ•áÐÍÑå±”õíì™½¹ÑM¥é”è€ÄØ°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆ°½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éä°µ…É¥¹	½ÑÑ½´è€àõôùM•ÕÉ¥Ñä€˜…Ñ„ð½Q•áÐø4(€€€€€€€€€€€€€€ñQ•áÐÍÑå±”õíì™½¹ÑM¥é”è€ÄÌ°½±½ÈèÑ¡•µ”¹½±½È¹µÕÑ•°µ…É¥¹	½ÑÑ½´è€ÄØ°±¥¹•!•¥¡Ðè€ÄàõôùAÉ½Ñ•Ðå½ÕÈÍ•¹Í¥Ñ¥Ù”…Ñ¥½¹Ì…¹‰…­ÕÁÌ¸ð½Q•áÐø4(€€€€€€€€€€€€€€ñ½É‘¥½¹I½ÜÑ¥Ñ±”ô‰ÁÀ1½¬ˆÍÕ‰Ñ¥Ñ±”ô‰¥¹•ÉÁÉ¥¹Ð€¼A%8ˆÑ¡•µ”õíÑ¡•µ•ô•áÁ…¹‘•‘-•äõí•áÁ…¹‘•‘-•åôÍ•ÑáÁ…¹‘•‘-•äõíÍ•ÑáÁ…¹‘•‘-•åôø4(€€€€€€€€€€€€€€€€ñY¥•Üø4(€€€€€€€€€€€€€€€€€€ñQ•áÐÍÑå±”õíÍÑå±•Ì¹¡¥¹ÑôùUÍ”å½ÕÈÁ¡½¹—ŠeÌ™¥¹•ÉÁÉ¥¹Ð€¼™…”€¼A%8Ñ¼ÁÉ½Ñ•ÐÍ•¹Í¥Ñ¥Ù”…Ñ¥½¹Ì¸ð½Q•áÐø4(€€€€€€€€€€€€€€€€€€ñAÉ•ÍÍ…‰±”½¹AÉ•ÍÌõì ¤€ôøÍ•Ñ1½­¹…‰±• ¡Ø¤€ôø€…Ø¥ôÍÑå±”õímÍÑå±•Ì¹±½­Q½±”°±½­¹…‰±•€˜˜ÍÑå±•Ì¹±½­Q½±•=¹uôø4(€€€€€€€€€€€€€€€€€€€€ñ%½¹¥½¹Ì¹…µ”õí±½­¹…‰±•€ü€‰±½¬µ±½Í•ˆ€è€‰±½¬µ½Á•¸µ½ÕÑ±¥¹”‰ôÍ¥é”õìÄáô½±½Èõí±½­¹…‰±•€üÑ¡•µ”¹½±½È¹½¹	É…¹‘AÉ¥µ…Éä€èÑ¡•µ”¹½±½È¹½¹MÕÉ™…•ô€¼ø4(€€€€€€€€€€€€€€€€€€€€ñQ•áÐÍÑå±”õímÍÑå±•Ì¹±½­Q½±•Q•áÐ°±½­¹…‰±•€˜˜ì½±½ÈèÑ¡•µ”¹½±½È¹½¹	É…¹‘AÉ¥µ…Éäõuôùí±½­¹…‰±•€ü€‰ÁÀ1½¬=8ˆ€è€‰ÁÀ1½¬=‰ôð½Q•áÐø4(€€€€€€€€€€€€€€€€€€ð½AÉ•ÍÍ…‰±”ø4(€€€€€€€€€€€€€€€€ð½Y¥•Üø4(€€€€€€€€€€€€€€ð½½É‘¥½¹I½Üø4(€€€€€€€€€€€€€€ñ½É‘¥½¹I½ÜÑ¥Ñ±”ô‰	…­ÕÀ€˜I•ÍÑ½É”ˆÍÕ‰Ñ¥Ñ±”ô‰¹ÉåÁÑ••áÁ½ÉÐ…¹Ù•É¥™¥•É•ÍÑ½É”ˆÑ¡•µ”õíÑ¡•µ•ô•áÁ…¹‘•‘-•äõí•áÁ…¹‘•‘-•åôÍ•ÑáÁ…¹‘•‘-•äõíÍ•ÑáÁ…¹‘•‘-•åôø(€€€€€€€€€€€€€€€€ñY¥•Üø(€€€€€€€€€€€€€€€€€€ñQ•áÐÍÑå±”õíÍÑå±•Ì¹¡¥¹ÑôùÉ•…Ñ”Á…ÍÍÁ¡É…Í”µ•¹ÉåÁÑ•É•½Ù•Éä™¥±•Ì°Ù…±¥‘…Ñ”¥µÁ½ÉÑÌÝ¥Ñ¡½ÕÐ¡…¹¥¹œ‘…Ñ„°…¹É•ÍÑ½É”Ñ¡É½Õ Ñ¡”•á¥ÍÑ¥¹œ…Ñ½µ¥ŒµÕ±Ñ¤µ‰½½¬•¹¥¹”¸ð½Q•áÐø(€€€€€€€€€€€€€€€€€€ñAÉ•ÍÍ…‰±”Ñ•ÍÑ%ô‰½Á•¸µ‰…­ÕÀµÉ•½Ù•Éäˆ½¹AÉ•ÍÌõì ¤€ôøÉ½ÕÑ•È¹ÁÕÍ  œ½‰…­ÕÀµÉ•½Ù•Éäœ…Ì…¹ä¥ôÍÑå±”õímÍÑå±•Ì¹‰½½­I½Ü°ìµ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹Í´õuôø(€€€€€€€€€€€€€€€€€€€€ñ%½¹¥½¹Ì¹…µ”ô‰Í¡¥•±µ¡•­µ…É¬µ½ÕÑ±¥¹”ˆÍ¥é”õìÈÁô½±½ÈõíÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éåô€¼ø(€€€€€€€€€€€€€€€€€€€€ñY¥•ÜÍÑå±”õíì™±•àè€ÄõôøñQ•áÐÍÑå±”õíÍÑå±•Ì¹‰½½­9…µ•ôù=Á•¸	…­ÕÀ€˜I•½Ù•Éäð½Q•áÐøñQ•áÐÍÑå±”õíÍÑå±•Ì¹ÍÕ‰1…‰•±ôù¹ÉåÁÑ••áÁ½ÉÐ…¹Ù•É¥™¥•É•ÍÑ½É”ð½Q•áÐøð½Y¥•Üø(€€€€€€€€€€€€€€€€€€€€ñ%½¹¥½¹Ì¹…µ”ô‰¡•ÙÉ½¸µ™½ÉÝ…ÉˆÍ¥é”õìÄáô½±½ÈõíÑ¡•µ”¹½±½È¹µÕÑ•‘ô€¼ø(€€€€€€€€€€€€€€€€€€ð½AÉ•ÍÍ…‰±”ø(€€€€€€€€€€€€€€€€ð½Y¥•Üø(€€€€€€€€€€€€€€ð½½É‘¥½¹I½Üø4(€€€€€€€€€€€€€€ñ½É‘¥½¹I½ÜÑ¥Ñ±”ô‰…¹•Èi½¹”ˆ4(€€€€€€€€€€€€€€€ÍÕ‰Ñ¥Ñ±”ô‰±•…È…½Õ¹Ñ¥¹œ‘…Ñ„½ÈÉ•Í•ÐÑ¡¥Ì‘•Ù¥”ˆ¥Í1…ÍÐÑ¡•µ”õíÑ¡•µ•ô•áÁ…¹‘•‘-•äõí•áÁ…¹‘•‘-•åôÍ•ÑáÁ…¹‘•‘-•äõíÍ•ÑáÁ…¹‘•‘-•åôø4(€€€€€€€€€€€€€€€€ñY¥•Üø4(€€€€€€€€€€€€€€€€€€ñQ•áÐÍÑå±”õíÍÑå±•Ì¹¡¥¹Ñôù±•…È…½Õ¹Ñ¥¹œ‘…Ñ„É•µ½Ù•Ì‰½½­Ì°ÑÉ…¹Í…Ñ¥½¹Ì°‰ÕÍ¥¹•ÍÌ…½Õ¹ÑÌ°¥¹Ù•¹Ñ½Éä…¹Á•É¥½‘ÌÝ¡¥±”ÁÉ•Í•ÉÙ¥¹œÁÉ•™•É•¹•Ì…¹$½¹™¥ÕÉ…Ñ¥½¸¸…Ñ½ÉäÉ•Í•Ð…±Í¼É•µ½Ù•Ì‰ÕÍ¥¹•ÍÌÍ•ÑÑ¥¹Ì…¹$É•‘•¹Ñ¥…±Ì¸ð½Q•áÐø4(€€€€€€€€€€€€€€€€€ì…½¹™¥ÉµI•Í•Ð€ü€ 4(€€€€€€€€€€€€€€€€€€€€ñAÉ•ÍÍ…‰±”½¹AÉ•ÍÌõì ¤€ôøÍ•Ñ½¹™¥ÉµI•Í•Ð¡ÑÉÕ”¥ôÍÑå±”õíÍÑå±•Ì¹É•Í•Ñ%¹¥Ñ	Ñ¹ôøñ%½¹¥½¹Ì¹…µ”ô‰ÑÉ…Í µ½ÕÑ±¥¹”ˆÍ¥é”õìÄÙô½±½ÈõíÑ¡•µ”¹½±½È¹•ÉÉ½Éô€¼øñQ•áÐÍÑå±”õíÍÑå±•Ì¹É•Í•Ñ%¹¥ÑQ•áÑôù±•…È½Õ¹Ñ¥¹œ…Ñ‡Š˜ð½Q•áÐøð½AÉ•ÍÍ…‰±”ø4(€€€€€€€€€€€€€€€€€€¤€è€ 4(€€€€€€€€€€€€€€€€€€€€ñY¥•ÜÍÑå±”õíìµ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µõôø4(€€€€€€€€€€€€€€€€€€€€€€ñQ•áÐÍÑå±”õímÍÑå±•Ì¹¡¥¹Ð°ì½±½ÈèÑ¡•µ”¹½±½È¹•ÉÉ½È°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆõuôùQ¡¥Ì…¹¹½Ð‰”Õ¹‘½¹”¸½¹Í¥‘•È•áÁ½ÉÑ¥¹œ„‰…­ÕÀ™¥ÉÍÐ¸ð½Q•áÐø4(€€€€€€€€€€€€€€€€€€€€€€ñY¥•ÜÍÑå±”õíì™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…Àè€à°µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹Í´õôø4(€€€€€€€€€€€€€€€€€€€€€€€€ñAÉ•ÍÍ…‰±”½¹AÉ•ÍÌõì ¤€ôøÍ•Ñ½¹™¥ÉµI•Í•Ð¡™…±Í”¥ôÍÑå±”õíÍÑå±•Ì¹É•Í•Ñ…¹•±	Ñ¹ôøñQ•áÐÍÑå±”õíÍÑå±•Ì¹É•Í•Ñ…¹•±Q•áÑôù…¹•°ð½Q•áÐøð½AÉ•ÍÍ…‰±”ø4(€€€€€€€€€€€€€€€€€€€€€€€€ñAÉ•ÍÍ…‰±”½¹AÉ•ÍÌõí‘½I•Í•Ñô‘¥Í…‰±•õíÉ•Í•ÑÑ¥¹ôÍÑå±”õíÍÑå±•Ì¹É•Í•Ñ½¹™¥Éµ	Ñ¹ôùíÉ•Í•ÑÑ¥¹œ€ü€ñÑ¥Ù¥Ñå%¹‘¥…Ñ½È½±½Èôˆ™™˜ˆ€¼ø€è€ñQ•áÐÍÑå±”õíÍÑå±•Ì¹É•Í•Ñ½¹™¥ÉµQ•áÑôùe•Ì°±•…È…½Õ¹Ñ¥¹œ‘…Ñ„ð½Q•áÐùôð½AÉ•ÍÍ…‰±”ø4(€€€€€€€€€€€€€€€€€€€€€€ð½Y¥•Üø4(€€€€€€€€€€€€€€€€€€€€ð½Y¥•Üø4(€€€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€€€ì…½¹™¥Éµ…Ñ½ÉåI•Í•Ð€ü€ 4(€€€€€€€€€€€€€€€€€€€€ñAÉ•ÍÍ…‰±”½¹AÉ•ÍÌõì ¤€ôøÍ•Ñ½¹™¥Éµ…Ñ½ÉåI•Í•Ð¡ÑÉÕ”¥ôÍÑå±”õímÍÑå±•Ì¹É•Í•Ñ%¹¥Ñ	Ñ¸°ì‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹•ÉÉ½È€¬€ˆääˆõuôøñ%½¹¥½¹Ì¹…µ”ô‰Ý…É¹¥¹œµ½ÕÑ±¥¹”ˆÍ¥é”õìÄÙô½±½ÈõíÑ¡•µ”¹½±½È¹•ÉÉ½Éô€¼øñQ•áÐÍÑå±”õíÍÑå±•Ì¹É•Í•Ñ%¹¥ÑQ•áÑôù…Ñ½ÉäI•Í•Ð•Ù¥—Š˜ð½Q•áÐøð½AÉ•ÍÍ…‰±”ø4(€€€€€€€€€€€€€€€€€€¤€è€ 4(€€€€€€€€€€€€€€€€€€€€ñY¥•ÜÍÑå±”õíìµ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µõôø4(€€€€€€€€€€€€€€€€€€€€€€ñQ•áÐÍÑå±”õímÍÑå±•Ì¹¡¥¹Ð°ì½±½ÈèÑ¡•µ”¹½±½È¹•ÉÉ½È°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆõuôùQ¡¥ÌÝ¥Á•Ì•Ù•ÉåÑ¡¥¹œƒŠP…±°‰½½­Ì€˜É•½É‘Ì°‰ÕÍ¥¹•ÍÌ½¹™¥ÕÉ…Ñ¥½¸°Ñ¡”Í…Ù•$­•ä°…¹å½ÕÈÁÉ•™•É•¹•Ì€¡Ñ¡•µ”°…¹¥µ…Ñ¥½¹Ì°‘…Í¡‰½…É±…å½ÕÐ¤ƒŠPÑ¡•¸É•ÑÕÉ¹ÌÑ¼½¹‰½…É‘¥¹œ¸ð½Q•áÐø4(€€€€€€€€€€€€€€€€€€€€€€ñY¥•ÜÍÑå±”õíì™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…Àè€à°µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹Í´õôø4(€€€€€€€€€€€€€€€€€€€€€€€€ñAÉ•ÍÍ…‰±”½¹AÉ•ÍÌõì ¤€ôøÍ•Ñ½¹™¥Éµ…Ñ½ÉåI•Í•Ð¡™…±Í”¥ôÍÑå±”õíÍÑå±•Ì¹É•Í•Ñ…¹•±	Ñ¹ôøñQ•áÐÍÑå±”õíÍÑå±•Ì¹É•Í•Ñ…¹•±Q•áÑôù…¹•°ð½Q•áÐøð½AÉ•ÍÍ…‰±”ø4(€€€€€€€€€€€€€€€€€€€€€€€€ñAÉ•ÍÍ…‰±”½¹AÉ•ÍÌõí‘½…Ñ½ÉåI•Í•Ñô‘¥Í…‰±•õíÉ•Í•ÑÑ¥¹ôÍÑå±”õíÍÑå±•Ì¹É•Í•Ñ½¹™¥Éµ	Ñ¹ôùíÉ•Í•ÑÑ¥¹œ€ü€ñÑ¥Ù¥Ñå%¹‘¥…Ñ½È½±½Èôˆ™™˜ˆ€¼ø€è€ñQ•áÐÍÑå±”õíÍÑå±•Ì¹É•Í•Ñ½¹™¥ÉµQ•áÑôùe•Ì°™…Ñ½ÉäÉ•Í•Ðð½Q•áÐùôð½AÉ•ÍÍ…‰±”ø4(€€€€€€€€€€€€€€€€€€€€€€ð½Y¥•Üø4(€€€€€€€€€€€€€€€€€€€€ð½Y¥•Üø4(€€€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€€ð½Y¥•Üø4(€€€€€€€€€€€€€€ð½½É‘¥½¹I½Üø4(€€€€€€€€€€€€ð½Y¥•Üø4(4(€€€€€€€€€€€íÍÑ…ÑÕÌ€˜˜€ 4(€€€€€€€€€€€€€€ñY¥•ÜÍÑå±”õímÍÑå±•Ì¹ÍÑ…ÑÕÌ°ì‰…­É½Õ¹‘½±½ÈèÍÑ…ÑÕÌ¹½¬€üÑ¡•µ”¹½±½È¹ÍÕ•ÍÍ	œ€èÑ¡•µ”¹½±½È¹•ÉÉ½É	œõuôø4(€€€€€€€€€€€€€€€€ñ%½¹¥½¹Ì¹…µ”õíÍÑ…ÑÕÌ¹½¬€ü€‰¡•­µ…É¬µ¥É±”ˆ€è€‰…±•ÉÐµ¥É±”‰ôÍ¥é”õìÄáô½±½ÈõíÍÑ…ÑÕÌ¹½¬€üÑ¡•µ”¹½±½È¹ÍÕ•ÍÌ€èÑ¡•µ”¹½±½È¹•ÉÉ½Éô€¼ø4(€€€€€€€€€€€€€€€€ñQ•áÐÍÑå±”õímÍÑå±•Ì¹ÍÑ…ÑÕÍQ•áÐ°ì½±½ÈèÍÑ…ÑÕÌ¹½¬€üÑ¡•µ”¹½±½È¹ÍÕ•ÍÌ€èÑ¡•µ”¹½±½È¹•ÉÉ½ÈõuôùíÍÑ…ÑÕÌ¹µÍôð½Q•áÐø4(€€€€€€€€€€€€€€ð½Y¥•Üø4(€€€€€€€€€€€€¥ô4(4(€€€€€€€€€€€€ñAÉ•ÍÍ…‰±”Ñ•ÍÑ%ô‰‰Ñ¸µÍ…Ù”µÍ•ÑÑ¥¹Ìˆ½¹AÉ•ÍÌõíÍ…Ù•ô‘¥Í…‰±•õíÍ…Ù¥¹ôÍÑå±”õì¡ìÁÉ•ÍÍ•ô¤€ôømÍÑå±•Ì¹ÁÉ¥µ…Éå	Ñ¸°€¡ÁÉ•ÍÍ•ñðÍ…Ù¥¹œ¤€˜˜ì½Á…¥Ñäè€À¸àÔõuôø4(€€€€€€€€€€€€€íÍ…Ù¥¹œ€ü€ñÑ¥Ù¥Ñå%¹‘¥…Ñ½È½±½Èôˆ™™˜ˆ€¼ø€è€ñQ•áÐÍÑå±”õíÍÑå±•Ì¹ÁÉ¥µ…ÉåQ•áÑôùM…Ù”M•ÑÑ¥¹Ìð½Q•áÐùô4(€€€€€€€€€€€€ð½AÉ•ÍÍ…‰±”ø4(€€€€€€€€€€€€ñY¥•ÜÍÑå±”õíì¡•¥¡Ðè€ÄÈÀõô€¼ø4(€€€€€€€€€€ð½MÉ½±±Y¥•Üø4(€€€€€€€€ð½-•å‰½…É‘Ù½¥‘¥¹Y¥•Üø4(€€€€€€¥ô4(€€€€ð½M…™•É•…Y¥•Üø4(€€¤ì4)ô4(4)™Õ¹Ñ¥½¸µ…­•MÑå±•Ì¡Ñ¡•µ”è…¹ä¤ì4(€É•ÑÕÉ¸MÑå±•M¡••Ð¹É•…Ñ”¡ì4(€€€½¹Ñ…¥¹•Èèì™±•àè€Ä°‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹ÍÕÉ™…”ô°4(€€€ÍÉ½±°èìÁ…‘‘¥¹!½É¥é½¹Ñ…°èÑ¡•µ”¹ÍÁ…¥¹œ¹±œ°Á…‘‘¥¹	½ÑÑ½´è€ØÀô°(€€€Ý½É­™±½ÝM•Ñ¥½¸èì(€€€€€‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹ÍÕÉ™…•M•½¹‘…Éä°(€€€€€‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°(€€€€€‰½É‘•É]¥‘Ñ è€Ä°(€€€€€‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰½É‘•È°(€€€€€µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹±œ°(€€€€€Á…‘‘¥¹œè€ÈÀ°(€€€ô°(€€€Ý½É­™±½Ý½¹Ñ•¹Ðèì(€€€€€‰½É‘•ÉQ½Á]¥‘Ñ èMÑå±•M¡••Ð¹¡…¥É±¥¹•]¥‘Ñ °(€€€€€‰½É‘•ÉQ½Á½±½ÈèÑ¡•µ”¹½±½È¹‰½É‘•È°(€€€€€Á…‘‘¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹Í´°(€€€€€Á…‘‘¥¹	½ÑÑ½´èÑ¡•µ”¹ÍÁ…¥¹œ¹áÌ°(€€€ô°(€€€Ý½É­™±½ÝMÑ…ÑÕÌèì(€€€€€™±•á¥É•Ñ¥½¸è€‰É½Üˆ°(€€€€€…±¥¹%Ñ•µÌè€‰™±•àµÍÑ…ÉÐˆ°(€€€€€…ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°(€€€€€Á…‘‘¥¹Y•ÉÑ¥…°è€ÄÐ°(€€€€€‰½É‘•É	½ÑÑ½µ]¥‘Ñ èMÑå±•M¡••Ð¹¡…¥É±¥¹•]¥‘Ñ °(€€€€€‰½É‘•É	½ÑÑ½µ½±½ÈèÑ¡•µ”¹½±½È¹‰½É‘•È°(€€€ô°(€€€Ý½É­™±½ÝMÑ…ÑÕÍ%½¸èìÝ¥‘Ñ è€ÌØ°¡•¥¡Ðè€ÌØ°‰½É‘•ÉI…‘¥ÕÌè€Äà°…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€‰•¹Ñ•Èˆô°(€€€Ý½É­™±½ÝMÑ…ÑÕÍ½Áäèì™±•àè€Ä°µ¥¹]¥‘Ñ è€Àô°(€€€Ý½É­™±½ÝMÑ…ÑÕÍQ¥Ñ±•I½Üèì™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°…ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹Í´ô°(€€€Ý½É­™±½ÝMÑ…ÑÕÍ	…‘”èì™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°…Àè€Ô°‰½É‘•É]¥‘Ñ è€Ä°‰½É‘•ÉI…‘¥ÕÌè€äää°Á…‘‘¥¹!½É¥é½¹Ñ…°è€à°Á…‘‘¥¹Y•ÉÑ¥…°è€Ðô°(€€€Ý½É­™±½ÝMÑ…ÑÕÍ½ÐèìÝ¥‘Ñ è€Ø°¡•¥¡Ðè€Ø°‰½É‘•ÉI…‘¥ÕÌè€Ìô°(€€€Ý½É­™±½ÝMÑ…ÑÕÍ	…‘•Q•áÐèì™½¹ÑM¥é”è€ÄÀ°™½¹Ñ]•¥¡Ðè€ˆÜÀÀˆô°(€€€Ý½É­™±½ÝI½Üèì(€€€€€™±•á¥É•Ñ¥½¸è€‰É½Üˆ°(€€€€€…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°(€€€€€…ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°(€€€€€Á…‘‘¥¹Y•ÉÑ¥…°è€Äà°(€€€€€‰½É‘•É	½ÑÑ½µ]¥‘Ñ èMÑå±•M¡••Ð¹¡…¥É±¥¹•]¥‘Ñ °(€€€€€‰½É‘•É	½ÑÑ½µ½±½ÈèÑ¡•µ”¹½±½È¹‰½É‘•È°(€€€ô°(€€€Ý½É­™±½ÝI½Ý1…ÍÐèì‰½É‘•É	½ÑÑ½µ]¥‘Ñ è€Àô°(€€€±…‰•°èì™½¹ÑM¥é”è€ÄÐ°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆ°½±½ÈèÑ¡•µ”¹½±½È¹½¹MÕÉ™…”ô°4(€€€¡¥¹Ðèì™½¹ÑM¥é”è€ÄÈ°½±½ÈèÑ¡•µ”¹½±½È¹µÕÑ•°µ…É¥¹Q½Àè€Ðô°4(€€€¥¹ÁÕÐèì4(€€€€€µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°4(€€€€€‰½É‘•É]¥‘Ñ è€Ä°4(€€€€€‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰½É‘•È°4(€€€€€‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹ÍÕÉ™…”°4(€€€€€‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°4(€€€€€Á…‘‘¥¹œèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°4(€€€€€™½¹ÑM¥é”è€ÄÐ°4(€€€€€½±½ÈèÑ¡•µ”¹½±½È¹½¹MÕÉ™…”°4(€€€ô°4(€€€ÁÉ¥µ…Éå	Ñ¸èì4(€€€€€‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éä°4(€€€€€Á…‘‘¥¹œèÑ¡•µ”¹ÍÁ…¥¹œ¹±œ°4(€€€€€‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°4(€€€€€…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°4(€€€€€µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹±œ°4(€€€ô°4(€€€ÁÉ¥µ…ÉåQ•áÐèì½±½Èè€ˆ™™˜ˆ°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆ°™½¹ÑM¥é”è€ÄÔô°4(€€€Í•½¹‘…Éå	Ñ¸èì4(€€€€€µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°4(€€€€€Á…‘‘¥¹œèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°4(€€€€€‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°4(€€€€€…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°4(€€€€€‰½É‘•É]¥‘Ñ è€Ä°4(€€€€€‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éä°4(€€€ô°4(€€€Í•½¹‘…ÉåQ•áÐèì½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éä°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆ°™½¹ÑM¥é”è€ÄÐô°4(€€€ÍÑ…ÑÕÌèì4(€€€€€™±•á¥É•Ñ¥½¸è€‰É½Üˆ°4(€€€€€…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°4(€€€€€…Àè€à°4(€€€€€Á…‘‘¥¹œèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°4(€€€€€‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°4(€€€€€µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°4(€€€ô°4(€€€ÍÑ…ÑÕÍQ•áÐèì™½¹ÑM¥é”è€ÄÌ°™½¹Ñ]•¥¡Ðè€ˆÔÀÀˆ°™±•àè€Äô°4(€€€µ½‘•I½Üèì™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…Àè€à°µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µô°4(€€€µ½‘•	Ñ¸èì4(€€€€€™±•àè€Ä°™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€‰•¹Ñ•Èˆ°4(€€€€€…Àè€Ø°Á…‘‘¥¹œèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°4(€€€€€‰½É‘•É]¥‘Ñ è€Ä°‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰½É‘•È°‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹ÍÕÉ™…”°4(€€€ô°4(€€€µ½‘•	Ñ¹Ñ¥Ù”èì‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éä°‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éäô°4(€€€µ½‘•Q•áÐèì™½¹ÑM¥é”è€ÄÌ°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆ°½±½ÈèÑ¡•µ”¹½±½È¹½¹MÕÉ™…”ô°4(€€€µ½‘•Q•áÑÑ¥Ù”èì½±½ÈèÑ¡•µ”¹½±½È¹½¹	É…¹‘AÉ¥µ…Éäô°4(€€€ÕÉÉ•¹å¡¥Àèì4(€€€€€™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€‰•¹Ñ•Èˆ°4(€€€€€Á…‘‘¥¹Y•ÉÑ¥…°è€ÄÀ°Á…‘‘¥¹!½É¥é½¹Ñ…°è€ÄÐ°‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°4(€€€€€‰½É‘•É]¥‘Ñ è€Ä°‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰½É‘•È°‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹ÍÕÉ™…”°4(€€€€€µ¥¹]¥‘Ñ è€àà°4(€€€ô°4(€€€ÕÉÉ•¹å¡¥ÁÑ¥Ù”èì‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éä°‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éäô°4(€€€ÕÉÉ•¹å¡¥ÁQ•áÐèì™½¹ÑM¥é”è€ÄÐ°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆ°½±½ÈèÑ¡•µ”¹½±½È¹½¹MÕÉ™…”ô°4(€€€ÕÉÉ•¹å¡¥ÁQ•áÑÑ¥Ù”èì½±½ÈèÑ¡•µ”¹½±½È¹½¹	É…¹‘AÉ¥µ…Éäô°4(€€€‰…­ÕÁI½Üèì™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…Àè€à°µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µô°4(€€€‰…­ÕÁ	Ñ¸èì4(€€€€€™±•àè€Ä°™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€‰•¹Ñ•Èˆ°…Àè€Ø°4(€€€€€Á…‘‘¥¹œèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°4(€€€ô°4(€€€‰…­ÕÁ	Ñ¹AÉ¥µ…Éäèì‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éäô°4(€€€‰…­ÕÁ	Ñ¹M•½¹‘…Éäèì‰½É‘•É]¥‘Ñ è€Ä°‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éä°‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹ÍÕÉ™…•M•½¹‘…Éäô°4(€€€‰…­ÕÁ	Ñ¹Q•áÑAÉ¥µ…Éäèì½±½Èè€ˆ™™˜ˆ°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆ°™½¹ÑM¥é”è€ÄÌô°4(€€€‰…­ÕÁ	Ñ¹Q•áÑM•½¹‘…Éäèì½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éä°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆ°™½¹ÑM¥é”è€ÄÌô°4(€€€É•Í•Ñ%¹¥Ñ	Ñ¸èì4(€€€€€™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€‰•¹Ñ•Èˆ°…Àè€Ø°4(€€€€€Á…‘‘¥¹œèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°4(€€€€€‰½É‘•É]¥‘Ñ è€Ä°‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹•ÉÉ½È°µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°4(€€€ô°4(€€€É•Í•Ñ%¹¥ÑQ•áÐèì½±½ÈèÑ¡•µ”¹½±½È¹•ÉÉ½È°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆ°™½¹ÑM¥é”è€ÄÌô°4(€€€É•Í•Ñ…¹•±	Ñ¸èì™±•àè€Ä°Á…‘‘¥¹œèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°‰½É‘•É]¥‘Ñ è€Ä°‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰½É‘•È°‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹ÍÕÉ™…•M•½¹‘…Éäô°4(€€€É•Í•Ñ…¹•±Q•áÐèì½±½ÈèÑ¡•µ”¹½±½È¹½¹MÕÉ™…”°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆ°™½¹ÑM¥é”è€ÄÌô°4(€€€É•Í•Ñ½¹™¥Éµ	Ñ¸èì™±•àè€Ä¸Ð°Á…‘‘¥¹œèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹•ÉÉ½Èô°4(€€€É•Í•Ñ½¹™¥ÉµQ•áÐèì½±½Èè€ˆ™™˜ˆ°™½¹Ñ]•¥¡Ðè€ˆÜÀÀˆ°™½¹ÑM¥é”è€ÄÌô°4(€€€•¹ÑÉåI½Üèì™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°…Àè€àô°4(€€€•¹ÑÉå%¹ÁÕÐèì™±•àè€Äô°4(€€€•¹ÑÉåµ½Õ¹ÐèìÝ¥‘Ñ è€ÄÄÀô°4(€€€µ•µ‰•É…Éèì‰½É‘•É]¥‘Ñ è€Ä°‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰½É‘•È°‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°Á…‘‘¥¹œèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µô°4(€€€ÍÕ‰1…‰•°èì™½¹ÑM¥é”è€ÄÄ°½±½ÈèÑ¡•µ”¹½±½È¹µÕÑ•°µ…É¥¹Q½Àè€Èô°4(€€€±½­Q½±”èì4(€€€€€™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€‰•¹Ñ•Èˆ°…Àè€à°4(€€€€€Á…‘‘¥¹œèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°4(€€€€€‰½É‘•É]¥‘Ñ è€Ä°‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰½É‘•È°‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹ÍÕÉ™…”°4(€€€€€µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°4(€€€ô°4(€€€±½­Q½±•=¸èì‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éä°‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éäô°4(€€€±½­Q½±•Q•áÐèì™½¹ÑM¥é”è€ÄÐ°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆ°½±½ÈèÑ¡•µ”¹½±½È¹½¹MÕÉ™…”ô°4(€€€‰½½­I½Üèì4(€€€€€™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°…Àè€à°4(€€€€€Á…‘‘¥¹œèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°4(€€€€€‰½É‘•É]¥‘Ñ è€Ä°‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰½É‘•È°‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹ÍÕÉ™…”°4(€€€€€µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹Í´°4(€€€ô°4(€€€‰½½­I½ÝÑ¥Ù”èì‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éä°‰…­É½Õ¹‘½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éä€¬€ˆÄÈˆô°4(€€€‰½½­9…µ”èì™±•àè€Ä°™½¹ÑM¥é”è€ÄÐ°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆ°½±½ÈèÑ¡•µ”¹½±½È¹½¹MÕÉ™…”ô°4(€€€É•µ½Ù•	Ñ¸èì4(€€€€€µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°4(€€€€€Á…‘‘¥¹œèÑ¡•µ”¹ÍÁ…¥¹œ¹Í´°4(€€€€€‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°4(€€€€€…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°4(€€€€€©ÕÍÑ¥™å½¹Ñ•¹Ðè€‰•¹Ñ•Èˆ°4(€€€ô°4(€€€…‘‘	Ñ¸èì4(€€€€€™±•á¥É•Ñ¥½¸è€‰É½Üˆ°…±¥¹%Ñ•µÌè€‰•¹Ñ•Èˆ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€‰•¹Ñ•Èˆ°…Àè€Ø°4(€€€€€Á…‘‘¥¹œèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°‰½É‘•ÉI…‘¥ÕÌèÑ¡•µ”¹É…‘¥ÕÌ¹µ°4(€€€€€‰½É‘•É]¥‘Ñ è€Ä°‰½É‘•É½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éä°µ…É¥¹Q½ÀèÑ¡•µ”¹ÍÁ…¥¹œ¹µ°4(€€€ô°4(€€€…‘‘Q•áÐèì½±½ÈèÑ¡•µ”¹½±½È¹‰É…¹‘AÉ¥µ…Éä°™½¹Ñ]•¥¡Ðè€ˆØÀÀˆ°™½¹ÑM¥é”è€ÄÌô°4(€ô¤ì4)ô4(