import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, TextInput, Alert, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/db/local";
import { Card } from "@/src/components/UI";
import {
  mapAnalyzedDocument,
  buildBalancedOpeningSet,
  normalizeScanDate,
  isValidScanAmount,
  AMOUNT_BOUNDS_REASON,
  DATE_BOUNDS_REASON,
  type ScanRow,
  type FlaggedScanRow,
} from "@/src/accountingV2/scanImport";
import { normalizeDateInput, isValidDateString } from "@/src/utils/dateValidation";

// Source tag prefixed onto every note/memo this screen writes (same convention
// as [AI] on ask.tsx and [Reconcile] on reconcile.tsx).
const SCAN_TAG = "[Scan]";
const scanNote = (base?: string) => `${SCAN_TAG} ${base || "Imported from document"}`.trim();

// Hard cap on the base64 payload we send to the AI provider (~8MB of base64).
const MAX_BASE64_CHARS = 8 * 1024 * 1024;

type RowStatus = { state: "created" | "failed"; message: string };
type MissingPartyLedger = { name: string; role: "customer" | "supplier" };
type PartyPreflightItem = MissingPartyLedger & {
  status: "existing" | "missing" | "role_missing" | "ignored_generic_ap";
  requiresCreation: boolean;
};
type ReviewRow = {
  id: number;
  row: ScanRow;
  checked: boolean;
  importable: boolean;
  infoReason?: string; // set on non-importable info rows (e.g. partner manual step)
  amountText: string;
  stockText: string; // opening-balances row only
  shareText: string; // partner row only
  dateText: string;
  partyText: string; // party name / asset name / liability name / partner name
  status?: RowStatus;
};

function rowTitle(row: ScanRow): string {
  switch (row.kind) {
    case "transaction": {
      const labels: Record<string, string> = {
        sale: "Sale", purchase_bill: "Purchase (bill)", receipt_in: "Money received",
        payment_out: "Payment out", expense: "Expense",
      };
      return labels[row.entryType] || row.entryType;
    }
    case "opening_balances": return "Opening balances (cash + stock)";
    case "asset": return "Asset";
    case "liability": return "Liability";
    case "partner": return "Partner capital";
  }
}

