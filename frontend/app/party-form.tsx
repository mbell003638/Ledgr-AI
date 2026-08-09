import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { bumpDataVersion } from "@/src/utils/dataVersion";
import { Card } from "@/src/components/UI";

export default function PartyForm() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string, type?: "customer" | "supplier" }>();
  const editId = params.id;
  const partyType = params.type || "customer";
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!editId) return;
    (async () => {
      try {
        if (partyType === "supplier") {
          const s = await api.getSupplier(editId);
          setName(s.name || ""); setPhone(s.phone || ""); setEmail(s.email || ""); setNotes(s.notes || "");
        } else {
          const d = await api.getCustomer(editId);
          if (d) {
            setName(d.name || ""); setPhone(d.phone || ""); setEmail(d.email || ""); setNotes(d.notes || "");
          }
        }
      } catch (e: any) { setError(e.message); }
    })();
  }, [editId, partyType]);

  const save = async () => {
    if (!name.trim()) { setError("Enter a name"); return; }
    setSaving(true); setError("");
    try {
      const payload = { name: name.trim(), phone, email: email.trim(), notes, roles: [partyType] };
      if (editId) {
        if (partyType === "supplier") await api.updateSupplier(editId, payload);
        else await api.updateDebtor(editId, payload);
      } else {
        await api.createParty(payload);
      }
      bumpDataVersion();
      router.back();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!editId) return;
    setDeleting(true);
    try { 
      if (partyType === "supplier") await api.deleteSupplier(editId);
      else await api.deleteDebtor(editId);
      bumpDataVersion();
      router.back(); router.back();
    }
    catch (e: any) { setError(e.message); }
    finally { setDeleting(false); }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-close-supplier" onPress={() => router.back()}>
          <Ionicons name="close" size={26} color={theme.color.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>{editId ? `Edit ${partyType === 'supplier' ? 'Supplier' : 'Customer'}` : `New ${partyType === 'supplier' ? 'Supplier' : 'Customer'}`}</Text>
        <View style={{ width: 26 }} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }} keyboardShouldPersistTaps="handled">
          <Card>
            <Text style={styles.label}>Name</Text>
            <TextInput testID="input-supplier-name" value={name} onChangeText={setName} style={styles.input} placeholder="e.g. ABC Trading" placeholderTextColor={theme.color.muted} />
            <Text style={[styles.label, { marginTop: 12 }]}>Phone</Text>
            <TextInput testID="input-supplier-phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" style={styles.input} placeholder="Optional" placeholderTextColor={theme.color.muted} />
            <Text style={[styles.label, { marginTop: 12 }]}>Email</Text>
            <TextInput testID="input-supplier-email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" style={styles.input} placeholder="Optional — for email reminders" placeholderTextColor={theme.color.muted} />
            <Text style={[styles.label, { marginTop: 12 }]}>Notes</Text>
            <TextInput testID="input-supplier-notes" value={notes} onChangeText={setNotes} style={[styles.input, { minHeight: 60 }]} multiline placeholder="Optional" placeholderTextColor={theme.color.muted} />
          </Card>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            testID="btn-save-supplier"
            onPress={save}
            disabled={saving}
            style={({ pressed }) => [styles.saveBtn, (pressed || saving) && { opacity: 0.85 }]}
          >
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>{editId ? "Update " : "Save "}{partyType === 'supplier' ? 'Supplier' : 'Customer'}</Text>}
          </Pressable>
          {editId ? (
            <Pressable testID="btn-delete-supplier" onPress={remove} disabled={deleting} style={({ pressed }) => [{ padding: theme.spacing.md, alignItems: "center", marginTop: theme.spacing.sm }, (pressed || deleting) && { opacity: 0.85 }]}>
              {deleting ? <ActivityIndicator color={theme.color.error} /> : <Text style={{ color: theme.color.error, fontWeight: "600", fontSize: 14 }}>Delete {partyType === 'supplier' ? 'Supplier' : 'Customer'}</Text>}
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
  label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
  input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
  error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
  saveBtn: { backgroundColor: theme.color.brandPrimary, padding: theme.spacing.lg, borderRadius: theme.radius.md, alignItems: "center", marginTop: theme.spacing.lg },
  saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
}); }
