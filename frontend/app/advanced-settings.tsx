import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";

import { useTheme, useThemeMode, useAnimations } from "@/src/context/ThemeContext";
import { useOnboardingGate } from "@/src/context/OnboardingContext";
import { api, getAIConfig, setAIConfig } from "@/src/api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { askHistoryStorageKey } from "@/src/utils/askHistory";
import { PROVIDERS, type ProviderId } from "@/src/db/ai";
import { ScreenHeader, Card } from "@/src/components/UI";
import { GlowPressable } from "@/src/components/GlowPressable";
import { saveJsonFile, shareJsonFile, pickJsonFile } from "@/src/utils/share";
import { deviceHasLock, requireAuth } from "@/src/utils/lock";
import { PERSONAS, type PersonaId } from "@/src/accountingV2/config";
import { isValidDateString, normalizeDateInput, localTodayIso } from "@/src/utils/dateValidation";

const AccordionRow = ({ title, subtitle, isLast, expandedKey, setExpandedKey, children, theme }: any) => {
  const isExpanded = expandedKey === title;
  return (
    <View style={{ borderBottomWidth: isLast && !isExpanded ? 0 : 1, borderBottomColor: theme.color.border, backgroundColor: "transparent" }}>
      <GlowPressable
        topHighlight={false}
        haptic
        animateBorder
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
          minHeight: 48,
          paddingVertical: 12,
          paddingHorizontal: 0,
          marginHorizontal: 0,
          borderWidth: 0,
          borderRadius: 0,
        }}
      >
        <View style={{ flex: 1, paddingRight: 16 }}>
          <Text style={{ fontSize: 15, fontWeight: "500", color: theme.color.onSurface }}>{title}</Text>
          {subtitle && <Text style={{ fontSize: 12, color: theme.color.muted, marginTop: 4 }}>{subtitle}</Text>}
        </View>
        <Ionicons name={isExpanded ? "chevron-down" : "chevron-forward"} size={20} color={theme.color.muted} />
      </GlowPressable>
      {isExpanded && <View style={{ marginHorizontal: 0, marginBottom: 10, paddingHorizontal: 0, paddingVertical: 10, paddingTop: 4, backgroundColor: "transparent" }}>{children}</View>}
    </View>
  );
};

