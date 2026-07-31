import React, { useEffect, useMemo, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { findBestPartyMatch } from "@/src/utils/fuzzyMatch";

import { GlowPressable } from "@/src/components/GlowPressable";
type PartyItem = { id: string; name: string; phone?: string; role?: string };

interface Props {
  value: string;
  onChangeText: (text: string) => void;
  onSelectParty?: (party: PartyItem) => void;
  placeholder?: string;
  label?: string;
  roleFilter?: "customer" | "supplier" | "all";
  testID?: string;
  style?: any;
}

export function PartyAutocompleteInput({
  value,
  onChangeText,
  onSelectParty,
  placeholder = "Type or select name...",
  label,
  roleFilter = "all",
  testID,
  style,
}: Props) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [parties, setParties] = useState<PartyItem[]>([]);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const list = await api.searchParties("");
        const filtered = list.filter((p) => {
          if (roleFilter === "customer") return p.role === "customer" || p.role === "both";
          if (roleFilter === "supplier") return p.role === "supplier" || p.role === "both";
          return true;
        });
        setParties(filtered);
      } catch (e) {
        console.warn("Failed to load parties for autocomplete", e);
      }
    })();
  }, [roleFilter]);

  const matches = useMemo(() => {
    const q = (value || "").trim().toLowerCase();
    if (!q) return parties.slice(0, 5); // Show first 5 parties if field is empty & focused
    return parties
      .filter((p) => p.name.toLowerCase().includes(q) || (p.phone && p.phone.includes(q)))
      .slice(0, 6);
  }, [value, parties]);

  const select = (p: PartyItem) => {
    onChangeText(p.name);
    if (onSelectParty) onSelectParty(p);
    setFocused(false);
  };

  return (
    <View style={styles.container}>
      {label && <Text style={styles.label}>{label}</Text>}
      <TextInput
        testID={testID}
        value={value}
        onChangeText={(val) => {
          onChangeText(val);
          setFocused(true);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 200)}
        placeholder={placeholder}
        placeholderTextColor={theme.color.muted}
        style={[styles.input, style]}
      />

      {/* Autocomplete suggestions dropdown/chips when focused */}
      {focused && matches.length > 0 && (
        <View style={styles.dropdown}>
          <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled style={{ maxHeight: 150 }}>
            {matches.map((item, index) => (
              <GlowPressable
                key={item.id}
                topHighlight={false}
                animateBorder={false}
                haptic
                hoverLift={0}
                hoverScale={1.008}
                pressScale={0.98}
                onPress={() => select(item)}
                style={[styles.dropdownRow, index === matches.length - 1 && styles.dropdownRowLast]}
              >
                <Ionicons name="person-circle-outline" size={18} color={theme.color.brandPrimary} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.dropdownTitle}>{item.name}</Text>
                  {item.phone ? <Text style={styles.dropdownSub}>{item.phone}</Text> : null}
                </View>
                <View style={styles.roleBadge}>
                  <Text style={styles.roleText}>{item.role === "both" ? "Both" : item.role === "customer" ? "Customer" : "Supplier"}</Text>
                </View>
              </GlowPressable>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { zIndex: 10, position: "relative" },
    label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface, marginBottom: 4 },
    input: {
      borderWidth: 1,
      borderColor: theme.color.border,
      backgroundColor: theme.color.surface,
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
      fontSize: 14,
      color: theme.color.onSurface,
    },
    dropdown: {
      marginTop: 6,
      backgroundColor: theme.color.surfaceSecondary,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.color.border,
      overflow: "hidden",
      zIndex: 20,
    },
    dropdownRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.color.border,
    },
    dropdownRowLast: { borderBottomWidth: 0 },
    dropdownTitle: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    dropdownSub: { fontSize: 11, color: theme.color.muted },
    roleBadge: {
      backgroundColor: theme.color.brandPrimary + "18",
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
    },
    roleText: { fontSize: 10, fontWeight: "700", color: theme.color.brandPrimary, textTransform: "uppercase" },
  });
}
