import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, RefreshControl, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { ScreenHeader, Card } from "@/src/components/UI";
import { FormField, FormActions } from "@/src/components/FormCard";
import { isValidDateString, localTodayIso, normalizeDateInput } from "@/src/utils/dateValidation";
import { parseMoneyInput } from "@/src/money";
import { fmt } from "@/src/theme";
import { getEnabledFeatures } from "@/src/utils/featureFlags";
import { getCurrencySymbol } from "@/src/utils/currency";
import { confirmAction } from "@/src/utils/alerts";

// Payroll endpoints are added by the parent in api.ts. Cast so this screen
// type-checks and still calls the agreed method names if they are missing.
const payrollApi = api as any;

type PayMethod = "cash" | "bank";

type Employee = {
  id: string;
  name: string;
  role: string;
  payRate: number;
  taxPct: number;
  startDate: string;
  archived: boolean;
};

type PayRun = {
  id: string;
  date: string;
  method: string;
  notes: string;
};

type Payslip = {
  id: string;
  employeeId: string;
  employeeName: string;
  gross: number;
  tax: number;
  net: number;
};

type YearEndRow = { name: string; gross: number; tax: number; net: number };

function asList(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const obj = value as any;
    for (const key of ["employees", "payRuns", "payslips", "items", "rows"]) {
      if (Array.isArray(obj[key])) return obj[key];
    }
  }
  return [];
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapEmployee(row: any): Employee {
  return {
    id: String(row?.id || ""),
    name: String(row?.name || "").trim(),
    role: String(row?.role || "").trim(),
    payRate: num(row?.payRate ?? row?.pay_rate),
    taxPct: num(row?.taxPct ?? row?.taxWithholdPct ?? row?.tax_withhold_pct),
    startDate: String(row?.startDate ?? row?.start_date ?? ""),
    archived: Boolean(row?.archived === true || row?.archived === 1),
  };
}

function mapPayRun(row: any): PayRun {
  return {
    id: String(row?.id || ""),
    date: String(row?.date || ""),
    method: String(row?.method || ""),
    notes: String(row?.notes || ""),
  };
}

function mapPayslip(row: any, employees: Employee[]): Payslip {
  const employeeId = String(row?.employeeId ?? row?.employee_id ?? "");
  const named = employees.find((item) => item.id && item.id === employeeId);
  return {
    id: String(row?.id || `${employeeId}-${row?.gross ?? ""}`),
    employeeId,
    employeeName: String(row?.employeeName || row?.employee || row?.name || named?.name || "Employee"),
    gross: num(row?.gross),
    tax: num(row?.tax ?? row?.taxWithheld ?? row?.tax_withheld),
    net: num(row?.net ?? row?.netPay),
  };
}

function mapYearEndRows(summary: any): YearEndRow[] {
  const rows = asList(summary?.employees ?? summary?.byEmployee ?? summary);
  return rows.map((row: any) => ({
    name: String(row?.name || row?.employeeName || row?.employee || "Employee"),
    gross: num(row?.gross ?? row?.totalGross),
    tax: num(row?.tax ?? row?.taxWithheld ?? row?.tax_withheld),
    net: num(row?.net ?? row?.netPay ?? row?.totalNet),
  }));
}

