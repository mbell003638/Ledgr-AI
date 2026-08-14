import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { api } from "@/src/api";
import { getEnabledFeatures } from "@/src/utils/featureFlags";
import { useTheme } from "@/src/context/ThemeContext";

export type ShopLocation = { id: string; name: string };

export async function loadLocationsIfEnabled(): Promise<{ enabled: boolean; locations: ShopLocation[]; activeId: string }> {
  const settings = await api.getSettings().catch(() => ({}));
  const enabled = getEnabledFeatures(settings).includes("locations");
  if (!enabled) return { enabled: false, locations: [], activeId: "" };
  const rows = await (api as any).listLocations();
  const locations = (Array.isArray(rows) ? rows : []).map((row: any) => ({
    id: String(row.id || ""),
    name: String(row.name || ""),
  })).filter((row: ShopLocation) => row.id);
  const activeId = String((settings as any)?.activeLocationId || locations[0]?.id || "");
  return { enabled, locations, activeId };
}

export function LocationPicker({
  value,
  onChange,
  label = "Location",
}: {
  value: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  const theme = useTheme();
  const [enabled, setEnabled] = useState(false);
  const [locations, setLocations] = useState<ShopLocation[]>([]);
  const [activeId, setActiveId] = useState("");

  useEffect(() => {
    let live = true;
    loadLocationsIfEnabled().then((next) => {
      if (!live) return;
      setEnabled(next.enabled);
      setLocations(next.locations);
      setActiveId(next.activeId);
    }).catch(() => {
      if (live) setEnabled(false);
    });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (enabled && !value && activeId) onChange(activeId);
  }, [enabled, value, activeId, onChange]);

  if (!enabled) return null;

  return (
    <View style={{ marginBottom: theme.spacing.md }}>
      <Text style={{ color: theme.color.muted, fontSize: 13, fontWeight: "600", marginBottom: 8 }}>{label}</Text>
      {locations.length === 0 ? (
        <Text style={{ color: theme.color.muted, fontSize: 13 }}>Add a shop in Locations first.</Text>
      ) : (
        <View style={styles.row}>
          {locations.map((loc) => {
            const on = loc.id === value;
            return (
              <Pressable
                key={loc.id}
                onPress={() => onChange(loc.id)}
                style={[
                  styles.chip,
                  { borderColor: on ? theme.color.brandPrimary : theme.color.border, backgroundColor: on ? theme.color.brandPrimary : "transparent" },
                ]}
              >
                <Text style={{ color: on ? "#fff" : theme.color.onSurface, fontWeight: "600", fontSize: 13 }}>{loc.name}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1 },
});