export default function ScanImport() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();

  const [phase, setPhase] = useState<"pick" | "busy" | "review" | "done">("pick");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const [docType, setDocType] = useState("");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [flagged, setFlagged] = useState<FlaggedScanRow[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [importing, setImporting] = useState(false);
  const [preflighting, setPreflighting] = useState(false);
  const [currencySymbol, setCurrencySymbol] = useState("$");
  const [doneCounts, setDoneCounts] = useState({ created: 0, failed: 0, manual: 0 });
  const [partnershipMode, setPartnershipMode] = useState(false);
  const [configuredInvestors, setConfiguredInvestors] = useState<{ id: string; name: string; profitSharePct: number }[]>([]);
  const [partyPreflightItems, setPartyPreflightItems] = useState<PartyPreflightItem[]>([]);
  const [partyLookupReady, setPartyLookupReady] = useState(false);

  React.useEffect(() => {
    api.getSettings().then((s: any) => setCurrencySymbol(getCurrencySymbol(s.currency || "USD"))).catch(() => {});
  }, []);

  const friendlyError = (e: any): string => {
    const message = String(e?.message || "Analysis failed");
    if (/api key/i.test(message)) return "No AI key configured. Open Settings → AI Provider and add your API key, then try again.";
    if (/network request failed|failed to fetch|timed out/i.test(message)) return "Could not reach the AI provider — you may be offline. Check your connection and try again.";
    return message;
  };

  const analyze = async (input: { base64?: string; mimeType?: string; text?: string }) => {
    if (input.base64 && input.base64.length > MAX_BASE64_CHARS) {
      setError("That file is too large (over ~8MB). Try a smaller photo, a lower-resolution scan, or paste the text instead.");
      return;
    }
    setError(""); setPhase("busy");
    try {
      const [raw, settings] = await Promise.all([api.analyzeDocument(input), api.getSettings().catch(() => ({}))]);
      const mapped = mapAnalyzedDocument(raw);
      const partnership = (settings as any)?.accountingStyle === "retail_partnership";
      let investors: { id: string; name: string; profitSharePct: number }[] = [];
      const [investorResult] = await Promise.allSettled([
        partnership ? api.listInvestors() : Promise.resolve([]),
      ]);
      if (investorResult.status === "fulfilled") investors = investorResult.value;
      const reviewRows: ReviewRow[] = mapped.validRows.map((row, index) => {
        const importable = true;
        let infoReason: string | undefined;
        if (row.kind === "partner") {
          const match = investors.find((inv) => inv.name.trim().toLowerCase() === row.name.trim().toLowerCase());
          if (!match && !partnership) {
            infoReason = `Partner stakes require Partnership Mode and matching investors before this report can be imported.`;
          }
        }
        return {
          id: index,
          row,
          checked: importable,
          importable,
          infoReason,
          amountText: String(row.kind === "transaction" ? row.amount : row.kind === "opening_balances" ? row.openingCash : row.kind === "partner" ? row.capital : row.amount),
          stockText: row.kind === "opening_balances" ? String(row.stockValue) : "",
          shareText: row.kind === "partner" && Number.isFinite(row.profitSharePct) ? String(row.profitSharePct) : "",
          dateText: row.kind === "transaction" ? row.date : row.kind === "opening_balances" ? row.asOfDate : row.date,
          partyText: row.kind === "transaction" ? row.partyName : row.kind === "opening_balances" ? "" : row.name,
        };
      });
      setDocType(mapped.docType);
      setSummary(mapped.summary);
      setRows(reviewRows);
      setFlagged(mapped.flaggedRows);
      setPartnershipMode(partnership);
      setConfiguredInvestors(investors);
      setPartyPreflightItems([]);
      setPartyLookupReady(false);
      setPhase("review");
    } catch (e: any) {
      setError(friendlyError(e));
      setPhase("pick");
    }
  };

  const scanCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { setError("Camera permission denied"); return; }
    const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.8, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled || !res.assets[0].base64) return;
    await analyze({ base64: res.assets[0].base64, mimeType: res.assets[0].mimeType || "image/jpeg" });
  };

  const pickGallery = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setError("Gallery permission denied"); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.8, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled || !res.assets[0].base64) return;
    await analyze({ base64: res.assets[0].base64, mimeType: res.assets[0].mimeType || "image/jpeg" });
  };

  const pickPdf = async () => {
    try {
      const DocumentPicker = await import("expo-document-picker");
      const FileSystem = await import("expo-file-system");
      const res = await DocumentPicker.getDocumentAsync({ type: "application/pdf", copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;
      const file = new FileSystem.File(res.assets[0].uri);
      const b64 = file.base64Sync();
      await analyze({ base64: b64, mimeType: "application/pdf" });
    } catch (e: any) {
      setError(e?.message || "Could not read PDF");
    }
  };

  const analyzeText = async () => {
    const text = pasteText.trim();
    if (!text) { setError("Paste some document text first."); return; }
    await analyze({ text });
  };

  const setupRows = rows.filter((r) => r.row.kind !== "transaction");
  const hasBalancedOpeningSet = setupRows.length > 1;
  const includedSetupRows = setupRows.filter((r) => r.checked && r.importable);
  const willImportBalancedSet = hasBalancedOpeningSet && includedSetupRows.length > 0;

  const updateRow = (id: number, patch: Partial<ReviewRow>) => {
    setError("");
    setRows((prev) => {
      const edited = prev.find((r) => r.id === id);
      const synchronizeSetupDate = hasBalancedOpeningSet && edited?.checked && edited.row.kind !== "transaction" && patch.dateText !== undefined;
      return prev.map((r) => {
        if (synchronizeSetupDate && r.row.kind !== "transaction") return { ...r, dateText: patch.dateText! };
        return r.id === id ? { ...r, ...patch } : r;
      });
    });
  };

  const editedScanRow = (r: ReviewRow): ScanRow => {
    const amount = Number(r.amountText);
    const date = r.dateText;
    switch (r.row.kind) {
      case "transaction": return { ...r.row, amount, date, partyName: r.partyText.trim() };
      case "opening_balances": return { ...r.row, openingCash: amount, stockValue: Number(r.stockText), asOfDate: date };
      case "asset": return { ...r.row, amount, date, name: r.partyText.trim() };
      case "liability": return { ...r.row, amount, date, name: r.partyText.trim() };
      case "partner": return { ...r.row, capital: amount, profitSharePct: Number(r.shareText), date, name: r.partyText.trim() };
    }
  };

  const partnerImportPlan = (
    partners: { name: string; amount: number; profitSharePct?: number }[],
    investors = configuredInvestors,
  ): {
    problem: string | null;
    entries: { memberId?: string; name: string; amount: number; profitSharePct: number }[];
    createNames: string[];
  } => {
    const empty = (problem: string) => ({ problem, entries: [], createNames: [] });
    if (partners.length > 0 && !partnershipMode) {
      return empty("This report contains partner stakes. Enable Partnership Mode before importing or creating partner ledgers.");
    }
    const investorByName = new Map(investors.map((investor) => [investor.name.trim().toLowerCase(), investor]));
    const reportNames = new Set(partners.map((partner) => partner.name.trim().toLowerCase()));
    const missing = investors.filter((investor) => !reportNames.has(investor.name.trim().toLowerCase()));
    if (missing.length > 0) {
      return empty(`The report is missing configured investor${missing.length === 1 ? "" : "s"}: ${missing.map((investor) => investor.name).join(", ")}. Every configured investor must be represented.`);
    }
    if (reportNames.size !== partners.length) return empty("Each partner must appear exactly once in the report.");

    const newPartners = partners.filter((partner) => !investorByName.has(partner.name.trim().toLowerCase()));
    const invalidNewShares = newPartners.filter((partner) => !Number.isFinite(partner.profitSharePct) || Number(partner.profitSharePct) <= 0 || Number(partner.profitSharePct) > 100);
    if (invalidNewShares.length > 0) {
      return empty(`Set a valid profit share for new partner${invalidNewShares.length === 1 ? "" : "s"}: ${invalidNewShares.map((partner) => partner.name).join(", ")}. Create them manually in Investors if the report does not show the shares.`);
    }
    const resultingShare = investors.reduce((sum, investor) => sum + Number(investor.profitSharePct || 0), 0)
      + newPartners.reduce((sum, partner) => sum + Number(partner.profitSharePct), 0);
    if (newPartners.length > 0 && Math.abs(resultingShare - 100) > 0.005) {
      return empty(`Configured and new partner profit shares must total 100% (currently ${resultingShare.toFixed(2)}%). Correct the shares or create the ledgers manually.`);
    }
    return {
      problem: null,
      createNames: newPartners.map((partner) => partner.name),
      entries: partners.map((partner) => {
        const match = investorByName.get(partner.name.trim().toLowerCase());
        return {
          memberId: match?.id,
          name: partner.name,
          amount: partner.amount,
          profitSharePct: match ? Number(match.profitSharePct) : Number(partner.profitSharePct),
        };
      }),
    };
  };

  const balancedOpeningResult = willImportBalancedSet
    ? buildBalancedOpeningSet(includedSetupRows.map(editedScanRow))
    : null;
  const balancedPartnerPlan = balancedOpeningResult?.value
    ? partnerImportPlan(balancedOpeningResult.value.partnerCapitals)
    : { problem: null, entries: [], createNames: [] };
  const balancedOpeningProblem = balancedOpeningResult?.error
    || balancedPartnerPlan.problem;
  const openingPreview = includedSetupRows.reduce((preview, review) => {
    const amount = Number(review.amountText) || 0;
    if (review.row.kind === "opening_balances") preview.assets += amount + (Number(review.stockText) || 0);
    if (review.row.kind === "asset") preview.assets += amount;
    if (review.row.kind === "liability") preview.liabilities += amount;
    if (review.row.kind === "partner") preview.partnerStakes += amount;
    return preview;
  }, { assets: 0, liabilities: 0, partnerStakes: 0 });
  const calculatedEquity = Math.round((openingPreview.assets - openingPreview.liabilities) * 100) / 100;

  // Re-validate an edited row's fields at import time. Returns an error reason
  // or null when safe. All amounts go through the shared AI caps and every date
  // through normalizeDateInput before anything is written.
  const rowProblem = (r: ReviewRow): string | null => {
    const normalized = normalizeDateInput(r.dateText);
    if (!isValidDateString(normalized) || !normalizeScanDate(normalized)) return DATE_BOUNDS_REASON;
    if (r.row.kind === "opening_balances") {
      const cash = Number(r.amountText);
      const stock = Number(r.stockText);
      const okBal = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1_000_000_000;
      if (!okBal(cash) || !okBal(stock)) return AMOUNT_BOUNDS_REASON;
      if (cash === 0 && stock === 0) return "Enter an opening cash or stock value";
      return null;
    }
    if (!isValidScanAmount(Number(r.amountText))) return AMOUNT_BOUNDS_REASON;
    if (r.row.kind === "transaction" && r.row.entryType === "sale" && r.row.method === "credit" && !r.partyText.trim()) {
      return "Customer name is required for a credit sale";
    }
    if (r.row.kind === "transaction" && (r.row.entryType === "purchase_bill" || r.row.entryType === "payment_out") && !r.partyText.trim()) {
      return "Supplier name is required";
    }
    if ((r.row.kind === "asset" || r.row.kind === "liability" || r.row.kind === "partner") && !r.partyText.trim()) return "Name is required";
    return null;
  };

  // Execute ONE confirmed, validated ordinary row through the existing api surface.
  const writeRow = async (r: ReviewRow, approvedPartyCreationKeys = new Set<string>()) => {
    const date = normalizeScanDate(normalizeDateInput(r.dateText))!;
    const amount = Number(r.amountText);
    const party = r.partyText.trim();
    const row = r.row;
    if (row.kind === "transaction") {
      const notes = scanNote(row.notes || rowTitle(row));
      const role = row.entryType === "purchase_bill" || row.entryType === "payment_out" ? "supplier"
        : row.entryType === "receipt_in" || (row.entryType === "sale" && row.method === "credit") ? "customer"
        : null;
      const partyKey = role && party ? `${role}:${party.trim().toLowerCase().replace(/\s+/g, " ")}` : "";
      await api.importV2ScanTransaction({
        entryType: row.entryType,
        date,
        partyName: party || undefined,
        amount,
        method: row.method,
        notes,
        createMissingParty: !!partyKey && approvedPartyCreationKeys.has(partyKey),
      });
      return;
    }
    if (row.kind === "opening_balances") {
      await api.updateV2OpeningBalances({ date, cash: amount, inventory: Number(r.stockText), memo: scanNote("Imported opening balances") });
      return;
    }
    if (row.kind === "asset") {
      await api.createManualAsset({ date, name: party, amount, funding: "capital", notes: scanNote("Imported asset") });
      return;
    }
    if (row.kind === "liability") {
      await api.createManualLiability({ date, name: party, amount, recognition: "asset", notes: scanNote("Imported liability") });
      return;
    }
    if (row.kind === "partner") {
      const investors = await api.listInvestors();
      const match = investors.find((inv) => inv.name.trim().toLowerCase() === party.toLowerCase());
      if (!match) throw new Error(`No investor named "${party}" — add them on the Investors screen first`);
      await api.depositInvestorCapital(match.id, { amount, date, notes: scanNote(`Capital stake for ${match.name}`) });
      return;
    }
  };

  const selectedTransactions = rows.filter((r) => r.row.kind === "transaction" && r.checked && r.importable);
  const selected = hasBalancedOpeningSet
    ? [...selectedTransactions, ...includedSetupRows]
    : rows.filter((r) => r.checked && r.importable);
  const selectedHasProblems = selected.some((review) => !!rowProblem(review));
  const screenBusy = importing || preflighting;

  const partyRequests = (): MissingPartyLedger[] => {
    const required: MissingPartyLedger[] = [];
    for (const review of selectedTransactions) {
      if (review.row.kind !== "transaction") continue;
      const name = review.partyText.trim();
      if (review.row.entryType === "purchase_bill" && name) required.push({ name, role: "supplier" });
      if (review.row.entryType === "payment_out" && name) required.push({ name, role: "supplier" });
      if (review.row.entryType === "receipt_in" && name) required.push({ name, role: "customer" });
      if (review.row.entryType === "sale" && review.row.method === "credit" && name) required.push({ name, role: "customer" });
    }
    if (willImportBalancedSet && balancedOpeningResult?.value) {
      for (const liability of balancedOpeningResult.value.liabilityBreakdown) {
        if (liability.type === "creditor" && !/^(creditors?|accounts? payable)$/i.test(liability.name.trim())) {
          required.push({ name: liability.name.trim(), role: "supplier" });
        }
      }
    }
    const normalized = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
    const unique = new Map(required.map((item) => [`${item.role}:${normalized(item.name)}`, item]));
    return [...unique.values()];
  };

  const requestedPartyLedgers = partyRequests();
  const partyRequestKey = JSON.stringify(requestedPartyLedgers);
  React.useEffect(() => {
    if (phase !== "review") return;
    let active = true;
    setPartyLookupReady(false);
    api.preflightV2ScanParties(requestedPartyLedgers)
      .then((result) => {
        if (!active) return;
        setPartyPreflightItems(result.items);
        setPartyLookupReady(true);
      })
      .catch(() => {
        if (!active) return;
        setPartyPreflightItems([]);
        setPartyLookupReady(false);
      });
    return () => { active = false; };
    // The serialized key changes whenever selection or an editable party name changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyRequestKey, phase]);

  const missingPartyLedgers = partyLookupReady ? partyPreflightItems.filter((item) => item.requiresCreation) : [];
  const pendingSupportRecords = [
    ...missingPartyLedgers.map((item) => `${item.role === "customer" ? "Customer" : "Supplier"} ledger — ${item.name}`),
    ...balancedPartnerPlan.entries
      .filter((entry) => !entry.memberId)
      .map((entry) => `Investor ledger — ${entry.name} (${entry.profitSharePct}% profit share)`),
  ];

  const selectedRecordLines = () => {
    const lines = selectedTransactions.map((review) => {
      if (review.row.kind !== "transaction") return "";
      const party = review.partyText.trim();
      const detail = party ? ` — ${party}` : "";
      return `${rowTitle(review.row)}${detail}: ${fmt(Number(review.amountText) || 0, currencySymbol)} on ${review.dateText}`;
    });
    if (willImportBalancedSet && balancedOpeningResult?.value) {
      lines.unshift(`Balanced opening set: ${fmt(balancedOpeningResult.value.totalAssets, currencySymbol)} assets as of ${balancedOpeningResult.value.date}`);
    }
    return lines.filter(Boolean);
  };

  const runImport = async (approvedSupportLedgers: MissingPartyLedger[] = missingPartyLedgers) => {
    setImporting(true); setError("");
    let created = 0; let failed = 0;
    const next = [...rows];
    const normalized = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
    const approvedPartyCreationKeys = new Set(approvedSupportLedgers.map((item) => `${item.role}:${normalized(item.name)}`));
    if (willImportBalancedSet) {
      const includedNextSetup = next.filter((r) => r.row.kind !== "transaction" && r.checked && r.importable);
      const rebuilt = buildBalancedOpeningSet(includedNextSetup.map(editedScanRow));
      const partnerPlan = rebuilt.value ? partnerImportPlan(rebuilt.value.partnerCapitals) : { problem: null, entries: [], createNames: [] };
      const problem = rebuilt.error || partnerPlan.problem;
      if (!rebuilt.value || problem) {
        const message = problem || "The balanced opening set is incomplete.";
        includedNextSetup.forEach((r) => { r.status = { state: "failed", message }; });
        setRows([...next]);
        setError(message);
        setDoneCounts({ created: 0, failed: 1, manual: 0 });
        setImporting(false);
        return;
      }
      try {
        await api.importV2ClosingBalances({
          ...rebuilt.value,
          memo: scanNote("Imported balanced opening set from closing report"),
          createMissingPartners: partnerPlan.createNames.length > 0,
          createMissingCreditors: approvedSupportLedgers.some((item) => item.role === "supplier"
            && rebuilt.value!.liabilityBreakdown.some((liability) => liability.type === "creditor" && normalized(liability.name) === normalized(item.name))),
          partnerCapitals: partnerPlan.entries,
        });
        includedNextSetup.forEach((r) => { r.status = { state: "created", message: "Imported in balanced opening set" }; });
        created++;
      } catch (e: any) {
        const message = e?.message || "Balanced opening set import failed";
        includedNextSetup.forEach((r) => { r.status = { state: "failed", message }; });
        setRows([...next]);
        setError(message);
        setDoneCounts({ created: 0, failed: 1, manual: 0 });
        setImporting(false);
        return;
      }
      setRows([...next]);
    }
    for (const r of next) {
      if (willImportBalancedSet && r.row.kind !== "transaction") continue;
      if (!r.checked || !r.importable) continue;
      const problem = rowProblem(r);
      if (problem) { r.status = { state: "failed", message: problem }; failed++; continue; }
      try {
        await writeRow(r, approvedPartyCreationKeys);
        r.status = { state: "created", message: "Created" };
        created++;
      } catch (e: any) {
        r.status = { state: "failed", message: e?.message || "Failed" };
        failed++;
      }
      setRows([...next]);
    }
    setRows([...next]);
    setDoneCounts({ created, failed, manual: 0 });
    setImporting(false);
    setPhase("done");
  };

  const confirmImport = async () => {
    if (selected.length === 0) return;
    if (selectedHasProblems) {
      setError("Fix or exclude the included rows highlighted below before importing.");
      return;
    }
    if (willImportBalancedSet && balancedOpeningProblem) {
      setError(balancedOpeningProblem);
      return;
    }
    setPreflighting(true);
    setError("");
    let freshMissingLedgers: MissingPartyLedger[];
    try {
      const preflight = await api.preflightV2ScanParties(requestedPartyLedgers);
      setPartyPreflightItems(preflight.items);
      setPartyLookupReady(true);
      freshMissingLedgers = preflight.items.filter((item) => item.requiresCreation);
    } catch {
      setPartyLookupReady(false);
      setError("Could not verify customer and supplier ledgers. Nothing was created; check your book and try again.");
      setPreflighting(false);
      return;
    }
    setPreflighting(false);
    const transactionRecords = selectedRecordLines();
    const supportRecords = [
      ...freshMissingLedgers.map((item) => `${item.role === "customer" ? "Customer" : "Supplier"} ledger — ${item.name}`),
      ...balancedPartnerPlan.entries
        .filter((entry) => !entry.memberId)
        .map((entry) => `Investor ledger — ${entry.name} (${entry.profitSharePct}% profit share)`),
    ];
    const recordDisclosure = [
      "Records to create:",
      ...transactionRecords.map((record) => `• ${record}`),
      ...(supportRecords.length ? ["", "New supporting ledgers:", ...supportRecords.map((record) => `• ${record}`)] : []),
    ].join("\n");
    const total = selected.reduce((sum, r) => sum + (Number(r.amountText) || 0) + (r.row.kind === "opening_balances" ? Number(r.stockText) || 0 : 0), 0);
    if (willImportBalancedSet) {
      Alert.alert(
        "Import balanced opening set?",
        `The complete statement will be written atomically. Assets, liabilities, and partner stakes cannot be imported separately.\n\n${recordDisclosure}`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Import balanced opening set", isPreferred: true, onPress: () => runImport(freshMissingLedgers) },
        ],
      );
      return;
    }
    Alert.alert(
      `Import ${selected.length} selected?`,
      `${selected.length} entr${selected.length === 1 ? "y" : "ies"} will be written to your books (total value ${fmt(total, currencySymbol)}). Each record is tagged ${SCAN_TAG}.\n\n${recordDisclosure}`,
      [
        { text: "Cancel", style: "cancel" },
        { text: `Import ${selected.length}`, isPreferred: true, onPress: () => runImport(freshMissingLedgers) },
      ],
    );
  };

  const transactionsRows = rows.filter((r) => r.row.kind === "transaction");

  const renderRow = (r: ReviewRow) => {
    const problem = r.checked && r.importable ? rowProblem(r) : null;
    const border = !r.checked || !r.importable ? theme.color.muted : problem ? theme.color.error : theme.color.brandPrimary;
    return (
      <View key={r.id} style={[styles.row, { borderLeftColor: border }, !r.checked && styles.rowExcluded]} testID={`scan-row-${r.id}`}>
        <View style={styles.rowHeader}>
          <Pressable
            testID={`scan-check-${r.id}`}
            disabled={screenBusy || phase === "done"}
            onPress={() => updateRow(r.id, { checked: !r.checked })}
            style={styles.checkWrap}
          >
            <Ionicons
              name={!r.checked ? "square-outline" : !r.importable ? "information-circle-outline" : problem ? "close-circle" : "checkbox"}
              size={22}
              color={!r.checked || !r.importable ? theme.color.muted : problem ? theme.color.error : theme.color.brandPrimary}
            />
          </Pressable>
          <Text style={styles.rowTitle}>{rowTitle(r.row)}</Text>
          {!r.checked ? <Text style={styles.excludedText}>Excluded</Text> : null}
          {r.status ? (
            <Text style={[styles.statusText, { color: r.status.state === "created" ? theme.color.success : theme.color.error }]}>
              {r.status.state === "created" ? "✓ Created" : "✗ Failed"}
            </Text>
          ) : null}
          {phase !== "done" ? (
            <Pressable
              testID={`scan-remove-${r.id}`}
              accessibilityRole="button"
              accessibilityLabel={r.checked ? `Exclude ${rowTitle(r.row)}` : `Include ${rowTitle(r.row)}`}
              disabled={screenBusy}
              onPress={() => updateRow(r.id, { checked: !r.checked, status: undefined })}
              style={styles.removeRowBtn}
            >
              <Ionicons name={r.checked ? "remove-circle-outline" : "add-circle-outline"} size={22} color={r.checked ? theme.color.error : theme.color.brandPrimary} />
            </Pressable>
          ) : null}
        </View>
        {r.infoReason ? <Text style={styles.infoText}>{r.infoReason}</Text> : null}
        {r.importable || r.row.kind === "partner" ? (
          <View style={[styles.fieldRow, !r.checked && { opacity: 0.65 }]}>
            {r.row.kind !== "opening_balances" ? (
              <View style={{ flex: 1.2 }}>
                <Text style={styles.fieldLabel}>{r.row.kind === "transaction" ? "Party" : "Name"}</Text>
                <TextInput
                  value={r.partyText}
                  editable={r.checked && !screenBusy && phase !== "done"}
                  onChangeText={(t) => updateRow(r.id, { partyText: t })}
                  placeholder={r.row.kind === "transaction" ? "Optional" : "Name"}
                  placeholderTextColor={theme.color.muted}
                  style={styles.fieldInput}
                />
              </View>
            ) : null}
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>{r.row.kind === "opening_balances" ? "Cash" : "Amount"}</Text>
              <TextInput
                value={r.amountText}
                editable={r.checked && !screenBusy && phase !== "done"}
                onChangeText={(t) => updateRow(r.id, { amountText: t })}
                keyboardType="decimal-pad"
                placeholderTextColor={theme.color.muted}
                style={styles.fieldInput}
              />
            </View>
            {r.row.kind === "opening_balances" ? (
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>Stock</Text>
                <TextInput
                  value={r.stockText}
                  editable={r.checked && !screenBusy && phase !== "done"}
                  onChangeText={(t) => updateRow(r.id, { stockText: t })}
                  keyboardType="decimal-pad"
                  placeholderTextColor={theme.color.muted}
                  style={styles.fieldInput}
                />
              </View>
            ) : null}
            {r.row.kind === "partner" ? (
              <View style={{ flex: 0.8 }}>
                <Text style={styles.fieldLabel}>Profit share %</Text>
                <TextInput
                  value={r.shareText}
                  editable={r.checked && !screenBusy && phase !== "done"}
                  onChangeText={(t) => updateRow(r.id, { shareText: t })}
                  keyboardType="decimal-pad"
                  placeholder="Required if new"
                  placeholderTextColor={theme.color.muted}
                  style={styles.fieldInput}
                />
              </View>
            ) : null}
            <View style={{ flex: 1.1 }}>
              <Text style={styles.fieldLabel}>Date</Text>
              <TextInput
                value={r.dateText}
                editable={r.checked && !screenBusy && phase !== "done"}
                onChangeText={(t) => updateRow(r.id, { dateText: t })}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={theme.color.muted}
                style={styles.fieldInput}
              />
            </View>
          </View>
        ) : null}
        {problem ? <Text style={styles.flaggedText}>⚠ {problem}</Text> : null}
        {r.status?.state === "failed" ? <Text style={styles.flaggedText}>⚠ {r.status.message}</Text> : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-back-scan" onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={26} color={theme.color.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Scan &amp; Import</Text>
        <View style={{ width: 26 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
        {phase === "pick" && (
          <>
            <Card>
              <Text style={styles.name}>Import any business document</Text>
              <Text style={styles.hint}>
                Photograph or upload a receipt, supplier statement, transaction list, or a closing report from another accounting
                app. AI proposes the entries and opening balances; you review and import only what you want. Nothing is saved
                without your confirmation.
              </Text>
              <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.md }}>
                <Pressable testID="btn-scan-doc" onPress={scanCamera} style={[styles.actionBtn, { flex: 1 }]}>
                  <Ionicons name="camera-outline" size={18} color="#fff" />
                  <Text style={styles.actionText}>Camera</Text>
                </Pressable>
                <Pressable testID="btn-gallery-doc" onPress={pickGallery} style={[styles.actionBtn, { flex: 1, backgroundColor: theme.color.brandSecondary }]}>
                  <Ionicons name="image-outline" size={18} color="#fff" />
                  <Text style={styles.actionText}>Gallery</Text>
                </Pressable>
                <Pressable testID="btn-pdf-doc" onPress={pickPdf} style={[styles.actionBtn, { flex: 1, backgroundColor: theme.color.brandTertiary || theme.color.brandSecondary }]}>
                  <Ionicons name="document-outline" size={18} color="#fff" />
                  <Text style={styles.actionText}>PDF</Text>
                </Pressable>
              </View>
            </Card>
            <Card style={{ marginTop: theme.spacing.md }}>
              <Text style={styles.section2}>Or paste document text</Text>
              <TextInput
                testID="scan-paste-input"
                value={pasteText}
                onChangeText={setPasteText}
                placeholder="Paste the report / statement text here…"
                placeholderTextColor={theme.color.muted}
                multiline
                style={styles.pasteBox}
              />
              <Pressable testID="btn-analyze-text" onPress={analyzeText} style={[styles.actionBtn, { marginTop: theme.spacing.md }]}>
                <Ionicons name="sparkles-outline" size={18} color="#fff" />
                <Text style={styles.actionText}>Analyze text</Text>
              </Pressable>
            </Card>
          </>
        )}

        {phase === "busy" && (
          <View style={{ alignItems: "center", padding: theme.spacing.xl }}>
            <ActivityIndicator color={theme.color.brandPrimary} size="large" />
            <Text style={styles.hint}>AI is analyzing the document…</Text>
          </View>
        )}

        {error ? <Text style={styles.error} testID="scan-error">{error}</Text> : null}

        {(phase === "review" || phase === "done") && (
          <>
            <Card testID="scan-summary">
              <Text style={styles.section2}>AI read this as: {docType.replace(/_/g, " ")}</Text>
              <Text style={styles.hint}>{summary || "No description provided."}</Text>
            </Card>

            {rows.length === 0 && flagged.length === 0 ? (
              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.hint} testID="scan-empty">
                  No importable entries were found in this document. Try a clearer photo, or paste the text instead.
                </Text>
                <Pressable onPress={() => { setPhase("pick"); setError(""); }} style={[styles.actionBtn, { marginTop: theme.spacing.md }]}>
                  <Text style={styles.actionText}>Try another document</Text>
                </Pressable>
              </Card>
            ) : null}

            {transactionsRows.length > 0 ? (
              <>
                <Text style={styles.section}>Transactions ({transactionsRows.length})</Text>
                {transactionsRows.map(renderRow)}
              </>
            ) : null}

            {setupRows.length > 0 ? (
              <>
                <Text style={styles.section}>{hasBalancedOpeningSet ? "Balanced opening set" : "Book setup"} ({setupRows.length})</Text>
                {hasBalancedOpeningSet ? (
                  <View style={styles.balancePreview} testID="scan-balanced-opening-info">
                    <Text style={styles.infoText}>Include only rows that belong in the opening entry. Removing a row recalculates the balance; import stays blocked until the included set balances.</Text>
                    <Text style={styles.balancePreviewText}>Included assets {fmt(openingPreview.assets, currencySymbol)} · Liabilities {fmt(openingPreview.liabilities, currencySymbol)} · Calculated equity {fmt(calculatedEquity, currencySymbol)}</Text>
                    {openingPreview.partnerStakes > 0 ? <Text style={styles.balancePreviewText}>Included partner stakes {fmt(openingPreview.partnerStakes, currencySymbol)}</Text> : null}
                  </View>
                ) : null}
                {setupRows.map(renderRow)}
                {hasBalancedOpeningSet && balancedPartnerPlan.createNames.length > 0 && !balancedOpeningProblem ? (
                  <Text style={styles.infoText} testID="scan-partners-to-create">
                    New investor ledgers will be created after confirmation: {balancedPartnerPlan.createNames.join(", ")}. Review their profit shares above.
                  </Text>
                ) : null}
                {hasBalancedOpeningSet && balancedOpeningProblem ? (
                  <Text style={styles.flaggedText} testID="scan-balanced-opening-error">⚠ {balancedOpeningProblem}</Text>
                ) : null}
              </>
            ) : null}

            {flagged.length > 0 ? (
              <>
                <Text style={styles.section}>Needs review — excluded ({flagged.length})</Text>
                <Text style={[styles.infoText, { marginBottom: theme.spacing.sm }]}>AI could not map these figures safely. They are not selected or imported; check the document, correct the editable proposals above, or rescan.</Text>
                {flagged.map((f, i) => (
                  <View key={i} style={[styles.row, { borderLeftColor: theme.color.error }]} testID={`scan-flagged-${i}`}>
                    <View style={styles.rowHeader}>
                      <Ionicons name="close-circle" size={20} color={theme.color.error} />
                      <Text style={styles.rowTitle}>{f.label}</Text>
                    </View>
                    <Text style={styles.flaggedText}>⚠ {f.reason}</Text>
                  </View>
                ))}
              </>
            ) : null}

            {phase === "review" && selected.length > 0 ? (
              <Card style={{ marginTop: theme.spacing.lg }} testID="scan-support-records">
                <Text style={styles.section2}>Records created after confirmation</Text>
                <Text style={styles.hint}>
                  Your selected entries are listed above. The app also checks whether those entries need customer, supplier, or investor ledgers; no ledger is created during this review.
                </Text>
                {!partyLookupReady ? (
                  <Text style={styles.infoText}>Customer and supplier ledgers will be checked again before the confirmation appears.</Text>
                ) : pendingSupportRecords.length > 0 ? (
                  pendingSupportRecords.map((record) => <Text key={record} style={styles.infoText}>• New {record}</Text>)
                ) : (
                  <Text style={styles.infoText}>No new supporting ledgers are currently required.</Text>
                )}
              </Card>
            ) : null}

            {phase === "done" ? (
              <Card style={{ marginTop: theme.spacing.lg }} testID="scan-done-card">
                <Text style={styles.section2}>Import finished</Text>
                <Text style={styles.hint}>
                  {doneCounts.created} created · {doneCounts.failed} failed
                  {doneCounts.manual > 0 ? ` · ${doneCounts.manual} manual step${doneCounts.manual === 1 ? "" : "s"} (see info rows above)` : ""}
                </Text>
                <Pressable testID="btn-scan-done" onPress={() => router.back()} style={[styles.actionBtn, { marginTop: theme.spacing.md }]}>
                  <Text style={styles.actionText}>Done</Text>
                </Pressable>
              </Card>
            ) : rows.length > 0 ? (
              <Pressable
                testID="btn-import-selected"
                onPress={confirmImport}
                disabled={screenBusy || selected.length === 0 || selectedHasProblems || !!balancedOpeningProblem}
                style={[styles.actionBtn, { marginTop: theme.spacing.lg }, (screenBusy || selected.length === 0 || selectedHasProblems || !!balancedOpeningProblem) && { opacity: 0.5 }]}
              >
                {screenBusy ? <ActivityIndicator color="#fff" /> : <Ionicons name="cloud-upload-outline" size={18} color="#fff" />}
                <Text style={styles.actionText}>
                  {preflighting ? "Checking ledgers…" : importing ? "Importing…" : willImportBalancedSet ? "Import included balanced set" : `Import ${selected.length} selected`}
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
        {Platform.OS === "web" ? <View style={{ height: 24 }} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    name: { fontSize: 20, fontWeight: "700", color: theme.color.onSurface },
    hint: { fontSize: 13, color: theme.color.muted, marginTop: 6, lineHeight: 18 },
    actionBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.color.brandPrimary, padding: theme.spacing.md, borderRadius: theme.radius.md },
    actionText: { color: "#fff", fontWeight: "600", fontSize: 14 },
    error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
    section: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface, marginTop: theme.spacing.lg, marginBottom: theme.spacing.md },
    section2: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface },
    pasteBox: {
      marginTop: theme.spacing.md, minHeight: 110, textAlignVertical: "top",
      borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md,
      padding: theme.spacing.md, color: theme.color.onSurface, fontSize: 13, backgroundColor: theme.color.surface,
    },
    row: {
      backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md,
      borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
      borderLeftWidth: 4, marginBottom: theme.spacing.sm,
    },
    rowExcluded: { opacity: 0.78, borderStyle: "dashed" },
    rowHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
    checkWrap: { padding: 2 },
    rowTitle: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface, flex: 1 },
    statusText: { fontSize: 12, fontWeight: "700" },
    excludedText: { fontSize: 11, fontWeight: "700", color: theme.color.muted },
    removeRowBtn: { padding: 2 },
    infoText: { fontSize: 12, color: theme.color.muted, marginTop: 6, lineHeight: 17 },
    fieldRow: { flexDirection: "row", gap: 8, marginTop: theme.spacing.sm },
    fieldLabel: { fontSize: 11, fontWeight: "600", color: theme.color.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4 },
    fieldInput: {
      borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.sm,
      paddingHorizontal: 8, paddingVertical: 6, fontSize: 13, color: theme.color.onSurface,
      backgroundColor: theme.color.surface,
    },
    flaggedText: { color: theme.color.error, fontSize: 11, marginTop: 6, fontWeight: "600" },
    balancePreview: { marginBottom: theme.spacing.md, padding: theme.spacing.sm, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    balancePreviewText: { marginTop: 6, color: theme.color.onSurface, fontSize: 12, fontWeight: "700" },
  });
}