export default function PayrollScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [currSym, setCurrSym] = useState("$");

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [payRuns, setPayRuns] = useState<PayRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [payslipError, setPayslipError] = useState("");

  const [empName, setEmpName] = useState("");
  const [empRole, setEmpRole] = useState("");
  const [empRate, setEmpRate] = useState("");
  const [empTax, setEmpTax] = useState("");
  const [empStart, setEmpStart] = useState(localTodayIso());
  const [empError, setEmpError] = useState("");
  const [savingEmp, setSavingEmp] = useState(false);

  const [payDate, setPayDate] = useState(localTodayIso());
  const [payMethod, setPayMethod] = useState<PayMethod>("cash");
  const [payNotes, setPayNotes] = useState("");
  const [payError, setPayError] = useState("");
  const [runningPay, setRunningPay] = useState(false);

  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [yearRows, setYearRows] = useState<YearEndRow[]>([]);
  const [yearGrand, setYearGrand] = useState<number | null>(null);
  const [yearGross, setYearGross] = useState(0);
  const [yearTax, setYearTax] = useState(0);
  const [yearError, setYearError] = useState("");
  const [yearBusy, setYearBusy] = useState(false);
  const [yearLoaded, setYearLoaded] = useState(false);

  const resetEmployeeForm = () => {
    setEmpName("");
    setEmpRole("");
    setEmpRate("");
    setEmpTax("");
    setEmpStart(localTodayIso());
    setEmpError("");
  };

  const load = useCallback(async () => {
    try {
      const settings = await api.getSettings().catch(() => ({}));
      const features = getEnabledFeatures(settings);
      const on = Array.isArray(features) && features.includes("payroll");
      setEnabled(on);
      setCurrSym(getCurrencySymbol((settings as any)?.currency || "USD"));
      if (!on) {
        setEmployees([]);
        setPayRuns([]);
        setPayslips([]);
        setSelectedRunId(null);
        return;
      }
      const [empRows, runRows] = await Promise.all([
        payrollApi.listEmployees(),
        payrollApi.listPayRuns(),
      ]);
      setEmployees(asList(empRows).map(mapEmployee).filter((row) => row.id && !row.archived));
      setPayRuns(asList(runRows).map(mapPayRun).filter((row) => row.id));
    } catch {
      setEmployees([]);
      setPayRuns([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    load();
  }, [load]));

  const saveEmployee = async () => {
    const name = empName.trim();
    const rate = parseMoneyInput(empRate);
    const tax = Number(String(empTax).replace(",", "."));
    const startIso = normalizeDateInput(empStart);
    if (!name) { setEmpError("Enter an employee name."); return; }
    if (!Number.isFinite(rate) || rate < 0) { setEmpError("Enter a pay rate of zero or more."); return; }
    if (!Number.isFinite(tax) || tax < 0 || tax > 100) { setEmpError("Tax % must be between 0 and 100."); return; }
    if (!isValidDateString(startIso)) { setEmpError(`Couldn't read "${empStart.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    setEmpStart(startIso);
    setSavingEmp(true);
    setEmpError("");
    try {
      await payrollApi.upsertEmployee({
        name,
        role: empRole.trim(),
        payRate: rate,
        taxPct: tax,
        taxWithholdPct: tax,
        startDate: startIso,
      });
      resetEmployeeForm();
      await load();
    } catch (e: any) {
      setEmpError(e?.message || "Could not save this employee.");
    } finally {
      setSavingEmp(false);
    }
  };

  const archiveEmployee = (employee: Employee) => {
    confirmAction(
      "Archive employee?",
      `${employee.name} will be hidden from the next pay run. Past payslips stay on file.`,
      async () => {
        try {
          await payrollApi.archiveEmployee(employee.id);
          await load();
        } catch (e: any) {
          setEmpError(e?.message || "Could not archive this employee.");
        }
      },
      "Archive",
    );
  };

  const runPay = async () => {
    const dateIso = normalizeDateInput(payDate);
    if (!isValidDateString(dateIso)) { setPayError(`Couldn't read "${payDate.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    setPayDate(dateIso);
    setRunningPay(true);
    setPayError("");
    try {
      await payrollApi.runPayroll({ date: dateIso, method: payMethod, notes: payNotes.trim() });
      setPayNotes("");
      setSelectedRunId(null);
      setPayslips([]);
      await load();
    } catch (e: any) {
      setPayError(e?.message || "Could not run payroll.");
    } finally {
      setRunningPay(false);
    }
  };

  const openPayRun = async (run: PayRun) => {
    if (selectedRunId === run.id) {
      setSelectedRunId(null);
      setPayslips([]);
      setPayslipError("");
      return;
    }
    setSelectedRunId(run.id);
    setPayslipError("");
    try {
      const rows = await payrollApi.listPayslips(run.id);
      setPayslips(asList(rows).map((row) => mapPayslip(row, employees)));
    } catch (e: any) {
      setPayslips([]);
      setPayslipError(e?.message || "Could not load payslips.");
    }
  };

  const loadYearEnd = async () => {
    const parsed = parseInt(String(year).trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 1900 || parsed > 2100) {
      setYearError("Enter a four-digit year.");
      return;
    }
    setYear(String(parsed));
    setYearBusy(true);
    setYearError("");
    try {
      const summary = await payrollApi.yearEndPayrollSummary(parsed);
      const rows = mapYearEndRows(summary);
      setYearRows(rows);
      const gross = num(summary?.totals?.gross ?? summary?.totalGross ?? rows.reduce((sum, row) => sum + row.gross, 0));
      const tax = num(summary?.totals?.tax ?? summary?.totals?.taxWithheld ?? summary?.totalTax ?? rows.reduce((sum, row) => sum + row.tax, 0));
      const net = num(summary?.grandTotal ?? summary?.totalNet ?? summary?.totals?.net ?? rows.reduce((sum, row) => sum + row.net, 0));
      setYearGross(gross);
      setYearTax(tax);
      setYearGrand(net);
      setYearLoaded(true);
    } catch (e: any) {
      setYearRows([]);
      setYearGrand(null);
      setYearLoaded(false);
      setYearError(e?.message || "Could not load the year-end summary.");
    } finally {
      setYearBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Payroll" subtitle="Employees, pay runs, and payslips" />
      {loading ? (
        <ActivityIndicator style={{ marginTop: 48 }} color={theme.color.brandPrimary} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          keyboardShouldPersistTaps="handled"
        >
          {!enabled ? (
            <Card>
              <View style={styles.formTitleRow}>
                <View style={styles.formIcon}>
                  <Ionicons name="people-outline" size={19} color={theme.color.brandPrimary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>Payroll is optional</Text>
                  <Text style={styles.hint}>This is an extra module. Turn it on when you want to record employees, run pay, and keep payslips.</Text>
                </View>
              </View>
              <Text style={styles.body}>Payroll stays off until you enable it in Customize Features. Nothing here files with a tax office.</Text>
              <FormActions
                primaryLabel="Enable in Customize Features"
                onPrimary={() => router.push("/customize-features")}
              />
            </Card>
          ) : (
            <>
              <Card>
                <View style={styles.formTitleRow}>
                  <View style={styles.formIcon}>
                    <Ionicons name="person-add-outline" size={19} color={theme.color.brandPrimary} />
                  </View>
                  <View>
                    <Text style={styles.cardTitle}>Add employee</Text>
                    <Text style={styles.hint}>Name, role, pay rate, and tax withheld.</Text>
                  </View>
                </View>
                <FormField
                  label="Name"
                  first
                  testID="input-employee-name"
                  value={empName}
                  onChangeText={setEmpName}
                  placeholder="Employee name"
                />
                <FormField label="Role" value={empRole} onChangeText={setEmpRole} placeholder="e.g. Cashier" />
                <FormField
                  label="Pay rate"
                  value={empRate}
                  onChangeText={setEmpRate}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                />
                <FormField
                  label="Tax %"
                  value={empTax}
                  onChangeText={setEmpTax}
                  keyboardType="decimal-pad"
                  placeholder="0–100"
                />
                <FormField
                  label="Start date"
                  value={empStart}
                  onChangeText={setEmpStart}
                  onBlur={() => { if (empStart.trim()) setEmpStart(normalizeDateInput(empStart)); }}
                  autoCapitalize="none"
                  placeholder="YYYY-MM-DD"
                />
                <FormActions primaryLabel="Save employee" onPrimary={saveEmployee} primaryBusy={savingEmp} error={empError} />
              </Card>

              <Card style={styles.listCard}>
                <View style={styles.listTitleRow}>
                  <View style={styles.listIcon}>
                    <Ionicons name="people-outline" size={17} color={theme.color.brandPrimary} />
                  </View>
                  <Text style={styles.cardTitle}>Employees</Text>
                </View>
                {!employees.length ? (
                  <Text style={styles.empty}>No employees yet.</Text>
                ) : employees.map((employee) => (
                  <View key={employee.id} style={styles.entry}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.entryName}>{employee.name}</Text>
                      <Text style={styles.entryMeta}>
                        {[employee.role || "No role", fmt(employee.payRate, currSym), `${employee.taxPct}% tax`, employee.startDate].filter(Boolean).join(" · ")}
                      </Text>
                    </View>
                    <Pressable onPress={() => archiveEmployee(employee)} hitSlop={10} style={styles.archiveBtn}>
                      <Ionicons name="archive-outline" size={16} color={theme.color.muted} />
                      <Text style={styles.archiveText}>Archive</Text>
                    </Pressable>
                  </View>
                ))}
              </Card>

              <Card>
                <View style={styles.formTitleRow}>
                  <View style={styles.formIcon}>
                    <Ionicons name="wallet-outline" size={19} color={theme.color.brandPrimary} />
                  </View>
                  <View>
                    <Text style={styles.cardTitle}>Run pay</Text>
                    <Text style={styles.hint}>Pays each active employee for this date from cash or bank.</Text>
                  </View>
                </View>
                <FormField
                  label="Pay date"
                  first
                  value={payDate}
                  onChangeText={setPayDate}
                  onBlur={() => { if (payDate.trim()) setPayDate(normalizeDateInput(payDate)); }}
                  autoCapitalize="none"
                  placeholder="YYYY-MM-DD"
                />
                <Text style={styles.labelSpaced}>Paid from</Text>
                <View style={styles.chips}>
                  {(["cash", "bank"] as PayMethod[]).map((method) => {
                    const active = payMethod === method;
                    return (
                      <Pressable key={method} onPress={() => setPayMethod(method)} style={[styles.chip, active && styles.chipActive]}>
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>{method === "cash" ? "Cash" : "Bank"}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <FormField label="Notes (optional)" multiline value={payNotes} onChangeText={setPayNotes} placeholder="Period or reference" />
                <FormActions
                  primaryLabel="Run Pay"
                  primaryTestID="btn-run-payroll"
                  onPrimary={runPay}
                  primaryBusy={runningPay}
                  error={payError}
                />
              </Card>

              <Card style={styles.listCard}>
                <View style={styles.listTitleRow}>
                  <View style={styles.listIcon}>
                    <Ionicons name="document-text-outline" size={17} color={theme.color.brandPrimary} />
                  </View>
                  <Text style={styles.cardTitle}>Pay runs</Text>
                </View>
                {!payRuns.length ? (
                  <Text style={styles.empty}>No pay runs yet.</Text>
                ) : payRuns.map((run) => {
                  const open = selectedRunId === run.id;
                  return (
                    <View key={run.id}>
                      <Pressable onPress={() => openPayRun(run)} style={styles.entry}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.entryName}>{run.date || "Pay run"}</Text>
                          <Text style={styles.entryMeta}>
                            {[run.method ? run.method.toUpperCase() : null, run.notes].filter(Boolean).join(" · ") || "Tap to show payslips"}
                          </Text>
                        </View>
                        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={theme.color.muted} />
                      </Pressable>
                      {open ? (
                        <View style={styles.slipBlock}>
                          {payslipError ? <Text style={styles.errorInline}>{payslipError}</Text> : null}
                          {!payslips.length && !payslipError ? <Text style={styles.empty}>No payslips on this run.</Text> : null}
                          {payslips.map((slip) => (
                            <View key={slip.id} style={styles.slipRow}>
                              <Text style={styles.slipName}>{slip.employeeName}</Text>
                              <Text style={styles.slipMeta}>Gross {fmt(slip.gross, currSym)}</Text>
                              <Text style={styles.slipMeta}>Tax {fmt(slip.tax, currSym)}</Text>
                              <Text style={styles.slipNet}>Net {fmt(slip.net, currSym)}</Text>
                            </View>
                          ))}
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </Card>

              <Card>
                <View style={styles.formTitleRow}>
                  <View style={styles.formIcon}>
                    <Ionicons name="calendar-outline" size={19} color={theme.color.brandPrimary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardTitle}>Year-end summary</Text>
                    <Text style={styles.hint}>Year-end summary for your records — this does not file with a tax office.</Text>
                  </View>
                </View>
                <FormField
                  label="Year"
                  first
                  value={year}
                  onChangeText={setYear}
                  keyboardType="number-pad"
                  placeholder={String(new Date().getFullYear())}
                />
                <FormActions
                  primaryLabel="Show year-end summary"
                  primaryTestID="btn-year-end"
                  onPrimary={loadYearEnd}
                  primaryBusy={yearBusy}
                  error={yearError}
                />
                {yearLoaded ? (
                  <View style={{ marginTop: 12 }}>
                    {!yearRows.length ? (
                      <Text style={styles.empty}>No payroll recorded for {year}.</Text>
                    ) : yearRows.map((row, index) => (
                      <View key={`${row.name}-${index}`} style={styles.entry}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.entryName}>{row.name}</Text>
                          <Text style={styles.entryMeta}>
                            Gross {fmt(row.gross, currSym)} · Tax {fmt(row.tax, currSym)}
                          </Text>
                        </View>
                        <Text style={styles.entryAmount}>{fmt(row.net, currSym)}</Text>
                      </View>
                    ))}
                    <View style={styles.totalRow}>
                      <View>
                        <Text style={styles.totalLabel}>Grand total (net)</Text>
                        <Text style={styles.entryMeta}>Gross {fmt(yearGross, currSym)} · Tax {fmt(yearTax, currSym)}</Text>
                      </View>
                      <Text style={styles.total}>{fmt(yearGrand || 0, currSym)}</Text>
                    </View>
                  </View>
                ) : null}
              </Card>
              <View style={{ height: 120 }} />
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    scroll: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.xxxl },
    formTitleRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: theme.spacing.md },
    formIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.surfaceTertiary },
    cardTitle: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface },
    hint: { color: theme.color.muted, fontSize: 11, marginTop: 2 },
    body: { color: theme.color.onSurface, fontSize: 13, lineHeight: 19 },
    labelSpaced: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface, marginTop: 12 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 6 },
    chip: { borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 12 },
    chipActive: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary },
    chipText: { color: theme.color.onSurface, fontSize: 12, fontWeight: "600" },
    chipTextActive: { color: theme.color.onBrandPrimary || "#fff" },
    listCard: { marginTop: theme.spacing.md },
    listTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: theme.spacing.sm },
    listIcon: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.surfaceTertiary },
    empty: { color: theme.color.muted, fontSize: 12, paddingVertical: theme.spacing.sm },
    entry: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: theme.spacing.sm, borderBottomWidth: 1, borderBottomColor: theme.color.border },
    entryName: { color: theme.color.onSurface, fontSize: 13, fontWeight: "700" },
    entryMeta: { color: theme.color.muted, fontSize: 11, marginTop: 3 },
    entryAmount: { color: theme.color.brandPrimary, fontSize: 13, fontWeight: "800" },
    archiveBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4, paddingHorizontal: 6 },
    archiveText: { color: theme.color.muted, fontSize: 12, fontWeight: "600" },
    slipBlock: { paddingLeft: 8, paddingBottom: 8 },
    slipRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.color.border },
    slipName: { color: theme.color.onSurface, fontSize: 13, fontWeight: "600" },
    slipMeta: { color: theme.color.muted, fontSize: 12, marginTop: 2 },
    slipNet: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: "700", marginTop: 2 },
    errorInline: { color: theme.color.error, fontSize: 12, marginBottom: 6 },
    totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", paddingTop: theme.spacing.md, marginTop: 2 },
    totalLabel: { color: theme.color.onSurface, fontSize: 13, fontWeight: "800" },
    total: { color: theme.color.onSurface, fontSize: 14, fontWeight: "800" },
  });
}
