import React, { useMemo } from "react";
import {
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ActivityIndicator,
  StyleProp,
  ViewStyle,
  TextStyle,
  TextInputProps,
} from "react-native";
import { useTheme } from "@/src/context/ThemeContext";
import { Card } from "@/src/components/UI";

/**
 * Shared entry-form grammar for Ledgr.
 *
 * This is a *consolidation* of the visual pattern already used by the app's
 * dominant entry forms (sale-form, bill-form, payment-form, receipt-form):
 *   - `<Card>` container (glass surface, radius.card, padding 18)
 *   - label: 13px / 600 weight / onSurface
 *   - input: 1px border, surface bg, radius.md, spacing.md padding, 14px text,
 *     6px top margin; the first field sits flush, later fields get 12px top gap
 *   - multiline notes: minHeight 60
 *   - primary action: brandPrimary block button, spacing.lg padding, radius.md,
 *     white 15px/600 label, spinner while busy
 *   - secondary/destructive action: text-only, spacing.md padding, error colour
 *   - error text: centred, error colour, 13px
 *
 * These components exist so the previously-divergent screens (investor,
 * inventory count, assets & liabilities) can adopt the *exact* same structure
 * without a redesign. They intentionally mirror the existing StyleSheet values
 * rather than introducing new ones.
 */

export function makeFormStyles(theme: any) {
  return StyleSheet.create({
    label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    labelSpaced: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface, marginTop: 12 },
    hint: { fontSize: 12, color: theme.color.muted, marginTop: 6 },
    input: {
      marginTop: 6,
      borderWidth: 1,
      borderColor: theme.color.border,
      backgroundColor: "transparent",
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
      fontSize: 14,
      color: theme.color.onSurface,
    },
    multiline: { minHeight: 60 },
    error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
    primaryBtn: {
      backgroundColor: theme.color.brandPrimary,
      padding: theme.spacing.lg,
      borderRadius: theme.radius.md,
      alignItems: "center",
      marginTop: theme.spacing.lg,
    },
    primaryText: { color: "#fff", fontWeight: "600", fontSize: 15 },
    secondaryBtn: { padding: theme.spacing.md, alignItems: "center", marginTop: theme.spacing.sm },
    secondaryText: { color: theme.color.error, fontWeight: "600", fontSize: 14 },
  });
}

/** Card container for a group of form fields — same look as every entry form. */
export function FormCard({
  children,
  style,
  testID,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <Card style={style} testID={testID}>
      {children}
    </Card>
  );
}

/**
 * A labelled text input matching the app's standard field.
 *
 * `first` controls the top gap: the first field in a card sits flush (matching
 * the reference forms where the opening label has no extra top margin), later
 * fields get the standard 12px separation.
 */
export function FormField({
  label,
  first = false,
  multiline = false,
  labelStyle,
  inputStyle,
  hint,
  ...inputProps
}: {
  label: string;
  first?: boolean;
  multiline?: boolean;
  labelStyle?: StyleProp<TextStyle>;
  inputStyle?: StyleProp<TextStyle>;
  hint?: string;
} & TextInputProps) {
  const theme = useTheme();
  const styles = useMemo(() => makeFormStyles(theme), [theme]);
  return (
    <>
      <Text style={[first ? styles.label : styles.labelSpaced, labelStyle]}>{label}</Text>
      <TextInput
        placeholderTextColor={theme.color.muted}
        multiline={multiline}
        style={[styles.input, multiline && styles.multiline, inputStyle]}
        {...inputProps}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </>
  );
}

/**
 * Standard primary save action + optional destructive/secondary action, laid
 * out identically to the app's entry forms (block primary button, text-only
 * secondary beneath it). An error string, when present, renders above.
 */
export function FormActions({
  primaryLabel,
  onPrimary,
  primaryBusy = false,
  primaryDisabled = false,
  primaryTestID,
  secondaryLabel,
  onSecondary,
  secondaryBusy = false,
  secondaryTestID,
  error,
  errorTestID,
}: {
  primaryLabel: string;
  onPrimary: () => void;
  primaryBusy?: boolean;
  primaryDisabled?: boolean;
  primaryTestID?: string;
  secondaryLabel?: string;
  onSecondary?: () => void;
  secondaryBusy?: boolean;
  secondaryTestID?: string;
  error?: string;
  errorTestID?: string;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeFormStyles(theme), [theme]);
  return (
    <>
      {error ? (
        <Text style={styles.error} testID={errorTestID}>
          {error}
        </Text>
      ) : null}
      <Pressable
        testID={primaryTestID}
        onPress={onPrimary}
        disabled={primaryBusy || primaryDisabled}
        style={({ pressed }) => [styles.primaryBtn, (pressed || primaryBusy || primaryDisabled) && { opacity: 0.85 }]}
      >
        {primaryBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{primaryLabel}</Text>}
      </Pressable>
      {secondaryLabel && onSecondary ? (
        <Pressable
          testID={secondaryTestID}
          onPress={onSecondary}
          disabled={secondaryBusy}
          style={({ pressed }) => [styles.secondaryBtn, (pressed || secondaryBusy) && { opacity: 0.85 }]}
        >
          {secondaryBusy ? (
            <ActivityIndicator color={theme.color.error} />
          ) : (
            <Text style={styles.secondaryText}>{secondaryLabel}</Text>
          )}
        </Pressable>
      ) : null}
    </>
  );
}