const AdvancedNavRow = ({ title, subtitle, icon, onPress, isLast = false, theme }: any) => (
  <View style={{ borderBottomWidth: isLast ? 0 : 1, borderBottomColor: theme.color.border, paddingBottom: isLast ? 0 : 10, marginBottom: isLast ? 0 : 10 }}>
    <GlowPressable
      topHighlight={false}
      haptic
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      restingBorderColor="transparent"
      hoverBorderColor={theme.color.brandPrimary}
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: 56,
        paddingVertical: 10,
        paddingHorizontal: 8,
        borderWidth: 1,
        borderColor: "transparent",
        borderRadius: theme.radius.md,
        backgroundColor: "transparent",
      }}
    >
      <Ionicons name={icon} size={24} color={theme.color.brandPrimary} style={{ marginRight: 14 }} />
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={{ fontSize: 15, fontWeight: "700", color: theme.color.onSurface }}>{title}</Text>
        <Text style={{ fontSize: 12, lineHeight: 17, color: theme.color.muted, marginTop: 4 }}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={22} color={theme.color.muted} />
    </GlowPressable>
  </View>
);

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
  const [aiDataMode, setAiDataMode] = useState<'summary' | 'detailed'>('summary');
  const [aiRememberHistory, setAiRememberHistory] = useState(false);
  const [customHostConfirmed, setCustomHostConfirmed] = useState(false);
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
  const [confirmFactoryReset, setConfirmFactoryReset] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const params = useLocalSearchParams<{ section?: string }>();

  const chooseProvider = (nextProvider: ProviderId) => {
    const meta = PROVIDERS.find((item) => item.id === nextProvider)!;
    setProvider(nextProvider);
    setModelName(meta.defaultModel);
    setBaseUrl(meta.defaultBaseUrl);
    setCustomHostConfirmed(nextProvider === 'gemini' || (meta.defaultBaseUrl.length > 0 && !transcriptionBaseUrl.trim()));
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
      const s = await api.getSettings();
      const cfg = await getAIConfig();
      setProvider(cfg.provider);
      setKey(cfg.apiKey || "");
      setModelName(cfg.model || "");
      setVisionModelName(cfg.visionModel || "");
      setTranscriptionModelName(cfg.transcriptionModel || "whisper-1");
      setTranscriptionBaseUrl(cfg.transcriptionBaseUrl || "");
      setTranscriptionKey(cfg.transcriptionApiKey || "");
      setBaseUrl(cfg.baseUrl || "");
      setAiDataMode(s.aiDataMode === 'detailed' ? 'detailed' : 'summary');
      setAiRememberHistory(s.aiRememberHistory === true);
      const providerMeta = PROVIDERS.find((item) => item.id === cfg.provider);
      const chatBaseUrl = cfg.baseUrl?.trim() || '';
      const defaultChatBaseUrl = providerMeta?.defaultBaseUrl?.replace(/\/+$/, '') || '';
      const hasCustomChatHost = Boolean(chatBaseUrl) && chatBaseUrl.replace(/\/+$/, '') !== defaultChatBaseUrl;
      const hasCustomVoiceHost = Boolean(cfg.transcriptionBaseUrl?.trim());
      setCustomHostConfirmed(cfg.provider === 'gemini' || (!hasCustomChatHost && !hasCustomVoiceHost) || s.aiCustomHostConfirmed === true);
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

  const toggleAiRememberHistory = async () => {
    const next = !aiRememberHistory;
    setAiRememberHistory(next);
    try {
      await api.updateSettings({ aiRememberHistory: next });
      if (!next) await AsyncStorage.removeItem(askHistoryStorageKey(api.activeBookId()));
      setStatus({ ok: true, msg: next ? "Ask AI history will be remembered on this device." : "Ask AI history was removed from this device." });
    } catch (e: any) {
      setAiRememberHistory(!next);
      setStatus({ ok: false, msg: e?.message || "Could not update Ask AI history setting." });
    }
  };

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
      if (isCustomProvider && (baseUrl.trim() || transcriptionBaseUrl.trim()) && !customHostConfirmed) {
        throw new Error('Confirm that you trust this custom AI host before saving its API key.');
      }
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
        aiDataMode,
        aiRememberHistory,
        aiCustomHostConfirmed: customHostConfirmed,
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
      if (isCustomProvider && (baseUrl.trim() || transcriptionBaseUrl.trim()) && !customHostConfirmed) {
        setTestResult({ ok: false, msg: 'Confirm that you trust this custom AI host first.' });
        return;
     ×NuöÚ$z{-®éÜj×G–ÆW2æÖöFUFW‡BÂ”FFÖöFRÓÓÒvFWF–ÆVBrbb7G–ÆW2æÖöFUFW‡D7F—fU×ÓäFWF–ÆVB6öçFW‡CÂõFW‡CãÂõ&W76&ÆSà¢Âõf–Wsà¢Å&W76&ÆR66W76–&–Æ—G•&öÆSÒ&6†V6¶&÷‚"66W76–&–Æ—G•7FFS×·²6†V6¶VC¢•&VÖVÖ&W$†—7F÷'’×Òöå&W73×²‚’Óâ²fö–BFövvÆT•&VÖVÖ&W$†—7F÷'’‚“²×Ò7G–ÆS×·7G–ÆW2ç6V7W&—G”6†V6µ&÷wÓà¢Ä–öæ–6öç2æÖS×¶•&VÖVÖ&W$†—7F÷'’ò&6†V6¶&÷‚"¢'7V&RÖ÷WFÆ–æR'Ò6—¦S×³#Ò6öÆ÷#×¶•&VÖVÖ&W$†—7F÷'’òF†VÖRæ6öÆ÷"æ'&æE&–Ö'’¢F†VÖRæ6öÆ÷"æ×WFVGÒóà¢ÅFW‡B7G–ÆS×·7G–ÆW2ç6V7W&—G”6†V6µFW‡GÓå&VÖVÖ&W"6²’6öçfW'6F–öâöâF†—2FWf–6RãÂõFW‡Cà¢Âõ&W76&ÆSà¢Âõf–Wsà¢Âô66÷&F–öå&÷sà¢Âô6&Cà ¢Ä6&B7G–ÆS×·7G–ÆW2æGfæ6VDw&÷WÓà¢ÅFW‡B7G–ÆS×·²föçE6—¦S¢bÂföçEvV–v‡C¢#c"Â6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’ÂÖ&v–ä&÷GFöÓ¢‚×Óå6V7W&—G’bFFÂõFW‡Cà¢ÅFW‡B7G–ÆS×·²föçE6—¦S¢2Â6öÆ÷#¢F†VÖRæ6öÆ÷"æ×WFVBÂÖ&v–ä&÷GFöÓ¢bÂÆ–æT†V–v‡C¢‚×Óå&÷FV7B–÷W"6Vç6—F—fR7F–öç2æB&6·W2ãÂõFW‡Cà¢Ä66÷&F–öå&÷rF—FÆSÒ$Æö6²"7V'F—FÆS×¶Æö6´Væ&ÆVBò$ôâ+rf–ævW'&–çBò”â"¢$ôdb+rf–ævW'&–çBò”â'ÒF†VÖS×·F†VÖWÒW‡æFVD¶W“×¶W‡æFVD¶W—Ò6WDW‡æFVD¶W“×·6WDW‡æFVD¶W—Óà¢Åf–Wsà¢ÅFW‡B7G–ÆS×·7G–ÆW2æ†–çGÓåW6R–÷W"†öæ^(	—2f–ævW'&–çBòf6Rò”âFò&÷FV7B6Vç6—F—fR7F–öç2ãÂõFW‡Cà¢Å&W76&ÆRöå&W73×²‚’Óâ6WDÆö6´Væ&ÆVB‚‡b’Óâb—Ò7G–ÆS×µ·7G–ÆW2æÆö6µFövvÆRÂÆö6´Væ&ÆVBbb7G–ÆW2æÆö6µFövvÆTöå×Óà¢Ä–öæ–6öç2æÖS×¶Æö6´Væ&ÆVBò&Æö6²Ö6Æ÷6VB"¢&Æö6²Ö÷VâÖ÷WFÆ–æR'Ò6—¦S×³‡Ò6öÆ÷#×¶Æö6´Væ&ÆVBòF†VÖRæ6öÆ÷"æöä'&æE&–Ö'’¢F†VÖRæ6öÆ÷"æöå7W&f6WÒóà¢ÅFW‡B7G–ÆS×µ·7G–ÆW2æÆö6µFövvÆUFW‡BÂÆö6´Væ&ÆVBbb²6öÆ÷#¢F†VÖRæ6öÆ÷"æöä'&æE&–Ö'’Õ×Óç¶Æö6´Væ&ÆVBò$Æö6²ôâ"¢$Æö6²ôdb'ÓÂõFW‡Cà¢Âõ&W76&ÆSà¢Âõf–Wsà¢Âô66÷&F–öå&÷sà¢Ä66÷&F–öå&÷rF—FÆSÒ$&6·Wb&W7F÷&R"7V'F—FÆSÒ$Væ7'—FVB&V6÷fW'’æBÆVv7’¥4ôâ"F†VÖS×·F†VÖWÒW‡æFVD¶W“×¶W‡æFVD¶W—Ò6WDW‡æFVD¶W“×·6WDW‡æFVD¶W—Óà¢Åf–Wsà¢ÅFW‡B7G–ÆS×·7G–ÆW2æ†–çGÓåW6R&6·Wb&V6÷fW'’f÷"Væ7'—FVBW‡÷'G2Â–çFVw&—G’6†V6·2Â&W7F÷&RG'’×'Vç2ÂæB&V6÷fW'’†—7F÷'’âF†RÆVv7’¥4ôâ'WGFöç2&VÖ–âf–Æ&ÆRf÷"6ö×F–&–Æ—G’v—F‚öÆFW"f–ÆW2ãÂõFW‡Cà¢Å&W76&ÆRFW7D”CÒ&÷VâÖ&6·W×&V6÷fW'’"öå&W73×²‚’Óâ&÷WFW"çW6‚‚rö&6·W×&V6÷fW'’r2ç’—Ò7G–ÆS×µ·7G–ÆW2æ&ööµ&÷rÂ²Ö&v–åF÷¢F†VÖRç76–æræÖBÂÖ&v–ä&÷GFöÓ¢F†VÖRç76–æræÖBÕ×ÓãÄ–öæ–6öç2æÖSÒ'6†–VÆBÖ6†V6¶Ö&²Ö÷WFÆ–æR"6—¦S×³#Ò6öÆ÷#×·F†VÖRæ6öÆ÷"æ'&æE&–Ö'—ÒóãÅf–Wr7G–ÆS×·²fÆWƒ¢×ÓãÅFW‡B7G–ÆS×·7G–ÆW2æ&öö´æÖWÓä÷Vâ&6·Wb&V6÷fW'“ÂõFW‡CãÅFW‡B7G–ÆS×·7G–ÆW2ç7V$Æ&VÇÓå&V6öÖÖVæFVBf÷"6Vç6—F—fRf–ææ6–ÂFFÂõFW‡CãÂõf–WsãÄ–öæ–6öç2æÖSÒ&6†Wg&öâÖf÷'v&B"6—¦S×³‡Ò6öÆ÷#×·F†VÖRæ6öÆ÷"æ×WFVGÒóãÂõ&W76&ÆSà¢ÅFW‡B7G–ÆS×µ·7G–ÆW2ç7V$Æ&VÂÂ²Ö&v–ä&÷GFöÓ¢F†VÖRç76–ærç6ÒÕ×ÓäÆVv7’¥4ôâ6ö×F–&–Æ—G“ÂõFW‡Cà¢Åf–Wr7G–ÆS×·7G–ÆW2æ&6·W&÷wÓà¢Å&W76&ÆR66W76–&–Æ—G•&öÆSÒ&'WGFöâ"66W76–&–Æ—G”Æ&VÃÒ%6†&R¥4ôâ&6·W"öå&W73×²‚’Óâ²fö–BFôW‡÷'B‚'6†&R"“²×ÒF—6&ÆVC×¶'W7’ÓÒçVÆÇÒ7G–ÆS×²‡²&W76VBÒ’Óâ·7G–ÆW2æ&6·W'FâÂ7G–ÆW2æ&6·W'Få&–Ö'’Â‡&W76VBÇÂ'W7’ÓÓÒ&W‡÷'B"’bb²÷6—G“¢ãƒRÕ×Óà¢¶'W7’ÓÓÒ&W‡÷'B"òÄ7F—f—G”–æF–6F÷"6öÆ÷#Ò"6ffb"óâ¢ÃãÄ–öæ–6öç2æÖSÒ'6†&RÖ÷WFÆ–æR"6—¦S×³‡Ò6öÆ÷#Ò"6ffb"óãÅFW‡B7G–ÆS×·7G–ÆW2æ&6·W'FåFW‡E&–Ö'—Óå6†&SÂõFW‡CãÂóçĞ¢Âõ&W76&ÆSà¢Å&W76&ÆRFW7D”CÒ&ÆVv7’×6fRÖFWf–6RÖ'WGFöâ"66W76–&–Æ—G•&öÆSÒ&'WGFöâ"66W76–&–Æ—G”Æ&VÃÒ%6fR¥4ôâ&6·WFòFWf–6R"öå&W73×²‚’Óâ²fö–BFôW‡÷'B‚'6fR"“²×ÒF—6&ÆVC×¶'W7’ÓÒçVÆÇÒ7G–ÆS×²‡²&W76VBÒ’Óâ·7G–ÆW2æ&6·W'FâÂ7G–ÆW2æ&6·W'Få6V6öæF'’Â‡&W76VBÇÂ'W7’ÓÓÒ'6fR"’bb²÷6—G“¢ãƒRÕ×Óà¢¶'W7’ÓÓÒ'6fR"òÄ7F—f—G”–æF–6F÷"6öÆ÷#×·F†VÖRæ6öÆ÷"æ'&æE&–Ö'—Òóâ¢ÃãÄ–öæ–6öç2æÖSÒ&F÷væÆöBÖ÷WFÆ–æR"6—¦S×³‡Ò6öÆ÷#×·F†VÖRæ6öÆ÷"æ'&æE&–Ö'—ÒóãÅFW‡B7G–ÆS×·7G–ÆW2æ&6·W'FåFW‡E6V6öæF'—Óå6fSÂõFW‡CãÂóçĞ¢Âõ&W76&ÆSà¢Å&W76&ÆRöå&W73×¶Fô–×÷'GÒF—6&ÆVC×¶'W7’ÓÒçVÆÇÒ7G–ÆS×²‡²&W76VBÒ’Óâ·7G–ÆW2æ&6·W'FâÂ7G–ÆW2æ&6·W'Få6V6öæF'’Â‡&W76VBÇÂ'W7’ÓÓÒ&–×÷'B"’bb²÷6—G“¢ãƒRÕ×Óà¢¶'W7’ÓÓÒ&–×÷'B"òÄ7F—f—G”–æF–6F÷"6öÆ÷#×·F†VÖRæ6öÆ÷"æ'&æE&–Ö'—Òóâ¢ÃãÄ–öæ–6öç2æÖSÒ&6Æ÷VB×WÆöBÖ÷WFÆ–æR"6—¦S×³‡Ò6öÆ÷#×·F†VÖRæ6öÆ÷"æ'&æE&–Ö'—ÒóãÅFW‡B7G–ÆS×·7G–ÆW2æ&6·W'FåFW‡E6V6öæF'—Óä–×÷'CÂõFW‡CãÂóçĞ¢Âõ&W76&ÆSà¢Âõf–Wsà¢Âõf–Wsà¢Âô66÷&F–öå&÷sà¢Ä66÷&F–öå&÷rF—FÆSÒ$FævW"¦öæR ¢7V'F—FÆSÒ$6ÆV"66÷VçF–ærFF÷"&W6WBF†—2FWf–6R"—4Æ7BF†VÖS×·F†VÖWÒW‡æFVD¶W“×¶W‡æFVD¶W—Ò6WDW‡æFVD¶W“×·6WDW‡æFVD¶W—Óà¢Åf–Wsà¢ÅFW‡B7G–ÆS×·7G–ÆW2æ†–çGÓä6ÆV"66÷VçF–ærFF&VÖ÷fW2&öö·2ÂG&ç67F–öç2Â'W6–æW7266÷VçG2Â–çfVçF÷'’æBW&–öG2v†–ÆR&W6W'f–ær&VfW&Væ6W2æB’6öæf–wW&F–öââf7F÷'’&W6WBÇ6ò&VÖ÷fW2'W6–æW726WGF–æw2æB’7&VFVçF–Ç2ãÂõFW‡Cà¢²6öæf—&Õ&W6WBò€¢Å&W76&ÆRöå&W73×²‚’Óâ6WD6öæf—&Õ&W6WB‡G'VR—Ò7G–ÆS×·7G–ÆW2ç&W6WD–æ—D'FçÓãÄ–öæ–6öç2æÖSÒ'G&6‚Ö÷WFÆ–æR"6—¦S×³gÒ6öÆ÷#×·F†VÖRæ6öÆ÷"æW'&÷'ÒóãÅFW‡B7G–ÆS×·7G–ÆW2ç&W6WD–æ—EFW‡GÓä6ÆV"66÷VçF–ærFF(
cÂõFW‡CãÂõ&W76&ÆSà¢’¢€¢Åf–Wr7G–ÆS×·²Ö&v–åF÷¢F†VÖRç76–æræÖB×Óà¢ÅFW‡B7G–ÆS×µ·7G–ÆW2æ†–çBÂ²6öÆ÷#¢F†VÖRæ6öÆ÷"æW'&÷"ÂföçEvV–v‡C¢#c"Õ×ÓåF†—26ææ÷B&RVæFöæRâ6öç6–FW"W‡÷'F–ær&6·Wf—'7BãÂõFW‡Cà¢Åf–Wr7G–ÆS×·²fÆW„F—&V7F–öã¢'&÷r"Âv¢‚ÂÖ&v–åF÷¢F†VÖRç76–ærç6Ò×Óà¢Å&W76&ÆRöå&W73×²‚’Óâ6WD6öæf—&Õ&W6WB†fÇ6R—Ò7G–ÆS×·7G–ÆW2ç&W6WD6æ6VÄ'FçÓãÅFW‡B7G–ÆS×·7G–ÆW2ç&W6WD6æ6VÅFW‡GÓä6æ6VÃÂõFW‡CãÂõ&W76&ÆSà¢Å&W76&ÆRöå&W73×¶Fõ&W6WGÒF—6&ÆVC×·&W6WGF–æwÒ7G–ÆS×·7G–ÆW2ç&W6WD6öæf—&Ô'FçÓç·&W6WGF–æròÄ7F—f—G”–æF–6F÷"6öÆ÷#Ò"6ffb"óâ¢ÅFW‡B7G–ÆS×·7G–ÆW2ç&W6WD6öæf—&ÕFW‡GÓå–W2Â6ÆV"66÷VçF–ærFFÂõFW‡CçÓÂõ&W76&ÆSà¢Âõf–Wsà¢Âõf–Wsà¢—Ğ¢²6öæf—&Ôf7F÷'•&W6WBò€¢Å&W76&ÆRöå&W73×²‚’Óâ6WD6öæf—&Ôf7F÷'•&W6WB‡G'VR—Ò7G–ÆS×µ·7G–ÆW2ç&W6WD–æ—D'FâÂ²&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æW'&÷"²#“’"Õ×ÓãÄ–öæ–6öç2æÖSÒ'v&æ–ærÖ÷WFÆ–æR"6—¦S×³gÒ6öÆ÷#×·F†VÖRæ6öÆ÷"æW'&÷'ÒóãÅFW‡B7G–ÆS×·7G–ÆW2ç&W6WD–æ—EFW‡GÓäf7F÷'’&W6WBFWf–6^(
cÂõFW‡CãÂõ&W76&ÆSà¢’¢€¢Åf–Wr7G–ÆS×·²Ö&v–åF÷¢F†VÖRç76–æræÖB×Óà¢ÅFW‡B7G–ÆS×µ·7G–ÆW2æ†–çBÂ²6öÆ÷#¢F†VÖRæ6öÆ÷"æW'&÷"ÂföçEvV–v‡C¢#c"Õ×ÓåF†—2v—W2WfW'—F†–ær(	BÆÂ&öö·2b&V6÷&G2Â'W6–æW726öæf–wW&F–öâÂF†R6fVB’¶W’ÂæB–÷W"&VfW&Væ6W2‡F†VÖRÂæ–ÖF–öç2ÂF6†&ö&BÆ–÷WB’(	BF†Vâ&WGW&ç2Fòöæ&ö&F–ærãÂõFW‡Cà¢Åf–Wr7G–ÆS×·²fÆW„F—&V7F–öã¢'&÷r"Âv¢‚ÂÖ&v–åF÷¢F†VÖRç76–ærç6Ò×Óà¢Å&W76&ÆRöå&W73×²‚’Óâ6WD6öæf—&Ôf7F÷'•&W6WB†fÇ6R—Ò7G–ÆS×·7G–ÆW2ç&W6WD6æ6VÄ'FçÓãÅFW‡B7G–ÆS×·7G–ÆW2ç&W6WD6æ6VÅFW‡GÓä6æ6VÃÂõFW‡CãÂõ&W76&ÆSà¢Å&W76&ÆRöå&W73×¶Fôf7F÷'•&W6WGÒF—6&ÆVC×·&W6WGF–æwÒ7G–ÆS×·7G–ÆW2ç&W6WD6öæf—&Ô'FçÓç·&W6WGF–æròÄ7F—f—G”–æF–6F÷"6öÆ÷#Ò"6ffb"óâ¢ÅFW‡B7G–ÆS×·7G–ÆW2ç&W6WD6öæf—&ÕFW‡GÓå–W2Âf7F÷'’&W6WCÂõFW‡CçÓÂõ&W76&ÆSà¢Âõf–Wsà¢Âõf–Wsà¢—Ğ¢Âõf–Wsà¢Âô66÷&F–öå&÷sà¢Âô6&Cà ¢·7FGW2bb€¢Åf–Wr7G–ÆS×µ·7G–ÆW2ç7FGW2Â²&6¶w&÷VæD6öÆ÷#¢7FGW2æö²òF†VÖRæ6öÆ÷"ç7V66W74&r¢F†VÖRæ6öÆ÷"æW'&÷$&rÕ×Óà¢Ä–öæ–6öç2æÖS×·7FGW2æö²ò&6†V6¶Ö&²Ö6—&6ÆR"¢&ÆW'BÖ6—&6ÆR'Ò6—¦S×³‡Ò6öÆ÷#×·7FGW2æö²òF†VÖRæ6öÆ÷"ç7V66W72¢F†VÖRæ6öÆ÷"æW'&÷'Òóà¢ÅFW‡B7G–ÆS×µ·7G–ÆW2ç7FGW5FW‡BÂ²6öÆ÷#¢7FGW2æö²òF†VÖRæ6öÆ÷"ç7V66W72¢F†VÖRæ6öÆ÷"æW'&÷"Õ×Óç·7FGW2æ×6wÓÂõFW‡Cà¢Âõf–Wsà¢—Ğ ¢Å&W76&ÆRFW7D”CÒ&'Fâ×6fR×6WGF–æw2"öå&W73×·6fWÒF—6&ÆVC×·6f–æwÒ7G–ÆS×²‡²&W76VBÒ’Óâ·7G–ÆW2ç&–Ö'”'FâÂ‡&W76VBÇÂ6f–ær’bb²÷6—G“¢ãƒRÕ×Óà¢·6f–æròÄ7F—f—G”–æF–6F÷"6öÆ÷#Ò"6ffb"óâ¢ÅFW‡B7G–ÆS×·7G–ÆW2ç&–Ö'•FW‡GÓå6fR6WGF–æw3ÂõFW‡CçĞ¢Âõ&W76&ÆSà¢Åf–Wr7G–ÆS×·²†V–v‡C¢#×Òóà¢Âõ67&öÆÅf–Wsà¢Âô¶W–&ö&Dfö–F–æuf–Wsà¢—Ğ¢Âõ6fT&Vf–Wsà¢“°§Ğ ¦gVæ7F–öâÖ¶U7G–ÆW2‡F†VÖS¢ç’’°¢&WGW&â7G–ÆU6†VWBæ7&VFR‡°¢6öçF–æW#¢²fÆWƒ¢Â&6¶w&÷VæD6öÆ÷#¢F†VÖRæ6öÆ÷"ç7W&f6RÒÀ¢67&öÆÃ¢²FF–æt†÷&—¦öçFÃ¢F†VÖRç76–æræÆrÂFF–æt&÷GFöÓ¢ƒÒÀ¢Gfæ6VD†VFW#¢²FF–æuF÷¢#ÂFF–æt&÷GFöÓ¢ÒÀ¢Gfæ6VDw&÷W¢²Ö&v–åF÷¢F†VÖRç76–æræÆrÂFF–æs¢#ÒÀ¢Æ&VÃ¢²föçE6—¦S¢BÂföçEvV–v‡C¢#c"Â6öÆ÷#¢F†VÖRæ6öÆ÷"æöå7W&f6RÒÀ¢†–çC¢²föçE6—¦S¢"ÂÆ–æT†V–v‡C¢‚Â6öÆ÷#¢F†VÖRæ6öÆ÷"æ×WFVBÂÖ&v–åF÷¢BÒÀ¢–çWC¢°¢Ö&v–åF÷¢F†VÖRç76–æræÖBÀ¢&÷&FW%v–GFƒ¢À¢&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æ&÷&FW"À¢&6¶w&÷VæD6öÆ÷#¢'G&ç7&VçB"À¢&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÀ¢FF–æs¢F†VÖRç76–æræÖBÀ¢föçE6—¦S¢BÀ¢6öÆ÷#¢F†VÖRæ6öÆ÷"æöå7W&f6RÀ¢ÒÀ¢&–Ö'”'Fã¢°¢&6¶w&÷VæD6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’À¢FF–æs¢F†VÖRç76–æræÆrÀ¢&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÀ¢Æ–vä—FV×3¢&6VçFW""À¢Ö&v–åF÷¢F†VÖRç76–æræÆrÀ¢ÒÀ¢&–Ö'•FW‡C¢²6öÆ÷#¢"6ffb"ÂföçEvV–v‡C¢#c"ÂföçE6—¦S¢RÒÀ¢6V6öæF'”'Fã¢°¢Ö&v–åF÷¢F†VÖRç76–æræÖBÀ¢FF–æs¢F†VÖRç76–æræÖBÀ¢&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÀ¢Æ–vä—FV×3¢&6VçFW""À¢&÷&FW%v–GFƒ¢À¢&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’À¢ÒÀ¢6V6öæF'•FW‡C¢²6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’ÂföçEvV–v‡C¢#c"ÂföçE6—¦S¢BÒÀ¢7FGW3¢°¢fÆW„F—&V7F–öã¢'&÷r"À¢Æ–vä—FV×3¢&6VçFW""À¢v¢‚À¢FF–æs¢F†VÖRç76–æræÖBÀ¢&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÀ¢Ö&v–åF÷¢F†VÖRç76–æræÖBÀ¢ÒÀ¢7FGW5FW‡C¢²föçE6—¦S¢2ÂföçEvV–v‡C¢#S"ÂfÆWƒ¢ÒÀ¢ÖöFU&÷s¢²fÆW„F—&V7F–öã¢'&÷r"Âv¢‚ÂÖ&v–åF÷¢F†VÖRç76–æræÖBÒÀ¢ÖöFT'Fã¢°¢fÆWƒ¢ÂfÆW„F—&V7F–öã¢'&÷r"ÂÆ–vä—FV×3¢&6VçFW""Â§W7F–g”6öçFVçC¢&6VçFW""À¢v¢bÂFF–æs¢F†VÖRç76–æræÖBÂ&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÀ¢&÷&FW%v–GFƒ¢Â&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æ&÷&FW"Â&6¶w&÷VæD6öÆ÷#¢'G&ç7&VçB"À¢ÒÀ¢ÖöFT'Fä7F—fS¢²&6¶w&÷VæD6öÆ÷#¢'G&ç7&VçB"Â&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’ÒÀ¢ÖöFUFW‡C¢²föçE6—¦S¢2ÂföçEvV–v‡C¢#c"Â6öÆ÷#¢F†VÖRæ6öÆ÷"æöå7W&f6RÒÀ¢ÖöFUFW‡D7F—fS¢²6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’ÒÀ¢6V7W&—G”6†V6µ&÷s¢²fÆW„F—&V7F–öã¢'&÷r"ÂÆ–vä—FV×3¢&6VçFW""Âv¢‚ÂÖ&v–åF÷¢F†VÖRç76–æræÖBÂFF–æufW'F–6Ã¢‚ÒÀ¢6V7W&—G”6†V6µFW‡C¢²fÆWƒ¢ÂföçE6—¦S¢"ÂÆ–æT†V–v‡C¢‚Â6öÆ÷#¢F†VÖRæ6öÆ÷"æöå7W&f6RÒÀ¢7W'&Væ7”6†—¢°¢fÆW„F—&V7F–öã¢'&÷r"ÂÆ–vä—FV×3¢&6VçFW""Â§W7F–g”6öçFVçC¢&6VçFW""À¢FF–æufW'F–6Ã¢ÂFF–æt†÷&—¦öçFÃ¢BÂ&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÀ¢&÷&FW%v–GFƒ¢Â&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æ&÷&FW"Â&6¶w&÷VæD6öÆ÷#¢F†VÖRæ6öÆ÷"ç7W&f6RÀ¢Ö–åv–GFƒ¢ƒ‚À¢ÒÀ¢7W'&Væ7”6†—7F—fS¢²&6¶w&÷VæD6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’Â&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’ÒÀ¢7W'&Væ7”6†—FW‡C¢²föçE6—¦S¢BÂföçEvV–v‡C¢#c"Â6öÆ÷#¢F†VÖRæ6öÆ÷"æöå7W&f6RÒÀ¢7W'&Væ7”6†—FW‡D7F—fS¢²6öÆ÷#¢F†VÖRæ6öÆ÷"æöä'&æE&–Ö'’ÒÀ¢&6·W&÷s¢²fÆW„F—&V7F–öã¢'&÷r"Âv¢‚ÂÖ&v–åF÷¢F†VÖRç76–æræÖBÒÀ¢&6·W'Fã¢°¢fÆWƒ¢ÂfÆW„F—&V7F–öã¢'&÷r"ÂÆ–vä—FV×3¢&6VçFW""Â§W7F–g”6öçFVçC¢&6VçFW""Âv¢bÀ¢FF–æs¢F†VÖRç76–æræÖBÂ&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÀ¢ÒÀ¢&6·W'Få&–Ö'“¢²&6¶w&÷VæD6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’ÒÀ¢&6·W'Få6V6öæF'“¢²&÷&FW%v–GFƒ¢Â&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’Â&6¶w&÷VæD6öÆ÷#¢'G&ç7&VçB"ÒÀ¢&6·W'FåFW‡E&–Ö'“¢²6öÆ÷#¢"6ffb"ÂföçEvV–v‡C¢#c"ÂföçE6—¦S¢2ÒÀ¢&6·W'FåFW‡E6V6öæF'“¢²6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’ÂföçEvV–v‡C¢#c"ÂföçE6—¦S¢2ÒÀ¢&W6WD–æ—D'Fã¢°¢fÆW„F—&V7F–öã¢'&÷r"ÂÆ–vä—FV×3¢&6VçFW""Â§W7F–g”6öçFVçC¢&6VçFW""Âv¢bÀ¢FF–æs¢F†VÖRç76–æræÖBÂ&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÀ¢&÷&FW%v–GFƒ¢Â&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æW'&÷"ÂÖ&v–åF÷¢F†VÖRç76–æræÖBÀ¢ÒÀ¢&W6WD–æ—EFW‡C¢²6öÆ÷#¢F†VÖRæ6öÆ÷"æW'&÷"ÂföçEvV–v‡C¢#c"ÂföçE6—¦S¢2ÒÀ¢&W6WD6æ6VÄ'Fã¢²fÆWƒ¢ÂFF–æs¢F†VÖRç76–æræÖBÂ&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÂÆ–vä—FV×3¢&6VçFW""Â&÷&FW%v–GFƒ¢Â&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æ&÷&FW"Â&6¶w&÷VæD6öÆ÷#¢'G&ç7&VçB"ÒÀ¢&W6WD6æ6VÅFW‡C¢²6öÆ÷#¢F†VÖRæ6öÆ÷"æöå7W&f6RÂföçEvV–v‡C¢#c"ÂföçE6—¦S¢2ÒÀ¢&W6WD6öæf—&Ô'Fã¢²fÆWƒ¢ãBÂFF–æs¢F†VÖRç76–æræÖBÂ&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÂÆ–vä—FV×3¢&6VçFW""Â&6¶w&÷VæD6öÆ÷#¢F†VÖRæ6öÆ÷"æW'&÷"ÒÀ¢&W6WD6öæf—&ÕFW‡C¢²6öÆ÷#¢"6ffb"ÂföçEvV–v‡C¢#s"ÂföçE6—¦S¢2ÒÀ¢VçG'•&÷s¢²fÆW„F—&V7F–öã¢'&÷r"ÂÆ–vä—FV×3¢&6VçFW""Âv¢‚ÒÀ¢VçG'”–çWC¢²fÆWƒ¢ÒÀ¢VçG'”Ö÷VçC¢²v–GFƒ¢ÒÀ¢ÖVÖ&W$6&C¢²&÷&FW%v–GFƒ¢Â&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æ&÷&FW"Â&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÂFF–æs¢F†VÖRç76–æræÖBÂÖ&v–åF÷¢F†VÖRç76–æræÖBÒÀ¢7V$Æ&VÃ¢²föçE6—¦S¢ÂÆ–æT†V–v‡C¢bÂ6öÆ÷#¢F†VÖRæ6öÆ÷"æ×WFVBÂÖ&v–åF÷¢"ÒÀ¢Æö6µFövvÆS¢°¢fÆW„F—&V7F–öã¢'&÷r"ÂÆ–vä—FV×3¢&6VçFW""Â§W7F–g”6öçFVçC¢&6VçFW""Âv¢‚À¢FF–æs¢F†VÖRç76–æræÖBÂ&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÀ¢&÷&FW%v–GFƒ¢Â&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æ&÷&FW"Â&6¶w&÷VæD6öÆ÷#¢F†VÖRæ6öÆ÷"ç7W&f6RÀ¢Ö&v–åF÷¢F†VÖRç76–æræÖBÀ¢ÒÀ¢Æö6µFövvÆTöã¢²&6¶w&÷VæD6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’Â&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’ÒÀ¢Æö6µFövvÆUFW‡C¢²föçE6—¦S¢BÂföçEvV–v‡C¢#c"Â6öÆ÷#¢F†VÖRæ6öÆ÷"æöå7W&f6RÒÀ¢&ööµ&÷s¢°¢fÆW„F—&V7F–öã¢'&÷r"ÂÆ–vä—FV×3¢&6VçFW""Âv¢‚À¢FF–æs¢F†VÖRç76–æræÖBÂ&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÀ¢&÷&FW%v–GFƒ¢Â&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æ&÷&FW"Â&6¶w&÷VæD6öÆ÷#¢'G&ç7&VçB"À¢Ö&v–åF÷¢F†VÖRç76–ærç6ÒÀ¢ÒÀ¢&ööµ&÷t7F—fS¢²&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’Â&6¶w&÷VæD6öÆ÷#¢'G&ç7&VçB"ÒÀ¢&öö´æÖS¢²fÆWƒ¢ÂföçE6—¦S¢BÂföçEvV–v‡C¢#c"Â6öÆ÷#¢F†VÖRæ6öÆ÷"æöå7W&f6RÒÀ¢&VÖ÷fT'Fã¢°¢Ö&v–åF÷¢F†VÖRç76–æræÖBÀ¢FF–æs¢F†VÖRç76–ærç6ÒÀ¢&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÀ¢Æ–vä—FV×3¢&6VçFW""À¢§W7F–g”6öçFVçC¢&6VçFW""À¢ÒÀ¢FD'Fã¢°¢fÆW„F—&V7F–öã¢'&÷r"ÂÆ–vä—FV×3¢&6VçFW""Â§W7F–g”6öçFVçC¢&6VçFW""Âv¢bÀ¢FF–æs¢F†VÖRç76–æræÖBÂ&÷&FW%&F—W3¢F†VÖRç&F—W2æÖBÀ¢&÷&FW%v–GFƒ¢Â&÷&FW$6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’ÂÖ&v–åF÷¢F†VÖRç76–æræÖBÀ¢ÒÀ¢FEFW‡C¢²6öÆ÷#¢F†VÖRæ6öÆ÷"æ'&æE&–Ö'’ÂföçEvV–v‡C¢#c"ÂföçE6—¦S¢2ÒÀ¢Ò“°§Ğ