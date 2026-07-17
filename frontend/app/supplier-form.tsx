import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";

export default function SupplierForm() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!name.trim()) { setError("Enter a name"); return; }
    setSaving(true); setError("");
    try {
      await api.createSupplier({ name: name.trim(), phone, notes });
      router.back();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-close-supplier" onPress={() => router.back()}>
          <Ionicons name="close" size={26} color={theme.color.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>New Partner</Text>
        <View style={{ width: 26 }} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }} keyboardShouldPersistTaps="handled">
          <Card>
            <Text style={styles.label}>Name</Text>
            <TextInput testID="input-supplier-name" value={name} onChangeText={setName} style={styles.input} placeholder="e.g. Rahim Trading" placeholderTextColor={theme.color.muted} />
            <Text style={[styles.label, { marginTop: 12 }]}>Phone</Text>
            <TextInput testID="input-supplier-phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" style={styles.input} placeholder="Optional" placeholderTextColor={theme.color.muted} />
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
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save Partner</Text>}
          </Pressable>
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
